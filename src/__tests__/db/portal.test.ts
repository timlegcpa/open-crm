// @vitest-environment node
// 0012_portal: the server's invite and sign-in functions, against the real migrations.
// Every function is the server's alone; the invite pair is atomic and case-insensitive,
// a resend touches one account, a link refuses a claimed row, and the user lookup that
// feeds a delete never names the owner or the system actor.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  becomeSuperuser,
  become,
  createDb,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  tryIn,
} from './harness';

type Tx = Parameters<Parameters<typeof session>[2]>[0];

let db: PGlite;
let contactId: string;
let clientId: string;

const PRIMARY = 'ada@example.com';
const SPOUSE = 'grace@example.com';
const LATER = `now() + interval '7 days'`;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactId = await seedContact(db, { email: PRIMARY, spouse_first_name: 'Grace', spouse_email: SPOUSE });
  const other = await seedContact(db, { first_name: 'Bo', email: 'bo@example.com' });
  clientId = (await seedPortalAccount(db, other)).userId;
}, 60_000);

const FUNCTIONS = [
  ['portal_invite_throttled($1)', [randomUUID()]],
  ['create_portal_invitation($1, $2, $3, now(), $4)', [randomUUID(), PRIMARY, 'h', OWNER_ID]],
  ['reissue_portal_invitation($1, $2, now(), $3)', [randomUUID(), 'h', OWNER_ID]],
  ['link_portal_invitation($1, $2)', [randomUUID(), randomUUID()]],
  ['deactivate_portal_account($1)', [randomUUID()]],
  ['record_portal_login($1)', [randomUUID()]],
  ['find_auth_user_id_by_email($1)', [PRIMARY]],
  ['impersonation_credential_changes($1)', [randomUUID()]],
  ['claim_portal_invitation($1, $2)', [randomUUID(), randomUUID()]],
  ['release_portal_invitation_claim($1, $2)', [randomUUID(), randomUUID()]],
  ['delete_stale_portal_user($1, $2, $3)', [randomUUID(), randomUUID(), randomUUID()]],
] as const;

describe('EXECUTE', () => {
  it.each(FUNCTIONS)('%s: refused to anon, the owner and a client', async (call, params) => {
    for (const who of [asAnon, asOwner, asClient(clientId)]) {
      await expectDenied(as(db, who, `SELECT public.${call}`, [...params]));
    }
  });

  it('the server may call them', async () => {
    const [row] = await as<{ ok: boolean }>(db, asServer, `SELECT public.portal_invite_throttled($1) AS ok`, [contactId]);
    expect(row.ok).toBe(false);
  });
});

async function invite(tx: Tx, email: string, hash: string = randomUUID()): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT public.create_portal_invitation($1, $2, $3, ${LATER}, $4) AS id`, [contactId, email, hash, OWNER_ID]);
  return rows[0].id;
}

async function accounts(tx: Tx) {
  return (await tx.query<{ id: string; invited_email: string; status: string; role: string; user_id: string | null }>(
    `SELECT id, invited_email, status, role, user_id FROM public.client_portal_accounts WHERE contact_id = $1 ORDER BY created_at, invited_email`,
    [contactId])).rows;
}

async function invitations(tx: Tx) {
  return (await tx.query<{ id: string; email: string; status: string }>(
    `SELECT id, email, status FROM public.portal_invitations WHERE contact_id = $1 ORDER BY created_at, id`, [contactId])).rows;
}

describe('create_portal_invitation', () => {
  it('writes the account and the invitation together', async () => {
    await session(db, asServer, async (tx) => {
      const id = await invite(tx, PRIMARY, 'hash-1');
      expect(await accounts(tx)).toMatchObject([{ invited_email: PRIMARY, status: 'invited', role: 'primary', user_id: null }]);
      expect(await invitations(tx)).toEqual([{ id, email: PRIMARY, status: 'pending' }]);
    });
  });

  it('refuses an address that already has an open account, whatever its case, and leaves no orphan invitation', async () => {
    await session(db, asServer, async (tx) => {
      await invite(tx, PRIMARY);
      const err = await tryIn(tx, `SELECT public.create_portal_invitation($1, $2, 'h2', ${LATER}, $3)`, [contactId, PRIMARY.toUpperCase(), OWNER_ID]);
      expect(err).toMatch(/idx_portal_accounts_open_invite|duplicate key/);
      expect(await invitations(tx)).toHaveLength(1);
      expect(await accounts(tx)).toHaveLength(1);
    });
  });

  it("refuses an address that is not one of the contact's", async () => {
    await session(db, asServer, async (tx) => {
      const err = await tryIn(tx, `SELECT public.create_portal_invitation($1, 'someone@example.net', 'h', ${LATER}, $2)`, [contactId, OWNER_ID]);
      expect(err).toBe('portal_invite_email_not_on_contact');
      expect(await invitations(tx)).toHaveLength(0);
    });
  });

  it('refuses a fourth invitation to one contact within 24 hours, before writing anything', async () => {
    await session(db, asServer, async (tx) => {
      await tx.query(
        `INSERT INTO public.portal_invitations (email, contact_id, status, expires_at)
         SELECT 'old@example.com', $1, 'revoked', now() FROM generate_series(1, 3)`, [contactId]);
      const err = await tryIn(tx, `SELECT public.create_portal_invitation($1, $2, 'h', ${LATER}, $3)`, [contactId, PRIMARY, OWNER_ID]);
      expect(err).toBe('portal_invite_throttled');
      expect(await accounts(tx)).toHaveLength(0);
      // A day later the cap has passed.
      await tx.query(`UPDATE public.portal_invitations SET created_at = now() - interval '25 hours' WHERE contact_id = $1`, [contactId]);
      await invite(tx, PRIMARY);
    });
  });

  it('makes a second person on a contact with an active account secondary', async () => {
    await session(db, asServer, async (tx) => {
      await invite(tx, PRIMARY);
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'active' WHERE contact_id = $1`, [contactId]);
      await invite(tx, SPOUSE);
      expect((await accounts(tx)).find((a) => a.invited_email === SPOUSE)?.role).toBe('secondary');
    });
  });

  it('refuses a contact whose delete is in progress', async () => {
    await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.contacts SET delete_claim = gen_random_uuid(), delete_claimed_at = now() WHERE id = $1`, [contactId]);
      const err = await tryIn(tx, `SELECT public.create_portal_invitation($1, $2, 'h', ${LATER}, $3)`, [contactId, PRIMARY, OWNER_ID]);
      expect(err).toBe('contact_delete_in_progress');
      expect(await invitations(tx)).toHaveLength(0);
    });
  });
});

describe('reissue_portal_invitation', () => {
  it("touches one account: the other person's account and pending link stay as they were", async () => {
    await session(db, asServer, async (tx) => {
      const first = await invite(tx, PRIMARY);
      const spouseLink = await invite(tx, SPOUSE);
      const primary = (await accounts(tx)).find((a) => a.invited_email === PRIMARY)!;
      const { rows } = await tx.query<{ invitation_id: string; email: string }>(
        `SELECT * FROM public.reissue_portal_invitation($1, 'fresh', ${LATER}, $2)`, [primary.id, OWNER_ID]);
      expect(rows[0].email).toBe(PRIMARY);
      const byId = Object.fromEntries((await invitations(tx)).map((i) => [i.id, i.status]));
      expect(byId[first]).toBe('revoked');
      expect(byId[spouseLink]).toBe('pending');
      expect(byId[rows[0].invitation_id]).toBe('pending');
      expect((await accounts(tx)).map((a) => a.status)).toEqual(['invited', 'invited']);
    });
  });

  it('re-invites a deactivated account once its sign-in user is gone, and refuses one that still has it', async () => {
    await session(db, asServer, async (tx) => {
      await invite(tx, PRIMARY);
      const user = randomUUID();
      await becomeSuperuser(tx);
      await tx.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, PRIMARY]);
      await become(tx, asServer);
      const [account] = await accounts(tx);
      await tx.query(`UPDATE public.client_portal_accounts SET user_id = $1, status = 'deactivated' WHERE id = $2`, [user, account.id]);
      const reissue = `SELECT * FROM public.reissue_portal_invitation($1, 'again', ${LATER}, $2)`;
      expect(await tryIn(tx, reissue, [account.id, OWNER_ID])).toBe('portal_account_has_login');
      await becomeSuperuser(tx);
      await tx.query(`DELETE FROM auth.users WHERE id = $1`, [user]);
      await become(tx, asServer);
      expect(await tryIn(tx, reissue, [account.id, OWNER_ID])).toBeNull();
      expect((await accounts(tx))[0].status).toBe('invited');
    });
  });

  it('refuses an active account, and runs the same cap as a new invite', async () => {
    await session(db, asServer, async (tx) => {
      await invite(tx, PRIMARY);
      const [account] = await accounts(tx);
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'active' WHERE id = $1`, [account.id]);
      const reissue = `SELECT * FROM public.reissue_portal_invitation($1, 'again', ${LATER}, $2)`;
      expect(await tryIn(tx, reissue, [account.id, OWNER_ID])).toBe('portal_account_not_reinvitable');
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'invited' WHERE id = $1`, [account.id]);
      await tx.query(
        `INSERT INTO public.portal_invitations (email, contact_id, status, expires_at)
         SELECT 'old@example.com', $1, 'revoked', now() FROM generate_series(1, 2)`, [contactId]);
      expect(await tryIn(tx, reissue, [account.id, OWNER_ID])).toBe('portal_invite_throttled');
      expect(await tryIn(tx, reissue, [randomUUID(), OWNER_ID])).toBe('portal_account_not_found');
    });
  });
});

describe('link_portal_invitation', () => {
  async function newUser(tx: Tx): Promise<string> {
    const id = randomUUID();
    await becomeSuperuser(tx);
    await tx.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, PRIMARY]);
    await become(tx, asServer);
    return id;
  }

  it('links the open account for the address and activates it, once', async () => {
    await session(db, asServer, async (tx) => {
      const inv = await invite(tx, PRIMARY);
      const user = await newUser(tx);
      const { rows } = await tx.query<{ id: string | null }>(`SELECT public.link_portal_invitation($1, $2) AS id`, [inv, user]);
      expect(rows[0].id).not.toBeNull();
      expect((await accounts(tx))[0]).toMatchObject({ user_id: user, status: 'active' });
      // A second acceptance racing the first finds nothing left to link.
      const again = await tx.query<{ id: string | null }>(`SELECT public.link_portal_invitation($1, $2) AS id`, [inv, await newUser(tx)]);
      expect(again.rows[0].id).toBeNull();
    });
  });

  it('refuses a row a contact delete has claimed, even once the claim has aged out', async () => {
    await session(db, asServer, async (tx) => {
      const inv = await invite(tx, PRIMARY);
      await tx.query(
        `UPDATE public.client_portal_accounts SET delete_claim = gen_random_uuid(), delete_claimed_at = now() - interval '1 hour' WHERE contact_id = $1`,
        [contactId]);
      const { rows } = await tx.query<{ id: string | null }>(`SELECT public.link_portal_invitation($1, $2) AS id`, [inv, await newUser(tx)]);
      expect(rows[0].id).toBeNull();
      expect((await accounts(tx))[0]).toMatchObject({ user_id: null, status: 'invited' });
    });
  });
});

describe('deactivate_portal_account', () => {
  it('deactivates one account, revokes its pending link and returns its sign-in user', async () => {
    await session(db, asServer, async (tx) => {
      await invite(tx, PRIMARY);
      const spouseLink = await invite(tx, SPOUSE);
      const primary = (await accounts(tx)).find((a) => a.invited_email === PRIMARY)!;
      const { rows } = await tx.query<{ user_id: string | null }>(`SELECT public.deactivate_portal_account($1) AS user_id`, [primary.id]);
      expect(rows[0].user_id).toBeNull();
      const statuses = Object.fromEntries((await accounts(tx)).map((a) => [a.invited_email, a.status]));
      expect(statuses).toEqual({ [PRIMARY]: 'deactivated', [SPOUSE]: 'invited' });
      const links = await invitations(tx);
      expect(links.find((i) => i.email === PRIMARY)?.status).toBe('revoked');
      expect(links.find((i) => i.id === spouseLink)?.status).toBe('pending');
    });
  });
});

describe('record_portal_login', () => {
  it('counts every sign-in of an active account, and none of a suspended one', async () => {
    await session(db, asServer, async (tx) => {
      const call = `SELECT public.record_portal_login($1) AS ok`;
      await tx.query(call, [clientId]);
      await tx.query(call, [clientId]);
      const { rows } = await tx.query<{ login_count: number; last_login_at: string | null }>(
        `SELECT login_count, last_login_at FROM public.client_portal_accounts WHERE user_id = $1`, [clientId]);
      expect(rows[0].login_count).toBe(2);
      expect(rows[0].last_login_at).not.toBeNull();
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'suspended' WHERE user_id = $1`, [clientId]);
      expect((await tx.query<{ ok: boolean }>(call, [clientId])).rows[0].ok).toBe(false);
    });
  });
});

describe('find_auth_user_id_by_email', () => {
  it('finds a user by address, ignoring case', async () => {
    const [found] = await as<{ id: string }>(db, asServer, `SELECT public.find_auth_user_id_by_email($1) AS id`, [`CLIENT-${clientId.slice(0, 8)}@EXAMPLE.TEST`]);
    expect(found.id).toBe(clientId);
  });

  it('never names the owner or the system actor', async () => {
    for (const email of ['owner@example.test', 'system@example.test', 'OWNER@example.test']) {
      const [row] = await as<{ id: string | null }>(db, asServer, `SELECT public.find_auth_user_id_by_email($1) AS id`, [email]);
      expect([email, row.id]).toEqual([email, null]);
    }
  });
});

describe('link_portal_invitation re-checks the invitation', () => {
  async function linkAfter(tx: Tx, change: string): Promise<string | null> {
    const inv = await invite(tx, PRIMARY);
    await tx.query(`UPDATE public.portal_invitations SET ${change} WHERE id = $1`, [inv]);
    const user = randomUUID();
    await becomeSuperuser(tx);
    await tx.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, PRIMARY]);
    await become(tx, asServer);
    return (await tx.query<{ id: string | null }>(`SELECT public.link_portal_invitation($1, $2) AS id`, [inv, user])).rows[0].id;
  }

  it.each([
    ['revoked', `status = 'revoked'`],
    ['already accepted', `status = 'accepted'`],
    ['expired by status', `status = 'expired'`],
    ['past its expiry', `expires_at = now() - interval '1 second'`],
  ])('refuses an invitation that is %s, and links nothing', async (_label, change) => {
    await session(db, asServer, async (tx) => {
      expect(await linkAfter(tx, change)).toBeNull();
      expect((await accounts(tx))[0]).toMatchObject({ user_id: null, status: 'invited' });
    });
  });
});

describe('View as client locks the credentials of the client it views', () => {
  /** A View-as-client row on the client, as the superuser (Auth's tables are not the API's). */
  async function startView(tx: Tx, opts: { endedAgo?: string; withSession?: boolean } = {}): Promise<string> {
    await becomeSuperuser(tx);
    let sessionId: string | null = null;
    if (opts.withSession) {
      sessionId = randomUUID();
      await tx.query(`INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())`, [sessionId, clientId]);
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id, started_at, ended_at)
       VALUES ($1, (SELECT contact_id FROM public.client_portal_accounts WHERE user_id = $2), $2, 'bo@example.com', $3,
               now() - interval '3 hours', ${opts.endedAgo ? `now() - interval '${opts.endedAgo}'` : 'NULL'})
       RETURNING id`,
      [OWNER_ID, clientId, sessionId]);
    return rows[0].id;
  }

  const refused = /impersonation_credentials_locked/;

  it("refuses a new password, a new email and a new or verified factor while the view is open", async () => {
    await session(db, asServer, async (tx) => {
      await startView(tx);
      expect(await tryIn(tx, `UPDATE auth.users SET encrypted_password = 'owner-chosen' WHERE id = $1`, [clientId])).toMatch(refused);
      expect(await tryIn(tx, `UPDATE auth.users SET email = 'owner@elsewhere.example' WHERE id = $1`, [clientId])).toMatch(refused);
      expect(await tryIn(tx, `INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'unverified')`, [clientId])).toMatch(refused);
    });
  });

  it("refuses a factor turning verified, but not the fields Auth rewrites on every sign-in", async () => {
    await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'unverified') RETURNING id`, [clientId]);
      await startView(tx);
      expect(await tryIn(tx, `UPDATE auth.mfa_factors SET status = 'verified' WHERE id = $1`, [rows[0].id])).toMatch(refused);
      expect(await tryIn(tx,
        `UPDATE auth.users SET last_sign_in_at = now(), updated_at = now(), raw_app_meta_data = '{"x":1}', email = email, encrypted_password = encrypted_password WHERE id = $1`,
        [clientId])).toBeNull();
    });
  });

  it('holds while a closed view’s minted session exists or its last token can live, then lets go', async () => {
    await session(db, asServer, async (tx) => {
      const view = await startView(tx, { endedAgo: '2 hours', withSession: true });
      expect(await tryIn(tx, `UPDATE auth.users SET encrypted_password = 'x' WHERE id = $1`, [clientId])).toMatch(refused);
      await tx.query(`DELETE FROM auth.sessions WHERE id = (SELECT session_id FROM public.impersonation_sessions WHERE id = $1)`, [view]);
      expect(await tryIn(tx, `UPDATE auth.users SET encrypted_password = 'x' WHERE id = $1`, [clientId])).toBeNull();
    });
    await session(db, asServer, async (tx) => {
      await startView(tx, { endedAgo: '30 minutes' });
      expect(await tryIn(tx, `UPDATE auth.users SET encrypted_password = 'x' WHERE id = $1`, [clientId])).toMatch(refused);
    });
  });

  it('touches no other user', async () => {
    await session(db, asServer, async (tx) => {
      await startView(tx);
      expect(await tryIn(tx, `UPDATE auth.users SET encrypted_password = 'x' WHERE id = $1`, [OWNER_ID])).toBeNull();
      expect(await tryIn(tx, `INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'unverified')`, [OWNER_ID])).toBeNull();
    });
  });

  it('snapshots the credentials at the start and reports what changed since, flags only', async () => {
    await session(db, asServer, async (tx) => {
      const view = await startView(tx);
      const changes = async () =>
        (await tx.query<{ c: Record<string, unknown> }>(`SELECT public.impersonation_credential_changes($1) AS c`, [view])).rows[0].c;
      await become(tx, asServer);
      expect(await changes()).toEqual({ password_changed: false, email_changed: false, factors_added: 0 });
      // Past the lock (as if it had failed), to prove the end would see the change.
      await becomeSuperuser(tx);
      await tx.exec(`ALTER TABLE auth.users DISABLE TRIGGER trg_impersonation_credentials_locked`);
      await tx.exec(`ALTER TABLE auth.mfa_factors DISABLE TRIGGER trg_impersonation_factor_locked`);
      await tx.query(`UPDATE auth.users SET encrypted_password = 'changed' WHERE id = $1`, [clientId]);
      await tx.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [clientId]);
      await become(tx, asServer);
      expect(await changes()).toEqual({ password_changed: true, email_changed: false, factors_added: 1 });
      const snap = await tx.query<{ d: string }>(
        `SELECT password_digest AS d FROM public.impersonation_credential_snapshots WHERE impersonation_session_id = $1`, [view]).catch(() => null);
      // The snapshot table is not the server's to read: only the definer functions are.
      expect(snap).toBeNull();
    });
  });

  it('the stale sweep writes an audit row for each view it closes, with the credential check', async () => {
    await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, started_at)
         VALUES ($1, (SELECT contact_id FROM public.client_portal_accounts WHERE user_id = $2), $2, 'bo@example.com', now() - interval '9 hours')
         RETURNING id`, [OWNER_ID, clientId]);
      await become(tx, asServer);
      await tx.query(`SELECT public.auto_end_stale_impersonation_sessions()`);
      await becomeSuperuser(tx);
      const audit = await tx.query<{ user_id: string; details: Record<string, unknown> }>(
        `SELECT user_id, details FROM public.audit_logs WHERE action = 'impersonate_end' AND details ->> 'session_id' = $1`, [rows[0].id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].user_id).toBe(OWNER_ID);
      expect(audit.rows[0].details).toMatchObject({ auto_ended: true, password_changed: false, email_changed: false, factors_added: 0 });
    });
  });
});

describe('one acceptance at a time', () => {
  const claimIt = async (tx: Tx, inv: string, claim: string) =>
    (await tx.query<{ ok: boolean }>(`SELECT public.claim_portal_invitation($1, $2) AS ok`, [inv, claim])).rows[0].ok;

  it('a held claim refuses a second, a lapsed one is taken over, and only its holder releases it', async () => {
    await session(db, asServer, async (tx) => {
      const inv = await invite(tx, PRIMARY);
      const [a, b] = [randomUUID(), randomUUID()];
      expect(await claimIt(tx, inv, a)).toBe(true);
      expect(await claimIt(tx, inv, b)).toBe(false);
      await tx.query(`SELECT public.release_portal_invitation_claim($1, $2)`, [inv, b]);
      expect(await claimIt(tx, inv, b)).toBe(false);
      await tx.query(`UPDATE public.portal_invitation_claims SET claimed_at = now() - interval '6 minutes' WHERE invitation_id = $1`, [inv]);
      expect(await claimIt(tx, inv, b)).toBe(true);
      await tx.query(`SELECT public.release_portal_invitation_claim($1, $2)`, [inv, b]);
      expect(await claimIt(tx, inv, a)).toBe(true);
    });
  });

  it('refuses an invitation that is not pending, or has expired', async () => {
    await session(db, asServer, async (tx) => {
      const inv = await invite(tx, PRIMARY);
      await tx.query(`UPDATE public.portal_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, [inv]);
      expect(await claimIt(tx, inv, randomUUID())).toBe(false);
      await tx.query(`UPDATE public.portal_invitations SET expires_at = now() + interval '1 day', status = 'accepted' WHERE id = $1`, [inv]);
      expect(await claimIt(tx, inv, randomUUID())).toBe(false);
    });
  });

  describe('delete_stale_portal_user', () => {
    async function staleUser(tx: Tx, inv: string, over: { stamp?: string | null; banned?: boolean } = {}): Promise<string> {
      const id = randomUUID();
      await becomeSuperuser(tx);
      await tx.query(
        `INSERT INTO auth.users (id, email, raw_app_meta_data, banned_until) VALUES ($1, $2, $3, $4)`,
        [id, PRIMARY, JSON.stringify(over.stamp === null ? {} : { pending_invite: over.stamp ?? inv }), over.banned === false ? null : '2999-01-01']);
      await become(tx, asServer);
      return id;
    }
    const del = async (tx: Tx, user: string, inv: string, claim: string) =>
      (await tx.query<{ ok: boolean }>(`SELECT public.delete_stale_portal_user($1, $2, $3) AS ok`, [user, inv, claim])).rows[0].ok;
    const exists = async (tx: Tx, user: string) => {
      await becomeSuperuser(tx);
      const found = (await tx.query(`SELECT 1 FROM auth.users WHERE id = $1`, [user])).rows.length === 1;
      await become(tx, asServer);
      return found;
    };

    it("deletes this invitation's unfinished user, only for the claim's holder", async () => {
      await session(db, asServer, async (tx) => {
        const inv = await invite(tx, PRIMARY);
        const claim = randomUUID();
        await claimIt(tx, inv, claim);
        const user = await staleUser(tx, inv);
        expect(await del(tx, user, inv, randomUUID())).toBe(false);
        expect(await exists(tx, user)).toBe(true);
        expect(await del(tx, user, inv, claim)).toBe(true);
        expect(await exists(tx, user)).toBe(false);
      });
    });

    it.each([
      ['activated (stamp cleared)', { stamp: null }],
      ['activated (ban lifted)', { banned: false }],
      ['stamped for another invitation', { stamp: '10000000-0000-4000-8000-0000000000ff' }],
    ])('never deletes a user that is %s', async (_label, over) => {
      await session(db, asServer, async (tx) => {
        const inv = await invite(tx, PRIMARY);
        const claim = randomUUID();
        await claimIt(tx, inv, claim);
        const user = await staleUser(tx, inv, over);
        expect(await del(tx, user, inv, claim)).toBe(false);
        expect(await exists(tx, user)).toBe(true);
      });
    });

    it("never deletes a user linked to another contact's account", async () => {
      await session(db, asServer, async (tx) => {
        const inv = await invite(tx, PRIMARY);
        const claim = randomUUID();
        await claimIt(tx, inv, claim);
        const user = await staleUser(tx, inv);
        await tx.query(`UPDATE public.client_portal_accounts SET user_id = NULL WHERE user_id = $1`, [clientId]);
        await tx.query(`UPDATE public.client_portal_accounts SET user_id = $1 WHERE contact_id <> $2 AND status = 'active'`, [user, contactId]);
        expect(await del(tx, user, inv, claim)).toBe(false);
        expect(await exists(tx, user)).toBe(true);
      });
    });
  });
});
