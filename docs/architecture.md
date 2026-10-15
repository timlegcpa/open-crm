# Architecture

Open CRM is a React single-page app (Vite, TypeScript, Tailwind, shadcn/ui, TanStack Query)
on one Supabase project: Postgres with row-level security, Auth, Storage, and edge functions
on Deno. The browser talks to Postgres directly (through PostgREST, as the signed-in user) for
everything row-level security can decide, and to an edge function for everything it cannot:
work with secrets, email and text messages, encryption, public links, and steps that must
happen together.

```
browser ──(anon key + user token)──> PostgREST ──> Postgres (RLS on every table)
   │                                                   ▲
   └──(user token / link token)──> edge functions ─────┘ (service role)
                                        │
            pg_cron tick ──(x-cron-secret)──> job-runner ──> other functions / SQL
                                        │
                              outbound adapter ──> Resend, Twilio, or dev_outbox
```

## The feature registry

Each domain is a folder, `src/features/<domain>/`, with a `manifest.tsx` that exports a
`FeatureManifest` (`src/features/types.ts`). A manifest declares what the domain contributes:

- owner nav items and routes inside the shell, and standalone owner routes (the connector's
  consent page);
- portal tabs, routes, home cards and profile sections, and the portal frame;
- public routes (no session: `/sign`, `/invite`, `/start`, `/unsubscribe`, `/esign/verify`,
  the password pages);
- contact record tabs (with a waiting-count badge), header actions, right-bar panels and
  activity cards;
- settings sections.

`src/features/registry.ts` lists the manifests and sorts each slot by `order`. The owner app,
the shell, the portal and the public router read only the registry, so a domain adds a screen
by editing its own manifest, never a shared file.

Manifests load with the entry bundle that every public page downloads, so a manifest imports
only React, the router, icons and three small helpers; everything it points at is lazy
(`lazyNamed`). Public pages live under `src/features/<domain>/public/`, the build names their
chunks `public-*`, and `bundleBoundary.test.ts` proves none of them loads supabase-js.
`registry.test.ts` checks the other rules (relative routes, unique keys and paths, every nav
item opens a screen).

Inside a domain: one api module with its own query keys, Zod at the boundaries, paged reads with
a stable tiebreaker, and mutations with error toasts and rollback of optimistic updates. Shared
CRM pieces (contact stages, revenue math, the contact picker, the pick-list hook) are in
`src/lib`, `src/api` and `src/hooks`.

## Principals

Defined once, in `0001_core` and `0002_contacts`:

- **owner**: `is_owner()`, the user recorded in `org_profile.owner_user_id`, at aal2 once a
  two-factor factor is verified, on a token issued after any two-factor recovery.
- **client**: `get_client_contact_id()`, the contact an active portal account belongs to.
- **server**: the service role, used by edge functions. It bypasses row-level security but not
  triggers.
- **system actor**: an Auth user that never signs in, recorded as the actor on audit rows
  written with no user (scheduled jobs, webhooks).

A role claim in a token grants nothing. View as client is a client session that a statement
trigger on every client-writable table, the storage policies and the edge handler all keep
read-only.

## The shared edge layer

Every function is `supabase/functions/<name>/` with `handler.ts` (pure, every dependency
injected, tested in vitest) and `index.ts` (wires Deno and Supabase). Common code is in
`supabase/functions/_shared/`:

- `handler.ts`, `createHandler`: the one request pipeline. In order: CORS preflight, the method
  allowlist, refusal of a browser origin not on the list, authentication, refusal of a View as
  client session for client writes, the rate limit, a body read with a size cap, then the
  function. Errors leave as their own status with a generic message; anything unexpected is a
  generic 500.
- **Auth modes**, combinable per function:
  `owner` (bearer token, owner at the right assurance level), `client` (bearer token, a portal
  account; the function must declare `clientWrites`), `cron` (`x-cron-secret` against
  `CRON_SHARED_SECRET`), `internal` (a named header against a named secret, one function
  calling another), `apiKey` (a server-to-server key the function verifies; must declare a rate
  limit) and `public` (no Supabase principal: the function proves the caller itself with a
  signed link, a webhook signature or an OAuth token; must declare a rate limit).
- `config.ts` (URLs, keys, allowed origins), `secrets.ts` (constant-time secret checks),
  `rate-limit.ts` (the per-address, per-user and global buckets in `0001_core`), `audit.ts`,
  `crypto.ts`, `magic-bytes.ts` (every stored upload's bytes are checked against its type),
  `log.ts` (redacting logger), `organization.ts` (the org's names and branding for emails),
  `email-layout.ts`, `paging.ts` and `outbound.ts`.

## The outbound adapter

Every email and text message leaves through `_shared/outbound.ts`, which picks an adapter per
send from the environment:

- **resend** when `RESEND_API_KEY` is set (with `EMAIL_FROM`);
- **twilio** when all three Twilio values are set;
- **local** when no provider is set and `ENVIRONMENT` is not `production`: the message is
  written to the `dev_outbox` table with its sender, headers and idempotency key, and the owner
  reads it on System, Outbox. Every flow works on a fresh project with no provider account.

In production a missing provider throws: a message is never dropped silently and never parked in
the outbox of a live install. A send answers `sent`, `failed` (the provider refused; safe to
retry) or `unknown` (no answer; it may have been accepted, so it is never retried with a new
idempotency key).

## Background work: jobs and the job runner

No migration schedules anything. Background work is a row in `public.jobs`, and one scheduled
tick runs the queue:

1. `npm run schedules:install` stores the project URL and `CRON_SHARED_SECRET` in Vault and
   applies `supabase/schedules.sql`: an every-minute tick that posts to `job-runner` (reading
   the URL and secret from Vault when it runs), daily jobs that enqueue one row of each kind
   only when none is already waiting, an hourly View as client sweep, and a cron history trim.
2. `job-runner` claims due jobs with a lease and routes each by its kind
   (`supabase/functions/job-runner/kinds.ts`): `esign:expire_envelopes`,
   `needs:reminder_dispatch` and `portal:daily_digest` post to their functions with the cron
   secret; `ops:maintenance` calls the server-only retention functions in SQL.
3. Execution is at least once, so every callee is safe to run twice and treats "nothing to do"
   as success. Results (counts and ids only) are kept 30 days and shown on System, Jobs, where
   the owner can retry a failed job.

## Migrations

`supabase/migrations/`, applied in filename order by `npx supabase db push` and by the PGlite
test harness:

| File | Holds |
| --- | --- |
| `0001_core` | The principals and `org_profile`, two-factor session checks and backup codes, the rate-limit buckets, the append-only audit log, app settings, the jobs queue, the dev outbox, CSP violation reports, and the shared trigger helpers. |
| `0002_contacts` | Contacts and their pick-lists (stages, lead sources, organization types, services), businesses, emails, notes, relationships, quotes and upsells; portal accounts, invitations, client activity and tasks; View as client sessions and the read-only rules; the safe contact delete. |
| `0003_documents` | Documents and folders, encryption metadata, annotations, the private documents bucket and its policies. |
| `0004_messages` | Client messages and the organization's message key. |
| `0005_requests` | Requests, their items, answers and uploaded documents, request categories and tags, templates, and start links. |
| `0006_esign` | Envelopes, their documents, pages, signers, fields and events, templates, text message codes, drawn signatures, and the e-sign working bucket. |
| `0007_mcp` | The AI connector's OAuth tables (every secret stored hashed) and the audited functions behind its tools. |
| `0008_board` | Work items, their history, board stages and work item types. |
| `0009_marketing` | Monthly targets and ad spend. |
| `0010_email` | Group email campaigns, recipients, suppressions and unsubscribe tokens. |
| `0011_control_center` | The lead-intake key and deliveries, and the public logo bucket. |
| `0012_portal` | The server side of invitations, sign-in records, and the View as client credential lock. |

Every migration states the schema's rules in its header, and
`src/__tests__/db/invariants.test.ts` checks the migrated catalog against them (row-level
security and an MFA gate on every table, explicit grants, `search_path` pinned on every
function, per-bucket storage policies, the View as client trigger on client-writable tables).
[CONTRIBUTING.md](../CONTRIBUTING.md#migration-rules) lists them.

## Tests

- `src/__tests__/db/`: the migrations in PGlite, with every principal against every table.
- `src/__tests__/edge/`: each function's handler, through the shared contract and its own
  behaviour tests.
- `src/features/<domain>/__tests__/`: the screens and api modules.
- `src/__tests__/`: the registry, the bundle boundary, the bootstrap, the firm-strings scan.
- `src/__tests__/seed/`: the demo seed (`supabase/seed/demo.sql`).
