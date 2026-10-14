// @vitest-environment node
// The harness itself: a helper that passed vacuously would make every test built on it
// vacuous too.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  createDb,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
} from './harness';

let db: PGlite;
let contactId: string;
let clientId: string;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactId = await seedContact(db, { first_name: 'Cy', status: 'client' });
  clientId = (await seedPortalAccount(db, contactId)).userId;
}, 60_000);

describe('expectDenied', () => {
  it('returns the error when the statement is refused with the expected SQLSTATE', async () => {
    const err = await expectDenied(as(db, asAnon, 'SELECT 1 FROM public.contacts'));
    expect(err.message).toMatch(/permission denied/);
  });

  it('fails when the statement succeeds', async () => {
    await expect(expectDenied(as(db, asOwner, 'SELECT 1 FROM public.contacts'))).rejects.toThrow(/but it succeeded/);
  });

  it('fails when the statement is refused for another reason', async () => {
    await expect(expectDenied(as(db, asServer, 'SELECT 1/0'))).rejects.toThrow(/expected '22012' to be '42501'/);
  });
});

describe('principals and seeds', () => {
  it('the seeded owner is the owner, and the seeded client is that contact’s client', async () => {
    expect((await as(db, asOwner, 'SELECT public.is_owner() AS v'))[0].v).toBe(true);
    expect((await as(db, asClient(clientId), 'SELECT public.get_client_contact_id() AS v'))[0].v).toBe(contactId);
    expect((await as(db, asClient(clientId), 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
  });

  it('a token carries a session_id claim unless asked not to', async () => {
    const sid = '20000000-0000-4000-8000-000000000001';
    const claim = `SELECT auth.jwt() ->> 'session_id' AS v`;
    expect((await as(db, asClient(clientId, { sessionId: sid }), claim))[0].v).toBe(sid);
    expect((await as(db, asClient(clientId), claim))[0].v).toMatch(/^[0-9a-f-]{36}$/);
    expect((await as(db, asClient(clientId, { sessionId: null }), claim))[0].v).toBeNull();
    expect((await as(db, asOwner, 'SELECT auth.uid() AS v'))[0].v).toBe(OWNER_ID);
  });
});

describe('the Supabase shim', () => {
  it('storage path helpers split like Supabase Storage', async () => {
    const [r] = await as<{ f: string[]; n: string; e: string }>(db, asServer,
      `SELECT storage.foldername('a/b/c.tar.gz') AS f, storage.filename('a/b/c.tar.gz') AS n, storage.extension('a/b/c.tar.gz') AS e`);
    expect(r).toEqual({ f: ['a', 'b'], n: 'c.tar.gz', e: 'gz' });
  });

  it('storage is granted to every API role but reachable by none until a policy says so', async () => {
    await db.exec(`INSERT INTO storage.buckets (id, name) VALUES ('shim-test', 'shim-test');
                   INSERT INTO storage.objects (bucket_id, name) VALUES ('shim-test', 'x/y.txt');`);
    for (const who of [asAnon, asOwner, asClient(clientId)]) {
      expect(await as(db, who, 'SELECT id FROM storage.objects')).toEqual([]);
      expect(await as(db, who, 'SELECT id FROM storage.buckets')).toEqual([]);
    }
    expect(await as(db, asServer, 'SELECT path_tokens FROM storage.objects')).toEqual([{ path_tokens: ['x', 'y.txt'] }]);
  });

  it('no API role may touch the auth tables directly', async () => {
    for (const who of [asAnon, asOwner, asServer]) {
      await expectDenied(as(db, who, 'SELECT 1 FROM auth.sessions'));
      await expectDenied(as(db, who, 'SELECT 1 FROM auth.users'));
    }
  });
});
