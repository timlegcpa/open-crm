// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, as, count as countRows, createDb, errorOf, service, session, tryIn, user } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const USER_C = '00000000-0000-4000-8000-00000000000c';
const FORGER = '00000000-0000-4000-8000-00000000000f';

const CONTACT_A = '10000000-0000-4000-8000-00000000000a';
const CONTACT_B = '10000000-0000-4000-8000-00000000000b';
const CONTACT_C = '10000000-0000-4000-8000-00000000000c';
const ORG_A = '20000000-0000-4000-8000-00000000000a';
const ORG_B = '20000000-0000-4000-8000-00000000000b';
const TASK_A = '30000000-0000-4000-8000-00000000000a';
const TASK_B = '30000000-0000-4000-8000-00000000000b';

const owner = user(OWNER);
const clientA = user(USER_A);
const clientB = user(USER_B);
const clientC = user(USER_C); // account suspended
const forger = user(FORGER, { appRole: 'admin' }); // signed in, no account, forged claim

const TABLES = [
  'contact_statuses', 'lead_sources', 'organization_types', 'service_types',
  'contacts', 'organizations', 'contact_emails', 'contact_notes', 'contact_relationships',
  'contact_followups', 'contact_services', 'contact_upsells', 'client_portal_accounts',
  'portal_invitations', 'client_activity_log', 'client_tasks', 'impersonation_sessions',
];

// What client A may see, per table. Everything else is zero rows.
const CLIENT_A_VISIBLE: Record<string, 'own' | 'all'> = {
  organization_types: 'all',
  organizations: 'own',
  client_portal_accounts: 'own',
  client_tasks: 'own',
};

// Every function a signed-in session may call directly, across all migrations. Any
// other function in public is the server's alone (or a trigger's, which needs no grant).
const AUTHENTICATED_CALLABLE = [
  'is_owner()', 'mfa_session_ok()', 'user_has_verified_mfa()', 'audit_actor()', 'is_owner_or_server()',
  'org_profile_guard_principals()', 'set_updated_at()', 'retry_job(uuid)', 'get_job_status_counts()',
  'get_org_branding()',
  'get_client_contact_id()', 'get_my_contact()', 'get_my_activity(integer)',
  'contact_emails_set_default(uuid,uuid,text)',
];
const ANON_CALLABLE = ['get_org_branding()'];
const SERVER_RPCS = [
  'get_client_contact_id()', 'increment_invitation_attempt(uuid,integer)', 'contact_delete_claim_live(uuid)',
  'admin_contact_delete_begin(uuid)', 'admin_contact_delete_release(uuid,jsonb,uuid,uuid[])',
  'admin_delete_contact(uuid,uuid)',
];

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test'),
      ('${USER_C}', 'c@example.test'), ('${FORGER}', 'f@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id)
      VALUES ('Example Co', '${OWNER}', '${SYSTEM}');

    INSERT INTO public.contacts (id, first_name, last_name, email, status) VALUES
      ('${CONTACT_A}', 'Ada', 'Able', 'a@example.test', 'client'),
      ('${CONTACT_B}', 'Bo', 'Baker', 'b@example.test', 'client'),
      ('${CONTACT_C}', 'Cy', 'Cole', 'c@example.test', 'client');
    INSERT INTO public.organizations (id, contact_id, name, organization_type) VALUES
      ('${ORG_A}', '${CONTACT_A}', 'Able Works', 'llc'),
      ('${ORG_B}', '${CONTACT_B}', 'Baker Goods', 'corporation');
    INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES
      ('${CONTACT_A}', '${USER_A}', 'active', 'a@example.test'),
      ('${CONTACT_B}', '${USER_B}', 'active', 'b@example.test'),
      ('${CONTACT_C}', '${USER_C}', 'suspended', 'c@example.test');
    INSERT INTO public.client_tasks (id, contact_id, title, type) VALUES
      ('${TASK_A}', '${CONTACT_A}', 'Upload ID', 'document_request'),
      ('${TASK_B}', '${CONTACT_B}', 'Upload ID', 'document_request');
    INSERT INTO public.client_activity_log (contact_id, user_id, action) VALUES
      ('${CONTACT_A}', '${USER_A}', 'login'), ('${CONTACT_B}', '${USER_B}', 'login');
    INSERT INTO public.contact_notes (contact_id, body) VALUES ('${CONTACT_A}', 'Called');
    INSERT INTO public.contact_relationships (contact_id, related_contact_id, relationship)
      VALUES ('${CONTACT_A}', '${CONTACT_B}', 'business_partner');
    INSERT INTO public.contact_followups (contact_id, next_followup_date) VALUES ('${CONTACT_A}', '2030-01-01');
    INSERT INTO public.contact_services (contact_id, organization_id, service_type, state, cadence, amount)
      VALUES ('${CONTACT_A}', '${ORG_A}', 'retainer', 'accepted', 'monthly', 500);
    INSERT INTO public.contact_upsells (contact_id, title, service_type) VALUES ('${CONTACT_A}', 'Add a plan', 'annual_plan');
    INSERT INTO public.portal_invitations (email, contact_id, expires_at)
      VALUES ('a@example.test', '${CONTACT_A}', now() + interval '1 day');
    INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email)
      VALUES ('${OWNER}', '${CONTACT_A}', '${USER_A}', 'a@example.test');
  `);
}, 60_000);

const count = (who: Parameters<typeof as>[1], table: string, where?: string) => countRows(db, who, table, where);

describe('who can read what', () => {
  it('every table in public has row-level security on', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it('anon has no access to any contacts table', async () => {
    for (const t of TABLES) {
      expect(await errorOf(db, anon, `SELECT 1 FROM public.${t}`), t).toMatch(/permission denied/);
    }
  });

  it('the owner reads every table, and a forged admin claim reads nothing', async () => {
    for (const t of TABLES) {
      expect(await count(owner, t), t).toBeGreaterThan(0);
      expect(await count(forger, t), t).toBe(0);
    }
  });

  it('a client reads only its own rows, and only where a policy says so', async () => {
    for (const t of TABLES) {
      const scope = CLIENT_A_VISIBLE[t];
      const n = await count(clientA, t);
      if (!scope) expect(n, t).toBe(0);
      else if (scope === 'all') expect(n, t).toBe(await count(owner, t));
      else expect(n, t).toBe(await count(owner, t, `contact_id = '${CONTACT_A}'`));
    }
    expect(await count(clientA, 'organizations', `contact_id = '${CONTACT_B}'`)).toBe(0);
  });

  it('get_my_contact returns the caller’s own contact, and nobody else’s', async () => {
    const mine = await as<{ id: string }>(db, clientA, 'SELECT id FROM public.get_my_contact()');
    expect(mine.map((r) => r.id)).toEqual([CONTACT_A]);
    expect(await as(db, forger, 'SELECT id FROM public.get_my_contact()')).toEqual([]);
    expect(await errorOf(db, anon, 'SELECT id FROM public.get_my_contact()')).toMatch(/permission denied/);
  });

  it('a suspended account is not a client', async () => {
    expect(await as(db, clientC, 'SELECT id FROM public.get_my_contact()')).toEqual([]);
    expect(await count(clientC, 'client_portal_accounts')).toBe(0);
  });

  it('client_tasks is published to realtime', async () => {
    const rows = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`);
    expect(rows.rows.map((r) => r.tablename)).toContain('client_tasks');
  });
});

describe('the MFA gate', () => {
  it('an MFA-enrolled client at aal1 reads nothing, at aal2 reads its rows', async () => {
    const counts = await session(db, service, async (tx) => {
      await tx.exec(`RESET ROLE; INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${USER_A}', 'verified')`);
      const read = async (aal: string) => {
        const claims = JSON.stringify({ sub: USER_A, role: 'authenticated', aal, iat: Math.floor(Date.now() / 1000) });
        await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.exec('SET LOCAL ROLE authenticated');
        const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.client_tasks')).rows[0].n;
        await tx.exec('RESET ROLE');
        return n;
      };
      return { aal1: await read('aal1'), aal2: await read('aal2') };
    });
    expect(counts).toEqual({ aal1: 0, aal2: 1 });
  });

  it('every table carries the restrictive gate', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive
                         AND pg_get_expr(p.polqual, p.polrelid) LIKE '%mfa_session_ok()%'
                         AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%mfa_session_ok()%')`);
    expect(rows).toEqual([]);
  });
});

describe('function privileges', () => {
  it('every function pins an empty search_path', async () => {
    const { rows } = await db.query<{ proname: string; cfg: string[] | null }>(
      `SELECT p.proname, p.proconfig AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`);
    const unpinned = rows.filter((r) => !(r.cfg ?? []).some((c) => /^search_path=(""|)$/.test(c)));
    expect(unpinned.map((r) => r.proname)).toEqual([]);
  });

  // Enumerated from the catalog, so a function added later without its REVOKE fails here.
  const allFunctions = async () =>
    (await db.query<{ sig: string }>(
      `SELECT p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
    )).rows.map((r) => r.sig.replace(/, /g, ','));

  const can = async (role: string, sig: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `public.${sig}`])).rows[0].ok;

  it('anon and signed-in sessions can call exactly their lists, nothing else', async () => {
    const fns = await allFunctions();
    expect(fns.length).toBeGreaterThan(30);
    for (const f of fns) {
      expect(await can('anon', f), `anon ${f}`).toBe(ANON_CALLABLE.includes(f));
      expect(await can('authenticated', f), `authenticated ${f}`).toBe(AUTHENTICATED_CALLABLE.includes(f));
    }
  });

  it('the server can call its RPCs', async () => {
    for (const f of SERVER_RPCS) expect(await can('service_role', f), f).toBe(true);
  });

  it('triggers still fire for a signed-in session without an EXECUTE grant', async () => {
    const rows = await as<{ status_history: unknown[] }>(db, owner,
      `INSERT INTO public.contacts (first_name) VALUES ('Dee') RETURNING status_history`);
    expect(rows[0].status_history).toHaveLength(1);
  });
});

describe('who can write what', () => {
  it('a client cannot write the owner-only tables', async () => {
    expect(await errorOf(db, clientA, `INSERT INTO public.contacts (first_name) VALUES ('x')`)).toMatch(/row-level security/);
    expect(await errorOf(db, clientA, `INSERT INTO public.organizations (contact_id, name) VALUES ('${CONTACT_A}', 'x')`)).toMatch(/row-level security/);
    expect(await as(db, clientA, `UPDATE public.contacts SET first_name = 'x' RETURNING id`)).toEqual([]);
    expect(await errorOf(db, clientA, `UPDATE public.contact_notes SET body = 'x'`)).toMatch(/permission denied/);
  });

  it('notes are append-only, for the owner and the server alike', async () => {
    for (const who of [owner, service]) {
      expect(await errorOf(db, who, `UPDATE public.contact_notes SET body = 'x'`)).toMatch(/permission denied/);
      expect(await errorOf(db, who, `DELETE FROM public.contact_notes`)).toMatch(/permission denied/);
    }
  });

  it('the server has row access but cannot TRUNCATE', async () => {
    expect(await count(service, 'contacts')).toBe(3);
    expect(await errorOf(db, service, 'TRUNCATE public.contacts CASCADE')).toMatch(/permission denied/);
  });

  it('the owner sees a contact but cannot delete it, or a portal account, directly', async () => {
    expect(await count(owner, 'contacts', `id = '${CONTACT_A}'`)).toBe(1);
    expect(await errorOf(db, owner, `DELETE FROM public.contacts WHERE id = '${CONTACT_A}'`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `DELETE FROM public.client_portal_accounts WHERE contact_id = '${CONTACT_A}'`)).toMatch(/permission denied/);
    // Only the server's claim protocol deletes; the owner cannot even call it.
    expect(await errorOf(db, owner, `SELECT * FROM public.admin_contact_delete_begin('${CONTACT_A}')`)).toMatch(/permission denied/);
  });

  it('the owner cannot write the delete-claim columns', async () => {
    expect(await errorOf(db, owner, `UPDATE public.contacts SET delete_claim = NULL`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.client_portal_accounts SET delete_claim = NULL`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.client_portal_accounts SET status_before_claim = 'active'`)).toMatch(/permission denied/);
  });

  it('a portal account can never hold the owner’s or the system actor’s sign-in', async () => {
    for (const staff of [OWNER, SYSTEM]) {
      expect(await errorOf(db, owner, `UPDATE public.client_portal_accounts SET user_id = '${staff}' WHERE contact_id = '${CONTACT_C}'`))
        .toMatch(/portal_account_staff_user/);
      expect(await errorOf(db, owner, `INSERT INTO public.client_portal_accounts (contact_id, user_id, status) VALUES ('${CONTACT_C}', '${staff}', 'invited')`))
        .toMatch(/portal_account_staff_user/);
    }
  });
});

describe('portal tasks', () => {
  it('a client can complete its own task, and completed_at is stamped by the database', async () => {
    const rows = await as<{ status: string; completed_at: string | null }>(db, clientA,
      `UPDATE public.client_tasks SET status = 'completed', completed_at = '2000-01-01' WHERE id = '${TASK_A}'
       RETURNING status, completed_at`);
    expect(rows[0].status).toBe('completed');
    expect(new Date(rows[0].completed_at!).getFullYear()).toBeGreaterThan(2000);
  });

  it('a client cannot rename, retype or relink a task', async () => {
    for (const set of [`title = 'x'`, `type = 'esign'`, `link = '/x'`, `metadata = '{"a":1}'`]) {
      expect(await errorOf(db, clientA, `UPDATE public.client_tasks SET ${set} WHERE id = '${TASK_A}'`), set)
        .toMatch(/not client-writable/);
    }
  });

  it('a client cannot reopen a task or touch another client’s', async () => {
    const err = await session(db, clientA, async (tx) => {
      await tx.exec(`UPDATE public.client_tasks SET status = 'completed' WHERE id = '${TASK_A}'`);
      return tryIn(tx, `UPDATE public.client_tasks SET status = 'pending' WHERE id = '${TASK_A}'`);
    });
    expect(err).toMatch(/cannot change from completed to pending/);
    expect(await as(db, clientA, `UPDATE public.client_tasks SET status = 'dismissed' WHERE id = '${TASK_B}' RETURNING id`)).toEqual([]);
  });

  it('a task link must stay on this site', async () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/ok\tbad',
      'https://evil.example', 'javascript:alert(1)']) {
      expect(await errorOf(db, service, `UPDATE public.client_tasks SET link = $1 WHERE id = '${TASK_A}'`, [bad]), JSON.stringify(bad))
        .toMatch(/check constraint/);
    }
    for (const good of ['/', '/portal/documents', '/portal/sign?id=1#top']) {
      expect(await errorOf(db, service, `UPDATE public.client_tasks SET link = $1 WHERE id = '${TASK_A}'`, [good]), good).toBeNull();
    }
  });
});

describe('portal activity', () => {
  it('a client records what it witnessed, and the database strips what it may not choose', async () => {
    const rows = await session(db, clientA, async (tx) => {
      await tx.exec(`INSERT INTO public.client_activity_log (contact_id, user_id, action, ip_address, details)
        VALUES ('${CONTACT_A}', '${USER_A}', 'message_read', '1.2.3.4', '{"actor_email":"x@y","actor_role":"owner"}')`);
      await tx.exec('RESET ROLE');
      return (await tx.query<{ ip_address: string | null; details: Record<string, unknown> }>(
        `SELECT ip_address, details FROM public.client_activity_log WHERE action = 'message_read'`)).rows;
    });
    expect(rows).toEqual([{ ip_address: null, details: { actor_role: 'client' } }]);
  });

  it('a client reads its history through get_my_activity, without anyone’s network details', async () => {
    const rows = await session(db, service, async (tx) => {
      await tx.exec(`INSERT INTO public.client_activity_log (contact_id, user_id, action, ip_address, user_agent)
        VALUES ('${CONTACT_A}', '${OWNER}', 'email_sent', '9.9.9.9', 'owner browser')`);
      await tx.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${USER_A}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`);
      return (await tx.query<Record<string, unknown>>('SELECT * FROM public.get_my_activity()')).rows;
    });
    expect(rows.map((r) => [r.action, r.by_me])).toEqual([['email_sent', false], ['login', true]]);
    expect(Object.keys(rows[0]).sort()).toEqual(['action', 'by_me', 'created_at', 'id']);
    expect(await as(db, clientA, 'SELECT id FROM public.client_activity_log')).toEqual([]);
  });

  it('view events are not recorded', async () => {
    expect(await errorOf(db, service,
      `INSERT INTO public.client_activity_log (contact_id, action) VALUES ('${CONTACT_A}', 'profile_view')`)).toMatch(/check constraint/);
  });

  it('a client cannot forge a lifecycle event or write to another contact', async () => {
    expect(await errorOf(db, clientA,
      `INSERT INTO public.client_activity_log (contact_id, user_id, action) VALUES ('${CONTACT_A}', '${USER_A}', 'account_deleted')`))
      .toMatch(/row-level security/);
    expect(await errorOf(db, clientA,
      `INSERT INTO public.client_activity_log (contact_id, user_id, action) VALUES ('${CONTACT_B}', '${USER_A}', 'message_read')`))
      .toMatch(/row-level security/);
  });

  it('activity details are bounded in size', async () => {
    expect(await errorOf(db, clientA,
      `INSERT INTO public.client_activity_log (contact_id, user_id, action, details)
       VALUES ('${CONTACT_A}', '${USER_A}', 'message_read', jsonb_build_object('x', repeat('y', 20000)))`))
      .toMatch(/check constraint/);
  });
});

describe('email mirror', () => {
  const defaults = (tx: { query: PGlite['query'] }, id: string, kind = 'primary') =>
    tx.query<{ email: string }>(`SELECT email FROM public.contact_emails WHERE contact_id = $1 AND kind = $2 AND is_default`, [id, kind])
      .then((r) => r.rows.map((x) => x.email));
  const contactEmails = (tx: { query: PGlite['query'] }, id: string) =>
    tx.query<{ email: string | null; spouse_email: string | null }>('SELECT email, spouse_email FROM public.contacts WHERE id = $1', [id])
      .then((r) => r.rows[0]);

  it('a new contact’s email becomes its default address', async () => {
    expect(await session(db, owner, (tx) => defaults(tx, CONTACT_A))).toEqual(['a@example.test']);
  });

  it('clearing the email leaves no deliverable default behind', async () => {
    const rows = await session(db, owner, async (tx) => {
      await tx.exec(`UPDATE public.contacts SET email = NULL WHERE id = '${CONTACT_A}'`);
      return defaults(tx, CONTACT_A);
    });
    expect(rows).toEqual([]);
  });

  it('switching the default, or deleting it, moves contacts.email with it', async () => {
    const result = await session(db, owner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.contact_emails (contact_id, kind, email) VALUES ('${CONTACT_A}', 'primary', 'a2@example.test') RETURNING id`);
      await tx.query('SELECT public.contact_emails_set_default($1, $2, $3)', [rows[0].id, CONTACT_A, 'primary']);
      const afterSwitch = (await contactEmails(tx, CONTACT_A)).email;
      await tx.query('DELETE FROM public.contact_emails WHERE id = $1', [rows[0].id]);
      const afterDelete = (await contactEmails(tx, CONTACT_A)).email;
      return { afterSwitch, afterDelete };
    });
    expect(result).toEqual({ afterSwitch: 'a2@example.test', afterDelete: null });
  });

  it('an address moved to another kind or contact takes its mirror with it', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.contact_emails SET kind = 'spouse' WHERE contact_id = '${CONTACT_A}' AND kind = 'primary'`);
      const a = await contactEmails(tx, CONTACT_A);
      await tx.exec(`UPDATE public.contact_emails SET contact_id = '${CONTACT_C}' WHERE contact_id = '${CONTACT_A}' AND kind = 'spouse'`);
      return { a, a2: await contactEmails(tx, CONTACT_A), c: await contactEmails(tx, CONTACT_C) };
    });
    expect(out.a).toEqual({ email: null, spouse_email: 'a@example.test' });
    expect(out.a2).toEqual({ email: null, spouse_email: null });
    expect(out.c.spouse_email).toBe('a@example.test');
  });

  it('the owner cannot move an address to another contact or kind', async () => {
    expect(await errorOf(db, owner, `UPDATE public.contact_emails SET kind = 'spouse'`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.contact_emails SET contact_id = '${CONTACT_B}'`)).toMatch(/permission denied/);
  });

  it('an email too short to be an address is refused on the contact itself', async () => {
    expect(await errorOf(db, owner, `INSERT INTO public.contacts (first_name, email) VALUES ('x', 'ab')`)).toMatch(/contacts_email_check/);
  });

  it('set-default refuses a row from another contact, and refuses a non-owner', async () => {
    const [{ id }] = await db.query<{ id: string }>(
      `SELECT id FROM public.contact_emails WHERE contact_id = '${CONTACT_B}' AND kind = 'primary'`).then((r) => r.rows);
    expect(await errorOf(db, owner, 'SELECT public.contact_emails_set_default($1, $2, $3)', [id, CONTACT_A, 'primary']))
      .toMatch(/no matching row/);
    expect(await errorOf(db, clientB, 'SELECT public.contact_emails_set_default($1, $2, $3)', [id, CONTACT_B, 'primary']))
      .toMatch(/owner required/);
  });
});

describe('quotes and businesses', () => {
  it('a quote cannot name another contact’s business', async () => {
    expect(await errorOf(db, owner,
      `INSERT INTO public.contact_services (contact_id, organization_id, service_type, state, cadence)
       VALUES ('${CONTACT_A}', '${ORG_B}', 'project', 'proposed', 'one_time')`)).toMatch(/foreign key/);
  });

  it('a business with quotes cannot be deleted, but its contact can be, with everything under it', async () => {
    expect(await errorOf(db, owner, `DELETE FROM public.organizations WHERE id = '${ORG_A}'`)).toMatch(/foreign key/);
    const left = await session(db, service, async (tx) => {
      await tx.exec(`DELETE FROM public.contacts WHERE id = '${CONTACT_A}'`);
      const n = async (t: string) =>
        (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t} WHERE contact_id = $1`, [CONTACT_A])).rows[0].n;
      return { orgs: await n('organizations'), services: await n('contact_services'), emails: await n('contact_emails') };
    });
    expect(left).toEqual({ orgs: 0, services: 0, emails: 0 });
  });

  it('pick-list values are enforced by foreign key', async () => {
    expect(await errorOf(db, owner, `INSERT INTO public.contacts (first_name, source) VALUES ('x', 'nowhere')`)).toMatch(/foreign key/);
    expect(await errorOf(db, owner, `INSERT INTO public.contacts (first_name, status) VALUES ('x', 'free_user')`)).toMatch(/foreign key/);
    expect(await errorOf(db, owner, `INSERT INTO public.contact_services (contact_id, service_type, state, cadence) VALUES ('${CONTACT_A}', 'tax_return', 'proposed', 'annual')`)).toMatch(/foreign key/);
  });
});

describe('pick-lists', () => {
  it('the owner relabels, adds and removes ordinary rows', async () => {
    expect(await errorOf(db, owner, `UPDATE public.lead_sources SET label = 'Friends' WHERE key = 'referral'`)).toBeNull();
    expect(await errorOf(db, owner, `INSERT INTO public.lead_sources (key, label) VALUES ('podcast', 'Podcast')`)).toBeNull();
    expect(await as(db, owner, `DELETE FROM public.lead_sources WHERE key = 'event' RETURNING key`)).toEqual([{ key: 'event' }]);
  });

  it('system rows stay, keys never change, and the pipeline has exactly its eight stages', async () => {
    expect(await as(db, owner, `DELETE FROM public.lead_sources WHERE key = 'esign' RETURNING key`)).toEqual([]);
    expect(await errorOf(db, owner, `INSERT INTO public.lead_sources (key, label, is_system) VALUES ('x', 'X', true)`)).toMatch(/created only by migrations/);
    expect(await errorOf(db, owner, `UPDATE public.lead_sources SET key = 'y' WHERE key = 'referral'`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.lead_sources SET is_system = false WHERE key = 'esign'`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `INSERT INTO public.contact_statuses (key, label) VALUES ('x', 'X')`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `DELETE FROM public.contact_statuses`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.contact_statuses SET label = 'Won' WHERE key = 'client'`)).toBeNull();
    expect(await count(owner, 'contact_statuses')).toBe(8);
  });

  it('the server is held to the same rules: built-in rows keep their meaning', async () => {
    expect(await errorOf(db, service, `DELETE FROM public.lead_sources WHERE key = 'esign'`)).toMatch(/cannot be deleted/);
    expect(await errorOf(db, service, `DELETE FROM public.contact_statuses WHERE key = 'lost'`)).toMatch(/cannot be deleted/);
    expect(await errorOf(db, service, `INSERT INTO public.contact_statuses (key, label) VALUES ('x', 'X')`)).toMatch(/created only by migrations/);
    expect(await errorOf(db, service, `UPDATE public.lead_sources SET key = 'y' WHERE key = 'referral'`)).toMatch(/key never changes/);
    expect(await errorOf(db, service, `UPDATE public.lead_sources SET is_system = true WHERE key = 'referral'`)).toMatch(/cannot become built-in/);
    expect(await errorOf(db, owner, `UPDATE public.lead_sources SET is_active = false WHERE key = 'esign'`)).toMatch(/only the label, colour and order/);
    expect(await errorOf(db, owner, `UPDATE public.service_types SET revenue_family = 'recurring' WHERE key = 'other'`)).toMatch(/only the label, colour and order/);
    expect(await errorOf(db, owner, `UPDATE public.lead_sources SET is_active = false, label = 'Old' WHERE key = 'referral'`)).toBeNull();
  });

  it('a client cannot change organization types', async () => {
    expect(await as(db, clientA, `UPDATE public.organization_types SET label = 'x' RETURNING key`)).toEqual([]);
  });
});

describe('housekeeping columns', () => {
  it('updated_at moves on every update', async () => {
    const rows = await session(db, owner, async (tx) => {
      await tx.exec(`SELECT pg_sleep(0.01)`);
      return (await tx.query<{ moved: boolean }>(
        `UPDATE public.contacts SET phone = '5' WHERE id = '${CONTACT_A}' RETURNING updated_at = now() AS moved`)).rows;
    });
    expect(rows).toEqual([{ moved: true }]);
  });

  it('an invitation stops counting attempts at the cap', async () => {
    const out = await session(db, service, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM public.portal_invitations LIMIT 1');
      const tries: Array<number | null> = [];
      for (let i = 0; i < 3; i++) {
        const r = await tx.query<{ n: number | null }>('SELECT public.increment_invitation_attempt($1, 2) AS n', [rows[0].id]);
        tries.push(r.rows[0].n);
      }
      return tries;
    });
    expect(out).toEqual([1, 2, null]);
  });
});

describe('status history', () => {
  it('is written by the database on every status change, and a caller’s own history is dropped', async () => {
    const hist = await session(db, service, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.contacts (first_name, status_history) VALUES ('Cy', '[{"status":"client"}]') RETURNING id`);
      const id = rows[0].id;
      await tx.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`);
      await tx.query(`UPDATE public.contacts SET status = 'active_lead' WHERE id = $1`, [id]);
      await tx.exec('RESET ROLE');
      await tx.query(`UPDATE public.contacts SET phone = '1', status_history = '[]' WHERE id = $1`, [id]);
      return (await tx.query<{ h: Array<{ status: string; changed_by: string }> }>(
        'SELECT status_history AS h FROM public.contacts WHERE id = $1', [id])).rows[0].h;
    });
    expect(hist.map((e) => e.status)).toEqual(['new_lead', 'active_lead']);
    expect(hist[0].changed_by).toBe(SYSTEM); // written by the server: the system actor
    expect(hist[1].changed_by).toBe(OWNER);
  });

  it('the owner cannot write status history at all', async () => {
    expect(await errorOf(db, owner, `UPDATE public.contacts SET status_history = '[]'`)).toMatch(/permission denied/);
  });
});

describe('contact delete claim', () => {
  const begin = (tx: Parameters<Parameters<typeof session>[2]>[0], id: string) =>
    tx.query<{ claim: string; user_ids: string[]; prior: Record<string, string>; blocking_code: string | null }>(
      'SELECT * FROM public.admin_contact_delete_begin($1)', [id]).then((r) => r.rows[0]);

  it('runs begin, refuses re-activation and a wrong claim, then deletes with the right one', async () => {
    const out = await session(db, service, async (tx) => {
      const first = await begin(tx, CONTACT_B);
      const second = await begin(tx, CONTACT_B);
      const reactivate = await tryIn(tx, `UPDATE public.client_portal_accounts SET status = 'active' WHERE contact_id = $1`, [CONTACT_B]);
      const wrong = await tryIn(tx, 'SELECT public.admin_delete_contact($1, gen_random_uuid())', [CONTACT_B]);
      const deleted = (await tx.query<{ ids: string[] }>('SELECT public.admin_delete_contact($1, $2) AS ids', [CONTACT_B, first.claim])).rows[0].ids;
      const left = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.contacts WHERE id = $1', [CONTACT_B])).rows[0].n;
      return { first, second, reactivate, wrong, deleted, left };
    });
    expect(out.first.user_ids).toEqual([USER_B]);
    expect(Object.values(out.first.prior)).toEqual(['active']);
    expect(out.second.blocking_code).toBe('delete_in_progress');
    expect(out.reactivate).toMatch(/contact_delete_in_progress/);
    expect(out.wrong).toMatch(/contact_delete_claim_mismatch/);
    expect(out.deleted).toEqual([USER_B]);
    expect(out.left).toBe(0);
  });

  it('under a live claim: a login can be cleared, but nothing can attach, join or leave', async () => {
    const out = await session(db, service, async (tx) => {
      await begin(tx, CONTACT_B);
      return {
        clear: await tryIn(tx, `UPDATE public.client_portal_accounts SET user_id = NULL WHERE contact_id = $1`, [CONTACT_B]),
        insert: await tryIn(tx, `INSERT INTO public.client_portal_accounts (contact_id, status) VALUES ($1, 'invited')`, [CONTACT_B]),
        attach: await tryIn(tx, `UPDATE public.client_portal_accounts SET user_id = $2 WHERE contact_id = $1`, [CONTACT_B, FORGER]),
        leave: await tryIn(tx, `UPDATE public.client_portal_accounts SET contact_id = $2 WHERE contact_id = $1`, [CONTACT_B, CONTACT_C]),
        join: await tryIn(tx, `UPDATE public.client_portal_accounts SET contact_id = $2 WHERE contact_id = $1`, [CONTACT_C, CONTACT_B]),
      };
    });
    expect(out.clear).toBeNull();
    for (const k of ['insert', 'attach', 'leave', 'join'] as const) expect(out[k], k).toMatch(/contact_delete_in_progress/);
  });

  it('release marks a destroyed login deactivated', async () => {
    const statuses = await session(db, service, async (tx) => {
      const b = await begin(tx, CONTACT_B);
      await tx.query('SELECT public.admin_contact_delete_release($1, $2, $3, $4)', [CONTACT_B, JSON.stringify(b.prior), b.claim, [USER_B]]);
      return (await tx.query('SELECT status, user_id, delete_claim FROM public.client_portal_accounts WHERE contact_id = $1', [CONTACT_B])).rows;
    });
    expect(statuses).toEqual([{ status: 'deactivated', user_id: null, delete_claim: null }]);
  });

  it('release of a delete that destroyed nothing gives the client its active account back', async () => {
    const statuses = await session(db, service, async (tx) => {
      const b = await begin(tx, CONTACT_B);
      await tx.query('SELECT public.admin_contact_delete_release($1, $2, $3)', [CONTACT_B, JSON.stringify(b.prior), b.claim]);
      return (await tx.query('SELECT status, user_id FROM public.client_portal_accounts WHERE contact_id = $1', [CONTACT_B])).rows;
    });
    expect(statuses).toEqual([{ status: 'active', user_id: USER_B }]);
  });

  it('a delete that died before release does not cost the client its account on the next attempt', async () => {
    const statuses = await session(db, service, async (tx) => {
      await begin(tx, CONTACT_B); // dies here: no delete, no release
      await tx.exec(`UPDATE public.contacts SET delete_claimed_at = now() - interval '10 minutes' WHERE id = '${CONTACT_B}';
                     UPDATE public.client_portal_accounts SET delete_claimed_at = now() - interval '10 minutes' WHERE contact_id = '${CONTACT_B}';`);
      const retry = await begin(tx, CONTACT_B);
      await tx.query('SELECT public.admin_contact_delete_release($1, $2, $3)', [CONTACT_B, JSON.stringify(retry.prior), retry.claim]);
      return (await tx.query('SELECT status FROM public.client_portal_accounts WHERE contact_id = $1', [CONTACT_B])).rows;
    });
    expect(statuses).toEqual([{ status: 'active' }]);
  });

  it('refuses an absent claim and an expired one', async () => {
    expect(await errorOf(db, service, 'SELECT public.admin_delete_contact($1)', [CONTACT_B])).toMatch(/contact_delete_claim_missing/);
    const expired = await session(db, service, async (tx) => {
      const b = await begin(tx, CONTACT_B);
      await tx.exec(`UPDATE public.contacts SET delete_claimed_at = now() - interval '10 minutes' WHERE id = '${CONTACT_B}'`);
      return tryIn(tx, 'SELECT public.admin_delete_contact($1, $2)', [CONTACT_B, b.claim]);
    });
    expect(expired).toMatch(/contact_delete_claim_expired/);
  });
});
