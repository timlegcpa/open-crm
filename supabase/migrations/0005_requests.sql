-- 0005_requests: requests a client answers in the portal.
--
-- Belongs here: the request lists, their items, answers and uploaded item documents,
-- the request pick-lists (request_categories, request_tags) and templates, the start-link
-- path for a contact with no portal account yet (pending_signup_requests), the draft
-- functions (needs_owner_save_draft, needs_replace_draft, needs_delete_draft), and the
-- request lists in the supabase_realtime publication. The database keeps the needs_*
-- names; everything a person reads says "Requests".
--
-- Depends on: 0003_documents (an uploaded answer is a client document), 0002_contacts
-- (contacts, client_portal_accounts, portal_invitations, guard_pick_list), 0001_core
-- (is_owner, mfa_session_ok, org_profile, audit_logs, set_updated_at).
--
-- Principals:
--   owner   reads and writes every row here through RLS (is_owner()); the builder saves
--           a draft in one call to needs_owner_save_draft.
--   client  READS its own lists once sent (never a draft), their items and item
--           documents, and writes NOTHING here. Every change a client makes (an answer, a
--           ticked to-do, a linked upload, a submit, its contact details) goes through the
--           needs-save edge function, which calls the server-only functions below. Those
--           functions are the whole rule for client writes: there is no client write
--           policy on any needs_* table, and re-adding one reopens what it closed (a
--           client un-accepting its own answer, submitting past the completeness check,
--           answering a closed list). So no table here is client-writable and none
--           carries trg_impersonation_read_only; View as client is read-only by construction.
--   server  service_role (edge functions): sending, reminders, client writes, start links.
--
-- The request's own rules, each enforced here rather than trusted to the app:
--   * content_version moves on every change to what the client will see (the list's
--     title, intro and contact-confirm switch; any item's content), and NEVER when a
--     client answers or the owner accepts: send-needs-list publishes a draft only if the
--     version is still the one it read (needs_send_list), so an edit landing mid-send
--     publishes nothing. A trigger that compared status or an answer column would break
--     that, and the reminder and review-token paths built on it.
--   * Status moves only forward, and only the server publishes: a new list is a draft;
--     draft -> sent and sent -> submitted are the server's (send, submit); the owner may
--     close a sent or submitted list. Closing a draft used to be possible, and it showed
--     never-sent content to the client (the client reads every status but draft).
--   * Items are edited only while their list is a draft (or by the server), so a builder
--     save that lands after the list was sent is refused instead of replacing the items
--     a client is answering. The owner's builder writes a draft only through
--     needs_owner_save_draft, which locks the list (as a send does), and deletes a list
--     only through needs_owner_delete_list, which audits it. An answer is only ever the
--     client's, written by the server.
--   * A client write locks its list first (as submit does), so it never lands on a list
--     submitted in between; a client cannot delete a file once its request was handed
--     in or the item accepted, and an item that loses its last file is open again.
--   * Reminders claim the count before sending (one at a time per list), and a reminder's
--     link replaces the older ones only once its email went.
--   * Pick-list keys an item names are foreign keys (a pick-list row in use cannot be
--     deleted). Keys inside needs_templates.items and a draft function's p_items are not
--     checked until an item row is written: the builder maps an unknown key to general.
--   * A start link stores only the SHA-256 of its token. Redeeming one (accept-start-link)
--     claims it, links one portal account, then retires it (status consumed, and the hash
--     overwritten so the emailed token stops resolving), all through the functions below.
--     It is issued only for the contact and address the send read, and stops working when
--     its request is closed or deleted, the address changes, access is revoked, or the
--     contact already has a sign-in.
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
-- Errors the server functions answer with, as text, so the edge functions can map each:
--   needs_send_list            sent | already_sent | changed | contact_changed | address_changed
--                              | gone | not_draft
--   needs_recipient_current    ok | gone | contact_changed | address_changed
--   needs_client_submit        submitted | already_submitted | incomplete | not_open | not_found
--   needs_claim_reminder       claimed | in_progress | not_sent
--   needs_issue_start_link     raises contact_changed / address_changed
-- and the draft functions raise not_found / not_draft (plus stale_content, has_answers,
-- has_documents for a delete).

-- ---------------------------------------------------------------------------
-- The request pick-lists. Seeded BEFORE the guard triggers exist: guard_pick_list refuses
-- to insert a row the code depends on (a system row). `general` is what every item
-- defaults to and what an unknown key falls back to, so it is the system row of each.
-- The portal never shows these labels; they sort and file the owner's side.
-- ---------------------------------------------------------------------------

CREATE TABLE public.request_categories (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text CHECK (colour IS NULL OR colour ~ '^#[0-9a-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

INSERT INTO public.request_categories (key, label, sort_order, is_system) VALUES
  ('general', 'General', 10, true),
  ('contract', 'Contract', 20, false),
  ('invoice', 'Invoice', 30, false),
  ('receipt', 'Receipt', 40, false),
  ('statement', 'Statement', 50, false),
  ('id_verification', 'ID verification', 60, false);

CREATE TABLE public.request_tags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text CHECK (colour IS NULL OR colour ~ '^#[0-9a-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

INSERT INTO public.request_tags (key, label, sort_order, is_system) VALUES
  ('general', 'General', 10, true),
  ('personal', 'Personal', 20, false),
  ('business', 'Business', 30, false);

CREATE TRIGGER trg_request_categories_guard BEFORE INSERT OR UPDATE OR DELETE ON public.request_categories
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();
CREATE TRIGGER trg_request_tags_guard BEFORE INSERT OR UPDATE OR DELETE ON public.request_tags
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();

-- ---------------------------------------------------------------------------
-- Lists, items, the documents uploaded for an item
-- ---------------------------------------------------------------------------

CREATE TABLE public.needs_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  -- The client reads the title in emails, the portal and a folder name.
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND pg_catalog.btrim(title) <> ''),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'submitted', 'closed')),
  intro_message text CHECK (intro_message IS NULL OR char_length(intro_message) <= 5000),
  include_contact_confirm boolean NOT NULL DEFAULT false,
  reminders_paused boolean NOT NULL DEFAULT false,
  reminder_count integer NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  last_reminded_at timestamptz,
  -- The owner, or the system actor for a list made by the server.
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  submitted_at timestamptz,
  closed_at timestamptz,
  -- See the header: moved by the triggers below on client-visible content only.
  content_version integer NOT NULL DEFAULT 0,
  -- When the owner was last emailed about an upload to this list (at most one notice per
  -- 30 minutes). Written only through needs_claim_upload_notice / _release.
  upload_notified_at timestamptz
);

CREATE INDEX idx_needs_lists_contact ON public.needs_lists (contact_id);
CREATE INDEX idx_needs_lists_created_by ON public.needs_lists (created_by);
-- The reminder dispatcher reads sent lists in id order.
CREATE INDEX idx_needs_lists_sent ON public.needs_lists (id) WHERE status = 'sent';

CREATE TABLE public.needs_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES public.needs_lists (id) ON DELETE CASCADE,
  -- document: upload a file; question: type an answer; todo: tick it off; info: read only.
  kind text NOT NULL CHECK (kind IN ('document', 'question', 'todo', 'info')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 500 AND pg_catalog.btrim(label) <> ''),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  sort_order integer NOT NULL DEFAULT 0,
  required boolean NOT NULL DEFAULT true,
  -- reviewed is what the screens call Accepted: the owner has locked the answer.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'reviewed')),
  answer_text text CHECK (answer_text IS NULL OR char_length(answer_text) <= 5000),
  tag text NOT NULL DEFAULT 'general' REFERENCES public.request_tags (key),
  category text NOT NULL DEFAULT 'general' REFERENCES public.request_categories (key),
  -- A sensitive question's answer is stored only encrypted (AES-GCM, PII_ENCRYPTION_KEY,
  -- written by needs-save) and read only through needs-reveal-answer, which audits it.
  sensitive boolean NOT NULL DEFAULT false,
  answer_ciphertext bytea CHECK (answer_ciphertext IS NULL OR octet_length(answer_ciphertext) <= 20480),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT needs_items_sensitive_question_only CHECK (NOT sensitive OR kind = 'question'),
  -- Exactly one place an answer can live, by the item's sensitivity.
  CONSTRAINT needs_items_answer_channel CHECK (
    (sensitive AND answer_text IS NULL) OR (NOT sensitive AND answer_ciphertext IS NULL))
);

CREATE INDEX idx_needs_items_list ON public.needs_items (list_id);
CREATE INDEX idx_needs_items_tag ON public.needs_items (tag);
CREATE INDEX idx_needs_items_category ON public.needs_items (category);

CREATE TABLE public.needs_item_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.needs_items (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.client_documents (id) ON DELETE CASCADE,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  -- Leads with item_id, so it also serves reads by item.
  CONSTRAINT needs_item_documents_item_document_key UNIQUE (item_id, document_id)
);

-- A document delete (and a contact delete, through client_documents) cascades here.
CREATE INDEX idx_needs_item_documents_document ON public.needs_item_documents (document_id);

-- The owner's reusable lists. `items` is what the builder applies: an array of
-- { kind, label, description, required, sensitive, category, tag }.
CREATE TABLE public.needs_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND pg_catalog.btrim(name) <> ''),
  intro_message text CHECK (intro_message IS NULL OR char_length(intro_message) <= 5000),
  include_contact_confirm boolean NOT NULL DEFAULT false,
  items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(items) = 'array' AND pg_column_size(items) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_needs_templates_updated_at
  BEFORE UPDATE ON public.needs_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A start link: a request sent to a contact with no active portal account carries one,
-- and redeeming it creates the contact's sign-in (accept-start-link, /start). Written
-- only by the server; the owner may read.
CREATE TABLE public.pending_signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The address the sign-in is created for, stored lowercased and trimmed.
  email text NOT NULL CHECK (email = lower(pg_catalog.btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  -- SET NULL, never CASCADE: a link whose contact was deleted must read as such (and be
  -- refused) rather than vanish mid-redemption.
  contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL,
  needs_list_id uuid REFERENCES public.needs_lists (id) ON DELETE SET NULL,
  -- sha256 hex of the emailed token; 'consumed:<id>' once retired, which no token hashes to.
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$' OR token_hash ~ '^consumed:[0-9a-f-]{36}$'),
  expires_at timestamptz NOT NULL,
  -- superseded: a reminder sent the contact a fresh link for the same list, or another
  -- link to the same address made the account first.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'superseded')),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  -- One redemption at a time (claim_start_link); a claim older than five minutes is a
  -- crashed attempt and may be taken over.
  claim uuid,
  claimed_at timestamptz
);

CREATE INDEX idx_pending_signup_email_status ON public.pending_signup_requests (email, status);
CREATE INDEX idx_pending_signup_expires ON public.pending_signup_requests (expires_at) WHERE status = 'pending';
CREATE INDEX idx_pending_signup_contact ON public.pending_signup_requests (contact_id);
CREATE INDEX idx_pending_signup_list ON public.pending_signup_requests (needs_list_id);
CREATE INDEX idx_pending_signup_created_by ON public.pending_signup_requests (created_by);

-- ---------------------------------------------------------------------------
-- Triggers: the content version, and the rules on status and draft-only edits
-- ---------------------------------------------------------------------------

-- Item rows: statement triggers with transition tables, so a replace of N items bumps the
-- version once per statement. Definers: the version is no signed-in session's to write
-- (the grants leave it out), yet an owner's accept fires these too. Postgres refuses `UPDATE OF col` together with transition
-- tables, so the update trigger compares the content columns in its body. It must never
-- compare status, answer_text or answer_ciphertext (see the header).
CREATE FUNCTION public._needs_bump_version_new()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l
     SET content_version = l.content_version + 1
   WHERE l.id IN (SELECT DISTINCT n.list_id FROM new_items n);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public._needs_bump_version_old()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l
     SET content_version = l.content_version + 1
   WHERE l.id IN (SELECT DISTINCT o.list_id FROM old_items o);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public._needs_bump_version_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l
     SET content_version = l.content_version + 1
   WHERE l.id IN (
     SELECT n.list_id FROM new_items n JOIN old_items o ON o.id = n.id
      WHERE n.kind IS DISTINCT FROM o.kind
         OR n.label IS DISTINCT FROM o.label
         OR n.description IS DISTINCT FROM o.description
         OR n.required IS DISTINCT FROM o.required
         OR n.sensitive IS DISTINCT FROM o.sensitive
         OR n.category IS DISTINCT FROM o.category
         OR n.tag IS DISTINCT FROM o.tag
         OR n.sort_order IS DISTINCT FROM o.sort_order
         OR n.list_id IS DISTINCT FROM o.list_id
     UNION
     -- An item moved to another list changes that list's content too.
     SELECT o.list_id FROM new_items n JOIN old_items o ON o.id = n.id
      WHERE n.list_id IS DISTINCT FROM o.list_id);
  RETURN NULL;
END;
$$;

-- The list's own client-visible columns, and who it goes to: a draft reassigned to
-- another contact is new content, so a send that read the old contact publishes nothing.
CREATE FUNCTION public._needs_bump_version_self()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.intro_message IS DISTINCT FROM OLD.intro_message
     OR NEW.include_contact_confirm IS DISTINCT FROM OLD.include_contact_confirm
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    NEW.content_version := OLD.content_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Status only moves forward, and only the server publishes or submits (see the header).
CREATE FUNCTION public.needs_lists_guard_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- The server: rolsuper or rolbypassrls (service_role, the migrations' role).
  v_server boolean := COALESCE((SELECT r.rolsuper OR r.rolbypassrls
                               FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT v_server THEN
      RAISE EXCEPTION 'needs_lists: a new request is a draft; only the server sends one'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- What the client reads is fixed once sent: only a draft's title, intro and
  -- contact-confirm switch change (or the server's).
  IF OLD.status <> 'draft' AND NOT v_server
     AND (NEW.title IS DISTINCT FROM OLD.title
          OR NEW.intro_message IS DISTINCT FROM OLD.intro_message
          OR NEW.include_contact_confirm IS DISTINCT FROM OLD.include_contact_confirm
          OR NEW.contact_id IS DISTINCT FROM OLD.contact_id) THEN
    RAISE EXCEPTION 'needs_lists: only a draft request can be edited'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'draft' AND NEW.status = 'sent' AND v_server)
     OR (OLD.status = 'sent' AND NEW.status = 'submitted' AND v_server)
     OR (OLD.status IN ('sent', 'submitted') AND NEW.status = 'closed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'needs_lists: a request cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = '42501';
END;
$$;

-- Items change only while their list is a draft, except for the server. A missing parent
-- is the cascade of a list (or contact) delete, which is allowed. An answer is the
-- client's alone: only the server writes one (through needs_client_set_answer), at any
-- status, since nothing would record an owner's rewrite of it. (The grants already keep
-- a signed-in session off every item column but status; this holds if they widen.)
CREATE FUNCTION public.needs_items_guard_draft()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF COALESCE((SELECT r.rolsuper OR r.rolbypassrls
                 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.answer_text IS DISTINCT FROM OLD.answer_text
                           OR NEW.answer_ciphertext IS DISTINCT FROM OLD.answer_ciphertext) THEN
    RAISE EXCEPTION 'needs_items: only the client answers'
      USING ERRCODE = '42501';
  END IF;
  SELECT l.status INTO v_status FROM public.needs_lists l WHERE l.id = COALESCE(NEW.list_id, OLD.list_id);
  IF FOUND AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'needs_items: only a draft request can be edited'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.list_id IS DISTINCT FROM OLD.list_id THEN
    SELECT l.status INTO v_status FROM public.needs_lists l WHERE l.id = OLD.list_id;
    IF FOUND AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'needs_items: only a draft request can be edited'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_needs_lists_guard_status
  BEFORE INSERT OR UPDATE ON public.needs_lists
  FOR EACH ROW EXECUTE FUNCTION public.needs_lists_guard_status();
CREATE TRIGGER trg_needs_lists_version_self
  BEFORE UPDATE ON public.needs_lists
  FOR EACH ROW EXECUTE FUNCTION public._needs_bump_version_self();

CREATE TRIGGER trg_needs_items_guard_draft
  BEFORE INSERT OR DELETE
    OR UPDATE OF list_id, kind, label, description, sort_order, required, sensitive, category, tag, answer_text, answer_ciphertext
  ON public.needs_items
  FOR EACH ROW EXECUTE FUNCTION public.needs_items_guard_draft();
CREATE TRIGGER trg_needs_items_version_ins
  AFTER INSERT ON public.needs_items REFERENCING NEW TABLE AS new_items
  FOR EACH STATEMENT EXECUTE FUNCTION public._needs_bump_version_new();
CREATE TRIGGER trg_needs_items_version_del
  AFTER DELETE ON public.needs_items REFERENCING OLD TABLE AS old_items
  FOR EACH STATEMENT EXECUTE FUNCTION public._needs_bump_version_old();
CREATE TRIGGER trg_needs_items_version_upd
  AFTER UPDATE ON public.needs_items REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items
  FOR EACH STATEMENT EXECUTE FUNCTION public._needs_bump_version_upd();

-- ---------------------------------------------------------------------------
-- How far a list has got: THE fulfilment rule, in one place for the server
-- ---------------------------------------------------------------------------

-- Per list: actionable items (every kind but info), how many of them are fulfilled, and
-- how many required ones are still open. Submit, the manual reminder and the dispatcher
-- all read this, so the gate and the counts in every email agree. The browser's twin is
-- isItemFulfilled in src/features/requests/lib/requests.ts (a parity test holds them):
--   document  at least one linked document
--   todo      ticked (fulfilled) or accepted (reviewed)
--   question  an encrypted answer stored, or answer text with something other than space
--   info      never (display only)
CREATE FUNCTION public.needs_list_progress(p_list_ids uuid[])
RETURNS TABLE (list_id uuid, actionable integer, fulfilled integer, required_open integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH items AS (
    SELECT i.list_id, i.required,
           CASE i.kind
             WHEN 'document' THEN EXISTS (SELECT 1 FROM public.needs_item_documents d WHERE d.item_id = i.id)
             WHEN 'todo' THEN i.status IN ('fulfilled', 'reviewed')
             WHEN 'question' THEN i.answer_ciphertext IS NOT NULL
                                  OR (i.answer_text IS NOT NULL AND i.answer_text ~ '[^[:space:]]')
             ELSE false
           END AS done
      FROM public.needs_items i
     WHERE i.list_id = ANY (p_list_ids) AND i.kind <> 'info'
  )
  SELECT l.id,
         COALESCE(count(items.list_id), 0)::integer,
         COALESCE(count(items.list_id) FILTER (WHERE items.done), 0)::integer,
         COALESCE(count(items.list_id) FILTER (WHERE items.required AND NOT items.done), 0)::integer
    FROM public.needs_lists l
    LEFT JOIN items ON items.list_id = l.id
   WHERE l.id = ANY (p_list_ids)
   GROUP BY l.id;
$$;

-- ---------------------------------------------------------------------------
-- Drafts (the server's: the AI connector edits and deletes drafts through these)
-- ---------------------------------------------------------------------------

-- Replace a draft's title, intro and items in one transaction. The row is locked before
-- the status check, so a send landing mid-call waits and then this refuses (or the send's
-- version check does). Returns how many items were written.
CREATE FUNCTION public.needs_replace_draft(
  p_list_id uuid,
  p_title text,
  p_items jsonb,
  p_intro text DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL,
  p_include_contact_confirm boolean DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_count integer := 0;
BEGIN
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'needs_replace_draft: items must be an array' USING ERRCODE = '22023';
  END IF;

  SELECT l.status INTO v_status
    FROM public.needs_lists l
   WHERE l.id = p_list_id AND (p_contact_id IS NULL OR l.contact_id = p_contact_id)
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'needs_replace_draft: not_found';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'needs_replace_draft: not_draft';
  END IF;

  UPDATE public.needs_lists l
     SET title = p_title,
         intro_message = p_intro,
         include_contact_confirm = COALESCE(p_include_contact_confirm, l.include_contact_confirm)
   WHERE l.id = p_list_id;

  DELETE FROM public.needs_items i WHERE i.list_id = p_list_id;

  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) > 0 THEN
    INSERT INTO public.needs_items (list_id, kind, label, description, required, category, tag, sensitive, sort_order, status)
    SELECT p_list_id, i.kind, i.label, i.description,
           COALESCE(i.required, true), COALESCE(i.category, 'general'), COALESCE(i.tag, 'general'),
           COALESCE(i.sensitive, false), COALESCE(i.sort_order, 0), 'pending'
      FROM jsonb_to_recordset(p_items) AS i(
        kind text, label text, description text, required boolean,
        category text, tag text, sensitive boolean, sort_order integer);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN v_count;
END;
$$;

-- The owner's builder save: create a draft (p_list_id NULL) or replace one at the version
-- the builder read, list fields and the full item list in one transaction. Any failure
-- (a bad item, a lost race) rolls back the whole call, so the old draft stays as it was.
-- Owner only: a View-as-client session is the client's own session and never passes
-- is_owner(). The replace itself is needs_replace_draft, which stays the server's.
CREATE FUNCTION public.needs_owner_save_draft(
  p_list_id uuid,
  p_contact_id uuid,
  p_expected_version integer,
  p_title text,
  p_intro text,
  p_include_contact_confirm boolean,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- A record, not the row type: nothing in public is named before the owner refusal.
  v_list record;
  v_id uuid;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;
  IF p_contact_id IS NULL OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_draft' USING ERRCODE = '22023';
  END IF;

  IF p_list_id IS NULL THEN
    INSERT INTO public.needs_lists (contact_id, title, created_by)
    VALUES (p_contact_id, p_title, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_list FROM public.needs_lists l WHERE l.id = p_list_id FOR UPDATE;
    IF NOT FOUND OR v_list.contact_id IS DISTINCT FROM p_contact_id THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF v_list.status <> 'draft' THEN
      RAISE EXCEPTION 'not_draft';
    END IF;
    IF v_list.content_version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'stale_content';
    END IF;
    v_id := p_list_id;
  END IF;

  PERFORM public.needs_replace_draft(v_id, p_title, p_items, p_intro, p_contact_id,
                                     COALESCE(p_include_contact_confirm, false));

  RETURN jsonb_build_object(
    'id', v_id,
    'content_version', (SELECT l.content_version FROM public.needs_lists l WHERE l.id = v_id));
END;
$$;

-- Delete a draft, only at the version the caller read, and never one holding a client's
-- answer or file (a draft is invisible to the client, so both should be impossible; if
-- they exist, refusing is the one safe answer). The audit row is written in the same
-- transaction. A contact mismatch reads as not_found, so the call reveals nothing.
CREATE FUNCTION public.needs_delete_draft(
  p_list_id uuid,
  p_contact_id uuid,
  p_expected_version integer,
  p_actor uuid,
  p_ip inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_list public.needs_lists;
  v_items integer;
BEGIN
  SELECT * INTO v_list FROM public.needs_lists l WHERE l.id = p_list_id FOR UPDATE;
  IF NOT FOUND OR v_list.contact_id IS DISTINCT FROM p_contact_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_list.status <> 'draft' THEN
    RAISE EXCEPTION 'not_draft';
  END IF;
  IF v_list.content_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'stale_content';
  END IF;
  IF EXISTS (SELECT 1 FROM public.needs_items i
              WHERE i.list_id = p_list_id
                AND (i.answer_text IS NOT NULL OR i.answer_ciphertext IS NOT NULL OR i.status <> 'pending')) THEN
    RAISE EXCEPTION 'has_answers';
  END IF;
  IF EXISTS (SELECT 1 FROM public.needs_item_documents d JOIN public.needs_items i ON i.id = d.item_id
              WHERE i.list_id = p_list_id) THEN
    RAISE EXCEPTION 'has_documents';
  END IF;

  SELECT count(*)::integer INTO v_items FROM public.needs_items i WHERE i.list_id = p_list_id;
  DELETE FROM public.needs_lists l WHERE l.id = p_list_id;

  -- Ids and counts only: the audit log is kept for years and read by the owner.
  INSERT INTO public.audit_logs (user_id, action, details, ip_address, user_agent)
  VALUES (
    COALESCE(p_actor, (SELECT o.system_user_id FROM public.org_profile o)),
    'needs_list_deleted',
    jsonb_build_object(
      'list_id', p_list_id,
      'contact_id', p_contact_id,
      'item_count', v_items,
      'content_version', v_list.content_version,
      'documents_deleted', 0,
      'source', 'server'),
    p_ip,
    left(p_user_agent, 512));
END;
$$;

-- ---------------------------------------------------------------------------
-- Sending and reminding (send-needs-list, needs-reminder-dispatcher)
-- ---------------------------------------------------------------------------

-- Whether the list still goes to the contact and address the caller read and is about to
-- email: the list is locked (FOR SHARE) and re-read, and the address must still be the
-- contact's current one (contacts.email, the mirror of its default primary address). A
-- send or reminder that read the old recipient emails nobody.
--   ok | gone | contact_changed | address_changed
CREATE FUNCTION public.needs_recipient_current(p_list_id uuid, p_contact_id uuid, p_email text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
BEGIN
  SELECT l.contact_id INTO v_contact FROM public.needs_lists l WHERE l.id = p_list_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_contact IS DISTINCT FROM p_contact_id THEN
    RETURN 'contact_changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = p_contact_id
                    AND lower(pg_catalog.btrim(c.email)) = lower(pg_catalog.btrim(p_email))) THEN
    RETURN 'address_changed';
  END IF;
  RETURN 'ok';
END;
$$;

-- Publish a draft: draft -> sent, only while its content is still the version the caller
-- read (a compare-and-swap) and it still goes to the contact and address the caller read
-- (needs_recipient_current, under this function's row lock). Nothing is visible to the
-- client until this succeeds, so an edit or an address correction landing between the
-- caller's read and here publishes nothing. Only one of the reasons is "already sent":
--   sent             published now
--   already_sent     another call published it first (whether its email landed is unknown)
--   changed          still a draft, so the content moved: nothing was sent
--   contact_changed  the list now belongs to another contact: nothing was sent
--   address_changed  the contact's address changed: nothing was sent
--   gone             deleted
--   not_draft        submitted or closed meanwhile
CREATE FUNCTION public.needs_send_list(p_list_id uuid, p_expected_version integer, p_contact_id uuid, p_email text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_version integer;
  v_recipient text;
BEGIN
  SELECT l.status, l.content_version INTO v_status, v_version
    FROM public.needs_lists l WHERE l.id = p_list_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_status = 'sent' THEN
    RETURN 'already_sent';
  END IF;
  IF v_status <> 'draft' THEN
    RETURN 'not_draft';
  END IF;
  IF v_version IS DISTINCT FROM p_expected_version THEN
    RETURN 'changed';
  END IF;
  v_recipient := public.needs_recipient_current(p_list_id, p_contact_id, p_email);
  IF v_recipient <> 'ok' THEN
    RETURN v_recipient;
  END IF;
  UPDATE public.needs_lists l SET status = 'sent', sent_at = now() WHERE l.id = p_list_id;
  RETURN 'sent';
END;
$$;

-- Claim the next reminder of a sent list: the count moves FIRST, and only from the count
-- the caller read (a compare-and-swap), so two reminders at once cannot both go: the
-- second finds the count moved and is refused. The claimed number keys the email and is
-- what a failed email gives back (needs_release_reminder).
--   claimed       this caller sends reminder number p_expected_count
--   in_progress   the count moved since the caller read it: another reminder got there
--   not_sent      the list is not (or no longer) sent
CREATE FUNCTION public.needs_claim_reminder(p_list_id uuid, p_expected_count integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE public.needs_lists l
     SET reminder_count = l.reminder_count + 1, last_reminded_at = now()
   WHERE l.id = p_list_id AND l.status = 'sent' AND l.reminder_count = p_expected_count;
  IF FOUND THEN
    RETURN 'claimed';
  END IF;
  SELECT l.status INTO v_status FROM public.needs_lists l WHERE l.id = p_list_id;
  RETURN CASE WHEN v_status = 'sent' THEN 'in_progress' ELSE 'not_sent' END;
END;
$$;

-- A reminder whose email failed gives its count back, only while nothing claimed after it.
CREATE FUNCTION public.needs_release_reminder(p_list_id uuid, p_claimed_count integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l
     SET reminder_count = l.reminder_count - 1
   WHERE l.id = p_list_id AND l.reminder_count = p_claimed_count + 1;
  RETURN FOUND;
END;
$$;

-- A start link for the contact and address the caller read and is about to email. The list
-- is locked and its contact re-checked under the lock, and the address must still be the
-- contact's: a list reassigned (or an address corrected) after the caller's read gets no
-- link, so one contact's address never carries a link into another contact's portal.
--   contact_changed   the list now belongs to another contact (or is gone)
--   address_changed   the address is no longer this contact's
CREATE FUNCTION public.needs_issue_start_link(
  p_list_id uuid,
  p_contact_id uuid,
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
  v_email text := lower(pg_catalog.btrim(p_email));
  v_id uuid;
BEGIN
  SELECT l.contact_id INTO v_contact FROM public.needs_lists l WHERE l.id = p_list_id FOR UPDATE;
  IF NOT FOUND OR v_contact IS DISTINCT FROM p_contact_id THEN
    RAISE EXCEPTION 'contact_changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = p_contact_id AND lower(pg_catalog.btrim(c.email)) = v_email) THEN
    RAISE EXCEPTION 'address_changed';
  END IF;
  INSERT INTO public.pending_signup_requests (email, contact_id, needs_list_id, token_hash, expires_at, created_by)
  VALUES (v_email, p_contact_id, p_list_id, p_token_hash, p_expires_at, p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- After a reminder's email was accepted: the list's OLDER pending links stop working, so
-- the newest email holds the live one. Never before the email went (a failed reminder
-- must not kill the link the client already holds), never the kept link, and never a
-- newer one: a reminder that finishes after a later one must not kill the link in the
-- later email. (Links issued in the same instant are treated as older.)
CREATE FUNCTION public.needs_supersede_start_links(p_list_id uuid, p_keep uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.pending_signup_requests r
     SET status = 'superseded'
   WHERE r.needs_list_id = p_list_id AND r.status = 'pending' AND r.id <> p_keep
     AND r.created_at <= (SELECT k.created_at FROM public.pending_signup_requests k WHERE k.id = p_keep);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- A client's writes (needs-save, the ONLY door for them). Each first takes the list row
-- (FOR SHARE, the lock order submit uses: list, then items) and re-checks it is still
-- sent, so a write and a submit run one after the other: a write never lands on a list
-- that was submitted in between. Then one guarded statement: the item must be the
-- caller's (through its list), the list still sent, and the item not accepted. NULL when
-- the guard matched nothing; the function then reports "already accepted" or the list's
-- state.
-- ---------------------------------------------------------------------------

-- Store a question's answer. A sensitive item takes only the ciphertext (encrypted by the
-- server), any other only the text; the item is fulfilled when an answer is stored.
-- Returns the new status, or NULL.
CREATE FUNCTION public.needs_client_set_answer(
  p_contact_id uuid,
  p_item_id uuid,
  p_answer_text text,
  p_answer_ciphertext bytea
)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_list_status text;
  v_status text;
BEGIN
  SELECT l.status INTO v_list_status
    FROM public.needs_items i JOIN public.needs_lists l ON l.id = i.list_id
   WHERE i.id = p_item_id AND l.contact_id = p_contact_id
     FOR SHARE OF l;
  IF v_list_status IS DISTINCT FROM 'sent' THEN
    RETURN NULL;
  END IF;
  UPDATE public.needs_items i
     SET answer_text = CASE WHEN i.sensitive THEN NULL ELSE p_answer_text END,
         answer_ciphertext = CASE WHEN i.sensitive THEN p_answer_ciphertext ELSE NULL END,
         status = CASE
           WHEN (i.sensitive AND p_answer_ciphertext IS NOT NULL) OR (NOT i.sensitive AND p_answer_text IS NOT NULL)
             THEN 'fulfilled' ELSE 'pending' END
    FROM public.needs_lists l
   WHERE i.id = p_item_id
     AND l.id = i.list_id
     AND l.contact_id = p_contact_id
     AND l.status = 'sent'
     AND i.kind = 'question'
     AND i.status IN ('pending', 'fulfilled')
  RETURNING i.status INTO v_status;
  RETURN v_status;
END;
$$;

-- Tick or untick a to-do. Returns the new status, or NULL.
CREATE FUNCTION public.needs_client_mark_todo(p_contact_id uuid, p_item_id uuid, p_done boolean)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_list_status text;
  v_status text;
BEGIN
  SELECT l.status INTO v_list_status
    FROM public.needs_items i JOIN public.needs_lists l ON l.id = i.list_id
   WHERE i.id = p_item_id AND l.contact_id = p_contact_id
     FOR SHARE OF l;
  IF v_list_status IS DISTINCT FROM 'sent' THEN
    RETURN NULL;
  END IF;
  UPDATE public.needs_items i
     SET status = CASE WHEN p_done THEN 'fulfilled' ELSE 'pending' END
    FROM public.needs_lists l
   WHERE i.id = p_item_id
     AND l.id = i.list_id
     AND l.contact_id = p_contact_id
     AND l.status = 'sent'
     AND i.kind = 'todo'
     AND i.status IN ('pending', 'fulfilled')
  RETURNING i.status INTO v_status;
  RETURN v_status;
END;
$$;

-- Attach an uploaded document to a document item and mark it fulfilled, in ONE
-- transaction: the status flip locks the item row, so an Accept (or Accept all) cannot
-- land between the flip and the link and lock an item without its newest file. The
-- document must be one the caller uploaded (its own contact, its own section).
-- Returns linked (a new link), already_linked (a repeat of an earlier link), or NULL.
CREATE FUNCTION public.needs_client_link_document(p_contact_id uuid, p_item_id uuid, p_document_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_list_status text;
  v_inserted integer;
BEGIN
  SELECT l.status INTO v_list_status
    FROM public.needs_items i JOIN public.needs_lists l ON l.id = i.list_id
   WHERE i.id = p_item_id AND l.contact_id = p_contact_id
     FOR SHARE OF l;
  IF v_list_status IS DISTINCT FROM 'sent' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.client_documents d
                  WHERE d.id = p_document_id AND d.contact_id = p_contact_id AND d.held_by = 'client') THEN
    RETURN NULL;
  END IF;
  UPDATE public.needs_items i
     SET status = 'fulfilled'
    FROM public.needs_lists l
   WHERE i.id = p_item_id
     AND l.id = i.list_id
     AND l.contact_id = p_contact_id
     AND l.status = 'sent'
     AND i.kind = 'document'
     AND i.status IN ('pending', 'fulfilled');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.needs_item_documents (item_id, document_id)
  VALUES (p_item_id, p_document_id)
  ON CONFLICT (item_id, document_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN CASE WHEN v_inserted > 0 THEN 'linked' ELSE 'already_linked' END;
END;
$$;

-- Hand a list back: sent -> submitted, only when every required item is fulfilled (the
-- rule of needs_list_progress, re-derived here, never trusted from the browser). The row
-- lock makes two submits at once run one after the other; the second reads
-- already_submitted and sends no second set of emails.
CREATE FUNCTION public.needs_client_submit(p_contact_id uuid, p_list_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_open integer;
BEGIN
  SELECT l.status INTO v_status FROM public.needs_lists l
   WHERE l.id = p_list_id AND l.contact_id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_status = 'submitted' THEN
    RETURN 'already_submitted';
  END IF;
  IF v_status <> 'sent' THEN
    RETURN 'not_open';
  END IF;
  SELECT p.required_open INTO v_open FROM public.needs_list_progress(ARRAY[p_list_id]) p;
  IF COALESCE(v_open, 0) > 0 THEN
    RETURN 'incomplete';
  END IF;
  UPDATE public.needs_lists l SET status = 'submitted', submitted_at = now() WHERE l.id = p_list_id;
  RETURN 'submitted';
END;
$$;

-- The owner hears about an upload without waiting for Submit, at most once per list per
-- 30 minutes however many files arrive. The claim is one guarded statement, so of two
-- uploads at once only one gets the stamp back and sends. NULL: not this time.
CREATE FUNCTION public.needs_claim_upload_notice(p_list_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_stamp timestamptz;
BEGIN
  UPDATE public.needs_lists l
     SET upload_notified_at = clock_timestamp()
   WHERE l.id = p_list_id
     AND (l.upload_notified_at IS NULL OR l.upload_notified_at < clock_timestamp() - interval '30 minutes')
  RETURNING l.upload_notified_at INTO v_stamp;
  RETURN v_stamp;
END;
$$;

-- A notice that failed to send gives its claim back, so the next upload tries again; only
-- the caller's own stamp is cleared, never a newer claim.
CREATE FUNCTION public.needs_release_upload_notice(p_list_id uuid, p_stamp timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l SET upload_notified_at = NULL
   WHERE l.id = p_list_id AND l.upload_notified_at = p_stamp;
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Start links (accept-start-link)
-- ---------------------------------------------------------------------------

-- Whether this link may no longer create a sign-in. Any one of these refuses it:
--   * the contact is gone;
--   * portal access was taken away: every account the contact has is suspended or
--     deactivated (none active), or an account for this very address is, with none open
--     for it (a link sent before or after a revoke must not hand out a fresh login);
--   * the request it was sent with is gone, closed, or now belongs to another contact;
--   * the address is no longer one of the contact's (the owner corrected it);
--   * the contact already has an active sign-in (redeeming would make a second login;
--     the request is in the portal already).
CREATE FUNCTION public.start_link_access_revoked(p_contact_id uuid, p_email text, p_list_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_contact_id IS NULL
      OR (EXISTS (SELECT 1 FROM public.client_portal_accounts a
                   WHERE a.contact_id = p_contact_id AND a.status IN ('suspended', 'deactivated'))
          AND NOT EXISTS (SELECT 1 FROM public.client_portal_accounts a
                           WHERE a.contact_id = p_contact_id AND a.status = 'active'))
      OR (EXISTS (SELECT 1 FROM public.client_portal_accounts a
                   WHERE a.contact_id = p_contact_id AND a.status IN ('suspended', 'deactivated')
                     AND lower(a.invited_email) = lower(pg_catalog.btrim(p_email)))
          AND NOT EXISTS (SELECT 1 FROM public.client_portal_accounts a
                           WHERE a.contact_id = p_contact_id AND a.status IN ('invited', 'active')
                             AND lower(a.invited_email) = lower(pg_catalog.btrim(p_email))))
      OR NOT EXISTS (SELECT 1 FROM public.needs_lists l
                      WHERE l.id = p_list_id AND l.contact_id = p_contact_id AND l.status <> 'closed')
      OR NOT (EXISTS (SELECT 1 FROM public.contacts c
                       WHERE c.id = p_contact_id AND lower(pg_catalog.btrim(c.email)) = lower(pg_catalog.btrim(p_email)))
              OR EXISTS (SELECT 1 FROM public.contact_emails e
                          WHERE e.contact_id = p_contact_id AND e.kind = 'primary'
                            AND lower(pg_catalog.btrim(e.email)) = lower(pg_catalog.btrim(p_email))))
      OR EXISTS (SELECT 1 FROM public.client_portal_accounts a
                  WHERE a.contact_id = p_contact_id AND a.status = 'active' AND a.user_id IS NOT NULL);
$$;

-- The start link a token hashes to, with whether access was revoked since it was sent.
CREATE FUNCTION public.start_link_lookup(p_token_hash text)
RETURNS TABLE (
  id uuid, email text, contact_id uuid, needs_list_id uuid, status text, expires_at timestamptz,
  access_revoked boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT r.id, r.email, r.contact_id, r.needs_list_id, r.status, r.expires_at,
         public.start_link_access_revoked(r.contact_id, r.email, r.needs_list_id)
    FROM public.pending_signup_requests r
   WHERE r.token_hash = p_token_hash;
$$;

-- Mark a pending link expired (out of date, or refused as revoked).
CREATE FUNCTION public.expire_start_link(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.pending_signup_requests r SET status = 'expired' WHERE r.id = p_id AND r.status = 'pending';
  RETURN FOUND;
END;
$$;

-- Claim a pending, unexpired link for one redemption. Two redemptions at once once raced
-- (both answered success with different passwords, or the slower deleted the login the
-- faster had just made); the second now finds the claim held and is refused before it
-- creates or deletes anything. The row is locked while the claim is decided.
CREATE FUNCTION public.claim_start_link(p_id uuid, p_claim uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.pending_signup_requests r
     SET claim = p_claim, claimed_at = now()
   WHERE r.id = p_id
     AND r.status = 'pending'
     AND r.expires_at > now()
     AND (r.claim IS NULL OR r.claim = p_claim OR r.claimed_at < now() - interval '5 minutes');
  RETURN FOUND;
END;
$$;

-- Let go of a claim, only by the redemption that holds it.
CREATE FUNCTION public.release_start_link_claim(p_id uuid, p_claim uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.pending_signup_requests r SET claim = NULL, claimed_at = NULL
   WHERE r.id = p_id AND r.claim = p_claim;
END;
$$;

-- Delete the sign-in user an earlier, unfinished redemption left behind, deciding and
-- deleting in one statement so nothing changes in between, and only while the caller
-- holds this link's claim. THE STAMP IS REQUIRED, and that requirement is the whole
-- guard: a contact match alone once let a replayed token replace a live login's
-- password. The user must still be banned (created banned, un-banned at activation) and
-- stamped by a start link (pending_signup, set at create, cleared at activation), and
-- either:
--   * stamped by THIS link and holding no account but on this contact (the same attempt,
--     retried), or
--   * stamped by any start link and holding no account at all (abandoned before its
--     account existed; without this arm a re-issued link would be wedged for good).
-- Never the owner or the system actor. True when it deleted the user.
CREATE FUNCTION public.delete_stale_start_link_user(p_user uuid, p_id uuid, p_claim uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
  v_deleted integer;
BEGIN
  SELECT r.contact_id INTO v_contact FROM public.pending_signup_requests r
   WHERE r.id = p_id AND r.claim = p_claim AND r.status = 'pending';
  IF NOT FOUND OR v_contact IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM auth.users u
   WHERE u.id = p_user
     AND u.banned_until IS NOT NULL AND u.banned_until > now()
     AND COALESCE(u.raw_app_meta_data ->> 'pending_signup', '') <> ''
     AND (
       (u.raw_app_meta_data ->> 'pending_signup' = p_id::text
        AND NOT EXISTS (SELECT 1 FROM public.client_portal_accounts a
                         WHERE a.user_id = u.id AND a.contact_id <> v_contact))
       OR NOT EXISTS (SELECT 1 FROM public.client_portal_accounts a WHERE a.user_id = u.id))
     AND NOT EXISTS (SELECT 1 FROM public.org_profile o WHERE u.id = o.owner_user_id OR u.id = o.system_user_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- Attach a new sign-in user to the contact's portal account for this address, creating
-- the account when there is none. Locked and re-checked in the link's own transaction (a
-- revoke, an expiry or a contact delete landing after the caller's checks still wins), and
-- only by the redemption holding the claim. The account it reuses is the open one for this
-- address with no user (invited, or active with its user cleared by a failed earlier
-- attempt): `user_id IS NULL AND delete_claim IS NULL`, never `status = 'invited'`, which
-- would refuse that retry and let the next attempt insert a SECOND account. A new account
-- records the address, so a retry finds it instead of inserting beside it. NULL when the
-- link cannot be redeemed any more. A contact delete in progress raises
-- contact_delete_in_progress (0002) and an address with an open account raises 23505; the
-- caller rolls its new user back on any of these.
CREATE FUNCTION public.link_start_link(p_id uuid, p_user_id uuid, p_claim uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_link public.pending_signup_requests;
  v_account uuid;
BEGIN
  SELECT * INTO v_link FROM public.pending_signup_requests r WHERE r.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_link.status <> 'pending' OR v_link.expires_at <= now()
     OR v_link.claim IS DISTINCT FROM p_claim OR v_link.contact_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- The contact's accounts are locked BEFORE access is checked, so a revoke (a deactivate
  -- or suspend) either landed already and is seen, or waits until this link is done: it
  -- can never fall between the check and the write below and be undone by it.
  PERFORM 1 FROM public.client_portal_accounts a WHERE a.contact_id = v_link.contact_id FOR UPDATE;
  IF public.start_link_access_revoked(v_link.contact_id, v_link.email, v_link.needs_list_id) THEN
    RETURN NULL;
  END IF;

  UPDATE public.client_portal_accounts a
     SET user_id = p_user_id, status = 'active', activated_at = now()
   WHERE a.id = (
           SELECT c.id FROM public.client_portal_accounts c
            WHERE c.contact_id = v_link.contact_id
              AND c.status IN ('invited', 'active')
              AND lower(c.invited_email) = v_link.email
              AND c.user_id IS NULL
              AND c.delete_claim IS NULL
            ORDER BY c.invited_at DESC, c.id
            LIMIT 1)
     AND a.user_id IS NULL
     AND a.delete_claim IS NULL
  RETURNING a.id INTO v_account;
  IF v_account IS NOT NULL THEN
    RETURN v_account;
  END IF;

  -- Never a fresh account beside one the owner took away for this address.
  IF EXISTS (SELECT 1 FROM public.client_portal_accounts c
              WHERE c.contact_id = v_link.contact_id AND c.status IN ('suspended', 'deactivated')
                AND lower(c.invited_email) = v_link.email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.client_portal_accounts (user_id, contact_id, role, status, activated_at, invited_email)
  VALUES (
    p_user_id, v_link.contact_id,
    CASE WHEN EXISTS (SELECT 1 FROM public.client_portal_accounts c
                       WHERE c.contact_id = v_link.contact_id AND c.status = 'active')
         THEN 'secondary' ELSE 'primary' END,
    'active', now(), v_link.email)
  RETURNING id INTO v_account;
  RETURN v_account;
END;
$$;

-- Retire a redeemed link: consumed, and its hash overwritten, which is what actually kills
-- the credential (the lookup is an equality match on the token's hash, and nothing hashes
-- to 'consumed:<id>'). In the same transaction: the contact's other pending links to this
-- address are superseded (the sign-in now exists), and its pending portal invitations to
-- this address are revoked, compared lowercased and trimmed: an invitation to another
-- address on the contact (a spouse) stays live. Returns the revoked invitation ids.
CREATE FUNCTION public.retire_start_link(p_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_link public.pending_signup_requests;
  v_revoked uuid[];
BEGIN
  SELECT * INTO v_link FROM public.pending_signup_requests r WHERE r.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retire_start_link: not_found';
  END IF;
  UPDATE public.pending_signup_requests r
     SET status = 'consumed', consumed_at = now(), token_hash = 'consumed:' || r.id::text, claim = NULL, claimed_at = NULL
   WHERE r.id = p_id;
  IF v_link.contact_id IS NOT NULL THEN
    UPDATE public.pending_signup_requests r
       SET status = 'superseded'
     WHERE r.contact_id = v_link.contact_id AND r.email = v_link.email AND r.status = 'pending' AND r.id <> p_id;
    WITH revoked AS (
      UPDATE public.portal_invitations i
         SET status = 'revoked'
       WHERE i.contact_id = v_link.contact_id
         AND lower(pg_catalog.btrim(i.email)) = v_link.email
         AND i.status = 'pending'
      RETURNING i.id)
    SELECT COALESCE(array_agg(revoked.id ORDER BY revoked.id), '{}') INTO v_revoked FROM revoked;
  END IF;
  RETURN COALESCE(v_revoked, '{}');
END;
$$;

-- Retention: a link that expired more than 30 days ago and was never used has nothing
-- left to say. For the scheduled maintenance job (the server's alone).
CREATE FUNCTION public.cleanup_stale_start_links()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.pending_signup_requests r
   WHERE r.expires_at < now() - interval '30 days' AND r.consumed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('start_links', v_count);
END;
$$;

-- A start link stops working when what it was sent for goes away: its request closed or
-- deleted (BEFORE the delete: after it the foreign key has already cleared needs_list_id),
-- or the contact's address changed (every pending link to another address). The lookup
-- refuses those links anyway (start_link_access_revoked); this makes them read as expired.
-- Definer: the owner closes, deletes and edits, and never writes start links itself.
CREATE FUNCTION public._needs_expire_start_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'needs_lists' THEN
    UPDATE public.pending_signup_requests r SET status = 'expired'
     WHERE r.needs_list_id = OLD.id AND r.status = 'pending';
  ELSE
    UPDATE public.pending_signup_requests r SET status = 'expired'
     WHERE r.contact_id = OLD.id AND r.status = 'pending'
       AND r.email IS DISTINCT FROM lower(pg_catalog.btrim(NEW.email));
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_needs_lists_expire_start_links_close
  AFTER UPDATE OF status ON public.needs_lists
  FOR EACH ROW WHEN (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION public._needs_expire_start_links();
CREATE TRIGGER trg_needs_lists_expire_start_links_delete
  BEFORE DELETE ON public.needs_lists
  FOR EACH ROW EXECUTE FUNCTION public._needs_expire_start_links();
CREATE TRIGGER trg_contacts_expire_start_links
  AFTER UPDATE OF email ON public.contacts
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public._needs_expire_start_links();

-- ---------------------------------------------------------------------------
-- Answers a client cannot take back by deleting a file
-- ---------------------------------------------------------------------------

-- A client deletes its own uploads (0003), and a delete cascades to the item links here.
-- Once the request was handed in or closed, or the item accepted, that file is part of
-- the answer: a client's delete of it is refused. While the request is open and the item
-- not accepted the client may still remove it (the item is then re-checked below). The
-- owner and the server delete as before. Definer, so the check sees every link whatever
-- the caller may read.
CREATE FUNCTION public.needs_guard_document_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'authenticated' OR public.is_owner() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.needs_item_documents d
               JOIN public.needs_items i ON i.id = d.item_id
               JOIN public.needs_lists l ON l.id = i.list_id
              WHERE d.document_id = OLD.id AND (l.status <> 'sent' OR i.status = 'reviewed')) THEN
    RAISE EXCEPTION 'This file was handed in with a request, so it cannot be deleted.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_client_documents_needs_guard
  BEFORE DELETE ON public.client_documents
  FOR EACH ROW EXECUTE FUNCTION public.needs_guard_document_delete();

-- A document item that lost its last file is open again, in the same transaction as the
-- delete (a client's own delete, or the owner unlinking). An accepted item stays accepted.
-- Definer: the delete may be a client's, whose session cannot update items.
CREATE FUNCTION public._needs_recheck_document_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_items i
     SET status = 'pending'
   WHERE i.id = OLD.item_id AND i.kind = 'document' AND i.status = 'fulfilled'
     AND NOT EXISTS (SELECT 1 FROM public.needs_item_documents d WHERE d.item_id = OLD.item_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_needs_item_documents_recheck
  AFTER DELETE ON public.needs_item_documents
  FOR EACH ROW EXECUTE FUNCTION public._needs_recheck_document_item();

-- ---------------------------------------------------------------------------
-- The owner's delete
-- ---------------------------------------------------------------------------

-- Delete a request at any status, with an audit row in the same transaction (ids, counts
-- and the status it had; never a title or an answer). Returns the ids of the documents
-- that were linked to it, read before the cascade removes the links, so the browser can
-- delete those files through the documents API when asked. Never touches a file itself.
CREATE FUNCTION public.needs_owner_delete_list(p_list_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- A record, not the row type: nothing in public is named before the owner refusal.
  v_list record;
  v_items integer;
  v_documents uuid[];
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;
  SELECT l.id, l.contact_id, l.status INTO v_list FROM public.needs_lists l WHERE l.id = p_list_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT count(*)::integer INTO v_items FROM public.needs_items i WHERE i.list_id = p_list_id;
  SELECT COALESCE(array_agg(DISTINCT d.document_id ORDER BY d.document_id), '{}') INTO v_documents
    FROM public.needs_item_documents d JOIN public.needs_items i ON i.id = d.item_id
   WHERE i.list_id = p_list_id;

  DELETE FROM public.needs_lists l WHERE l.id = p_list_id;

  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (
    auth.uid(),
    'needs_list_deleted',
    jsonb_build_object(
      'list_id', p_list_id,
      'contact_id', v_list.contact_id,
      'status', v_list.status,
      'item_count', v_items,
      'document_count', cardinality(v_documents),
      'source', 'owner'));
  RETURN v_documents;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.request_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.needs_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.needs_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.needs_item_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.needs_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_signup_requests ENABLE ROW LEVEL SECURITY;

-- The pick-lists: the owner's alone (the portal never shows it).
CREATE POLICY request_categories_owner_select ON public.request_categories
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY request_categories_owner_insert ON public.request_categories
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY request_categories_owner_update ON public.request_categories
  FOR UPDATE TO authenticated USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY request_categories_owner_delete ON public.request_categories
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

CREATE POLICY request_tags_owner_select ON public.request_tags
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY request_tags_owner_insert ON public.request_tags
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY request_tags_owner_update ON public.request_tags
  FOR UPDATE TO authenticated USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY request_tags_owner_delete ON public.request_tags
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

-- Lists: the owner everything; a client its own once sent (never a draft). No client
-- write policy, on purpose (see the header).
CREATE POLICY needs_lists_owner_all ON public.needs_lists
  FOR ALL TO authenticated USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY needs_lists_client_select ON public.needs_lists
  FOR SELECT TO authenticated
  USING (contact_id = (SELECT public.get_client_contact_id()) AND status <> 'draft');

CREATE POLICY needs_items_owner_all ON public.needs_items
  FOR ALL TO authenticated USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY needs_items_client_select ON public.needs_items
  FOR SELECT TO authenticated
  USING (list_id IN (SELECT l.id FROM public.needs_lists l
                      WHERE l.contact_id = (SELECT public.get_client_contact_id()) AND l.status <> 'draft'));

-- Item documents: written by the server alone (needs_client_link_document). The owner
-- reads them and may unlink; a client reads the links of its own sent lists.
CREATE POLICY needs_item_documents_owner_select ON public.needs_item_documents
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY needs_item_documents_owner_delete ON public.needs_item_documents
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY needs_item_documents_client_select ON public.needs_item_documents
  FOR SELECT TO authenticated
  USING (item_id IN (SELECT i.id FROM public.needs_items i JOIN public.needs_lists l ON l.id = i.list_id
                      WHERE l.contact_id = (SELECT public.get_client_contact_id()) AND l.status <> 'draft'));

CREATE POLICY needs_templates_owner_all ON public.needs_templates
  FOR ALL TO authenticated USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

-- Start links: the server writes, the owner may read.
CREATE POLICY pending_signup_requests_owner_select ON public.pending_signup_requests
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['request_categories', 'request_tags', 'needs_lists', 'needs_items',
                           'needs_item_documents', 'needs_templates', 'pending_signup_requests'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()))',
      t || '_mfa_gate', t);
  END LOOP;
END;
$$;

-- A client's portal follows its lists live (a new list sent, a list closed).
ALTER PUBLICATION supabase_realtime ADD TABLE public.needs_lists;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.request_categories, public.request_tags, public.needs_lists, public.needs_items,
  public.needs_item_documents, public.needs_templates, public.pending_signup_requests
FROM PUBLIC, anon, authenticated, service_role;

-- The server: row access only, no TRUNCATE.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_categories, public.request_tags, public.needs_lists,
  public.needs_items, public.needs_item_documents, public.needs_templates, public.pending_signup_requests
TO service_role;

-- Signed-in sessions; the policies decide who. A pick-list key and its system flag never
-- change. Item documents are written only by the server; start links only read.
-- Lists and items: the owner's builder creates and replaces a draft only through
-- needs_owner_save_draft and deletes only through needs_owner_delete_list (both lock the
-- list, so a save and a send run one after the other, and the delete is audited). Direct
-- writes are what the screens need and no more: close, pause reminders, accept an answer.
-- An answer is never the owner's to write.
GRANT SELECT, INSERT, DELETE, UPDATE (label, colour, sort_order, is_active) ON public.request_categories, public.request_tags
TO authenticated;
GRANT SELECT, UPDATE (status, closed_at, reminders_paused) ON public.needs_lists TO authenticated;
GRANT SELECT, UPDATE (status) ON public.needs_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.needs_templates TO authenticated;
GRANT SELECT, DELETE ON public.needs_item_documents TO authenticated;
GRANT SELECT ON public.pending_signup_requests TO authenticated;

-- Functions created in this file only. Trigger functions need no EXECUTE grant. The
-- owner's builder save (needs_owner_save_draft) and delete (needs_owner_delete_list) are
-- the functions a signed-in session may call, and each refuses anyone but the owner first;
-- every other function here is the server's alone (the AI connector reaches the draft
-- functions through the server).
REVOKE ALL ON FUNCTION
  public._needs_bump_version_new(),
  public._needs_bump_version_old(),
  public._needs_bump_version_upd(),
  public._needs_bump_version_self(),
  public.needs_lists_guard_status(),
  public.needs_items_guard_draft(),
  public._needs_expire_start_links(),
  public.needs_guard_document_delete(),
  public._needs_recheck_document_item(),
  public.needs_list_progress(uuid[]),
  public.needs_replace_draft(uuid, text, jsonb, text, uuid, boolean),
  public.needs_owner_save_draft(uuid, uuid, integer, text, text, boolean, jsonb),
  public.needs_owner_delete_list(uuid),
  public.needs_delete_draft(uuid, uuid, integer, uuid, inet, text),
  public.needs_recipient_current(uuid, uuid, text),
  public.needs_send_list(uuid, integer, uuid, text),
  public.needs_claim_reminder(uuid, integer),
  public.needs_release_reminder(uuid, integer),
  public.needs_issue_start_link(uuid, uuid, text, text, timestamptz, uuid),
  public.needs_supersede_start_links(uuid, uuid),
  public.needs_client_set_answer(uuid, uuid, text, bytea),
  public.needs_client_mark_todo(uuid, uuid, boolean),
  public.needs_client_link_document(uuid, uuid, uuid),
  public.needs_client_submit(uuid, uuid),
  public.needs_claim_upload_notice(uuid),
  public.needs_release_upload_notice(uuid, timestamptz),
  public.start_link_access_revoked(uuid, text, uuid),
  public.start_link_lookup(text),
  public.expire_start_link(uuid),
  public.claim_start_link(uuid, uuid),
  public.release_start_link_claim(uuid, uuid),
  public.delete_stale_start_link_user(uuid, uuid, uuid),
  public.link_start_link(uuid, uuid, uuid),
  public.retire_start_link(uuid),
  public.cleanup_stale_start_links()
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.needs_list_progress(uuid[]),
  public.needs_replace_draft(uuid, text, jsonb, text, uuid, boolean),
  public.needs_delete_draft(uuid, uuid, integer, uuid, inet, text),
  public.needs_recipient_current(uuid, uuid, text),
  public.needs_send_list(uuid, integer, uuid, text),
  public.needs_claim_reminder(uuid, integer),
  public.needs_release_reminder(uuid, integer),
  public.needs_issue_start_link(uuid, uuid, text, text, timestamptz, uuid),
  public.needs_supersede_start_links(uuid, uuid),
  public.needs_client_set_answer(uuid, uuid, text, bytea),
  public.needs_client_mark_todo(uuid, uuid, boolean),
  public.needs_client_link_document(uuid, uuid, uuid),
  public.needs_client_submit(uuid, uuid),
  public.needs_claim_upload_notice(uuid),
  public.needs_release_upload_notice(uuid, timestamptz),
  public.start_link_access_revoked(uuid, text, uuid),
  public.start_link_lookup(text),
  public.expire_start_link(uuid),
  public.claim_start_link(uuid, uuid),
  public.release_start_link_claim(uuid, uuid),
  public.delete_stale_start_link_user(uuid, uuid, uuid),
  public.link_start_link(uuid, uuid, uuid),
  public.retire_start_link(uuid),
  public.cleanup_stale_start_links()
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.needs_owner_save_draft(uuid, uuid, integer, text, text, boolean, jsonb),
  public.needs_owner_delete_list(uuid)
TO authenticated;
