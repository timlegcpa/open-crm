-- 0012_portal: the server's side of portal invitations, sign-in records, the lookups the
-- invite flow needs, and the View-as-client credential lock. The portal's tables are in
-- 0002_contacts (client_portal_accounts, portal_invitations, client_activity_log,
-- client_tasks, impersonation_sessions, with the View-as-client rules). The two tables here
-- belong to functions in this file: portal_invitation_claims (one acceptance at a time)
-- and impersonation_credential_snapshots (definer functions only).
--
-- Depends on: 0001_core (org_profile), 0002_contacts (the tables above, the contact
-- delete claim and its trigger on client_portal_accounts).
--
-- Every function here is the server's alone (edge functions, service role): EXECUTE is
-- revoked from every API role and granted to service_role only. The SECURITY DEFINER ones
-- read or guard auth.* (no API role may): find_auth_user_id_by_email,
-- delete_stale_portal_user, impersonation_credential_changes and the credential-lock
-- trigger functions.
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
--   * A view is created WITH (security_invoker = true).
--   * No cron schedules in a migration: scheduled work is a row in public.jobs run by the
--     job-runner, or a schedule the adopter sets up outside the migrations.
--
-- Errors are raised with a stable message the edge functions map to a response:
--   portal_invite_throttled         three invitations to this contact in 24 hours
--   portal_invite_email_not_on_contact
--   portal_account_not_found / portal_account_not_reinvitable / portal_account_has_login
--   contact_not_found
-- plus what 0002 raises on its own: 23505 on idx_portal_accounts_open_invite (an address
-- that already has an open account, compared case-insensitively) and
-- contact_delete_in_progress from the delete claim.

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

-- The cap on invitations to one contact. Shared by a new invite and a resend, which
-- write the same table: a resend that skipped it would be an unbounded way past it.
CREATE FUNCTION public.portal_invite_throttled(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT count(*) >= 3
  FROM public.portal_invitations i
  WHERE i.contact_id = p_contact_id
    AND i.created_at > now() - interval '24 hours';
$$;

-- A new invitation and the account it will activate, in one transaction. Two separate
-- writes once left a pending invitation with no account behind it when the account
-- insert failed (an address differing only in case met the case-insensitive index).
-- Here either both rows land or neither does.
--
-- The contact row is locked first, so two invites to one contact run one at a time and
-- the cap above is exact rather than "three plus however many arrive at once". The
-- address must be one of the contact's own (contact_emails), whatever the caller sent.
-- The second account on a contact that already has an active one is 'secondary'.
CREATE FUNCTION public.create_portal_invitation(
  p_contact_id uuid,
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_invited_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM 1 FROM public.contacts c WHERE c.id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.contact_emails e
    WHERE e.contact_id = p_contact_id AND lower(e.email) = lower(trim(p_email))
  ) THEN
    RAISE EXCEPTION 'portal_invite_email_not_on_contact';
  END IF;
  IF public.portal_invite_throttled(p_contact_id) THEN
    RAISE EXCEPTION 'portal_invite_throttled';
  END IF;

  INSERT INTO public.client_portal_accounts (contact_id, status, role, invited_email, invited_at, invited_by)
  VALUES (
    p_contact_id,
    'invited',
    CASE WHEN EXISTS (
      SELECT 1 FROM public.client_portal_accounts a
      WHERE a.contact_id = p_contact_id AND a.status = 'active'
    ) THEN 'secondary' ELSE 'primary' END,
    trim(p_email),
    now(),
    p_invited_by
  );

  INSERT INTO public.portal_invitations (token_hash, email, contact_id, invited_by, status, expires_at)
  VALUES (p_token_hash, trim(p_email), p_contact_id, p_invited_by, 'pending', p_expires_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- A fresh invitation for ONE account (Resend, Re-invite). Only that account's address
-- loses its earlier pending links and only that account goes back to 'invited': a
-- second person on the same contact (another address) keeps their sign-in and their
-- own pending link. The account must hold no sign-in user any more (the server deletes
-- a deactivated account's user first), so 'invited' never points at a live login.
CREATE FUNCTION public.reissue_portal_invitation(
  p_account_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_invited_by uuid
)
RETURNS TABLE (invitation_id uuid, contact_id uuid, email text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
  v_account public.client_portal_accounts;
  v_id uuid;
BEGIN
  SELECT a.contact_id INTO v_contact FROM public.client_portal_accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portal_account_not_found';
  END IF;
  -- Contact first, then the account: the same order create_portal_invitation takes.
  PERFORM 1 FROM public.contacts c WHERE c.id = v_contact FOR UPDATE;
  SELECT * INTO v_account FROM public.client_portal_accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_account.contact_id IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'portal_account_not_found';
  END IF;
  IF v_account.status NOT IN ('invited', 'deactivated') OR v_account.invited_email IS NULL THEN
    RAISE EXCEPTION 'portal_account_not_reinvitable';
  END IF;
  IF v_account.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'portal_account_has_login';
  END IF;
  IF public.portal_invite_throttled(v_contact) THEN
    RAISE EXCEPTION 'portal_invite_throttled';
  END IF;

  UPDATE public.portal_invitations i
     SET status = 'revoked'
   WHERE i.contact_id = v_contact
     AND lower(i.email) = lower(v_account.invited_email)
     AND i.status = 'pending';

  INSERT INTO public.portal_invitations (token_hash, email, contact_id, invited_by, status, expires_at)
  VALUES (p_token_hash, v_account.invited_email, v_contact, p_invited_by, 'pending', p_expires_at)
  RETURNING id INTO v_id;

  UPDATE public.client_portal_accounts a
     SET status = 'invited', invited_at = now(), invited_by = p_invited_by
   WHERE a.id = p_account_id;

  RETURN QUERY SELECT v_id, v_contact, v_account.invited_email;
END;
$$;

-- Attach a new sign-in user to the account an invitation opened, and activate it.
-- Returns the account id, or NULL when no row could take the link: the invitation is no
-- longer pending or has expired, no account is open for that address, it is already
-- linked (a second acceptance racing this one), or a contact delete has claimed it. NULL is a real outcome, and the caller removes the user it created.
--
-- `delete_claim IS NULL`, not `status = 'invited'`: a link whose un-ban failed leaves the
-- row active with its user later cleared, and a status test would refuse every retry.
CREATE FUNCTION public.link_portal_invitation(p_invitation_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_invite public.portal_invitations;
  v_account uuid;
BEGIN
  -- Locked and re-checked here, in the link's own transaction: a revoke, a reissue or the
  -- expiry that lands between the caller's check and this link must still refuse it.
  SELECT * INTO v_invite FROM public.portal_invitations i WHERE i.id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_invite.status <> 'pending' OR v_invite.expires_at <= now() THEN
    RETURN NULL;
  END IF;
  UPDATE public.client_portal_accounts a
     SET user_id = p_user_id, status = 'active', activated_at = now()
   WHERE a.id = (
           SELECT c.id FROM public.client_portal_accounts c
           WHERE c.contact_id = v_invite.contact_id
             AND c.status IN ('invited', 'active')
             AND lower(c.invited_email) = lower(v_invite.email)
             AND c.user_id IS NULL
           ORDER BY c.invited_at DESC, c.id
           LIMIT 1)
     AND a.user_id IS NULL
     AND a.delete_claim IS NULL
  RETURNING a.id INTO v_account;
  RETURN v_account;
END;
$$;

-- ---------------------------------------------------------------------------
-- Acceptance: one at a time per invitation
-- ---------------------------------------------------------------------------
--
-- Two acceptances of one link at once once raced: each read the stale-user state on its
-- own, so both could answer success with different passwords, or the slower one deleted
-- the login the faster one had just made. An acceptance now claims its invitation first
-- and holds the claim to the end; a second one finds it held and is refused before it
-- creates or deletes anything. A claim older than five minutes is a crashed acceptance and
-- may be taken over (an acceptance takes seconds). Written by these functions alone.
CREATE TABLE public.portal_invitation_claims (
  invitation_id uuid PRIMARY KEY REFERENCES public.portal_invitations (id) ON DELETE CASCADE,
  claim uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.portal_invitation_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_invitation_claims_mfa_gate ON public.portal_invitation_claims
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
REVOKE ALL ON public.portal_invitation_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_invitation_claims TO service_role;

-- Claim a pending, unexpired invitation for one acceptance. The invitation row is locked
-- while the claim is decided, so two callers cannot both win. True when `p_claim` holds it.
CREATE FUNCTION public.claim_portal_invitation(p_invitation_id uuid, p_claim uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_invite public.portal_invitations;
  v_won integer;
BEGIN
  SELECT * INTO v_invite FROM public.portal_invitations i WHERE i.id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_invite.status <> 'pending' OR v_invite.expires_at <= now() THEN
    RETURN false;
  END IF;
  INSERT INTO public.portal_invitation_claims AS c (invitation_id, claim, claimed_at)
  VALUES (p_invitation_id, p_claim, now())
  ON CONFLICT (invitation_id) DO UPDATE
    SET claim = EXCLUDED.claim, claimed_at = EXCLUDED.claimed_at
    WHERE c.claimed_at < now() - interval '5 minutes';
  GET DIAGNOSTICS v_won = ROW_COUNT;
  RETURN v_won > 0;
END;
$$;

-- Let go of a claim, only by the acceptance that holds it.
CREATE FUNCTION public.release_portal_invitation_claim(p_invitation_id uuid, p_claim uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.portal_invitation_claims c WHERE c.invitation_id = p_invitation_id AND c.claim = p_claim;
END;
$$;

-- Delete the sign-in user an earlier, unfinished acceptance of THIS invitation left behind,
-- deciding and deleting in one statement, so nothing can change in between. Only while the
-- caller holds the claim, and only a user that is still unactivated: stamped with this
-- invitation (pending_invite, cleared at activation) and still banned (created banned,
-- un-banned at activation). Never one linked to another contact's account, never the owner
-- or the system actor. True when it deleted the user.
CREATE FUNCTION public.delete_stale_portal_user(p_user uuid, p_invitation_id uuid, p_claim uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contact uuid;
  v_deleted integer;
BEGIN
  SELECT i.contact_id INTO v_contact
    FROM public.portal_invitations i
    JOIN public.portal_invitation_claims c ON c.invitation_id = i.id AND c.claim = p_claim
   WHERE i.id = p_invitation_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM auth.users u
   WHERE u.id = p_user
     AND u.raw_app_meta_data ->> 'pending_invite' = p_invitation_id::text
     AND u.banned_until IS NOT NULL AND u.banned_until > now()
     AND NOT EXISTS (
       SELECT 1 FROM public.client_portal_accounts a WHERE a.user_id = u.id AND a.contact_id <> v_contact)
     AND NOT EXISTS (
       SELECT 1 FROM public.org_profile o WHERE u.id = o.owner_user_id OR u.id = o.system_user_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- Deactivate one account and revoke the pending links to its address. Returns the
-- account's sign-in user (NULL when it has none), which the server then bans: a
-- deactivated account must not keep a working password. Already deactivated is not an
-- error, so a retry after a failed ban can finish the job.
CREATE FUNCTION public.deactivate_portal_account(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account public.client_portal_accounts;
BEGIN
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
  RETURN v_account.user_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Sign-in records
-- ---------------------------------------------------------------------------

-- One sign-in: the count goes up in the row, so two sign-ins at once both count (a read
-- then a write lost one). Active accounts only. Returns whether a row was stamped.
CREATE FUNCTION public.record_portal_login(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.client_portal_accounts a
     SET last_login_at = now(), login_count = a.login_count + 1
   WHERE a.user_id = p_user AND a.status = 'active';
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Lookups
-- ---------------------------------------------------------------------------

-- The sign-in user holding an address, for the invite flow's stale-user check. The
-- answer feeds a decision to DELETE that user, so it never names the owner or the
-- system actor. NOT EXISTS, not NOT IN: a NULL in org_profile would make NOT IN
-- answer nothing at all.
CREATE FUNCTION public.find_auth_user_id_by_email(target_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE lower(u.email) = lower(trim(target_email))
    AND NOT EXISTS (
      SELECT 1 FROM public.org_profile o
      WHERE u.id = o.owner_user_id OR u.id = o.system_user_id)
  ORDER BY u.created_at, u.id
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- View as client: the client's credentials are locked while it runs
-- ---------------------------------------------------------------------------
--
-- The minted session is a real Auth session. The read-only rules in 0002 cover the data
-- API and storage, but Auth's own endpoints (change password, change email, enroll a
-- second factor) write auth.users and auth.mfa_factors directly, as Auth's role, with no
-- token the database can read. So the lock is on the user: while a View-as-client row for
-- that user is live, those writes are refused whoever makes them. Live means:
--   * not ended; or
--   * bound, and its minted session still exists (a session outlives its row until it
--     is revoked); or
--   * ended less than an hour ago, the life of an access token issued before the end.
-- The cost: the real client cannot change their own password or email, or enroll a
-- factor, during a view and for that hour; the stale sweep bounds a forgotten view at
-- eight hours.
CREATE FUNCTION public.impersonation_credentials_locked(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.impersonation_sessions s
     WHERE s.target_user_id = p_user
       AND (s.ended_at IS NULL
            OR s.ended_at > now() - interval '1 hour'
            OR (s.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM auth.sessions a WHERE a.id = s.session_id))));
END;
$$;

-- Narrow on purpose: Auth rewrites the whole auth.users row on every sign-in and token
-- refresh (last_sign_in_at, updated_at, metadata), so the trigger fires on every update
-- and refuses only a change to the password hash or the email address. The hash is read
-- through to_jsonb, so this file applies to an auth schema without that column (the test
-- stub) and reads it on a real project.
CREATE FUNCTION public.refuse_credential_change_under_view()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF ((to_jsonb(NEW) ->> 'encrypted_password') IS DISTINCT FROM (to_jsonb(OLD) ->> 'encrypted_password')
      OR NEW.email IS DISTINCT FROM OLD.email)
     AND public.impersonation_credentials_locked(OLD.id) THEN
    RAISE EXCEPTION 'impersonation_credentials_locked'
      USING ERRCODE = '42501',
            HINT = 'A client''s password and email cannot change while View as client is live.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_impersonation_credentials_locked
  BEFORE UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.refuse_credential_change_under_view();

-- A new factor, or a factor changing status (an enrollment being verified), under the same
-- lock: the owner must never put their own authenticator on the client's account.
CREATE FUNCTION public.refuse_factor_change_under_view()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND public.impersonation_credentials_locked(NEW.user_id) THEN
    RAISE EXCEPTION 'impersonation_credentials_locked'
      USING ERRCODE = '42501',
            HINT = 'A client cannot enroll a second factor while View as client is live.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_impersonation_factor_locked
  BEFORE INSERT OR UPDATE ON auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION public.refuse_factor_change_under_view();

-- What the client's credentials were when a view started, so its end can say whether they
-- changed (defence in depth behind the lock above). Digests only: an md5 of the stored
-- password hash, never the hash itself. Written and read by definer functions alone.
CREATE TABLE public.impersonation_credential_snapshots (
  impersonation_session_id uuid PRIMARY KEY REFERENCES public.impersonation_sessions (id) ON DELETE CASCADE,
  password_digest text,
  email text,
  factor_ids uuid[] NOT NULL DEFAULT '{}',
  taken_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.impersonation_credential_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY impersonation_credential_snapshots_mfa_gate ON public.impersonation_credential_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
REVOKE ALL ON public.impersonation_credential_snapshots FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.snapshot_impersonation_credentials()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.impersonation_credential_snapshots (impersonation_session_id, password_digest, email, factor_ids)
  SELECT NEW.id,
         md5(coalesce(to_jsonb(u) ->> 'encrypted_password', '')),
         u.email,
         coalesce((SELECT array_agg(f.id ORDER BY f.id) FROM auth.mfa_factors f WHERE f.user_id = u.id), '{}')
    FROM auth.users u
   WHERE u.id = NEW.target_user_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_impersonation_credential_snapshot
  AFTER INSERT ON public.impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_impersonation_credentials();

-- What changed on the client's sign-in since the view started: flags and a count only,
-- for the impersonate_end audit row. NULL when the row or its snapshot is gone.
CREATE FUNCTION public.impersonation_credential_changes(p_row uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_snap public.impersonation_credential_snapshots;
  v_user uuid;
  v_password text;
  v_email text;
  v_added integer;
BEGIN
  SELECT * INTO v_snap FROM public.impersonation_credential_snapshots c WHERE c.impersonation_session_id = p_row;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT s.target_user_id INTO v_user FROM public.impersonation_sessions s WHERE s.id = p_row;
  SELECT md5(coalesce(to_jsonb(u) ->> 'encrypted_password', '')), u.email INTO v_password, v_email FROM auth.users u WHERE u.id = v_user;
  SELECT count(*) INTO v_added FROM auth.mfa_factors f WHERE f.user_id = v_user AND NOT (f.id = ANY (v_snap.factor_ids));
  RETURN jsonb_build_object(
    'password_changed', v_password IS DISTINCT FROM v_snap.password_digest,
    'email_changed', v_email IS DISTINCT FROM v_snap.email,
    'factors_added', v_added);
END;
$$;

-- The stale sweep (0002) closes forgotten rows with no audit row of its own; this writes
-- one for each row it closes, with the same credential check the owner's end records.
CREATE FUNCTION public.audit_auto_ended_impersonation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND NEW.auto_ended THEN
    INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (
      NEW.owner_user_id,
      'impersonate_end',
      jsonb_build_object(
        'session_id', NEW.id,
        'auto_ended', true,
        'duration_ms', floor(extract(epoch FROM (NEW.ended_at - NEW.started_at)) * 1000)::bigint)
      || coalesce(public.impersonation_credential_changes(NEW.id), '{}'::jsonb));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_impersonation_auto_end_audit
  AFTER UPDATE ON public.impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.audit_auto_ended_impersonation();

-- ---------------------------------------------------------------------------
-- Privileges: the server's alone.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.portal_invite_throttled(uuid),
  public.create_portal_invitation(uuid, text, text, timestamptz, uuid),
  public.reissue_portal_invitation(uuid, text, timestamptz, uuid),
  public.link_portal_invitation(uuid, uuid),
  public.deactivate_portal_account(uuid),
  public.record_portal_login(uuid),
  public.find_auth_user_id_by_email(text),
  public.claim_portal_invitation(uuid, uuid),
  public.release_portal_invitation_claim(uuid, uuid),
  public.delete_stale_portal_user(uuid, uuid, uuid),
  public.impersonation_credentials_locked(uuid),
  public.impersonation_credential_changes(uuid),
  public.refuse_credential_change_under_view(),
  public.refuse_factor_change_under_view(),
  public.snapshot_impersonation_credentials(),
  public.audit_auto_ended_impersonation()
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.portal_invite_throttled(uuid),
  public.create_portal_invitation(uuid, text, text, timestamptz, uuid),
  public.reissue_portal_invitation(uuid, text, timestamptz, uuid),
  public.link_portal_invitation(uuid, uuid),
  public.deactivate_portal_account(uuid),
  public.record_portal_login(uuid),
  public.find_auth_user_id_by_email(text),
  public.claim_portal_invitation(uuid, uuid),
  public.release_portal_invitation_claim(uuid, uuid),
  public.delete_stale_portal_user(uuid, uuid, uuid),
  public.impersonation_credential_changes(uuid)
TO service_role;
