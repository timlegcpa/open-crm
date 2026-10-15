-- 0011_control_center: what the settings page owns beyond org_profile and app_settings.
--
-- Here: the lead-intake key (stored hashed) and the record of every delivery it accepted,
-- the one function that records a delivery, and the public bucket the organization's logo
-- lives in (org_profile.logo_path names it). Pick-lists are not here: each lives with the
-- first domain that uses it, and the settings page only edits them.
--
-- Depends on: 0001_core (org_profile, is_owner(), mfa_session_ok()), 0002_contacts
-- (contacts, contact_emails, contact_notes and the lead_intake system source).
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
-- Nothing here is client-writable: the owner reads, and only the server (the lead-intake
-- and lead-intake-key edge functions) writes.

-- ---------------------------------------------------------------------------
-- The lead-intake key: one row, or none (then every delivery is refused). Only its
-- SHA-256 digest is stored; the key itself is shown to the owner once, when the
-- lead-intake-key function makes it. The owner may read the hint (the key's first
-- characters, to tell one key from the next) and when it was made, never the digest.
-- ---------------------------------------------------------------------------

CREATE TABLE public.lead_intake_keys (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint text NOT NULL CHECK (char_length(key_hint) BETWEEN 4 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

CREATE INDEX idx_lead_intake_keys_created_by ON public.lead_intake_keys (created_by);

-- ---------------------------------------------------------------------------
-- One row per accepted delivery. external_id is the sender's own id for the lead and the
-- whole of retry detection: a delivery seen before is answered and changes nothing.
-- The row outlives its contact (contact_id goes NULL), so a late redelivery of a lead
-- the owner has deleted is still recognised and cannot bring the contact back.
-- ---------------------------------------------------------------------------

CREATE TABLE public.lead_intake_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_intake_deliveries_external_id_key ON public.lead_intake_deliveries (external_id);
CREATE INDEX idx_lead_intake_deliveries_contact ON public.lead_intake_deliveries (contact_id);
CREATE INDEX idx_lead_intake_deliveries_created ON public.lead_intake_deliveries (created_at DESC);

-- Two deliveries for one new address at the same moment (two different external ids):
-- one insert wins and the other re-reads the winner, so one person is one contact.
-- Partial on the source, so it binds only contacts lead intake created. It binds the
-- owner's edits of those contacts too: two of them cannot be given one address.
CREATE UNIQUE INDEX contacts_lead_intake_email_key
  ON public.contacts (lower(email)) WHERE source = 'lead_intake';

-- ---------------------------------------------------------------------------
-- lead_intake_record: one delivery, in one transaction, so a crash can never leave a
-- contact without its note or a delivery that was never recorded. Called by the
-- lead-intake edge function (service role) after the key, the rate limit and the body
-- have passed. Runs as the caller (SECURITY INVOKER); only the server may call it.
--
--   1. The delivery row first. Its unique index is what serialises two posts of one
--      delivery: the one that loses inserts nothing and answers 'replayed' having
--      written nothing, before it can create a contact or a second note.
--   2. The person, by address: contacts.email, then a contact_emails 'primary' row.
--      Never a 'spouse' row: a spouse is another person, and folding their address in
--      would swallow a new lead into someone else's record.
--   3. No match: a new contact, status new_lead and source lead_intake, both constants
--      here (the caller's payload cannot choose them). A concurrent insert of the same
--      address hits contacts_lead_intake_email_key and re-reads the winner.
--   4. The note: the delivery id, then the business, phone and the sender's notes, which
--      the caller formats (p_note).
-- Returns {status: 'replayed'} or {status: 'created' | 'matched', delivery_id,
-- contact_id}. The edge function answers every one of them the same way, so a key holder
-- cannot learn whether an address is already a contact.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.lead_intake_record(
  p_external_id text,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_business_name text,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_delivery uuid;
  v_contact uuid;
  v_status text := 'matched';
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' OR p_first_name IS NULL OR btrim(p_first_name) = '' THEN
    RAISE EXCEPTION 'lead_intake_record: first name and email are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.lead_intake_deliveries (external_id)
  VALUES (p_external_id)
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_delivery;
  IF v_delivery IS NULL THEN
    RETURN jsonb_build_object('status', 'replayed');
  END IF;

  SELECT c.id INTO v_contact
    FROM public.contacts c
   WHERE lower(c.email) = lower(p_email)
   ORDER BY c.created_at, c.id
   LIMIT 1;

  IF v_contact IS NULL THEN
    SELECT e.contact_id INTO v_contact
      FROM public.contact_emails e
     WHERE e.kind = 'primary' AND lower(e.email) = lower(p_email)
     ORDER BY e.created_at, e.id
     LIMIT 1;
  END IF;

  IF v_contact IS NULL THEN
    INSERT INTO public.contacts (first_name, last_name, email, phone, business_name, status, source)
    VALUES (p_first_name, COALESCE(p_last_name, ''), p_email, p_phone, p_business_name, 'new_lead', 'lead_intake')
    ON CONFLICT ((lower(email))) WHERE source = 'lead_intake' DO NOTHING
    RETURNING id INTO v_contact;

    IF v_contact IS NULL THEN
      SELECT c.id INTO v_contact
        FROM public.contacts c
       WHERE c.source = 'lead_intake' AND lower(c.email) = lower(p_email);
    ELSE
      v_status := 'created';
    END IF;
  END IF;

  IF v_contact IS NULL THEN
    RAISE EXCEPTION 'lead_intake_record: no contact for this delivery';
  END IF;

  UPDATE public.lead_intake_deliveries SET contact_id = v_contact WHERE id = v_delivery;

  INSERT INTO public.contact_notes (contact_id, body, kind, source)
  VALUES (v_contact, p_note, 'note', 'lead_intake');

  RETURN jsonb_build_object('status', v_status, 'delivery_id', v_delivery, 'contact_id', v_contact);
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: the owner reads; nothing for anyone else. The server bypasses RLS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.lead_intake_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_intake_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_intake_keys_owner_select ON public.lead_intake_keys
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY lead_intake_deliveries_owner_select ON public.lead_intake_deliveries
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

CREATE POLICY lead_intake_keys_mfa_gate ON public.lead_intake_keys AS RESTRICTIVE
  FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY lead_intake_deliveries_mfa_gate ON public.lead_intake_deliveries AS RESTRICTIVE
  FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- ---------------------------------------------------------------------------
-- The logo bucket. Public, because emails and the sign-in page show the logo by URL
-- (organization.ts turns 'org-assets/<path>' into the public object URL). It holds
-- images only (PNG, JPEG or WebP: never SVG, which can carry script) of at most 1 MiB,
-- and only the org-logo edge function writes it, as the server after checking the
-- bytes, so it has no storage.objects policy of its own: no signed-in session can write
-- or list it. Old logos are kept, because emails already sent point at them.
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('org-assets', 'org-assets', true, 1048576, ARRAY['image/png', 'image/jpeg', 'image/webp']);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.lead_intake_keys, public.lead_intake_deliveries
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_intake_keys, public.lead_intake_deliveries TO service_role;

-- The digest never leaves the server, even to the owner: a column grant, not a convention.
GRANT SELECT (key_hint, created_at) ON public.lead_intake_keys TO authenticated;
GRANT SELECT ON public.lead_intake_deliveries TO authenticated;

REVOKE ALL ON FUNCTION
  public.lead_intake_record(text, text, text, text, text, text, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.lead_intake_record(text, text, text, text, text, text, text)
TO service_role;
