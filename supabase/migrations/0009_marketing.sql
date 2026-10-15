-- 0009_marketing: the marketing page's own data.
--
-- Belongs here: monthly goals and ad spend, from which the page derives cost per lead
-- and cost per acquisition. Revenue groups by service_types and leads count by
-- lead_sources, both seeded in 0002; never a hardcoded list.
--
-- Depends on: 0001_core (is_owner, mfa_session_ok, set_updated_at). The page also reads
-- 0002_contacts (contacts, contact_services, contact_upsells and the pick-lists), but no
-- object here refers to them.
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

-- ---------------------------------------------------------------------------
-- Monthly goals and ad spend
-- ---------------------------------------------------------------------------

-- One row per calendar month ('YYYY-MM', the key every screen groups months by). The name
-- says goals, but the row also holds that month's ad spend, the figure cost per lead and
-- cost per acquisition divide. Spend is one amount per month with no channel on it.
--
-- A NULL target means "no target set" and 0 is a target of zero: the marketing table
-- draws the two differently ("7" against "7 / 0"), so the targets carry no default and a
-- spend-only row leaves them NULL. Spend has nothing to tell apart, so it defaults to 0.
CREATE TABLE public.monthly_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL UNIQUE CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  new_leads_target smallint CHECK (new_leads_target IS NULL OR new_leads_target >= 0),
  closed_clients_target smallint CHECK (closed_clients_target IS NULL OR closed_clients_target >= 0),
  ad_spend numeric(15, 2) NOT NULL DEFAULT 0 CHECK (ad_spend >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_monthly_goals_updated_at
  BEFORE UPDATE ON public.monthly_goals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.monthly_goals ENABLE ROW LEVEL SECURITY;

-- The owner's alone. No client reads or writes a goal, so the table needs no
-- View-as-client trigger: a client session matches no policy here.
CREATE POLICY monthly_goals_owner_all ON public.monthly_goals
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY monthly_goals_mfa_gate ON public.monthly_goals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.monthly_goals FROM PUBLIC, anon, authenticated, service_role;

-- The server: row access only, no TRUNCATE (it skips RLS and row triggers).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.monthly_goals TO service_role;

-- Signed-in sessions: a month is created once and never renamed (every screen keys on
-- it), so it is insert-only. No DELETE: no screen removes a month, and an emptied month
-- is a row with NULL targets and zero spend.
GRANT SELECT,
  INSERT (month, new_leads_target, closed_clients_target, ad_spend),
  UPDATE (new_leads_target, closed_clients_target, ad_spend)
ON public.monthly_goals TO authenticated;
