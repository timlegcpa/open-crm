// @vitest-environment node
// lead-intake-key: the owner makes, replaces and removes the lead-intake key. The row is
// written to the real table in PGlite, and the key a call returns is the one lead-intake
// then accepts.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, seedCore } from '../db/harness';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { createLeadIntakeKeyHandler, type LeadIntakeKeyDeps } from '../../../supabase/functions/lead-intake-key/handler';
import { createKeyVerifier } from '../../../supabase/functions/lead-intake/key';

function fakeDeps(over: Partial<LeadIntakeKeyDeps> = {}): LeadIntakeKeyDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    userLimit: async () => 'allowed',
    saveKey: async () => {},
    deleteKey: async () => {},
    audit: async () => {},
    ...over,
  };
}

describeEdgeContract({
  name: 'lead-intake-key',
  handler: createLeadIntakeKeyHandler(fakeDeps()),
  failingHandler: createLeadIntakeKeyHandler(fakeDeps({ saveKey: throwInternal })),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { action: 'rotate' }, maxBytes: 1024 },
});

describe('lead-intake-key', () => {
  let db: PGlite;
  let audits: string[];

  beforeEach(async () => {
    db = await createDb();
    await seedCore(db);
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'contract-owner@example.test')`, [OWNER_ID]);
    audits = [];
  }, 60_000);

  const dbDeps = (over: Partial<LeadIntakeKeyDeps> = {}) =>
    fakeDeps({
      async saveKey(row) {
        await db.query(
          `INSERT INTO public.lead_intake_keys (id, key_hash, key_hint, created_by) VALUES (true, $1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, key_hint = EXCLUDED.key_hint,
             created_by = EXCLUDED.created_by, created_at = now()`,
          [row.key_hash, row.key_hint, row.created_by],
        );
      },
      async deleteKey() {
        await db.exec('DELETE FROM public.lead_intake_keys');
      },
      async audit(_owner, action) {
        audits.push(action);
      },
      ...over,
    });

  const call = (handler: (req: Request) => Promise<Response>, action: unknown) =>
    handler(edgeRequest({ headers: CREDENTIALS.owner, body: { action } }));
  const verifierFor = () =>
    createKeyVerifier({
      loadKeyHash: async () => (await db.query<{ key_hash: string }>('SELECT key_hash FROM public.lead_intake_keys')).rows[0]?.key_hash ?? null,
    });

  it('rotate returns a key once and stores only its digest and hint; lead-intake accepts it', async () => {
    const res = await call(createLeadIntakeKeyHandler(dbDeps()), 'rotate');
    expect(res.status).toBe(200);
    const { key, key_hint } = (await res.json()) as { key: string; key_hint: string };
    expect(key).toMatch(/^lik_[A-Za-z0-9_-]{43}$/);
    expect(key_hint).toBe(key.slice(0, 8));
    const [row] = (await db.query<{ key_hash: string; key_hint: string; created_by: string }>('SELECT * FROM public.lead_intake_keys')).rows;
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_hash).not.toContain(key);
    expect(row).toMatchObject({ key_hint, created_by: OWNER_ID });
    expect(await verifierFor().verify(key)).toBe(true);
    expect(audits).toEqual(['lead_intake_key_rotated']);
  });

  it('a second rotate replaces the first key', async () => {
    const handler = createLeadIntakeKeyHandler(dbDeps());
    const first = ((await (await call(handler, 'rotate')).json()) as { key: string }).key;
    const second = ((await (await call(handler, 'rotate')).json()) as { key: string }).key;
    expect(second).not.toBe(first);
    expect(await verifierFor().verify(first)).toBe(false);
    expect(await verifierFor().verify(second)).toBe(true);
  });

  it('revoke removes the key, so every delivery is refused', async () => {
    const handler = createLeadIntakeKeyHandler(dbDeps());
    const key = ((await (await call(handler, 'rotate')).json()) as { key: string }).key;
    expect((await call(handler, 'revoke')).status).toBe(200);
    expect(await verifierFor().verify(key)).toBe(false);
    expect(audits).toEqual(['lead_intake_key_rotated', 'lead_intake_key_revoked']);
  });

  it('refuses an unknown action, and changes nothing', async () => {
    const saveKey = vi.fn();
    const deleteKey = vi.fn();
    for (const action of ['generate', '', null, 1]) {
      const res = await call(createLeadIntakeKeyHandler(dbDeps({ saveKey, deleteKey })), action);
      expect(res.status).toBe(400);
    }
    expect(saveKey).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it('a limited owner is 429 and an unanswerable limiter 503, before anything is written', async () => {
    const saveKey = vi.fn();
    expect((await call(createLeadIntakeKeyHandler(dbDeps({ saveKey, userLimit: async () => 'limited' })), 'rotate')).status).toBe(429);
    expect((await call(createLeadIntakeKeyHandler(dbDeps({ saveKey, userLimit: async () => 'unavailable' })), 'rotate')).status).toBe(503);
    expect(saveKey).not.toHaveBeenCalled();
  });

  it('a failed audit does not fail the rotation', async () => {
    const res = await call(createLeadIntakeKeyHandler(dbDeps({ audit: async () => { throw new Error('audit down'); } })), 'rotate');
    expect(res.status).toBe(200);
  });
});
