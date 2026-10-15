-- 0006_esign: electronic signatures, end to end.
--
-- Belongs here: envelopes, their documents, signers, fields and events, templates,
-- SMS verification codes, drawn signatures, the e-signature storage bucket(s) with
-- per-bucket policies, and the esign_* functions.
--
-- Depends on: 0003_documents (an executed copy is filed into the contact's documents),
-- 0002_contacts (a signer with no contact gets the esign_signer status and the esign
-- lead source, both seeded there).
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
-- The e-signature model, and the rules this file adds:
--   * An envelope moves draft -> sent -> partially_signed -> completed, or ends voided,
--     expired or declined. Everything after draft happens in the e-sign edge functions,
--     as the server. The owner's session READS the e-sign tables and writes exactly one
--     thing directly: a template's deleted_at (soft delete). Even a draft's documents
--     leave through the server (esign-reorder-pages, esign_delete_draft_document), which
--     remaps the fields in the same transaction. So a stolen owner session cannot forge
--     an executed envelope by writing rows: signing, completing and filing are server
--     work.
--   * An envelope's shape (documents, pages, signers, fields) changes only while it is a
--     draft, for every writer, the server included (esign_guard_draft_edit, under the
--     envelope row lock); each change bumps draft_revision, and send claims draft -> sent
--     only at the revision it assembled.
--   * Completion and delivery are apart: delivered_at is set once the copy is filed, the
--     completion event written and every party emailed (each recorded in `delivery`);
--     the expiry run re-drives a completed envelope until then. One filed copy per
--     envelope and contact (client_documents_esign_envelope_contact_key).
--   * No client session reads an e-sign table. A signer reaches the flow through a link
--     (a token whose SHA-256 is stored, never the token) or, signed in to the portal,
--     through esign-portal-signer-token, which trades the session for a fresh link. So no
--     e-sign table is client-writable and none needs the View-as-client trigger. Earlier
--     designs let a client read signer rows by contact; two signers can share a contact
--     (a co-signer on the primary signer's record), and that read exposed one signer's
--     token hash, phone ciphertext and IP to the other.
--   * The owner reads a signer row by column: token_hash, token_expires_at,
--     phone_ciphertext and phone_iv are not granted, so a browser select of '*' fails
--     loudly rather than carrying them to the page.
--   * Signer sessions, SMS codes and drawn-signature images are the server's alone. A
--     drawn signature is kept off the signer row on purpose.
--   * Once an envelope is completed, its status, completed_at, signed_pdf_path and
--     signed_pdf_sha256 never change (the freeze trigger). source_pdf_path is not frozen:
--     the retention run clears it when it removes the working files.
--   * A deleted completed envelope leaves a tombstone (title, signers, events, digest),
--     so the tamper check can still answer for an executed copy whose envelope is gone.
--   * The executed PDF is filed into the documents bucket as {contact}/esign/{envelope}.pdf,
--     a row per signer contact over ONE object, each row carrying esign_envelope_id. The
--     documents bucket takes no browser write at all (0003), which is what keeps those
--     objects safe; should a signed-in write policy ever be added there, it must exclude
--     names matching '%/esign/%'.
--   * SMS codes are generated, HMAC'd and compared per signer: a code row is written
--     BEFORE the text is sent (the row is the state), a new row spends every older one
--     (esign_supersede_sms_codes) and an approval spends them all, so only the newest code
--     can ever match, and esign_check_sms_code holds the attempt cap in one transaction.
--     Two signers sharing a phone never share a code.
--   * Retention: working files and drawn images of a terminal envelope go after 90 days
--     (esign-expire-envelopes, aged per status as esign_purge_terminal_signature_images
--     says), SMS code rows after 30 days, signer sessions a day after they expire
--     (esign_prune_operational). Drafts are never purged.
--   * FK indexes are kept even where a planner may never use them: a contact or task
--     delete must not scan these tables.
--   * Addresses: every inet column takes the request's real address or NULL, never a
--     placeholder string.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.esign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provenance only. Functions never compare it with the caller: is_owner() decides, so a
  -- change of owner account does not lock the owner out of older envelopes.
  created_by uuid NOT NULL REFERENCES auth.users (id),
  -- Deleting a contact must not fail on, or delete, its envelopes.
  primary_contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'partially_signed', 'completed', 'voided', 'expired', 'declined')),
  verification_level text NOT NULL DEFAULT 'standard' CHECK (verification_level IN ('standard', 'high')),
  source_pdf_path text CHECK (char_length(source_pdf_path) <= 1024),
  source_pdf_sha256 text CHECK (source_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  signed_pdf_path text CHECK (char_length(signed_pdf_path) <= 1024),
  signed_pdf_sha256 text CHECK (signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  void_reason text CHECK (char_length(void_reason) <= 500),
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  voided_at timestamptz,
  -- Bumped by every change to the draft's documents, pages, signers or fields (the
  -- draft-edit trigger); send claims draft -> sent only at the revision it assembled.
  draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  -- After completion: which completion emails went out (recipient digest -> sent at),
  -- how many delivery runs there were, and when everything was delivered. The expiry
  -- run re-drives a completed envelope until delivered_at is set.
  delivery jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(delivery) = 'object' AND pg_column_size(delivery) <= 8192),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Every envelope past draft has a deadline; the expiry run depends on it.
  CONSTRAINT esign_envelopes_sent_requires_expiry CHECK (status = 'draft' OR expires_at IS NOT NULL)
);

CREATE INDEX idx_esign_envelopes_status ON public.esign_envelopes (status);
CREATE INDEX idx_esign_envelopes_primary_contact ON public.esign_envelopes (primary_contact_id);
CREATE INDEX idx_esign_envelopes_created_by ON public.esign_envelopes (created_by);
-- The tamper check looks an executed copy up by its digest.
CREATE INDEX idx_esign_envelopes_signed_sha256 ON public.esign_envelopes (signed_pdf_sha256)
  WHERE signed_pdf_sha256 IS NOT NULL;
-- The expiry run reads the live envelopes past their deadline.
CREATE INDEX idx_esign_envelopes_live_expiry ON public.esign_envelopes (expires_at)
  WHERE status IN ('sent', 'partially_signed');
CREATE INDEX idx_esign_envelopes_created ON public.esign_envelopes (created_at DESC, id);

CREATE TABLE public.esign_envelope_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL REFERENCES public.esign_envelopes (id) ON DELETE CASCADE,
  "order" integer NOT NULL CHECK ("order" >= 0),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  storage_path text NOT NULL CHECK (char_length(storage_path) BETWEEN 1 AND 1024),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_envelope_documents_envelope_order_key UNIQUE (envelope_id, "order")
);

CREATE TABLE public.esign_envelope_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL REFERENCES public.esign_envelopes (id) ON DELETE CASCADE,
  "order" integer NOT NULL CHECK ("order" >= 0),
  source_document_id uuid NOT NULL REFERENCES public.esign_envelope_documents (id) ON DELETE CASCADE,
  source_page_index integer NOT NULL CHECK (source_page_index >= 0),
  deleted boolean NOT NULL DEFAULT false
);

-- Partial: a deleted page keeps its order and may collide with a live one.
CREATE UNIQUE INDEX uq_esign_envelope_pages_live_order ON public.esign_envelope_pages (envelope_id, "order")
  WHERE deleted = false;
CREATE INDEX idx_esign_envelope_pages_envelope ON public.esign_envelope_pages (envelope_id);
CREATE INDEX idx_esign_envelope_pages_document ON public.esign_envelope_pages (source_document_id);

CREATE TABLE public.esign_envelope_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL REFERENCES public.esign_envelopes (id) ON DELETE CASCADE,
  -- SET NULL, so a contact delete keeps working; the signer keeps its email.
  contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL,
  "order" integer NOT NULL CHECK ("order" >= 0),
  -- primary: the person the envelope is for; co_signer: a second signer on the primary
  -- contact's record (spouse_email); other: anyone else.
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('primary', 'co_signer', 'other')),
  -- Stored lowercased, so (envelope_id, email) is unique whatever the case typed.
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  -- The phone for the SMS code: AES-GCM under PII_ENCRYPTION_KEY, ciphertext and IV apart.
  phone_ciphertext bytea,
  phone_iv bytea,
  phone_last_four text CHECK (phone_last_four ~ '^[0-9]{4}$'),
  -- SHA-256 hex of the signing link's token. The token itself is never stored.
  token_hash text CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  invited_at timestamptz,
  opened_email_at timestamptz,
  first_viewed_at timestamptz,
  signed_at timestamptz,
  signed_font text CHECK (char_length(signed_font) <= 40),
  signed_signature_text text CHECK (char_length(signed_signature_text) <= 200),
  -- typed or drawn. NULL means typed, so readers coalesce.
  signed_signature_kind text CHECK (signed_signature_kind IN ('typed', 'drawn')),
  signed_ip inet,
  signed_user_agent text CHECK (char_length(signed_user_agent) <= 512),
  signed_verification_method text CHECK (signed_verification_method IN ('email', 'email+sms')),
  signed_timezone text CHECK (char_length(signed_timezone) <= 60),
  consented_at timestamptz,
  consent_disclosure_version text CHECK (char_length(consent_disclosure_version) <= 40),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'invited', 'viewed', 'signed', 'expired', 'declined')),
  -- The signer's "Signature needed" portal task, when the signer has a portal account.
  client_task_id uuid REFERENCES public.client_tasks (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_envelope_signers_envelope_email_key UNIQUE (envelope_id, email),
  CONSTRAINT esign_envelope_signers_phone_pair CHECK ((phone_ciphertext IS NULL) = (phone_iv IS NULL))
);

CREATE INDEX idx_esign_signers_envelope ON public.esign_envelope_signers (envelope_id);
CREATE INDEX idx_esign_signers_token_hash ON public.esign_envelope_signers (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX idx_esign_signers_contact ON public.esign_envelope_signers (contact_id);
CREATE INDEX idx_esign_signers_client_task ON public.esign_envelope_signers (client_task_id);

CREATE TABLE public.esign_envelope_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL REFERENCES public.esign_envelopes (id) ON DELETE CASCADE,
  signer_id uuid NOT NULL REFERENCES public.esign_envelope_signers (id) ON DELETE CASCADE,
  -- Positional: the page's place among the envelope's live pages in order. No key to a
  -- page row, because a reorder moves fields by remapping this number.
  page_index integer NOT NULL CHECK (page_index BETWEEN 0 AND 199),
  field_type text NOT NULL CHECK (field_type IN ('signature', 'date')),
  x numeric NOT NULL,
  y numeric NOT NULL,
  width numeric NOT NULL CHECK (width > 0),
  height numeric NOT NULL CHECK (height > 0),
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_fields_envelope ON public.esign_envelope_fields (envelope_id);
CREATE INDEX idx_esign_fields_signer ON public.esign_envelope_fields (signer_id);

CREATE TABLE public.esign_envelope_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL REFERENCES public.esign_envelopes (id) ON DELETE CASCADE,
  signer_id uuid REFERENCES public.esign_envelope_signers (id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'envelope_created', 'envelope_sent', 'envelope_voided', 'envelope_expired',
    'invite_sent', 'invite_resent', 'email_delivered', 'email_opened',
    'signer_opened_link', 'signer_viewed_pdf', 'sms_code_sent', 'sms_code_verified',
    'sms_code_failed', 'signer_signed', 'envelope_completed', 'rate_limit_hit',
    'consent_accepted', 'signer_declined'
  )),
  ip inet,
  user_agent text CHECK (char_length(user_agent) <= 512),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 4096),
  -- The provider's webhook delivery id: a redelivered event is recorded once.
  svix_id text CHECK (char_length(svix_id) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_events_envelope_created ON public.esign_envelope_events (envelope_id, created_at DESC);
CREATE INDEX idx_esign_events_signer ON public.esign_envelope_events (signer_id) WHERE signer_id IS NOT NULL;
CREATE UNIQUE INDEX uq_esign_events_svix_id ON public.esign_envelope_events (svix_id) WHERE svix_id IS NOT NULL;

-- One row per code sent. code_hash = hex(HMAC-SHA256(ESIGN_SMS_CODE_KEY, signer_id || ':' || code)),
-- made in the edge function: the key never reaches the database.
CREATE TABLE public.esign_sms_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL REFERENCES public.esign_envelope_signers (id) ON DELETE CASCADE,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  sent_to_last_four text NOT NULL CHECK (sent_to_last_four ~ '^[0-9]{4}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_sms_signer_created ON public.esign_sms_verifications (signer_id, created_at DESC);
CREATE INDEX idx_esign_sms_created ON public.esign_sms_verifications (created_at);

-- A verified SMS code buys a short session pinned to the address that verified it.
CREATE TABLE public.esign_signer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL REFERENCES public.esign_envelope_signers (id) ON DELETE CASCADE,
  session_token_hash text NOT NULL CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  ip inet NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_signer_sessions_token_key UNIQUE (session_token_hash)
);

CREATE INDEX idx_esign_signer_sessions_signer ON public.esign_signer_sessions (signer_id);
CREATE INDEX idx_esign_signer_sessions_expires ON public.esign_signer_sessions (expires_at);

CREATE TABLE public.esign_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (char_length(description) <= 500),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES auth.users (id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_esign_templates_active_name ON public.esign_templates (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_esign_templates_active ON public.esign_templates (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_esign_templates_created_by ON public.esign_templates (created_by);

CREATE TABLE public.esign_template_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.esign_templates (id) ON DELETE CASCADE,
  -- A template knows two roles: the primary signer and a co-signer.
  role text NOT NULL CHECK (role IN ('primary', 'co_signer')),
  page_index integer NOT NULL CHECK (page_index BETWEEN 0 AND 199),
  field_type text NOT NULL CHECK (field_type IN ('signature', 'date')),
  x numeric NOT NULL,
  y numeric NOT NULL,
  width numeric NOT NULL CHECK (width > 0),
  height numeric NOT NULL CHECK (height > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_template_fields_template ON public.esign_template_fields (template_id);

-- The raw drawn signature (base64 PNG), validated before it is stored. The server's alone.
CREATE TABLE public.esign_signer_signature_images (
  signer_id uuid PRIMARY KEY REFERENCES public.esign_envelope_signers (id) ON DELETE CASCADE,
  image_base64 text NOT NULL CHECK (char_length(image_base64) BETWEEN 1 AND 320000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_signature_images_created ON public.esign_signer_signature_images (created_at);

-- What survives a deleted completed envelope. No key to the envelope: it is gone.
CREATE TABLE public.esign_completed_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  completed_at timestamptz,
  signed_pdf_sha256 text CHECK (signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  signed_pdf_path text CHECK (char_length(signed_pdf_path) <= 1024),
  signers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(signers) = 'array'),
  events jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(events) = 'array'),
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_esign_tombstones_sha256 ON public.esign_completed_tombstones (signed_pdf_sha256);
CREATE INDEX idx_esign_tombstones_deleted_by ON public.esign_completed_tombstones (deleted_by);

-- The executed copy's row in the documents store names its envelope (column in 0003).
ALTER TABLE public.client_documents
  ADD CONSTRAINT client_documents_esign_envelope_id_fkey
  FOREIGN KEY (esign_envelope_id) REFERENCES public.esign_envelopes (id) ON DELETE SET NULL;
CREATE INDEX idx_client_documents_esign_envelope ON public.client_documents (esign_envelope_id)
  WHERE esign_envelope_id IS NOT NULL;
-- One executed copy per envelope and contact, however many finalize runs race to file it
-- (rows with no envelope are NULL here, and NULLs never collide).
ALTER TABLE public.client_documents
  ADD CONSTRAINT client_documents_esign_envelope_contact_key UNIQUE (esign_envelope_id, contact_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_esign_envelopes_updated_at
  BEFORE UPDATE ON public.esign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_esign_envelope_signers_updated_at
  BEFORE UPDATE ON public.esign_envelope_signers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_esign_templates_updated_at
  BEFORE UPDATE ON public.esign_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A completed envelope's record of completion never changes, for any caller, the server
-- included: the executed PDF's digest is what the tamper check answers from.
CREATE FUNCTION public.esign_freeze_completed_envelope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'completed' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.signed_pdf_path IS DISTINCT FROM OLD.signed_pdf_path
    OR NEW.signed_pdf_sha256 IS DISTINCT FROM OLD.signed_pdf_sha256
  ) THEN
    RAISE EXCEPTION 'esign_envelopes: completion fields are immutable once status = completed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_esign_freeze_completed
  BEFORE UPDATE ON public.esign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.esign_freeze_completed_envelope();

-- An envelope's shape (its documents, pages, signers and fields) changes only while it is
-- a draft, for every writer. Each change takes the envelope row lock (the lock send's
-- claim and a signature also take), refuses unless the envelope is still a draft, and
-- bumps draft_revision, so a send that assembled an older revision loses its claim
-- instead of sending a PDF that no longer matches the fields. Passed through: a signer's
-- lifecycle after send (status past pending, link token, timestamps, the signed_*
-- evidence), a contact deleted under a signer (contact_id SET NULL), and rows leaving
-- with their envelope (the cascade, when the envelope row is already gone).
CREATE FUNCTION public.esign_guard_draft_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_envelope uuid;
BEGIN
  -- A write that changes nothing changes no shape.
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'esign_envelope_signers' AND TG_OP = 'UPDATE' THEN
    IF NOT (
      NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW."order" IS DISTINCT FROM OLD."order"
      OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
      OR NEW.phone_ciphertext IS DISTINCT FROM OLD.phone_ciphertext
      OR NEW.phone_iv IS DISTINCT FROM OLD.phone_iv
      OR NEW.phone_last_four IS DISTINCT FROM OLD.phone_last_four
      OR (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending')
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  v_envelope := CASE WHEN TG_OP = 'DELETE' THEN OLD.envelope_id ELSE NEW.envelope_id END;
  UPDATE public.esign_envelopes e
     SET draft_revision = e.draft_revision + 1
   WHERE e.id = v_envelope AND e.status = 'draft';
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.esign_envelopes e WHERE e.id = v_envelope) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'envelope is not a draft' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_esign_documents_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.esign_envelope_documents
  FOR EACH ROW EXECUTE FUNCTION public.esign_guard_draft_edit();
CREATE TRIGGER trg_esign_pages_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.esign_envelope_pages
  FOR EACH ROW EXECUTE FUNCTION public.esign_guard_draft_edit();
CREATE TRIGGER trg_esign_signers_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.esign_envelope_signers
  FOR EACH ROW EXECUTE FUNCTION public.esign_guard_draft_edit();
CREATE TRIGGER trg_esign_fields_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.esign_envelope_fields
  FOR EACH ROW EXECUTE FUNCTION public.esign_guard_draft_edit();

-- A new SMS code supersedes every older one for that signer: issuing it consumes the
-- earlier unconsumed codes, so only the newest can ever match, before or after it is used.
CREATE FUNCTION public.esign_supersede_sms_codes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.esign_sms_verifications v
     SET consumed_at = now()
   WHERE v.signer_id = NEW.signer_id AND v.consumed_at IS NULL AND v.id <> NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_esign_sms_supersede
  AFTER INSERT ON public.esign_sms_verifications
  FOR EACH ROW EXECUTE FUNCTION public.esign_supersede_sms_codes();

-- ---------------------------------------------------------------------------
-- Server functions (EXECUTE to service_role only; each runs as the caller)
-- ---------------------------------------------------------------------------

-- A stored source PDF becomes a document row and one page row per page, in one
-- transaction. The envelope row is locked first, so concurrent uploads to one envelope
-- take their order numbers one after another, and a document is only ever added to a
-- draft. Page orders continue above every existing page, deleted ones included: the
-- live-order index is partial, and staying above soft-deleted rows keeps "order"
-- monotonic so it can never collide.
CREATE FUNCTION public.esign_insert_document_with_pages(
  p_envelope_id uuid,
  p_document_id uuid,
  p_file_name text,
  p_storage_path text,
  p_byte_size bigint,
  p_page_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_doc_order integer;
  v_page_start integer;
  v_pages jsonb;
BEGIN
  IF p_page_count IS NULL OR p_page_count < 1 THEN
    RAISE EXCEPTION 'page_count must be >= 1' USING ERRCODE = '22023';
  END IF;

  SELECT e.status INTO v_status FROM public.esign_envelopes e WHERE e.id = p_envelope_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'envelope is not a draft' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(MAX(d."order") + 1, 0) INTO v_doc_order
    FROM public.esign_envelope_documents d WHERE d.envelope_id = p_envelope_id;
  SELECT COALESCE(MAX(pg."order") + 1, 0) INTO v_page_start
    FROM public.esign_envelope_pages pg WHERE pg.envelope_id = p_envelope_id;

  INSERT INTO public.esign_envelope_documents (id, envelope_id, "order", file_name, storage_path, byte_size, page_count)
  VALUES (p_document_id, p_envelope_id, v_doc_order, p_file_name, p_storage_path, p_byte_size, p_page_count);

  WITH inserted AS (
    INSERT INTO public.esign_envelope_pages (envelope_id, source_document_id, source_page_index, "order", deleted)
    SELECT p_envelope_id, p_document_id, i, v_page_start + i, false
      FROM pg_catalog.generate_series(0, p_page_count - 1) AS i
    RETURNING id, "order", source_page_index
  )
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('id', ins.id, 'order', ins."order", 'source_page_index', ins.source_page_index)
                     ORDER BY ins."order"),
           '[]'::jsonb)
    INTO v_pages
    FROM inserted ins;

  RETURN jsonb_build_object('document_order', v_doc_order, 'pages', v_pages);
END;
$$;

-- One signer's fields, replaced in one transaction (a failure between the delete and
-- the insert used to leave the signer with none). Draft only. Returns the new ids in
-- the order the fields were given, so the editor can re-bind each box it drew.
CREATE FUNCTION public.esign_set_signer_fields(p_envelope_id uuid, p_signer_id uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_ids jsonb;
BEGIN
  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'fields must be an array' USING ERRCODE = '22023';
  END IF;
  SELECT e.status INTO v_status FROM public.esign_envelopes e WHERE e.id = p_envelope_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'envelope is not a draft' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.esign_envelope_signers s WHERE s.id = p_signer_id AND s.envelope_id = p_envelope_id) THEN
    RAISE EXCEPTION 'signer not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.esign_envelope_fields f WHERE f.signer_id = p_signer_id;

  WITH given AS (
    SELECT gen_random_uuid() AS id, g.ord, g.f
      FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS g(f, ord)
  ), ins AS (
    INSERT INTO public.esign_envelope_fields (id, envelope_id, signer_id, page_index, field_type, x, y, width, height, required)
    SELECT given.id, p_envelope_id, p_signer_id,
           (given.f ->> 'page_index')::integer, given.f ->> 'field_type',
           (given.f ->> 'x')::numeric, (given.f ->> 'y')::numeric,
           (given.f ->> 'width')::numeric, (given.f ->> 'height')::numeric,
           COALESCE((given.f ->> 'required')::boolean, true)
      FROM given
    RETURNING id
  )
  SELECT COALESCE(jsonb_agg(given.id ORDER BY given.ord), '[]'::jsonb) INTO v_ids
    FROM given WHERE given.id IN (SELECT ins.id FROM ins);

  RETURN v_ids;
END;
$$;

-- A page reorder applied in one transaction: the page moves and deletions, then the
-- field remap the function computed for exactly this page set. Pages that move are first
-- parked above every order in use, so the partial live-order index never sees two live
-- pages on one number. Draft only.
--   p_pages          [{ "page_id", "order"?, "deleted"? }]
--   p_field_updates  [{ "id", "page_index" }]
--   p_field_deletes  field ids
CREATE FUNCTION public.esign_apply_page_reorder(
  p_envelope_id uuid,
  p_pages jsonb,
  p_field_updates jsonb,
  p_field_deletes uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_park integer;
  v_pages integer;
  v_updated integer;
  v_deleted integer;
BEGIN
  IF jsonb_typeof(p_pages) IS DISTINCT FROM 'array' OR jsonb_typeof(p_field_updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pages and field updates must be arrays' USING ERRCODE = '22023';
  END IF;
  SELECT e.status INTO v_status FROM public.esign_envelopes e WHERE e.id = p_envelope_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'envelope is not a draft' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pages) op
     WHERE NOT EXISTS (SELECT 1 FROM public.esign_envelope_pages pg
                        WHERE pg.id = (op ->> 'page_id')::uuid AND pg.envelope_id = p_envelope_id)
  ) THEN
    RAISE EXCEPTION 'a page is not in this envelope' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(MAX(pg."order"), 0) + 1 INTO v_park
    FROM public.esign_envelope_pages pg WHERE pg.envelope_id = p_envelope_id;

  -- Park every page that moves, above every order in use.
  UPDATE public.esign_envelope_pages pg
     SET "order" = v_park + pg."order"
    FROM jsonb_array_elements(p_pages) op
   WHERE pg.id = (op ->> 'page_id')::uuid AND op ? 'order';

  UPDATE public.esign_envelope_pages pg
     SET "order" = COALESCE((op ->> 'order')::integer, pg."order"),
         deleted = COALESCE((op ->> 'deleted')::boolean, pg.deleted)
    FROM jsonb_array_elements(p_pages) op
   WHERE pg.id = (op ->> 'page_id')::uuid;
  GET DIAGNOSTICS v_pages = ROW_COUNT;

  UPDATE public.esign_envelope_fields f
     SET page_index = (u ->> 'page_index')::integer
    FROM jsonb_array_elements(p_field_updates) u
   WHERE f.id = (u ->> 'id')::uuid AND f.envelope_id = p_envelope_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  DELETE FROM public.esign_envelope_fields f
   WHERE f.envelope_id = p_envelope_id AND f.id = ANY (COALESCE(p_field_deletes, '{}'::uuid[]));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('pages_updated', v_pages, 'fields_updated', v_updated, 'fields_deleted', v_deleted);
END;
$$;

-- A source document taken out of a draft, in one transaction under the envelope's row
-- lock: the field remap the function computed for the pages that remain (fields sit on a
-- page by POSITION, so every later field moves up by the document's live page count and
-- the fields on its pages go), then the document row, whose pages cascade. Returns the
-- working object's path, which the function removes after the commit (storage is not in
-- this transaction). Draft only.
--   p_field_updates  [{ "id", "page_index" }]
--   p_field_deletes  field ids
CREATE FUNCTION public.esign_delete_draft_document(
  p_envelope_id uuid,
  p_document_id uuid,
  p_field_updates jsonb,
  p_field_deletes uuid[]
)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_path text;
BEGIN
  IF jsonb_typeof(p_field_updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'field updates must be an array' USING ERRCODE = '22023';
  END IF;
  SELECT e.status INTO v_status FROM public.esign_envelopes e WHERE e.id = p_envelope_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'envelope is not a draft' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.esign_envelope_fields f
   WHERE f.envelope_id = p_envelope_id AND f.id = ANY (COALESCE(p_field_deletes, '{}'::uuid[]));
  UPDATE public.esign_envelope_fields f
     SET page_index = (u ->> 'page_index')::integer
    FROM jsonb_array_elements(p_field_updates) u
   WHERE f.id = (u ->> 'id')::uuid AND f.envelope_id = p_envelope_id;

  DELETE FROM public.esign_envelope_documents d
   WHERE d.id = p_document_id AND d.envelope_id = p_envelope_id
  RETURNING d.storage_path INTO v_path;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'document not in this envelope' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_path;
END;
$$;

-- The one way a signer becomes signed. The envelope row is locked first, so a void,
-- decline or expiry racing this either lands first (and the claim refuses) or waits.
-- Only an invited or viewed signer on a sent or partially signed envelope is claimed;
-- the link expires in the same statement. A drawn signature's image is stored in the
-- same transaction. Consent recorded earlier (by the PDF view) is kept, never replaced.
CREATE FUNCTION public.esign_claim_signer_signature(
  p_signer_id uuid,
  p_kind text,
  p_signature_text text,
  p_font_key text,
  p_image_base64 text,
  p_signed_at timestamptz,
  p_signed_ip inet,
  p_signed_user_agent text,
  p_signed_verification_method text,
  p_signed_timezone text,
  p_consent_version text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_env_status text;
  v_claimed uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('typed', 'drawn') THEN
    RAISE EXCEPTION 'esign_claim_signer_signature: invalid kind' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'drawn' AND (p_image_base64 IS NULL OR length(p_image_base64) = 0) THEN
    RAISE EXCEPTION 'esign_claim_signer_signature: a drawn signature requires an image' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'typed' AND p_image_base64 IS NOT NULL THEN
    RAISE EXCEPTION 'esign_claim_signer_signature: a typed signature cannot carry an image' USING ERRCODE = '22023';
  END IF;

  SELECT e.status INTO v_env_status
    FROM public.esign_envelopes e
    JOIN public.esign_envelope_signers s ON s.envelope_id = e.id
   WHERE s.id = p_signer_id
     FOR UPDATE OF e;

  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'partially_signed') THEN
    RETURN false;
  END IF;

  UPDATE public.esign_envelope_signers AS s
     SET signed_at = p_signed_at,
         signed_signature_text = p_signature_text,
         signed_font = p_font_key,
         signed_signature_kind = p_kind,
         signed_ip = p_signed_ip,
         signed_user_agent = p_signed_user_agent,
         signed_verification_method = p_signed_verification_method,
         signed_timezone = p_signed_timezone,
         status = 'signed',
         token_expires_at = p_signed_at,
         consented_at = COALESCE(s.consented_at, p_signed_at),
         consent_disclosure_version = COALESCE(s.consent_disclosure_version, p_consent_version)
   WHERE s.id = p_signer_id
     AND s.status IN ('invited', 'viewed')
  RETURNING s.id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN false;
  END IF;

  IF p_kind = 'drawn' THEN
    INSERT INTO public.esign_signer_signature_images AS i (signer_id, image_base64)
    VALUES (p_signer_id, p_image_base64)
    ON CONFLICT (signer_id) DO UPDATE SET image_base64 = EXCLUDED.image_base64;
  END IF;

  RETURN true;
END;
$$;

-- An SMS code check, in one transaction. Only the signer's newest unconsumed code can
-- match (a newer code supersedes the older ones); it is locked while it is checked, so
-- concurrent guesses are counted one by one. A match consumes the code and opens a
-- session pinned to the caller's address; a miss counts toward p_max_attempts, after
-- which the code is locked. The hash is an HMAC the function made with a key the
-- database never sees, so comparing it here leaks nothing a guesser can use.
-- Answers { status: none | expired | locked | invalid | approved, attempts }.
CREATE FUNCTION public.esign_check_sms_code(
  p_signer_id uuid,
  p_code_hash text,
  p_max_attempts integer,
  p_session_token_hash text,
  p_ip inet,
  p_session_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.esign_sms_verifications%ROWTYPE;
  v_attempts integer;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_session_minutes IS NULL OR p_session_minutes < 1 THEN
    RAISE EXCEPTION 'esign_check_sms_code: bad limits' USING ERRCODE = '22023';
  END IF;
  IF p_ip IS NULL THEN
    RAISE EXCEPTION 'esign_check_sms_code: an address is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.esign_sms_verifications v
   WHERE v.signer_id = p_signer_id AND v.consumed_at IS NULL
   ORDER BY v.created_at DESC, v.id DESC
   LIMIT 1
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'none', 'attempts', 0);
  END IF;
  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'expired', 'attempts', v_row.attempt_count);
  END IF;
  IF v_row.attempt_count >= p_max_attempts THEN
    RETURN jsonb_build_object('status', 'locked', 'attempts', v_row.attempt_count);
  END IF;

  IF v_row.code_hash = p_code_hash THEN
    UPDATE public.esign_sms_verifications v
       SET consumed_at = now(), attempt_count = v.attempt_count + 1
     WHERE v.id = v_row.id;
    -- And any other code still outstanding: an approval leaves none usable.
    UPDATE public.esign_sms_verifications v
       SET consumed_at = now()
     WHERE v.signer_id = p_signer_id AND v.consumed_at IS NULL;
    INSERT INTO public.esign_signer_sessions (signer_id, session_token_hash, expires_at, ip)
    VALUES (p_signer_id, p_session_token_hash, now() + make_interval(mins => p_session_minutes), p_ip);
    RETURN jsonb_build_object('status', 'approved', 'attempts', v_row.attempt_count + 1);
  END IF;

  UPDATE public.esign_sms_verifications v
     SET attempt_count = v.attempt_count + 1
   WHERE v.id = v_row.id
  RETURNING v.attempt_count INTO v_attempts;
  RETURN jsonb_build_object('status', CASE WHEN v_attempts >= p_max_attempts THEN 'locked' ELSE 'invalid' END,
                            'attempts', v_attempts);
END;
$$;

-- Drop the drawn images of one envelope (its working files are going too).
CREATE FUNCTION public.esign_delete_signature_images_for_envelope(p_envelope_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.esign_signer_signature_images i
     USING public.esign_envelope_signers s
     WHERE i.signer_id = s.id
       AND s.envelope_id = p_envelope_id
    RETURNING i.signer_id
  )
  SELECT count(*) INTO v_deleted FROM gone;
  RETURN v_deleted;
END;
$$;

-- The retention sweep for drawn images: every terminal envelope whose terminal moment is
-- before p_cutoff, oldest image first, at most p_limit. Each terminal status is aged by
-- its own moment. Live envelopes (draft, sent, partially signed) keep their images.
CREATE FUNCTION public.esign_purge_terminal_signature_images(p_cutoff timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'esign_purge_terminal_signature_images: p_limit must be >= 1' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT i.signer_id
      FROM public.esign_signer_signature_images i
      JOIN public.esign_envelope_signers s ON s.id = i.signer_id
      JOIN public.esign_envelopes e ON e.id = s.envelope_id
     WHERE e.status IN ('completed', 'voided', 'expired', 'declined')
       AND (CASE e.status
              WHEN 'completed' THEN COALESCE(e.completed_at, e.updated_at)
              WHEN 'voided' THEN COALESCE(e.voided_at, e.updated_at)
              -- no dedicated column; its last write is the decline
              WHEN 'declined' THEN e.updated_at
              -- the deadline it passed is the terminal moment
              ELSE COALESCE(e.expires_at, e.updated_at)
            END) < p_cutoff
     ORDER BY i.created_at
     LIMIT p_limit
  ), gone AS (
    DELETE FROM public.esign_signer_signature_images i
     USING candidates c
     WHERE i.signer_id = c.signer_id
    RETURNING i.signer_id
  )
  SELECT count(*) INTO v_deleted FROM gone;
  RETURN v_deleted;
END;
$$;

-- One live envelope past its deadline, decided under the envelope row lock a signature
-- also takes (esign_claim_signer_signature locks it FOR UPDATE), so no signature commits
-- between the count and the flip. Still live and still past its deadline (a resend may
-- have moved it), with everyone signed: nothing changes and the answer is all_signed, so
-- the caller re-drives finalize. Otherwise the waiting signers expire and the envelope
-- flips to expired in this one transaction.
-- Answers { status: not_due | all_signed | expired, signers_expired, task_ids }.
CREATE FUNCTION public.esign_expire_envelope(p_envelope_id uuid, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_expires timestamptz;
  v_total integer;
  v_waiting integer;
  v_expired integer;
  v_tasks jsonb;
BEGIN
  SELECT e.status, e.expires_at INTO v_status, v_expires
    FROM public.esign_envelopes e WHERE e.id = p_envelope_id FOR UPDATE;
  IF v_status IS NULL OR v_status NOT IN ('sent', 'partially_signed') OR v_expires IS NULL OR v_expires >= p_at THEN
    RETURN jsonb_build_object('status', 'not_due', 'signers_expired', 0, 'task_ids', '[]'::jsonb);
  END IF;

  SELECT count(*), count(*) FILTER (WHERE s.status <> 'signed') INTO v_total, v_waiting
    FROM public.esign_envelope_signers s WHERE s.envelope_id = p_envelope_id;
  IF v_total > 0 AND v_waiting = 0 THEN
    RETURN jsonb_build_object('status', 'all_signed', 'signers_expired', 0, 'task_ids', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(s.client_task_id) FILTER (WHERE s.client_task_id IS NOT NULL), '[]'::jsonb) INTO v_tasks
    FROM public.esign_envelope_signers s WHERE s.envelope_id = p_envelope_id AND s.status <> 'signed';
  UPDATE public.esign_envelope_signers s
     SET status = 'expired', token_expires_at = p_at
   WHERE s.envelope_id = p_envelope_id AND s.status IN ('pending', 'invited', 'viewed');
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  UPDATE public.esign_envelopes e SET status = 'expired' WHERE e.id = p_envelope_id;
  RETURN jsonb_build_object('status', 'expired', 'signers_expired', v_expired, 'task_ids', v_tasks);
END;
$$;

-- Operational rows past their use: SMS code rows after 30 days, signer sessions a day
-- after they expired. Run by the daily expiry job.
CREATE FUNCTION public.esign_prune_operational()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_codes integer;
  v_sessions integer;
BEGIN
  DELETE FROM public.esign_sms_verifications v WHERE v.created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_codes = ROW_COUNT;
  DELETE FROM public.esign_signer_sessions s WHERE s.expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  RETURN jsonb_build_object('sms_codes_deleted', v_codes, 'sessions_deleted', v_sessions);
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.esign_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_envelope_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_envelope_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_envelope_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_envelope_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_envelope_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_sms_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_signer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_template_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_signer_signature_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_completed_tombstones ENABLE ROW LEVEL SECURITY;

CREATE POLICY esign_envelopes_mfa_gate ON public.esign_envelopes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_envelope_documents_mfa_gate ON public.esign_envelope_documents AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_envelope_pages_mfa_gate ON public.esign_envelope_pages AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_envelope_signers_mfa_gate ON public.esign_envelope_signers AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_envelope_fields_mfa_gate ON public.esign_envelope_fields AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_envelope_events_mfa_gate ON public.esign_envelope_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_sms_verifications_mfa_gate ON public.esign_sms_verifications AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_signer_sessions_mfa_gate ON public.esign_signer_sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_templates_mfa_gate ON public.esign_templates AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_template_fields_mfa_gate ON public.esign_template_fields AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_signer_signature_images_mfa_gate ON public.esign_signer_signature_images AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY esign_completed_tombstones_mfa_gate ON public.esign_completed_tombstones AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- The owner reads; the server (service role, past RLS) does the rest.
CREATE POLICY esign_envelopes_owner_select ON public.esign_envelopes
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_envelope_documents_owner_select ON public.esign_envelope_documents
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_envelope_pages_owner_select ON public.esign_envelope_pages
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_envelope_signers_owner_select ON public.esign_envelope_signers
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_envelope_fields_owner_select ON public.esign_envelope_fields
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_envelope_events_owner_select ON public.esign_envelope_events
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_templates_owner_select ON public.esign_templates
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
-- The soft delete: the column grant below limits the update to deleted_at.
CREATE POLICY esign_templates_owner_update ON public.esign_templates
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY esign_template_fields_owner_select ON public.esign_template_fields
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY esign_completed_tombstones_owner_select ON public.esign_completed_tombstones
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
-- esign_sms_verifications, esign_signer_sessions, esign_signer_signature_images: no
-- permissive policy and no grant to a signed-in session. The server's alone.

-- ---------------------------------------------------------------------------
-- Storage: the private working bucket
-- ---------------------------------------------------------------------------

-- Source PDFs ({envelope}/sources/{document}.pdf) and the assembled PDF sent for signing
-- ({envelope}/source.pdf). The executed PDF is not here: finalize files it in the
-- documents bucket. Written and removed by the e-sign functions as the server; the
-- owner's browser reads them through short signed URLs (the field placer and the page
-- thumbnails).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('esign-working', 'esign-working', false, 26214400, ARRAY['application/pdf']);

CREATE POLICY esign_working_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'esign-working' AND (SELECT public.is_owner()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON
  public.esign_envelopes, public.esign_envelope_documents, public.esign_envelope_pages,
  public.esign_envelope_signers, public.esign_envelope_fields, public.esign_envelope_events,
  public.esign_sms_verifications, public.esign_signer_sessions, public.esign_templates,
  public.esign_template_fields, public.esign_signer_signature_images, public.esign_completed_tombstones
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.esign_envelopes, public.esign_envelope_documents, public.esign_envelope_pages,
  public.esign_envelope_signers, public.esign_envelope_fields, public.esign_envelope_events,
  public.esign_sms_verifications, public.esign_signer_sessions, public.esign_templates,
  public.esign_template_fields, public.esign_signer_signature_images, public.esign_completed_tombstones
  TO service_role;

GRANT SELECT ON
  public.esign_envelopes, public.esign_envelope_documents, public.esign_envelope_pages,
  public.esign_envelope_fields, public.esign_envelope_events, public.esign_templates,
  public.esign_template_fields, public.esign_completed_tombstones
  TO authenticated;
GRANT UPDATE (deleted_at) ON public.esign_templates TO authenticated;
-- Every signer column but the link token's hash and expiry and the encrypted phone.
GRANT SELECT (
  id, envelope_id, contact_id, "order", role, email, phone_last_four, invited_at, opened_email_at,
  first_viewed_at, signed_at, signed_font, signed_signature_text, signed_signature_kind, signed_ip,
  signed_user_agent, signed_verification_method, signed_timezone, consented_at,
  consent_disclosure_version, status, client_task_id, created_at, updated_at
) ON public.esign_envelope_signers TO authenticated;

REVOKE ALL ON FUNCTION
  public.esign_freeze_completed_envelope(),
  public.esign_guard_draft_edit(),
  public.esign_supersede_sms_codes(),
  public.esign_expire_envelope(uuid, timestamptz),
  public.esign_insert_document_with_pages(uuid, uuid, text, text, bigint, integer),
  public.esign_set_signer_fields(uuid, uuid, jsonb),
  public.esign_apply_page_reorder(uuid, jsonb, jsonb, uuid[]),
  public.esign_delete_draft_document(uuid, uuid, jsonb, uuid[]),
  public.esign_claim_signer_signature(uuid, text, text, text, text, timestamptz, inet, text, text, text, text),
  public.esign_check_sms_code(uuid, text, integer, text, inet, integer),
  public.esign_delete_signature_images_for_envelope(uuid),
  public.esign_purge_terminal_signature_images(timestamptz, integer),
  public.esign_prune_operational()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.esign_insert_document_with_pages(uuid, uuid, text, text, bigint, integer),
  public.esign_set_signer_fields(uuid, uuid, jsonb),
  public.esign_apply_page_reorder(uuid, jsonb, jsonb, uuid[]),
  public.esign_delete_draft_document(uuid, uuid, jsonb, uuid[]),
  public.esign_claim_signer_signature(uuid, text, text, text, text, timestamptz, inet, text, text, text, text),
  public.esign_check_sms_code(uuid, text, integer, text, inet, integer),
  public.esign_delete_signature_images_for_envelope(uuid),
  public.esign_purge_terminal_signature_images(timestamptz, integer),
  public.esign_prune_operational(),
  public.esign_expire_envelope(uuid, timestamptz)
  TO service_role;
