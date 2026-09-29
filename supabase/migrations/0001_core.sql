-- 0001_core: the principals, MFA, rate limits, audit log, settings, background jobs,
-- the dev outbox and CSP reports. Every later migration depends on this one.
--
-- Principals, each defined once:
--   owner        the single staff account: org_profile.owner_user_id, at aal2 when it
--                has a verified MFA factor, on a token issued after any MFA recovery.
--   system actor a dedicated auth.users row (org_profile.system_user_id) that stands in
--                as the audit actor for cron jobs, webhooks and other paths with no JWT.
--   client       a portal user bound to a contact (defined with contacts, in 0002).
--   service_role the server key used by edge functions; bypasses RLS.
--
-- Conventions: RLS on every table; access is REVOKEd from every API role (anon,
-- authenticated and service_role) and then GRANTed per table, never inherited from
-- Supabase's default privileges; every function pins
-- `search_path = ''` and schema-qualifies what it touches; EXECUTE is revoked from
-- PUBLIC and granted per function.

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- org_profile: the one identity row (who runs this deployment)
-- ---------------------------------------------------------------------------

CREATE TABLE public.org_profile (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  legal_name text CHECK (legal_name IS NULL OR length(legal_name) <= 200),
  sender_name text CHECK (sender_name IS NULL OR length(sender_name) <= 120),
  postal_address text CHECK (postal_address IS NULL OR length(postal_address) <= 500),
  logo_path text CHECK (logo_path IS NULL OR length(logo_path) <= 500),
  brand jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(brand) = 'object'),
  owner_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  system_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_user_id IS DISTINCT FROM system_user_id OR owner_user_id IS NULL)
);

COMMENT ON TABLE public.org_profile IS
  'Exactly one row. Non-secret identity used by the UI, emails, PDFs and consent copy, plus the owner and system-actor user ids. Written by the bootstrap script and the owner.';

CREATE TRIGGER trg_org_profile_updated_at
  BEFORE UPDATE ON public.org_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- MFA session state
-- ---------------------------------------------------------------------------

CREATE TABLE public.mfa_recovery_lockouts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revoked_before timestamptz NOT NULL
);

CREATE FUNCTION public.user_has_verified_mfa()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors f
    WHERE f.user_id = auth.uid() AND f.status = 'verified'
  );
$$;

-- True when the caller's session is acceptable: at aal2 if the user has a verified
-- factor, and issued after any MFA recovery lockout for that user. A token with no
-- usable issued-at proves nothing about when it was issued, so a lockout denies it.
CREATE FUNCTION public.mfa_session_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT
    (NOT public.user_has_verified_mfa()
     OR COALESCE(auth.jwt() ->> 'aal', '') = 'aal2')
    AND NOT EXISTS (
      SELECT 1 FROM public.mfa_recovery_lockouts l
      WHERE l.user_id = auth.uid()
        AND (CASE WHEN COALESCE(auth.jwt() ->> 'iat', '') ~ '^[0-9]+$'
                  THEN to_timestamp((auth.jwt() ->> 'iat')::bigint)
                  ELSE '-infinity'::timestamptz END) < l.revoked_before
    );
$$;

-- The edge-function twin of mfa_session_ok, for a user id and claims the function
-- has already verified.
CREATE FUNCTION public.mfa_guard_denied(p_user_id uuid, p_aal text, p_iat bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT
    (EXISTS (SELECT 1 FROM auth.mfa_factors f
             WHERE f.user_id = p_user_id AND f.status = 'verified')
     AND COALESCE(p_aal, '') <> 'aal2')
    OR EXISTS (
      SELECT 1 FROM public.mfa_recovery_lockouts l
      WHERE l.user_id = p_user_id
        AND COALESCE(to_timestamp(p_iat), '-infinity'::timestamptz) < l.revoked_before
    );
$$;

-- ---------------------------------------------------------------------------
-- Principals
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    auth.uid() IS NOT NULL
      AND auth.uid() = (SELECT o.owner_user_id FROM public.org_profile o),
    false
  )
  AND public.mfa_session_ok();
$$;

-- The actor recorded on audit rows: the signed-in user, else the system actor.
CREATE FUNCTION public.audit_actor()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(auth.uid(), (SELECT o.system_user_id FROM public.org_profile o));
$$;

-- Display fields only, for pages that render before or without an owner session
-- (sign-in, the signer flow). Never the user ids.
CREATE FUNCTION public.get_org_branding()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'display_name', o.display_name,
    'logo_path', o.logo_path,
    'brand', o.brand
  )
  FROM public.org_profile o;
$$;

ALTER TABLE public.org_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_profile_owner_select ON public.org_profile
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY org_profile_owner_update ON public.org_profile
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

-- The owner may edit identity fields, never who the owner or system actor is. Those
-- change only through the bootstrap script (service role).
CREATE FUNCTION public.org_profile_guard_principals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.system_user_id IS DISTINCT FROM OLD.system_user_id)
     AND NOT (SELECT r.rolsuper OR r.rolbypassrls
                FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'owner_user_id and system_user_id are not editable here'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_profile_guard_principals
  BEFORE UPDATE ON public.org_profile
  FOR EACH ROW EXECUTE FUNCTION public.org_profile_guard_principals();

-- True for the owner and for the server. The server test is positive (rolsuper or
-- rolbypassrls: service_role and postgres), so an unknown role fails closed. Triggers
-- that bound what a client may write use this to let those two through.
CREATE FUNCTION public.is_owner_or_server()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT r.rolsuper OR r.rolbypassrls
                     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
         OR public.is_owner();
$$;

-- Blocks a caller other than the owner or the server from changing the listed columns.
-- The column list is the trigger's arguments and must include `id`.
CREATE FUNCTION public.enforce_client_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  col text;
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  changed text := NULL;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (old_json -> col) IS DISTINCT FROM (new_json -> col) THEN
      changed := col;
      EXIT;
    END IF;
  END LOOP;

  IF changed IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_owner_or_server() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Column %.% is not client-writable', TG_TABLE_NAME, changed
    USING ERRCODE = '42501';
END;
$$;

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user_created ON public.audit_logs (user_id, created_at DESC);
CREATE INDEX idx_audit_logs_created ON public.audit_logs (created_at DESC);

CREATE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- The one sanctioned escape: a retention job that runs
  -- SET LOCAL app.allow_audit_maintenance = 'on'.
  IF current_setting('app.allow_audit_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();

-- TRUNCATE fires neither RLS nor row triggers, so it needs its own statement trigger.
CREATE TRIGGER trg_audit_logs_no_truncate
  BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_audit_log_mutation();

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_owner_select ON public.audit_logs
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY audit_logs_owner_insert ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_owner()) AND user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- MFA backup codes
-- ---------------------------------------------------------------------------

CREATE SEQUENCE public.mfa_backup_code_generation_seq;

CREATE TABLE public.mfa_backup_code_generations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.mfa_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  batch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reserved', 'used', 'revoked')),
  generation bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reserved_at timestamptz,
  alert_sent_at timestamptz,
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX idx_mfa_backup_codes_user ON public.mfa_backup_codes (user_id, status);

CREATE FUNCTION public.mfa_backup_code_next_generation()
RETURNS bigint
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT nextval('public.mfa_backup_code_generation_seq');
$$;

CREATE FUNCTION public.mfa_verified_factor_ids(p_user_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT COALESCE(array_agg(f.id), ARRAY[]::uuid[])
  FROM auth.mfa_factors f
  WHERE f.user_id = p_user_id AND f.status = 'verified';
$$;

CREATE FUNCTION public.mfa_backup_codes_replace(
  p_user_id uuid, p_hashes text[], p_batch uuid, p_generation bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_count integer;
  v_current bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));

  -- Never destroy an in-flight recovery's reservation.
  IF EXISTS (SELECT 1 FROM public.mfa_backup_codes
             WHERE user_id = p_user_id AND status = 'reserved') THEN
    RAISE EXCEPTION 'mfa_backup_codes_replace: recovery_in_flight';
  END IF;

  -- Recovery codes for an account with no second factor are a standing credential
  -- nobody asked for. Checked here, under the lock.
  IF NOT EXISTS (SELECT 1 FROM auth.mfa_factors f
                 WHERE f.user_id = p_user_id AND f.status = 'verified') THEN
    RAISE EXCEPTION 'mfa_backup_codes_replace: no_verified_factor';
  END IF;

  INSERT INTO public.mfa_backup_code_generations (user_id, generation)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT g.generation INTO v_current
    FROM public.mfa_backup_code_generations g
    WHERE g.user_id = p_user_id
    FOR UPDATE;

  IF p_generation IS NULL OR p_generation <= v_current THEN
    RAISE EXCEPTION 'mfa_backup_codes_replace: stale_generation';
  END IF;

  DELETE FROM public.mfa_backup_codes WHERE user_id = p_user_id;
  INSERT INTO public.mfa_backup_codes (user_id, code_hash, batch_id, generation)
  SELECT p_user_id, h, p_batch, p_generation FROM unnest(p_hashes) AS h;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.mfa_backup_code_generations
    SET generation = p_generation, updated_at = now()
    WHERE user_id = p_user_id;

  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (p_user_id, 'mfa_backup_codes_generated',
          jsonb_build_object('batch_id', p_batch, 'count', v_count,
                             'generation', p_generation));
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.mfa_backup_codes_revoke(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));
  -- A reserved row belongs to an in-flight recovery; it ends through finalize.
  DELETE FROM public.mfa_backup_codes
    WHERE user_id = p_user_id AND status <> 'reserved';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (p_user_id, 'mfa_backup_codes_revoked', jsonb_build_object('count', v_count));
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.mfa_backup_code_claim(p_user_id uuid, p_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_row public.mfa_backup_codes%ROWTYPE;
  v_has_factor boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));

  SELECT EXISTS (SELECT 1 FROM auth.mfa_factors f
                 WHERE f.user_id = p_user_id AND f.status = 'verified')
    INTO v_has_factor;

  -- Lease-expire a crashed request's unalerted reservation (10 minutes).
  UPDATE public.mfa_backup_codes
    SET status = CASE WHEN v_has_factor THEN 'active' ELSE 'revoked' END,
        reserved_at = NULL
    WHERE user_id = p_user_id AND status = 'reserved'
      AND alert_sent_at IS NULL
      AND reserved_at < now() - interval '10 minutes';

  -- An alerted reservation gets a longer lease (60 minutes) so a failed post-alert
  -- step cannot wedge issuance. alert_sent_at stays set so the saga does not re-alert.
  UPDATE public.mfa_backup_codes
    SET status = CASE WHEN v_has_factor THEN 'active' ELSE 'revoked' END,
        reserved_at = NULL
    WHERE user_id = p_user_id AND status = 'reserved'
      AND alert_sent_at IS NOT NULL
      AND reserved_at < now() - interval '60 minutes';

  SELECT * INTO v_row
    FROM public.mfa_backup_codes
    WHERE user_id = p_user_id AND code_hash = p_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'none');
  END IF;

  IF v_row.status = 'active' THEN
    -- Never start a recovery when there is no second factor to remove.
    IF NOT v_has_factor THEN
      RETURN jsonb_build_object('state', 'none');
    END IF;
    UPDATE public.mfa_backup_codes
      SET status = 'reserved', reserved_at = now()
      WHERE id = v_row.id;
    RETURN jsonb_build_object('state', 'claimed', 'id', v_row.id,
                              'alerted', v_row.alert_sent_at IS NOT NULL);
  END IF;

  IF v_row.status = 'reserved' THEN
    -- Resume stays reachable with no factor: the saga deletes the factor midway.
    IF v_row.alert_sent_at IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'resume', 'id', v_row.id, 'alerted', true);
    END IF;
    RETURN jsonb_build_object('state', 'in_flight');
  END IF;

  RETURN jsonb_build_object('state', 'none');
END;
$$;

CREATE FUNCTION public.mfa_backup_code_release(p_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));
  UPDATE public.mfa_backup_codes
    SET status = CASE WHEN EXISTS (SELECT 1 FROM auth.mfa_factors f
                                   WHERE f.user_id = p_user_id AND f.status = 'verified')
                      THEN 'active' ELSE 'revoked' END,
        reserved_at = NULL
    WHERE id = p_id AND user_id = p_user_id
      AND status = 'reserved' AND alert_sent_at IS NULL;
END;
$$;

CREATE FUNCTION public.mfa_backup_code_finalize(
  p_id uuid, p_user_id uuid, p_ip text, p_user_agent text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
  v_ip inet;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));
  BEGIN
    v_ip := NULLIF(p_ip, '')::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  UPDATE public.mfa_backup_codes
    SET status = 'used', used_at = now()
    WHERE id = p_id AND user_id = p_user_id AND status = 'reserved';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'mfa_backup_code_finalize: not_reserved';
  END IF;

  UPDATE public.mfa_backup_codes
    SET status = 'revoked'
    WHERE user_id = p_user_id AND status IN ('active', 'reserved') AND id <> p_id;

  INSERT INTO public.mfa_recovery_lockouts (user_id, revoked_before)
  VALUES (p_user_id, date_trunc('second', clock_timestamp()) + interval '1 second')
  ON CONFLICT (user_id) DO UPDATE
    SET revoked_before = GREATEST(public.mfa_recovery_lockouts.revoked_before, EXCLUDED.revoked_before);

  INSERT INTO public.audit_logs (user_id, action, details, ip_address, user_agent)
  VALUES (p_user_id, 'mfa_recovery_used', jsonb_build_object('code_id', p_id),
          v_ip, NULLIF(p_user_agent, ''));
END;
$$;

CREATE FUNCTION public.mfa_recovery_lockout_stamp(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || p_user_id::text));
  INSERT INTO public.mfa_recovery_lockouts (user_id, revoked_before)
  VALUES (p_user_id, date_trunc('second', clock_timestamp()) + interval '1 second')
  ON CONFLICT (user_id) DO UPDATE
    SET revoked_before = GREATEST(public.mfa_recovery_lockouts.revoked_before, EXCLUDED.revoked_before);
END;
$$;

-- When a user's last verified factor goes, their unused backup codes go with it.
CREATE FUNCTION public.revoke_backup_codes_on_factor_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || OLD.user_id::text));
  IF OLD.status = 'verified' AND NOT EXISTS (
    SELECT 1 FROM auth.mfa_factors f
    WHERE f.user_id = OLD.user_id AND f.status = 'verified' AND f.id <> OLD.id
  ) THEN
    UPDATE public.mfa_backup_codes
      SET status = 'revoked'
      WHERE user_id = OLD.user_id AND status = 'active';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_revoke_backup_codes_on_factor_delete
  AFTER DELETE ON auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION public.revoke_backup_codes_on_factor_delete();

-- These three tables are service-role only. RLS is on with no permissive policy, so
-- a user session sees nothing even if a grant is added by mistake.
ALTER TABLE public.mfa_recovery_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_backup_code_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------

CREATE TABLE public.auth_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  ip_address inet,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_rate_limits_action_ip_created
  ON public.auth_rate_limits (action, ip_address, created_at DESC);
CREATE INDEX idx_auth_rate_limits_action_user_created
  ON public.auth_rate_limits (action, user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_auth_rate_limits_user ON public.auth_rate_limits (user_id);

ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_rate_limits_owner_select ON public.auth_rate_limits
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

-- Each returns the new count, or NULL when the limit is reached, and raises on a
-- missing or non-positive limit or window rather than allowing everything. Count-then-insert is
-- serialized per bucket with an advisory lock.

-- A NULL, blank or uncastable IP is bucketed under the 0.0.0.0/0 sentinel, never
-- exempted: an unparseable address must not switch its own limit off.
CREATE FUNCTION public.check_auth_ip_rate_limit(
  p_action text, p_ip text, p_max_count integer, p_window_minutes integer,
  p_user_agent text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_unusable_ip CONSTANT inet := '0.0.0.0/0'::inet;
  v_ip inet;
  v_current_count integer;
BEGIN
  IF p_max_count IS NULL OR p_max_count < 1 OR p_window_minutes IS NULL OR p_window_minutes < 1 THEN
    RAISE EXCEPTION 'rate limit needs a positive max count and window';
  END IF;

  IF p_ip IS NULL OR btrim(p_ip) = '' THEN
    v_ip := c_unusable_ip;
  ELSE
    BEGIN
      v_ip := p_ip::inet;
    EXCEPTION WHEN invalid_text_representation THEN
      v_ip := c_unusable_ip;
    END;
  END IF;

  -- Keyed on v_ip::text, not host(v_ip): host() renders the sentinel and a literal
  -- 0.0.0.0 identically.
  PERFORM pg_advisory_xact_lock(hashtext(p_action || ':' || v_ip::text));

  SELECT count(*) INTO v_current_count
  FROM public.auth_rate_limits
  WHERE action = p_action
    AND ip_address = v_ip
    AND created_at >= now() - (p_window_minutes * interval '1 minute');

  IF v_current_count >= p_max_count THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.auth_rate_limits (action, ip_address, user_agent)
  VALUES (p_action, v_ip, p_user_agent);
  RETURN v_current_count + 1;
END;
$$;

CREATE FUNCTION public.check_auth_global_rate_limit(
  p_action text, p_max_count integer, p_window_minutes integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_count integer;
BEGIN
  IF p_max_count IS NULL OR p_max_count < 1 OR p_window_minutes IS NULL OR p_window_minutes < 1 THEN
    RAISE EXCEPTION 'rate limit needs a positive max count and window';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('global:' || p_action));

  SELECT count(*) INTO v_current_count
  FROM public.auth_rate_limits
  WHERE action = p_action
    AND ip_address IS NULL
    AND user_id IS NULL
    AND created_at >= now() - (p_window_minutes * interval '1 minute');

  IF v_current_count >= p_max_count THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.auth_rate_limits (action) VALUES (p_action);
  RETURN v_current_count + 1;
END;
$$;

-- Every caller passes a user id it has already verified. A NULL id is refused, not
-- allowed through.
CREATE FUNCTION public.check_auth_user_rate_limit(
  p_action text, p_user_id uuid, p_max_count integer, p_window_minutes integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_count integer;
BEGIN
  IF p_max_count IS NULL OR p_max_count < 1 OR p_window_minutes IS NULL OR p_window_minutes < 1 THEN
    RAISE EXCEPTION 'rate limit needs a positive max count and window';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_action || ':' || p_user_id::text));

  SELECT count(*) INTO v_current_count
  FROM public.auth_rate_limits
  WHERE action = p_action
    AND user_id = p_user_id
    AND created_at >= now() - (p_window_minutes * interval '1 minute');

  IF v_current_count >= p_max_count THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.auth_rate_limits (action, user_id) VALUES (p_action, p_user_id);
  RETURN v_current_count + 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Owner settings (key/value blobs edited in the admin settings pages)
-- ---------------------------------------------------------------------------

CREATE TABLE public.app_settings (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value jsonb NOT NULL
    CHECK (jsonb_typeof(value) = 'object')
    CHECK (pg_column_size(value) < 65536),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_settings_owner_all ON public.app_settings
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

-- ---------------------------------------------------------------------------
-- Background jobs (claimed by the job-runner edge function)
-- ---------------------------------------------------------------------------

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  claimed_until timestamptz,
  claim_token uuid,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_due ON public.jobs (scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_jobs_running ON public.jobs (claimed_until) WHERE status = 'running';
CREATE INDEX idx_jobs_status_created ON public.jobs (status, created_at DESC);

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_owner_select ON public.jobs
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

-- Each claim gets a fresh claim_token. complete_job and fail_job act only when the
-- caller presents the token of the live claim, so a worker whose lease expired and
-- was reclaimed cannot report an outcome for the new claim.
--
-- A lease that expired on the final permitted attempt is marked dead here, because a
-- worker that disappeared never calls fail_job.
CREATE FUNCTION public.claim_next_jobs(p_limit integer DEFAULT 10, p_claim_seconds integer DEFAULT 300)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be in (0, 100]';
  END IF;
  IF p_claim_seconds IS NULL OR p_claim_seconds <= 0 THEN
    RAISE EXCEPTION 'p_claim_seconds must be positive';
  END IF;

  UPDATE public.jobs
  SET status = 'dead',
      finished_at = v_now,
      claimed_until = NULL,
      claim_token = NULL,
      last_error = COALESCE(last_error, 'lease expired on the final attempt')
  WHERE status = 'running'
    AND claimed_until < v_now
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT j.id
    FROM public.jobs j
    WHERE (j.status = 'pending' AND j.scheduled_at <= v_now)
       OR (j.status = 'running' AND j.claimed_until < v_now AND j.attempts < j.max_attempts)
    ORDER BY j.scheduled_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE public.jobs j
    SET status = 'running',
        started_at = v_now,
        claimed_until = v_now + make_interval(secs => p_claim_seconds),
        claim_token = gen_random_uuid(),
        attempts = j.attempts + 1
    FROM due
    WHERE j.id = due.id
    RETURNING j.*
  )
  SELECT to_jsonb(upd) FROM upd;
END;
$$;

-- Returns true when the outcome was recorded, false when the claim is no longer live.
CREATE FUNCTION public.complete_job(p_job_id uuid, p_claim_token uuid, p_result jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.jobs
  SET status = 'success',
      finished_at = clock_timestamp(),
      claimed_until = NULL,
      claim_token = NULL,
      result = p_result,
      last_error = NULL
  WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fail_job(p_job_id uuid, p_claim_token uuid, p_error text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.jobs%ROWTYPE;
  v_backoff_sec integer;
  v_next_status text;
BEGIN
  SELECT * INTO v_row FROM public.jobs
  WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_not_live');
  END IF;

  IF v_row.attempts >= v_row.max_attempts THEN
    v_next_status := 'dead';
    v_backoff_sec := 0;
  ELSE
    v_next_status := 'pending';
    -- 60s, 120s, 240s, ... capped at an hour.
    v_backoff_sec := LEAST(60 * power(2, v_row.attempts)::integer, 3600);
  END IF;

  UPDATE public.jobs
  SET status = v_next_status,
      finished_at = CASE WHEN v_next_status = 'dead' THEN clock_timestamp() END,
      claimed_until = NULL,
      claim_token = NULL,
      scheduled_at = CASE WHEN v_next_status = 'pending'
                          THEN clock_timestamp() + make_interval(secs => v_backoff_sec)
                          ELSE scheduled_at END,
      last_error = p_error
  WHERE id = p_job_id;

  RETURN jsonb_build_object('ok', true, 'status', v_next_status,
                            'backoff_sec', v_backoff_sec, 'attempts', v_row.attempts);
END;
$$;

CREATE FUNCTION public.retry_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.jobs
  SET status = 'pending', attempts = 0, scheduled_at = clock_timestamp(),
      started_at = NULL, finished_at = NULL, claimed_until = NULL, claim_token = NULL,
      last_error = NULL
  WHERE id = p_job_id AND status IN ('failed', 'dead');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not retryable (must be failed or dead)', p_job_id;
  END IF;
END;
$$;

CREATE FUNCTION public.get_job_status_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE status = 'pending'),
      'running', count(*) FILTER (WHERE status = 'running'),
      'success', count(*) FILTER (WHERE status = 'success'),
      'failed', count(*) FILTER (WHERE status = 'failed'),
      'dead', count(*) FILTER (WHERE status = 'dead'),
      'all', count(*))
    FROM public.jobs);
END;
$$;

-- ---------------------------------------------------------------------------
-- Dev outbox: where the local email/SMS adapter delivers when no provider key is set
-- ---------------------------------------------------------------------------

CREATE TABLE public.dev_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL,
  subject text,
  body_text text,
  body_html text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dev_outbox_created ON public.dev_outbox (created_at DESC);

ALTER TABLE public.dev_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY dev_outbox_owner_select ON public.dev_outbox
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

-- ---------------------------------------------------------------------------
-- CSP violation reports (written by the csp-report edge function)
-- ---------------------------------------------------------------------------

CREATE TABLE public.csp_violation_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  document_url text,
  referrer text,
  violated_directive text,
  effective_directive text,
  blocked_url text,
  source_file text,
  line_number integer,
  column_number integer,
  disposition text,
  status_code integer,
  user_agent text,
  ip_address text,
  raw jsonb NOT NULL
);

CREATE INDEX idx_csp_reports_received_at ON public.csp_violation_reports (received_at DESC);

ALTER TABLE public.csp_violation_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY csp_reports_owner_select ON public.csp_violation_reports
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

-- A second, independent MFA gate on every table: whatever a permissive policy above
-- says, a session that fails mfa_session_ok() reads and writes nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_profile', 'mfa_recovery_lockouts', 'mfa_backup_code_generations', 'mfa_backup_codes',
    'audit_logs', 'auth_rate_limits', 'app_settings', 'jobs', 'dev_outbox', 'csp_violation_reports'
  ] LOOP
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

-- Tables: nothing inherited, service_role included (Supabase's default privileges grant
-- it ALL, TRUNCATE on audit_logs among them). service_role gets full access (audit_logs
-- without TRUNCATE); user sessions get only what a policy above can use.
REVOKE ALL ON
  public.org_profile, public.mfa_recovery_lockouts, public.mfa_backup_code_generations,
  public.mfa_backup_codes, public.audit_logs, public.auth_rate_limits, public.app_settings,
  public.jobs, public.dev_outbox, public.csp_violation_reports
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_logs TO service_role;
GRANT ALL ON
  public.org_profile, public.mfa_recovery_lockouts, public.mfa_backup_code_generations,
  public.mfa_backup_codes, public.auth_rate_limits, public.app_settings,
  public.jobs, public.dev_outbox, public.csp_violation_reports
TO service_role;

GRANT SELECT, UPDATE ON public.org_profile TO authenticated;
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT SELECT ON public.auth_rate_limits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT SELECT ON public.jobs TO authenticated;
GRANT SELECT ON public.dev_outbox TO authenticated;
GRANT SELECT ON public.csp_violation_reports TO authenticated;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.mfa_backup_code_generation_seq TO service_role;

-- Functions: revoke from everyone, then grant per function.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

-- Called inside RLS policies and triggers that run as the session role.
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mfa_session_ok() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_verified_mfa() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_actor() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner_or_server() TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_profile_guard_principals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;
-- Owner actions (each checks is_owner itself).
GRANT EXECUTE ON FUNCTION public.retry_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_status_counts() TO authenticated;
-- Public display fields.
GRANT EXECUTE ON FUNCTION public.get_org_branding() TO anon, authenticated;
