// @vitest-environment node
// validate-portal-invite: public, rate limited before the body is read, and it answers
// only whether a link works and the name and address the account will carry.
import { describe, expect, it, vi } from 'vitest';
import {
  createValidateInviteHandler,
  inviteeName,
  type InvitationRow,
  type ValidateInviteDeps,
} from '../../../supabase/functions/validate-portal-invite/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';

const TOKEN = 'A'.repeat(43);
const CONTACT = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-05-01T12:00:00Z');

function row(over: Partial<InvitationRow> = {}): InvitationRow {
  return { id: '20000000-0000-4000-8000-000000000001', contact_id: CONTACT, email: 'ada@example.com', status: 'pending', expires_at: '2026-05-05T00:00:00Z', ...over };
}

function deps(over: Partial<ValidateInviteDeps> = {}) {
  const lookedUp: string[] = [];
  const expired: string[] = [];
  const d: ValidateInviteDeps = {
    allowedOrigins: ['http://localhost:5173'],
    rateLimit: async () => 'allowed',
    findInvitation: async (hash) => {
      lookedUp.push(hash);
      return row();
    },
    markExpired: async (id) => {
      expired.push(id);
    },
    loadContact: async () => ({ first_name: 'Ada', last_name: 'Lovelace', spouse_first_name: 'Grace', spouse_last_name: 'Hopper', spouse_email: 'Grace@Example.com' }),
    now: () => NOW,
    logSink: () => {},
    ...over,
  };
  return { d, lookedUp, expired };
}

const call = (d: ValidateInviteDeps, body: unknown = { token: TOKEN }) => createValidateInviteHandler(d)(edgeRequest({ body }));

describeEdgeContract({
  name: 'validate-portal-invite',
  handler: createValidateInviteHandler(deps().d),
  failingHandler: createValidateInviteHandler(deps({ findInvitation: throwInternal }).d),
  limitedHandler: createValidateInviteHandler(deps({ rateLimit: async () => 'limited' }).d),
  credentials: null,
  body: { kind: 'json', valid: { token: TOKEN }, maxBytes: 4000 },
});

describe('validate-portal-invite', () => {
  it('looks the link up by the SHA-256 of its token, and answers the name and address only', async () => {
    const { d, lookedUp } = deps();
    const res = await call(d);
    expect(lookedUp).toEqual([await sha256Hex(TOKEN)]);
    expect(await res.json()).toEqual({ valid: true, contact: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' } });
  });

  it("greets the spouse when the link went to the spouse's address", async () => {
    const { d } = deps({ findInvitation: async () => row({ email: 'grace@example.com' }) });
    expect(await (await call(d)).json()).toMatchObject({ contact: { first_name: 'Grace', last_name: 'Hopper' } });
    expect(inviteeName({ first_name: 'A', last_name: 'B', spouse_first_name: null, spouse_last_name: null, spouse_email: 'x@example.com' }, 'X@example.com'))
      .toEqual({ first_name: 'A', last_name: 'B' });
  });

  it.each([
    ['accepted', 'used'],
    ['revoked', 'revoked'],
    ['expired', 'expired'],
  ] as const)('a %s invitation reads as %s', async (status, reason) => {
    const { d } = deps({ findInvitation: async () => row({ status }) });
    expect(await (await call(d)).json()).toEqual({ valid: false, reason });
  });

  it('a pending invitation past its time reads as expired and is marked so', async () => {
    const { d, expired } = deps({ findInvitation: async () => row({ expires_at: '2026-05-01T11:59:59Z' }) });
    expect(await (await call(d)).json()).toEqual({ valid: false, reason: 'expired' });
    expect(expired).toEqual([row().id]);
  });

  it('a token of the wrong shape, or one that matches nothing, is not looked up or not found', async () => {
    const { d, lookedUp } = deps();
    for (const token of ['short', 'has spaces in it but is long enough to pass the length', 42, null]) {
      expect(await (await call(d, { token })).json()).toEqual({ valid: false, reason: 'not_found' });
    }
    expect(lookedUp).toEqual([]);
    const none = deps({ findInvitation: async () => null });
    expect(await (await call(none.d)).json()).toEqual({ valid: false, reason: 'not_found' });
  });

  it('a limited caller never reaches the lookup', async () => {
    const findInvitation = vi.fn(async () => row());
    const { d } = deps({ rateLimit: async () => 'limited', findInvitation });
    expect((await call(d)).status).toBe(429);
    expect(findInvitation).not.toHaveBeenCalled();
  });
});
