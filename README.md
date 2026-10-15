# Open CRM

A self-hosted CRM and client-workflow suite for a single business, built on React and
Supabase. One owner runs it; clients get a secure portal.

> **Status: early.** This repository is being extracted, piece by piece, from a CRM that has
> run a real client practice in production. The contacts and pipeline, the client portal,
> documents, secure messages, the work board, group email, marketing, the AI connector,
> settings and the system pages are here and tested. Requests and e-signature are next: their
> pages are placeholders for now.

## What it is for

- **Contacts and pipeline**: contacts, businesses they own, notes, follow-ups, service quotes.
- **Client portal**: invitations, a client home, profile.
- **Documents**: upload, preview, annotate and share, encrypted at rest.
- **Secure messages**: secure messages between the owner and each client: a client's message is
  end-to-end encrypted in their browser to the owner's key, and the owner's replies are stored as
  plain text (not end-to-end encrypted). Messages are deleted 7 days after they are read.
- **Requests**: send a client a list of documents and questions, with reminders.
- **E-signature**: place fields, send, sign, and verify an executed PDF against tampering.
- **Work board**: a Kanban board of work items with configurable stages.
- **Group email**: email a chosen group of contacts, with an unsubscribe link in every message.
- **Marketing**: leads and won clients by month and by source, revenue goals and ad spend.
- **Lead intake**: a keyed endpoint another system posts new leads to.
- **MCP connector**: an OAuth-protected MCP server so an AI assistant can work the CRM.
- **Control center**: names, branding, lead sources, services and other pick-lists are data the
  owner edits, not code.

## What is in the repository today

| Piece | State |
| --- | --- |
| Project setup (Vite, React, TypeScript, Tailwind, shadcn/ui) | Done |
| Core database schema: owner and system principals, MFA session gating and backup codes, rate limits, append-only audit log, settings, background jobs, dev outbox | Done, tested |
| Contacts and pipeline: contacts, the businesses they own, emails, notes, relationships, follow-ups, quotes, the pipeline board, a safe contact delete | Done, tested |
| Local setup script and sign-in (password, the authenticator code when one is set up, or a backup code) | Done, tested |
| Client portal: invitations, home, profile with password and two-factor, View as client, the daily digest | Done, tested |
| Documents: folders, upload with a check of the file's bytes, preview, annotation, encryption at rest | Done, tested |
| Secure messages | Done, tested |
| Work board | Done, tested |
| Group email and unsubscribe | Done, tested |
| Marketing | Done, tested |
| AI connector (OAuth server and MCP server) | Done, tested |
| Control center: identity and branding, pick-lists, lead intake, security, appearance | Done, tested |
| System pages (audit log, jobs, outbox), schedules, Content-Security-Policy reporting | Done, tested |
| Requests and e-signature | Being ported (placeholder pages) |

## Security model

- Row-level security on every table, with explicit grants rather than inherited defaults.
- The owner is resolved from a single identity row plus an MFA session check. A role claim in
  a token grants nothing on its own.
- An owner with MFA enrolled is only the owner at the second factor, and only on a token
  issued after any recovery lockout.
- A client is a portal account bound to one contact. It reads its own record through narrow
  functions and can change only what the portal lets it (completing a task, for instance);
  everything else is the owner's.
- Every table also carries a second, independent MFA check, so a policy that forgets one
  still cannot be reached from a session that has not passed its second factor.
- Rate limits fail closed. The audit log cannot be updated, deleted or truncated. The
  anonymous role can reach no table at all.

## Running it

You need Node 22 and a Supabase project; the free plan is enough, and nothing runs in Docker.
Create the project at [supabase.com](https://supabase.com), then from a fresh clone:

```bash
npm ci
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
npx supabase config push
npm run dev:bootstrap
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy --use-api
npm run schedules:install
npm run dev
```

`db push` creates the tables. `config push` applies the sign-in settings in
`supabase/config.toml`: public sign-up off, the password rules, authenticator apps on, and the
site URL `http://127.0.0.1:5173`. `dev:bootstrap` asks for the project URL and the anon and
service role keys (Project Settings > API), your organization's name, and the owner's email and
password. It writes `.env.local` and the edge-function secrets, creates the owner account, and
is safe to run again; the service role key is used for that run only and never saved.
`secrets set` hands the generated secrets to your project's edge functions, and
`functions deploy --use-api` deploys them (bundled by Supabase, so no Docker), and
`schedules:install` turns on the background work (see Schedules below). Then open
http://localhost:5173 and sign in as the owner.

The edge functions accept browser requests from http://localhost:5173 while `ENVIRONMENT` is
unset. When you serve the app from a real address, set `SITE_URL` to it and `ENVIRONMENT`
to `production` with `npx supabase secrets set`, and redeploy. A live project needs both.

### Sign-in, passwords and two-factor

- Add your reset and email-change pages to Auth's redirect allow-list (Authentication, URL
  Configuration, Redirect URLs): `<your site>/reset-password` and `<your site>/settings/security`,
  or `<your site>/**` for both. `supabase/config.toml` already allows the local addresses.
  The localhost entries are for local development only and must not be pushed to a live
  project: before `config push` to a live project, put your site's addresses in
  `additional_redirect_urls` instead.
- A password change needs a recent sign-in or a one-time code that Auth emails
  (`secure_password_change` in `supabase/config.toml`). Production therefore needs an email
  provider for Auth (custom SMTP in the dashboard) or nobody can change a password.
- Password resets (the owner's and every client's) and that code are sent by Supabase Auth's
  own mailer until you set up custom SMTP. Its built-in sender allows only a few emails an
  hour across the whole project, so set up SMTP before clients start using the portal.
- Two-factor backup codes: a backup code turns two-factor off and signs out every session, and
  an email about it goes to the account and to the owner, so MFA recovery needs an email
  provider in production (see Email below).
- Backup codes are stored only as a keyed hash derived from the service role key. Rotating the
  service role key (or moving to a new key format) invalidates every outstanding code: make new
  ones in Settings, Security afterwards, and ask clients who use two-factor to do the same.

### Client portal

- Invitations are emailed through the email provider (see Email). Without one, and with
  `ENVIRONMENT` not `production`, they land in the dev outbox (System, Outbox). When an
  invitation is not sent, the contact's Portal panel shows its link for the owner to copy.
- During View as client, and for one hour after it ends, the client being viewed cannot change
  their password or email or add a two-factor factor. That hour is the life of a sign-in token
  issued before the view ended, so nothing the owner could have done in the view outlives it.
- A client is signed out of the portal after 30 minutes without activity.

### Lead intake

Lead intake is server to server only. Make a key in Settings, Lead intake, and have the sending
system (a form tool, a lead seller, a script) post JSON to
`https://<your-project-ref>.supabase.co/functions/v1/lead-intake` with the key in an
`x-api-key` header, as `Authorization: Bearer <key>`, or as a bare `Authorization` value. Never
put the key in a web page: anyone who reads the page could then post leads. A replaced or
removed key keeps working, and a new one stays refused, for up to a minute.

### Messages

The encryption password and the recovery key are chosen on the owner's first visit to
Messages. Keep the recovery key somewhere safe: losing both the password and the recovery key
makes every client message unreadable for good, and nobody can recover them.

### Email

Group email sends through Resend. Set these with `npx supabase secrets set` (or in
`supabase/functions/.env` before `secrets set --env-file`):

- `SITE_URL` is required for group email: every email carries an unsubscribe link built on
  it, so without it a send is refused (503, `site_url_missing`).
- `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain verified in Resend) turn on real
  email. Without them, and with `ENVIRONMENT` not `production`, messages are written to the
  dev outbox instead (System > Outbox).
- `EMAIL_REPLY_TO` is optional: where replies go.

The unsubscribe link opens `/unsubscribe` on your site, which needs no sign-in. A static host
must serve `index.html` for that path (an SPA fallback), as it does for every other route.

### AI connector

The connector lets an AI assistant (Claude, ChatGPT) work the CRM through MCP, with the owner
approving each connection at the second factor. Settings, AI connector shows the address to
add. It needs:

- `SITE_URL` set (with `npx supabase secrets set`) to the site's public address, reachable from
  the internet: the assistant's provider opens it to sign in.
- The site to serve `/.well-known/oauth-authorization-server` as JSON. `npm run build` writes
  `dist/.well-known/oauth-authorization-server` when `VITE_SITE_URL` (the same address as
  `SITE_URL`) and `VITE_SUPABASE_URL` are set in `.env.local`; the file has no extension, so
  have the static host send it with `Content-Type: application/json`.
- The host that serves the app to send `Content-Security-Policy: frame-ancestors 'none'` (or
  `X-Frame-Options: DENY`), so the approval screen can never be framed by another site.

### Content-Security-Policy reports

To see what your Content-Security-Policy blocks, have the host that serves the app send these
response headers (a `<meta>` policy cannot report), with your project's URL:

```
Content-Security-Policy: <your policy>; report-uri https://<your-project-ref>.supabase.co/functions/v1/csp-report; report-to csp-endpoint
Reporting-Endpoints: csp-endpoint="https://<your-project-ref>.supabase.co/functions/v1/csp-report"
```

The `csp-report` function drops every report until `SITE_URL` names the site. It stores at
most 500 reports an hour across everyone and keeps them 30 days, in the
`csp_violation_reports` table.

## Schedules

Background work (reminders, digests, expiring signature requests, clean-up of old records)
runs from a queue that one scheduled tick works through every minute. The schedules live in
`supabase/schedules.sql`, not in a migration, because they need your project's URL and the
cron secret. Install them after the rest of the setup, in this order:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy --use-api
npm run schedules:install
```

`schedules:install` stores the project URL and `CRON_SHARED_SECRET` in Supabase Vault (as
`project_url` and `cron_shared_secret`), applies `supabase/schedules.sql`, then fires one real
test tick and waits up to 150 seconds for it to answer, so a secret that does not match the
functions' shows up now rather than as silent failures later. The test tick is a real tick:
whatever jobs are due run. `npm run schedules:install -- --no-wait` skips it.

- Run it again whenever `CRON_SHARED_SECRET` changes.
- `npm run schedules:install -- --remove` unschedules every `open-crm-*` job and also deletes
  the two Vault secrets.
- If an install fails after the secret was sent, rotate `CRON_SHARED_SECRET` (put a new value
  in `supabase/functions/.env`, run `secrets set --env-file` again, then the installer): the
  failing statement, secret included, can end up in the project's database logs.
- Without the Supabase CLI, open the SQL editor, create the two secrets with
  `select vault.create_secret('https://<your-project-ref>.supabase.co', 'project_url');` and
  `select vault.create_secret('<your CRON_SHARED_SECRET>', 'cron_shared_secret');`, then run the
  contents of `supabase/schedules.sql`. The secret then stays in the editor's snippet history,
  so delete that snippet afterwards.

## Running the tests

No Docker and no Supabase account are needed. The database tests run the real migration
files inside an in-memory Postgres ([PGlite](https://pglite.dev)) and check what an
anonymous visitor, a client, the owner and the server can each do.

```bash
npm ci
npm test
```

Other checks: `npm run typecheck`, `npm run lint`, `npm run build`.

## Stack

React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, Zod; Supabase
(Postgres with row-level security, Auth, Storage, Edge Functions on Deno).

## Author

Built and maintained by Timothy LeGendre, [timcpa.com](https://timcpa.com).

## License

MIT. The bundled signature fonts carry their own licenses; see [LICENSE](LICENSE).
