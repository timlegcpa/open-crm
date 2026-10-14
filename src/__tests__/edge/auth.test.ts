// @vitest-environment node
// authorizeOwner / authorizeClient against fake clients that record who was asked what.
// The point under test is WHO answers: the session through the service client, the
// principal through a client that carries the caller's own token, and the View-as-client
// rule through the service client, failing closed.
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeClient,
  authorizeOwner,
  jwtSessionId,
  MAX_TOKEN_LENGTH,
  sessionUserId,
  supabaseClients,
  type AuthDeps,
} from '../../../supabase/functions/_shared/auth';

const USER = '00000000-0000-4000-8000-0000000000b1';
const CONTACT = '10000000-0000-4000-8000-0000000000b1';
const SESSION = '20000000-0000-4000-8000-0000000000b1';
const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (claims: object) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;
const TOKEN = tokenFor({ sub: USER, session_id: SESSION });

type Answer = { data: unknown; error: unknown };

function fakes(opts: {
  user?: { id: string } | null;
  getUserError?: unknown;
  caller?: Record<string, Answer>;
  service?: Record<string, Answer | 'throw'>;
}) {
  const calls: Array<{ via: string; fn: string; args?: Record<string, unknown> }> = [];
  const deps: AuthDeps = {
    service: {
      auth: {
        getUser: async (token: string) => {
          calls.push({ via: 'service.auth', fn: 'getUser', args: { token } });
          return { data: { user: opts.user === undefined ? { id: USER } : opts.user }, error: opts.getUserError ?? null };
        },
      },
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        calls.push({ via: 'service', fn, args });
        const answer = opts.service?.[fn];
        if (answer === 'throw') throw new Error('network');
        return answer ?? { data: null, error: { message: `no fake for ${fn}` } };
      },
    },
    asCaller: (token: string) => ({
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        calls.push({ via: `caller:${token}`, fn, args });
        return opts.caller?.[fn] ?? { data: null, error: { message: `no fake for ${fn}` } };
      },
    }),
  };
  return { deps, calls };
}

describe('authorizeOwner', () => {
  it('asks is_owner as the caller, with the caller token, never through the service client', async () => {
    const { deps, calls } = fakes({ caller: { is_owner: { data: true, error: null } } });
    expect(await authorizeOwner(deps, TOKEN)).toEqual({ ok: true, principal: { kind: 'owner', userId: USER } });
    expect(calls).toEqual([
      { via: 'service.auth', fn: 'getUser', args: { token: TOKEN } },
      { via: `caller:${TOKEN}`, fn: 'is_owner', args: undefined },
    ]);
  });

  it('a dead session is 401 and the database is not asked', async () => {
    for (const f of [fakes({ getUserError: { status: 401 } }), fakes({ user: null }), fakes({ user: { id: '' } })]) {
      expect(await authorizeOwner(f.deps, TOKEN)).toEqual({ ok: false, status: 401 });
      expect(f.calls.map((c) => c.fn)).toEqual(['getUser']);
    }
  });

  it('a live session that is not the owner is 403; only an explicit true passes', async () => {
    for (const data of [false, null, 'true', 1]) {
      const { deps } = fakes({ caller: { is_owner: { data, error: null } } });
      expect([data, await authorizeOwner(deps, TOKEN)]).toEqual([data, { ok: false, status: 403 }]);
    }
  });

  it('throws when the database cannot answer, for the handler to refuse', async () => {
    const { deps } = fakes({ caller: { is_owner: { data: null, error: { code: '57014' } } } });
    await expect(authorizeOwner(deps, TOKEN)).rejects.toEqual({ code: '57014' });
  });
});

describe('authorizeClient', () => {
  const contact = { get_client_contact_id: { data: CONTACT, error: null } };

  it('names the contact as the caller and checks this session through the service client', async () => {
    const { deps, calls } = fakes({ caller: contact, service: { is_impersonation_session: { data: false, error: null } } });
    expect(await authorizeClient(deps, TOKEN)).toEqual({
      ok: true,
      principal: { kind: 'client', userId: USER, contactId: CONTACT, sessionId: SESSION, impersonating: false },
    });
    expect(calls.slice(1)).toEqual([
      { via: `caller:${TOKEN}`, fn: 'get_client_contact_id', args: undefined },
      { via: 'service', fn: 'is_impersonation_session', args: { p_user: USER, p_session: SESSION } },
    ]);
  });

  it('a dead session is 401; a live one with no active portal account is 403', async () => {
    expect(await authorizeClient(fakes({ user: null }).deps, TOKEN)).toEqual({ ok: false, status: 401 });
    for (const data of [null, 'not-a-uuid', 42]) {
      const { deps } = fakes({ caller: { get_client_contact_id: { data, error: null } } });
      expect([data, await authorizeClient(deps, TOKEN)]).toEqual([data, { ok: false, status: 403 }]);
    }
  });

  it('throws when the contact lookup errors', async () => {
    const { deps } = fakes({ caller: { get_client_contact_id: { data: null, error: { code: 'XX000' } } } });
    await expect(authorizeClient(deps, TOKEN)).rejects.toEqual({ code: 'XX000' });
  });

  it('View as client: true, null, an error or a throw all mean impersonating (fail closed)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<Answer | 'throw'> = [
      { data: true, error: null },
      { data: null, error: null },
      { data: false, error: { code: '42883' } },
      'throw',
    ];
    for (const answer of cases) {
      const { deps } = fakes({ caller: contact, service: { is_impersonation_session: answer } });
      const out = await authorizeClient(deps, TOKEN);
      expect([answer, out.ok && out.principal.impersonating]).toEqual([answer, true]);
    }
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('impersonation lookup failed'),
      expect.stringContaining('impersonation lookup failed'),
    ]);
    spy.mockRestore();
  });

  it('a token with no readable session id asks with a null session', async () => {
    const token = tokenFor({ sub: USER });
    const { deps, calls } = fakes({ caller: contact, service: { is_impersonation_session: { data: false, error: null } } });
    const out = await authorizeClient(deps, token);
    expect(out.ok && out.principal.sessionId).toBeNull();
    expect(calls.at(-1)?.args).toEqual({ p_user: USER, p_session: null });
  });
});

describe('jwtSessionId', () => {
  it('reads the session_id claim, with or without the Bearer prefix', () => {
    expect(jwtSessionId(TOKEN)).toBe(SESSION);
    expect(jwtSessionId(`Bearer ${TOKEN}`)).toBe(SESSION);
  });

  it('is null for a missing, non-uuid or unreadable claim', () => {
    expect(jwtSessionId(tokenFor({ sub: USER }))).toBeNull();
    expect(jwtSessionId(tokenFor({ session_id: "x' OR 1=1" }))).toBeNull();
    expect(jwtSessionId('not-a-jwt')).toBeNull();
    expect(jwtSessionId('a.%%%.c')).toBeNull();
  });
});

describe('sessionUserId: a live session, nothing more', () => {
  it('answers the user id of a live session and asks only Auth', async () => {
    const { deps, calls } = fakes({});
    expect(await sessionUserId(deps, TOKEN)).toBe(USER);
    expect(calls.map((c) => `${c.via}.${c.fn}`)).toEqual(['service.auth.getUser']);
  });

  it('is null for a dead session', async () => {
    for (const f of [fakes({ getUserError: { status: 401 } }), fakes({ user: null })]) {
      expect(await sessionUserId(f.deps, TOKEN)).toBeNull();
    }
  });

  it('refuses a missing or over-long token without asking Auth', async () => {
    const { deps, calls } = fakes({});
    expect(await sessionUserId(deps, null)).toBeNull();
    expect(await sessionUserId(deps, '')).toBeNull();
    expect(await sessionUserId(deps, 't'.repeat(MAX_TOKEN_LENGTH + 1))).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('supabaseClients', () => {
  it('builds the service client with the service key and the caller client with the anon key plus the token', () => {
    const made: unknown[][] = [];
    const createClient = (...args: unknown[]) => {
      made.push(args);
      return { n: made.length };
    };
    const config = { supabaseUrl: 'https://ref.supabase.co', anonKey: 'anon', serviceRoleKey: 'service' };
    const clients = supabaseClients(createClient, config);
    clients.asCaller('caller-token');
    const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
    expect(made).toEqual([
      ['https://ref.supabase.co', 'service', { auth }],
      ['https://ref.supabase.co', 'anon', { auth, global: { headers: { Authorization: 'Bearer caller-token' } } }],
    ]);
  });
});
