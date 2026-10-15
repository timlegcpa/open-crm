# Security policy

## Supported versions

Open CRM has no release branches. Security fixes land on `main`; run the latest `main`.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Please do not open a public issue,
pull request or discussion for a security problem, and do not test against an install you do
not run yourself.

Include what you found, the steps to reproduce it, and what an attacker could reach. You will
get an answer in the advisory thread, and credit in the fix if you want it.

## The security model

What the code does, so you can judge it and report where it falls short.

### Principals

- **One owner.** The owner is the account recorded in the single `org_profile` row, created by
  `npm run dev:bootstrap`. A role claim in a token grants nothing; the database decides with
  `is_owner()`. Public sign-up is off (`supabase/config.toml`).
- **Two-factor.** Once the owner turns on two-factor sign-in (Settings, Security), every owner
  read and write needs a second-factor (aal2) session, in the database
  (`mfa_session_ok()`, behind a restrictive policy on every table and on storage) and in the
  app. A two-factor recovery revokes every token issued before it. Approving an AI connector
  always needs an aal2 session, whatever else is set up. Two-factor is not forced on at
  install: turn it on as the first thing you do (see [docs/setup.md](docs/setup.md)).
- **Clients.** A client is a portal account bound to one contact. Row-level security limits a
  client to its own contact's rows through `get_client_contact_id()`, and a client changes
  only what the portal lets it change (answering a request, completing a task); column
  guards hold everything else. A client is signed out after 30 minutes without activity.
- **View as client.** The owner can look at the portal as a client sees it. That session is
  read-only: every client-writable table refuses its writes (a statement trigger), storage
  refuses them for every bucket, and every edge function a client writes through refuses it.
  During the view and for an hour after it, the client's password, email and two-factor
  factors are locked, so nothing done in the view outlives it.
- **The server.** Edge functions use the service role. Functions with no signed-in caller
  prove themselves another way: scheduled calls with `CRON_SHARED_SECRET`, one function
  calling another with its own shared secret, lead intake with a hashed API key, public pages
  with a signed link token. Shared secrets are compared in constant time, and an unset or
  short one refuses every caller.
- **Anonymous visitors** reach no table at all.

### Data at rest

- **Documents** clients and the owner upload are encrypted by the server (AES-GCM, a fresh IV
  each, `DOCUMENT_ENCRYPTION_KEY`) before they are stored, after the file's bytes are checked
  against its declared type.
- **Sensitive fields** (a sensitive request answer, an e-sign signer's phone number) are stored
  only encrypted under `PII_ENCRYPTION_KEY`; revealing a sensitive answer is audited.
- **Secure messages** from a client are encrypted in the client's browser to the owner's key;
  the server never sees the text. The owner's replies are stored as plain text.
- **Executed e-sign PDFs are stored unencrypted** so their SHA-256 can be checked by anyone
  holding a copy (`/esign/verify`). They are served only through short-lived signed links.
- **Tokens are stored as hashes**: e-sign signing links, portal invitations, request start
  links, lead-intake keys, the AI connector's OAuth secrets, and two-factor backup codes
  (a keyed hash).
- The audit log cannot be updated, deleted or truncated, and keeps ids and codes, not personal
  data.

### In transit and in the browser

- Link tokens travel in the URL fragment (`/sign#token=`, `/invite#token=`, `/start#token=`),
  which a browser never sends to a server, and every page sets `referrer` to `no-referrer`.
- Edge functions answer only allowed origins (`SITE_URL`, `ALLOWED_ORIGINS`, and localhost
  while `ENVIRONMENT` is not `production`), and every error body is generic.
- Every public or API-key endpoint is rate limited: the shared edge handler refuses to start
  one without a limit. A limiter that cannot answer refuses the request (503), never allows it.
- No third-party tracking, analytics or remote fonts: the app loads only its own files and
  your Supabase project.

### Email and text messages

Every email and text leaves through one adapter. With no provider configured and
`ENVIRONMENT` not `production`, messages are written to the dev outbox (System, Outbox) instead
of being sent. In production a missing provider is an error, never a silent drop.

## What you are responsible for

Open CRM runs on your own Supabase project and your own host. The code cannot do these for you:

- **Your Supabase project's settings.** Push `supabase/config.toml` (`npx supabase config push`)
  so public sign-up stays off and the password rules apply, with your own site in the redirect
  list instead of the localhost entries.
- **Secrets.** Keep `supabase/functions/.env` and the service role key out of version control
  and out of any web page. Never change `DOCUMENT_ENCRYPTION_KEY` or `PII_ENCRYPTION_KEY` after
  data exists: what was encrypted under the old key becomes unreadable. Rotate
  `CRON_SHARED_SECRET` if a schedules install fails after sending it.
- **Production mode.** Set `SITE_URL` to your real address and `ENVIRONMENT=production`.
- **Email.** Set up custom SMTP for Supabase Auth (password resets, password-change codes) and
  an email provider for the app (invitations, requests, two-factor recovery alerts).
- **Your host's headers.** Serve the app with a Content-Security-Policy that includes
  `frame-ancestors 'none'` (or `X-Frame-Options: DENY`), over HTTPS.
- **Backups.** The free plan has no point-in-time recovery. Decide how you back up the
  database and the storage buckets, and test a restore.
- **Two-factor.** Turn it on for the owner account, and keep the backup codes somewhere safe.
- **Updates.** Pull fixes from `main`, push new migrations, and redeploy the functions.
