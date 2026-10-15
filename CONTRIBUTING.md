# Contributing to Open CRM

Thanks for helping. Open CRM is a self-hosted, single-owner CRM and client portal (React, Vite,
Supabase). This page covers how to set up, what every change must pass, and the rules the
tests enforce.

## Setup

You need Node 22 (CI runs Node 22; `package.json` asks for `>=22`). Nothing else: no Docker,
no Deno install, no local Supabase stack, and no Supabase account for the tests.

```bash
git clone <your fork>
cd open-crm
npm ci
```

`npm ci` also installs the Deno and Supabase command-line tools as dev dependencies, so the
Deno checks run from `node_modules`. To try the app against a real backend, follow
[docs/setup.md](docs/setup.md) with your own free Supabase project, then load the fictional
demo data with `npm run demo:seed`.

## The six gates

Every change passes the same six commands CI runs (`.github/workflows/ci.yml`), in this order:

```bash
npm run typecheck   # tsc, no emit
npm run lint        # eslint, including jsx-a11y
npm run build       # vite build
npm test            # vitest, after the build: some suites read dist/
npm run deno:check  # type-checks every edge function's index.ts
npm run deno:lint   # lints supabase/functions
```

CI also runs [gitleaks](https://github.com/gitleaks/gitleaks) over the history, so a
string that looks like a provider key fails the build even in a test (see Fixtures below).

### Database tests

The database tests apply the real migration files, in order, to an in-memory Postgres
([PGlite](https://pglite.dev)) with a small shim for the parts of Supabase the migrations
read (the API roles, `auth.uid()` and `auth.jwt()`, the auth and storage tables). The shim
and the helpers live in `src/__tests__/db/harness.ts`. A test acts as a principal
(`asAnon`, `asOwner`, `asClient(userId)`, `asServer`) inside a transaction that is always
rolled back, so real row-level security is evaluated, not a mock.

For every table a domain adds, its test (`src/__tests__/db/<domain>.test.ts`) covers the
whole principal matrix: anon, client A, client B, the owner, the server, and a View as client
session for any table a client can write, each against SELECT, INSERT, UPDATE and DELETE;
the column guards; the storage policies of each bucket; and EXECUTE on every function.

### Edge function tests

Edge functions are tested in vitest, not in Deno. Each function is split in two:

- `handler.ts` is pure: every outside dependency (database calls, storage, email, the clock)
  is passed in.
- `index.ts` wires those dependencies to Deno and Supabase.

`src/__tests__/edge/<name>.test.ts` imports the handler, runs the shared door checks with
`describeEdgeContract` from `src/__tests__/edge/contract.ts` (origins, methods, auth modes,
body caps, generic errors), then tests the behaviour, against PGlite wherever the logic lives
in SQL. Deno itself only type-checks and lints (`deno:check`, `deno:lint`).

## Branches and pull requests

- Fork, branch from `main`, and open a pull request against `main`.
- All six gates green, in CI as well as locally.
- One topic per pull request. Fill in the checklist in the template, and add screenshots
  for anything a person sees (light and dark, and phone width when the layout changes).
- Security problems are never reported in an issue or a pull request: see
  [SECURITY.md](SECURITY.md).

## Rules the tests enforce

### No firm-specific strings

Open CRM was extracted from one business's private deployment. Nothing from it may come back:
no real person, business, place, phone number, domain or license number, and none of the
vocabulary of the domains that were deliberately left out. `src/__tests__/zeroFirmStrings.test.ts`
scans every file and path in the repository (built output in `dist/` included) and fails on
any hit. Use plainly fictional values instead: addresses on `example.test` or `example.com`,
phone numbers in the 555-01xx range, names like Ada Example and Acme LLC.

Also: no em dashes in anything a person reads (docs, UI copy, comments), and UI copy is in
sentence case.

### Fixtures never look like secrets

A test value that looks like a real credential (a provider key prefix, a real-looking JWT, a
cloud access key) trips the secret scanner and teaches readers bad habits. Use an obviously
fake value such as `provider-secret-0123456789`.

### The feature registry

Each feature domain is a folder, `src/features/<domain>/`, with one `manifest.tsx` that
exports `manifest: FeatureManifest` (the type is in `src/features/types.ts`). The manifest
says what the domain contributes: owner nav items and routes, portal tabs, routes and home
cards, public routes, contact tabs, header actions and side panels, activity cards and
settings sections. `src/features/registry.ts` collects the manifests, and the shell, the
portal and the public router read only the registry, so no other file names a feature.

`src/__tests__/registry.test.ts` checks the rules in the header of `types.ts`, among them:

- A manifest statically imports only `react`, `react-router-dom`, `lucide-react` and
  `@/features/lazy`, `@/features/types`, `@/features/links`. Everything it points at is lazy
  (`lazyNamed`), because the registry loads with the bundle every public page downloads.
- Owner and portal route paths are relative; nav and tab paths are absolute, and each opens
  a registered screen.
- Routes use `element` and `children` only.
- Keys and paths are unique across features.
- A page that lays out its own scrolling sets `handle: BOUNDED_PAGE`.
- A public page lives under `src/features/<domain>/public/`;
  `bundleBoundary.test.ts` proves no public page loads supabase-js.

### Adding a domain

1. `src/features/<domain>/manifest.tsx`, plus the domain's pages, components and one api
   module (TanStack Query, its own query keys, Zod at the boundary).
2. One import and one entry in `FEATURES` in `src/features/registry.ts`, and the folder name
   in the domain list `registry.test.ts` compares against.
3. If it needs tables: the next migration, `supabase/migrations/00NN_<domain>.sql`, following
   the rules below, with `src/__tests__/db/<domain>.test.ts` and, for any function a session
   may call or any stated exemption, `src/__tests__/db/allowlists/<domain>.ts`
   (shape in `allowlists/types.ts`).
4. If it needs edge functions: `supabase/functions/<name>/{handler.ts,index.ts,deno.json}` on
   the shared handler (`_shared/handler.ts`), and `src/__tests__/edge/<name>.test.ts`.
5. If it needs scheduled work: a job kind in `supabase/functions/job-runner/kinds.ts` and a
   line in `supabase/schedules.sql`. Never a schedule in a migration.

### Migration rules

`src/__tests__/db/invariants.test.ts` reads the migrated catalog and fails the build when a
table or function breaks one of these. Every migration states them in its header comment:

- Row-level security on every table, plus a RESTRICTIVE policy named `<table>_mfa_gate`,
  `FOR ALL TO authenticated`, `USING ((SELECT public.mfa_session_ok()))` and the same
  `WITH CHECK`, so a policy that forgets the second factor still cannot be reached.
- Privileges are stated, never inherited: `REVOKE ALL ON <table> FROM PUBLIC, anon,
  authenticated, service_role`, then `GRANT` per role, row access only (by column where a
  column must not move). Supabase grants everything in `public` by default, so a missing
  REVOKE is an open table. `anon` gets nothing.
- Functions likewise: `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated,
  service_role`, then `GRANT EXECUTE` per role. Every function pins `SET search_path = ''`
  and schema-qualifies what it touches. `SECURITY DEFINER` only where it must be.
- A `FOR ALL` policy states both `USING` and `WITH CHECK`.
- The principals are `public.is_owner()`, `public.get_client_contact_id()` and the service
  role. A role claim in a token grants nothing.
- Columns a client must not change are held by a `BEFORE UPDATE` trigger running
  `public.enforce_client_column_guard('id', ...)`.
- Every table a client session can write carries the `trg_impersonation_read_only`
  statement trigger (`public.enforce_impersonation_read_only()`), so the owner's View as
  client session stays read-only.
- Storage: each bucket has its own policies on `storage.objects`, and every clause requires
  `bucket_id = '<that bucket>'` at its top level.
- A pick-list is a table guarded by `public.guard_pick_list()` (key, label, colour,
  sort_order, is_active, is_system); a list the code depends on in full passes `'fixed'`.
- A view is created `WITH (security_invoker = true)`.
- No cron schedule in a migration.

The test also checks each of its own rules against a deliberately broken schema, so a check
that stops working fails too.

### Prove a guard works

A passing test is not evidence that it guards anything. When you add a guard, break the code
it guards, run the test and watch it fail, then restore the code. Mention what you broke in
the pull request.
