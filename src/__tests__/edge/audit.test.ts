// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/harness';
import { assertAuditDetails, createAudit, type AuditClient } from '../../../supabase/functions/_shared/audit';
import { serviceClient } from './pgliteClient';

const OWNER = '00000000-0000-4000-8000-0000000000d1';
const SYSTEM = '00000000-0000-4000-8000-0000000000d2';
const CONTACT = '10000000-0000-4000-8000-0000000000d1';

describe('createAudit against 0001 audit_logs', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test');
      INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER}', '${SYSTEM}');
    `);
  }, 60_000);

  const rowsFor = async (action: string) =>
    (
      await db.query<{ user_id: string; details: unknown; ip_address: string | null; user_agent: string | null }>(
        `SELECT user_id, details, host(ip_address) AS ip_address, user_agent FROM public.audit_logs WHERE action = $1`,
        [action],
      )
    ).rows;

  it('records the human actor, the details as jsonb, and a valid address', async () => {
    const audit = createAudit({ db: serviceClient(db) });
    await audit.write({
      actorId: OWNER,
      action: 'contact_deleted',
      details: { contact_id: CONTACT, portal_users_removed: 2, orphaned_sign_ins: [], source: 'owner' },
      ip: '203.0.113.5',
      userAgent: 'x'.repeat(600),
    });
    const [row] = await rowsFor('contact_deleted');
    expect(row.user_id).toBe(OWNER);
    expect(row.details).toEqual({ contact_id: CONTACT, portal_users_removed: 2, orphaned_sign_ins: [], source: 'owner' });
    expect(row.ip_address).toBe('203.0.113.5');
    expect(row.user_agent).toHaveLength(512);
  });

  it('falls back to the system actor when no human acted, and drops an address Postgres would refuse', async () => {
    const audit = createAudit({ db: serviceClient(db) });
    await audit.write({ action: 'job.swept', details: { swept: 3 }, ip: '01.2.3.4' });
    const [row] = await rowsFor('job.swept');
    expect(row).toMatchObject({ user_id: SYSTEM, ip_address: null });
  });
});

describe('assertAuditDetails: ids and codes only', () => {
  it('accepts ids, counts, flags, null, lowercase codes and short lists of them', () => {
    expect(() =>
      assertAuditDetails({ contact_id: CONTACT, count: 3, ok: true, none: null, kind: 'esign.completed', ids: [CONTACT, CONTACT] }),
    ).not.toThrow();
  });

  it.each([
    ['a name', { signer: 'Ada Example' }],
    ['an email', { to: 'ada@example.test' }],
    ['a digit run', { phone: '5550104477' }],
    ['a nested object', { meta: { a: 1 } }],
    ['a list with free text', { names: ['Ada Example'] }],
    ['a long list', { ids: Array.from({ length: 101 }, () => CONTACT) }],
    ['an infinite number', { n: Number.POSITIVE_INFINITY }],
    ['a key that is not an identifier', { 'Contact Id': CONTACT }],
  ])('refuses %s', (_label, details) => {
    expect(() => assertAuditDetails(details as Record<string, unknown>)).toThrow(TypeError);
  });
});

describe('createAudit: refusals and the system actor cache', () => {
  function fake(systemUserId: unknown = SYSTEM, insertError: unknown = null) {
    const calls: string[] = [];
    const db: AuditClient = {
      from: (table: string) => ({
        insert: async () => {
          calls.push(`insert ${table}`);
          return { error: insertError };
        },
        select: () => ({
          maybeSingle: async () => {
            calls.push(`select ${table}`);
            return { data: { system_user_id: systemUserId }, error: null };
          },
        }),
      }),
    };
    return { db, calls };
  }

  it('checks the entry before touching the database', async () => {
    const f = fake();
    const audit = createAudit({ db: f.db });
    await expect(audit.write({ action: 'Contact Deleted' })).rejects.toThrow(TypeError);
    await expect(audit.write({ action: 'x', details: { who: 'Ada Example' } })).rejects.toThrow(TypeError);
    await expect(audit.write({ action: 'x', actorId: 'not-a-uuid' })).rejects.toThrow(TypeError);
    expect(f.calls).toEqual([]);
  });

  it('reads the system actor once per isolate', async () => {
    const f = fake();
    const audit = createAudit({ db: f.db });
    await audit.write({ action: 'a' });
    await audit.write({ action: 'b' });
    expect(f.calls).toEqual(['select org_profile', 'insert audit_logs', 'insert audit_logs']);
  });

  it('refuses to write an unattributed row when there is no system actor', async () => {
    await expect(createAudit({ db: fake(null).db }).write({ action: 'a' })).rejects.toThrow(/system actor/);
  });

  it('surfaces an insert error to the caller', async () => {
    await expect(createAudit({ db: fake(SYSTEM, { code: '42501' }).db }).write({ action: 'a' })).rejects.toEqual({ code: '42501' });
  });
});
