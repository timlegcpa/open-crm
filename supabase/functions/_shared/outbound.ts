// Every email and text message leaves through here.
//
// Adapters, chosen per send from the environment:
//   resend   RESEND_API_KEY set (EMAIL_FROM required with it)
//   twilio   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM all set
//   local    no provider key and ENVIRONMENT is not 'production': the message is written
//            to public.dev_outbox (0001_core.sql), which the owner can read, so every
//            sending flow works on a fresh project with no provider account
// In production with no provider key, a send THROWS OutboundConfigError: a message is
// never dropped silently, and never parked in the outbox of a live deployment.
//
// Results, because "did it send?" has three answers:
//   sent     the provider accepted it (or the outbox row was written)
//   failed   the provider answered with an error status: it did not send, a retry is safe
//   unknown  no answer came back (timeout, network). It MAY have been accepted, so do not
//            record it as failed and retry with a new idempotency key: that is how a
//            recipient gets the same message twice.
// A provider's error body is logged (redacted) and never returned, since it can echo the
// recipient's address or number.

import { sha256Hex } from './crypto.ts';
import { createLogger, type Logger } from './log.ts';

export interface OutboundEnv {
  production: boolean;
  resendApiKey: string | null;
  emailFrom: string | null;
  emailReplyTo: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFrom: string | null;
}

/** Read the provider settings, e.g. readOutboundEnv((name) => Deno.env.get(name)). */
export function readOutboundEnv(get: (name: string) => string | undefined): OutboundEnv {
  const v = (name: string) => get(name)?.trim() || null;
  return {
    production: get('ENVIRONMENT') === 'production',
    resendApiKey: v('RESEND_API_KEY'),
    emailFrom: v('EMAIL_FROM'),
    emailReplyTo: v('EMAIL_REPLY_TO'),
    twilioAccountSid: v('TWILIO_ACCOUNT_SID'),
    twilioAuthToken: v('TWILIO_AUTH_TOKEN'),
    twilioFrom: v('TWILIO_FROM'),
  };
}

/** The slice of a Supabase client the local adapter calls. supabase-js clients satisfy it. */
export interface OutboxClient {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }> };
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Display name in From, normally OrgIdentity.senderName. EMAIL_FROM supplies the address. */
  fromName?: string;
  /** Default EMAIL_REPLY_TO. */
  replyTo?: string;
  /**
   * Stable per message (e.g. `invite:<invitation id>`), so a retry is de-duplicated by the
   * provider. Over 256 characters, or outside printable ASCII, it is sent as its SHA-256.
   */
  idempotencyKey?: string;
  /** Provider tags; names and values of letters, digits, _ and - only. */
  tags?: Record<string, string>;
  attachments?: ReadonlyArray<{ filename: string; content: Uint8Array }>;
  /** Group email: List-Unsubscribe, plus List-Unsubscribe-Post for one-click (RFC 8058). */
  listUnsubscribe?: { url: string; oneClick?: boolean };
}

export interface SmsMessage {
  /** E.164, e.g. +15555550123. */
  to: string;
  body: string;
}

export type Channel = 'resend' | 'twilio' | 'local';
export type FailureReason =
  | 'invalid_recipient'
  | 'invalid_message'
  | 'rejected'
  | 'rate_limited'
  | 'provider_auth'
  | 'provider_error'
  | 'outbox_error';

export type SendResult =
  | { status: 'sent'; channel: Channel; id: string | null }
  | { status: 'failed'; channel: Channel; reason: FailureReason; httpStatus: number | null }
  | { status: 'unknown'; channel: Exclude<Channel, 'local'> };

export class OutboundConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundConfigError';
  }
}

/** Rejects CR/LF/NUL (header injection) and anything that is plainly not an address. */
export function isValidEmail(address: string): boolean {
  if (/[\r\n\0]/.test(address) || address.length > 254) return false;
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(address);
}

const E164 = /^\+[1-9]\d{6,14}$/;
const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const TWILIO_SID = /^AC[0-9a-fA-F]{32}$/;
const TWILIO_SERVICE = /^MG[0-9a-fA-F]{32}$/;
const MAX_SMS = 1600;
const DEFAULT_TIMEOUT_MS = 20_000;

/** A display name safe inside a quoted header phrase. */
function displayName(name: string): string {
  return name.replace(/[\r\n\0"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** EMAIL_FROM is `address` or `Name <address>`; the address part must be valid. */
function parseFrom(value: string): { address: string; name: string | null } {
  const match = /^(.*)<([^<>]+)>\s*$/.exec(value);
  const address = (match ? match[2] : value).trim();
  if (!isValidEmail(address)) throw new OutboundConfigError('EMAIL_FROM is not a valid address');
  const name = match ? displayName(match[1]) : '';
  return { address, name: name || null };
}

async function providerKey(key: string): Promise<string> {
  return /^[\x21-\x7e]{1,256}$/.test(key) ? key : `sha256-${await sha256Hex(key)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function reasonFor(status: number): FailureReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'provider_auth';
  if (status >= 500) return 'provider_error';
  return 'rejected';
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

export function createOutbound(deps: {
  env: OutboundEnv;
  /** The service client, for the local adapter. */
  db: OutboxClient;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: Logger;
}): { sendEmail(message: EmailMessage): Promise<SendResult>; sendSms(message: SmsMessage): Promise<SendResult> } {
  const { env, db } = deps;
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.log ?? createLogger('outbound');

  function emailChannel(): 'resend' | 'local' {
    if (env.resendApiKey) {
      if (!env.emailFrom) throw new OutboundConfigError('EMAIL_FROM must be set with RESEND_API_KEY');
      return 'resend';
    }
    if (env.production) throw new OutboundConfigError('Email is not configured: set RESEND_API_KEY and EMAIL_FROM');
    return 'local';
  }

  function smsChannel(): 'twilio' | 'local' {
    const parts = [env.twilioAccountSid, env.twilioAuthToken, env.twilioFrom];
    if (parts.some(Boolean)) {
      if (!parts.every(Boolean)) {
        throw new OutboundConfigError('SMS needs all of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
      }
      if (!TWILIO_SID.test(env.twilioAccountSid!)) throw new OutboundConfigError('TWILIO_ACCOUNT_SID is malformed');
      if (!E164.test(env.twilioFrom!) && !TWILIO_SERVICE.test(env.twilioFrom!)) {
        throw new OutboundConfigError('TWILIO_FROM must be an E.164 number or a Messaging Service SID');
      }
      return 'twilio';
    }
    if (env.production) throw new OutboundConfigError('SMS is not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
    return 'local';
  }

  /** A provider error's machine code (Resend `name`, Twilio `code`), never its message. */
  function providerErrorCode(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const raw = (body as { name?: unknown; code?: unknown }).name ?? (body as { code?: unknown }).code;
    const code = typeof raw === 'number' ? String(raw) : raw;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : null;
  }

  /** POST and classify. Never returns the provider's body. */
  async function post(channel: 'resend' | 'twilio', url: string, init: RequestInit): Promise<SendResult> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      log.error(`${channel}: no response; delivery unknown`, err);
      return { status: 'unknown', channel };
    }
    if (!res.ok) {
      // Only the provider's error code is logged: its message can echo the recipient.
      const code = await res.json().then(providerErrorCode, () => null);
      log.error(`${channel}: refused`, undefined, { status: res.status, code });
      return { status: 'failed', channel, reason: reasonFor(res.status), httpStatus: res.status };
    }
    // An unreadable success body is still a successful send.
    let id: string | null = null;
    try {
      const parsed = (await res.json()) as { id?: unknown; sid?: unknown };
      const raw = channel === 'resend' ? parsed.id : parsed.sid;
      id = typeof raw === 'string' ? raw : null;
    } catch {
      log.warn(`${channel}: accepted, but the reply did not parse; no message id`);
    }
    return { status: 'sent', channel, id };
  }

  async function writeOutbox(row: Record<string, unknown>): Promise<SendResult> {
    const { error } = await db.from('dev_outbox').insert(row);
    // A repeated idempotency key: the first write stands, as a provider would de-duplicate.
    // Only that index's conflict; any other unique violation is a failed write.
    const e = error as { code?: unknown; message?: unknown } | null;
    if (row.idempotency_key && e?.code === '23505' && String(e.message).includes('uq_dev_outbox_idempotency_key')) {
      log.info('dev_outbox: repeated idempotency key; already written');
      return { status: 'sent', channel: 'local', id: null };
    }
    if (error) {
      log.error('dev_outbox insert failed', error);
      return { status: 'failed', channel: 'local', reason: 'outbox_error', httpStatus: null };
    }
    log.warn('message written to dev_outbox, not sent: no provider configured and ENVIRONMENT is not production', { channel: String(row.channel) });
    return { status: 'sent', channel: 'local', id: null };
  }

  /** EMAIL_FROM's display name, as the provider would use it; none when unset or unreadable. */
  function localDefaultName(): string | null {
    if (!env.emailFrom) return null;
    try {
      return parseFrom(env.emailFrom).name;
    } catch {
      return null;
    }
  }

  const invalid = (channel: Channel, reason: FailureReason, what: string): SendResult => {
    log.error(`${channel}: message refused before sending (${what})`);
    return { status: 'failed', channel, reason, httpStatus: null };
  };

  return {
    async sendEmail(m: EmailMessage): Promise<SendResult> {
      const channel = emailChannel();
      if (!isValidEmail(m.to)) return invalid(channel, 'invalid_recipient', 'to');
      const replyTo = m.replyTo ?? env.emailReplyTo;
      if (replyTo && !isValidEmail(replyTo)) return invalid(channel, 'invalid_message', 'replyTo');
      const tags = Object.entries(m.tags ?? {});
      if (tags.some(([k, v]) => !TAG.test(k) || !TAG.test(v))) return invalid(channel, 'invalid_message', 'tags');
      const subject = oneLine(m.subject).trim();
      if (!subject) return invalid(channel, 'invalid_message', 'subject');
      const files = (m.attachments ?? []).map((a) => ({ filename: oneLine(a.filename).slice(0, 255), content: a.content }));
      if (files.some((a) => !a.filename)) return invalid(channel, 'invalid_message', 'attachment filename');
      const unsubscribe = m.listUnsubscribe?.url;
      if (unsubscribe !== undefined && !/^https?:\/\/[^\s<>]+$/.test(unsubscribe)) {
        return invalid(channel, 'invalid_message', 'listUnsubscribe');
      }

      const listHeaders = unsubscribe
        ? {
            'List-Unsubscribe': `<${unsubscribe}>`,
            ...(m.listUnsubscribe?.oneClick ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
          }
        : null;

      if (channel === 'local') {
        const note = files.length ? `\n\n[attachments: ${files.map((a) => `${a.filename} (${a.content.byteLength} bytes)`).join(', ')}]` : '';
        const carried = { ...listHeaders, ...(replyTo ? { 'Reply-To': replyTo } : {}), ...(tags.length ? { tags: Object.fromEntries(tags) } : {}) };
        return writeOutbox({
          channel: 'email',
          recipient: m.to,
          sender: (m.fromName ? displayName(m.fromName) : localDefaultName()) || null,
          subject,
          body_text: m.text + note,
          body_html: m.html,
          headers: Object.keys(carried).length ? carried : null,
          idempotency_key: m.idempotencyKey ? await providerKey(m.idempotencyKey) : null,
        });
      }

      const from = parseFrom(env.emailFrom!);
      const name = m.fromName ? displayName(m.fromName) : from.name;
      const payload: Record<string, unknown> = {
        from: name ? `"${name}" <${from.address}>` : from.address,
        to: [m.to],
        subject,
        html: m.html,
        text: m.text,
      };
      if (replyTo) payload.reply_to = replyTo;
      if (tags.length) payload.tags = tags.map(([tagName, value]) => ({ name: tagName, value }));
      if (files.length) payload.attachments = files.map((a) => ({ filename: a.filename, content: toBase64(a.content) }));
      if (listHeaders) payload.headers = listHeaders;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      };
      if (m.idempotencyKey) headers['Idempotency-Key'] = await providerKey(m.idempotencyKey);
      return post('resend', 'https://api.resend.com/emails', { headers, body: JSON.stringify(payload) });
    },

    async sendSms(m: SmsMessage): Promise<SendResult> {
      const channel = smsChannel();
      if (!E164.test(m.to)) return invalid(channel, 'invalid_recipient', 'to');
      if (!m.body.trim() || m.body.length > MAX_SMS) return invalid(channel, 'invalid_message', 'body');
      if (channel === 'local') return await writeOutbox({ channel: 'sms', recipient: m.to, body_text: m.body });

      const sid = env.twilioAccountSid!;
      const form = new URLSearchParams({ To: m.to, Body: m.body });
      form.set(TWILIO_SERVICE.test(env.twilioFrom!) ? 'MessagingServiceSid' : 'From', env.twilioFrom!);
      return await post('twilio', `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${env.twilioAuthToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    },
  };
}
