-- 0015_mcp: the connector's pipeline, work board and request follow-up tools.
--
-- Belongs here: what the mcp-crm tools added after 0007 call. The pipeline (a contact
-- created from a phone call with no address, a stage and a lead source on creation, and a
-- stage move), the work board of 0008 (list, create, edit, move and note a card), and the
-- request follow-up (close a request, accept its answers, pause or resume its reminders,
-- and one roster of every open request), and the consent version that makes a connection
-- approved before these powers existed be approved again. Six 0007 functions are replaced
-- in place, with their signatures and privileges unchanged: mcp_tool_vocabulary,
-- mcp_search_contacts, mcp_create_contact, mcp_oauth_authenticate, mcp_oauth_rotate_refresh
-- and mcp_list_grants. One column is added to a 0007 table: mcp_oauth_grants.consent_version.
--
-- Written to run once on top of 0001 to 0014: CREATE OR REPLACE for the replaced
-- functions, CREATE for the new ones. 0001 to 0012 may already be applied on a project, so
-- nothing earlier is edited.
--
-- Depends on: 0001_core (audit_logs), 0002_contacts (contacts, contact_statuses,
-- lead_sources and the status trigger), 0005_requests (needs_lists, needs_items), 0007_mcp
-- (mcp_audit_row, mcp_request_audit and the functions replaced here), 0008_board
-- (work_items, work_item_events, board_stages, work_item_types) and the contacts
-- archive column (contacts.archived_at, timestamptz, NULL while the contact is on the
-- working list). That column is read only inside plpgsql bodies, which resolve a column
-- when they run, never when they are created.
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
--     full (stages) passes it the argument 'fixed': guard_pick_list('fixed').
--   * A view is created WITH (security_invoker = true).
--   * No cron schedules in a migration: scheduled work is a row in public.jobs run by the
--     job-runner, or a schedule the adopter sets up outside the migrations.
--
-- No table is created here. What this file decides, and why:
--   * A connection carries the consent version it was approved under (see the consent
--     section): new powers are never handed to a connection the owner approved without
--     them.
--   * The 0007 shape for every function: SECURITY INVOKER, executable by service_role
--     alone (the mcp-crm bearer check is the authentication boundary), returning jsonb or
--     a scalar, and writing its audit row INSIDE the act's transaction, so an audit
--     failure rolls the act back and a retry is safe. The request functions audit through
--     mcp_request_audit, whose fixed sentinel lets the server retry the whole call and
--     then tell the owner, as the other request tools do.
--   * The board's own functions (create_work_item, move_work_item_stage,
--     add_work_item_note) refuse anyone but the owner as their first statement, and the
--     server is not the owner. The functions here are their twins for the server: the same
--     writes and the same history rows, with the owner who approved the connection as the
--     actor and details.source 'mcp' on each history row.
--   * A refusal that hands the current state back (a stage the caller did not expect, a
--     card already in that lane, a system or archived contact) is a read of that row, so
--     it is audited like one. A refusal that reveals nothing (no such row) is not.
--   * Audit details carry ids, keys, counts and outcome codes, never what a person typed:
--     a note, a title or a reason is recorded as having been given, not quoted.
--
-- The pipeline:
--   * esign_signer is the one system status (src/lib/contactStatus.ts SYSTEM_STATUSES):
--     the e-signature flow gives it to a contact created only to sign, whose address is
--     self-asserted and unproven. A model can neither give it nor take a contact out of
--     it: promoting such a contact is the owner's call, in the CRM.
--   * A status change writes only the status. contacts_record_status (0002) appends the
--     history entry and stamps client_since from the row being written, as it does for the
--     owner's own change, so the connector cannot disagree with the CRM about either.
--   * An archived contact is off the working list: search leaves it out, and no tool moves
--     its stage or ties new board work to it. Restoring it is the owner's act in the CRM.
--   * The lead sources a model may set are the active ones, less the two the code assigns
--     itself (lead_intake, esign): a model setting one would misstate where a lead came
--     from. A source left out records as 'other'.
--
-- The board:
--   * A move needs a reason and is compare-and-swapped on the lane the caller read, as on
--     the board. Every move clears the card's place in its lane (lane_position), the
--     board's rule: a place counts only in the lane it was set in.
--   * An archived card is off the board: it cannot be moved from here.
--
-- The requests:
--   * close: a sent or submitted request becomes closed, as the owner's Close does. A
--     draft is refused (the client never saw it; delete_request removes a draft). Closing
--     a closed request changes nothing. Nothing is deleted.
--   * accept: every answered item ('fulfilled') becomes accepted ('reviewed'), as the
--     owner's Accept all does, under a lock on the list. An unanswered item is never
--     accepted. It does not close the request.
--   * reminders: reminders_paused is not client-visible, so the content version does not
--     move and a review token read before a pause still verifies after it.
--   * The roster reads every open request (draft, sent, submitted) by whose move it is:
--     waiting on the owner (submitted, or sent with an answer to accept), waiting on the
--     client (sent, nothing to accept), and drafts. No answer and no token leaves here.

-- ---------------------------------------------------------------------------
-- Consent version: a connection approved on older wording must be approved again
-- ---------------------------------------------------------------------------

-- The consent screen lists every power the connector's tools grant (src/features/mcp/
-- pages.tsx, CAN). This file adds powers the owner was never asked about (stage moves,
-- board writes, closing and accepting requests), and a grant lives up to 30 days, so a
-- connection approved before it would pick the new tools up silently. Each grant records
-- the consent version it was approved under (the column default, so the grant writer
-- needs no change), and authentication, refresh and the owner's list honour only the
-- current one. An older connection gets the ordinary answers (401 on a call, invalid_grant
-- on a refresh), which send the assistant back through the consent screen.
--
-- To change what a connection may do: add the line to CAN, bump the number returned
-- here, and ship both together.
CREATE FUNCTION public.mcp_consent_version()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT 2 $$;

-- Grants that exist now were approved on the older wording: version 1. New ones take the
-- current version.
ALTER TABLE public.mcp_oauth_grants ADD COLUMN consent_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.mcp_oauth_grants ALTER COLUMN consent_version SET DEFAULT public.mcp_consent_version();

-- 0007's authentication, with the consent version.
CREATE OR REPLACE FUNCTION public.mcp_oauth_authenticate(p_access_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
BEGIN
  SELECT g.id, g.approved_by, g.last_used_at INTO v
    FROM public.mcp_oauth_tokens t
    JOIN public.mcp_oauth_grants g ON g.id = t.grant_id
   WHERE t.token_hash = p_access_hash
     AND t.kind = 'access'
     AND t.expires_at > now()
     AND g.revoked_at IS NULL
     AND g.absolute_expires_at > now()
     AND g.consent_version = public.mcp_consent_version()
     AND g.approved_by = (SELECT o.owner_user_id FROM public.org_profile o)
     AND NOT EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l WHERE l.user_id = g.approved_by AND g.approved_at < l.revoked_before);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v.last_used_at IS NULL OR v.last_used_at < now() - interval '5 minutes' THEN
    UPDATE public.mcp_oauth_grants SET last_used_at = now() WHERE id = v.id;
  END IF;
  RETURN jsonb_build_object('grant_id', v.id, 'actor', v.approved_by);
END;
$$;

-- 0007's refresh rotation, with the consent version: an older grant is invalid, never
-- rotated. Replay is still judged first.
CREATE OR REPLACE FUNCTION public.mcp_oauth_rotate_refresh(
  p_old_hash text, p_client_id text, p_access_hash text, p_access_expires timestamptz, p_refresh_hash text,
  p_refresh_idle_expires timestamptz, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_tok record;
  v_grant record;
BEGIN
  SELECT t.id, t.grant_id, t.expires_at, t.rotated_at INTO v_tok
    FROM public.mcp_oauth_tokens t
   WHERE t.token_hash = p_old_hash AND t.kind = 'refresh'
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT g.id, g.client_id, g.scope, g.approved_by, g.approved_at, g.revoked_at, g.absolute_expires_at, g.consent_version INTO v_grant
    FROM public.mcp_oauth_grants g
   WHERE g.id = v_tok.grant_id
     FOR UPDATE;

  IF v_tok.rotated_at IS NOT NULL THEN
    UPDATE public.mcp_oauth_grants SET revoked_at = now() WHERE id = v_grant.id AND revoked_at IS NULL;
    PERFORM public.mcp_audit_row(
      v_grant.approved_by, 'mcp_oauth_replay_revoked',
      jsonb_build_object('source', 'mcp_oauth', 'grant_id', v_grant.id), p_ip, p_user_agent);
    RETURN jsonb_build_object('status', 'replayed');
  END IF;
  IF v_tok.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  IF (p_client_id IS NOT NULL AND v_grant.client_id IS DISTINCT FROM p_client_id)
     OR v_grant.revoked_at IS NOT NULL OR v_grant.absolute_expires_at <= now()
     OR v_grant.consent_version IS DISTINCT FROM public.mcp_consent_version()
     OR v_grant.approved_by IS DISTINCT FROM (SELECT o.owner_user_id FROM public.org_profile o)
     OR EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l
                 WHERE l.user_id = v_grant.approved_by AND v_grant.approved_at < l.revoked_before) THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  UPDATE public.mcp_oauth_tokens SET rotated_at = now() WHERE id = v_tok.id;

  INSERT INTO public.mcp_oauth_tokens (grant_id, token_hash, kind, expires_at)
  VALUES (v_grant.id, p_access_hash, 'access', p_access_expires),
         (v_grant.id, p_refresh_hash, 'refresh', least(p_refresh_idle_expires, v_grant.absolute_expires_at));
  UPDATE public.mcp_oauth_grants SET last_used_at = now() WHERE id = v_grant.id;

  PERFORM public.mcp_audit_row(
    v_grant.approved_by, 'mcp_oauth_refreshed',
    jsonb_build_object('source', 'mcp_oauth', 'grant_id', v_grant.id), p_ip, p_user_agent);

  RETURN jsonb_build_object('status', 'ok', 'scope', v_grant.scope);
END;
$$;

-- 0007's list of live connections for Settings, with the consent version: a connection
-- that no longer works is not shown as connected.
CREATE OR REPLACE FUNCTION public.mcp_list_grants()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'mcp_list_grants: owner only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', g.id, 'client_name', g.client_name, 'created_at', g.created_at,
             'last_used_at', g.last_used_at, 'expires_at', g.absolute_expires_at)
           ORDER BY g.created_at DESC, g.id DESC)
    FROM public.mcp_oauth_grants g
    WHERE g.revoked_at IS NULL AND g.absolute_expires_at > now()
      AND g.consent_version = public.mcp_consent_version()
      AND NOT EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l WHERE l.user_id = g.approved_by AND g.approved_at < l.revoked_before)), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- The vocabulary tools/list offers
-- ---------------------------------------------------------------------------

-- 0007's keys, plus the stages a model may set (every status but the system one, with its
-- label), the lead sources it may record, the board's lanes with their labels (the owner
-- relabels them, and a model needs both to place a card where the owner means), and the
-- active card types. LANGUAGE sql: nothing here reads a column 0013 adds.
CREATE OR REPLACE FUNCTION public.mcp_tool_vocabulary()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'statuses', COALESCE((SELECT jsonb_agg(s.key ORDER BY s.sort_order, s.key) FROM public.contact_statuses s), '[]'::jsonb),
    'selectable_statuses', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', s.key, 'label', s.label) ORDER BY s.sort_order, s.key)
                                        FROM public.contact_statuses s WHERE s.key <> 'esign_signer'), '[]'::jsonb),
    'lead_sources', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                 FROM public.lead_sources t
                                WHERE t.is_active AND t.key NOT IN ('lead_intake', 'esign')), '[]'::jsonb),
    'organization_types', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                       FROM public.organization_types t WHERE t.is_active), '[]'::jsonb),
    'service_types', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                  FROM public.service_types t WHERE t.is_active), '[]'::jsonb),
    'request_categories', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                       FROM public.request_categories t WHERE t.is_active), '[]'::jsonb),
    'request_tags', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                 FROM public.request_tags t WHERE t.is_active), '[]'::jsonb),
    'board_stages', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label) ORDER BY b.sort_order, b.key)
                                 FROM public.board_stages b), '[]'::jsonb),
    'work_item_types', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                    FROM public.work_item_types t WHERE t.is_active), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- The pipeline
-- ---------------------------------------------------------------------------

-- 0007's search, now over the phone too (stored as typed, so a run of digits such as the
-- last four is what matches), and never an archived contact. position() rather than LIKE,
-- so nothing in the query is a pattern character. Newest first, id as the tiebreak.
CREATE OR REPLACE FUNCTION public.mcp_search_contacts(
  p_query text, p_status text, p_limit integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_q text := lower(btrim(COALESCE(p_query, '')));
  v_limit integer := least(greatest(COALESCE(p_limit, 25), 1), 100);
  v_rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.contact_statuses s WHERE s.key = p_status) THEN
    RAISE EXCEPTION 'mcp_search_contacts: unknown_status';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.business_name, c.status, c.created_at
    FROM public.contacts c
    WHERE c.archived_at IS NULL
      AND (p_status IS NULL OR c.status = p_status)
      AND (v_q = ''
           OR position(v_q IN lower(c.full_name)) > 0
           OR position(v_q IN lower(COALESCE(c.email, ''))) > 0
           OR position(v_q IN lower(COALESCE(c.phone, ''))) > 0
           OR position(v_q IN lower(COALESCE(c.business_name, ''))) > 0)
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT v_limit
  ) m;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_search_contacts',
    jsonb_build_object('query_length', char_length(v_q), 'status', p_status, 'returned', jsonb_array_length(v_rows)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('count', jsonb_array_length(v_rows), 'contacts', v_rows);
END;
$$;

-- A new contact from an email OR a phone number (a lead who phoned in has no address
-- yet), with an optional stage and lead source. The duplicate check runs only for an
-- address, under one advisory lock per address, so two concurrent calls for the same
-- address cannot both create; a duplicate is an address on any contact's primary list,
-- compared case-insensitively. Status history and client_since come from the status
-- trigger. The edge function validates every key first; the checks here are the backstop.
CREATE OR REPLACE FUNCTION public.mcp_create_contact(p_patch jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_email text := NULLIF(btrim(COALESCE(p_patch ->> 'email', '')), '');
  v_phone text := NULLIF(btrim(COALESCE(p_patch ->> 'phone', '')), '');
  v_status text := COALESCE(NULLIF(p_patch ->> 'status', ''), 'new_lead');
  v_source text := COALESCE(NULLIF(p_patch ->> 'source', ''), 'other');
  v_dup uuid;
  v_row record;
BEGIN
  IF v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION 'mcp_create_contact: email_or_phone_required';
  END IF;
  IF v_status = 'esign_signer' OR NOT EXISTS (SELECT 1 FROM public.contact_statuses s WHERE s.key = v_status) THEN
    RAISE EXCEPTION 'mcp_create_contact: invalid_status';
  END IF;
  IF p_patch ? 'source' AND (v_source IN ('lead_intake', 'esign')
     OR NOT EXISTS (SELECT 1 FROM public.lead_sources t WHERE t.key = v_source AND t.is_active)) THEN
    RAISE EXCEPTION 'mcp_create_contact: inactive_source';
  END IF;

  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('mcp_create_contact:' || lower(v_email)));

    SELECT c.id INTO v_dup FROM public.contacts c WHERE lower(c.email) = lower(v_email) LIMIT 1;
    IF v_dup IS NULL THEN
      SELECT e.contact_id INTO v_dup FROM public.contact_emails e
       WHERE e.kind = 'primary' AND lower(e.email) = lower(v_email) LIMIT 1;
    END IF;
    IF v_dup IS NOT NULL THEN
      PERFORM public.mcp_audit_row(p_actor, 'mcp_create_contact', jsonb_build_object('outcome', 'duplicate'), p_ip, p_user_agent);
      RETURN jsonb_build_object('outcome', 'duplicate', 'id', v_dup);
    END IF;
  END IF;

  -- Every column named here loses its DEFAULT, so the names fall back to '' as they do
  -- in the CRM.
  INSERT INTO public.contacts (first_name, last_name, phone, business_name, email, status, source)
  VALUES (
    COALESCE(p_patch ->> 'first_name', ''),
    COALESCE(p_patch ->> 'last_name', ''),
    v_phone,
    p_patch ->> 'business_name',
    v_email,
    v_status,
    v_source)
  RETURNING id, first_name, last_name, email, phone, status, source INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_create_contact',
    jsonb_build_object('contact_id', v_row.id, 'status', v_row.status, 'lead_source', v_row.source,
      'fields', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) AS k)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'created', 'id', v_row.id, 'first_name', v_row.first_name,
                            'last_name', v_row.last_name, 'email', v_row.email, 'phone', v_row.phone,
                            'status', v_row.status, 'source', v_row.source);
END;
$$;

-- Move a contact to another stage, compare-and-swapped on the stage the caller read. The
-- row is locked first, so the check and the write are one decision. Outcomes, returned
-- rather than raised so the edge function maps each to its own message:
--   not_found      no such contact (nothing read, nothing audited)
--   system_status  the contact holds esign_signer: only the owner promotes it
--   archived       the contact is archived: the owner restores it first
--   stale          the stored stage is not p_expected_status
--   unchanged      already in that stage; nothing written
--   updated
-- A target that is the system status or no status at all is raised: the edge function
-- never sends one.
CREATE FUNCTION public.mcp_set_contact_status(
  p_contact_id uuid, p_status text, p_expected_status text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old text;
  v_archived timestamptz;
  v_row record;
BEGIN
  IF p_status IS NULL OR p_status = 'esign_signer'
     OR NOT EXISTS (SELECT 1 FROM public.contact_statuses s WHERE s.key = p_status) THEN
    RAISE EXCEPTION 'mcp_set_contact_status: invalid_status';
  END IF;

  SELECT c.status, c.archived_at INTO v_old, v_archived
    FROM public.contacts c
   WHERE c.id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_old = 'esign_signer' THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_set_contact_status',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'system_status'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'system_status', 'current_status', v_old);
  END IF;
  IF v_archived IS NOT NULL THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_set_contact_status',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'archived'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'archived');
  END IF;
  IF v_old IS DISTINCT FROM p_expected_status THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_set_contact_status',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'stale'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'stale', 'current_status', v_old);
  END IF;
  IF v_old = p_status THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_set_contact_status',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'unchanged'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'unchanged', 'status', v_old);
  END IF;

  -- The status alone: the trigger writes the history entry and client_since.
  UPDATE public.contacts SET status = p_status
   WHERE id = p_contact_id
  RETURNING id, first_name, last_name, status, client_since INTO v_row;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_set_contact_status',
    jsonb_build_object('contact_id', p_contact_id, 'from', v_old, 'to', p_status), p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'updated', 'id', v_row.id, 'first_name', v_row.first_name,
                            'last_name', v_row.last_name, 'from', v_old, 'status', v_row.status,
                            'client_since', v_row.client_since);
END;
$$;

-- ---------------------------------------------------------------------------
-- The work board
-- ---------------------------------------------------------------------------

-- The board as the owner sees it: every unarchived card, lane by lane in the lanes' order,
-- each lane in board order (a card never placed first, newest first, then the saved
-- places; the id breaks a tie). Optionally one lane, one contact. One more card than the
-- limit is read, only to learn whether more exist, so a cut list is never passed off as
-- the whole board.
CREATE FUNCTION public.mcp_list_board(
  p_stage text, p_contact_id uuid, p_limit integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(COALESCE(p_limit, 200), 1), 200);
  v_found integer;
  v_cards jsonb;
BEGIN
  IF p_stage IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.board_stages b WHERE b.key = p_stage) THEN
    RAISE EXCEPTION 'mcp_list_board: unknown_stage';
  END IF;

  SELECT count(*)::integer,
         COALESCE(jsonb_agg(m.obj ORDER BY m.n) FILTER (WHERE m.n <= v_limit), '[]'::jsonb)
    INTO v_found, v_cards
    FROM (
      SELECT row_number() OVER (
               ORDER BY b.sort_order, b.key, w.lane_position ASC NULLS FIRST, w.created_at DESC, w.id) AS n,
             jsonb_build_object(
               'id', w.id, 'title', w.title, 'stage', w.stage, 'lane', b.label,
               'work_item_type', w.work_item_type, 'priority', w.priority, 'due_date', w.due_date,
               'contact_id', w.contact_id, 'contact_name', NULLIF(c.full_name, ''),
               'created_at', w.created_at) AS obj
        FROM public.work_items w
        JOIN public.board_stages b ON b.key = w.stage
        LEFT JOIN public.contacts c ON c.id = w.contact_id
       WHERE w.archived_at IS NULL
         AND (p_stage IS NULL OR w.stage = p_stage)
         AND (p_contact_id IS NULL OR w.contact_id = p_contact_id)
       ORDER BY n
       LIMIT v_limit + 1
    ) m;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_list_board',
    jsonb_build_object('stage', p_stage, 'contact_id', p_contact_id,
                       'returned', jsonb_array_length(v_cards), 'truncated', v_found > v_limit),
    p_ip, p_user_agent);

  RETURN jsonb_build_object(
    'lanes', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label) ORDER BY b.sort_order, b.key)
                         FROM public.board_stages b), '[]'::jsonb),
    'cards', v_cards,
    'truncated', v_found > v_limit);
END;
$$;

-- The contact a card is tied to: it must exist and be on the working list. Raised as the
-- calling function's sentinel. A share lock, so the contact cannot be archived or deleted
-- between this check and the card's write.
CREATE FUNCTION public.mcp_work_item_contact_ok(p_contact_id uuid, p_fn text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_archived timestamptz;
BEGIN
  SELECT c.archived_at INTO v_archived FROM public.contacts c WHERE c.id = p_contact_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: contact_not_found', p_fn;
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION '%: contact_archived', p_fn;
  END IF;
END;
$$;

-- create_work_item's twin for the server: the card and the history row recording the
-- lane it started in, in one transaction, with the audit row. NULL type, stage or
-- priority take the column defaults. The type must be an ACTIVE one: a foreign key
-- accepts a retired type.
CREATE FUNCTION public.mcp_create_work_item(
  p_title text, p_contact_id uuid, p_work_item_type text, p_stage text, p_priority text, p_due_date date,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  IF p_contact_id IS NOT NULL THEN
    PERFORM public.mcp_work_item_contact_ok(p_contact_id, 'mcp_create_work_item');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_item_types t WHERE t.key = COALESCE(p_work_item_type, 'task') AND t.is_active) THEN
    RAISE EXCEPTION 'mcp_create_work_item: inactive_type';
  END IF;

  INSERT INTO public.work_items (title, contact_id, work_item_type, stage, priority, due_date)
  VALUES (btrim(p_title), p_contact_id, COALESCE(p_work_item_type, 'task'), COALESCE(p_stage, 'todo'),
          COALESCE(p_priority, 'normal'), p_due_date)
  RETURNING id, title, contact_id, work_item_type, stage, priority, due_date INTO v_row;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (v_row.id, 'created', NULL, v_row.stage, p_actor, jsonb_build_object('source', 'mcp'));

  PERFORM public.mcp_audit_row(p_actor, 'mcp_create_work_item',
    jsonb_build_object('work_item_id', v_row.id, 'contact_id', p_contact_id, 'stage', v_row.stage),
    p_ip, p_user_agent);

  RETURN to_jsonb(v_row);
END;
$$;

-- A card's face: title, contact, type, priority and due date. A key is applied only when
-- PRESENT, so an explicit null clears the contact or the due date and an absent key leaves
-- it. The stage is not here: a move needs a reason (mcp_move_work_item). An archived card
-- is off the board and is not edited from here. Outcomes:
--   not_found     no such card (nothing read, nothing audited)
--   not_on_board  the card is archived
--   updated       with the card as it now stands
CREATE FUNCTION public.mcp_update_work_item(p_id uuid, p_patch jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_archived timestamptz;
  v_row record;
BEGIN
  -- Locked, so the card cannot be archived between this check and the write.
  SELECT w.archived_at INTO v_archived FROM public.work_items w WHERE w.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_archived IS NOT NULL THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_update_work_item',
      jsonb_build_object('work_item_id', p_id, 'outcome', 'not_on_board'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'not_on_board');
  END IF;
  IF p_patch ? 'contact_id' AND p_patch ->> 'contact_id' IS NOT NULL THEN
    PERFORM public.mcp_work_item_contact_ok((p_patch ->> 'contact_id')::uuid, 'mcp_update_work_item');
  END IF;
  IF p_patch ? 'work_item_type'
     AND NOT EXISTS (SELECT 1 FROM public.work_item_types t WHERE t.key = p_patch ->> 'work_item_type' AND t.is_active) THEN
    RAISE EXCEPTION 'mcp_update_work_item: inactive_type';
  END IF;

  UPDATE public.work_items SET
    title          = CASE WHEN p_patch ? 'title' THEN btrim(p_patch ->> 'title') ELSE title END,
    contact_id     = CASE WHEN p_patch ? 'contact_id' THEN (p_patch ->> 'contact_id')::uuid ELSE contact_id END,
    work_item_type = CASE WHEN p_patch ? 'work_item_type' THEN p_patch ->> 'work_item_type' ELSE work_item_type END,
    priority       = CASE WHEN p_patch ? 'priority' THEN p_patch ->> 'priority' ELSE priority END,
    due_date       = CASE WHEN p_patch ? 'due_date' THEN (p_patch ->> 'due_date')::date ELSE due_date END
  WHERE id = p_id AND archived_at IS NULL
  RETURNING id, title, contact_id, work_item_type, stage, priority, due_date INTO v_row;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_update_work_item',
    jsonb_build_object('work_item_id', p_id,
      'fields', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) AS k)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'updated', 'card', to_jsonb(v_row));
END;
$$;

-- move_work_item_stage's twin for the server. Outcomes:
--   not_found     no such card (nothing read, nothing audited)
--   not_on_board  the card is archived
--   stale         the card is not in p_expected_stage (someone moved it first)
--   unchanged     already in p_stage; nothing written
--   moved
-- The reason is required and kept in the card's history; the place in the lane is
-- cleared, as every move on the board clears it.
CREATE FUNCTION public.mcp_move_work_item(
  p_id uuid, p_stage text, p_expected_stage text, p_note text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_note text := btrim(p_note);
  v_from text;
  v_archived timestamptz;
BEGIN
  IF v_note IS NULL OR v_note = '' THEN
    RAISE EXCEPTION 'mcp_move_work_item: note_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.board_stages b WHERE b.key = p_stage) THEN
    RAISE EXCEPTION 'mcp_move_work_item: unknown_stage';
  END IF;

  SELECT w.stage, w.archived_at INTO v_from, v_archived FROM public.work_items w WHERE w.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_archived IS NOT NULL THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_move_work_item',
      jsonb_build_object('work_item_id', p_id, 'outcome', 'not_on_board'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'not_on_board');
  END IF;
  IF v_from IS DISTINCT FROM p_expected_stage THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_move_work_item',
      jsonb_build_object('work_item_id', p_id, 'outcome', 'stale'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'stale', 'current_stage', v_from);
  END IF;
  IF v_from = p_stage THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_move_work_item',
      jsonb_build_object('work_item_id', p_id, 'outcome', 'unchanged'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'unchanged', 'stage', v_from);
  END IF;

  UPDATE public.work_items
     SET stage = p_stage, stage_updated_at = now(), lane_position = NULL
   WHERE id = p_id;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (p_id, 'stage_changed', v_from, p_stage, p_actor, jsonb_build_object('note', v_note, 'source', 'mcp'));

  PERFORM public.mcp_audit_row(p_actor, 'mcp_move_work_item',
    jsonb_build_object('work_item_id', p_id, 'from', v_from, 'to', p_stage), p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'moved', 'from', v_from, 'stage', p_stage);
END;
$$;

-- add_work_item_note's twin for the server: a note on a card's history without a move.
-- History is owner-only, so a note never reaches a client. An archived card is off the
-- board and takes no note from here. Outcomes: not_found (nothing audited), not_on_board,
-- noted.
CREATE FUNCTION public.mcp_add_work_item_note(p_id uuid, p_note text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_note text := btrim(p_note);
  v_archived timestamptz;
BEGIN
  IF v_note IS NULL OR v_note = '' THEN
    RAISE EXCEPTION 'mcp_add_work_item_note: note_required';
  END IF;
  -- A share lock, so the card cannot be archived between this check and the note.
  SELECT w.archived_at INTO v_archived FROM public.work_items w WHERE w.id = p_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_archived IS NOT NULL THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_add_work_item_note',
      jsonb_build_object('work_item_id', p_id, 'outcome', 'not_on_board'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'not_on_board');
  END IF;

  INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, actor_user_id, detail)
  VALUES (p_id, 'note_added', NULL, NULL, p_actor, jsonb_build_object('note', v_note, 'source', 'mcp'));

  PERFORM public.mcp_audit_row(p_actor, 'mcp_add_work_item_note',
    jsonb_build_object('work_item_id', p_id), p_ip, p_user_agent);
  RETURN jsonb_build_object('outcome', 'noted');
END;
$$;

-- ---------------------------------------------------------------------------
-- The requests
-- ---------------------------------------------------------------------------

-- Close a sent or submitted request, bound to the contact named. {applied, reason}:
--   applied true   closed now; from_status is what it was
--   already_closed closing again changes nothing
--   draft          the client never saw it
--   not_found      no such request for that contact (nothing audited)
CREATE FUNCTION public.mcp_close_request(p_list_id uuid, p_contact_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old text;
BEGIN
  SELECT l.status INTO v_old
    FROM public.needs_lists l
   WHERE l.id = p_list_id AND l.contact_id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  IF v_old IN ('closed', 'draft') THEN
    PERFORM public.mcp_request_audit(p_actor, 'mcp_close_request',
      jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id,
                         'outcome', CASE v_old WHEN 'closed' THEN 'already_closed' ELSE 'draft' END),
      p_ip, p_user_agent);
    RETURN jsonb_build_object('applied', false, 'reason', CASE v_old WHEN 'closed' THEN 'already_closed' ELSE 'draft' END);
  END IF;

  UPDATE public.needs_lists SET status = 'closed', closed_at = now() WHERE id = p_list_id;

  PERFORM public.mcp_request_audit(p_actor, 'mcp_close_request',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id, 'from_status', v_old),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('applied', true, 'from_status', v_old);
END;
$$;

-- Accept every answered item of a request, bound to the contact named, under a lock on
-- the list: one UPDATE, so an item is either accepted here or left answered for the next
-- accept. Only 'fulfilled' moves; an unanswered item never does. still_open counts the
-- items still waiting on the client (an info item asks nothing and is not counted).
-- list_status is read AFTER the items move: a trigger on needs_items may close the request
-- once every item is accepted, and the tool must report what is stored, not what was
-- read before. NULL when there is no such request for that contact.
CREATE FUNCTION public.mcp_accept_request(p_list_id uuid, p_contact_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_accepted integer;
  v_open integer;
BEGIN
  SELECT l.status INTO v_status
    FROM public.needs_lists l
   WHERE l.id = p_list_id AND l.contact_id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.needs_items i SET status = 'reviewed'
   WHERE i.list_id = p_list_id AND i.status = 'fulfilled';
  GET DIAGNOSTICS v_accepted = ROW_COUNT;

  SELECT count(*)::integer INTO v_open
    FROM public.needs_items i
   WHERE i.list_id = p_list_id AND i.status = 'pending' AND i.kind <> 'info';

  SELECT l.status INTO v_status FROM public.needs_lists l WHERE l.id = p_list_id;

  PERFORM public.mcp_request_audit(p_actor, 'mcp_accept_request',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id, 'accepted', v_accepted),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('accepted', v_accepted, 'still_open', v_open, 'list_status', v_status);
END;
$$;

-- Pause or resume the automatic reminders of one request, the contact bound into the
-- write's own predicate. NULL when there is no such request for that contact.
CREATE FUNCTION public.mcp_set_request_reminders(
  p_list_id uuid, p_contact_id uuid, p_paused boolean, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'mcp_set_request_reminders: paused_required';
  END IF;

  UPDATE public.needs_lists l SET reminders_paused = p_paused
   WHERE l.id = p_list_id AND l.contact_id = p_contact_id
  RETURNING l.id, l.title, l.status, l.reminders_paused INTO v_row;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM public.mcp_request_audit(p_actor, 'mcp_set_request_reminders',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id, 'paused', p_paused),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'title', v_row.title, 'status', v_row.status,
                            'reminders_paused', v_row.reminders_paused);
END;
$$;

-- Every open request, across every contact, each with the section it belongs to:
-- waiting_on_you, waiting_on_client or drafts (see the header). Sections in that order,
-- clients A to Z within one, newest first for one client, the id breaking a tie. One more
-- row than the limit is read, only to learn whether more exist. Narrow columns: no
-- answer, no token, nothing a client typed.
CREATE FUNCTION public.mcp_list_open_requests(p_limit integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(COALESCE(p_limit, 500), 1), 500);
  v_found integer;
  v_rows jsonb;
BEGIN
  SELECT count(*)::integer,
         COALESCE(jsonb_agg(m.obj ORDER BY m.n) FILTER (WHERE m.n <= v_limit), '[]'::jsonb)
    INTO v_found, v_rows
    FROM (
      SELECT row_number() OVER (
               ORDER BY r.section_rank, lower(r.client), r.created_at DESC, r.id) AS n,
             jsonb_build_object(
               'section', r.section, 'list_id', r.id, 'contact_id', r.contact_id, 'client', r.client,
               'title', r.title, 'status', r.status, 'items', r.items, 'answers_to_accept', r.to_accept,
               'sent_at', r.sent_at, 'submitted_at', r.submitted_at,
               'reminders_paused', r.reminders_paused, 'reminder_count', r.reminder_count) AS obj
        FROM (
          SELECT l.id, l.contact_id, c.full_name AS client, l.title, l.status, l.created_at, l.sent_at,
                 l.submitted_at, l.reminders_paused, l.reminder_count, q.items, q.to_accept,
                 CASE
                   WHEN l.status = 'submitted' OR (l.status = 'sent' AND q.to_accept > 0) THEN 'waiting_on_you'
                   WHEN l.status = 'sent' THEN 'waiting_on_client'
                   ELSE 'drafts'
                 END AS section,
                 CASE
                   WHEN l.status = 'submitted' OR (l.status = 'sent' AND q.to_accept > 0) THEN 1
                   WHEN l.status = 'sent' THEN 2
                   ELSE 3
                 END AS section_rank
            FROM public.needs_lists l
            JOIN public.contacts c ON c.id = l.contact_id
           CROSS JOIN LATERAL (
             SELECT count(*)::integer AS items,
                    (count(*) FILTER (WHERE i.status = 'fulfilled'))::integer AS to_accept
               FROM public.needs_items i
              WHERE i.list_id = l.id
           ) q
           WHERE l.status IN ('draft', 'sent', 'submitted')
        ) r
       ORDER BY n
       LIMIT v_limit + 1
    ) m;

  PERFORM public.mcp_request_audit(p_actor, 'mcp_list_open_requests',
    jsonb_build_object('returned', jsonb_array_length(v_rows), 'truncated', v_found > v_limit),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('rows', v_rows, 'truncated', v_found > v_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: the functions this file creates, never a sweep. The three it
-- replaces (and the three OAuth functions above) keep the privileges 0007 gave them
-- (CREATE OR REPLACE does not change them).
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.mcp_consent_version(),
  public.mcp_set_contact_status(uuid, text, text, uuid, text, text),
  public.mcp_list_board(text, uuid, integer, uuid, text, text),
  public.mcp_work_item_contact_ok(uuid, text),
  public.mcp_create_work_item(text, uuid, text, text, text, date, uuid, text, text),
  public.mcp_update_work_item(uuid, jsonb, uuid, text, text),
  public.mcp_move_work_item(uuid, text, text, text, uuid, text, text),
  public.mcp_add_work_item_note(uuid, text, uuid, text, text),
  public.mcp_close_request(uuid, uuid, uuid, text, text),
  public.mcp_accept_request(uuid, uuid, uuid, text, text),
  public.mcp_set_request_reminders(uuid, uuid, boolean, uuid, text, text),
  public.mcp_list_open_requests(integer, uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

-- The consent version is read by the column default, which runs in the grant writer's
-- transaction (the server's), and by the three functions above.
GRANT EXECUTE ON FUNCTION
  public.mcp_consent_version(),
  public.mcp_set_contact_status(uuid, text, text, uuid, text, text),
  public.mcp_list_board(text, uuid, integer, uuid, text, text),
  public.mcp_work_item_contact_ok(uuid, text),
  public.mcp_create_work_item(text, uuid, text, text, text, date, uuid, text, text),
  public.mcp_update_work_item(uuid, jsonb, uuid, text, text),
  public.mcp_move_work_item(uuid, text, text, text, uuid, text, text),
  public.mcp_add_work_item_note(uuid, text, uuid, text, text),
  public.mcp_close_request(uuid, uuid, uuid, text, text),
  public.mcp_accept_request(uuid, uuid, uuid, text, text),
  public.mcp_set_request_reminders(uuid, uuid, boolean, uuid, text, text),
  public.mcp_list_open_requests(integer, uuid, text, text)
TO service_role;
