// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  anon,
  as,
  asOwner,
  asServer,
  count,
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

/**
 * 0009_marketing: `monthly_goals`, the owner's monthly targets and ad spend. The table is the
 * owner's alone: every other principal reads nothing and writes nothing, and the server keeps
 * row access without TRUNCATE.
 */

const GOAL = '90000000-0000-4000-8000-000000000001';
const FORGER = '00000000-0000-4000-8000-00000000000f';

let db: PGlite;
let clientA: Principal;
let clientB: Principal;
const forger = user(FORGER, { appRole: 'admin' }); // signed in, no portal account, forged claim

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'forger@example.test')`, [FORGER]);
  const contactA = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', status: 'client' });
  const contactB = await seedContact(db, { first_name: 'Bo', last_name: 'Example', status: 'client' });
  clientA = user((await seedPortalAccount(db, contactA)).userId);
  clientB = user((await seedPortalAccount(db, contactB)).userId);
  // Seeded here, in a committed transaction, so a later session's now() is a later instant.
  await db.query(
    `INSERT INTO public.monthly_goals (id, month, new_leads_target, closed_clients_target, ad_spend)
     VALUES ($1, '2026-03', 10, 4, 500), (gen_random_uuid(), '2026-04', NULL, NULL, 0)`,
    [GOAL],
  );
}, 60_000);

const insertAs = (who: Principal, month = '2026-09') =>
  as(db, who, `INSERT INTO public.monthly_goals (month, ad_spend) VALUES ($1, 100) RETURNING id`, [month]);

describe('who can read monthly goals', () => {
  it('anon has no access at all', async () => {
    expect(await errorOf(db, anon, 'SELECT 1 FROM public.monthly_goals')).toMatch(/permission denied/);
  });

  it('the owner reads every month', async () => {
    expect(await count(db, asOwner, 'monthly_goals')).toBe(2);
  });

  it('a client, another client and a forged admin claim read nothing', async () => {
    for (const who of [clientA, clientB, forger]) expect(await count(db, who, 'monthly_goals')).toBe(0);
  });

  it('the server reads every month', async () => {
    expect(await count(db, asServer, 'monthly_goals')).toBe(2);
  });

  it('an MFA-enrolled owner at aal1 reads nothing, and at aal2 reads every month', async () => {
    const counts = await session(db, asServer, async (tx) => {
      await tx.exec(`RESET ROLE; INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${OWNER_ID}', 'verified')`);
      const read = async (aal: string) => {
        const claims = JSON.stringify({ sub: OWNER_ID, role: 'authenticated', aal, iat: Math.floor(Date.now() / 1000) });
        await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.exec('SET LOCAL ROLE authenticated');
        const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.monthly_goals')).rows[0].n;
        await tx.exec('RESET ROLE');
        return n;
      };
      return { aal1: await read('aal1'), aal2: await read('aal2') };
    });
    expect(counts).toEqual({ aal1: 0, aal2: 2 });
  });
});

describe('who can write monthly goals', () => {
  it('anon cannot insert, update or delete', async () => {
    await expectDenied(insertAs(anon));
    await expectDenied(as(db, anon, `UPDATE public.monthly_goals SET ad_spend = 1`));
    await expectDenied(as(db, anon, `DELETE FROM public.monthly_goals`));
  });

  it('a client and a forged admin claim cannot insert', async () => {
    for (const who of [clientA, clientB, forger]) await expectDenied(insertAs(who));
  });

  it('a client and a forged admin claim update and delete nothing', async () => {
    for (const who of [clientA, clientB, forger]) {
      expect(await as(db, who, `UPDATE public.monthly_goals SET ad_spend = 1 RETURNING id`)).toEqual([]);
    }
    // No DELETE grant for a signed-in session at all, owner or not.
    for (const who of [clientA, forger]) await expectDenied(as(db, who, `DELETE FROM public.monthly_goals`));
  });

  it('the owner creates a month and edits its targets and spend', async () => {
    expect(await insertAs(asOwner)).toHaveLength(1);
    const rows = await as<{ ad_spend: string; new_leads_target: number }>(db, asOwner,
      `UPDATE public.monthly_goals SET ad_spend = 750.5, new_leads_target = 12, closed_clients_target = NULL
       WHERE id = $1 RETURNING ad_spend, new_leads_target`, [GOAL]);
    expect(rows).toEqual([{ ad_spend: '750.50', new_leads_target: 12 }]);
  });

  it('the owner cannot rename a month or delete one', async () => {
    await expectDenied(as(db, asOwner, `UPDATE public.monthly_goals SET month = '2026-05' WHERE id = $1`, [GOAL]));
    await expectDenied(as(db, asOwner, `DELETE FROM public.monthly_goals WHERE id = $1`, [GOAL]));
  });

  it('the owner cannot set the id or the timestamps', async () => {
    await expectDenied(as(db, asOwner,
      `INSERT INTO public.monthly_goals (id, month) VALUES (gen_random_uuid(), '2026-10')`));
    await expectDenied(as(db, asOwner, `UPDATE public.monthly_goals SET created_at = now() WHERE id = $1`, [GOAL]));
  });

  it('the server has row access but cannot TRUNCATE', async () => {
    expect(await insertAs(asServer)).toHaveLength(1);
    expect(await as(db, asServer, `DELETE FROM public.monthly_goals WHERE id = $1 RETURNING id`, [GOAL])).toHaveLength(1);
    expect(await errorOf(db, asServer, 'TRUNCATE public.monthly_goals')).toMatch(/permission denied/);
  });
});

describe('the monthly_goals row', () => {
  it("a month is 'YYYY-MM' and nothing else", async () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', '']) {
      expect(await errorOf(db, asOwner, `INSERT INTO public.monthly_goals (month) VALUES ($1)`, [bad]), bad)
        .toMatch(/check constraint/);
    }
  });

  it('a month has one row', async () => {
    expect(await errorOf(db, asOwner, `INSERT INTO public.monthly_goals (month) VALUES ('2026-03')`))
      .toMatch(/duplicate key/);
  });

  it('a target or a spend below zero is refused', async () => {
    for (const column of ['new_leads_target', 'closed_clients_target', 'ad_spend']) {
      expect(await errorOf(db, asOwner, `UPDATE public.monthly_goals SET ${column} = -1 WHERE id = $1`, [GOAL]), column)
        .toMatch(/check constraint/);
    }
  });

  it('a spend-only row has no targets: NULL, never a target of zero', async () => {
    const rows = await as(db, asOwner,
      `INSERT INTO public.monthly_goals (month, ad_spend) VALUES ('2026-11', 250)
       RETURNING new_leads_target, closed_clients_target, ad_spend`);
    expect(rows).toEqual([{ new_leads_target: null, closed_clients_target: null, ad_spend: '250.00' }]);
  });

  it('a row with no spend named spends zero', async () => {
    const rows = await as(db, asOwner,
      `INSERT INTO public.monthly_goals (month, new_leads_target) VALUES ('2026-12', 5) RETURNING ad_spend`);
    expect(rows).toEqual([{ ad_spend: '0.00' }]);
  });

  it('updated_at moves on every update', async () => {
    const rows = await session(db, asOwner, async (tx) => {
      await tx.exec(`SELECT pg_sleep(0.01)`);
      return (await tx.query<{ moved: boolean }>(
        `UPDATE public.monthly_goals SET ad_spend = 1 WHERE id = '${GOAL}' RETURNING updated_at = now() AND updated_at > created_at AS moved`,
      )).rows;
    });
    expect(rows).toEqual([{ moved: true }]);
  });

  it('carries the restrictive MFA gate on both clauses', async () => {
    const { rows } = await db.query<{ polname: string }>(
      `SELECT p.polname FROM pg_policy p
       WHERE p.polrelid = 'public.monthly_goals'::regclass AND NOT p.polpermissive
         AND pg_get_expr(p.polqual, p.polrelid) LIKE '%mfa_session_ok()%'
         AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%mfa_session_ok()%'`);
    expect(rows.map((r) => r.polname)).toEqual(['monthly_goals_mfa_gate']);
  });
});
