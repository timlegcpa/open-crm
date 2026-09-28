# Open CRM

A self-hosted CRM and client-workflow suite for a single business, built on React and
Supabase. One owner runs it; clients get a secure portal.

> **Status: early.** This repository is being extracted, piece by piece, from a CRM that has
> run a real client practice in production. The core database layer is here and tested. The
> application surfaces below are being ported in phases and are not in the repository yet.

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
| CRM, portal, documents, messages, requests, e-sign, board, MCP | Being ported |

## Security model

- Row-level security on every table, with explicit grants rather than inherited defaults.
- The owner is resolved from a single identity row plus an MFA session check. A role claim in
  a token grants nothing on its own.
- An owner with MFA enrolled is only the owner at the second factor, and only on a token
  issued after any recovery lockout.
- Rate limits fail closed. The audit log cannot be updated, deleted or truncated.

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
