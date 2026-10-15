// @vitest-environment node
// log-portal-event: a client's session lifecycle, written by the server with the
// caller's address; the owner's View-as-client session is skipped, not recorded.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLogPortalEventHandler,
  PORTAL_EVENTS,
  type LogPortalEventDeps,
} from '../../../supabase/functions/log-portal-event/handler';
import { CLIENT_CONTACT_ID, CLIENT_USER_ID, CREDENTIALS, describeEdgeContract, edgeRequest, fakeClientAuth, throwInternal } from './contract';

function deps(over: Partial<LogPortalEventDeps> = {}) {
  const inserted: unknown[] = [];
  const logins: string[] = [];
  const d: LogPortalEventDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeClient: fakeClientAuth(),
    rateLimit: async () => 'allowed',
    async insertEvent(row) {
      inserted.push(row);
    },
    async recordLogin(id) {
      logins.push(id);
    },
    logSink: () => {},
    ...over,
  };
  return { d, inserted, logins };
}

const send = (d: LogPortalEventDeps, action: unknown, headers: Record<string, string> = CREDENTIALS.client, extra: Record<string, string> = {}) =>
  createLogPortalEventHandler(d)(edgeRequest({ headers: { ...headers, ...extra }, body: { action } }));

describeEdgeContract({
  name: 'log-portal-event',
  handler: createLogPortalEventHandler(deps().d),
  failingHandler: createLogPortalEventHandler(deps({ insertEvent: throwInternal }).d),
  credentials: CREDENTIALS.client,
  wrongPrincipal: CREDENTIALS.owner,
  body: { kind: 'json', valid: { action: 'logout' }, maxBytes: 1024 },
});

describe('log-portal-event', () => {
  it("records the event for the caller's own contact, with the address the server saw", async () => {
    const { d, inserted, logins } = deps();
    const res = await send(d, 'logout', CREDENTIALS.client, { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Test' });
    expect(res.status).toBe(200);
    expect(inserted).toEqual([{ contactId: CLIENT_CONTACT_ID, userId: CLIENT_USER_ID, action: 'logout', ip: '203.0.113.9', userAgent: 'Test' }]);
    expect(logins).toEqual([]);
  });

  it('counts a sign-in on the account', async () => {
    const { d, logins } = deps();
    await send(d, 'login');
    expect(logins).toEqual([CLIENT_USER_ID]);
  });

  it("skips the owner's View-as-client session: 204 and nothing written", async () => {
    const { d, inserted, logins } = deps();
    for (const action of PORTAL_EVENTS) {
      const res = await send(d, action, CREDENTIALS.viewAsClient);
      expect(res.status).toBe(204);
    }
    expect(inserted).toEqual([]);
    expect(logins).toEqual([]);
  });

  it('refuses any other action, and an unreadable address is recorded as none', async () => {
    const { d, inserted } = deps();
    for (const action of ['message_sent', 'document_delete', '', null, 7]) expect((await send(d, action)).status).toBe(400);
    expect(inserted).toEqual([]);
    await send(d, 'session_expired', CREDENTIALS.client, { 'x-forwarded-for': 'unknown' });
    expect(inserted).toEqual([expect.objectContaining({ action: 'session_expired', ip: null })]);
  });

  it('every event it accepts is one the activity log accepts', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0002_contacts.sql'), 'utf8');
    const list = /action text NOT NULL CHECK \(action IN \(([\s\S]*?)\)\)/.exec(sql)![1];
    const allowed = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const event of PORTAL_EVENTS) expect(allowed).toContain(event);
  });
});
