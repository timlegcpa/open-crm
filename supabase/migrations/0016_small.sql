-- 0016_small: deactivating a portal account expires the contact's pending start links in
-- the same transaction.
--
-- Depends on: 0002_contacts (client_portal_accounts, portal_invitations), 0005_requests
-- (pending_signup_requests), 0012_portal (deactivate_portal_account, replaced here).
--
-- Why: redeeming a start link creates a fresh active sign-in, so every path that takes
-- portal access away expires the contact's pending links. revoke-portal-access used to do
-- it as a separate call after the deactivate, and logged a failure without failing. The
-- redemption check (start_link_access_revoked) does not cover every account shape: with
-- another account on the contact active but holding no sign-in (the state a failed
-- redemption retry leaves), a link to that account's address stayed redeemable after the
-- revoke. Inside the deactivate the expiry cannot fail on its own: both land or neither.
-- Contact-wide on purpose, as in delete-contact: a revoke is a statement about the
-- contact's portal, and the owner can send a fresh link to anyone who still needs one.
--
-- Written to run once on top of 0001 to 0012 (and whatever later files an adopter has):
-- CREATE OR REPLACE keeps the function's signature, owner and privileges, which are
-- restated below anyway.
--
-- Rules, as for every migration in this schema. src/__tests__/db/invariants.test.ts reads
-- the migrated catalog and fails the build when a table or function here breaks one:
--   * RLS on every table, and a RESTRICTIVE policy named <table>_mfa_gate, FOR ALL TO
--     authenticated, USING ((SELECT public.mfa_session_ok())) and WITH CHECK the same.
--   * Privileges stated, never inherited: REVOKE ALL ON <table> FROM PUBLIC, anon,
--     authenticated, service_role; then GRANT per role. Row access only (SELECT, INSERT,
--     UPDATE, DELETE, by column where a column must not move); anon gets nothing.
--   * Functions likewise: REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated,
--     service_role; then GRANT EXECUTE per role. Every function pins SET search_path = ''
--     and schema-qualifies what it touches; SECURITY DEFINER only where it must be.
--   * A FOR ALL policy states both USING and WITH CHECK.
--   * The principals are public.is_owner(), public.get_client_contact_id() and the
--     service role; a role claim in a token grants nothing.
--   * Columns a client must not change: a BEFORE UPDATE trigger running
--     public.enforce_client_column_guard('id', ...the columns...).
--   * Every table a client session can write carries trg_impersonation_read_only.
--   * Storage: each bucket gets its own policies on storage.objects, and every clause of
--     each requires bucket_id = '<that bucket>' at its top level (AND, never OR).
-- ---------------------------------------------------------------------------

-- Deactivate one account, revoke the pending invitations to its address and expire the
-- contact's pending start links. Returns the account's sign-in user (NULL when it has
-- none), which the server then bans: a deactivated account must not keep a working
-- password. Already deactivated is not an error, so a retry after a failed ban can finish
-- the job. The server's alone (invoker: service_role holds the row access it needs).
CREATE OR REPLACE FUNCTION public.deactivate_portal_account(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account public.client_portal_accounts;
BEGIN
  -- The contact's pending links are locked BEFORE the account, the order link_start_link
  -- takes (its link, then the contact's accounts), so a revoke and a redemption running at
  -- once queue behind each other instead of deadlocking.
  PERFORM 1 FROM public.pending_signup_requests r
   WHERE r.status = 'pending'
     AND r.contact_id = (SELECT a.contact_id FROM public.client_portal_accounts a WHERE a.id = p_account_id)
   ORDER BY r.id
     FOR UPDATE;
  SELECT * INTO v_account FROM public.client_portal_accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portal_account_not_found';
  END IF;
  UPDATE public.client_portal_accounts a SET status = 'deactivated' WHERE a.id = p_account_id;
  IF v_account.invited_email IS NOT NULL THEN
    UPDATE public.portal_invitations i
       SET status = 'revoked'
     WHERE i.contact_id = v_account.contact_id
       AND lower(i.email) = lower(v_account.invited_email)
       AND i.status = 'pending';
  END IF;
  UPDATE public.pending_signup_requests r
     SET status = 'expired'
   WHERE r.contact_id = v_account.contact_id
     AND r.status = 'pending';
  RETURN v_account.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_portal_account(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_portal_account(uuid) TO service_role;
