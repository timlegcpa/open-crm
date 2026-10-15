// esign-resend-webhook: the email provider's delivery and open notices for invitations.
// Public (the provider sends no Authorization at all), with a shared ceiling; every call
// proves itself with the Svix signature instead.
//
// Signed content: `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 under the
// base64 key after `whsec_`, compared in constant time against every `v1,` signature in
// the header (several during a key rotation). The timestamp must be within five minutes.
// Only email.delivered and email.opened on a message tagged esign_signer_id are recorded;
// a redelivery of one notice (same svix-id) is recorded once. A database failure answers
// 200 and is logged: a retry storm would not fix it, and the notice is evidence, not state.
// Without RESEND_WEBHOOK_SECRET the webhook is off: 503.

import { bytesToBase64, base64ToBytes } from '../_shared/crypto.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { checkGlobalLimit } from '../_shared/rate-limit.ts';
import { timingSafeEqual } from '../_shared/secrets.ts';
import { pgCode, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import type { RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';

export type ResendWebhookResponse =
  | { ok: true }
  | { ok: true; ignored: true }
  | { ok: true; deduped: true }
  | { ok: true; error: 'lookup_failed' | 'insert_failed' };

export const RESEND_WEBHOOK_ERRORS = ['bad_request', 'unauthenticated', 'webhook_off', 'rate_limited'] as const;

export const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

export interface ResendWebhookDeps {
  allowedOrigins: string[];
  db: EsignDb;
  webhookSecret: string | null;
  /** Default: 600 notices a minute in all. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

/** The candidate signatures of a `svix-signature` header: the `v1,` entries only. */
export function svixSignatures(header: string): string[] {
  return header
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3))
    .filter((sig) => sig.length > 0);
}

/** The raw HMAC key of a `whsec_<base64>` secret (the prefix is optional); null when not base64. */
export function svixKey(secret: string): Uint8Array<ArrayBuffer> | null {
  try {
    const key = base64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function svixSign(key: Uint8Array<ArrayBuffer>, id: string, timestamp: string, body: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', k, message)));
}

/** Tags as a flat object, from the object or the [{ name, value }] form. */
export function normalizeTags(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      const e = entry as { name?: unknown; value?: unknown } | null;
      if (e && typeof e.name === 'string' && typeof e.value === 'string') out[e.name] = e.value;
    }
  } else if (tags && typeof tags === 'object') {
    for (const [k, v] of Object.entries(tags as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const EVENT_FOR: Record<string, 'email_delivered' | 'email_opened'> = {
  'email.delivered': 'email_delivered',
  'email.opened': 'email_opened',
};

export function createResendWebhookHandler(deps: ResendWebhookDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-resend-webhook',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? (() => checkGlobalLimit(db, { action: 'esign_resend_webhook', max: 600, windowMinutes: 1 })),
    allowHeaders: ['svix-id', 'svix-timestamp', 'svix-signature'],
    body: 'bytes',
    maxBodyBytes: 65_536,
    logSink: deps.logSink,
    async handle({ req, body, json, log }) {
      if (!deps.webhookSecret) {
        log.error('RESEND_WEBHOOK_SECRET is not set; the delivery webhook is off');
        throw new HttpError(503, 'This webhook is not configured.', 'webhook_off');
      }
      const id = req.headers.get('svix-id') ?? '';
      const timestamp = req.headers.get('svix-timestamp') ?? '';
      const signature = req.headers.get('svix-signature') ?? '';
      // Anything short of a fresh, matching signature is an unauthenticated call.
      const unauthenticated = () => new HttpError(401, REFUSALS.unauthenticated.error, REFUSALS.unauthenticated.code);
      if (!id || id.length > 200 || !/^\d{1,12}$/.test(timestamp) || !signature) throw unauthenticated();
      if (Math.abs(now().getTime() - Number(timestamp) * 1000) > SVIX_TOLERANCE_MS) throw unauthenticated();

      const key = svixKey(deps.webhookSecret);
      if (!key) {
        log.error('RESEND_WEBHOOK_SECRET is not a whsec_ base64 key');
        throw new HttpError(503, 'This webhook is not configured.', 'webhook_off');
      }
      const expected = await svixSign(key, id, timestamp, body);
      if (!svixSignatures(signature).some((sig) => timingSafeEqual(sig, expected))) {
        log.warn('webhook signature mismatch');
        throw unauthenticated();
      }

      let event: { type?: unknown; data?: unknown };
      try {
        event = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new HttpError(400, 'Bad request.', 'bad_request');
      }
      const mapped = typeof event?.type === 'string' ? EVENT_FOR[event.type] : undefined;
      if (!mapped) return json(200, { ok: true, ignored: true } satisfies ResendWebhookResponse);
      const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
      const tags = normalizeTags(data.tags);
      const signerId = tags.esign_signer_id;
      if (!isUuid(signerId)) return json(200, { ok: true, ignored: true } satisfies ResendWebhookResponse);

      const signer = await db.from('esign_envelope_signers').select('id, envelope_id').eq('id', signerId).maybeSingle();
      if (signer.error) {
        log.error('signer read failed', signer.error);
        return json(200, { ok: true, error: 'lookup_failed' } satisfies ResendWebhookResponse);
      }
      if (!signer.data) return json(200, { ok: true, ignored: true } satisfies ResendWebhookResponse);

      const inserted = await db.from('esign_envelope_events').insert({
        envelope_id: signer.data.envelope_id,
        signer_id: signer.data.id,
        event_type: mapped,
        svix_id: id,
        metadata: {
          resend_email_id: typeof data.email_id === 'string' ? data.email_id.slice(0, 200) : null,
          kind: tags.kind && /^[a-z_]{1,40}$/.test(tags.kind) ? tags.kind : 'esign_invite',
        },
      });
      if (inserted.error) {
        if (pgCode(inserted.error) === '23505') return json(200, { ok: true, deduped: true } satisfies ResendWebhookResponse);
        log.error('event insert failed', inserted.error);
        return json(200, { ok: true, error: 'insert_failed' } satisfies ResendWebhookResponse);
      }
      return json(200, { ok: true } satisfies ResendWebhookResponse);
    },
  });
}
