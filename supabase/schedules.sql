-- Open CRM's schedules: what runs on its own, and when (UTC). Not a migration: a fresh
-- project has no pg_cron, and the tick needs the project's URL and the cron secret, which
-- no file in this repo holds. `npm run schedules:install` stores those two in Vault and
-- applies this file; run it after `db push`, `secrets set` and `functions deploy`, and
-- again after any change to CRON_SHARED_SECRET. Safe to re-run: cron.schedule replaces a
-- job of the same name.
--
-- Rules (src/features/ops/__tests__/schedules.test.ts checks each):
--   - Every job is named open-crm-*, so the installer can list and remove exactly these.
--   - The tick reads the URL and the secret from Vault when it RUNS. A secret written into
--     the command would sit in plain text in cron.job and in every run's history row.
--     A missing value raises, so the run is recorded as failed instead of posting a
--     request that is refused while cron reports success.
--   - Every net.http_post states its timeout (pg_net's default is a few seconds).
--   - Background work is a public.jobs row the tick runs (kinds:
--     supabase/functions/job-runner/kinds.ts). Each daily enqueue adds a row only when
--     none of that kind is waiting or running, so after an outage the queue holds one
--     digest, not one per missed day sent all at once.
--   - A direct SQL line calls a function that exists in the migrations (as the role that
--     installed it, which owns them).

CREATE EXTENSION IF NOT EXISTS pg_cron;
-- pg_net cannot be moved once created, so it goes straight into `extensions`.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- The tick: every minute, run whatever is due in public.jobs.
SELECT cron.schedule('open-crm-job-runner', '* * * * *', $job$
DO $tick$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_shared_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE EXCEPTION 'project_url or cron_shared_secret is missing from Vault; run npm run schedules:install';
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/job-runner',
    headers := jsonb_build_object('x-cron-secret', v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
END
$tick$;
$job$);

-- Retention (ops:maintenance): aged jobs, rate-limit rows, CSP reports, dev outbox, audit rows,
-- portal activity, client messages read more than 7 days ago, and board cards left in a done
-- stage long enough to archive.
SELECT cron.schedule('open-crm-maintenance', '45 3 * * *', $job$
INSERT INTO public.jobs (provider, action)
SELECT 'ops', 'maintenance'
WHERE NOT EXISTS (SELECT 1 FROM public.jobs
                  WHERE provider = 'ops' AND action = 'maintenance' AND status IN ('pending', 'running'));
$job$);

-- Expire e-signature envelopes past their deadline.
SELECT cron.schedule('open-crm-esign-expire', '0 9 * * *', $job$
INSERT INTO public.jobs (provider, action)
SELECT 'esign', 'expire_envelopes'
WHERE NOT EXISTS (SELECT 1 FROM public.jobs
                  WHERE provider = 'esign' AND action = 'expire_envelopes' AND status IN ('pending', 'running'));
$job$);

-- The portal's daily digest to clients.
SELECT cron.schedule('open-crm-portal-digest', '30 12 * * *', $job$
INSERT INTO public.jobs (provider, action)
SELECT 'portal', 'daily_digest'
WHERE NOT EXISTS (SELECT 1 FROM public.jobs
                  WHERE provider = 'portal' AND action = 'daily_digest' AND status IN ('pending', 'running'));
$job$);

-- Reminders for open requests.
SELECT cron.schedule('open-crm-needs-reminders', '0 14 * * *', $job$
INSERT INTO public.jobs (provider, action)
SELECT 'needs', 'reminder_dispatch'
WHERE NOT EXISTS (SELECT 1 FROM public.jobs
                  WHERE provider = 'needs' AND action = 'reminder_dispatch' AND status IN ('pending', 'running'));
$job$);

-- Close any View-as-client session left open more than eight hours, and revoke its sign-in.
SELECT cron.schedule('open-crm-impersonation-sweep', '0 * * * *', $job$
SELECT public.auto_end_stale_impersonation_sessions();
$job$);

-- The tick alone writes about 1,440 run-history rows a day; keep a week of them.
SELECT cron.schedule('open-crm-cron-history', '55 3 * * *', $job$
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
$job$);
