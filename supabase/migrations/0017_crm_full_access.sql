-- 0017_crm_full_access: notes the owner can correct and delete, a portal sign-in address
-- the owner can change, and an AI connector that reads and writes nearly the whole CRM.
--
-- Belongs here: the owner's decision that the connector should have near full access to
-- the CRM, and the two owner powers that came with it. What it adds:
--   * contact_notes is no longer append-only. The owner (and the connector, through two
--     audited functions) corrects a note's text or kind and deletes a note. `source` stays
--     unwritable, by column grant, so a note the connector or a lead form wrote can never
--     be relabelled as the owner's: that was the property the append-only grant protected.
--   * Accepting a proposed quote from the connector (mcp_accept_quote): the quote, and the
--     contact's stage the accepted work implies, in one transaction.
--   * The connector reads and writes the whole contact record: the spouse, the mailing
--     address, the lead source and the tier (mcp_get_contact and mcp_update_contact are
--     replaced in place, signatures and privileges unchanged). The contact's own address
--     still has its own doors.
--   * A portal account's sign-in address can be changed (portal_login_for_change,
--     portal_set_login_email, and the connector's audited mcp_change_portal_email). Auth
--     holds the sign-in, and Postgres cannot reach Auth, so the server changes Auth first
--     and these functions own the database half.
--   * The connector reads a contact's request answers (sensitive ones come out encrypted,
--     for the server to open), lists a contact's documents, and reads a stored text
--     document. Each read is audited inside its own transaction, before anything returns.
--   * The consent version moves to 3: a connection approved before these powers existed
--     is approved again before it can use them.
--
-- Written to run once on top of 0001 to 0016. 0001 to 0016 may already be applied on a
-- project, so nothing earlier is edited: CREATE OR REPLACE for the replaced functions,
-- CREATE for the new ones, new policies and grants for contact_notes.
--
-- Depends on: 0001_core (audit_logs), 0002_contacts (contacts, contact_emails,
-- contact_notes, contact_services, client_portal_accounts, lead_sources), 0003_documents
-- (client_documents), 0005_requests (needs_lists, needs_items, needs_item_documents),
-- 0007_mcp (mcp_audit_row, the replaced functions), 0013_crm (contacts.tier,
-- contacts.archived_at) and 0015_mcp (mcp_consent_version).
--
-- Rules, as for every migration in this schema (src/__tests__/db/invariants.test.ts reads
-- the migrated catalog and fails the build when a table or function breaks one):
--   * Every function pins SET search_path = '' and schema-qualifies what it touches;
--     none here is SECURITY DEFINER.
--   * Functions: REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role, then GRANT
--     EXECUTE per role. Every function here is the server's alone: the mcp-crm bearer check
--     and the change-portal-email owner check are the authentication boundaries.
--   * The 0007 shape for the connector's functions: SECURITY INVOKER, returning jsonb,
--     writing the audit row INSIDE the act's transaction (an audit failure rolls the act
--     back, so a retry is safe). Audit details carry ids, keys, counts and outcome codes,
--     never what a person typed, never an address.
--   * A refusal that hands state back is audited like a read; one that reveals nothing
--     (no such row) is not.
--   * No cron schedules.

-- ---------------------------------------------------------------------------
-- Notes: corrected and deleted, the source kept
-- ---------------------------------------------------------------------------

-- Column-scoped: body and kind only. A grant on `source` would let any writer relabel a
-- note; without one, an UPDATE naming it is refused before any policy runs.
GRANT UPDATE (body, kind), DELETE ON public.contact_notes TO authenticated, service_role;

CREATE POLICY contact_notes_owner_update ON public.contact_notes
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_notes_owner_delete ON public.contact_notes
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()));

COMMENT ON TABLE public.contact_notes IS
  'One row per note on a contact. Body and kind can be corrected and a note deleted (0017); source is never writable, so a note written by the connector or a lead form cannot be relabelled as the owner''s.';

-- Correct a note's text, its kind, or both (NULL keeps a value). One not_found for every
-- mismatch (no such note, or a note on another contact), so an id never reveals that some
-- other contact holds it. The body never enters the audit row: its length does.
CREATE FUNCTION public.mcp_update_note(
  p_note_id uuid, p_contact_id uuid, p_body text, p_kind text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT n.id, n.contact_id INTO v_row
    FROM public.contact_notes n
   WHERE n.id = p_note_id
     FOR UPDATE;
  IF NOT FOUND OR v_row.contact_id IS DISTINCT FROM p_contact_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  UPDATE public.contact_notes
     SET body = COALESCE(p_body, body), kind = COALESCE(p_kind, kind)
   WHERE id = p_note_id
  RETURNING id, contact_id, kind, source, body, created_at INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_update_note',
    jsonb_build_object('contact_id', p_contact_id, 'note_id', p_note_id, 'kind', v_row.kind,
                       'note_source', v_row.source, 'body_length', char_length(v_row.body),
                       'fields', to_jsonb(array_remove(ARRAY[
                         CASE WHEN p_body IS NOT NULL THEN 'body' END,
                         CASE WHEN p_kind IS NOT NULL THEN 'kind' END], NULL))),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'updated', 'id', v_row.id, 'contact_id', v_row.contact_id,
                            'kind', v_row.kind, 'source', v_row.source, 'body', v_row.body,
                            'created_at', v_row.created_at);
END;
$$;

-- Delete one note. A hard delete; the audit row (ids, kind, source, length) is the record
-- that it existed, and commits with the delete or not at all.
CREATE FUNCTION public.mcp_delete_note(p_note_id uuid, p_contact_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT n.id, n.contact_id, n.kind, n.source, char_length(n.body) AS body_length INTO v_row
    FROM public.contact_notes n
   WHERE n.id = p_note_id
     FOR UPDATE;
  IF NOT FOUND OR v_row.contact_id IS DISTINCT FROM p_contact_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  DELETE FROM public.contact_notes WHERE id = p_note_id;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_delete_note',
    jsonb_build_object('contact_id', p_contact_id, 'note_id', p_note_id, 'kind', v_row.kind,
                       'note_source', v_row.source, 'body_length', v_row.body_length),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'deleted', 'id', p_note_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Accepting a quote
-- ---------------------------------------------------------------------------

-- The owner's Accept, server-side and in one transaction: the quote becomes accepted, and
-- the contact's stage follows the accepted work the way the CRM's own accept does
-- (contactPatchForQuoteChange in src/features/crm/lib/quotes.ts): an accepted monthly or
-- annual quote makes a client, accepted one-time work alone a one-time client, and a
-- terminal stage (lost, cold, former client) is sticky. The status trigger writes the
-- history entry and client_since, as for any stage change.
--
-- The service and the business are a content binding, as in mcp_delete_quote: the caller
-- must have read the quote, and one moved to another service or business since is not
-- accepted as though it were still the one described. One not_found for every mismatch.
-- The contact is locked first, then the quote (the order every quote writer takes), and a
-- system contact (created only to sign) or an archived one is refused: promoting either is
-- the owner's call.
CREATE FUNCTION public.mcp_accept_quote(
  p_contact_id uuid, p_quote_id uuid, p_organization_id uuid, p_service_type text,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_contact record;
  v_quote record;
  v_derived text;
  v_after record;
BEGIN
  SELECT c.id, c.status, c.archived_at INTO v_contact
    FROM public.contacts c
   WHERE c.id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mcp_accept_quote: not_found';
  END IF;

  SELECT s.id, s.contact_id, s.organization_id, s.service_type, s.state, s.cadence, s.amount INTO v_quote
    FROM public.contact_services s
   WHERE s.id = p_quote_id
     FOR UPDATE;
  IF NOT FOUND
     OR v_quote.contact_id IS DISTINCT FROM p_contact_id
     OR v_quote.service_type IS DISTINCT FROM p_service_type
     OR v_quote.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'mcp_accept_quote: not_found';
  END IF;

  IF v_contact.status = 'esign_signer' THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_accept_quote',
      jsonb_build_object('contact_id', p_contact_id, 'quote_id', p_quote_id, 'outcome', 'system_status'), p_ip, p_user_agent);
    RAISE EXCEPTION 'mcp_accept_quote: system_status';
  END IF;
  IF v_contact.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'mcp_accept_quote: archived';
  END IF;
  IF v_quote.state = 'accepted' THEN
    RAISE EXCEPTION 'mcp_accept_quote: already_accepted';
  END IF;

  UPDATE public.contact_services SET state = 'accepted' WHERE id = p_quote_id;

  -- From every accepted quote of the contact, this one included.
  v_derived := CASE
    WHEN EXISTS (SELECT 1 FROM public.contact_services s
                  WHERE s.contact_id = p_contact_id AND s.state = 'accepted' AND s.cadence IN ('monthly', 'annual'))
      THEN 'client'
    WHEN EXISTS (SELECT 1 FROM public.contact_services s
                  WHERE s.contact_id = p_contact_id AND s.state = 'accepted' AND s.cadence = 'one_time')
      THEN 'one_time'
  END;
  IF v_contact.status NOT IN ('lost', 'cold', 'former_client')
     AND v_derived IS NOT NULL AND v_derived IS DISTINCT FROM v_contact.status THEN
    UPDATE public.contacts SET status = v_derived WHERE id = p_contact_id;
  END IF;

  SELECT c.status, c.client_since INTO v_after FROM public.contacts c WHERE c.id = p_contact_id;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_accept_quote',
    jsonb_build_object('contact_id', p_contact_id, 'quote_id', p_quote_id, 'service_type', v_quote.service_type,
                       'organization_id', v_quote.organization_id, 'cadence', v_quote.cadence,
                       'amount', v_quote.amount, 'from', v_contact.status, 'to', v_after.status),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', p_quote_id, 'service_type', v_quote.service_type, 'state', 'accepted',
                            'cadence', v_quote.cadence, 'amount', v_quote.amount,
                            'organization_id', v_quote.organization_id,
                            'contact_status', v_after.status, 'previous_status', v_contact.status,
                            'client_since', v_after.client_since);
END;
$$;

-- ---------------------------------------------------------------------------
-- The whole contact record
-- ---------------------------------------------------------------------------

-- 0007's read, widened to the whole record: the spouse, the mailing address, the lead
-- source, the tier, the client-since date, whether the contact is archived, every address
-- on the contact's email list and its portal accounts (status and sign-in address, never a
-- user id). Still NULL, and unaudited, when there is no such contact.
CREATE OR REPLACE FUNCTION public.mcp_get_contact(p_contact_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_out jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email,
    'phone', c.phone, 'business_name', c.business_name, 'status', c.status,
    'spouse_first_name', c.spouse_first_name, 'spouse_last_name', c.spouse_last_name,
    'spouse_email', c.spouse_email, 'spouse_phone', c.spouse_phone,
    'mailing_street', c.mailing_street, 'mailing_city', c.mailing_city,
    'mailing_state', c.mailing_state, 'mailing_zip', c.mailing_zip,
    'source', c.source, 'tier', c.tier, 'client_since', c.client_since,
    'archived', c.archived_at IS NOT NULL,
    'emails', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'email', e.email, 'label', e.label, 'is_default', e.is_default)
                       ORDER BY e.kind, e.is_default DESC, e.created_at, e.id)
      FROM public.contact_emails e WHERE e.contact_id = c.id), '[]'::jsonb),
    'portal_accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'role', a.role, 'status', a.status,
                                          'invited_email', a.invited_email, 'has_sign_in', a.user_id IS NOT NULL,
                                          'activated_at', a.activated_at, 'last_login_at', a.last_login_at)
                       ORDER BY a.invited_at, a.id)
      FROM public.client_portal_accounts a WHERE a.contact_id = c.id), '[]'::jsonb),
    'businesses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name,
                                          'organization_type', o.organization_type, 'status', o.status)
                       ORDER BY o.created_at, o.id)
      FROM public.organizations o WHERE o.contact_id = c.id), '[]'::jsonb),
    'quotes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'service_type', s.service_type, 'state', s.state,
                                          'cadence', s.cadence, 'amount', s.amount,
                                          'organization_id', s.organization_id)
                       ORDER BY s.created_at, s.id)
      FROM public.contact_services s WHERE s.contact_id = c.id), '[]'::jsonb),
    'recent_notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'body', n.body,
                                          'source', n.source, 'created_at', n.created_at)
                       ORDER BY n.created_at DESC, n.id DESC)
      FROM (SELECT * FROM public.contact_notes n0 WHERE n0.contact_id = c.id
             ORDER BY n0.created_at DESC, n0.id DESC LIMIT 20) n), '[]'::jsonb))
  INTO v_out
  FROM public.contacts c
  WHERE c.id = p_contact_id;

  IF v_out IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_get_contact', jsonb_build_object('contact_id', p_contact_id),
                               p_ip, p_user_agent);
  RETURN v_out;
END;
$$;

-- 0007's update, widened. Presence decides, never COALESCE: a key that is present writes
-- (an empty string or a null clears a nullable field), a key that is absent keeps its
-- value. The names are NOT NULL, so clearing one stores ''. The source is NOT NULL too and
-- must be a lead source a model may set (active, not a system source); the server checks
-- it against the vocabulary first, and this is the backstop. Never the contact's own
-- address (correct_contact_email and change_portal_email are its doors), and never the
-- spouse's address while a portal account signs in with it: that address is then a live
-- sign-in route. NULL when there is no such contact.
CREATE OR REPLACE FUNCTION public.mcp_update_contact(p_contact_id uuid, p_patch jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_spouse text;
  v_row record;
BEGIN
  SELECT c.spouse_email INTO v_spouse
    FROM public.contacts c
   WHERE c.id = p_contact_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_patch ? 'source' AND NOT EXISTS (
    SELECT 1 FROM public.lead_sources t
     WHERE t.key = p_patch ->> 'source' AND t.is_active AND t.key NOT IN ('lead_intake', 'esign')) THEN
    RAISE EXCEPTION 'mcp_update_contact: inactive_source';
  END IF;

  IF p_patch ? 'spouse_email' AND v_spouse IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.client_portal_accounts a
     WHERE a.contact_id = p_contact_id AND lower(a.invited_email) = lower(btrim(v_spouse))) THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_update_contact',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'spouse_address_signs_in'), p_ip, p_user_agent);
    RAISE EXCEPTION 'mcp_update_contact: spouse_address_signs_in';
  END IF;

  UPDATE public.contacts SET
    first_name        = CASE WHEN p_patch ? 'first_name' THEN COALESCE(p_patch ->> 'first_name', '') ELSE first_name END,
    last_name         = CASE WHEN p_patch ? 'last_name' THEN COALESCE(p_patch ->> 'last_name', '') ELSE last_name END,
    phone             = CASE WHEN p_patch ? 'phone' THEN NULLIF(p_patch ->> 'phone', '') ELSE phone END,
    business_name     = CASE WHEN p_patch ? 'business_name' THEN NULLIF(p_patch ->> 'business_name', '') ELSE business_name END,
    spouse_first_name = CASE WHEN p_patch ? 'spouse_first_name' THEN NULLIF(p_patch ->> 'spouse_first_name', '') ELSE spouse_first_name END,
    spouse_last_name  = CASE WHEN p_patch ? 'spouse_last_name' THEN NULLIF(p_patch ->> 'spouse_last_name', '') ELSE spouse_last_name END,
    spouse_email      = CASE WHEN p_patch ? 'spouse_email' THEN NULLIF(p_patch ->> 'spouse_email', '') ELSE spouse_email END,
    spouse_phone      = CASE WHEN p_patch ? 'spouse_phone' THEN NULLIF(p_patch ->> 'spouse_phone', '') ELSE spouse_phone END,
    mailing_street    = CASE WHEN p_patch ? 'mailing_street' THEN NULLIF(p_patch ->> 'mailing_street', '') ELSE mailing_street END,
    mailing_city      = CASE WHEN p_patch ? 'mailing_city' THEN NULLIF(p_patch ->> 'mailing_city', '') ELSE mailing_city END,
    mailing_state     = CASE WHEN p_patch ? 'mailing_state' THEN NULLIF(p_patch ->> 'mailing_state', '') ELSE mailing_state END,
    mailing_zip       = CASE WHEN p_patch ? 'mailing_zip' THEN NULLIF(p_patch ->> 'mailing_zip', '') ELSE mailing_zip END,
    source            = CASE WHEN p_patch ? 'source' THEN p_patch ->> 'source' ELSE source END,
    tier              = CASE WHEN p_patch ? 'tier' THEN NULLIF(p_patch ->> 'tier', '') ELSE tier END
  WHERE id = p_contact_id
  RETURNING id, first_name, last_name, email, phone, business_name, status, spouse_first_name, spouse_last_name,
            spouse_email, spouse_phone, mailing_street, mailing_city, mailing_state, mailing_zip, source, tier
  INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_update_contact',
    jsonb_build_object('contact_id', p_contact_id,
      'fields', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) AS k)),
    p_ip, p_user_agent);

  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- A portal account's sign-in address
-- ---------------------------------------------------------------------------

-- Changing the address a client signs in with has two halves: Auth (the sign-in itself),
-- which only the server can reach, and these columns, which decide where invitations and
-- requests go. The server changes Auth FIRST: Auth is the half that can refuse for a
-- reason outside this database (most often an address another sign-in already holds), and
-- refusing there leaves everything unchanged and a retry safe. Database first would leave
-- the sign-in on the old address while the record pointed at the new one.
--
-- So there are two steps. portal_login_for_change answers whether the change may go ahead
-- and which sign-in user to change, without writing. portal_set_login_email then writes
-- under locks, compare-and-swapped on the address the caller read, so a change built on a
-- stale read fails loudly instead of overwriting one made meanwhile.
--
-- The outcomes, returned rather than raised so each door maps its own message:
--   not_found        no such account
--   no_sign_in       the account has no sign-in user (an invitation not yet accepted, or
--                    a deactivated account): there is no login to move
--   stale            the stored address is not p_expected_email (case- and padding-blind)
--   unchanged        the new address is the stored one
--   address_in_use   another open account (invited or active) already holds the address
--   ok / updated

CREATE FUNCTION public.portal_login_for_change(p_account_id uuid, p_email text, p_expected_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_account record;
BEGIN
  SELECT a.id, a.contact_id, a.user_id, a.invited_email INTO v_account
    FROM public.client_portal_accounts a
   WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_account.user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_sign_in', 'contact_id', v_account.contact_id);
  END IF;
  IF lower(btrim(COALESCE(v_account.invited_email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(p_expected_email, ''))) THEN
    RETURN jsonb_build_object('outcome', 'stale', 'contact_id', v_account.contact_id);
  END IF;
  IF lower(btrim(COALESCE(v_account.invited_email, ''))) = lower(btrim(p_email)) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'contact_id', v_account.contact_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_portal_accounts o
              WHERE o.id <> p_account_id AND o.status IN ('invited', 'active')
                AND lower(o.invited_email) = lower(btrim(p_email))) THEN
    RETURN jsonb_build_object('outcome', 'address_in_use', 'contact_id', v_account.contact_id);
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'contact_id', v_account.contact_id, 'user_id', v_account.user_id);
END;
$$;

-- The database half. Contact first, then the account: the order create_portal_invitation
-- and reissue_portal_invitation take. The account's address moves, and so does the
-- contact's matching address: the contact's own when the account signed in with it, else
-- the spouse's, else the new address joins the contact's email list (an invitation's
-- address must be one of the contact's own). Moving a default address leaves the old one
-- on the email list as a former address (the email-list trigger), so nothing is lost.
CREATE FUNCTION public.portal_set_login_email(p_account_id uuid, p_email text, p_expected_email text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
  v_account record;
  v_person record;
  v_email text := btrim(p_email);
  v_moved text;
BEGIN
  SELECT a.contact_id INTO v_contact FROM public.client_portal_accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT c.email, c.spouse_email INTO v_person FROM public.contacts c WHERE c.id = v_contact FOR UPDATE;
  SELECT a.id, a.contact_id, a.user_id, a.invited_email INTO v_account
    FROM public.client_portal_accounts a
   WHERE a.id = p_account_id
     FOR UPDATE;
  IF NOT FOUND OR v_account.contact_id IS DISTINCT FROM v_contact THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_account.user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_sign_in', 'contact_id', v_contact);
  END IF;
  IF lower(btrim(COALESCE(v_account.invited_email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(p_expected_email, ''))) THEN
    RETURN jsonb_build_object('outcome', 'stale', 'contact_id', v_contact);
  END IF;
  IF lower(btrim(COALESCE(v_account.invited_email, ''))) = lower(v_email) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'contact_id', v_contact);
  END IF;

  BEGIN
    UPDATE public.client_portal_accounts SET invited_email = v_email WHERE id = p_account_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome', 'address_in_use', 'contact_id', v_contact);
  END;

  IF v_account.invited_email IS NOT NULL AND lower(btrim(COALESCE(v_person.email, ''))) = lower(btrim(v_account.invited_email)) THEN
    UPDATE public.contacts SET email = v_email WHERE id = v_contact;
    v_moved := 'email';
  ELSIF v_account.invited_email IS NOT NULL AND lower(btrim(COALESCE(v_person.spouse_email, ''))) = lower(btrim(v_account.invited_email)) THEN
    UPDATE public.contacts SET spouse_email = v_email WHERE id = v_contact;
    v_moved := 'spouse_email';
  ELSE
    -- A listed address is renamed in place, so its kind and label go with it. If the new
    -- address is already listed, the old row is no longer anyone's and goes.
    BEGIN
      UPDATE public.contact_emails SET email = v_email
       WHERE contact_id = v_contact AND lower(btrim(email)) = lower(btrim(COALESCE(v_account.invited_email, '')));
      IF NOT FOUND THEN
        INSERT INTO public.contact_emails (contact_id, kind, email, is_default)
        VALUES (v_contact, 'primary', v_email, false)
        ON CONFLICT (contact_id, kind, lower(email)) DO NOTHING;
      END IF;
    EXCEPTION WHEN unique_violation THEN
      DELETE FROM public.contact_emails
       WHERE contact_id = v_contact AND lower(btrim(email)) = lower(btrim(v_account.invited_email));
    END;
    v_moved := 'email_list';
  END IF;

  RETURN jsonb_build_object('outcome', 'updated', 'contact_id', v_contact, 'account_id', p_account_id,
                            'contact_address', v_moved);
END;
$$;

-- The connector's door to the database half, audited in the same transaction: ids and the
-- outcome, never either address.
CREATE FUNCTION public.mcp_change_portal_email(
  p_account_id uuid, p_email text, p_expected_email text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_out jsonb;
BEGIN
  v_out := public.portal_set_login_email(p_account_id, p_email, p_expected_email);
  IF v_out ->> 'outcome' <> 'not_found' THEN
    PERFORM public.mcp_audit_row(
      p_actor, 'mcp_change_portal_email',
      jsonb_build_object('contact_id', v_out ->> 'contact_id', 'account_id', p_account_id, 'outcome', v_out ->> 'outcome'),
      p_ip, p_user_agent);
  END IF;
  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reading what a client sent
-- ---------------------------------------------------------------------------

-- A contact's requests with what the client answered: every item's typed answer, a
-- sensitive item's ciphertext (as '\x' hex, for the server to open with the answer key;
-- the plaintext never exists in the database), and the files uploaded to each item. Drafts
-- are left out: a client never saw one, so it holds no answer. The 25 newest requests, or
-- one; `truncated` says when there are more. 0007 kept answers inside the database; the
-- owner reversed that for the connector, and this read is audited in its own transaction
-- (counts and ids only) before anything returns. NULL, unaudited, for no such contact.
CREATE FUNCTION public.mcp_read_request_answers(p_contact_id uuid, p_list_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_lists jsonb;
  v_total integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO v_total
    FROM public.needs_lists l
   WHERE l.contact_id = p_contact_id AND l.status <> 'draft' AND (p_list_id IS NULL OR l.id = p_list_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'list_id', l.id, 'title', l.title, 'status', l.status, 'sent_at', l.sent_at,
           'submitted_at', l.submitted_at, 'closed_at', l.closed_at,
           'items', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'item_id', i.id, 'kind', i.kind, 'label', i.label, 'description', i.description,
                      'required', i.required, 'status', i.status, 'sensitive', i.sensitive,
                      'answer', CASE WHEN NULLIF(btrim(i.answer_text), '') IS NOT NULL THEN i.answer_text END,
                      'answer_ciphertext', CASE WHEN i.answer_ciphertext IS NOT NULL
                                                THEN '\x' || encode(i.answer_ciphertext, 'hex') END,
                      'files', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object(
                                 'document_id', d.id, 'filename', d.original_filename, 'folder_path', d.folder_path,
                                 'file_size', d.file_size, 'mime_type', d.mime_type, 'uploaded_at', nid.uploaded_at)
                               ORDER BY nid.uploaded_at, nid.id)
                          FROM public.needs_item_documents nid
                          JOIN public.client_documents d ON d.id = nid.document_id
                         WHERE nid.item_id = i.id), '[]'::jsonb))
                    ORDER BY i.sort_order, i.created_at, i.id)
               FROM public.needs_items i WHERE i.list_id = l.id), '[]'::jsonb))
         ORDER BY l.created_at DESC, l.id DESC), '[]'::jsonb)
    INTO v_lists
    FROM (SELECT * FROM public.needs_lists l0
           WHERE l0.contact_id = p_contact_id AND l0.status <> 'draft' AND (p_list_id IS NULL OR l0.id = p_list_id)
           ORDER BY l0.created_at DESC, l0.id DESC
           LIMIT 25) l;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_read_request_answers',
    jsonb_build_object(
      'contact_id', p_contact_id, 'list_id', p_list_id, 'lists', jsonb_array_length(v_lists),
      'items', (SELECT COALESCE(sum(jsonb_array_length(x -> 'items')), 0) FROM jsonb_array_elements(v_lists) x),
      'sensitive_answers', (SELECT count(*) FROM jsonb_array_elements(v_lists) x, jsonb_array_elements(x -> 'items') it
                             WHERE it ->> 'answer_ciphertext' IS NOT NULL)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('contact_id', p_contact_id, 'lists', v_lists, 'truncated', v_total > jsonb_array_length(v_lists));
END;
$$;

-- A contact's documents, metadata only, newest first, at most p_limit (clamped to
-- 1..500); `truncated` says when there are more. Audited with the count. NULL, unaudited,
-- for no such contact.
CREATE FUNCTION public.mcp_list_documents(p_contact_id uuid, p_limit integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_docs jsonb;
  v_total integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO v_total FROM public.client_documents d WHERE d.contact_id = p_contact_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'filename', d.original_filename, 'folder_path', d.folder_path, 'category', d.category,
           'file_size', d.file_size, 'mime_type', d.mime_type, 'held_by', d.held_by,
           'reviewed', d.reviewed_at IS NOT NULL, 'created_at', d.created_at)
         ORDER BY d.created_at DESC, d.id DESC), '[]'::jsonb)
    INTO v_docs
    FROM (SELECT * FROM public.client_documents d0 WHERE d0.contact_id = p_contact_id
           ORDER BY d0.created_at DESC, d0.id DESC LIMIT v_limit) d;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_list_documents',
    jsonb_build_object('contact_id', p_contact_id, 'returned', jsonb_array_length(v_docs)), p_ip, p_user_agent);

  RETURN jsonb_build_object('contact_id', p_contact_id, 'count', jsonb_array_length(v_docs), 'documents', v_docs,
                            'truncated', v_total > jsonb_array_length(v_docs));
END;
$$;

-- Where a stored text document lives, for the server to read and open. Only plain text and
-- CSV, the two text types an upload may be (_shared/magic-bytes.ts): a PDF, an image or a
-- spreadsheet belongs in the document viewer, not a model's context. Both a read and a
-- refusal of a type are audited (the type is a fact about the document); a missing
-- document is not_found and unaudited. The storage path goes only to the server, never
-- into a tool result.
CREATE FUNCTION public.mcp_read_document(p_document_id uuid, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_doc record;
BEGIN
  SELECT d.id, d.contact_id, d.original_filename, d.mime_type, d.storage_path, d.encryption_status, d.encryption_iv
    INTO v_doc
    FROM public.client_documents d
   WHERE d.id = p_document_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_doc.mime_type NOT IN ('text/plain', 'text/csv') THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_read_document_text',
      jsonb_build_object('contact_id', v_doc.contact_id, 'document_id', p_document_id, 'outcome', 'not_text'),
      p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'not_text', 'mime_type', v_doc.mime_type);
  END IF;

  PERFORM public.mcp_audit_row(p_actor, 'mcp_read_document_text',
    jsonb_build_object('contact_id', v_doc.contact_id, 'document_id', p_document_id), p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'ok', 'document_id', v_doc.id, 'contact_id', v_doc.contact_id,
                            'filename', v_doc.original_filename, 'mime_type', v_doc.mime_type,
                            'storage_path', v_doc.storage_path, 'encryption_status', v_doc.encryption_status,
                            'encryption_iv', v_doc.encryption_iv);
END;
$$;

-- ---------------------------------------------------------------------------
-- The consent version
-- ---------------------------------------------------------------------------

-- New powers (accept a quote, correct and delete notes, change a sign-in address, read
-- answers and documents, write the whole record): every connection approved on the
-- version 2 wording is approved again. CONSENT_VERSION in src/features/mcp/pages.tsx moves
-- with it (src/__tests__/db/mcp.test.ts holds the two equal).
CREATE OR REPLACE FUNCTION public.mcp_consent_version()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT 3 $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- The functions created here only. The replaced ones keep the privileges 0007 and 0015
-- gave them.
REVOKE ALL ON FUNCTION
  public.mcp_update_note(uuid, uuid, text, text, uuid, text, text),
  public.mcp_delete_note(uuid, uuid, uuid, text, text),
  public.mcp_accept_quote(uuid, uuid, uuid, text, uuid, text, text),
  public.portal_login_for_change(uuid, text, text),
  public.portal_set_login_email(uuid, text, text),
  public.mcp_change_portal_email(uuid, text, text, uuid, text, text),
  public.mcp_read_request_answers(uuid, uuid, uuid, text, text),
  public.mcp_list_documents(uuid, integer, uuid, text, text),
  public.mcp_read_document(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.mcp_update_note(uuid, uuid, text, text, uuid, text, text),
  public.mcp_delete_note(uuid, uuid, uuid, text, text),
  public.mcp_accept_quote(uuid, uuid, uuid, text, uuid, text, text),
  public.portal_login_for_change(uuid, text, text),
  public.portal_set_login_email(uuid, text, text),
  public.mcp_change_portal_email(uuid, text, text, uuid, text, text),
  public.mcp_read_request_answers(uuid, uuid, uuid, text, text),
  public.mcp_list_documents(uuid, integer, uuid, text, text),
  public.mcp_read_document(uuid, uuid, text, text)
TO service_role;
