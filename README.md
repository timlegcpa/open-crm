# Open CRM

A self-hosted CRM and client-workflow suite for a single business, built on React and
Supabase. One owner runs it; clients get a secure portal.

> **Status: early.** This repository is being extracted, piece by piece, from a CRM that has
> run a real client practice in production. The contacts and pipeline, the client portal,
> documents, secure messages, requests, e-signature, the work board, group email, marketing,
> the AI connector, settings and the system pages are here and tested.

## What it is for

- **Contacts and pipeline**: contacts, businesses they own, notes, service quotes and upsells,
  client tiers and reversible archiving.
- **Client portal**: invitations, a client home, profile.
- **Documents**: upload, preview, annotate and share, encrypted at rest.
- **Secure messages**: secure messages between the owner and each client: a client's message is
  end-to-end encrypted in their browser to the owner's key, and the owner's replies are stored as
  plain text (not end-to-end encrypted). Messages are deleted 7 days after they are read.
- **Requests**: send a client a list of documents and questions, with reminders; a request closes itself once every answer is accepted.
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
| E-signature: compose, send, sign (typed or drawn), text message codes, tamper check, templates | Done, tested |
| Requests: documents, questions and tasks for a client, templates, start links, reminders | Done, tested |

## Documentation

- [Setup](docs/setup.md): from a fresh clone to a running install, step by step.
- [Configuration](docs/configuration.md): every environment variable and function secret,
  required or optional, and what stops working without it.
- [Features](docs/features.md): what the owner and clients can do, domain by domain.
- [Architecture](docs/architecture.md): the feature registry, the edge layer, the job runner,
  the outbound adapter and the migrations.
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md) (how to report a vulnerability).

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
http://localhost:5173, sign in as the owner, and turn on two-factor first (Settings, Security).
[docs/setup.md](docs/setup.md) walks through each step and what the bootstrap does.

To look around with fictional data, `npm run demo:seed` loads a dozen made-up contacts with
their businesses, quotes, board cards, messages, requests and a draft envelope. It creates no
sign-in accounts, is safe to run twice, and refuses a project that already has contacts of its
own (`npm run demo:seed -- --force` loads it anyway).

Every setting and secret, with what breaks without it, is in
[docs/configuration.md](docs/configuration.md). Every emailed link is built on `SITE_URL`, so
set it (to `http://localhost:5173` while developing) before sending invitations, requests or
envelopes. The edge functions accept browser requests from http://localhost:5173 while
`ENVIRONMENT` is unset. When you serve the app from a real address, set `SITE_URL` to it and `ENVIRONMENT`
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

- `SITE_URL` is required for invitations: the invitation link is built on it, so without it
  sending or resending an invitation is refused (`site_url_missing`) and no link is made.
- With `SITE_URL` set, invitations are emailed through the email provider (see Email). Without
  one, and with `ENVIRONMENT` not `production`, they land in the dev outbox (System, Outbox).
  When an invitation is not sent, the contact's Portal panel shows its link for the owner to copy.
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

### Requests

The owner sends a client a request (documents to upload, questions to answer, tasks to tick
off); the client answers in the portal, or through an emailed start link if they have no
portal account yet.

- `SITE_URL` is required: every request email carries a link built on it. Without it, Send
  and Remind are refused (`site_url_missing`), the scheduled reminders answer the same, and
  the emails that tell the owner and the client a request was submitted are skipped.
- `PII_ENCRYPTION_KEY` (generated by `npm run dev:bootstrap`) is required for sensitive
  answers: they are stored only encrypted with it, so without it a client's sensitive answer
  is refused and the owner's Reveal fails (`encryption_unavailable`).
- Scheduled reminders are off by default. Turn them on in Settings, Requests ("Send reminders
  automatically", "Days between reminders", "Most reminders per request"), and install the
  schedules (`npm run schedules:install`, see Schedules): the `open-crm-needs-reminders`
  schedule queues a `needs:reminder_dispatch` job once a day at 14:00 UTC, which the job
  runner hands to `needs-reminder-dispatcher`. Only clients with a portal account are
  reminded this way; Remind now on a request works for anyone. A request's reminders can be
  paused on the request itself.
- A scheduled reminder that runs while someone is sending a Remind for the same request is
  skipped (counted as `skipped_in_progress` in the job's result), not sent twice: the manual
  reminder counts as that reminder, and the next scheduled one waits a full interval from it.
  A reminder whose email fails is not counted and does not delay the next scheduled one.

### E-signature

The owner composes an envelope (PDFs, pages, signers, signature and date fields), sends it,
and each signer gets an emailed link to review and sign; a signer with a portal login can
also sign from the portal. When everyone has signed, the executed PDF (the document, the
stamped signatures and an audit trail page) is filed in each signer's documents and emailed
to every party. Anyone holding a copy can check it at `/esign/verify` on your site.

- **Not legal advice.** The consent screen follows the U.S. ESIGN Act's disclosure pattern
  with your organization's name, but whether an electronic signature is valid for a given
  document and place is a question for your own lawyer.
- **Executed PDFs are stored plaintext**, unlike uploaded documents, which are encrypted: the
  signed copy is served by short signed links and its SHA-256 is what the tamper check
  compares. Choose where they are filed in Settings, E-sign (the folder may be a path such as
  `Signed/Agreements`).
- **Text message codes** (High verification) send through Twilio. In the United States, texts
  from a long-code number need a registered A2P 10DLC campaign, or use a verified toll-free
  number; unregistered traffic is filtered by the carriers. Without Twilio, and with
  `ENVIRONMENT` not `production`, the code is written to the dev outbox instead, so the flow
  can be tried before a provider is set up. Turn SMS off in Settings, E-sign if you have no
  provider: envelopes then use Standard verification.
- Set `ENVIRONMENT=production` on a real install: it stops the dev outbox standing in for
  email and text messages, and stops allowing `http://localhost:5173`.
- `ESIGN_INTERNAL_TOKEN` and `ESIGN_SMS_CODE_KEY` are generated by `npm run dev:bootstrap`.
  `RESEND_WEBHOOK_SECRET` is optional: point a Resend webhook at
  `https://<your-project-ref>.supabase.co/functions/v1/esign-resend-webhook` for the
  delivered and opened events, and set its signing secret here.
- Unanswered envelopes expire, and the working files of finished ones are cleared after 90
  days, by a daily job (`esign:expire_envelopes`, run by the job runner; see Schedules).
- The six signature fonts deploy with `esign-finalize-envelope` through `static_files` in
  `supabase/config.toml`. After the first deploy, send yourself one envelope and sign it with
  a typed signature: if the fonts did not ship, finalize fails and the envelope stays
  unsigned.

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

Claude and ChatGPT can connect out of the box. To connect another assistant, set
`MCP_EXTRA_REDIRECT_URIS` (with `npx supabase secrets set`) to its exact OAuth callback address,
or several separated by commas: `https` only, no query and no fragment. A refused registration
is logged by the `mcp-oauth` function with the callback it asked for (scheme, host and path), so
you can copy it from the log. Only add an assistant you trust: the callback is where a sign-in
code is sent.

The tools an assistant gets. The ones marked with a go-ahead need your explicit approval in the
conversation before they act; every call is recorded in the audit log.

| Tool | What it does |
| --- | --- |
| `search_contacts`, `get_contact` | Find a contact by name, email, phone or business (archived contacts are left out) and read one. |
| `create_contact` | A new contact from an email or a phone number, with an optional stage and lead source. |
| `update_contact` | Names, phone and business name. |
| `correct_contact_email` | Fixes an address, refusing any contact with a portal account. Go-ahead. |
| `set_contact_status` | Moves a contact along the pipeline, only from the stage it read. |
| `add_business`, `log_call_note` | A business on the contact; a note appended to it. |
| `upsert_quote`, `delete_quote` | A proposed quote; deleting one is a go-ahead. Accepted quotes are yours alone. |
| `create_request`, `update_request`, `list_requests` | Draft and read back requests. |
| `send_request`, `remind_request` | Email the client. Go-ahead, one email per call. |
| `delete_request` | Deletes a draft. Go-ahead. |
| `list_open_requests` | Every open request, by whose move it is. |
| `accept_request`, `close_request` | Accept all answers (the last one closes the request); close a sent request. Go-ahead. |
| `set_request_reminders` | Pauses or resumes one request's reminders. |
| `list_board` | The board's cards, with each lane's name. |
| `create_work_item`, `update_work_item`, `move_work_item`, `add_work_item_note` | Board cards: add, edit, move with a reason, note. |

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

Other checks: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run deno:check` and
`npm run deno:lint` (Deno comes with `npm ci`). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, Zod; Supabase
(Postgres with row-level security, Auth, Storage, Edge Functions on Deno).

## Author

Built and maintained by Timothy LeGendre, [timcpa.com](https://timcpa.com).

## License

MIT. The bundled signature fonts carry their own licenses; see [LICENSE](LICENSE).
