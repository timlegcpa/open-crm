// lead-intake: the keyed endpoint another system posts leads to (a web form tool, a lead
// seller, a script). Server to server only: the key must never sit in a web page.
//
// The key is checked FIRST, before the rate limiter or any read of the body, against a
// cached digest (key.ts), so a flood of wrong keys costs a hash and a compare, never a
// database round trip. That is the shared handler's apiKey mode: preflight, method and
// origin are refused the shared way first, then the key (401 wrong or missing, 503 when
// it cannot be checked), then the rate limit, the capped JSON body and generic errors.
//
// Then, in one transaction (lead_intake_record): the delivery, the person (matched by
// address or created as a new lead), and a note. Last, the owner is told by email, as a
// courtesy: the lead is already recorded, so a failed or unknown send is logged and the
// sender still gets its answer. (A notice that must be retried until delivered needs a
// job kind in the job runner, which this does not have.)
//
// ONE success answer, 202 {status: 'accepted'}, for a new contact, a known one and a
// replayed delivery. Anything richer (a created flag, a contact id) would let a key holder
// ask whether any address is already a contact. A 400 names the bad field: it describes
// the input, nothing stored.

import { createHandler } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import type { EmailContent } from '../_shared/email-layout.ts';
import { createKeyVerifier } from './key.ts';
import { leadNoteBody, leadNotification, parseLead, type Lead } from './lead.ts';

export interface RecordResult {
  status: 'created' | 'matched' | 'replayed';
  contact_id?: string;
}

export interface LeadIntakeDeps {
  allowedOrigins: string[];
  /** Where the app is served, for the link in the owner's notice; null leaves it out. */
  siteUrl: string | null;
  /** The stored digest, or null when no key exists. Throws when it cannot be read. */
  loadKeyHash(): Promise<string | null>;
  /** checkPublicLimits for 'lead_intake': the address's bucket, then the global one. */
  rateLimit(ip: string | null, userAgent: string | null): Promise<RateLimitOutcome>;
  /** lead_intake_record. */
  record(lead: Lead, note: string): Promise<RecordResult>;
  /** Send the owner a notice. Throws or resolves false when it did not go. */
  notifyOwner(message: { subject: string; content: EmailContent; idempotencyKey: string }): Promise<boolean>;
  keyCacheMs?: number;
  now?: () => number;
  logSink?: LogSink;
}

const MAX_BODY = 20_000;

export function createLeadIntakeHandler(deps: LeadIntakeDeps): (req: Request) => Promise<Response> {
  const verifier = createKeyVerifier({ loadKeyHash: deps.loadKeyHash, ttlMs: deps.keyCacheMs, now: deps.now });

  return createHandler({
    name: 'lead-intake',
    allowedOrigins: deps.allowedOrigins,
    auth: { apiKey: { verify: (presented) => verifier.verify(presented) } },
    // The key is checked before this; a wrong key never reaches a bucket. Then the
    // address, then everyone, both before the body is read.
    rateLimit: ({ ip, userAgent }) => deps.rateLimit(ip, userAgent),
    maxBodyBytes: MAX_BODY,
    logSink: deps.logSink,
    async handle({ body, json, log: requestLog }) {
      const parsed = parseLead(body);
      if (!parsed.ok) return json(400, { error: parsed.error, code: 'invalid_lead' });
      const lead = parsed.lead;

      const result = await deps.record(lead, leadNoteBody(lead));

      if (result.status !== 'replayed') {
        const contactUrl = deps.siteUrl && result.contact_id ? `${deps.siteUrl}/contacts/${result.contact_id}` : null;
        const notice = leadNotification(lead, result.status === 'created', contactUrl);
        try {
          const sent = await deps.notifyOwner({ ...notice, idempotencyKey: `lead-intake:${lead.external_id}` });
          if (!sent) requestLog.warn('the owner notice was not sent; the lead is recorded');
        } catch (err) {
          requestLog.error('the owner notice failed; the lead is recorded', err);
        }
      }
      return json(202, { status: 'accepted' });
    },
  });
}
