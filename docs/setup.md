# Setup

From a fresh clone to a running install on your own Supabase project. The free plan is
enough. Nothing here runs in Docker and nothing needs a local Supabase stack: the database,
Auth, Storage and the edge functions all run in your project.

You need Node 22 and a Supabase account.

## 1. Create the project and link it

Create a project at [supabase.com](https://supabase.com) and note its reference (the
`<ref>` in `https://<ref>.supabase.co`). Then:

```bash
npm ci
npx supabase login
npx supabase link --project-ref <your-project-ref>
```

`npm ci` installs the Supabase CLI as a dev dependency, so `npx supabase` needs no global
install.

## 2. Create the tables

```bash
npx supabase db push
```

This applies the migrations in `supabase/migrations/` in order (`0001_core` to `0012_portal`).
See [architecture.md](architecture.md#migrations) for what each one holds.

## 3. Apply the Auth settings

```bash
npx supabase config push
```

This applies the `[auth]` settings in `supabase/config.toml`: public sign-up off, the password
rules, authenticator-app two-factor on, a password change that needs a recent sign-in or an
emailed code, and the site URL. The file ships with `http://127.0.0.1:5173` and localhost
redirect entries for development. **Before pushing to a project people will use**, set
`site_url` to your site and replace the localhost entries in `additional_redirect_urls` with
`<your site>/reset-password` and `<your site>/settings/security` (or `<your site>/**`).

## 4. Run the bootstrap

```bash
npm run dev:bootstrap
```

It asks for the project URL, the anon key and the service role key (Project Settings, API),
your organization's name, and the owner's email and password. You can pass them instead:
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in the environment, and
`-- --org-name "Example Co" --email you@example.com --password '...'` (add `--yes` to fail
rather than ask). It then:

1. Checks the values: an https project URL (or a local http one), keys without spaces, an anon
   key that is not the service role key, and a password that meets the Auth rules (at least
   eight characters, at most 72 bytes, with a lower-case letter, an upper-case letter, a digit
   and a symbol). Nothing is written if any check fails.
2. Writes the edge-function secrets into `supabase/functions/.env` (created with owner-only file permissions):
   `DOCUMENT_ENCRYPTION_KEY`, `PII_ENCRYPTION_KEY`, `CRON_SHARED_SECRET`,
   `ESIGN_INTERNAL_TOKEN` and `ESIGN_SMS_CODE_KEY`, each from a secure
   random source. Only missing ones are added; an existing value is never changed, because a
   changed encryption key makes everything encrypted under the old one unreadable.
3. Writes `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` into `.env.local`, again only if
   missing.
4. Creates the owner's Auth account (email already confirmed), and a system actor
   (`system-actor@open-crm.invalid`, an address nobody can receive mail at) that stands in as
   the actor on audit rows written by scheduled jobs and webhooks. The system actor gets a
   random password nobody keeps and is banned from signing in for a century.
5. Writes the `org_profile` row: your organization's name, the owner and the system actor.

It is safe to run again: a recorded owner is reused, and nothing that exists is changed. It
refuses, changing nothing, when the install already has an owner with a different email, or
when an Auth account already holds the owner's email without being recorded as the owner
(run again with `--adopt-existing` if you made it, for instance in an earlier run that stopped
part-way; that sets its password to the one given). The service role key is used for that run
only and never saved.

## 5. Set your own secrets

Add to `supabase/functions/.env`:

```bash
SITE_URL=http://localhost:5173
```

Every emailed link (portal invitations, requests, e-signature) is built on `SITE_URL`, so
without it those sends are refused. Use your real address once you deploy the frontend.

Add an email provider when you want real email (`RESEND_API_KEY`, `EMAIL_FROM`), and Twilio for
e-sign text message codes. Until then, with `ENVIRONMENT` unset, every message is written to
the dev outbox (System, Outbox) so each flow can be tried. The full list is in
[configuration.md](configuration.md).

## 6. Deploy the edge functions

```bash
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy --use-api
```

`--use-api` has Supabase bundle the functions, so no Docker is needed. Which functions skip
Supabase's JWT check (they authenticate callers themselves) is set per function in
`supabase/config.toml`, and the deploy applies it.

## 7. Install the schedules

```bash
npm run schedules:install
```

This stores the project URL and `CRON_SHARED_SECRET` in Supabase Vault, applies
`supabase/schedules.sql` (a tick every minute that runs the job queue, plus daily jobs for
clean-up, envelope expiry, the portal digest and request reminders), then fires one real test
tick and waits up to 150 seconds for it to answer 200. Run it again whenever
`CRON_SHARED_SECRET` changes. `-- --no-wait` skips the test tick; `-- --remove` unschedules
everything and deletes the two Vault secrets. The README's Schedules section has the details,
including how to do this from the SQL editor.

## 8. Sign in and turn on two-factor

```bash
npm run dev
```

Open http://localhost:5173 and sign in as the owner. Then, first:

1. Settings, Security: **Turn on two-factor** with an authenticator app, and keep the backup
   codes it shows somewhere safe. From then on every owner session needs the code, and the
   database refuses owner data to a session without it.
2. Settings, Identity: your organization's name, legal name, email sender name, postal address, contact email (optional, shown on the e-signature consent and error pages), brand colour and logo.
3. Messages: choose the encryption password and keep the recovery key. Losing both makes
   client messages unreadable for good.

## 9. Optional: demo data

```bash
npm run demo:seed
```

Loads fictional contacts, businesses, quotes, board cards, messages, a draft and a sent request
and a draft e-sign envelope (`supabase/seed/demo.sql`) through `npx supabase db query --linked`.
It creates no sign-in accounts and is safe to run twice. It refuses a project that already has
contacts of its own; `npm run demo:seed -- --force` loads it anyway.

Without the CLI link, paste the whole of `supabase/seed/demo.sql` into the Supabase SQL editor
and run it (for the forced load, put
`SELECT set_config('open_crm.demo_seed_force', 'on', false);` on the first line). The file's
header shows how to remove the demo rows again.

## 10. Deploy the frontend

The app is a static site. Build it with the two `VITE_` variables in `.env.local` (and
`VITE_SITE_URL` if you use the AI connector):

```bash
npm run build
```

and serve `dist/` from any static host. The host must:

- serve `index.html` for every path it has no file for (an SPA fallback), so links like
  `/sign`, `/invite`, `/start` and `/unsubscribe` open;
- serve over HTTPS;
- send `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`);
- for the AI connector, serve `dist/.well-known/oauth-authorization-server` as
  `application/json`.

Then point the backend at it:

```bash
npx supabase secrets set SITE_URL=https://crm.example.com ENVIRONMENT=production
npx supabase functions deploy --use-api
```

`ENVIRONMENT=production` stops the functions accepting `http://localhost:5173` and stops the
dev outbox standing in for email and text messages. Finally:

- update `site_url` and the redirect URLs (step 3) for the real address and `config push` again;
- set up custom SMTP for Supabase Auth (Authentication, Emails in the dashboard): password
  resets and password-change codes go through it, and the built-in sender allows only a few
  emails an hour;
- decide how you back up the database and the storage buckets (see [SECURITY.md](../SECURITY.md)).
