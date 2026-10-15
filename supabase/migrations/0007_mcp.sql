-- 0007_mcp: the MCP connector.
--
-- Belongs here: the OAuth server's tables (registered clients, authorization requests and
-- their codes, grants, access and refresh tokens, every secret stored as a SHA-256 hash),
-- the mcp_oauth_* functions the mcp-oauth and mcp-crm edge functions call, and the audited
-- read and write functions behind the contact and request tools (mcp_* and mcp_audit_row).
-- OAuth only: there is no static bearer token. The owner's two connector functions (mcp_list_grants,
-- mcp_revoke_grant) back the AI connector section of Settings.
--
-- Depends on: 0001_core (org_profile, audit_logs, is_owner), 0002_contacts (contacts and
-- their businesses, quotes, notes, portal accounts and pick-lists), 0005_requests (the
-- request tables, pick-lists and draft functions the request tools call; see the request
-- tools section).
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
-- What this file decides, and why:
--   * Every function the edge functions call is SECURITY INVOKER and executable by
--     service_role alone. The server already holds the row grants, so a definer would buy
--     nothing, and a signed-in session can execute none of them. The two owner functions
--     are definers that refuse anyone but the owner before they read or write.
--   * Every function returns jsonb (or a scalar), never a table, so the edge function and
--     the PGlite tests read one shape.
--   * A grant records the person who approved it (approved_by). Every access token is
--     accepted only while that person is still org_profile.owner_user_id, and that id is
--     the actor on every audit row the connector writes: an MCP call carries the owner's
--     delegated authority, given at aal2 on the consent screen, so it is attributed to
--     the owner, with details.source = 'mcp' telling it apart from the owner's own edits.
--   * The audited writes put their audit row INSIDE the write's transaction: an audit
--     failure rolls the write back, so a retry is safe and nothing commits unrecorded. The
--     two reads audit inside their transaction too, so a read that cannot be recorded
--     returns nothing.
--   * Audit details carry ids, counts, flags and codes, never what a person typed: a
--     search records the length of its query, an address correction records that it
--     happened, not the addresses (the old one stays on the contact's email list).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Dynamic client registration (RFC 7591). Registration confers nothing: the only thing a
-- registered client can do is ask the owner, whose approval at aal2 is the boundary.
CREATE TABLE public.mcp_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE CHECK (client_id ~ '^mcpc_[A-Za-z0-9_-]{20,80}$'),
  client_name text CHECK (client_name IS NULL OR char_length(client_name) <= 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- An authorization request parked by /authorize until the owner decides it. approved_by
-- is whoever decided (approve or deny). An approved request holds the hash of a five
-- minute, single-use code until /token consumes it.
CREATE TABLE public.mcp_oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  state text NOT NULL CHECK (char_length(state) BETWEEN 1 AND 1000),
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  code_hash text UNIQUE,
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- When the owner approved. An MFA recovery voids every approval made before it.
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  code_expires_at timestamptz
);

CREATE INDEX idx_mcp_oauth_requests_client ON public.mcp_oauth_requests (client_id);
CREATE INDEX idx_mcp_oauth_requests_approved_by ON public.mcp_oauth_requests (approved_by);

-- One approved connection: lives 30 days at most, whatever its refresh tokens say.
CREATE TABLE public.mcp_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  client_name text,
  scope text NOT NULL,
  approved_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- The approval's own time (the consent decision), not the code exchange: a recovery
  -- between the two must still void the grant.
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  absolute_expires_at timestamptz NOT NULL
);

CREATE INDEX idx_mcp_oauth_grants_client ON public.mcp_oauth_grants (client_id);
CREATE INDEX idx_mcp_oauth_grants_approved_by ON public.mcp_oauth_grants (approved_by);

-- Access tokens live ten minutes; refresh tokens rotate on every use. A rotated refresh
-- token is kept for as long as its grant lives: it is the evidence that a later replay
-- of it is a leak, which revokes the whole grant.
CREATE TABLE public.mcp_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES public.mcp_oauth_grants (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_oauth_tokens_grant ON public.mcp_oauth_tokens (grant_id);

-- ---------------------------------------------------------------------------
-- Row-level security: no permissive policy at all. Only the server reads or writes these
-- tables; the owner sees grants through mcp_list_grants().
-- ---------------------------------------------------------------------------

ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_oauth_clients_mfa_gate ON public.mcp_oauth_clients AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY mcp_oauth_requests_mfa_gate ON public.mcp_oauth_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY mcp_oauth_grants_mfa_gate ON public.mcp_oauth_grants AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY mcp_oauth_tokens_mfa_gate ON public.mcp_oauth_tokens AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

REVOKE ALL ON
  public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_grants, public.mcp_oauth_tokens
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_grants, public.mcp_oauth_tokens
TO service_role;

-- ---------------------------------------------------------------------------
-- The audit row every connector function writes
-- ---------------------------------------------------------------------------

-- details.source defaults to 'mcp' (a tool) and the OAuth functions pass 'mcp_oauth'. An
-- address that does not parse is stored as NULL rather than failing the write it records.
CREATE FUNCTION public.mcp_audit_row(p_actor uuid, p_action text, p_details jsonb, p_ip text, p_user_agent text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_ip inet;
BEGIN
  BEGIN
    v_ip := NULLIF(btrim(p_ip), '')::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;
  INSERT INTO public.audit_logs (user_id, action, details, ip_address, user_agent)
  VALUES (
    p_actor,
    p_action,
    jsonb_build_object('source', 'mcp') || COALESCE(p_details, '{}'::jsonb),
    v_ip,
    left(NULLIF(p_user_agent, ''), 300)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- OAuth
-- ---------------------------------------------------------------------------

-- The client a request names, for /authorize to check its redirect against.
CREATE FUNCTION public.mcp_oauth_client(p_client_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object('client_id', c.client_id, 'client_name', c.client_name, 'redirect_uris', to_jsonb(c.redirect_uris))
  FROM public.mcp_oauth_clients c
  WHERE c.client_id = p_client_id;
$$;

-- What the consent screen shows: a request that is still pending and unexpired, else NULL.
CREATE FUNCTION public.mcp_oauth_pending_request(p_request_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'request_id', r.request_id, 'client_name', c.client_name, 'redirect_uri', r.redirect_uri,
    'scope', r.scope, 'resource', r.resource, 'expires_at', r.expires_at)
  FROM public.mcp_oauth_requests r
  JOIN public.mcp_oauth_clients c ON c.client_id = r.client_id
  WHERE r.request_id = p_request_id AND r.status = 'pending' AND r.expires_at > now();
$$;

-- THE human gate. One statement decides a still-pending, unexpired request exactly once,
-- and the decision is audited in the same transaction. Only the owner decides; the edge
-- function has already checked the session at aal2. NULL when there is nothing to decide.
CREATE FUNCTION public.mcp_oauth_decide(
  p_request_id text, p_approve boolean, p_code_hash text, p_code_expires timestamptz,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
BEGIN
  IF p_actor IS DISTINCT FROM (SELECT o.owner_user_id FROM public.org_profile o) THEN
    RAISE EXCEPTION 'mcp_oauth_decide: actor_not_owner' USING ERRCODE = '42501';
  END IF;
  IF p_approve IS NULL OR (p_approve AND (p_code_hash IS NULL OR p_code_expires IS NULL)) THEN
    RAISE EXCEPTION 'mcp_oauth_decide: incomplete_decision';
  END IF;

  UPDATE public.mcp_oauth_requests r
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'denied' END,
         approved_by = p_actor,
         approved_at = CASE WHEN p_approve THEN now() END,
         code_hash = CASE WHEN p_approve THEN p_code_hash END,
         code_expires_at = CASE WHEN p_approve THEN p_code_expires END
   WHERE r.request_id = p_request_id AND r.status = 'pending' AND r.expires_at > now()
  RETURNING r.redirect_uri, r.state, r.client_id INTO v;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM public.mcp_audit_row(
    p_actor, CASE WHEN p_approve THEN 'mcp_oauth_approved' ELSE 'mcp_oauth_denied' END,
    jsonb_build_object('source', 'mcp_oauth', 'client_id', v.client_id), p_ip, p_user_agent);

  RETURN jsonb_build_object('redirect_uri', v.redirect_uri, 'state', v.state, 'client_id', v.client_id);
END;
$$;

-- Consume an approved code: single use, whatever happens to the rest of the exchange. A
-- code whose exchange then fails (wrong client, redirect, resource or verifier) stays
-- burned. NULL when the code is unknown, expired, or already used.
CREATE FUNCTION public.mcp_oauth_consume_code(p_code_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
BEGIN
  UPDATE public.mcp_oauth_requests r
     SET status = 'consumed'
   WHERE r.code_hash = p_code_hash AND r.status = 'approved' AND r.code_expires_at > now()
  RETURNING r.client_id, r.redirect_uri, r.code_challenge, r.scope, r.resource, r.approved_by, r.approved_at INTO v;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- An approval given before the approver's MFA recovery is void, like every session of
  -- that time. The code stays burned.
  IF EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l
              WHERE l.user_id = v.approved_by AND v.approved_at < l.revoked_before) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'client_id', v.client_id, 'redirect_uri', v.redirect_uri, 'code_challenge', v.code_challenge,
    'scope', v.scope, 'resource', v.resource, 'approved_by', v.approved_by, 'approved_at', v.approved_at);
END;
$$;

-- The grant and both first tokens, with the client's last use and the audit row, in one
-- transaction: a partial failure issues nothing the audit did not record. Refused unless
-- the approver is still the owner and no MFA recovery of theirs came after the approval
-- (one can land between the code's consumption and this call).
CREATE FUNCTION public.mcp_oauth_create_grant(
  p_client_id text, p_scope text, p_access_hash text, p_access_expires timestamptz,
  p_refresh_hash text, p_refresh_expires timestamptz, p_absolute_expires timestamptz,
  p_approved_by uuid, p_approved_at timestamptz, p_ip text, p_user_agent text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_grant_id uuid;
BEGIN
  IF p_approved_by IS DISTINCT FROM (SELECT o.owner_user_id FROM public.org_profile o) THEN
    RAISE EXCEPTION 'mcp_oauth_create_grant: approver_not_owner' USING ERRCODE = '42501';
  END IF;
  IF p_approved_at IS NULL OR EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l
                                       WHERE l.user_id = p_approved_by AND p_approved_at < l.revoked_before) THEN
    RAISE EXCEPTION 'mcp_oauth_create_grant: approval_revoked' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.mcp_oauth_grants (client_id, client_name, scope, approved_by, approved_at, absolute_expires_at)
  SELECT c.client_id, c.client_name, p_scope, p_approved_by, p_approved_at, p_absolute_expires
  FROM public.mcp_oauth_clients c
  WHERE c.client_id = p_client_id
  RETURNING id INTO v_grant_id;

  IF v_grant_id IS NULL THEN
    RAISE EXCEPTION 'mcp_oauth_create_grant: unknown_client';
  END IF;

  INSERT INTO public.mcp_oauth_tokens (grant_id, token_hash, kind, expires_at)
  VALUES (v_grant_id, p_access_hash, 'access', p_access_expires),
         (v_grant_id, p_refresh_hash, 'refresh', least(p_refresh_expires, p_absolute_expires));

  UPDATE public.mcp_oauth_clients SET last_used_at = now() WHERE client_id = p_client_id;

  PERFORM public.mcp_audit_row(
    p_approved_by, 'mcp_oauth_grant_created',
    jsonb_build_object('source', 'mcp_oauth', 'client_id', p_client_id, 'grant_id', v_grant_id),
    p_ip, p_user_agent);

  RETURN v_grant_id;
END;
$$;

-- Refresh-token rotation, as one transaction. Returns {status, scope}:
--   ok        new access and refresh tokens issued
--   replayed  an already-rotated token came back: it leaked, so the whole grant is
--             revoked (and audited)
--   invalid   unknown, expired, or its grant is revoked, expired or no longer the owner's
-- Replay is judged FIRST: a rotated token is replay evidence even past its own expiry.
-- There is no retry grace. A grace re-issue would let whoever replays a stolen token
-- within it mint working credentials, and kill the legitimate successor, without the
-- grant being revoked; a client whose response was lost connects again instead. A token
-- presented by another client is invalid (judged after replay: a rotated token is
-- evidence whoever presents it). A refresh that names no client (p_client_id NULL) is
-- allowed; rotation and replay still guard it.
CREATE FUNCTION public.mcp_oauth_rotate_refresh(
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

  SELECT g.id, g.client_id, g.scope, g.approved_by, g.approved_at, g.revoked_at, g.absolute_expires_at INTO v_grant
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

-- RFC 7009: revokes the grant behind any token of it. false for an unknown token (the
-- endpoint still answers 200); a database error raises, so it is never reported as done.
CREATE FUNCTION public.mcp_oauth_revoke_token(p_token_hash text, p_ip text, p_user_agent text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v record;
BEGIN
  SELECT g.id, g.approved_by INTO v
    FROM public.mcp_oauth_tokens t
    JOIN public.mcp_oauth_grants g ON g.id = t.grant_id
   WHERE t.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.mcp_oauth_grants SET revoked_at = now() WHERE id = v.id AND revoked_at IS NULL;
  IF FOUND THEN
    PERFORM public.mcp_audit_row(
      v.approved_by, 'mcp_oauth_revoked',
      jsonb_build_object('source', 'mcp_oauth', 'grant_id', v.id), p_ip, p_user_agent);
  END IF;
  RETURN true;
END;
$$;

-- An access token's grant and actor, or NULL. Accepted only while the token is unexpired,
-- its grant is neither revoked nor past its 30 days, and the person who approved the grant
-- is still the owner. last_used_at is stamped at most every five minutes (nothing decides
-- access on it), which spares a write on every call.
CREATE FUNCTION public.mcp_oauth_authenticate(p_access_hash text)
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

-- Bounded hygiene, run after each registration: requests a week past expiry, the tokens of
-- dead grants, and registrations that never earned a grant within a week. Tokens on a LIVE
-- grant are kept, rotated ones included: deleting a rotated token early would turn a later
-- replay of it into "invalid" instead of the revocation it should cause. A client with a
-- live request is kept, so a cleanup between /authorize and the owner's click cannot
-- delete the request mid-flow.
CREATE FUNCTION public.mcp_oauth_cleanup()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.mcp_oauth_requests
   WHERE id IN (SELECT r.id FROM public.mcp_oauth_requests r
                 WHERE r.expires_at < now() - interval '7 days' LIMIT 500);

  DELETE FROM public.mcp_oauth_tokens
   WHERE id IN (SELECT t.id FROM public.mcp_oauth_tokens t
                  JOIN public.mcp_oauth_grants g ON g.id = t.grant_id
                 WHERE g.revoked_at IS NOT NULL OR g.absolute_expires_at < now()
                 LIMIT 500);

  DELETE FROM public.mcp_oauth_clients
   WHERE id IN (SELECT c.id FROM public.mcp_oauth_clients c
                 WHERE c.created_at < now() - interval '7 days'
                   AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_grants g WHERE g.client_id = c.client_id)
                   AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_requests r
                                    WHERE r.client_id = c.client_id AND r.expires_at > now())
                 LIMIT 200);
END;
$$;

-- ---------------------------------------------------------------------------
-- The tools: what tools/list offers, and the audited reads and writes
-- ---------------------------------------------------------------------------

-- The pick-list keys the tool schemas offer, read when a client lists the tools: every
-- contact status (a search filter only; no tool sets a status), and the ACTIVE business
-- types, services, request categories and request tags. A write refuses an inactive key
-- itself, since a foreign key accepts one.
CREATE FUNCTION public.mcp_tool_vocabulary()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'statuses', COALESCE((SELECT jsonb_agg(s.key ORDER BY s.sort_order, s.key) FROM public.contact_statuses s), '[]'::jsonb),
    'organization_types', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                       FROM public.organization_types t WHERE t.is_active), '[]'::jsonb),
    'service_types', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                  FROM public.service_types t WHERE t.is_active), '[]'::jsonb),
    'request_categories', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                       FROM public.request_categories t WHERE t.is_active), '[]'::jsonb),
    'request_tags', COALESCE((SELECT jsonb_agg(t.key ORDER BY t.sort_order, t.key)
                                 FROM public.request_tags t WHERE t.is_active), '[]'::jsonb));
$$;

-- A case-insensitive substring match over the names, email and business name. position()
-- rather than LIKE, so nothing in the query is a pattern character. Newest first, id as
-- the tiebreak. Audited with the query's length and the count, never the rows.
CREATE FUNCTION public.mcp_search_contacts(
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
    WHERE (p_status IS NULL OR c.status = p_status)
      AND (v_q = ''
           OR position(v_q IN lower(c.full_name)) > 0
           OR position(v_q IN lower(COALESCE(c.email, ''))) > 0
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

-- One contact's basics, its businesses, its quotes and its 20 newest notes. The column
-- list is explicit and narrow: no spouse, address or intake columns leave the database.
-- NULL (and no audit row) when there is no such contact.
CREATE FUNCTION public.mcp_get_contact(p_contact_id uuid, p_actor uuid, p_ip text, p_user_agent text)
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

-- A new lead. The duplicate check and the insert run under one advisory lock per address,
-- so two concurrent calls for the same address cannot both create. A duplicate is an
-- address on any contact's primary list (its current one or an older one), compared
-- case-insensitively; the stored address keeps the case it was given. Every column the
-- insert names loses its DEFAULT, so the names fall back to '' here; status and source
-- are not named and take theirs ('new_lead', 'other': the connector's provenance is in
-- the audit log, not the lead source).
CREATE FUNCTION public.mcp_create_contact(p_patch jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_email text := p_patch ->> 'email';
  v_dup uuid;
  v_row record;
BEGIN
  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'mcp_create_contact: email_required';
  END IF;

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

  INSERT INTO public.contacts (first_name, last_name, phone, business_name, email)
  VALUES (
    COALESCE(p_patch ->> 'first_name', ''),
    COALESCE(p_patch ->> 'last_name', ''),
    p_patch ->> 'phone',
    p_patch ->> 'business_name',
    v_email)
  RETURNING id, first_name, last_name, email, status INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_create_contact',
    jsonb_build_object('contact_id', v_row.id,
      'fields', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) AS k)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'created', 'id', v_row.id, 'first_name', v_row.first_name,
                            'last_name', v_row.last_name, 'email', v_row.email, 'status', v_row.status);
END;
$$;

-- The four base fields only; a key left out keeps its value. NULL when there is no such
-- contact. Addresses never change here (see mcp_correct_contact_email).
CREATE FUNCTION public.mcp_update_contact(p_contact_id uuid, p_patch jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  UPDATE public.contacts SET
    first_name    = COALESCE(p_patch ->> 'first_name', first_name),
    last_name     = COALESCE(p_patch ->> 'last_name', last_name),
    phone         = COALESCE(p_patch ->> 'phone', phone),
    business_name = COALESCE(p_patch ->> 'business_name', business_name)
  WHERE id = p_contact_id
  RETURNING id, first_name, last_name, email, status INTO v_row;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_update_contact',
    jsonb_build_object('contact_id', p_contact_id,
      'fields', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) AS k)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'last_name', v_row.last_name,
                            'email', v_row.email, 'status', v_row.status);
END;
$$;

CREATE FUNCTION public.mcp_correct_contact_email(
  p_contact_id uuid, p_email text, p_expected_current_email text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old text;
  v_row record;
BEGIN
  -- Lock first, then check: without the lock, the portal check below and the UPDATE are a
  -- window an invitation accepted in between could slip through.
  SELECT c.email INTO v_old
    FROM public.contacts c
   WHERE c.id = p_contact_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- A portal account of ANY status. Never narrow this to 'active' (see the comment below).
  IF EXISTS (SELECT 1 FROM public.client_portal_accounts a WHERE a.contact_id = p_contact_id) THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_correct_contact_email',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'has_portal_account'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'has_portal_account');
  END IF;

  -- ONE expression for both operands: case-, whitespace- and NULL-tolerant.
  IF lower(regexp_replace(COALESCE(v_old, ''), '\s', '', 'g'))
     IS DISTINCT FROM
     lower(regexp_replace(COALESCE(p_expected_current_email, ''), '\s', '', 'g')) THEN
    PERFORM public.mcp_audit_row(p_actor, 'mcp_correct_contact_email',
      jsonb_build_object('contact_id', p_contact_id, 'outcome', 'stale'), p_ip, p_user_agent);
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;

  UPDATE public.contacts
     SET email = p_email
   WHERE id = p_contact_id
  RETURNING id, first_name, last_name, email, status INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_correct_contact_email',
    jsonb_build_object('contact_id', p_contact_id, 'had_previous', v_old IS NOT NULL),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('outcome', 'updated', 'id', v_row.id, 'first_name', v_row.first_name,
                            'last_name', v_row.last_name, 'email', v_row.email, 'status', v_row.status);
END;
$$;

COMMENT ON FUNCTION public.mcp_correct_contact_email(uuid, text, text, uuid, text, text) IS
'The one audited path by which the connector may change public.contacts.email.

Refusals, returned as a bounded `outcome` string rather than raised:
  not_found           no such contact
  has_portal_account  the contact holds a client_portal_accounts row of ANY status. Do
                      NOT narrow this to ''active'': an ''invited'' row has an invitation
                      in flight, and a ''deactivated'' row can be reactivated onto whatever
                      this column then holds. Adding that condition looks like an obvious
                      tightening and is the one change that would break the guard. An
                      address that blocks a real portal sign-in is fixed by the owner in
                      the CRM.
  stale               p_expected_current_email did not match what is stored.

SELECT ... FOR UPDATE is load-bearing: without the row lock the portal check and the
UPDATE are a window, and an invitation accepted in between would leave a contact whose
portal account routes to an address this function just changed.

The compare-and-swap on p_expected_current_email forces the caller to have READ the
contact, so a write built on a stale read fails loudly. NULL matches NULL. Both sides go
through one expression (whitespace removed, lowercased): a caller-side trim and a
database-side one disagree about which characters are whitespace, which once made a
tab-padded address impossible to correct.

Uniqueness of the address across contacts is deliberately NOT enforced: two contacts may
share an address (a household). Creating a contact refuses a duplicate address; this
asymmetry is chosen.

The old address is not destroyed: the contacts-to-contact_emails sync demotes it to
is_default = false on the contact''s email list. The audit row records that a correction
happened, never the addresses.';

-- A business (organization) on a contact: a registry entry, status left to its default.
CREATE FUNCTION public.mcp_add_business(
  p_contact_id uuid, p_name text, p_organization_type text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RAISE EXCEPTION 'mcp_add_business: not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_types t WHERE t.key = p_organization_type AND t.is_active) THEN
    RAISE EXCEPTION 'mcp_add_business: inactive_type';
  END IF;

  INSERT INTO public.organizations (contact_id, name, organization_type)
  VALUES (p_contact_id, p_name, p_organization_type)
  RETURNING id, name, organization_type, status INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_add_business',
    jsonb_build_object('contact_id', p_contact_id, 'organization_id', v_row.id),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'name', v_row.name,
                            'organization_type', v_row.organization_type, 'status', v_row.status);
END;
$$;

-- Append-only, like every note: there is no tool that edits or deletes one.
CREATE FUNCTION public.mcp_log_call_note(
  p_contact_id uuid, p_body text, p_kind text, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RAISE EXCEPTION 'mcp_log_call_note: not_found';
  END IF;

  INSERT INTO public.contact_notes (contact_id, body, kind, source)
  VALUES (p_contact_id, p_body, p_kind, 'mcp')
  RETURNING id, kind, created_at INTO v_row;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_log_call_note',
    jsonb_build_object('contact_id', p_contact_id, 'note_id', v_row.id, 'kind', p_kind),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'created_at', v_row.created_at);
END;
$$;

-- A PROPOSED quote, on the contact or on one of its businesses. An ACCEPTED quote is never
-- touched: accepting is the owner's act in the CRM, and it is what moves the revenue
-- figures. The refusal binds the write because the row is locked (FOR UPDATE) before it
-- is read. On a first insert there is nothing to lock: two concurrent inserts meet at the
-- table's unique key and the loser fails. An inactive service is refused here, since the
-- foreign key would accept it.
CREATE FUNCTION public.mcp_upsert_quote(
  p_contact_id uuid, p_organization_id uuid, p_service_type text, p_cadence text, p_amount numeric,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_current record;
  v_row record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RAISE EXCEPTION 'mcp_upsert_quote: not_found';
  END IF;
  IF p_organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id AND o.contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'mcp_upsert_quote: organization_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_types t WHERE t.key = p_service_type AND t.is_active) THEN
    RAISE EXCEPTION 'mcp_upsert_quote: inactive_service';
  END IF;

  SELECT s.id, s.state INTO v_current
    FROM public.contact_services s
   WHERE s.contact_id = p_contact_id
     AND s.service_type = p_service_type
     AND s.organization_id IS NOT DISTINCT FROM p_organization_id
     FOR UPDATE;

  IF FOUND AND v_current.state = 'accepted' THEN
    RAISE EXCEPTION 'mcp_upsert_quote: accepted_quote';
  END IF;

  IF FOUND THEN
    UPDATE public.contact_services
       SET state = 'proposed', cadence = p_cadence, amount = p_amount
     WHERE id = v_current.id
    RETURNING id, service_type, state, cadence, amount, organization_id INTO v_row;
  ELSE
    INSERT INTO public.contact_services (contact_id, organization_id, service_type, state, cadence, amount)
    VALUES (p_contact_id, p_organization_id, p_service_type, 'proposed', p_cadence, p_amount)
    RETURNING id, service_type, state, cadence, amount, organization_id INTO v_row;
  END IF;

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_upsert_quote',
    jsonb_build_object('contact_id', p_contact_id, 'quote_id', v_row.id, 'service_type', p_service_type),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'service_type', v_row.service_type, 'state', v_row.state,
                            'cadence', v_row.cadence, 'amount', v_row.amount,
                            'organization_id', v_row.organization_id);
END;
$$;

CREATE FUNCTION public.mcp_delete_quote(
  p_contact_id uuid, p_quote_id uuid, p_organization_id uuid, p_service_type text,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT s.id, s.contact_id, s.organization_id, s.service_type, s.state, s.cadence, s.amount
    INTO v_row
    FROM public.contact_services s
   WHERE s.id = p_quote_id
     FOR UPDATE;

  -- IS DISTINCT FROM, never <>. A plain inequality against a NULL parameter is NULL, an IF
  -- fires only on TRUE, and the refusal would be skipped: a caller passing no contact
  -- would delete any proposed quote by id. contact_id is NOT NULL on the row but the
  -- PARAMETER is not, which is where the hole would be. organization_id is genuinely
  -- nullable (NULL means the quote sits on the contact itself), so IS DISTINCT FROM is the
  -- only correct comparison there in any case.
  --
  -- ONE sentinel for every mismatch, so a caller cannot learn from the error that some
  -- other contact or business holds that id.
  IF NOT FOUND OR v_row.contact_id IS DISTINCT FROM p_contact_id THEN
    RAISE EXCEPTION 'mcp_delete_quote: not_found';
  END IF;

  -- Content binding, and the reason the tool takes a business and a service at all. The
  -- id alone proves nothing about WHEN the row was read: a quote edited between the
  -- read-back and the confirmation would be deleted as though it were still the row the
  -- user approved. Both halves of the row's identity are checked, because the unique key
  -- is (contact_id, organization_id, service_type) and the CRM moves a quote along both:
  -- binding the service alone would let a quote approved for deletion on one business be
  -- moved to another and then deleted there.
  --
  -- The AMOUNT is deliberately NOT bound: it is nullable, and a required figure would make
  -- a quote with no amount undeletable here. A repriced quote is still the quote the user
  -- meant to drop; a re-serviced or re-pointed one is a different quote.
  IF v_row.service_type IS DISTINCT FROM p_service_type
     OR v_row.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'mcp_delete_quote: not_found';
  END IF;

  IF v_row.state = 'accepted' THEN
    RAISE EXCEPTION 'mcp_delete_quote: accepted_quote';
  END IF;

  DELETE FROM public.contact_services WHERE id = v_row.id;

  -- In the same transaction: the audit row is the only surviving record of the deleted
  -- figures, so it commits with the delete or not at all.
  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_delete_quote',
    jsonb_build_object('contact_id', p_contact_id, 'quote_id', v_row.id, 'service_type', v_row.service_type,
                       'state', v_row.state, 'cadence', v_row.cadence, 'amount', v_row.amount,
                       'organization_id', v_row.organization_id),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_row.id, 'service_type', v_row.service_type, 'state', v_row.state,
                            'cadence', v_row.cadence, 'amount', v_row.amount,
                            'organization_id', v_row.organization_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- The request tools (wave 6b). Depend on 0005_requests: needs_lists, needs_items,
-- needs_item_documents, the request pick-lists, needs_replace_draft and needs_delete_draft.
--
-- What the connector may do with a request, and what it may not:
--   * It writes DRAFTS only. A draft is invisible to the client (the client reads every
--     status but draft), so nothing a model composes reaches a client unreviewed. No
--     function here takes a status or sets sent_at; publishing is send-needs-list's.
--   * Every item write goes through needs_replace_draft, the requests domain's one draft
--     writer, which locks the list before its status check: an edit racing a send either
--     lands on the draft or is refused, never rewrites a sent request's items.
--   * An outward act (send, remind) needs a review token: an HMAC over the request's exact
--     client-visible content, its recipient and each item's fulfilment, minted only from
--     what mcp_request_snapshot returns (mcp-crm/review-token.ts). The minter and the
--     verifier read through that one function, so they cannot compute fulfilment
--     differently.
--   * Answers never leave the database here: answer_text and answer_ciphertext are read
--     only to compute a fulfilled flag.
-- ---------------------------------------------------------------------------

-- A contact's requests as a client sees them, newest first (id as the tiebreak): the
-- recipient, each list's client-visible fields and content version, and each item's
-- content with a fulfilled flag. Fulfilment is needs_list_progress's rule, item by item
-- (src/__tests__/db/mcp.test.ts holds the two equal). p_list_id narrows to one list of
-- that contact; a list of another contact reads as no list. NULL when there is no such
-- contact. Not audited: list_requests audits through mcp_list_requests, and the outward
-- tools read through here to verify a token, recording the act itself.
CREATE FUNCTION public.mcp_request_snapshot(p_contact_id uuid, p_list_id uuid, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(COALESCE(p_limit, 25), 1), 100);
  v_contact jsonb;
  v_lists jsonb;
  v_found integer;
BEGIN
  SELECT jsonb_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email)
    INTO v_contact
    FROM public.contacts c
   WHERE c.id = p_contact_id;
  IF v_contact IS NULL THEN
    RETURN NULL;
  END IF;

  -- One more than the limit is read, only to learn whether more exist: a silent cap would
  -- let a model call 25 requests "all of them".
  SELECT count(*)::integer,
         COALESCE(jsonb_agg(m.obj ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.n <= v_limit), '[]'::jsonb)
    INTO v_found, v_lists
    FROM (
      SELECT l.id, l.created_at,
             row_number() OVER (ORDER BY l.created_at DESC, l.id DESC) AS n,
             jsonb_build_object(
               'id', l.id, 'status', l.status, 'title', l.title, 'intro_message', l.intro_message,
               'include_contact_confirm', l.include_contact_confirm, 'created_at', l.created_at,
               'sent_at', l.sent_at, 'content_version', l.content_version,
               'items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'sort_order', i.sort_order, 'kind', i.kind, 'label', i.label,
                          'description', i.description, 'required', i.required, 'sensitive', i.sensitive,
                          'category', i.category, 'tag', i.tag,
                          'fulfilled', CASE i.kind
                            WHEN 'document' THEN EXISTS (SELECT 1 FROM public.needs_item_documents d WHERE d.item_id = i.id)
                            WHEN 'todo' THEN i.status IN ('fulfilled', 'reviewed')
                            WHEN 'question' THEN i.answer_ciphertext IS NOT NULL
                                                 OR (i.answer_text IS NOT NULL AND i.answer_text ~ '[^[:space:]]')
                            ELSE false
                          END)
                        ORDER BY i.sort_order, i.id)
                   FROM public.needs_items i
                  WHERE i.list_id = l.id), '[]'::jsonb)) AS obj
        FROM public.needs_lists l
       WHERE l.contact_id = p_contact_id
         AND (p_list_id IS NULL OR l.id = p_list_id)
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT v_limit + 1
    ) m;

  RETURN jsonb_build_object('contact', v_contact, 'lists', v_lists, 'truncated', v_found > v_limit);
END;
$$;

-- list_requests: the snapshot, audited in the same transaction with the contact, the
-- count and whether it was cut short. NULL (and no audit row) when there is no contact.
CREATE FUNCTION public.mcp_list_requests(p_contact_id uuid, p_limit integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_out jsonb := public.mcp_request_snapshot(p_contact_id, NULL, p_limit);
BEGIN
  IF v_out IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_list_requests',
    jsonb_build_object('contact_id', p_contact_id, 'returned', jsonb_array_length(v_out -> 'lists'),
                       'truncated', v_out -> 'truncated'),
    p_ip, p_user_agent);
  RETURN v_out;
END;
$$;

-- Every item's category and tag (absent means general) must be an ACTIVE key: the foreign
-- keys accept an inactive one, and tools/list offers only the active ones.
CREATE FUNCTION public.mcp_request_keys_active(p_items jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- CASE, not AND: jsonb_to_recordset raises on anything but an array, and AND does not
  -- promise to evaluate its left side first. Not an array (or NULL) is false, never NULL.
  SELECT CASE WHEN jsonb_typeof(p_items) = 'array' THEN NOT EXISTS (
           SELECT 1
             FROM jsonb_to_recordset(p_items) AS x(category text, tag text)
            WHERE NOT EXISTS (SELECT 1 FROM public.request_categories k WHERE k.key = COALESCE(x.category, 'general') AND k.is_active)
               OR NOT EXISTS (SELECT 1 FROM public.request_tags k WHERE k.key = COALESCE(x.tag, 'general') AND k.is_active))
         ELSE false END;
$$;

-- A new DRAFT request, its items and the audit row in one transaction. The status is
-- written as 'draft' and never taken from the caller; there is no sent_at.
CREATE FUNCTION public.mcp_create_request(
  p_contact_id uuid, p_title text, p_intro text, p_items jsonb, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id) THEN
    RAISE EXCEPTION 'mcp_create_request: not_found';
  END IF;
  IF NOT public.mcp_request_keys_active(p_items) THEN
    RAISE EXCEPTION 'mcp_create_request: inactive_key';
  END IF;

  INSERT INTO public.needs_lists (contact_id, title, intro_message, status, created_by)
  VALUES (p_contact_id, p_title, p_intro, 'draft', p_actor)
  RETURNING id INTO v_id;

  v_count := public.needs_replace_draft(v_id, p_title, p_items, p_intro, p_contact_id);

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_create_request',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', v_id, 'item_count', v_count,
                       'sensitive_item_count', (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(sensitive boolean) WHERE x.sensitive)),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('id', v_id, 'title', p_title, 'status', 'draft', 'item_count', v_count);
END;
$$;

-- A FULL replacement of a draft's title, intro and items, audited in the same
-- transaction. needs_replace_draft's sentinels (not_found, not_draft) pass through. The
-- contact-confirm switch is not the connector's to set and keeps its value.
CREATE FUNCTION public.mcp_update_request(
  p_list_id uuid, p_contact_id uuid, p_title text, p_intro text, p_items jsonb,
  p_actor uuid, p_ip text, p_user_agent text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.mcp_request_keys_active(p_items) THEN
    RAISE EXCEPTION 'mcp_update_request: inactive_key';
  END IF;

  v_count := public.needs_replace_draft(p_list_id, p_title, p_items, p_intro, p_contact_id);

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_update_request',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id, 'item_count', v_count,
                       'sensitive_item_count', (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(sensitive boolean) WHERE x.sensitive)),
    p_ip, p_user_agent);

  RETURN v_count;
END;
$$;

-- Delete a DRAFT at the content version its review token was verified over.
-- needs_delete_draft does the work (lock, status, version, the refusals on client data,
-- its own needs_list_deleted row); this adds the connector's row in the same
-- transaction, so the delete commits with both records or not at all. Its sentinels
-- (not_found, not_draft, stale_content, has_answers, has_documents) pass through.
CREATE FUNCTION public.mcp_delete_request(
  p_list_id uuid, p_contact_id uuid, p_expected_version integer, p_actor uuid, p_ip text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_ip inet;
  v_items integer;
BEGIN
  BEGIN
    v_ip := NULLIF(btrim(p_ip), '')::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;
  -- Counted before the lock below; any edit after this moves the version, and the delete
  -- then refuses as stale_content, so a delete that commits counted the reviewed items.
  SELECT count(*)::integer INTO v_items FROM public.needs_items i WHERE i.list_id = p_list_id;

  PERFORM public.needs_delete_draft(p_list_id, p_contact_id, p_expected_version, p_actor, v_ip, p_user_agent);

  PERFORM public.mcp_audit_row(
    p_actor, 'mcp_delete_request',
    jsonb_build_object('contact_id', p_contact_id, 'list_id', p_list_id, 'item_count', v_items,
                       'content_version', p_expected_version),
    p_ip, p_user_agent);

  RETURN jsonb_build_object('list_id', p_list_id, 'item_count', v_items);
END;
$$;

-- The connector's reminder interval: at most one reminder a day per request, claimed with
-- one guarded write so two concurrent calls cannot both pass a read-then-send check. A
-- review token binds content, not a count, so without this one token would license a
-- reminder on every call. A claim whose email then fails still holds the day; the owner's
-- own reminder in the CRM is not bound by it. false: not this contact's sent request, or
-- reminded within the last day.
CREATE FUNCTION public.mcp_claim_reminder(p_list_id uuid, p_contact_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.needs_lists l
     SET last_reminded_at = now()
   WHERE l.id = p_list_id
     AND l.contact_id = p_contact_id
     AND l.status = 'sent'
     AND (l.last_reminded_at IS NULL OR l.last_reminded_at < now() - interval '24 hours');
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- The owner's view of connections (Settings, AI connector)
-- ---------------------------------------------------------------------------

-- Live grants only: neither revoked nor past their 30 days. No token, hash or request data.
CREATE FUNCTION public.mcp_list_grants()
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
      AND NOT EXISTS (SELECT 1 FROM public.mfa_recovery_lockouts l WHERE l.user_id = g.approved_by AND g.approved_at < l.revoked_before)), '[]'::jsonb);
END;
$$;

-- Disconnect one assistant now. Its access token dies at once (authentication checks the
-- grant on every call) and its refresh tokens can never rotate again. false when the grant
-- was already revoked or does not exist.
CREATE FUNCTION public.mcp_revoke_grant(p_grant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'mcp_revoke_grant: owner only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.mcp_oauth_grants SET revoked_at = now()
   WHERE id = p_grant_id AND revoked_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (auth.uid(), 'mcp_oauth_revoked', jsonb_build_object('source', 'owner', 'grant_id', v_id));
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: this file's functions only, never a sweep.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.mcp_audit_row(uuid, text, jsonb, text, text),
  public.mcp_oauth_client(text),
  public.mcp_oauth_pending_request(text),
  public.mcp_oauth_decide(text, boolean, text, timestamptz, uuid, text, text),
  public.mcp_oauth_consume_code(text),
  public.mcp_oauth_create_grant(text, text, text, timestamptz, text, timestamptz, timestamptz, uuid, timestamptz, text, text),
  public.mcp_oauth_rotate_refresh(text, text, text, timestamptz, text, timestamptz, text, text),
  public.mcp_oauth_revoke_token(text, text, text),
  public.mcp_oauth_authenticate(text),
  public.mcp_oauth_cleanup(),
  public.mcp_tool_vocabulary(),
  public.mcp_search_contacts(text, text, integer, uuid, text, text),
  public.mcp_get_contact(uuid, uuid, text, text),
  public.mcp_create_contact(jsonb, uuid, text, text),
  public.mcp_update_contact(uuid, jsonb, uuid, text, text),
  public.mcp_correct_contact_email(uuid, text, text, uuid, text, text),
  public.mcp_add_business(uuid, text, text, uuid, text, text),
  public.mcp_log_call_note(uuid, text, text, uuid, text, text),
  public.mcp_upsert_quote(uuid, uuid, text, text, numeric, uuid, text, text),
  public.mcp_delete_quote(uuid, uuid, uuid, text, uuid, text, text),
  public.mcp_request_snapshot(uuid, uuid, integer),
  public.mcp_list_requests(uuid, integer, uuid, text, text),
  public.mcp_request_keys_active(jsonb),
  public.mcp_create_request(uuid, text, text, jsonb, uuid, text, text),
  public.mcp_update_request(uuid, uuid, text, text, jsonb, uuid, text, text),
  public.mcp_delete_request(uuid, uuid, integer, uuid, text, text),
  public.mcp_claim_reminder(uuid, uuid),
  public.mcp_list_grants(),
  public.mcp_revoke_grant(uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- The server's RPCs (the mcp-oauth and mcp-crm edge functions).
GRANT EXECUTE ON FUNCTION
  public.mcp_audit_row(uuid, text, jsonb, text, text),
  public.mcp_oauth_client(text),
  public.mcp_oauth_pending_request(text),
  public.mcp_oauth_decide(text, boolean, text, timestamptz, uuid, text, text),
  public.mcp_oauth_consume_code(text),
  public.mcp_oauth_create_grant(text, text, text, timestamptz, text, timestamptz, timestamptz, uuid, timestamptz, text, text),
  public.mcp_oauth_rotate_refresh(text, text, text, timestamptz, text, timestamptz, text, text),
  public.mcp_oauth_revoke_token(text, text, text),
  public.mcp_oauth_authenticate(text),
  public.mcp_oauth_cleanup(),
  public.mcp_tool_vocabulary(),
  public.mcp_search_contacts(text, text, integer, uuid, text, text),
  public.mcp_get_contact(uuid, uuid, text, text),
  public.mcp_create_contact(jsonb, uuid, text, text),
  public.mcp_update_contact(uuid, jsonb, uuid, text, text),
  public.mcp_correct_contact_email(uuid, text, text, uuid, text, text),
  public.mcp_add_business(uuid, text, text, uuid, text, text),
  public.mcp_log_call_note(uuid, text, text, uuid, text, text),
  public.mcp_upsert_quote(uuid, uuid, text, text, numeric, uuid, text, text),
  public.mcp_delete_quote(uuid, uuid, uuid, text, uuid, text, text),
  public.mcp_request_snapshot(uuid, uuid, integer),
  public.mcp_list_requests(uuid, integer, uuid, text, text),
  public.mcp_request_keys_active(jsonb),
  public.mcp_create_request(uuid, text, text, jsonb, uuid, text, text),
  public.mcp_update_request(uuid, uuid, text, text, jsonb, uuid, text, text),
  public.mcp_delete_request(uuid, uuid, integer, uuid, text, text),
  public.mcp_claim_reminder(uuid, uuid)
TO service_role;

-- The owner's two (each refuses anyone else itself).
GRANT EXECUTE ON FUNCTION public.mcp_list_grants(), public.mcp_revoke_grant(uuid) TO authenticated;
