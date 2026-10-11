// @vitest-environment node
// View as client: the owner holds a client's own minted session, and that session may
// read but never write. is_impersonation_session() is the rule; the
// trg_impersonation_read_only statement trigger enforces it on every write.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  become,
  becomeSuperuser,
  createDb,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  type Principal,
} from './harness';

type Tx = Parameters<Parameters<typeof session>[2]>[0];

let db: PGlite;
let contactId: string;
let clientId: string;
let otherContactId: string;
let otherClientId: string;
let taskId: string;

const MINTED = randomUUID(); // the session the owner holds while viewing as the client
const OWN_DEVICE = randomUUID(); // the client's own session, on their own device

// No RETURNING: a client has no SELECT policy on its activity rows (it reads them through
// get_my_activity()), and RETURNING would apply one. Success is the affected-row count.
const COMPLETE_TASK = `UPDATE public.client_tasks SET status = 'completed' WHERE id = $1`;
const RECORD_READ = `INSERT INTO public.client_activity_log (contact_id, user_id, action) VALUES ($1, $2, 'message_read')`;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactId = await seedContact(db, { status: 'client' });
  clientId = (await seedPortalAccount(db, contactId)).userId;
  otherContactId = await seedContact(db, { first_name: 'Bo' });
  otherClientId = (await seedPortalAccount(db, otherContactId)).userId;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.client_tasks (contact_id, title) VALUES ($1, 'Send the signed form') RETURNING id`, [contactId]);
  taskId = rows[0].id;
}, 60_000);

interface Row {
  /** The minted session the row is bound to; null for an unbound row. */
  sessionId: string | null;
  startedAgo?: string;
  /** How long ago the row was closed; omitted for an open row. */
  endedAgo?: string;
}

/** Writes an impersonation row for the client as the server does, returning its id. */
async function insertRow(tx: Tx, row: Row): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO public.impersonation_sessions
       (owner_user_id, target_contact_id, target_user_id, target_email, session_id, started_at, ended_at)
     VALUES ($1, $2, $3, 'client@example.test', $4, now() - $5::interval, now() - $6::interval)
     RETURNING id`,
    [OWNER_ID, contactId, clientId, row.sessionId, row.startedAgo ?? '1 minute', row.endedAgo ?? null]);
  return rows[0].id;
}

/** With `row` in place (rolled back afterwards), run one write as `who`; resolves to the rows it wrote. */
function under(row: Row | null, who: Principal, sql: string, params: unknown[]): Promise<number> {
  return session(db, asServer, async (tx) => {
    if (row) await insertRow(tx, row);
    await become(tx, who);
    return (await tx.query(sql, params)).affectedRows ?? 0;
  });
}

const complete = (row: Row | null, who: Principal) => under(row, who, COMPLETE_TASK, [taskId]);
const record = (row: Row | null, who: Principal) => under(row, who, RECORD_READ, [contactId, clientId]);

async function expectReadOnly(promise: Promise<unknown>): Promise<void> {
  const err = await expectDenied(promise);
  expect(err.message).toBe('impersonation_read_only');
}

describe('a bound View-as-client session', () => {
  const bound: Row = { sessionId: MINTED };
  const minted = () => asClient(clientId, { sessionId: MINTED });

  it('cannot complete a task or record activity', async () => {
    await expectReadOnly(complete(bound, minted()));
    await expectReadOnly(record(bound, minted()));
  });

  it('can still read what the client reads', async () => {
    const rows = await session(db, asServer, async (tx) => {
      await insertRow(tx, bound);
      await become(tx, minted());
      return (await tx.query<{ id: string }>('SELECT id FROM public.client_tasks')).rows;
    });
    expect(rows.map((r) => r.id)).toEqual([taskId]);
  });

  it('stays read-only after its row is closed, since the token outlives the row', async () => {
    await expectReadOnly(complete({ sessionId: MINTED, startedAgo: '3 hours', endedAgo: '2 hours' }, minted()));
  });

  it("leaves the client's own sessions alone", async () => {
    expect(await complete(bound, asClient(clientId, { sessionId: OWN_DEVICE }))).toBe(1);
    expect(await record(bound, asClient(clientId, { sessionId: OWN_DEVICE }))).toBe(1);
  });

  it('leaves the owner and the server alone', async () => {
    expect(await record(bound, asOwner)).toBe(1);
    expect(await complete(bound, asServer)).toBe(1);
  });

  it('binds one row per session', async () => {
    const dup = session(db, asServer, async (tx) => {
      await insertRow(tx, bound);
      await insertRow(tx, bound);
    });
    await expectDenied(dup, '23505');
  });
});

describe('an unbound row (the bind never happened)', () => {
  it('makes every session of the client read-only while it is open', async () => {
    const open: Row = { sessionId: null };
    await expectReadOnly(complete(open, asClient(clientId, { sessionId: OWN_DEVICE })));
    await expectReadOnly(record(open, asClient(clientId, { sessionId: null })));
    // Nobody else: not another client, not the owner.
    expect(await under(open, asClient(otherClientId), RECORD_READ, [otherContactId, otherClientId])).toBe(1);
    expect(await record(open, asOwner)).toBe(1);
  });

  it("keeps restricting for the sign-in link's hour after it started, then stops", async () => {
    const own = asClient(clientId, { sessionId: OWN_DEVICE });
    await expectReadOnly(complete({ sessionId: null, startedAgo: '30 minutes', endedAgo: '20 minutes' }, own));
    expect(await complete({ sessionId: null, startedAgo: '2 hours', endedAgo: '90 minutes' }, own)).toBe(1);
  });
});

describe('is_impersonation_session', () => {
  it('answers the server for a session and a user', async () => {
    const out = await session(db, asServer, async (tx) => {
      await insertRow(tx, { sessionId: MINTED });
      const ask = async (user: string, sid: string | null) =>
        (await tx.query<{ v: boolean }>('SELECT public.is_impersonation_session($1, $2) AS v', [user, sid])).rows[0].v;
      return { minted: await ask(clientId, MINTED), own: await ask(clientId, OWN_DEVICE), none: await ask(clientId, null) };
    });
    expect(out).toEqual({ minted: true, own: false, none: false });
  });

  it('is not callable by a signed-in session or anon', async () => {
    const call = `SELECT public.is_impersonation_session('${clientId}', '${MINTED}')`;
    await expectDenied(as(db, asClient(clientId), call));
    await expectDenied(as(db, asOwner, call));
    await expectDenied(as(db, asAnon, call));
  });

  it('is_view_as_client() asks it about the caller alone, and anon may not ask', async () => {
    const ask = (who: Principal) =>
      session(db, asServer, async (tx) => {
        await insertRow(tx, { sessionId: MINTED });
        await become(tx, who);
        return (await tx.query<{ v: boolean }>('SELECT public.is_view_as_client() AS v')).rows[0].v;
      });
    expect(await ask(asClient(clientId, { sessionId: MINTED }))).toBe(true);
    expect(await ask(asClient(clientId, { sessionId: OWN_DEVICE }))).toBe(false);
    expect(await ask(asClient(otherClientId))).toBe(false);
    expect(await ask(asOwner)).toBe(false);
    await expectDenied(ask(asAnon));
  });
});

/**
 * A bucket a client may write, as a documents bucket does, holding one file in the
 * client's folder. Made as the superuser inside the session, so it is rolled back with it.
 */
async function addClientBucket(tx: Tx): Promise<void> {
  await becomeSuperuser(tx);
  const mine = `bucket_id = 'files' AND ((SELECT public.is_owner()) OR (storage.foldername(name))[1] = (SELECT public.get_client_contact_id())::text)`;
  await tx.exec(`
    INSERT INTO storage.buckets (id, name) VALUES ('files', 'files');
    CREATE POLICY files_select ON storage.objects FOR SELECT TO authenticated USING (${mine});
    CREATE POLICY files_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (${mine});
    CREATE POLICY files_update ON storage.objects FOR UPDATE TO authenticated USING (${mine}) WITH CHECK (${mine});
    CREATE POLICY files_delete ON storage.objects FOR DELETE TO authenticated USING (${mine});
    INSERT INTO storage.objects (bucket_id, name) VALUES ('files', '${contactId}/kept.pdf');
  `);
}

/** With `row` and the bucket in place (rolled back afterwards), run one storage statement as `who`. */
function onFiles(row: Row | null, who: Principal, sql: string): Promise<{ affected: number; names: string[] }> {
  return session(db, asServer, async (tx) => {
    if (row) await insertRow(tx, row);
    await addClientBucket(tx);
    await become(tx, who);
    const r = await tx.query<{ name: string }>(sql);
    return { affected: r.affectedRows ?? 0, names: r.rows.map((x) => x.name) };
  });
}

describe('files, in every bucket', () => {
  const bound: Row = { sessionId: MINTED };
  const minted = () => asClient(clientId, { sessionId: MINTED });
  const own = () => asClient(clientId, { sessionId: OWN_DEVICE });
  const upload = () => `INSERT INTO storage.objects (bucket_id, name) VALUES ('files', '${contactId}/new.pdf')`;
  const RENAME = `UPDATE storage.objects SET name = name || '.old' WHERE bucket_id = 'files'`;
  const REMOVE = `DELETE FROM storage.objects WHERE bucket_id = 'files'`;
  const LIST = `SELECT name FROM storage.objects WHERE bucket_id = 'files'`;

  it('a View-as-client session cannot upload, rename or remove a file, and still sees them', async () => {
    const err = await expectDenied(onFiles(bound, minted(), upload()));
    expect(err.message).toMatch(/objects_view_as_client_insert/);
    expect((await onFiles(bound, minted(), RENAME)).affected).toBe(0);
    expect((await onFiles(bound, minted(), REMOVE)).affected).toBe(0);
    expect((await onFiles(bound, minted(), LIST)).names).toEqual([`${contactId}/kept.pdf`]);
  });

  it("leaves the client's own device, the owner and the server alone", async () => {
    expect((await onFiles(bound, own(), upload())).affected).toBe(1);
    expect((await onFiles(bound, own(), RENAME)).affected).toBe(1);
    expect((await onFiles(bound, own(), REMOVE)).affected).toBe(1);
    expect((await onFiles(bound, asOwner, upload())).affected).toBe(1);
    expect((await onFiles(bound, asServer, REMOVE)).affected).toBe(1);
  });

  it('an unbound row holds every session of the client to reading', async () => {
    await expectDenied(onFiles({ sessionId: null }, own(), upload()));
    expect((await onFiles({ sessionId: null }, own(), REMOVE)).affected).toBe(0);
  });
});

/** An auth.sessions row for `userId`, created `createdAgo` ago, signed in by `method`. */
async function addAuthSession(tx: Tx, userId: string, createdAgo: string, method: string, id = randomUUID()): Promise<string> {
  await tx.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now() - $3::interval, now())`,
    [id, userId, createdAgo]);
  await tx.query(
    `INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
     VALUES ($1, $2, now(), now(), $3)`,
    [randomUUID(), id, method]);
  return id;
}

const sessionsLeft = async (tx: Tx) =>
  (await tx.query<{ id: string }>('SELECT id FROM auth.sessions ORDER BY id')).rows.map((r) => r.id).sort();

describe('revoke_impersonation_auth_session', () => {
  it('a bound row revokes exactly its minted session', async () => {
    const out = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await addAuthSession(tx, clientId, '1 minute', 'otp', MINTED);
      const own = await addAuthSession(tx, clientId, '1 minute', 'password', OWN_DEVICE);
      const row = await insertRow(tx, { sessionId: MINTED });
      await become(tx, asServer);
      const revoked = (await tx.query<{ v: boolean }>('SELECT public.revoke_impersonation_auth_session($1) AS v', [row])).rows[0].v;
      await becomeSuperuser(tx);
      return { revoked, left: await sessionsLeft(tx), own };
    });
    expect(out.revoked).toBe(true);
    expect(out.left).toEqual([out.own]);
  });

  it("an unbound row revokes the client's sign-in-link sessions from the link's hour, and nothing else", async () => {
    const out = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      const row = await insertRow(tx, { sessionId: null, startedAgo: '2 hours' });
      const minted = await addAuthSession(tx, clientId, '110 minutes', 'otp'); // 10 minutes after the start
      const kept = [
        await addAuthSession(tx, clientId, '110 minutes', 'password'), // signed in another way
        await addAuthSession(tx, clientId, '130 minutes', 'otp'), // before the row started
        await addAuthSession(tx, clientId, '50 minutes', 'otp'), // after the link's hour
        await addAuthSession(tx, otherClientId, '110 minutes', 'otp'), // someone else
      ];
      await become(tx, asServer);
      const revoked = (await tx.query<{ v: boolean }>('SELECT public.revoke_impersonation_auth_session($1) AS v', [row])).rows[0].v;
      await becomeSuperuser(tx);
      return { revoked, left: await sessionsLeft(tx), kept: kept.sort(), minted };
    });
    expect(out.revoked).toBe(true);
    expect(out.left).toEqual(out.kept);
    expect(out.left).not.toContain(out.minted);
  });

  it('says false when there was nothing to revoke', async () => {
    const out = await session(db, asServer, async (tx) => {
      const row = await insertRow(tx, { sessionId: MINTED });
      const ask = async (id: string) =>
        (await tx.query<{ v: boolean }>('SELECT public.revoke_impersonation_auth_session($1) AS v', [id])).rows[0].v;
      return { noSession: await ask(row), noRow: await ask(randomUUID()) };
    });
    expect(out).toEqual({ noSession: false, noRow: false });
  });
});

describe('auto_end_stale_impersonation_sessions', () => {
  it('closes rows open past eight hours, marks them auto-ended and revokes their sessions', async () => {
    const out = await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await addAuthSession(tx, clientId, '9 hours', 'otp', MINTED);
      const own = await addAuthSession(tx, clientId, '1 minute', 'password', OWN_DEVICE);
      const stale = await insertRow(tx, { sessionId: MINTED, startedAgo: '9 hours' });
      const fresh = await insertRow(tx, { sessionId: randomUUID(), startedAgo: '1 hour' });
      const ended = await insertRow(tx, { sessionId: randomUUID(), startedAgo: '10 hours', endedAgo: '9 hours' });
      await become(tx, asServer);
      const closed = (await tx.query<{ n: number }>('SELECT public.auto_end_stale_impersonation_sessions() AS n')).rows[0].n;
      const rows = (await tx.query<{ id: string; auto_ended: boolean; length: string | null }>(
        `SELECT id, auto_ended, (ended_at - started_at)::text AS length FROM public.impersonation_sessions`)).rows;
      await becomeSuperuser(tx);
      const byId = Object.fromEntries(rows.map((r) => [r.id, { auto: r.auto_ended, length: r.length }]));
      return { closed, stale: byId[stale], fresh: byId[fresh], ended: byId[ended], left: await sessionsLeft(tx), own };
    });
    expect(out.closed).toBe(1);
    expect(out.stale).toEqual({ auto: true, length: '08:00:00' });
    expect(out.fresh).toEqual({ auto: false, length: null });
    expect(out.ended).toEqual({ auto: false, length: '01:00:00' });
    expect(out.left).toEqual([out.own]);
  });
});
