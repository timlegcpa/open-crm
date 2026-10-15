## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] The six gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (after the build), `npm run deno:check`, `npm run deno:lint`
- [ ] No firm-specific strings: fictional names, `example.test` or `example.com` addresses, 555-01xx numbers (the zero-firm-strings test passes)
- [ ] Test fixtures do not look like real secrets
- [ ] Migrations follow the invariants in CONTRIBUTING.md (RLS and the MFA gate, explicit grants, `search_path` pinned) and `invariants.test.ts` passes
- [ ] New tables have the full principal matrix in their PGlite test; new edge functions have the edge contract test
- [ ] Each new guard was broken once to watch its test fail (say what you broke)
- [ ] Docs updated where behaviour, setup or configuration changed
- [ ] Screenshots for UI changes (light and dark, and phone width when the layout changes)

## Screenshots

<!-- For UI changes. -->
