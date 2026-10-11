// @vitest-environment node
// Outbound email and SMS. The local adapter writes to the real 0001 dev_outbox in
// PGlite; the providers are faked at fetch, which records exactly what would be sent.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/harness';
import {
  createOutbound,
  isValidEmail,
  OutboundConfigError,
  readOutboundEnv,
  type OutboundEnv,
  type OutboxClient,
} from '../../../supabase/functions/_shared/outbound';
import { createLogger, type LogLevel } from '../../../supabase/functions/_shared/log';
import { serviceClient } from './pgliteClient';

const NO_PROVIDERS: OutboundEnv = {
  production: false,
  resendApiKey: null,
  emailFrom: null,
  emailReplyTo: null,
  twilioAccountSid: null,
  twilioAuthToken: null,
  twilioFrom: null,
};
const RESEND: OutboundEnv = {
  ...NO_PROVIDERS,
  production: true,
  resendApiKey: 'test-resend-key',
  emailFrom: 'crm@example.test',
  emailReplyTo: 'owner@example.test',
};
const SID = `AC${'a'.repeat(32)}`;
const TWILIO: OutboundEnv = { ...NO_PROVIDERS, production: true, twilioAccountSid: SID, twilioAuthToken: 'test-token', twilioFrom: '+15555550100' };

const EMAIL = { to: 'ada@example.test', subject: 'Your invitation', html: '<p>Hi</p>', text: 'Hi' };
const noOutbox: OutboxClient = { from: () => ({ insert: async () => ({ error: { message: 'unexpected outbox write' } }) }) };

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { fn, calls };
}

function collectLog() {
  const lines: string[] = [];
  return { lines, log: createLogger('outbound', { sink: (_l: LogLevel, line: string) => lines.push(line) }) };
}

const jsonReply = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

describe('readOutboundEnv', () => {
  it('reads each variable, trims, and treats blanks as unset', () => {
    const env: Record<string, string> = { ENVIRONMENT: 'production', RESEND_API_KEY: ' key ', EMAIL_FROM: '', TWILIO_FROM: '+15555550100' };
    expect(readOutboundEnv((n) => env[n])).toEqual({
      production: true,
      resendApiKey: 'key',
      emailFrom: null,
      emailReplyTo: null,
      twilioAccountSid: null,
      twilioAuthToken: null,
      twilioFrom: '+15555550100',
    });
    expect(readOutboundEnv(() => undefined).production).toBe(false);
  });
});

describe('local adapter: dev_outbox in 0001', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
  }, 60_000);

  it('writes an email and a text message to the outbox when no provider is set outside production', async () => {
    const out = createOutbound({ env: NO_PROVIDERS, db: serviceClient(db), log: collectLog().log });
    expect(
      await out.sendEmail({ ...EMAIL, attachments: [{ filename: 'signed.pdf', content: new Uint8Array(12) }] }),
    ).toEqual({ status: 'sent', channel: 'local', id: null });
    expect(await out.sendSms({ to: '+15555550123', body: 'Your code is 123456' })).toEqual({ status: 'sent', channel: 'local', id: null });
    const rows = (
      await db.query<Record<string, unknown>>(
        `SELECT channel, recipient, subject, body_text, body_html FROM public.dev_outbox ORDER BY channel`,
      )
    ).rows;
    expect(rows).toEqual([
      { channel: 'email', recipient: 'ada@example.test', subject: 'Your invitation', body_text: 'Hi\n\n[attachments: signed.pdf (12 bytes)]', body_html: '<p>Hi</p>' },
      { channel: 'sms', recipient: '+15555550123', subject: null, body_text: 'Your code is 123456', body_html: null },
    ]);
  });

  it('reports a failed outbox write as failed, not sent', async () => {
    const out = createOutbound({ env: NO_PROVIDERS, db: noOutbox, log: collectLog().log });
    expect(await out.sendEmail(EMAIL)).toEqual({ status: 'failed', channel: 'local', reason: 'outbox_error', httpStatus: null });
  });
});

describe('fails closed on configuration', () => {
  const attempt = (env: OutboundEnv) => createOutbound({ env, db: noOutbox, fetch: fakeFetch(jsonReply(200, {})).fn, log: collectLog().log });

  it('throws in production with no provider, never writing to the outbox', async () => {
    const prod = { ...NO_PROVIDERS, production: true };
    await expect(attempt(prod).sendEmail(EMAIL)).rejects.toThrow(OutboundConfigError);
    await expect(attempt(prod).sendSms({ to: '+15555550123', body: 'x' })).rejects.toThrow(OutboundConfigError);
  });

  it('throws on a half-configured provider', async () => {
    await expect(attempt({ ...RESEND, emailFrom: null }).sendEmail(EMAIL)).rejects.toThrow(/EMAIL_FROM/);
    await expect(attempt({ ...RESEND, emailFrom: 'not an address' }).sendEmail(EMAIL)).rejects.toThrow(/EMAIL_FROM/);
    await expect(attempt({ ...TWILIO, twilioAuthToken: null }).sendSms({ to: '+15555550123', body: 'x' })).rejects.toThrow(/all of/);
    await expect(attempt({ ...TWILIO, twilioAccountSid: 'AC123' }).sendSms({ to: '+15555550123', body: 'x' })).rejects.toThrow(/malformed/);
    await expect(attempt({ ...TWILIO, twilioFrom: '5550100' }).sendSms({ to: '+15555550123', body: 'x' })).rejects.toThrow(/TWILIO_FROM/);
  });
});

describe('Resend adapter', () => {
  it('sends the message as Resend expects, with the idempotency key and a 20s-style timeout signal', async () => {
    const f = fakeFetch(jsonReply(200, { id: 'msg_1' }));
    const out = createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log: collectLog().log });
    const result = await out.sendEmail({
      ...EMAIL,
      fromName: 'Example "Team"\r\nBcc: x@example.test',
      idempotencyKey: 'invite:1',
      tags: { kind: 'invite', invitation_id: '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f' },
      attachments: [{ filename: 'a.pdf', content: new Uint8Array([1, 2, 3]) }],
      listUnsubscribe: { url: 'https://crm.example.test/unsubscribe?t=abc', oneClick: true },
    });
    expect(result).toEqual({ status: 'sent', channel: 'resend', id: 'msg_1' });
    const [{ url, init }] = f.calls;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-resend-key');
    expect(headers['Idempotency-Key']).toBe('invite:1');
    expect(JSON.parse(String(init.body))).toEqual({
      from: '"Example Team Bcc: x@example.test" <crm@example.test>',
      to: ['ada@example.test'],
      subject: 'Your invitation',
      html: '<p>Hi</p>',
      text: 'Hi',
      reply_to: 'owner@example.test',
      tags: [
        { name: 'kind', value: 'invite' },
        { name: 'invitation_id', value: '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f' },
      ],
      attachments: [{ filename: 'a.pdf', content: 'AQID' }],
      headers: {
        'List-Unsubscribe': '<https://crm.example.test/unsubscribe?t=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  });

  it('uses the display name in EMAIL_FROM when the message gives none, and the bare address otherwise', async () => {
    for (const [emailFrom, expected] of [
      ['Example Co <crm@example.test>', '"Example Co" <crm@example.test>'],
      ['crm@example.test', 'crm@example.test'],
    ]) {
      const f = fakeFetch(jsonReply(200, { id: 'm' }));
      await createOutbound({ env: { ...RESEND, emailFrom, emailReplyTo: null }, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendEmail(EMAIL);
      const payload = JSON.parse(String(f.calls[0].init.body)) as Record<string, unknown>;
      expect([emailFrom, payload.from, 'reply_to' in payload]).toEqual([emailFrom, expected, false]);
    }
  });

  it('sends an over-long or non-ASCII idempotency key as its stable SHA-256', async () => {
    const keys: string[] = [];
    for (const key of ['k'.repeat(300), 'k'.repeat(300), 'café:1']) {
      const f = fakeFetch(jsonReply(200, { id: 'm' }));
      await createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendEmail({ ...EMAIL, idempotencyKey: key });
      keys.push((f.calls[0].init.headers as Record<string, string>)['Idempotency-Key']);
    }
    expect(keys[0]).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it.each([
    [422, 'rejected'],
    [400, 'rejected'],
    [429, 'rate_limited'],
    [401, 'provider_auth'],
    [503, 'provider_error'],
  ])('an HTTP %i is failed (%s), and the provider body is neither returned nor logged raw', async (status, reason) => {
    const { lines, log } = collectLog();
    const f = fakeFetch(jsonReply(status, { message: 'Invalid `to`: ada@example.test' }));
    const result = await createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log }).sendEmail(EMAIL);
    expect(result).toEqual({ status: 'failed', channel: 'resend', reason, httpStatus: status });
    expect(JSON.stringify(result)).not.toContain('ada@');
    expect(lines.join('\n')).not.toContain('ada@example.test');
    expect(lines.join('\n')).toContain(`status=${status}`);
  });

  it('no answer at all (a throw or a timeout) is unknown, never failed', async () => {
    const thrown = fakeFetch(() => Promise.reject(new TypeError('connection reset')));
    expect(await createOutbound({ env: RESEND, db: noOutbox, fetch: thrown.fn, log: collectLog().log }).sendEmail(EMAIL)).toEqual({
      status: 'unknown',
      channel: 'resend',
    });

    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const started = Date.now();
    const result = await createOutbound({ env: RESEND, db: noOutbox, fetch: hanging, timeoutMs: 30, log: collectLog().log }).sendEmail(EMAIL);
    expect(result).toEqual({ status: 'unknown', channel: 'resend' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('an accepted send whose reply does not parse is still sent, with no id', async () => {
    const f = fakeFetch(() => new Response('not json', { status: 200 }));
    expect(await createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendEmail(EMAIL)).toEqual({
      status: 'sent',
      channel: 'resend',
      id: null,
    });
  });

  it('refuses a bad message before calling the provider', async () => {
    const f = fakeFetch(jsonReply(200, { id: 'm' }));
    const out = createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log: collectLog().log });
    const cases: Array<[Partial<typeof EMAIL> & Record<string, unknown>, string]> = [
      [{ to: 'ada@example.test\r\nBcc: x@example.test' }, 'invalid_recipient'],
      [{ to: 'not-an-address' }, 'invalid_recipient'],
      [{ replyTo: 'nope' }, 'invalid_message'],
      [{ tags: { 'bad tag': 'x' } }, 'invalid_message'],
      [{ subject: '\r\n' }, 'invalid_message'],
      [{ listUnsubscribe: { url: 'javascript:alert(1)' } }, 'invalid_message'],
      [{ attachments: [{ filename: '', content: new Uint8Array(1) }] }, 'invalid_message'],
    ];
    for (const [over, reason] of cases) {
      const result = await out.sendEmail({ ...EMAIL, ...over } as typeof EMAIL);
      expect([over, result]).toEqual([over, { status: 'failed', channel: 'resend', reason, httpStatus: null }]);
    }
    expect(f.calls).toEqual([]);
  });

  it('flattens a subject onto one line', async () => {
    const f = fakeFetch(jsonReply(200, { id: 'm' }));
    await createOutbound({ env: RESEND, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendEmail({ ...EMAIL, subject: 'Hello\r\nBcc: x' });
    expect(JSON.parse(String(f.calls[0].init.body)).subject).toBe('Hello Bcc: x');
  });
});

describe('Twilio adapter', () => {
  it('posts the form Twilio expects with basic auth, and returns the message sid', async () => {
    const f = fakeFetch(jsonReply(201, { sid: 'SM1' }));
    const result = await createOutbound({ env: TWILIO, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendSms({
      to: '+15555550123',
      body: 'Your code is 123456',
    });
    expect(result).toEqual({ status: 'sent', channel: 'twilio', id: 'SM1' });
    const [{ url, init }] = f.calls;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa(`${SID}:test-token`)}`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      To: '+15555550123',
      Body: 'Your code is 123456',
      From: '+15555550100',
    });
  });

  it('sends from a Messaging Service when TWILIO_FROM is one', async () => {
    const service = `MG${'b'.repeat(32)}`;
    const f = fakeFetch(jsonReply(201, { sid: 'SM2' }));
    await createOutbound({ env: { ...TWILIO, twilioFrom: service }, db: noOutbox, fetch: f.fn, log: collectLog().log }).sendSms({
      to: '+15555550123',
      body: 'x',
    });
    const form = new URLSearchParams(String(f.calls[0].init.body));
    expect([form.get('MessagingServiceSid'), form.get('From')]).toEqual([service, null]);
  });

  it('refuses a number that is not E.164 and a body over 1600 characters, without calling Twilio', async () => {
    const f = fakeFetch(jsonReply(201, { sid: 'SM3' }));
    const out = createOutbound({ env: TWILIO, db: noOutbox, fetch: f.fn, log: collectLog().log });
    expect(await out.sendSms({ to: '555-010-4477', body: 'x' })).toMatchObject({ status: 'failed', reason: 'invalid_recipient' });
    expect(await out.sendSms({ to: '+15555550123', body: 'x'.repeat(1601) })).toMatchObject({ status: 'failed', reason: 'invalid_message' });
    expect(f.calls).toEqual([]);
  });

  it('a Twilio error that names the number is failed, and the number is not logged', async () => {
    const { lines, log } = collectLog();
    const f = fakeFetch(jsonReply(400, { code: 21211, message: "The 'To' number +15555550123 is not valid." }));
    const result = await createOutbound({ env: TWILIO, db: noOutbox, fetch: f.fn, log }).sendSms({ to: '+15555550123', body: 'x' });
    expect(result).toEqual({ status: 'failed', channel: 'twilio', reason: 'rejected', httpStatus: 400 });
    expect(lines.join('\n')).not.toContain('5555550123');
  });
});

describe('isValidEmail', () => {
  it('refuses header injection and non-addresses', () => {
    expect(isValidEmail('ada@example.test')).toBe(true);
    // A NUL is not whitespace, so the address pattern alone would let it through.
    for (const bad of ['ada@example.test\r\n', 'ada@example.test\0', 'ada@example', 'ada example@x.test', '<ada@example.test>', `${'a'.repeat(250)}@x.test`]) {
      expect([bad, isValidEmail(bad)]).toEqual([bad, false]);
    }
  });
});
