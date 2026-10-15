// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import { forceSql, refusalIn, withForce } from '../../../scripts/demo-seed.mjs';

/**
 * supabase/seed/demo.sql, the fictional demo data `npm run demo:seed` loads: it applies on
 * top of every migration, a second run changes nothing, it creates no sign-in accounts or
 * storage objects, and it refuses a project that already holds contacts of its own unless
 * forced. The repository-wide scan in zeroFirmStrings.test.ts reads the file for firm
 * strings like every other file (importing it here would run that scan twice).
 */

const SEED_PATH = path.resolve(__dirname, '..', '..', '..', 'supabase', 'seed', 'demo.sql');
const SEED = readFileSync(SEED_PATH, 'utf8');

/** Rows the seed owns, by table: its ids all start dd0000NN-. */
const EXPECTED: Record<string, number> = {
  contacts: 12,
  organizations: 9,
  contact_services: 10,
  contact_upsells: 3,
  contact_notes: 5,
  work_items: 6,
  work_item_events: 6,
  client_messages: 3,
  needs_lists: 2,
  needs_items: 6,
  esign_envelopes: 1,
  esign_envelope_signers: 1,
  monthly_goals: 2,
};

/** Rows the seed causes elsewhere, or must leave alone. */
const SIDE_TABLES = ['contact_emails', 'lead_sources', 'work_item_types', 'request_categories', 'audit_logs'];

async function snapshot(db: PGlite): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [...Object.keys(EXPECTED), ...SIDE_TABLES]) {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
    out[table] = rows[0].n;
  }
  const users = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auth.users');
  const objects = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM storage.objects');
  out['auth.users'] = users.rows[0].n;
  out['storage.objects'] = objects.rows[0].n;
  return out;
}

async function errorOfExec(db: PGlite, sql: string): Promise<string | null> {
  try {
    await db.exec(sql);
    return null;
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => undefined);
    return (err as Error).message;
  }
}

describe('the demo seed', () => {
  let db: PGlite;
  let before: Record<string, number>;
  let afterFirst: Record<string, number>;

  beforeAll(async () => {
    db = await createDb();
    await seedCore(db);
    before = await snapshot(db);
    await db.exec(SEED);
    afterFirst = await snapshot(db);
  }, 60_000);

  it('loads every table it names, with the counts the file states', () => {
    for (const [table, n] of Object.entries(EXPECTED)) {
      expect(afterFirst[table] - before[table], table).toBe(n);
    }
    // Each contact's email reaches contact_emails through the mirror trigger.
    expect(afterFirst.contact_emails - before.contact_emails).toBe(12);
    expect(afterFirst.lead_sources - before.lead_sources).toBe(2);
    expect(afterFirst.work_item_types - before.work_item_types).toBe(1);
    expect(afterFirst.request_categories - before.request_categories).toBe(1);
  });

  it('creates no sign-in account and no storage object', () => {
    expect(afterFirst['auth.users']).toBe(before['auth.users']);
    expect(afterFirst['storage.objects']).toBe(before['storage.objects']);
  });

  it('a second run changes nothing, the draft envelope revision included', async () => {
    const revision = async () =>
      (await db.query<{ r: number }>(`SELECT draft_revision AS r FROM public.esign_envelopes WHERE id = 'dd00000a-0000-4000-8000-000000000001'`)).rows[0].r;
    const firstRevision = await revision();
    await db.exec(SEED);
    expect(await snapshot(db)).toEqual(afterFirst);
    expect(await revision()).toBe(firstRevision);
  });

  it('every row is plainly fictional: example.test addresses and 555-01xx numbers', async () => {
    const { rows } = await db.query<{ email: string; phone: string }>(
      `SELECT email, phone FROM public.contacts WHERE id::text LIKE 'dd000001-%'`,
    );
    for (const r of rows) {
      expect(r.email).toMatch(/@example\.test$/);
      expect(r.phone).toMatch(/^555-01\d\d$/);
    }
  });

  it('holds a sent and a draft request, owner-only messages and a draft envelope with no documents', async () => {
    const lists = await db.query<{ status: string }>(`SELECT status FROM public.needs_lists WHERE id::text LIKE 'dd000008-%' ORDER BY status`);
    expect(lists.rows.map((r) => r.status)).toEqual(['draft', 'sent']);
    const roles = await db.query<{ sender_role: string }>(`SELECT DISTINCT sender_role FROM public.client_messages`);
    expect(roles.rows).toEqual([{ sender_role: 'owner' }]);
    const env = await db.query<{ status: string; docs: number }>(
      `SELECT e.status, (SELECT count(*)::int FROM public.esign_envelope_documents d WHERE d.envelope_id = e.id) AS docs
       FROM public.esign_envelopes e WHERE e.id::text LIKE 'dd00000a-%'`,
    );
    expect(env.rows).toEqual([{ status: 'draft', docs: 0 }]);
  });

});

describe('the demo seed refuses', () => {
  it('a project with no owner yet', async () => {
    const db = await createDb();
    expect(await errorOfExec(db, SEED)).toMatch(/no owner yet/);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.contacts');
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it('a project holding contacts of its own, and loads when forced', async () => {
    const db = await createDb();
    await seedCore(db);
    await seedContact(db, { first_name: 'Own', last_name: 'Contact' });
    expect(await errorOfExec(db, SEED)).toMatch(/already has 1 contact/);
    const count = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.contacts')).rows[0].n;
    expect(await count()).toBe(1);

    await db.exec(withForce(SEED));
    expect(await count()).toBe(13);
  }, 60_000);

  it('the force line is the one the file documents', () => {
    expect(SEED).toContain(forceSql());
  });

  it('the script reports a refusal alone, and anything else as a connection failure', async () => {
    const db = await createDb();
    const message = await errorOfExec(db, SEED);
    expect(refusalIn(`ERROR:  P0001: ${message}\nCONTEXT: PL/pgSQL function inline_code_block`)).toBe(message);
    expect(refusalIn('Cannot find project ref. Have you run supabase link?')).toBeNull();
  }, 60_000);
});
