// @vitest-environment node
// 0010_email: who may read and write the group email tables, the address normalization
// every write path goes through, and the server RPCs the two edge functions call.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMAILABLE_STATUSES as BROWSER_EMAILABLE } from '@/lib/contactStatus';
import { EMAILABLE_STATUSES as EDGE_EMAILABLE } from '../../../supabase/functions/crm-send-group-email/handler';
import { anon, as, createDb, errorOf, expectDenied, service, session, tryIn, user } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const CONTACT_A = '10000000-0000-4000-8000-00000000000a';
const CONTACT_B = '10000000-0000-4000-8000-00000000000b';
const CAMPAIGN = '40000000-0000-4000-8000-000000000001';
const KEY = '50000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

const owner = user(OWNER);
const clientA = user(USER_A);
const clientB = user(USER_B);

const TABLES = ['crm_email_campaigns', 'crm_email_recipients', 'email_suppressions', 'email_unsubscribe_tokens'] as const;
/** What the owner may read; the tokens are nobody's to read. */
const OWNER_READS = ['crm_email_campaigns', 'crm_email_recipients', 'email_suppressions'];

/** A statement per table that would write one row, for the refusal matrix. */
const WRITES: Record<(typeof TABLES)[number], { insert: string; update: string; del: string }> = {
  crm_email_campaigns: {
    insert: `INSERT INTO public.crm_email_campaigns (subject, body, from_identity) VALUES ('S', 'B', 'Example Co')`,
    update: `UPDATE public.crm_email_campaigns SET subject = 'X' RETURNING id`,
    del: `DELETE FROM public.crm_email_campaigns RETURNING id`,
  },
  crm_email_recipients: {
    insert: `INSERT INTO public.crm_email_recipients (campaign_id, address) VALUES ('${CAMPAIGN}', 'new@example.com')`,
    update: `UPDATE public.crm_email_recipients SET status = 'sent' RETURNING id`,
    del: `DELETE FROM public.crm_email_recipients RETURNING id`,
  },
  email_suppressions: {
    insert: `INSERT INTO public.email_suppressions (address) VALUES ('new@example.com')`,
    update: `UPDATE public.email_suppressions SET reason = 'manual' RETURNING id`,
    del: `DELETE FROM public.email_suppressions RETURNING id`,
  },
  email_unsubscribe_tokens: {
    insert: `INSERT INTO public.email_unsubscribe_tokens (token_hash, address, expires_at) VALUES ('${'b'.repeat(64)}', 'x@example.com', now())`,
    update: `UPDATE public.email_unsubscribe_tokens SET used_at = now() RETURNING id`,
    del: `DELETE FROM public.email_unsubscribe_tokens RETURNING id`,
  },
};

const RPCS = [
  'group_email_begin(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,integer)',
  'group_email_replay(uuid)',
  'group_email_claim(uuid,text,text[])',
  'group_email_record(uuid,text,text,text,text)',
  'group_email_finish(uuid,integer,integer,integer,integer)',
  'email_unsubscribe_lookup(text)',
  'email_unsubscribe_confirm(text)',
];

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.com'), ('${SYSTEM}', 'system@example.com'),
      ('${USER_A}', 'ada@example.com'), ('${USER_B}', 'grace@example.com');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, email, status) VALUES
      ('${CONTACT_A}', 'Ada', 'Lovelace', 'ada@example.com', 'client'),
      ('${CONTACT_B}', 'Grace', 'Hopper', 'grace@example.com', 'client');
    INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES
      ('${CONTACT_A}', '${USER_A}', 'active', 'ada@example.com'),
      ('${CONTACT_B}', '${USER_B}', 'active', 'grace@example.com');
    INSERT INTO public.crm_email_campaigns (id, subject, body, from_identity, idempotency_key)
      VALUES ('${CAMPAIGN}', 'Hello', 'Body', 'Example Co', '${KEY}');
    INSERT INTO public.crm_email_recipients (campaign_id, contact_id, address, status)
      VALUES ('${CAMPAIGN}', '${CONTACT_A}', 'ada@example.com', 'sent');
    INSERT INTO public.email_suppressions (address) VALUES ('gone@example.com');
    INSERT INTO public.email_unsubscribe_tokens (token_hash, address, campaign_id, expires_at)
      VALUES ('${HASH}', 'ada@example.com', '${CAMPAIGN}', now() + interval '90 days');
  `);
}, 60_000);

const rowsOf = async (who: Parameters<typeof as>[1], table: string) =>
  (await as<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM public.${table}`))[0].n;

describe('reads', () => {
  it('the owner reads the send log and the suppressions, and no token', async () => {
    for (const t of OWNER_READS) expect([t, await rowsOf(owner, t)]).toEqual([t, 1]);
    await expectDenied(as(db, owner, `SELECT * FROM public.email_unsubscribe_tokens`));
  });

  it('a client, another client and anon read nothing, and anon is refused outright', async () => {
    for (const t of OWNER_READS) {
      expect([t, await rowsOf(clientA, t)]).toEqual([t, 0]);
      expect([t, await rowsOf(clientB, t)]).toEqual([t, 0]);
    }
    for (const t of TABLES) await expectDenied(as(db, anon, `SELECT * FROM public.${t}`));
    await expectDenied(as(db, clientA, `SELECT * FROM public.email_unsubscribe_tokens`));
  });

  it('the server reads every table', async () => {
    for (const t of TABLES) expect([t, await rowsOf(service, t)]).toEqual([t, 1]);
  });

  it('an owner who has enrolled MFA reads nothing at aal1 (the restrictive gate)', async () => {
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER]);
    try {
      for (const t of OWNER_READS) expect([t, await rowsOf(owner, t)]).toEqual([t, 0]);
      expect(await rowsOf(user(OWNER, { aal: 'aal2' }), 'crm_email_campaigns')).toBe(1);
    } finally {
      await db.query(`DELETE FROM auth.mfa_factors WHERE user_id = $1`, [OWNER]);
    }
  });
});

describe('writes', () => {
  it('no signed-in session writes any table: the owner, either client or anon', async () => {
    for (const t of TABLES) {
      for (const who of [owner, clientA, clientB, anon]) {
        await expectDenied(as(db, who, WRITES[t].insert));
        await expectDenied(as(db, who, WRITES[t].update));
        await expectDenied(as(db, who, WRITES[t].del));
      }
    }
  });

  it('the owner cannot erase an opt-out, and neither can the server', async () => {
    await expectDenied(as(db, owner, `DELETE FROM public.email_suppressions WHERE address = 'gone@example.com'`));
    await expectDenied(as(db, service, `DELETE FROM public.email_suppressions WHERE address = 'gone@example.com'`));
    await expectDenied(as(db, service, `UPDATE public.email_suppressions SET address = 'back@example.com'`));
    await expectDenied(as(db, service, `TRUNCATE public.email_suppressions`));
  });

  it('the server writes campaigns, recipients and tokens, and adds suppressions', async () => {
    await session(db, service, async (tx) => {
      for (const t of TABLES) expect([t, await tryIn(tx, WRITES[t].insert)]).toEqual([t, null]);
      for (const t of ['crm_email_campaigns', 'crm_email_recipients', 'email_unsubscribe_tokens'] as const) {
        expect([t, await tryIn(tx, WRITES[t].update)]).toEqual([t, null]);
        expect([t, await tryIn(tx, WRITES[t].del)]).toEqual([t, null]);
      }
    });
  });
});

describe('functions', () => {
  const can = async (role: string, sig: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `public.${sig}`])).rows[0].ok;

  it('every RPC is the server\'s alone: anon and every signed-in session are refused', async () => {
    for (const sig of RPCS) {
      expect([sig, await can('service_role', sig)]).toEqual([sig, true]);
      expect([sig, await can('authenticated', sig)]).toEqual([sig, false]);
      expect([sig, await can('anon', sig)]).toEqual([sig, false]);
    }
    expect(await errorOf(db, owner, `SELECT public.email_unsubscribe_confirm($1)`, [HASH])).toMatch(/permission denied/);
    expect(await errorOf(db, clientA, `SELECT public.group_email_replay($1)`, [KEY])).toMatch(/permission denied/);
  });

  it('nobody executes the trigger function directly, and the trigger still fires for the server', async () => {
    for (const role of ['service_role', 'authenticated', 'anon']) expect(await can(role, 'normalize_email_address()')).toBe(false);
    const [row] = await as<{ address: string }>(db, service,
      `INSERT INTO public.email_suppressions (address) VALUES ('  Mixed@Example.COM\t') RETURNING address`);
    expect(row.address).toBe('mixed@example.com');
  });
});

describe('addresses are normalized on every write path', () => {
  it('trims any whitespace and lower-cases, on all three address tables, inserts and updates', async () => {
    await session(db, service, async (tx) => {
      const ins = async (sql: string) => ((await tx.query<{ address: string }>(sql)).rows[0]).address;
      expect(await ins(`INSERT INTO public.email_suppressions (address) VALUES (E'\\t Foo@Example.COM \\n') RETURNING address`)).toBe('foo@example.com');
      expect(await ins(`INSERT INTO public.crm_email_recipients (campaign_id, address) VALUES ('${CAMPAIGN}', E' Bar@EXAMPLE.com\\t') RETURNING address`)).toBe('bar@example.com');
      expect(await ins(`INSERT INTO public.email_unsubscribe_tokens (token_hash, address, expires_at) VALUES ('${'c'.repeat(64)}', ' Baz@Example.com', now()) RETURNING address`)).toBe('baz@example.com');
      expect(await ins(`UPDATE public.crm_email_recipients SET address = 'QUX@example.com' WHERE address = 'bar@example.com' RETURNING address`)).toBe('qux@example.com');
    });
  });

  it('so a differently-cased opt-out collides with the existing one', async () => {
    expect(await errorOf(db, service, `INSERT INTO public.email_suppressions (address) VALUES ('GONE@example.com')`)).toMatch(/duplicate key/);
  });
});

describe('constraints', () => {
  it('one row per address per campaign, whatever the case', async () => {
    expect(await errorOf(db, service,
      `INSERT INTO public.crm_email_recipients (campaign_id, address) VALUES ('${CAMPAIGN}', 'ADA@example.com')`)).toMatch(/duplicate key/);
  });

  it('a recipient may be sending or unknown, and nothing outside the lifecycle', async () => {
    await session(db, service, async (tx) => {
      expect(await tryIn(tx, `UPDATE public.crm_email_recipients SET status = 'sending'`)).toBeNull();
      expect(await tryIn(tx, `UPDATE public.crm_email_recipients SET status = 'unknown'`)).toBeNull();
      expect(await tryIn(tx, `UPDATE public.crm_email_recipients SET status = 'bounced'`)).toMatch(/check constraint/);
    });
  });

  it('an idempotency key is used once; campaigns without one coexist', async () => {
    const insert = (key: string | null) =>
      `INSERT INTO public.crm_email_campaigns (subject, body, from_identity, idempotency_key) VALUES ('S', 'B', 'F', ${key ? `'${key}'` : 'NULL'})`;
    expect(await errorOf(db, service, insert(KEY))).toMatch(/duplicate key/);
    await session(db, service, async (tx) => {
      expect(await tryIn(tx, insert(null))).toBeNull();
      expect(await tryIn(tx, insert(null))).toBeNull();
    });
  });

  it('a subject is one line', async () => {
    expect(await errorOf(db, service,
      `INSERT INTO public.crm_email_campaigns (subject, body, from_identity) VALUES (E'Hi\\nBcc: x', 'B', 'F')`)).toMatch(/check constraint/);
  });

  it('a token is stored as its SHA-256 only', async () => {
    expect(await errorOf(db, service,
      `INSERT INTO public.email_unsubscribe_tokens (token_hash, address, expires_at) VALUES ('raw-token', 'x@example.com', now())`)).toMatch(/check constraint/);
  });

  it('deleting a contact takes its send-log rows with it and keeps every opt-out', async () => {
    await session(db, service, async (tx) => {
      await tx.exec('RESET ROLE');
      await tx.query(`INSERT INTO public.email_suppressions (address) VALUES ('ada@example.com')`);
      await tx.query(`INSERT INTO public.crm_email_recipients (campaign_id, contact_id, address, status)
        VALUES ($1, $2, 'grace@example.com', 'sent')`, [CAMPAIGN, CONTACT_B]);
      await tx.query(`DELETE FROM public.client_portal_accounts WHERE contact_id = $1`, [CONTACT_A]);
      await tx.query(`DELETE FROM public.contacts WHERE id = $1`, [CONTACT_A]);
      const left = (await tx.query<{ address: string }>(
        `SELECT address FROM public.crm_email_recipients WHERE campaign_id = $1 ORDER BY address`, [CAMPAIGN])).rows;
      expect(left).toEqual([{ address: 'grace@example.com' }]);
      expect((await tx.query(`SELECT 1 FROM public.crm_email_campaigns WHERE id = $1`, [CAMPAIGN])).rows).toHaveLength(1);
      expect((await tx.query(`SELECT 1 FROM public.email_suppressions WHERE address = 'ada@example.com'`)).rows).toHaveLength(1);
      expect((await tx.query(`SELECT 1 FROM public.email_unsubscribe_tokens WHERE address = 'ada@example.com'`)).rows).toHaveLength(1);
    });
  });
});

describe('group_email_begin', () => {
  const begin = (tx: Parameters<Parameters<typeof session>[2]>[0], key: string, tokens: unknown[]) =>
    tx.query<{ id: string | null }>(
      `SELECT public.group_email_begin($1, $2, 'Subject', 'Body', 'Example Co', null, $3, $4, $5, 1) AS id`,
      [key, OWNER,
        JSON.stringify([{ contact_id: CONTACT_B, address: 'Grace@Example.com' }]),
        JSON.stringify([{ contact_id: CONTACT_A, address: 'other@example.com', reason: 'unsubscribed' }]),
        JSON.stringify(tokens)],
    );

  it('writes the campaign, queued and skipped rows and one token per recipient, together', async () => {
    await session(db, service, async (tx) => {
      const key = '50000000-0000-4000-8000-000000000002';
      const [{ id }] = (await begin(tx, key, [{ token_hash: 'd'.repeat(64), address: 'grace@example.com' }])).rows;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const rows = (await tx.query(`SELECT address, status, error FROM public.crm_email_recipients WHERE campaign_id = $1 ORDER BY address`, [id])).rows;
      expect(rows).toEqual([
        { address: 'grace@example.com', status: 'queued', error: null },
        { address: 'other@example.com', status: 'skipped', error: 'unsubscribed' },
      ]);
      const [c] = (await tx.query(`SELECT status, recipient_count, skipped_count, created_by FROM public.crm_email_campaigns WHERE id = $1`, [id])).rows;
      expect(c).toEqual({ status: 'sending', recipient_count: 1, skipped_count: 1, created_by: OWNER });
      // The same key again: nothing new, and NULL tells the caller to replay.
      expect((await begin(tx, key, [{ token_hash: 'e'.repeat(64), address: 'grace@example.com' }])).rows[0].id).toBeNull();
    });
  });

  it('writes nothing at all when a recipient would have no unsubscribe token', async () => {
    const key = '50000000-0000-4000-8000-000000000003';
    expect(await errorOf(db, service,
      `SELECT public.group_email_begin($1, $2, 'S', 'B', 'F', null, $3, '[]', '[]', 0)`,
      [key, OWNER, JSON.stringify([{ contact_id: CONTACT_B, address: 'grace@example.com' }])])).toMatch(/unsubscribe token/);
    const [{ n }] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.crm_email_campaigns WHERE idempotency_key = $1`, [key])).rows;
    expect(n).toBe(0);
  });
});

describe('the unsubscribe RPCs', () => {
  it('lookup only asks; confirm suppresses the address and stamps the token, once', async () => {
    await session(db, service, async (tx) => {
      const lookup = async () => (await tx.query<{ s: string }>(`SELECT public.email_unsubscribe_lookup($1) AS s`, [HASH])).rows[0].s;
      const confirm = async () => (await tx.query<{ s: string }>(`SELECT public.email_unsubscribe_confirm($1) AS s`, [HASH])).rows[0].s;
      const suppressed = async () => (await tx.query(`SELECT 1 FROM public.email_suppressions WHERE address = 'ada@example.com'`)).rows.length;
      expect(await lookup()).toBe('confirm');
      expect(await lookup()).toBe('confirm');
      expect(await suppressed()).toBe(0);
      expect(await confirm()).toBe('unsubscribed');
      expect(await suppressed()).toBe(1);
      const [first] = (await tx.query<{ used_at: string }>(`SELECT used_at FROM public.email_unsubscribe_tokens WHERE token_hash = $1`, [HASH])).rows;
      expect(first.used_at).not.toBeNull();
      expect(await confirm()).toBe('unsubscribed');
      expect(await lookup()).toBe('unsubscribed');
      const [again] = (await tx.query<{ used_at: string }>(`SELECT used_at FROM public.email_unsubscribe_tokens WHERE token_hash = $1`, [HASH])).rows;
      expect(again.used_at).toEqual(first.used_at);
    });
  });

  it('an unknown token reads invalid and writes nothing', async () => {
    await session(db, service, async (tx) => {
      expect((await tx.query<{ s: string }>(`SELECT public.email_unsubscribe_confirm($1) AS s`, ['f'.repeat(64)])).rows[0].s).toBe('invalid');
      expect((await tx.query<{ s: string }>(`SELECT public.email_unsubscribe_lookup($1) AS s`, ['f'.repeat(64)])).rows[0].s).toBe('invalid');
      expect((await tx.query(`SELECT 1 FROM public.email_suppressions`)).rows).toHaveLength(1);
    });
  });

  it('an expired token still opts out: expires_at is retention, not access', async () => {
    await session(db, service, async (tx) => {
      await tx.query(`UPDATE public.email_unsubscribe_tokens SET expires_at = now() - interval '1 year' WHERE token_hash = $1`, [HASH]);
      expect((await tx.query<{ s: string }>(`SELECT public.email_unsubscribe_confirm($1) AS s`, [HASH])).rows[0].s).toBe('unsubscribed');
    });
  });
});

describe('who may be emailed', () => {
  it('the browser, the edge function and the seeded statuses agree: every status but lost and the system ones', async () => {
    const keys = (await db.query<{ key: string }>(`SELECT key FROM public.contact_statuses ORDER BY sort_order`)).rows.map((r) => r.key);
    const expected = keys.filter((k) => k !== 'lost' && k !== 'esign_signer');
    expect([...EDGE_EMAILABLE].sort()).toEqual([...expected].sort());
    expect([...BROWSER_EMAILABLE].sort()).toEqual([...expected].sort());
  });

  it('the address group email reads (contacts.email) follows the default primary address', async () => {
    await session(db, service, async (tx) => {
      await tx.exec('RESET ROLE');
      const email = async () => (await tx.query<{ email: string | null }>(`SELECT email FROM public.contacts WHERE id = $1`, [CONTACT_B])).rows[0].email;
      const [{ id }] = (await tx.query<{ id: string }>(
        `INSERT INTO public.contact_emails (contact_id, email, kind, is_default) VALUES ($1, 'grace.new@example.com', 'primary', false) RETURNING id`,
        [CONTACT_B])).rows;
      expect(await email()).toBe('grace@example.com');
      await tx.query(`UPDATE public.contact_emails SET is_default = false WHERE contact_id = $1 AND is_default`, [CONTACT_B]);
      await tx.query(`UPDATE public.contact_emails SET is_default = true WHERE id = $1`, [id]);
      expect(await email()).toBe('grace.new@example.com');
      await tx.query(`DELETE FROM public.contact_emails WHERE contact_id = $1`, [CONTACT_B]);
      expect(await email()).toBeNull();
    });
  });
});
