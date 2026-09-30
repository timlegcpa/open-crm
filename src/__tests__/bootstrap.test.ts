// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BAN_FOR_A_CENTURY,
  FUNCTION_SECRETS,
  SYSTEM_ACTOR_EMAIL,
  ensurePrincipals,
  generateSecrets,
  mergeEnv,
  ownerProblems,
  parseArgs,
  parseEnv,
  projectProblems,
  passwordProblem,
  systemActorPassword,
} from '../../scripts/lib/bootstrap-core.mjs';
import { randomBytes } from 'node:crypto';

describe('projectProblems', () => {
  const good = { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'sb_publishable_x', serviceKey: 'sb_secret_y' };
  it('accepts a hosted project and a local address', () => {
    expect(projectProblems(good)).toEqual([]);
    expect(projectProblems({ ...good, url: 'http://127.0.0.1:54321' })).toEqual([]);
  });
  it('refuses plain http to a remote host, and a non-URL', () => {
    expect(projectProblems({ ...good, url: 'http://abcdefghijklmnopqrst.supabase.co' })).toHaveLength(1);
    expect(projectProblems({ ...good, url: 'abcdefghijklmnopqrst' })).toHaveLength(1);
  });
  it('refuses missing or spaced keys, and the service key as the browser key', () => {
    expect(projectProblems({ ...good, anonKey: '' })).toHaveLength(1);
    expect(projectProblems({ ...good, serviceKey: 'a b' })).toHaveLength(1);
    expect(projectProblems({ ...good, anonKey: good.serviceKey })).toHaveLength(1);
  });
});

describe('mergeEnv', () => {
  it('adds only what is missing and never changes an existing value', () => {
    const before = '# local\nCRON_SHARED_SECRET=keep-me\n';
    const { text, added } = mergeEnv(before, { CRON_SHARED_SECRET: 'new', MCP_INTERNAL_SECRET: 'abc' });
    expect(added).toEqual(['MCP_INTERNAL_SECRET']);
    expect(parseEnv(text).get('CRON_SHARED_SECRET')).toBe('keep-me');
    expect(parseEnv(text).get('MCP_INTERNAL_SECRET')).toBe('abc');
    expect(text.startsWith('# local\n')).toBe(true);
  });
  it('is a no-op on a second run', () => {
    const first = mergeEnv('', { A: '1', B: '2' }).text;
    expect(mergeEnv(first, { A: '9', B: '9' })).toEqual({ text: first, added: [] });
  });
  it('fills an empty placeholder without leaving the empty line behind', () => {
    const { text, added } = mergeEnv('VITE_SUPABASE_URL=\nOTHER=x\n', { VITE_SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(added).toEqual(['VITE_SUPABASE_URL']);
    expect(text).toBe('OTHER=x\nVITE_SUPABASE_URL=http://127.0.0.1:54321\n');
  });
  it('refuses a value that could break out of its line', () => {
    expect(() => mergeEnv('', { A: 'x\nB=evil' })).toThrow(/unsafe/);
  });
});

describe('generateSecrets', () => {
  it('produces every secret at its length and encoding', () => {
    let n = 0;
    const secrets = generateSecrets((size: number) => Buffer.alloc(size, ++n));
    for (const { name, bytes, encoding } of FUNCTION_SECRETS) {
      expect(Buffer.from(secrets[name], encoding as BufferEncoding).length).toBe(bytes);
    }
    expect(new Set(Object.values(secrets)).size).toBe(FUNCTION_SECRETS.length);
  });
});

describe('ownerProblems and parseArgs', () => {
  const good = { email: 'owner@example.com', password: 'Good-pass-1', orgName: 'Example' };
  it('accepts a usable owner', () => {
    expect(ownerProblems(good)).toEqual([]);
  });
  it.each([
    ['short', 'Ab-1'],
    ['no upper', 'good-pass-1'],
    ['no lower', 'GOOD-PASS-1'],
    ['no digit', 'Good-pass-x'],
    ['no symbol', 'Goodpass11'],
    ['a space is not a symbol', 'Good pass1'],
    ['a non-ASCII letter is not a symbol', 'Goodpäss11'],
  ])('refuses a weak password (%s)', (_label, password) => {
    expect(ownerProblems({ ...good, password })).toHaveLength(1);
  });
  it('refuses a bad email, the system actor email and a blank org name', () => {
    expect(ownerProblems({ ...good, email: 'nope' })).toHaveLength(1);
    expect(ownerProblems({ ...good, email: SYSTEM_ACTOR_EMAIL.toUpperCase() })).toHaveLength(1);
    expect(ownerProblems({ ...good, orgName: '   ' })).toHaveLength(1);
  });
  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs(['--email', 'a@b.co', '--org-name', 'X Y', '--yes'])).toEqual({ email: 'a@b.co', orgName: 'X Y', yes: true, adoptExisting: false });
    expect(parseArgs(['--adopt-existing']).adoptExisting).toBe(true);
    expect(() => parseArgs(['--pasword', 'x'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--email'])).toThrow(/needs a value/);
  });
});

type User = { id: string; email: string; banned_until?: string };
type Profile = { owner_user_id: string | null; system_user_id: string | null; display_name?: string };

/** A service-role client with just the calls ensurePrincipals makes. */
function fakeDb(users: User[], profile: Profile | null) {
  const state = {
    users: [...users],
    profile,
    created: [] as Array<Record<string, unknown>>,
    passwordSet: [] as Array<{ id: string; password: string }>,
    rebanned: [] as string[],
  };
  let nextId = 100;
  const db = {
    auth: {
      admin: {
        async listUsers({ page, perPage }: { page: number; perPage: number }) {
          return { data: { users: state.users.slice((page - 1) * perPage, page * perPage) }, error: null };
        },
        async getUserById(id: string) {
          return { data: { user: state.users.find((u) => u.id === id) ?? null }, error: null };
        },
        async updateUserById(id: string, attrs: { password?: string; ban_duration?: string }) {
          if (attrs.password) state.passwordSet.push({ id, password: attrs.password });
          if (attrs.ban_duration) state.rebanned.push(id);
          return { data: { user: state.users.find((u) => u.id === id) }, error: null };
        },
        async createUser(attrs: { email: string; ban_duration?: string }) {
          const user: User = { id: `u${nextId++}`, email: attrs.email };
          if (attrs.ban_duration) user.banned_until = new Date(Date.now() + 3e12).toISOString();
          state.users.push(user);
          state.created.push(attrs);
          return { data: { user }, error: null };
        },
      },
    },
    from(table: string) {
      expect(table).toBe('org_profile');
      return {
        select: () => ({ maybeSingle: async () => ({ data: state.profile, error: null }) }),
        insert: async (row: Profile) => {
          state.profile = row;
          return { error: null };
        },
        update: (patch: Partial<Profile>) => ({
          eq: async () => {
            state.profile = { ...state.profile!, ...patch };
            return { error: null };
          },
        }),
      };
    },
  };
  return { db, state };
}

const owner = { email: 'owner@example.com', password: 'Good-pass-1', orgName: '  Example Firm ' };

describe('ensurePrincipals', () => {
  it('creates the owner, a banned system actor and the org row on a fresh stack', async () => {
    const { db, state } = fakeDb([], null);
    const result = await ensurePrincipals(db, owner, () => 'rnd');
    expect(result).toMatchObject({ ownerCreated: true, systemCreated: true, profileCreated: true });
    expect(state.profile).toMatchObject({ display_name: 'Example Firm', owner_user_id: result.ownerId, system_user_id: result.systemId });
    const system = state.created.find((c) => c.email === SYSTEM_ACTOR_EMAIL)!;
    expect(system.ban_duration).toBe(BAN_FOR_A_CENTURY);
    expect(system.password).toBe('rnd');
    expect(result.ownerId).not.toBe(result.systemId);
  });

  it('changes nothing on a second run', async () => {
    const { db, state } = fakeDb([], null);
    const first = await ensurePrincipals(db, owner, () => 'rnd');
    const snapshot = JSON.stringify(state.profile);
    const second = await ensurePrincipals(db, owner, () => 'rnd');
    expect(second).toEqual({ ...first, ownerCreated: false, ownerAdopted: false, systemCreated: false, profileCreated: false });
    expect(JSON.stringify(state.profile)).toBe(snapshot);
    expect(state.users).toHaveLength(2);
  });

  it('finds an existing account past the first page of users', async () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `x${i}`, email: `c${i}@example.com` }));
    const { db } = fakeDb([...many, { id: 'o1', email: 'OWNER@example.com' }], null);
    const result = await ensurePrincipals(db, { ...owner, adoptExisting: true }, () => 'rnd');
    expect(result.ownerId).toBe('o1');
    expect(result.ownerCreated).toBe(false);
  });

  it('refuses an account at the owner email that bootstrap never recorded, and writes nothing', async () => {
    const { db, state } = fakeDb([{ id: 'stranger', email: 'owner@example.com' }], null);
    await expect(ensurePrincipals(db, owner, () => 'rnd')).rejects.toThrow(/--adopt-existing/);
    expect(state.created).toHaveLength(0);
    expect(state.passwordSet).toHaveLength(0);
    expect(state.profile).toBeNull();
  });

  it('adopts that account only when asked, and sets the password given', async () => {
    const { db, state } = fakeDb([{ id: 'mine', email: 'owner@example.com' }], null);
    const result = await ensurePrincipals(db, { ...owner, adoptExisting: true }, () => 'rnd');
    expect(result).toMatchObject({ ownerId: 'mine', ownerAdopted: true, ownerCreated: false });
    expect(state.passwordSet).toEqual([{ id: 'mine', password: owner.password }]);
    expect(state.profile?.owner_user_id).toBe('mine');
  });

  it('refuses an unbanned account at the system address before writing anything', async () => {
    const { db, state } = fakeDb([{ id: 'sys', email: SYSTEM_ACTOR_EMAIL }], null);
    await expect(ensurePrincipals(db, owner, () => 'rnd')).rejects.toThrow(/not banned/);
    expect(state.created).toHaveLength(0);
    expect(state.profile).toBeNull();
  });

  it('puts the ban back on a recorded system actor that was unbanned by hand', async () => {
    const { db, state } = fakeDb([], null);
    const first = await ensurePrincipals(db, owner, () => 'rnd');
    state.users.find((u) => u.id === first.systemId)!.banned_until = undefined;
    await ensurePrincipals(db, owner, () => 'rnd');
    expect(state.rebanned).toEqual([first.systemId]);
  });

  it('refuses an account at the system address whose ban runs out soon', async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const { db, state } = fakeDb([{ id: 'sys', email: SYSTEM_ACTOR_EMAIL, banned_until: soon }], null);
    await expect(ensurePrincipals(db, owner, () => 'rnd')).rejects.toThrow(/not banned/);
    expect(state.created).toHaveLength(0);
  });

  it('re-bans a recorded system actor whose ban runs out soon', async () => {
    const { db, state } = fakeDb([], null);
    const first = await ensurePrincipals(db, owner, () => 'rnd');
    state.users.find((u) => u.id === first.systemId)!.banned_until = new Date(Date.now() + 86_400_000).toISOString();
    await ensurePrincipals(db, owner, () => 'rnd');
    expect(state.rebanned).toEqual([first.systemId]);
  });

  it('reuses a banned account at the system address', async () => {
    const future = new Date(Date.now() + 3e12).toISOString();
    const { db } = fakeDb([{ id: 'sys', email: SYSTEM_ACTOR_EMAIL, banned_until: future }], null);
    const result = await ensurePrincipals(db, owner, () => 'rnd');
    expect(result).toMatchObject({ systemId: 'sys', systemCreated: false });
  });

  it('refuses a second, different owner and creates nothing', async () => {
    const { db, state } = fakeDb([{ id: 'o1', email: 'first@example.com' }, { id: 's1', email: SYSTEM_ACTOR_EMAIL }], {
      owner_user_id: 'o1',
      system_user_id: 's1',
    });
    await expect(ensurePrincipals(db, owner, () => 'rnd')).rejects.toThrow(/different email/);
    expect(state.created).toHaveLength(0);
    expect(state.profile?.owner_user_id).toBe('o1');
  });

  it('fills principals into a row that exists without them', async () => {
    // A row with no principals but a display name: seeded by hand before bootstrap.
    const { db, state } = fakeDb([], { owner_user_id: null, system_user_id: null, display_name: 'Kept' });
    const result = await ensurePrincipals(db, owner, () => 'rnd');
    expect(state.profile).toMatchObject({ display_name: 'Kept', owner_user_id: result.ownerId, system_user_id: result.systemId });
  });
});

describe('systemActorPassword', () => {
  it('always meets the owner password rules, which Auth applies to every account', () => {
    for (let i = 0; i < 2000; i++) expect(passwordProblem(systemActorPassword(randomBytes))).toBeNull();
  });
  it('a century ban is at least fifty years', () => {
    expect(parseInt(BAN_FOR_A_CENTURY, 10)).toBeGreaterThanOrEqual(50 * 365 * 24);
  });
});
