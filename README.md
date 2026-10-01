# Open CRM

A self-hosted CRM and client-workflow suite for a single business, built on React and
Supabase. One owner runs it; clients get a secure portal.

> **Status: early.** This repository is being extracted, piece by piece, from a CRM that has
> run a real client practice in production. The core and contacts database layers are here
> and tested. The application surfaces below are being ported in phases and are not in the
> repository yet.

## What it is for

- **Contacts and pipeline**: contacts, businesses they own, notes, follow-ups, service quotes.
- **Client portal**: invitations, a client home, profile.
- **Documents**: upload, preview, annotate and share, encrypted at rest.
- **Secure messages**: end-to-end encrypted messages between the owner and each client.
- **Requests**: send a client a list of documents and questions, with reminders.
- **E-signature**: place fields, send, sign, and verify an executed PDF against tampering.
- **Work board**: a Kanban board of work items with configurable stages.
- **MCP connector**: an OAuth-protected MCP server so an AI assistant can work the CRM.
- **Control center**: names, branding, lead sources, services and other pick-lists are data the
  owner edits, not code.

## What is in the repository today

| Piece | State |
| --- | --- |
| Project setup (Vite, React, TypeScript, Tailwind, shadcn/ui) | Done |
| Core database schema: owner and system principals, MFA session gating and backup codes, rate limits, append-only audit log, settings, background jobs, dev outbox | Done, tested |
| Contacts database schema: contacts, the businesses they own, emails, notes, relationships, follow-ups, quotes, portal accounts and invitations, portal tasks and activity, editable pick-lists, a safe contact-delete protocol | Done, tested |
| Local setup script and owner sign-in (password, plus the authenticator code when one is set up) | Done, tested |
| CRM screens, portal, documents, messages, requests, e-sign, board, MCP | Being ported |

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
npm run dev
```

`db push` creates the tables. `config push` applies the sign-in settings in
`supabase/config.toml`: public sign-up off, the password rules, authenticator apps on, and the
site URL `http://127.0.0.1:5173`. `dev:bootstrap` asks for the project URL and the anon and
service role keys (Project Settings > API), your organization's name, and the owner's email and
password. It writes `.env.local` and the edge-function secrets, creates the owner account, and
is safe to run again; the service role key is used for that run only and never saved.
`secrets set` hands the generated secrets to your project's edge functions, and
`functions deploy --use-api` deploys them (bundled by Supabase, so no Docker). Then open
http://localhost:5173 and sign in as the owner.

The edge functions accept browser requests from http://localhost:5173 while `ENVIRONMENT` is
unset. When you serve the app from a real address, set `SITE_URL` to it and `ENVIRONMENT`
to `production` with `npx supabase secrets set`, and redeploy.

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
