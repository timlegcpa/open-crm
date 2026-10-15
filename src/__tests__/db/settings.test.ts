// @vitest-environment node
// 0011_control_center: the lead-intake key and deliveries, lead_intake_record, and the
// public logo bucket. Real policy evaluation in PGlite, for every principal.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  createDb,
  errorOf,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  user,
  type Principal,
} from './harness';

const HASH = 'a'.repeat(64);
const TABLES = ['lead_intake_keys', 'lead_intake_deliveries'] as const;
const MINTED = randomUUID();

let db: PGlite;
let contactA: string;
let clientA: Principal;
let clientB: Principal;
let viewAsClientA: Principal;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactA = await seedContact(db, { email: 'ada@example.com', status: 'client' });
  const contactB = await seedContact(db, { first_name: 'Bo', email: 'bo@example.com', status: 'client' });
  const a = await seedPortalAccount(db, contactA);
  const b = await seedPortalAccount(db, contactB);
  clientA = asClient(a.userId);
  clientB = asClient(b.userId);
  viewAsClientA = asClient(a.userId, { sessionId: MINTED });
  await db.query(
    `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
     VALUES ($1, $2, $3, 'a@example.test', $4)`,
    [OWNER_ID, contactA, a.userId, MINTED],
  );
  await db.query(`INSERT INTO public.lead_intake_keys (key_hash, key_hint, created_by) VALUES ($1, 'lik_abcd', $2)`, [HASH, OWNER_ID]);
  await db.query(`INSERT INTO public.lead_intake_deliveries (external_id, contact_id) VALUES ('seed-1', $1)`, [contactA]);
}, 60_000);

const count = async (who: Principal, table: string) =>
  (await as<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM public.${table}`))[0].n;

describe('who can read the lead-intake tables', () => {
  it('anon has no access at all', async () => {
    for (const t of TABLES) expect(await errorOf(db, asAnon, `SELECT 1 FROM public.${t}`), t).toMatch(/permission denied/);
  });

  it('the owner reads the key hint and date, and the deliveries', async () => {
    expect(await as(db, asOwner, 'SELECT key_hint, created_at IS NOT NULL AS dated FROM public.lead_intake_keys')).toEqual([
      { key_hint: 'lik_abcd', dated: true },
    ]);
    expect(await count(asOwner, 'lead_intake_deliveries')).toBe(1);
  });

  it('the key digest never reaches a signed-in session, the owner included', async () => {
    for (const who of [asOwner, clientA]) {
      await expectDenied(as(db, who, 'SELECT key_hash FROM public.lead_intake_keys'));
      await expectDenied(as(db, who, 'SELECT * FROM public.lead_intake_keys'));
    }
  });

  it('a client, and View as client, read nothing', async () => {
    for (const who of [clientA, clientB, viewAsClientA]) {
      expect(await as(db, who, 'SELECT key_hint FROM public.lead_intake_keys')).toEqual([]);
      expect(await count(who, 'lead_intake_deliveries')).toBe(0);
    }
  });

  it('an owner with an authenticator, at aal1, reads nothing until aal2', async () => {
    const counts = await session(db, asServer, async (tx) => {
      await tx.exec(`RESET ROLE; INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${OWNER_ID}', 'verified')`);
      const read = async (aal: 'aal1' | 'aal2') => {
        await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(user(OWNER_ID, { aal }).claims)]);
        await tx.exec('SET LOCAL ROLE authenticated');
        const keys = (await tx.query<{ n: number }>('SELECT count(key_hint)::int AS n FROM public.lead_intake_keys')).rows[0].n;
        const deliveries = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.lead_intake_deliveries')).rows[0].n;
        await tx.exec('RESET ROLE');
        return keys + deliveries;
      };
      return { aal1: await read('aal1'), aal2: await read('aal2') };
    });
    expect(counts).toEqual({ aal1: 0, aal2: 2 });
  });

  it('the server reads and writes both', async () => {
    expect(await as(db, asServer, 'SELECT key_hash FROM public.lead_intake_keys')).toEqual([{ key_hash: HASH }]);
    expect(await as(db, asServer, `UPDATE public.lead_intake_keys SET key_hint = 'lik_wxyz' RETURNING key_hint`)).toHaveLength(1);
    expect(await as(db, asServer, `DELETE FROM public.lead_intake_deliveries RETURNING id`)).toHaveLength(1);
  });
});

describe('nobody but the server writes them', () => {
  const writes: Array<[string, string]> = [
    ['insert a key', `INSERT INTO public.lead_intake_keys (id, key_hash, key_hint) VALUES (true, '${'b'.repeat(64)}', 'lik_zzzz')`],
    ['replace the key', `UPDATE public.lead_intake_keys SET key_hash = '${'b'.repeat(64)}'`],
    ['delete the key', 'DELETE FROM public.lead_intake_keys'],
    ['record a delivery', `INSERT INTO public.lead_intake_deliveries (external_id) VALUES ('forged-1')`],
    ['move a delivery', 'UPDATE public.lead_intake_deliveries SET contact_id = NULL'],
    ['delete a delivery', 'DELETE FROM public.lead_intake_deliveries'],
  ];

  it.each(writes)('the owner, a client, View as client and anon cannot %s', async (_what, sql) => {
    for (const who of [asOwner, clientA, viewAsClientA, asAnon]) await expectDenied(as(db, who, sql));
  });
});

describe('lead_intake_record: who may call it', () => {
  const sig = 'public.lead_intake_record(text,text,text,text,text,text,text)';
  const can = async (role: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig])).rows[0].ok;

  it('the server only', async () => {
    expect(await can('service_role')).toBe(true);
    expect(await can('authenticated')).toBe(false);
    expect(await can('anon')).toBe(false);
    await expectDenied(as(db, asOwner, `SELECT ${sig.replace(/\(.*/, '')}('x1', 'Ada', null, 'x@example.com', null, null, 'n')`));
    await expectDenied(as(db, clientA, `SELECT ${sig.replace(/\(.*/, '')}('x1', 'Ada', null, 'x@example.com', null, null, 'n')`));
  });
});

describe('lead_intake_record: one delivery, one transaction', () => {
  // A fresh database per case: every case writes, and the record must be exact.
  let fresh: PGlite;
  beforeEach(async () => {
    fresh = await createDb();
    await seedCore(fresh);
  }, 60_000);

  type Result = { status: string; delivery_id?: string; contact_id?: string };

  // as() rolls back; the record must persist across calls, so these run committed.
  async function recordCommitted(externalId: string, email: string, fields: { first?: string; last?: string | null } = {}): Promise<Result> {
    let out!: Result;
    await fresh.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      out = (await tx.query<{ r: Result }>(
        `SELECT public.lead_intake_record($1, $2, $3, $4, '555 0100', 'Acme LLC', $5) AS r`,
        [externalId, fields.first ?? 'Ada', fields.last === undefined ? 'Lovelace' : fields.last, email, `Lead received (delivery ${externalId}).`],
      )).rows[0].r;
    });
    return out;
  }

  const rows = async <T,>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;

  it('a new address: a new_lead contact from lead intake, its delivery, its note and its primary address', async () => {
    const r = await recordCommitted('ext-1', 'ada@example.com');
    expect(r.status).toBe('created');
    const [c] = await rows<{ id: string; status: string; source: string; full_name: string; business_name: string }>(
      'SELECT id, status, source, full_name, business_name FROM public.contacts');
    expect(c).toMatchObject({ id: r.contact_id, status: 'new_lead', source: 'lead_intake', full_name: 'Ada Lovelace', business_name: 'Acme LLC' });
    expect(await rows('SELECT external_id, contact_id FROM public.lead_intake_deliveries')).toEqual([{ external_id: 'ext-1', contact_id: c.id }]);
    expect(await rows('SELECT body, kind, source FROM public.contact_notes')).toEqual([
      { body: 'Lead received (delivery ext-1).', kind: 'note', source: 'lead_intake' },
    ]);
    expect(await rows(`SELECT kind, email FROM public.contact_emails WHERE contact_id = $1`, [c.id])).toEqual([
      { kind: 'primary', email: 'ada@example.com' },
    ]);
  });

  it('no last name is stored as the empty string, so the full name is the first name', async () => {
    await recordCommitted('ext-1', 'ada@example.com', { last: null });
    expect(await rows('SELECT last_name, full_name FROM public.contacts')).toEqual([{ last_name: '', full_name: 'Ada' }]);
  });

  it('the same delivery again changes nothing', async () => {
    await recordCommitted('ext-1', 'ada@example.com');
    expect(await recordCommitted('ext-1', 'ada@example.com')).toEqual({ status: 'replayed' });
    expect(await recordCommitted('ext-1', 'someone-else@example.com')).toEqual({ status: 'replayed' });
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM public.contact_notes')).toEqual([{ n: 1 }]);
  });

  it('a known address, any case, is matched: a note on that contact, no new contact, its source and status kept', async () => {
    const existing = await seedContact(fresh, { email: 'Ada@Example.com', source: 'referral', status: 'client' });
    const r = await recordCommitted('ext-2', 'ada@example.COM');
    expect(r).toMatchObject({ status: 'matched', contact_id: existing });
    expect(await rows('SELECT source, status FROM public.contacts')).toEqual([{ source: 'referral', status: 'client' }]);
    expect(await rows('SELECT contact_id FROM public.contact_notes')).toEqual([{ contact_id: existing }]);
  });

  it('a second primary address of a contact is matched too', async () => {
    const existing = await seedContact(fresh, { email: 'main@example.com' });
    await fresh.query(`INSERT INTO public.contact_emails (contact_id, kind, email) VALUES ($1, 'primary', 'other@example.com')`, [existing]);
    expect(await recordCommitted('ext-3', 'OTHER@example.com')).toMatchObject({ status: 'matched', contact_id: existing });
  });

  it('a spouse address is another person: a new contact, not the spouse record', async () => {
    const existing = await seedContact(fresh, { email: 'main@example.com', spouse_email: 'partner@example.com' });
    const r = await recordCommitted('ext-4', 'partner@example.com');
    expect(r.status).toBe('created');
    expect(r.contact_id).not.toBe(existing);
  });

  it('two deliveries for one new address make one contact with two notes', async () => {
    const first = await recordCommitted('ext-5', 'new@example.com');
    const second = await recordCommitted('ext-6', 'NEW@example.com');
    expect(second).toMatchObject({ status: 'matched', contact_id: first.contact_id });
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM public.contact_notes')).toEqual([{ n: 2 }]);
  });

  it('a redelivery after the owner deleted the contact does not bring it back', async () => {
    const r = await recordCommitted('ext-7', 'gone@example.com');
    await fresh.query('DELETE FROM public.contacts WHERE id = $1', [r.contact_id]);
    expect(await rows('SELECT contact_id FROM public.lead_intake_deliveries')).toEqual([{ contact_id: null }]);
    expect(await recordCommitted('ext-7', 'gone@example.com')).toEqual({ status: 'replayed' });
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 0 }]);
  });

  it('refuses a missing name or address, and writes nothing', async () => {
    for (const [first, email] of [['Ada', ''], ['', 'x@example.com'], ['Ada', '   ']]) {
      const err = await errorOf(fresh, asServer, `SELECT public.lead_intake_record('ext-8', $1, null, $2, null, null, 'n')`, [first, email]);
      expect(err).toMatch(/first name and email are required/);
    }
    expect(await rows('SELECT count(*)::int AS n FROM public.lead_intake_deliveries')).toEqual([{ n: 0 }]);
  });

  it('a failure after the delivery row rolls the delivery back too', async () => {
    // A note over the 10,000-character cap fails the last insert of the transaction.
    const err = await errorOf(fresh, asServer,
      `SELECT public.lead_intake_record('ext-9', 'Ada', null, 'ada@example.com', null, null, $1)`, ['x'.repeat(10_001)]);
    expect(err).toMatch(/check constraint/);
    expect(await rows('SELECT count(*)::int AS n FROM public.lead_intake_deliveries')).toEqual([{ n: 0 }]);
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 0 }]);
  });

  it('an external id outside the restricted set is refused, never cleaned up', async () => {
    for (const bad of ['', ' lead', 'lead\n1', '-lead', 'a'.repeat(129), 'lead/1']) {
      const err = await errorOf(fresh, asServer, `SELECT public.lead_intake_record($1, 'Ada', null, 'ada@example.com', null, null, 'n')`, [bad]);
      expect(err, JSON.stringify(bad)).toMatch(/check constraint/);
    }
  });
});

describe('contacts_lead_intake_email_key', () => {
  it('two lead-intake contacts cannot share an address, in any case; other contacts can', async () => {
    const tx = async (sql: string) => errorOf(db, asServer, sql);
    expect(await tx(`INSERT INTO public.contacts (first_name, email, source) VALUES
      ('A', 'twin@example.com', 'lead_intake'), ('B', 'TWIN@example.com', 'lead_intake')`)).toMatch(/contacts_lead_intake_email_key/);
    expect(await tx(`INSERT INTO public.contacts (first_name, email, source) VALUES
      ('A', 'twin@example.com', 'referral'), ('B', 'TWIN@example.com', 'referral')`)).toBeNull();
  });
});

describe('the logo bucket', () => {
  const upload = `INSERT INTO storage.objects (bucket_id, name) VALUES ('org-assets', 'logo/x.png')`;

  it('is public, images only, at most 1 MiB', async () => {
    expect(await db.query(`SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'org-assets'`).then((r) => r.rows)).toEqual([
      { public: true, file_size_limit: 1048576, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'] },
    ]);
  });

  it('no signed-in session or anon writes it; the server does', async () => {
    for (const who of [asOwner, clientA, viewAsClientA, asAnon]) {
      expect(await errorOf(db, who, upload), JSON.stringify(who.claims ?? who.role)).toMatch(/row-level security|permission denied/);
    }
    expect(await errorOf(db, asServer, upload)).toBeNull();
  });

  it('no signed-in session lists it through the API (the public URL is the way in)', async () => {
    await db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('org-assets', 'logo/seed.png')`);
    for (const who of [asOwner, clientA, clientB]) {
      expect(await as(db, who, `SELECT name FROM storage.objects WHERE bucket_id = 'org-assets'`)).toEqual([]);
    }
  });
});
