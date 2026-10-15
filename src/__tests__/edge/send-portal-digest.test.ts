// @vitest-environment node
// send-portal-digest: the owner's daily summary. The owner's own rows and View-as-client
// windows stay out; an unreadable window list sends unfiltered; no activity, no email;
// messages clients sent arrive through the seam to the messages table, which may not exist.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_PHRASES,
  createDigestHandler,
  digestContent,
  type ActivityRow,
  type DigestDeps,
  type RenderedMessage,
} from '../../../supabase/functions/send-portal-digest/handler';
import { renderEmail } from '../../../supabase/functions/_shared/email-layout';
import { CREDENTIALS, CRON_SECRET, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';

const NOW = new Date('2026-05-02T12:30:00Z');
const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const org = { displayName: 'Acme LLC', legalName: null, senderName: 'Acme LLC', postalAddress: null, logoUrl: null, brandColor: null };

let seq = 0;
function act(over: Partial<ActivityRow>): ActivityRow {
  seq += 1;
  return { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, contact_id: A, contact_name: 'Ada Lovelace', action: 'login', created_at: '2026-05-02T09:00:00Z', actor_role: 'client', ...over };
}

function deps(over: Partial<DigestDeps> = {}) {
  const sent: RenderedMessage[] = [];
  const d: DigestDeps = {
    allowedOrigins: ['http://localhost:5173'],
    cronSecret: CRON_SECRET,
    authorizeOwner: fakeOwnerAuth(),
    listActivitySince: async () => [act({}), act({ action: 'document_upload', created_at: '2026-05-02T10:15:00Z' })],
    listViewWindows: async () => [],
    countClientMessagesSince: async () => null,
    org: async () => org,
    recipient: async () => 'owner@example.com',
    async send(message) {
      sent.push(message);
      return 'sent';
    },
    now: () => NOW,
    logSink: () => {},
    ...over,
  };
  return { d, sent };
}

const run = (d: DigestDeps, headers: Record<string, string> = CREDENTIALS.cron) => createDigestHandler(d)(edgeRequest({ headers }));

describeEdgeContract({
  name: 'send-portal-digest',
  handler: createDigestHandler(deps().d),
  failingHandler: createDigestHandler(deps({ listActivitySince: throwInternal }).d),
  credentials: CREDENTIALS.cron,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'none' },
});

describe('send-portal-digest', () => {
  it("summarizes the last 24 hours per contact, in UTC, to the owner's address", async () => {
    const { d, sent } = deps();
    const res = await run(d);
    expect(await res.json()).toMatchObject({ ok: true, sent: true, events: 2, contacts: 1, window_start: '2026-05-01T12:30:00.000Z' });
    expect(sent[0]).toMatchObject({ to: 'owner@example.com', subject: 'Portal activity: 2 events from 1 contact', idempotencyKey: 'portal-digest:2026-05-01T12:30' });
    const { text } = renderEmail(org, sent[0].content);
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('09:00 UTC: signed in');
    expect(text).toContain('10:15 UTC: uploaded a document');
  });

  it('the owner can run it too', async () => {
    const { d, sent } = deps();
    expect((await run(d, CREDENTIALS.owner)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("leaves out the owner's own rows and rows inside a View-as-client window", async () => {
    const { d, sent } = deps({
      listActivitySince: async () => [
        act({ actor_role: 'owner', action: 'document_upload' }),
        act({ created_at: '2026-05-02T08:10:00Z' }),
        act({ contact_id: B, contact_name: 'Bo Example', created_at: '2026-05-02T08:10:00Z' }),
      ],
      listViewWindows: async () => [{ target_contact_id: A, started_at: '2026-05-02T08:00:00Z', ended_at: '2026-05-02T08:30:00Z' }],
    });
    expect(await (await run(d)).json()).toMatchObject({ events: 1, contacts: 1, view_as_client_suppressed: 1 });
    expect(renderEmail(org, sent[0].content).text).toContain('Bo Example');
  });

  it('an open window runs to now; a window list that cannot be read sends unfiltered', async () => {
    const inWindow = [act({ created_at: '2026-05-02T12:00:00Z' })];
    const open = deps({ listActivitySince: async () => inWindow, listViewWindows: async () => [{ target_contact_id: A, started_at: '2026-05-02T11:00:00Z', ended_at: null }] });
    expect(await (await run(open.d)).json()).toMatchObject({ sent: false, reason: 'no_activity' });
    const broken = deps({ listActivitySince: async () => inWindow, listViewWindows: async () => { throw new Error('down'); } });
    expect(await (await run(broken.d)).json()).toMatchObject({ sent: true, events: 1 });
  });

  it('no activity, no email', async () => {
    const { d, sent } = deps({ listActivitySince: async () => [] });
    expect(await (await run(d)).json()).toMatchObject({ ok: true, sent: false, reason: 'no_activity' });
    expect(sent).toEqual([]);
  });

  it('counts messages clients sent when the messages table exists, and goes on without it', async () => {
    const withMessages = deps({
      listActivitySince: async () => [],
      countClientMessagesSince: async () => [{ contact_id: B, contact_name: 'Bo Example', count: 3 }],
    });
    expect(await (await run(withMessages.d)).json()).toMatchObject({ sent: true, events: 3, contacts: 1 });
    expect(renderEmail(org, withMessages.sent[0].content).text).toContain('Sent 3 messages');
    const broken = deps({ countClientMessagesSince: async () => { throw new Error('down'); } });
    expect(await (await run(broken.d)).json()).toMatchObject({ sent: true, events: 2 });
  });

  it('a failed send is 502 so the job is retried; an unknown one is not', async () => {
    expect((await run(deps({ send: async () => 'failed' }).d)).status).toBe(502);
    expect(await (await run(deps({ send: async () => 'unknown' }).d)).json()).toMatchObject({ sent: true, delivery: 'unknown' });
  });

  it('no recipient is an error, not a silent skip', async () => {
    expect((await run(deps({ recipient: async () => null }).d)).status).toBe(500);
  });

  it('escapes what a contact name carries', () => {
    const { content } = digestContent({ org, windowEnd: NOW, rows: [act({ contact_name: '<img src=x>' })], messages: [] });
    expect(renderEmail(org, content).html).not.toContain('<img src=x>');
  });

  it('has a phrase for exactly the actions the activity log accepts', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0002_contacts.sql'), 'utf8');
    const list = /action text NOT NULL CHECK \(action IN \(([\s\S]*?)\)\)/.exec(sql)![1];
    const allowed = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(Object.keys(ACTION_PHRASES).sort()).toEqual(allowed);
  });
});
