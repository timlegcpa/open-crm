-- 0013_crm: client tiers and reversible contact archiving. Written to run once on top of
-- 0001-0012, which an adopter may already have applied: it only adds (two columns, one
-- trigger, one column grant) and replaces one function body.
--
-- Depends on: 0002_contacts (contacts and its column grants), 0010_email
-- (group_email_claim, replaced here so an archived contact is never mailed).
--
-- Rules, as for every migration in this schema. src/__tests__/db/invariants.test.ts reads
-- the migrated catalog and fails the build when a table or function here breaks one:
--   * Privileges stated, never inherited: a new function is revoked from PUBLIC, anon,
--     authenticated and service_role, then granted per role. A trigger function needs no
--     grant: a trigger runs whoever fires it.
--   * Every function pins SET search_path = '' and schema-qualifies what it touches;
--     SECURITY DEFINER only where it must be (nothing here needs it).
--   * Column grants are by column: a signed-in session updates exactly the columns the
--     owner edits. The contacts RLS policy (owner only, 0002) still decides the rows.
--
-- Tiers. The owner's hand-set ranking of clients: S (top), then A, B, C, D, E. NULL is
-- "not ranked", where every existing contact starts. A judgment, never derived: nothing
-- computes it. Owner only by construction: contacts is an owner-only table (a client reads
-- its own contact through get_my_contact(), whose column list does not include it), and a
-- signed-in session may UPDATE the column but not INSERT it, so the intake never seeds one.
-- The app's twin of the CHECK list is CLIENT_TIERS in src/features/crm/lib/tiers.ts, pinned
-- against this file by a test.
--
-- Archiving. `archived_at` takes a contact off every working list (the index, the pipeline
-- board, the table, the tiers, contact pickers and group email) while the contact, its
-- quotes, documents, notes and history stay exactly as they are. It is a second axis, not a
-- status: the status is left alone, so Restore (clearing the column) returns the contact to
-- the very stage it left, with no history to mine for it. That also keeps every guard keyed
-- on a status in force across an archive: a contact the e-signature flow created to sign
-- (the system status) is still that while archived, so archiving never turns its unproven
-- address into an ordinary, promotable contact.
--
-- The time is the database's: a caller may archive (any non-null value) or restore (null),
-- never backdate. Archiving an archived contact keeps the first time, so an older browser
-- repeating the action cannot move it.

ALTER TABLE public.contacts
  ADD COLUMN tier text CONSTRAINT contacts_tier_check CHECK (tier IS NULL OR tier IN ('S', 'A', 'B', 'C', 'D', 'E')),
  ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN public.contacts.tier IS
  'The owner''s hand-set client ranking: S (top), A, B, C, D, E. NULL = not ranked. Owner only.';
COMMENT ON COLUMN public.contacts.archived_at IS
  'When the contact was archived (off every working list, record kept); NULL = not archived. Stamped by the database.';

CREATE FUNCTION public.contacts_stamp_archived_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.archived_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NOT NULL THEN
    NEW.archived_at := OLD.archived_at;
  ELSE
    NEW.archived_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contacts_stamp_archived_at
  BEFORE INSERT OR UPDATE OF archived_at ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_stamp_archived_at();

REVOKE ALL ON FUNCTION public.contacts_stamp_archived_at() FROM PUBLIC, anon, authenticated, service_role;

-- The owner edits both from the record, the tier board and the archive actions. UPDATE
-- only: no signed-in INSERT may set either.
GRANT UPDATE (tier, archived_at) ON public.contacts TO authenticated;

-- One recipient's claim, as in 0010, with one more refusal: a contact archived after the
-- campaign was queued is skipped like a contact whose status no longer allows email. The
-- send path re-checks here at claim time, so this is the gate that holds even when the
-- browser's recipient list was built before the archive.
CREATE OR REPLACE FUNCTION public.group_email_claim(p_campaign_id uuid, p_address text, p_emailable text[])
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_address text := lower(regexp_replace(COALESCE(p_address, ''), '^\s+|\s+$', '', 'g'));
  v_id uuid;
  v_contact uuid;
  v_status text;
  v_archived timestamptz;
BEGIN
  UPDATE public.crm_email_recipients
  SET status = 'sending'
  WHERE campaign_id = p_campaign_id AND lower(address) = v_address AND status = 'queued'
  RETURNING id, contact_id INTO v_id, v_contact;
  IF v_id IS NULL THEN
    RETURN 'gone';
  END IF;

  SELECT c.status, c.archived_at INTO v_status, v_archived FROM public.contacts c WHERE c.id = v_contact;
  IF v_status IS NULL OR p_emailable IS NULL OR NOT (v_status = ANY (p_emailable)) THEN
    UPDATE public.crm_email_recipients
    SET status = 'skipped', error = left(COALESCE('status ' || v_status, 'contact deleted'), 500)
    WHERE id = v_id;
    RETURN 'ineligible';
  END IF;
  IF v_archived IS NOT NULL THEN
    UPDATE public.crm_email_recipients SET status = 'skipped', error = 'archived' WHERE id = v_id;
    RETURN 'ineligible';
  END IF;

  IF EXISTS (SELECT 1 FROM public.email_suppressions s WHERE s.address = v_address) THEN
    UPDATE public.crm_email_recipients SET status = 'skipped', error = 'unsubscribed' WHERE id = v_id;
    RETURN 'suppressed';
  END IF;

  UPDATE public.crm_email_campaigns SET claimed_count = claimed_count + 1 WHERE id = p_campaign_id;
  RETURN 'claimed';
END;
$$;
