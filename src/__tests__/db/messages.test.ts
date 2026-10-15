// @vitest-environment node
// 0004_messages: who may read and write secure messages and the organization's key, by
// real policy evaluation in PGlite. Every fixture is fictional.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asOwner,
  asServer,
  become,
  becomeSuperuser,
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

type Tx = Parameters<Parameters<typeof session>[2]>[0];

// Shapes the browser produces (lengths only; the database never sees plaintext).
const PUBLIC_JWK = `{"kty":"RSA","alg":"RSA-OAEP-256","n":"${'n'.repeat(200)}","e":"AQAB"}`;
const WRAPPED = 'w'.repeat(3200);
const SALT = 'S'.repeat(24);
const IV = 'I'.repeat(16);
const CIPHER = 'c'.repeat(64);
const SEALED_KEY = 'k'.repeat(684);
const MSG_IV = 'v'.repeat(16);

const STRAY_USER = '00000000-0000-4000-8000-0000000000ee';

let db: PGlite;
let contactA: string;
let contactB: string;
let clientA: string;
let clientB: string;
let keyId: string;
let strayKeyId: string;
/** Messages on A's conversation. */
let ownerToA: string;
let aToOwner: string;
/** Messages on B's conversation. */
let ownerToB: string;
let bToOwner: string;

const owner = asOwner;
const asA = () => user(clientA);
const asB = () => user(clientB);

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactA = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', status: 'client' });
  contactB = await seedContact(db, { first_name: 'Bo', last_name: 'Example', status: 'client' });
  clientA = (await seedPortalAccount(db, contactA)).userId;
  clientB = (await seedPortalAccount(db, contactB)).userId;

  // A stray key for someone who is not the owner, written earlier than the owner's: it must
  // never be the key clients encrypt to.
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'stray@example.test')`, [STRAY_USER]);
  strayKeyId = (await db.query<{ id: string }>(
    `INSERT INTO public.organization_keys (owner_user_id, public_key, encrypted_private_key, key_salt, key_iv, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 day') RETURNING id`,
    [STRAY_USER, PUBLIC_JWK, WRAPPED, SALT, IV])).rows[0].id;
  keyId = (await db.query<{ id: string }>(
    `INSERT INTO public.organization_keys (owner_user_id, public_key, encrypted_private_key, key_salt, key_iv)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [OWNER_ID, PUBLIC_JWK, WRAPPED, SALT, IV])).rows[0].id;

  const ownerMsg = async (contact: string, at: string) => (await db.query<{ id: string }>(
    `INSERT INTO public.client_messages (contact_id, sender_id, sender_role, body, created_at)
     VALUES ($1, $2, 'owner', 'Thanks, received.', $3) RETURNING id`, [contact, OWNER_ID, at])).rows[0].id;
  const clientMsg = async (contact: string, sender: string, at: string) => (await db.query<{ id: string }>(
    `INSERT INTO public.client_messages
       (contact_id, sender_id, sender_role, is_encrypted, encrypted_body, encrypted_key, encryption_iv, key_id, created_at)
     VALUES ($1, $2, 'client', true, $3, $4, $5, $6, $7) RETURNING id`,
    [contact, sender, CIPHER, SEALED_KEY, MSG_IV, keyId, at])).rows[0].id;

  aToOwner = await clientMsg(contactA, clientA, '2030-01-01T10:00:00Z');
  ownerToA = await ownerMsg(contactA, '2030-01-01T11:00:00Z');
  bToOwner = await clientMsg(contactB, clientB, '2030-01-02T10:00:00Z');
  ownerToB = await ownerMsg(contactB, '2030-01-01T09:00:00Z');
}, 60_000);

/** A client message as the browser sends it, with any field overridden. */
function clientInsert(fields: Record<string, unknown> = {}): [string, unknown[]] {
  const row: Record<string, unknown> = {
    contact_id: contactA, sender_id: clientA, sender_role: 'client', body: null, is_encrypted: true,
    encrypted_body: CIPHER, encrypted_key: SEALED_KEY, encryption_iv: MSG_IV, key_id: keyId, ...fields,
  };
  const cols = Object.keys(row);
  return [
    `INSERT INTO public.client_messages (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  ];
}

/** An owner reply as the browser sends it. */
function ownerInsert(fields: Record<string, unknown> = {}): [string, unknown[]] {
  return clientInsert({
    sender_id: OWNER_ID, sender_role: 'owner', body: 'See you Tuesday.', is_encrypted: false,
    encrypted_body: null, encrypted_key: null, encryption_iv: null, key_id: null, ...fields,
  });
}

/** Rows a statement changed, as `who`, rolled back. */
function affected(who: Principal, sql: string, params: unknown[] = []): Promise<number> {
  return session(db, who, async (tx) => (await tx.query(sql, params)).affectedRows ?? 0);
}

const ids = async (who: Principal, sql = 'SELECT id FROM public.client_messages ORDER BY id') =>
  (await as<{ id: string }>(db, who, sql)).map((r) => r.id).sort();

describe('reading messages', () => {
  it('a client reads its own conversation and nothing else; the owner and the server read all', async () => {
    expect(await ids(asA())).toEqual([aToOwner, ownerToA].sort());
    expect(await ids(asB())).toEqual([bToOwner, ownerToB].sort());
    expect(await ids(owner)).toEqual([aToOwner, ownerToA, bToOwner, ownerToB].sort());
    expect(await ids(asServer)).toEqual([aToOwner, ownerToA, bToOwner, ownerToB].sort());
  });

  it('anon reads nothing, by grant', async () => {
    await expectDenied(as(db, asAnon, 'SELECT id FROM public.client_messages'));
    await expectDenied(as(db, asAnon, 'SELECT id FROM public.organization_keys'));
  });

  it('a signed-in user with no portal account reads nothing', async () => {
    expect(await ids(user(STRAY_USER))).toEqual([]);
  });

  it('a suspended client reads nothing', async () => {
    const rows = await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'suspended' WHERE user_id = $1`, [clientA]);
      await become(tx, asA());
      return (await tx.query('SELECT id FROM public.client_messages')).rows;
    });
    expect(rows).toEqual([]);
  });
});

describe('a client sending', () => {
  it('may send ciphertext to the current key, on its own contact, as itself', async () => {
    expect(await affected(asA(), ...clientInsert())).toBe(1);
  });

  it('is refused on another contact, as the owner, or as someone else', async () => {
    await expectDenied(as(db, asA(), ...clientInsert({ contact_id: contactB })));
    await expectDenied(as(db, asA(), ...ownerInsert({ sender_id: clientA })));
    await expectDenied(as(db, asA(), ...clientInsert({ sender_id: clientB })));
    await expectDenied(as(db, asA(), ...clientInsert({ sender_id: null })));
  });

  it('is refused plain text (the shape)', async () => {
    await expectDenied(as(db, asA(), ...clientInsert({ body: 'hello', encrypted_body: null, is_encrypted: false })), '23514');
    await expectDenied(as(db, asA(), ...clientInsert({ body: 'hello' })), '23514');
    await expectDenied(as(db, asA(), ...clientInsert({ is_encrypted: false })), '23514');
  });

  it('is refused a key that is not the organization\'s current key', async () => {
    const stray = await expectDenied(as(db, asA(), ...clientInsert({ key_id: strayKeyId })));
    expect(stray.message).toMatch(/current key/);
    await expectDenied(as(db, asA(), ...clientInsert({ key_id: randomUUID() })));
    await expectDenied(as(db, asA(), ...clientInsert({ key_id: null })));
  });

  it('is refused ciphertext outside the bounds', async () => {
    await expectDenied(as(db, asA(), ...clientInsert({ encrypted_body: 'c'.repeat(40_025) })), '23514');
    await expectDenied(as(db, asA(), ...clientInsert({ encrypted_body: 'c'.repeat(23) })), '23514');
    await expectDenied(as(db, asA(), ...clientInsert({ encrypted_key: 'k'.repeat(683) })), '23514');
    await expectDenied(as(db, asA(), ...clientInsert({ encryption_iv: 'v'.repeat(17) })), '23514');
    expect(await affected(asA(), ...clientInsert({ encrypted_body: 'c'.repeat(40_024) }))).toBe(1);
  });

  it('cannot choose the time, the read state or the id (column grants)', async () => {
    await expectDenied(as(db, asA(), ...clientInsert({ created_at: '2001-01-01T00:00:00Z' })));
    await expectDenied(as(db, asA(), ...clientInsert({ read_at: '2001-01-01T00:00:00Z' })));
    await expectDenied(as(db, asA(), ...clientInsert({ id: randomUUID() })));
  });

  it('gets the server time and no read state even past the grants (the stamp trigger)', async () => {
    const row = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec('GRANT INSERT ON public.client_messages TO authenticated');
      await become(tx, asA());
      const [sql, params] = clientInsert({ created_at: '2001-01-01T00:00:00Z', read_at: '2001-01-02T00:00:00Z' });
      const { rows } = await tx.query<{ id: string }>(`${sql} RETURNING id`, params);
      await becomeSuperuser(tx);
      return (await tx.query<{ fresh: boolean; read_at: string | null }>(
        'SELECT created_at = now() AS fresh, read_at FROM public.client_messages WHERE id = $1', [rows[0].id])).rows[0];
    });
    expect(row).toEqual({ fresh: true, read_at: null });
  });

  it('anon cannot send', async () => {
    await expectDenied(as(db, asAnon, ...clientInsert()));
  });
});

describe('the owner sending', () => {
  it('may reply in plain text as itself', async () => {
    expect(await affected(owner, ...ownerInsert())).toBe(1);
  });

  it('is refused as a client, as someone else, or encrypted', async () => {
    await expectDenied(as(db, owner, ...clientInsert({ sender_id: OWNER_ID })));
    await expectDenied(as(db, owner, ...ownerInsert({ sender_id: clientA })));
    await expectDenied(as(db, owner, ...ownerInsert({ encrypted_body: CIPHER })), '23514');
  });

  it('is refused an empty or oversized body', async () => {
    await expectDenied(as(db, owner, ...ownerInsert({ body: '   ' })), '23514');
    await expectDenied(as(db, owner, ...ownerInsert({ body: 'x'.repeat(10_001) })), '23514');
    expect(await affected(owner, ...ownerInsert({ body: 'x'.repeat(10_000) }))).toBe(1);
  });
});

describe('marking read', () => {
  const markRead = (id: string): [string, unknown[]] => ['UPDATE public.client_messages SET read_at = now() WHERE id = $1', [id]];

  /**
   * As `who`: set read_at to each value in turn (statement time differs per step only by
   * the transaction, so "fresh" means now()), then report the stored read_at.
   */
  const readAtAfter = (who: Principal, id: string, values: string[]) =>
    session(db, asServer, async (tx) => {
      await become(tx, who);
      for (const v of values) await tx.query(`UPDATE public.client_messages SET read_at = ${v} WHERE id = $1`, [id]);
      await becomeSuperuser(tx);
      return (await tx.query<{ fresh: boolean; read_at: Date | null; inf: boolean }>(
        `SELECT read_at = now() AS fresh, read_at, read_at = 'infinity'::timestamptz AS inf FROM public.client_messages WHERE id = $1`,
        [id])).rows[0];
    });

  it('stamps the server time whatever time a client or the owner writes', async () => {
    for (const [who, id] of [[asA(), ownerToA], [owner, aToOwner]] as const) {
      expect((await readAtAfter(who, id, [`'2001-01-01T00:00:00Z'`])).fresh).toBe(true);
      expect(await readAtAfter(who, id, [`'infinity'`])).toMatchObject({ fresh: true, inf: false });
      expect((await readAtAfter(who, id, [`now() + interval '10 years'`])).fresh).toBe(true);
    }
  });

  it('keeps a read message read, at its first time: no reset to unread, no re-mark', async () => {
    const first = '2030-03-01T00:00:00Z';
    const run = (who: Principal, id: string, value: string) => session(db, asServer, async (tx) => {
      await tx.query('UPDATE public.client_messages SET read_at = $2 WHERE id = $1', [id, first]);
      await become(tx, who);
      await tx.query(`UPDATE public.client_messages SET read_at = ${value} WHERE id = $1`, [id]);
      await becomeSuperuser(tx);
      return (await tx.query<{ read_at: Date | null }>('SELECT read_at FROM public.client_messages WHERE id = $1', [id])).rows[0].read_at;
    });
    for (const [who, id] of [[asA(), ownerToA], [owner, aToOwner]] as const) {
      for (const value of ['NULL', 'now()', `'2001-01-01T00:00:00Z'`]) {
        expect((await run(who, id, value))?.toISOString()).toBe(new Date(first).toISOString());
      }
    }
  });

  it('the server alone sets read_at as it chooses', async () => {
    const at = await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.client_messages SET read_at = '2001-01-01T00:00:00Z' WHERE id = $1`, [ownerToA]);
      return (await tx.query<{ read_at: Date }>('SELECT read_at FROM public.client_messages WHERE id = $1', [ownerToA])).rows[0].read_at;
    });
    expect(at.toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });

  it('a client marks the owner\'s messages on its own contact, nothing else', async () => {
    expect(await affected(asA(), ...markRead(ownerToA))).toBe(1);
    expect(await affected(asA(), ...markRead(aToOwner))).toBe(0);
    expect(await affected(asA(), ...markRead(ownerToB))).toBe(0);
    expect(await affected(asA(), ...markRead(bToOwner))).toBe(0);
  });

  it('the owner marks clients\' messages, never its own', async () => {
    expect(await affected(owner, ...markRead(aToOwner))).toBe(1);
    expect(await affected(owner, ...markRead(ownerToA))).toBe(0);
  });

  it('no other column moves for a client (the grant)', async () => {
    for (const set of [`body = 'changed'`, `sender_role = 'client'`, `contact_id = '${contactB}'`, `id = gen_random_uuid()`]) {
      await expectDenied(as(db, asA(), `UPDATE public.client_messages SET ${set} WHERE id = $1`, [ownerToA]));
    }
  });

  it('no other column moves for a client even past the grant (the column guard)', async () => {
    const tryAs = (set: string) => session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec('GRANT UPDATE ON public.client_messages TO authenticated');
      await become(tx, asA());
      await tx.query(`UPDATE public.client_messages SET ${set} WHERE id = $1`, [ownerToA]);
    });
    for (const [set, column] of [[`body = 'changed'`, 'body'], ['id = gen_random_uuid()', 'id'], ['created_at = now()', 'created_at']]) {
      const err = await expectDenied(tryAs(set));
      expect(err.message).toBe(`Column client_messages.${column} is not client-writable`);
    }
  });

  it('the owner cannot rewrite a client\'s ciphertext (the grant)', async () => {
    await expectDenied(as(db, owner, `UPDATE public.client_messages SET encrypted_body = $2 WHERE id = $1`, [aToOwner, CIPHER]));
    await expectDenied(as(db, owner, `UPDATE public.client_messages SET body = 'x' WHERE id = $1`, [ownerToA]));
  });

  it('anon cannot mark anything', async () => {
    await expectDenied(as(db, asAnon, ...markRead(ownerToA)));
  });
});

describe('deleting', () => {
  const del = (id: string): [string, unknown[]] => ['DELETE FROM public.client_messages WHERE id = $1', [id]];

  it('only the owner (and the server) delete', async () => {
    expect(await affected(owner, ...del(aToOwner))).toBe(1);
    expect(await affected(owner, ...del(ownerToB))).toBe(1);
    expect(await affected(asServer, ...del(aToOwner))).toBe(1);
    expect(await affected(asA(), ...del(aToOwner))).toBe(0);
    expect(await affected(asA(), ...del(ownerToA))).toBe(0);
    await expectDenied(as(db, asAnon, ...del(aToOwner)));
  });

  it('deleting the contact deletes its messages', async () => {
    const left = await session(db, asServer, async (tx) => {
      await tx.query('DELETE FROM public.contacts WHERE id = $1', [contactB]);
      return (await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.client_messages WHERE contact_id = $1', [contactB])).rows[0].n;
    });
    expect(left).toBe(0);
  });

  it('deleting the sender\'s sign-in keeps the message, without a sender', async () => {
    const row = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.query('DELETE FROM public.client_portal_accounts WHERE user_id = $1', [clientA]);
      await tx.query('DELETE FROM auth.users WHERE id = $1', [clientA]);
      return (await tx.query<{ sender_id: string | null }>(
        'SELECT sender_id FROM public.client_messages WHERE id = $1', [aToOwner])).rows[0];
    });
    expect(row).toEqual({ sender_id: null });
  });
});

describe('the MFA gate', () => {
  it('an MFA-enrolled owner at aal1 reads and writes nothing, and has no inbox', async () => {
    const out = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER_ID]);
      await become(tx, user(OWNER_ID, { aal: 'aal1' }));
      const seen = (await tx.query('SELECT id FROM public.client_messages')).rows.length;
      const keys = (await tx.query('SELECT id FROM public.organization_keys')).rows.length;
      const [sql, params] = ownerInsert();
      await tx.exec('SAVEPOINT s');
      const insert = await tx.query(sql, params).then(() => null, (e: { code?: string }) => e.code);
      await tx.exec('ROLLBACK TO SAVEPOINT s');
      const inbox = await tx.query('SELECT public.admin_list_conversations()').then(() => null, (e: { code?: string }) => e.code);
      return { seen, keys, insert, inbox };
    });
    expect(out).toEqual({ seen: 0, keys: 0, insert: '42501', inbox: '42501' });
  });

  it('the same owner at aal2 reads everything', async () => {
    const seen = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER_ID]);
      await become(tx, user(OWNER_ID, { aal: 'aal2' }));
      return (await tx.query('SELECT id FROM public.client_messages')).rows.length;
    });
    expect(seen).toBe(4);
  });
});

interface Conversation {
  contact_id: string;
  full_name: string;
  business_name: string | null;
  email: string | null;
  last_message_id: string;
  last_message_body: string | null;
  last_message_at: string;
  last_message_sender_role: string;
  unread_count: number;
  message_count: number;
}

const inbox = async (tx: Tx): Promise<Conversation[]> =>
  (await tx.query<{ list: Conversation[] }>('SELECT public.admin_list_conversations() AS list')).rows[0].list;

describe('admin_list_conversations()', () => {
  it('gives the owner one entry per contact, newest activity first, with unread counts', async () => {
    const list = await session(db, owner, inbox);
    expect(list.map((c) => c.contact_id)).toEqual([contactB, contactA]);
    const [b, a] = list;
    expect(b).toMatchObject({
      full_name: 'Bo Example', last_message_id: bToOwner, last_message_sender_role: 'client',
      last_message_body: null, unread_count: 1, message_count: 2,
    });
    expect(a).toMatchObject({
      full_name: 'Ada Lovelace', last_message_id: ownerToA, last_message_sender_role: 'owner',
      last_message_body: 'Thanks, received.', unread_count: 1, message_count: 2,
    });
  });

  it('counts only unread client messages', async () => {
    const list = await session(db, owner, async (tx) => {
      await tx.query('UPDATE public.client_messages SET read_at = now() WHERE id = $1', [aToOwner]);
      return inbox(tx);
    });
    expect(list.find((c) => c.contact_id === contactA)?.unread_count).toBe(0);
  });

  it('breaks a tie on time by the higher id', async () => {
    const [low, high] = [randomUUID(), randomUUID()].sort();
    const at = '2031-01-01T00:00:00Z';
    for (const order of [[low, high], [high, low]]) {
      const list = await session(db, asServer, async (tx) => {
        for (const id of order) {
          await tx.query(
            `INSERT INTO public.client_messages (id, contact_id, sender_id, sender_role, body, created_at)
             VALUES ($1, $2, $3, 'owner', 'Same moment.', $4)`, [id, contactA, OWNER_ID, at]);
        }
        await become(tx, owner);
        return inbox(tx);
      });
      expect(list[0]).toMatchObject({ contact_id: contactA, last_message_id: high });
    }
  });

  it('is an empty list when there are no messages', async () => {
    const list = await session(db, asServer, async (tx) => {
      await tx.query('DELETE FROM public.client_messages');
      await become(tx, owner);
      return inbox(tx);
    });
    expect(list).toEqual([]);
  });

  it('refuses a client, and anon cannot call it', async () => {
    const err = await expectDenied(as(db, asA(), 'SELECT public.admin_list_conversations()'));
    expect(err.message).toBe('owner required');
    expect(await errorOf(db, asAnon, 'SELECT public.admin_list_conversations()')).toMatch(/permission denied/);
  });
});

describe('get_org_public_key()', () => {
  const key = (who: Principal) =>
    as<{ k: { key_id: string; public_key: string } | null }>(db, who, 'SELECT public.get_org_public_key() AS k').then((r) => r[0].k);

  it('gives a client and the owner the owner\'s key, never the stray one', async () => {
    expect(await key(asA())).toEqual({ key_id: keyId, public_key: PUBLIC_JWK });
    expect(await key(owner)).toEqual({ key_id: keyId, public_key: PUBLIC_JWK });
  });

  it('gives nothing to a signed-in user who is neither', async () => {
    expect(await key(user(STRAY_USER))).toBeNull();
  });

  it('is null before the owner has set up a key', async () => {
    const k = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec('DELETE FROM public.client_messages');
      await tx.query('DELETE FROM public.organization_keys WHERE owner_user_id = $1', [OWNER_ID]);
      await become(tx, asA());
      return (await tx.query<{ k: unknown }>('SELECT public.get_org_public_key() AS k')).rows[0].k;
    });
    expect(k).toBeNull();
  });

  it('anon cannot call it', async () => {
    expect(await errorOf(db, asAnon, 'SELECT public.get_org_public_key()')).toMatch(/permission denied/);
  });
});

describe('organization_keys', () => {
  const columns = '(owner_user_id, public_key, encrypted_private_key, key_salt, key_iv)';

  it('a client reads no key row, and cannot write one', async () => {
    expect(await as(db, asA(), 'SELECT id FROM public.organization_keys')).toEqual([]);
    await expectDenied(as(db, asA(), `INSERT INTO public.organization_keys ${columns} VALUES ($1, $2, $3, $4, $5)`,
      [clientA, PUBLIC_JWK, WRAPPED, SALT, IV]));
    expect(await affected(asA(), `UPDATE public.organization_keys SET key_iv = $1`, [IV])).toBe(0);
  });

  it('the owner reads its own key row only', async () => {
    expect((await as<{ id: string }>(db, owner, 'SELECT id FROM public.organization_keys')).map((r) => r.id)).toEqual([keyId]);
  });

  it('the owner sets up once (INSERT), audited, and never for someone else', async () => {
    const written = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec('DELETE FROM public.client_messages');
      await tx.query('DELETE FROM public.organization_keys WHERE owner_user_id = $1', [OWNER_ID]);
      await become(tx, owner);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.organization_keys ${columns} VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [OWNER_ID, PUBLIC_JWK, WRAPPED, SALT, IV]);
      const audit = (await tx.query<{ action: string; user_id: string; details: unknown }>(
        `SELECT action, user_id, details FROM public.audit_logs WHERE action LIKE 'messages_key_%' AND details->>'key_id' = $1`,
        [rows[0].id])).rows;
      return { audit, id: rows[0].id };
    });
    expect(written.audit).toEqual([{ action: 'messages_key_created', user_id: OWNER_ID, details: { key_id: written.id } }]);

    const second = await expectDenied(as(db, owner, `INSERT INTO public.organization_keys ${columns} VALUES ($1, $2, $3, $4, $5)`,
      [OWNER_ID, PUBLIC_JWK, WRAPPED, SALT, IV]), '23505');
    expect(second.message).toMatch(/owner_user_id/);
    await expectDenied(as(db, owner, `INSERT INTO public.organization_keys ${columns} VALUES ($1, $2, $3, $4, $5)`,
      [STRAY_USER, PUBLIC_JWK, WRAPPED, SALT, IV]));
  });

  it('the owner re-wraps (UPDATE of the wrap), audited', async () => {
    const audit = await session(db, owner, async (tx) => {
      const n = (await tx.query(
        `UPDATE public.organization_keys SET encrypted_private_key = $1, key_salt = $2, key_iv = $3 WHERE id = $4`,
        ['x'.repeat(3200), 'T'.repeat(24), 'J'.repeat(16), keyId])).affectedRows;
      const rows = (await tx.query<{ action: string }>(
        `SELECT action FROM public.audit_logs WHERE details->>'key_id' = $1 AND action = 'messages_key_rewrapped'`, [keyId])).rows;
      return { n, rows: rows.length };
    });
    expect(audit).toEqual({ n: 1, rows: 1 });
  });

  it('the public half, the owner and the id never move, and no one but the server deletes', async () => {
    for (const set of [`public_key = '${PUBLIC_JWK}'`, `owner_user_id = '${STRAY_USER}'`, 'id = gen_random_uuid()', 'created_at = now()']) {
      await expectDenied(as(db, owner, `UPDATE public.organization_keys SET ${set} WHERE id = $1`, [keyId]));
    }
    await expectDenied(as(db, owner, 'DELETE FROM public.organization_keys WHERE id = $1', [keyId]));
    await expectDenied(as(db, asA(), 'DELETE FROM public.organization_keys WHERE id = $1', [keyId]));
  });

  it('a key with messages encrypted to it cannot be deleted, even by the server', async () => {
    await expectDenied(as(db, asServer, 'DELETE FROM public.organization_keys WHERE id = $1', [keyId]), '23001');
  });

  it('refuses a malformed salt or IV', async () => {
    await expectDenied(as(db, owner, 'UPDATE public.organization_keys SET key_salt = $1 WHERE id = $2', ['S'.repeat(23), keyId]), '23514');
    await expectDenied(as(db, owner, 'UPDATE public.organization_keys SET key_iv = $1 WHERE id = $2', ['I'.repeat(15), keyId]), '23514');
  });
});

describe('cleanup_read_client_messages()', () => {
  it('deletes messages read over 7 days ago in both directions, keeps the rest', async () => {
    const out = await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.client_messages SET read_at = now() - interval '8 days' WHERE id = ANY($1)`, [[aToOwner, ownerToA]]);
      await tx.query(`UPDATE public.client_messages SET read_at = now() - interval '1 day' WHERE id = $1`, [ownerToB]);
      const n = (await tx.query<{ n: number }>('SELECT public.cleanup_read_client_messages() AS n')).rows[0].n;
      const left = (await tx.query<{ id: string }>('SELECT id FROM public.client_messages')).rows.map((r) => r.id).sort();
      return { n, left };
    });
    expect(out).toEqual({ n: 2, left: [bToOwner, ownerToB].sort() });
  });

  it('is the server\'s alone', async () => {
    await expectDenied(as(db, owner, 'SELECT public.cleanup_read_client_messages()'));
    await expectDenied(as(db, asA(), 'SELECT public.cleanup_read_client_messages()'));
    await expectDenied(as(db, asAnon, 'SELECT public.cleanup_read_client_messages()'));
  });
});

describe('realtime and grants', () => {
  it('client_messages is published to realtime', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public'`);
    expect(rows.map((r) => r.tablename)).toContain('client_messages');
  });

  it('a signed-in session may update read_at and nothing else, and never truncate', async () => {
    const { rows } = await db.query<{ col: string; ok: boolean }>(
      `SELECT a.attname AS col, has_column_privilege('authenticated', 'public.client_messages'::regclass, a.attname, 'UPDATE') AS ok
       FROM pg_attribute a WHERE a.attrelid = 'public.client_messages'::regclass AND a.attnum > 0 AND NOT a.attisdropped`);
    expect(rows.filter((r) => r.ok).map((r) => r.col)).toEqual(['read_at']);
    const truncate = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.client_messages', 'TRUNCATE') OR
              has_table_privilege('service_role', 'public.client_messages', 'TRUNCATE') AS ok`);
    expect(truncate.rows[0].ok).toBe(false);
  });
});

describe('View as client', () => {
  const MINTED = randomUUID();
  const OWN_DEVICE = randomUUID();

  /** One write as `who` while the owner's View-as-client row for client A (bound to MINTED) exists. */
  const whileViewing = (who: Principal, sql: string, params: unknown[]) =>
    session(db, asServer, async (tx) => {
      await tx.query(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
         VALUES ($1, $2, $3, 'client@example.test', $4)`, [OWNER_ID, contactA, clientA, MINTED]);
      await become(tx, who);
      return (await tx.query(sql, params)).affectedRows ?? 0;
    });

  const MARK_READ = 'UPDATE public.client_messages SET read_at = now() WHERE id = $1';

  it('the bound session can read but cannot send or mark read', async () => {
    const minted = user(clientA, { sessionId: MINTED });
    const seen = await session(db, asServer, async (tx) => {
      await tx.query(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
         VALUES ($1, $2, $3, 'client@example.test', $4)`, [OWNER_ID, contactA, clientA, MINTED]);
      await become(tx, minted);
      return (await tx.query('SELECT id FROM public.client_messages')).rows.length;
    });
    expect(seen).toBe(2);
    const send = await expectDenied(whileViewing(minted, ...clientInsert()));
    expect(send.message).toBe('impersonation_read_only');
    const mark = await expectDenied(whileViewing(minted, MARK_READ, [ownerToA]));
    expect(mark.message).toBe('impersonation_read_only');
  });

  it('the client\'s own device still writes, and the owner and server are unaffected', async () => {
    const own = user(clientA, { sessionId: OWN_DEVICE });
    expect(await whileViewing(own, ...clientInsert())).toBe(1);
    expect(await whileViewing(own, MARK_READ, [ownerToA])).toBe(1);
    expect(await whileViewing(owner, ...ownerInsert())).toBe(1);
    expect(await whileViewing(asServer, 'DELETE FROM public.client_messages WHERE id = $1', [aToOwner])).toBe(1);
  });
});
