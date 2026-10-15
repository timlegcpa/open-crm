// @vitest-environment node
// mfa-backup-codes and the code module both MFA functions share. The SQL half
// (mfa_backup_codes_replace, _revoke, mfa_guard_denied, the rate limits) runs in PGlite
// from the real migrations; only Auth's verdict on a token is faked.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, seedContact, seedCore, seedPortalAccount, OWNER_ID } from '../db/harness';
import { serviceClient } from './pgliteClient';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeClientAuth, fakeOwnerAuth, throwInternal } from './contract';
import { checkUserLimit } from '../../../supabase/functions/_shared/rate-limit';
import { jwtAssurance, type AuthOutcome, type ClientPrincipal, type OwnerPrincipal } from '../../../supabase/functions/_shared/auth';
import {
  BACKUP_CODE_LENGTH,
  CROCKFORD,
  createBackupCodeHasher,
  generateBackupCode,
  normalizeBackupCode,
} from '../../../supabase/functions/_shared/mfa-backup-code';
import { createMfaBackupCodesHandler, type MfaBackupCodesDeps } from '../../../supabase/functions/mfa-backup-codes/handler';

const SERVICE_KEY = 's'.repeat(64);
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** An unsigned token-shaped string with these claims: what the door's authorizers already accepted. */
function tokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('backup codes', () => {
  it('are XXXXX-XXXXX-XXXXX-XXXXX from the Crockford alphabet, never I, L, O or U', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateBackupCode();
      expect(code).toMatch(CODE_SHAPE);
      expect(code).not.toMatch(/[ILOU]/);
    }
    expect(CROCKFORD).toHaveLength(32);
    // 256 % 32 === 0: byte % 32 picks every character with the same odds.
    expect(256 % CROCKFORD.length).toBe(0);
  });

  it('are distinct', () => {
    expect(new Set(Array.from({ length: 500 }, generateBackupCode)).size).toBe(500);
  });

  it('normalise to the compact form, forgiving case, spaces, dashes and look-alike letters', () => {
    const code = generateBackupCode();
    expect(normalizeBackupCode(code)).toBe(code.replace(/-/g, ''));
    expect(normalizeBackupCode(` ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(code.replace(/-/g, ''));
    expect(normalizeBackupCode('OOOOO-IIIII-LLLLL-00000')).toBe('00000111111111100000');
  });

  it('refuse a wrong length, a non-string and a character outside the alphabet', () => {
    for (const bad of ['', 'ABCDE', 'ABCDE-ABCDE-ABCDE-ABCD', 'ABCDE-ABCDE-ABCDE-ABCDEF', 'UUUUU-UUUUU-UUUUU-UUUUU', 42, null, undefined, 'x'.repeat(65)]) {
      expect(normalizeBackupCode(bad), String(bad)).toBeNull();
    }
    expect(BACKUP_CODE_LENGTH).toBe(20);
  });

  it('hash with a key derived from the service key: stable, keyed, and refused with a short key', async () => {
    const hash = createBackupCodeHasher(SERVICE_KEY);
    const a = await hash('ABCDEFGHJKMNPQRSTVWX');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hash('ABCDEFGHJKMNPQRSTVWX')).toBe(a);
    expect(await createBackupCodeHasher('t'.repeat(64))('ABCDEFGHJKMNPQRSTVWX')).not.toBe(a);
    expect(() => createBackupCodeHasher('short')).toThrow();
  });

  it('read aal and iat from a token, and nothing from garbage', () => {
    expect(jwtAssurance(tokenWith({ aal: 'aal2', iat: 1700000000 }))).toEqual({ aal: 'aal2', iat: 1700000000 });
    expect(jwtAssurance(`Bearer ${tokenWith({ aal: 'aal1' })}`)).toEqual({ aal: 'aal1', iat: null });
    expect(jwtAssurance(tokenWith({ aal: 2, iat: '1700000000' }))).toEqual({ aal: null, iat: null });
    expect(jwtAssurance('not-a-token')).toEqual({ aal: null, iat: null });
    expect(jwtAssurance('a.%%%.b')).toEqual({ aal: null, iat: null });
  });
});

// ---------------------------------------------------------------------------

function fakeDeps(over: Partial<MfaBackupCodesDeps> = {}): MfaBackupCodesDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    authorizeClient: fakeClientAuth(),
    assurance: () => ({ aal: 'aal2', iat: Math.floor(Date.now() / 1000) }),
    guardDenied: async () => false,
    userLimit: async () => 'allowed',
    revoke: async () => {},
    verifiedFactorIds: async () => ['f1'],
    nextGeneration: async () => 1,
    replace: async () => 8,
    hashCode: async () => 'h',
    ...over,
  };
}

describeEdgeContract({
  name: 'mfa-backup-codes',
  handler: createMfaBackupCodesHandler(fakeDeps()),
  failingHandler: createMfaBackupCodesHandler(fakeDeps({ replace: throwInternal })),
  credentials: CREDENTIALS.owner,
  clientWrites: true,
  body: { kind: 'json', valid: { action: 'generate' }, maxBytes: 1024 },
});

describe('mfa-backup-codes without aal2', () => {
  it('refuses a token below aal2 itself, even when the database guard would let it through', async () => {
    const guardDenied = vi.fn(async () => false);
    const replace = vi.fn(async () => 8);
    for (const aal of ['aal1', null]) {
      const handler = createMfaBackupCodesHandler(fakeDeps({ assurance: () => ({ aal, iat: null }), guardDenied, replace }));
      const res = await handler(edgeRequest({ headers: CREDENTIALS.owner, body: { action: 'generate' } }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Check your authenticator code again first.', code: 'mfa_required' });
    }
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('mfa-backup-codes', () => {
  let db: PGlite;
  let clientUser: string;
  let contactId: string;

  beforeEach(async () => {
    db = await createDb();
    await seedCore(db);
    contactId = await seedContact(db);
    clientUser = (await seedPortalAccount(db, contactId)).userId;
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified'), ($2, 'verified')`, [OWNER_ID, clientUser]);
  }, 60_000);

  const now = () => Math.floor(Date.now() / 1000);
  const ownerToken = (claims: Record<string, unknown> = {}) => tokenWith({ sub: OWNER_ID, aal: 'aal2', iat: now(), ...claims });

  function dbDeps(over: Partial<MfaBackupCodesDeps> = {}): MfaBackupCodesDeps {
    const server = serviceClient(db);
    const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await server.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    };
    // Auth's verdict: any token whose sub is the owner, or the client.
    const owner = async (token: string): Promise<AuthOutcome<OwnerPrincipal>> => {
      const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
      return sub === OWNER_ID ? { ok: true, principal: { kind: 'owner', userId: OWNER_ID } } : { ok: false, status: 403 };
    };
    const client = async (token: string): Promise<AuthOutcome<ClientPrincipal>> => {
      const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
      return sub === clientUser
        ? { ok: true, principal: { kind: 'client', userId: clientUser, contactId, sessionId: null, impersonating: false } }
        : { ok: false, status: 403 };
    };
    return {
      allowedOrigins: ['http://localhost:5173'],
      authorizeOwner: owner,
      authorizeClient: client,
      guardDenied: async (userId, aal, iat) => (await rpc('mfa_guard_denied', { p_user_id: userId, p_aal: aal, p_iat: iat })) !== false,
      userLimit: (action, userId, max) => checkUserLimit(server, { action, userId, max, windowMinutes: 60 }),
      revoke: async (userId) => void (await rpc('mfa_backup_codes_revoke', { p_user_id: userId })),
      verifiedFactorIds: async (userId) => (await rpc('mfa_verified_factor_ids', { p_user_id: userId })) as string[],
      nextGeneration: async () => Number(await rpc('mfa_backup_code_next_generation')),
      replace: async (userId, hashes, batch, generation) =>
        Number(await rpc('mfa_backup_codes_replace', { p_user_id: userId, p_hashes: hashes, p_batch: batch, p_generation: generation })),
      hashCode: createBackupCodeHasher(SERVICE_KEY),
      ...over,
    };
  }

  const call = (deps: MfaBackupCodesDeps, token: string, action: unknown) =>
    createMfaBackupCodesHandler(deps)(edgeRequest({ headers: { Authorization: `Bearer ${token}` }, body: { action } }));
  const codesOf = async (userId: string) =>
    (await db.query<{ code_hash: string; status: string }>('SELECT code_hash, status FROM public.mfa_backup_codes WHERE user_id = $1', [userId])).rows;

  it('generates eight codes, stores only their keyed digests, and audits it', async () => {
    const res = await call(dbDeps(), ownerToken(), 'generate');
    expect(res.status).toBe(200);
    const { codes } = (await res.json()) as { codes: string[] };
    expect(codes).toHaveLength(8);
    for (const code of codes) expect(code).toMatch(CODE_SHAPE);
    const hash = createBackupCodeHasher(SERVICE_KEY);
    const expected = await Promise.all(codes.map((c) => hash(normalizeBackupCode(c)!)));
    expect((await codesOf(OWNER_ID)).map((r) => r.code_hash).sort()).toEqual(expected.sort());
    for (const r of await codesOf(OWNER_ID)) expect(codes.join()).not.toContain(r.code_hash);
    expect((await db.query(`SELECT action FROM public.audit_logs WHERE user_id = $1`, [OWNER_ID])).rows).toEqual([
      { action: 'mfa_backup_codes_generated' },
    ]);
  });

  it('a client generates codes for their own account only', async () => {
    const res = await call(dbDeps(), tokenWith({ sub: clientUser, aal: 'aal2', iat: now() }), 'generate');
    expect(res.status).toBe(200);
    expect(await codesOf(clientUser)).toHaveLength(8);
    expect(await codesOf(OWNER_ID)).toHaveLength(0);
  });

  it('a second set replaces the first', async () => {
    await call(dbDeps(), ownerToken(), 'generate');
    const before = (await codesOf(OWNER_ID)).map((r) => r.code_hash);
    await call(dbDeps(), ownerToken(), 'generate');
    const after = (await codesOf(OWNER_ID)).map((r) => r.code_hash);
    expect(after).toHaveLength(8);
    expect(after.some((h) => before.includes(h))).toBe(false);
  });

  it('refuses an aal1 token, and a token from before a recovery, without touching the codes', async () => {
    const replace = vi.fn();
    expect((await call(dbDeps({ replace }), ownerToken({ aal: 'aal1' }), 'generate')).status).toBe(403);
    expect((await call(dbDeps({ replace }), ownerToken({ aal: undefined }), 'generate')).status).toBe(403);
    await db.query(`INSERT INTO public.mfa_recovery_lockouts (user_id, revoked_before) VALUES ($1, now() + interval '1 minute')`, [OWNER_ID]);
    const res = await call(dbDeps({ replace }), ownerToken(), 'generate');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Check your authenticator code again first.', code: 'mfa_required' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('refuses any action but generate or revoke, and changes nothing (a typo never replaces codes)', async () => {
    await call(dbDeps(), ownerToken(), 'generate');
    const before = await codesOf(OWNER_ID);
    for (const action of ['regenerate', 'Revoke', '', null, undefined, 1]) {
      expect((await call(dbDeps(), ownerToken(), action)).status).toBe(400);
    }
    expect(await codesOf(OWNER_ID)).toEqual(before);
  });

  it('will not make codes for an account with no second factor', async () => {
    await db.query('DELETE FROM auth.mfa_factors WHERE user_id = $1', [OWNER_ID]);
    const res = await call(dbDeps(), ownerToken(), 'generate');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('no_verified_factor');
    expect(await codesOf(OWNER_ID)).toHaveLength(0);
  });

  it('revoke deletes the set and audits it', async () => {
    await call(dbDeps(), ownerToken(), 'generate');
    const res = await call(dbDeps(), ownerToken(), 'revoke');
    expect(res.status).toBe(200);
    expect(await codesOf(OWNER_ID)).toHaveLength(0);
    expect((await db.query(`SELECT action FROM public.audit_logs WHERE action = 'mfa_backup_codes_revoked'`)).rows).toHaveLength(1);
  });

  it('never replaces a code an in-flight recovery holds', async () => {
    await call(dbDeps(), ownerToken(), 'generate');
    await db.query(`UPDATE public.mfa_backup_codes SET status = 'reserved', reserved_at = now() WHERE id = (SELECT id FROM public.mfa_backup_codes LIMIT 1)`);
    const res = await call(dbDeps(), ownerToken(), 'generate');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('recovery_in_flight');
  });

  it('an older request that finishes after a newer one is refused, not stored', async () => {
    await call(dbDeps(), ownerToken(), 'generate');
    const before = await codesOf(OWNER_ID);
    const res = await call(dbDeps({ nextGeneration: async () => 1 }), ownerToken(), 'generate');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('stale_generation');
    expect(await codesOf(OWNER_ID)).toEqual(before);
  });

  it('generate and revoke have separate limits: five generates an hour never block a revoke', async () => {
    for (let i = 0; i < 5; i++) expect((await call(dbDeps(), ownerToken(), 'generate')).status).toBe(200);
    expect((await call(dbDeps(), ownerToken(), 'generate')).status).toBe(429);
    expect((await call(dbDeps(), ownerToken(), 'revoke')).status).toBe(200);
  });

  it('View as client is refused before anything runs', async () => {
    const revoke = vi.fn();
    const deps = fakeDeps({ revoke });
    const res = await createMfaBackupCodesHandler(deps)(edgeRequest({ headers: CREDENTIALS.viewAsClient, body: { action: 'revoke' } }));
    expect(res.status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });
});
