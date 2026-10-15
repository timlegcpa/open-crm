-- 0008_board: the work board.
--
-- Belongs here: work_items (title, optional contact, type, stage, priority, optional due
-- date, its place in its lane, archive), their notes and stage history, the board
-- pick lists (work_item_types, board_stages, seeded with generic defaults), the RPCs
-- create_work_item, move_work_item_stage, add_work_item_note and reorder_board_lane, and
-- the server's
-- auto_archive_done_work_items.
--
-- Depends on: 0001_core (is_owner, mfa_session_ok, audit_actor), 0002_contacts (contacts,
-- guard_pick_list).
--
-- Principals: every table here is the owner's alone. A client session (and so the
-- owner's View-as-client session, which is a client session) reads and writes nothing,
-- so no table here is client-writable and none carries trg_impersonation_read_only.
-- The four RPCs a signed-in session may call refuse everyone but the owner as their
-- first statement (src/__tests__/db/allowlists/board.ts names them).
--
-- Rules, as for every migration in this schema. src/__tests__/db/invariants.test.ts reads
-- the migrated catalog and fails the build when a table or function here breaks one:
--   * RLS on every table, and a RESTRICTIVE policy named <table>_mfa_gate, FOR ALL TO
--     authenticated, USING ((SELECT public.mfa_session_ok())) and WITH CHECK the same.
--   * Privileges stated, never inherited: REVOKE ALL ON <table> FROM PUBLIC, anon,
--     authenticated, service_role; then GRANT per role. Row access only (SELECT, INSERT,
--     UPDATE, DELETE, by column where a column must not move); anon gets nothing.
--     Supabase grants everything in public by default, so a missing REVOKE is an open
--     table.
--   * Functions likewise: REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated,
--     service_role; then GRANT EXECUTE per role. Every function pins SET search_path = ''
--     and schema-qualifies what it touches; SECURITY DEFINER only where it must be.
--   * A FOR ALL policy states both USING and WITH CHECK.
--   * The principals are public.is_owner(), public.get_client_contact_id() and the
--     service role; a role claim in a token grants nothing.
--   * Columns a client must not change: a BEFORE UPDATE trigger running
--     public.enforce_client_column_guard('id', ...the columns...).
--   * Every table a client session can write (a write policy that names
--     get_client_contact_id() or auth.uid(), or does not require is_owner()) carries
--       CREATE TRIGGER trg_impersonation_read_only
--         BEFORE INSERT OR UPDATE OR DELETE ON public.<table>
--         FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();
--   * Storage: each bucket gets its own policies on storage.objects, and every clause of
--     each requires bucket_id = '<that bucket>' at its top level (AND, never OR).
--     storage.objects already carries the MFA gate (0001) and refuses every write from
--     View as client (0002), for all buckets: never add another gate or change those.
--   * A pick-list is a table guarded by public.guard_pick_list(), with the columns key,
--     label, colour, sort_order, is_active and is_system. A list the code depends on in
--     full (stages) passes it the argument 'fixed': guard_pick_list('fixed'), and has
--     only key, label, colour and sort_order (contact_statuses' shape).
--   * A view is created WITH (security_invoker = true).
--   * No cron schedules in a migration: scheduled work is a row in public.jobs run by the
--     job-runner, or a schedule the adopter sets up outside the migrations.
--
-- The board's own rules, each enforced here rather than trusted to the app:
--   * A card is created only through create_work_item, which records where it started
--     (a 'created' event): a signed-in session holds no INSERT grant on work_items, so a
--     card cannot appear in a lane, Done included, without a line in its history.
--   * A card's stage moves only through move_work_item_stage, which requires a reason and
--     records it: a signed-in session holds no UPDATE grant on work_items.stage, so a
--     plain update of the stage is refused, and work_item_events has no write policy at
--     all. The RPCs are the only writers of history.
--   * A move is refused (move_rejected) when the card is no longer in the stage the
--     caller saw, so a stale second tab cannot overwrite a newer move.
--   * A card's place in its lane (lane_position) is written only by reorder_board_lane and
--     cleared by every move and every restore: a place counts only in the lane it was set
--     in. Cards with no place sort above placed ones on the board.
--   * Done cards archive 14 days after they entered Done or were last restored, whichever
--     is later (auto_archive_done_work_items, run by the server on a schedule). The
--     restore stamp is written by a trigger with the database's clock, so every way a
--     card comes back restarts the clock and the app never sends it.
--   * Delete is hard and takes the card's history with it; archive is the keep path. A
--     deleted contact takes its cards (and their history) with it.

-- ---------------------------------------------------------------------------
-- Pick-lists. Seeded BEFORE their guard triggers exist: guard_pick_list refuses to
-- insert a row the code depends on, which is every row of a fixed list.
-- ---------------------------------------------------------------------------

-- The board's lanes. The code branches on these keys (done archives, is never overdue,
-- takes the Done pill), so the set is fixed; the owner renames, recolours and reorders
-- them. colour NULL means the lane's default tone.
CREATE TABLE public.board_stages (
  key text PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  -- A six-digit hex colour: the board draws it straight into a style.
  colour text CHECK (colour IS NULL OR colour ~ '^#[0-9a-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO public.board_stages (key, label, sort_order) VALUES
  ('todo', 'To do', 10),
  ('waiting', 'Waiting', 20),
  ('doing', 'In progress', 30),
  ('done', 'Done', 40);

-- What kind of work a card is. The owner adds, relabels and retires types; `task` is the
-- system row every new card defaults to.
CREATE TABLE public.work_item_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text CHECK (colour IS NULL OR colour ~ '^#[0-9a-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

INSERT INTO public.work_item_types (key, label, sort_order, is_system) VALUES
  ('task', 'Task', 10, true),
  ('follow_up', 'Follow-up', 20, false),
  ('call', 'Call', 30, false),
  ('meeting', 'Meeting', 40, false),
  ('paperwork', 'Paperwork', 50, false);

CREATE TRIGGER trg_board_stages_guard BEFORE INSERT OR UPDATE OR DELETE ON public.board_stages
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list('fixed');
CREATE TRIGGER trg_work_item_types_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_item_types
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();

-- ---------------------------------------------------------------------------
-- Work items and their history
-- ---------------------------------------------------------------------------

CREATE TABLE public.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional. A contact delete takes its cards: the contact delete dialogs say
  -- everything recorded on the contact goes with it.
  contact_id uuid REFERENCES public.contacts (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (pg_catalog.btrim(title) <> '' AND char_length(title) <= 200),
  work_item_type text NOT NULL DEFAULT 'task' REFERENCES public.work_item_types (key),
  -- After the insert, written only by move_work_item_stage (no UPDATE grant).
  stage text NOT NULL DEFAULT 'todo' REFERENCES public.board_stages (key),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal', 'low')),
  -- A calendar day with no zone; NULL means no date.
  due_date date,
  -- The card's place in its lane, top first; NULL until placed. See the header.
  lane_position integer CHECK (lane_position IS NULL OR lane_position >= 0),
  archived_at timestamptz,
  -- Written only by trg_work_items_restore_stamp.
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  stage_updated_at timestamptz NOT NULL DEFAULT now()
);

-- Foreign keys are indexed; the board reads unarchived cards by stage, and the nightly
-- archive reads unarchived Done cards.
CREATE INDEX idx_work_items_contact ON public.work_items (contact_id);
CREATE INDEX idx_work_items_type ON public.work_items (work_item_type);
CREATE INDEX idx_work_items_stage ON public.work_items (stage);
CREATE INDEX idx_work_items_done_open ON public.work_items (stage_updated_at)
  WHERE stage = 'done' AND archived_at IS NULL;

-- Append-only: a card's creation (the lane it started in, and its starting note if any),
-- a stage move with its reason, or a note logged without a move.
CREATE TABLE public.work_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES public.work_items (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created', 'stage_changed', 'note_added')),
  -- Stage keys for a move; to_value alone for a creation; both NULL for a note.
  from_value text,
  to_value text,
  -- { "note": "..." }. The cap bounds one row: the board reads every row on each load,
  -- so one oversized paste would slow every later load.
  detail jsonb,
  actor_user_id uuid,
  -- clock_timestamp(), not now(): two events in one transaction must not share a
  -- timestamp, or history loses its order.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT work_item_events_note_length CHECK (char_length(detail ->> 'note') <= 2000)
);

CREATE INDEX idx_work_item_events_item ON public.work_item_events (work_item_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- The restore stamp. A card coming back from Archived restarts the 14-day Done clock and
-- loses its old place (it sits on top of its lane, like any card new to it). Archiving
-- (NULL to a time) takes no branch and so can never raise, which the nightly archive's
-- single UPDATE relies on: if a trigger on work_items could raise for one row, that
-- UPDATE would fail for every row, every night. Keep every branch here unable to raise.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.stamp_work_item_restore()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    NEW.restored_at := pg_catalog.now();
    NEW.lane_position := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_work_items_restore_stamp
  BEFORE UPDATE OF archived_at ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.stamp_work_item_restore();

-- ---------------------------------------------------------------------------
-- RPCs. SECURITY DEFINER because the history table has no write policy and a signed-in
-- session cannot write stage or lane_position. A definer runs past RLS, so each one
-- refuses everyone but the owner as its very first statement. The error strings are a
-- contract: the board matches 'move_rejected' and 'note_required'.
-- ---------------------------------------------------------------------------

-- Creates a card and records the lane it started in, with its starting note if one is
-- given, in one transaction. NULL type, stage or priority take the column defaults; an
-- unknown one fails its foreign key or CHECK.
CREATE FUNCTION public.create_work_item(
  p_title text,
  p_contact_id uuid,
  p_work_item_type text,
  p_stage text,
  p_priority text,
  p_due_date date,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note  text := NULLIF(pg_catalog.btrim(p_note), '');
  v_id    uuid;
  v_stage text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.work_items (title, contact_id, work_item_type, stage, priority, due_date)
  VALUES (p_title, p_contact_id, COALESCE(p_work_item_type, 'task'), COALESCE(p_stage, 'todo'),
          COALESCE(p_priority, 'normal'), p_due_date)
  RETURNING id, stage INTO v_id, v_stage;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (v_id, 'created', NULL, v_stage, public.audit_actor(),
          CASE WHEN v_note IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('note', v_note) END);
  RETURN v_id;
END;
$$;

-- Logs a note on a card without moving it.
CREATE FUNCTION public.add_work_item_note(p_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note text := pg_catalog.btrim(p_note);
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_note IS NULL OR v_note = '' THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = p_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (p_id, 'note_added', NULL, NULL, public.audit_actor(), pg_catalog.jsonb_build_object('note', v_note));
END;
$$;

-- Moves a card and records the reason, in one transaction. p_expected_stage is the stage
-- the caller saw: a card that has moved since is refused, never overwritten. An unknown
-- p_stage fails the foreign key.
CREATE FUNCTION public.move_work_item_stage(p_id uuid, p_stage text, p_note text, p_expected_stage text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note text := pg_catalog.btrim(p_note);
  v_from text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_note IS NULL OR v_note = '' THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = 'check_violation';
  END IF;

  -- Locked, so the from-value recorded is the one overwritten.
  SELECT w.stage INTO v_from FROM public.work_items w WHERE w.id = p_id FOR UPDATE;
  IF NOT FOUND OR (p_expected_stage IS NOT NULL AND v_from <> p_expected_stage) THEN
    RAISE EXCEPTION 'move_rejected' USING ERRCODE = 'no_data_found',
      HINT = 'The card was not found or has already moved. Refresh the board.';
  END IF;
  IF v_from = p_stage THEN
    RETURN;
  END IF;

  -- The old place belonged to the old lane.
  UPDATE public.work_items
     SET stage = p_stage, stage_updated_at = pg_catalog.now(), lane_position = NULL
   WHERE id = p_id;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (p_id, 'stage_changed', v_from, p_stage, public.audit_actor(), pg_catalog.jsonb_build_object('note', v_note));
END;
$$;

-- Saves a lane's order: p_ids top first, as the board draws the WHOLE lane (never a
-- filtered part of it). The rules, each settled by a past defect:
--   * An id no longer in p_stage (moved or archived in another tab) is skipped, never
--     placed back in a lane it left: every UPDATE re-checks the stage.
--   * Submitted cards with no place yet take the top slots; the rest refill the slots the
--     submitted cards already held, in the new order; a placed card left out of the list
--     keeps its slot.
--   * A list longer than 2,000 ids, or one naming a card twice (or a NULL), is refused
--     (invalid_cards): the loop below runs a lookup per id, so the bound caps one call's
--     work, and the board never sends a duplicate, so one is a bad caller.
--   * A per-lane advisory lock serialises two tabs saving the same lane.
CREATE FUNCTION public.reorder_board_lane(p_stage text, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id    uuid;
  v_sub   uuid[] := '{}';   -- submitted cards still in the lane, new order
  v_held  uuid[] := '{}';   -- placed cards still in the lane, current order
  v_final uuid[] := '{}';
  v_fresh integer := 0;
  v_next  integer;
  v_i     integer;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_stage IS NULL OR NOT EXISTS (SELECT 1 FROM public.board_stages s WHERE s.key = p_stage) THEN
    RAISE EXCEPTION 'invalid_stage' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ids IS NULL
     OR pg_catalog.cardinality(p_ids) > 2000
     OR (SELECT count(DISTINCT u.id) FROM pg_catalog.unnest(p_ids) AS u(id)) <> pg_catalog.cardinality(p_ids) THEN
    RAISE EXCEPTION 'invalid_cards' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('board_lane:' || p_stage));

  FOREACH v_id IN ARRAY p_ids LOOP
    IF EXISTS (
      SELECT 1 FROM public.work_items w WHERE w.id = v_id AND w.stage = p_stage AND w.archived_at IS NULL
    ) THEN
      v_sub := v_sub || v_id;
    END IF;
  END LOOP;

  SELECT COALESCE(pg_catalog.array_agg(w.id ORDER BY w.lane_position, w.id), '{}')
    INTO v_held
    FROM public.work_items w
   WHERE w.stage = p_stage AND w.archived_at IS NULL AND w.lane_position IS NOT NULL;

  FOREACH v_id IN ARRAY v_sub LOOP
    IF NOT (v_id = ANY (v_held)) THEN
      v_fresh := v_fresh + 1;
    END IF;
  END LOOP;
  v_final := v_sub[1:v_fresh];
  v_next := v_fresh + 1;
  FOREACH v_id IN ARRAY v_held LOOP
    IF v_id = ANY (v_sub) THEN
      v_final := v_final || v_sub[v_next];
      v_next := v_next + 1;
    ELSE
      v_final := v_final || v_id;
    END IF;
  END LOOP;

  FOR v_i IN 1 .. COALESCE(pg_catalog.array_length(v_final, 1), 0) LOOP
    UPDATE public.work_items
       SET lane_position = v_i - 1
     WHERE id = v_final[v_i]
       AND stage = p_stage
       AND archived_at IS NULL
       AND lane_position IS DISTINCT FROM v_i - 1;
  END LOOP;
END;
$$;

-- The server's: archives every Done card that has sat in Done for 14 days, counted from
-- the later of entering Done and its last restore (GREATEST skips a NULL restore), and
-- returns how many it archived. One UPDATE, so the test is evaluated on each row as it
-- is written: a card moved out of Done, or restored, a moment earlier is left alone.
-- Scheduled outside the migrations (the job-runner, or a cron the adopter sets up).
CREATE FUNCTION public.auto_archive_done_work_items()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.work_items
     SET archived_at = pg_catalog.now()
   WHERE stage = 'done'
     AND archived_at IS NULL
     AND GREATEST(stage_updated_at, restored_at) < pg_catalog.now() - interval '14 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: the owner's alone.
-- ---------------------------------------------------------------------------

ALTER TABLE public.board_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_item_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_item_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY board_stages_owner_select ON public.board_stages
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY board_stages_owner_update ON public.board_stages
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY work_item_types_owner_select ON public.work_item_types
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY work_item_types_owner_insert ON public.work_item_types
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY work_item_types_owner_update ON public.work_item_types
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY work_item_types_owner_delete ON public.work_item_types
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

CREATE POLICY work_items_owner_all ON public.work_items
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

-- Read only: the RPCs above are the one writer.
CREATE POLICY work_item_events_owner_select ON public.work_item_events
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_stages', 'work_item_types', 'work_items', 'work_item_events'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()))',
      t || '_mfa_gate', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.board_stages, public.work_item_types, public.work_items, public.work_item_events
FROM PUBLIC, anon, authenticated, service_role;

-- The server: row access only, no TRUNCATE. History is a record: no UPDATE or DELETE
-- (a card's delete still takes its history, through the foreign key).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.board_stages, public.work_item_types, public.work_items
TO service_role;
GRANT SELECT, INSERT ON public.work_item_events TO service_role;

-- Signed-in sessions, by column where a column must not move: a stage key never
-- changes and the fixed set is never added to or deleted from; a type's key and system
-- flag never change. On work_items: no INSERT (create_work_item), and no UPDATE of stage
-- (the move RPC), lane_position (the reorder RPC), restored_at (the trigger),
-- stage_updated_at or created_at.
GRANT SELECT, UPDATE (label, colour, sort_order) ON public.board_stages TO authenticated;
GRANT SELECT, INSERT, DELETE, UPDATE (label, colour, sort_order, is_active) ON public.work_item_types
TO authenticated;
GRANT SELECT, DELETE,
  UPDATE (title, contact_id, work_item_type, priority, due_date, archived_at)
ON public.work_items TO authenticated;
GRANT SELECT ON public.work_item_events TO authenticated;

-- Functions created in this file only. The trigger function needs no EXECUTE grant.
REVOKE ALL ON FUNCTION
  public.stamp_work_item_restore(),
  public.create_work_item(text, uuid, text, text, text, date, text),
  public.add_work_item_note(uuid, text),
  public.move_work_item_stage(uuid, text, text, text),
  public.reorder_board_lane(text, uuid[]),
  public.auto_archive_done_work_items()
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.create_work_item(text, uuid, text, text, text, date, text),
  public.add_work_item_note(uuid, text),
  public.move_work_item_stage(uuid, text, text, text),
  public.reorder_board_lane(text, uuid[])
TO authenticated;

GRANT EXECUTE ON FUNCTION public.auto_archive_done_work_items() TO service_role;
