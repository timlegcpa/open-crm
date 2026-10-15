// Every shared module, re-exported. This file exists so `npm run deno:check` (which
// checks supabase/functions/**/index.ts) type-checks every module here under Deno,
// including the ones no function imports yet. src/__tests__/edge/sharedIndex.test.ts
// fails when a module is missing from it.
//
// Functions import the specific module they need ('../_shared/handler.ts'), not this
// file, so a function's bundle carries only what it uses. Supabase does not deploy
// _shared as a function: names starting with '_' are skipped.

export * from './audit.ts';
export * from './auth.ts';
export * from './config.ts';
export * from './crypto.ts';
export * from './email-layout.ts';
export * from './handler.ts';
export * from './http.ts';
export * from './log.ts';
export * from './magic-bytes.ts';
export * from './mfa-backup-code.ts';
export * from './organization.ts';
export * from './outbound.ts';
export * from './owner.ts';
export * from './paging.ts';
export * from './portal-account.ts';
export * from './rate-limit.ts';
export * from './secrets.ts';
