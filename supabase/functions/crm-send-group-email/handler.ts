// crm-send-group-email: the owner writes ONE message and each selected contact gets an
// individual copy (no shared To or Cc). Owner only. Two modes on one endpoint, and only
// one of them mails anyone:
//   send     writes the campaign and sends
//   preview  runs every read and check a send runs, renders the message through the
//            same renderer, and returns before the first write
//
// Why each guard is here:
//   1. Recipients are resolved HERE from contact ids. The browser never supplies an
//      address, so a tampered payload cannot mail an arbitrary third party from this
//      deployment's domain. The address is contacts.email, which 0002 keeps equal to the
//      default primary contact_emails row (or NULL), so it is never a stale one.
//   2. A server cap (250) and a per-owner rate limit (5 campaigns an hour). The page's
//      typed confirmation is a speed bump for a person, not a control.
//   3. The From is built from org_profile and EMAIL_FROM, never accepted from the caller.
//   4. Suppression and the contact's status are checked twice, failing closed both
//      times: once to build the list, and again as the last database call before each
//      provider call (group_email_claim), so an unsubscribe, or a contact marked lost,
//      that lands mid-run is honoured.
//   5. Three idempotency layers, because the inner two do not cover a second REQUEST: the
//      caller's key, unique per campaign (a double-click or a timeout retry gets the first
//      campaign back instead of a second send); the per-recipient claim with one row per
//      address; and a provider key stable per (campaign, address). The key is asked
//      about FIRST, before the rate limit and the audience: a retry gets its original
//      report even when the audience has since changed, and spends no allowance.
//   6. The unsubscribe link is added by the renderer, so it cannot be edited out.
//
// The door (origin, method, owner check, body cap, headers, generic errors) is
// createHandler's. Everything outside this file is injected, so the tests run this exact
// code against the real migrations in PGlite with only the provider faked.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { randomTokenBase64Url, sha256Hex } from '../_shared/crypto.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import { isValidEmail, type EmailMessage, type OutboundEnv, type SendResult } from '../_shared/outbound.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { renderGroupEmail } from './render.ts';

/**
 * Statuses that may receive a group email, before per-address suppression. Deno cannot
 * import src/, so this is the second copy of EMAILABLE_STATUSES in src/lib/contactStatus.ts;
 * src/__tests__/edge/crmSendGroupEmail.test.ts pins the two, and the seeded keys.
 */
export const EMAILABLE_STATUSES: readonly string[] = [
  'new_lead', 'active_lead', 'hot', 'warm', 'cold', 'client', 'one_time', 'former_client',
];

/** One campaign's ceiling. Anything near it is a mistake or a stolen session; raise it deliberately. */
export const MAX_RECIPIENTS = 250;
/** 250 ids and a 50,000-character body fit with room to spare. */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CAMPAIGNS_PER_HOUR = 5;
export const MAX_SUBJECT = 200;
export const MAX_BODY = 50_000;

export interface ContactRow {
  id: string;
  first_name: string | null;
  email: string | null;
  status: string;
  /** Set when the contact is archived: never mailed (group_email_claim re-checks at send). */
  archived_at?: string | null;
}

export interface BeginInput {
  idempotencyKey: string;
  createdBy: string;
  subject: string;
  body: string;
  fromIdentity: string;
  audienceDescription: string | null;
  recipients: { contact_id: string; address: string }[];
  skips: { contact_id: string; address: string; reason: string }[];
  tokens: { token_hash: string; address: string }[];
  skippedCount: number;
}

export type ReplayResult =
  | { outcome: 'missing' }
  | { outcome: 'released' }
  | {
      outcome: 'duplicate';
      campaign_id: string;
      sent: number;
      failed: number;
      skipped: number;
      unknown: number;
      unsent: number;
      still_running: boolean;
    };

/**
 * claimed: send it. suppressed: unsubscribed since the list was built. ineligible: the
 * contact's status no longer allows email (both rows now skipped). gone: another worker
 * has it, or the row went with its contact.
 */
export type ClaimResult = 'claimed' | 'suppressed' | 'ineligible' | 'gone';

export type Outcome = 'sent' | 'failed' | 'unknown' | 'skipped';

export interface RunCounts {
  sent: number;
  failed: number;
  unknown: number;
  skipped: number;
}

export interface GroupEmailDeps {
  allowedOrigins: string[];
  /** _shared/auth.ts authorizeOwner, bound to the function's clients. */
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** EdgeConfig.siteUrl: the human unsubscribe page lives at <siteUrl>/unsubscribe. */
  siteUrl: string | null;
  /** The RFC 8058 one-click target: <SUPABASE_URL>/functions/v1/email-unsubscribe. */
  oneClickUrl: string;
  outboundEnv: OutboundEnv;
  checkSendLimit(ownerId: string): Promise<RateLimitOutcome>;
  loadOrg(): Promise<OrgIdentity>;
  /** contacts id, first_name, email, status, archived_at for these ids (any order). Throws on error. */
  readContacts(ids: string[]): Promise<ContactRow[]>;
  /** Which of these (normalized) addresses are suppressed. Throws on error. */
  readSuppressed(addresses: string[]): Promise<string[]>;
  /** group_email_begin: the new campaign's id, or null when the key is already taken. */
  begin(input: BeginInput): Promise<string | null>;
  /** group_email_replay. */
  replay(idempotencyKey: string): Promise<ReplayResult>;
  /** group_email_claim, with the statuses that may still be mailed. */
  claim(campaignId: string, address: string, emailable: readonly string[]): Promise<ClaimResult>;
  /** group_email_record. */
  record(campaignId: string, address: string, outcome: Outcome, providerMessageId: string | null, error: string | null): Promise<void>;
  /** group_email_finish. */
  finish(campaignId: string, counts: RunCounts): Promise<void>;
  /** _shared/outbound.ts sendEmail. */
  sendEmail(message: EmailMessage): Promise<SendResult>;
  audit(ownerId: string, details: Record<string, string | number>, userAgent: string | null): Promise<void>;
  /** An unsubscribe token: 32 random bytes, base64url. Injected so tests can see it. */
  newToken?: () => string;
  logSink?: LogSink;
}

/** What the page is told about where messages go. */
export type Delivery = 'provider' | 'dev_outbox';

/**
 * Why email cannot go out from this deployment, or null when it can. A deployment with no
 * provider key outside production writes to dev_outbox, and the response says so, so a
 * fresh project never reads "12 delivered" for messages that left nothing.
 */
export function emailConfigProblem(env: OutboundEnv): string | null {
  if (env.resendApiKey && !env.emailFrom) return 'EMAIL_FROM must be set with RESEND_API_KEY.';
  if (!env.resendApiKey && env.production) return 'Email is not configured: set RESEND_API_KEY and EMAIL_FROM.';
  return null;
}

export function deliveryFor(env: OutboundEnv): Delivery {
  return env.resendApiKey ? 'provider' : 'dev_outbox';
}

export const normalizeAddress = (raw: string): string => raw.trim().toLowerCase();

/**
 * The provider key for one message: stable per (campaign, address), so a retry of THIS
 * message is de-duplicated, and hashed, so it is a fixed 69 characters whatever the
 * address (an interpolated 254-character address once overran a provider's key length
 * and failed the recipient outright). A random key would defeat the point.
 */
export async function providerKeyFor(campaignId: string, address: string): Promise<string> {
  return `${campaignId}:${(await sha256Hex(address)).slice(0, 32)}`;
}

/** The From as recorded on the campaign: the display name and EMAIL_FROM's address. */
function fromIdentity(org: OrgIdentity, emailFrom: string | null): string {
  if (!emailFrom) return `${org.senderName} (dev outbox)`;
  const address = (/<([^<>]+)>\s*$/.exec(emailFrom)?.[1] ?? emailFrom).trim();
  return `${org.senderName} <${address}>`.slice(0, 400);
}

const bad = (message: string) => new HttpError(400, message, 'bad_request');

interface GroupEmailRequest {
  mode: 'send' | 'preview';
  subject: string;
  body: string;
  contactIds: string[];
  idempotencyKey: string | null;
  audienceDescription: string | null;
}

function parseRequest(raw: unknown): GroupEmailRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Bad request.');
  const b = raw as Record<string, unknown>;

  // Absent means send. Anything else is refused, never defaulted: the one direction
  // this must never fail is "meant to preview, sent instead".
  const mode = b.mode === undefined ? 'send' : b.mode;
  if (mode !== 'send' && mode !== 'preview') throw bad('Bad request.');

  // Required for a send and never defaulted: a generated fallback would make every retry
  // a new campaign. A preview needs none and the page sends none.
  const idempotencyKey = isUuid(b.idempotency_key) ? b.idempotency_key : null;
  if (mode === 'send' && !idempotencyKey) throw bad('This send is missing its request id. Reload and try again.');

  const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
  if (!subject || subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) {
    throw bad(`Write a subject of up to ${MAX_SUBJECT} characters, on one line.`);
  }
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!body || body.length > MAX_BODY) throw bad(`Write a message of up to ${MAX_BODY.toLocaleString('en-US')} characters.`);

  if (!Array.isArray(b.contact_ids) || b.contact_ids.length === 0) throw bad('Choose at least one recipient.');
  // Bound the RAW array before filtering it: a million invalid entries plus one valid id
  // would pass a check on the filtered list after costing a million regex tests.
  const tooMany = bad(`A group email goes to at most ${MAX_RECIPIENTS} people.`);
  if (b.contact_ids.length > MAX_RECIPIENTS) throw tooMany;
  const contactIds = [...new Set(b.contact_ids.filter(isUuid))];
  if (contactIds.length === 0) throw bad('Choose at least one recipient.');

  const audienceDescription = typeof b.audience_description === 'string' ? b.audience_description.slice(0, 300) : null;
  return { mode, subject, body, contactIds, idempotencyKey, audienceDescription };
}

interface Target {
  contactId: string;
  firstName: string;
  address: string;
}

interface Skip {
  contactId: string;
  /** Null when there is no usable address: such a skip gets no row. */
  address: string | null;
  reason: string;
}

/**
 * Who would be mailed, in the REQUEST's order: that order decides who wins a shared
 * address and whose copy a preview renders, so the same composition previews as the same
 * person twice.
 */
function resolveTargets(ids: string[], rows: ContactRow[]): { targets: Target[]; skips: Skip[] } {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const targets: Target[] = [];
  const skips: Skip[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const c = byId.get(id);
    // No row: a contact that no longer exists, not a skip.
    if (!c) continue;
    if (c.archived_at != null) {
      skips.push({ contactId: c.id, address: null, reason: 'archived' });
      continue;
    }
    if (!EMAILABLE_STATUSES.includes(c.status)) {
      skips.push({ contactId: c.id, address: null, reason: `status ${c.status}` });
      continue;
    }
    const address = normalizeAddress(c.email ?? '');
    if (!address || !isValidEmail(address)) {
      skips.push({ contactId: c.id, address: null, reason: 'no valid address' });
      continue;
    }
    if (seen.has(address)) {
      skips.push({ contactId: c.id, address, reason: 'duplicate address' });
      continue;
    }
    seen.add(address);
    targets.push({ contactId: c.id, firstName: (c.first_name ?? '').trim(), address });
  }
  return { targets, skips };
}

export function createGroupEmailHandler(deps: GroupEmailDeps): (req: Request) => Promise<Response> {
  const newToken = deps.newToken ?? randomTokenBase64Url;

  return createHandler({
    name: 'crm-send-group-email',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: MAX_BODY_BYTES,
    logSink: deps.logSink,
    async handle({ principal, body: raw, json, log, userAgent }) {
      const req = parseRequest(raw);
      const isPreview = req.mode === 'preview';

      // Fail closed on configuration, before anything is spent or written. A send with no
      // page to put in the unsubscribe link, or a production deployment with no provider,
      // must not start.
      if (!deps.siteUrl) {
        throw new HttpError(503, 'Group email needs SITE_URL set on the server.', 'site_url_missing');
      }
      const configProblem = emailConfigProblem(deps.outboundEnv);
      if (configProblem) {
        log.error('email is not configured; refusing');
        throw new HttpError(503, configProblem, 'email_not_configured');
      }
      const delivery = deliveryFor(deps.outboundEnv);
      const visibleUnsubscribeUrl = `${deps.siteUrl.replace(/\/+$/, '')}/unsubscribe`;

      // A repeated request id is answered from its campaign before anything else: the
      // audience may have changed since (a contact deleted or marked lost), and a retry
      // must neither be refused for that nor spend the allowance. 'released' (it provably
      // delivered nothing and nothing runs) and 'missing' carry on as a new send.
      if (!isPreview) {
        const prior = await deps.replay(req.idempotencyKey!);
        if (prior.outcome === 'duplicate') {
          const { outcome: _outcome, ...report } = prior;
          return json(200, { ...report, duplicate: true, delivery });
        }
      }

      // A preview does not spend the allowance: it counts campaigns, and a draft is not
      // one. Looking at your work twice must not cost you the send.
      if (!isPreview) {
        const limit = await deps.checkSendLimit(principal.userId);
        if (limit === 'limited') throw new HttpError(429, 'Too many sends. Try again later.', 'rate_limited');
        if (limit !== 'allowed') throw new HttpError(REFUSALS.unavailable.status, REFUSALS.unavailable.error, REFUSALS.unavailable.code);
      }

      // Every read below fails closed: a throw is a generic error before any write.
      const rows = await deps.readContacts(req.contactIds);
      const { targets, skips } = resolveTargets(req.contactIds, rows);

      // Mailing someone who unsubscribed is the harm this guards. Stored addresses are
      // normalized by the database (0010's trigger), so an exact match is complete.
      const suppressed = new Set(targets.length ? await deps.readSuppressed(targets.map((t) => t.address)) : []);
      const sendable: Target[] = [];
      for (const t of targets) {
        if (suppressed.has(t.address)) skips.push({ contactId: t.contactId, address: t.address, reason: 'unsubscribed' });
        else sendable.push(t);
      }
      if (sendable.length === 0) throw bad('No one on this list can be emailed: every recipient was skipped.');

      const org = await deps.loadOrg();

      // ── The line between the two halves. Everything above reads; everything below
      // writes or leaves the building (the campaign and its reserved key, recipient rows,
      // tokens, provider calls, counters, the audit row). That position IS the preview's
      // safety property, and the preview must RETURN here: a render that falls through
      // mails everyone.
      if (isPreview) {
        const sample = sendable[0];
        return json(200, {
          preview: true,
          html: renderGroupEmail(org, req.body, sample.firstName, visibleUnsubscribeUrl).html,
          // WHOSE copy this is: {{first_name}} makes each recipient's different.
          sample: { first_name: sample.firstName, address: sample.address },
          eligible: sendable.length,
          skipped: skips.length,
          delivery,
        });
      }

      const idempotencyKey = req.idempotencyKey!;
      const tokens = new Map<string, string>();
      const tokenRows: BeginInput['tokens'] = [];
      for (const t of sendable) {
        const token = newToken();
        tokens.set(t.address, token);
        tokenRows.push({ token_hash: await sha256Hex(token), address: t.address });
      }
      // A skip row may not reuse an address that is queued (one row per address), and a
      // 'duplicate address' skip is exactly that; one without a usable address has none.
      const used = new Set(sendable.map((t) => t.address));
      const skipRows: BeginInput['skips'] = [];
      for (const s of skips) {
        if (!s.address || used.has(s.address)) continue;
        used.add(s.address);
        skipRows.push({ contact_id: s.contactId, address: s.address, reason: s.reason });
      }

      const campaignId = await deps.begin({
        idempotencyKey,
        createdBy: principal.userId,
        subject: req.subject,
        body: req.body,
        fromIdentity: fromIdentity(org, deps.outboundEnv.emailFrom),
        audienceDescription: req.audienceDescription,
        recipients: sendable.map((t) => ({ contact_id: t.contactId, address: t.address })),
        skips: skipRows,
        tokens: tokenRows,
        skippedCount: skips.length,
      });

      if (!campaignId) {
        // A concurrent request with this key began between the replay above and here.
        // Never re-run it: re-sending would double-deliver.
        const prior = await deps.replay(idempotencyKey);
        if (prior.outcome === 'duplicate') {
          const { outcome: _outcome, ...report } = prior;
          return json(200, { ...report, duplicate: true, delivery });
        }
        // Released: it provably delivered nothing and nothing is running, so the key is
        // free and the retry can send. Missing: released by another request just now.
        return json(409, { error: 'That send did not go out. Try again.', code: 'not_sent' });
      }

      const counts: RunCounts = { sent: 0, failed: 0, unknown: 0, skipped: skips.length };
      let lateSuppressed = 0;
      let lateIneligible = 0;
      const record = async (address: string, outcome: Outcome, id: string | null, error: string | null) => {
        try {
          await deps.record(campaignId, address, outcome, id, error);
        } catch (err) {
          // The message's fate is already decided; a lost log row must not stop the run.
          log.error('recording a recipient outcome failed', err, { campaign: campaignId, outcome });
        }
      };

      for (const t of sendable) {
        let claim: ClaimResult;
        try {
          claim = await deps.claim(campaignId, t.address, EMAILABLE_STATUSES);
        } catch (err) {
          // The status and suppression re-check could not run, so this one does not go out.
          log.error('claim failed; skipping the recipient', err, { campaign: campaignId });
          await record(t.address, 'skipped', null, 'eligibility check unavailable');
          counts.skipped++;
          lateSuppressed++;
          continue;
        }
        if (claim === 'gone') continue;
        if (claim === 'suppressed') {
          counts.skipped++;
          lateSuppressed++;
          continue;
        }
        if (claim === 'ineligible') {
          counts.skipped++;
          lateIneligible++;
          continue;
        }

        const token = encodeURIComponent(tokens.get(t.address)!);
        const rendered = renderGroupEmail(org, req.body, t.firstName, `${visibleUnsubscribeUrl}?t=${token}`);
        let result: SendResult;
        try {
          result = await deps.sendEmail({
            to: t.address,
            subject: req.subject,
            html: rendered.html,
            text: rendered.text,
            fromName: org.senderName,
            // The one-click header targets the function: providers POST to it directly.
            listUnsubscribe: { url: `${deps.oneClickUrl}?t=${token}`, oneClick: true },
            idempotencyKey: await providerKeyFor(campaignId, t.address),
          });
        } catch (err) {
          // Whatever threw, nothing says the message did not leave.
          log.error('send threw; delivery unknown', err, { campaign: campaignId });
          result = { status: 'unknown', channel: 'resend' };
        }

        if (result.status === 'sent') {
          counts.sent++;
          await record(t.address, 'sent', result.id, null);
        } else if (result.status === 'unknown') {
          // NOT failed. No answer looks the same whether the provider dropped the message
          // or accepted it and the reply was lost. 'failed' would leave the campaign with no
          // live recipient, release its key, and invite a retry under a new campaign whose
          // provider keys de-duplicate nothing: a second delivery.
          counts.unknown++;
          await record(t.address, 'unknown', null, 'no response from the provider; delivery unknown');
        } else {
          // A real refusal is an answer: it did not send, and a retry is safe.
          counts.failed++;
          await record(t.address, 'failed', null, result.httpStatus ? `${result.reason} (${result.httpStatus})` : result.reason);
        }
      }

      try {
        await deps.finish(campaignId, counts);
      } catch (err) {
        log.error('finishing the campaign failed', err, { campaign: campaignId });
      }
      try {
        await deps.audit(
          principal.userId,
          {
            campaign_id: campaignId,
            recipients: sendable.length,
            sent: counts.sent,
            failed: counts.failed,
            unknown: counts.unknown,
            skipped: counts.skipped,
            late_suppressed: lateSuppressed,
            late_ineligible: lateIneligible,
          },
          userAgent,
        );
      } catch (err) {
        // The messages already went out; a missing audit row must not report a failed send.
        log.error('audit failed', err, { campaign: campaignId });
      }

      return json(200, { campaign_id: campaignId, ...counts, delivery });
    },
  });
}
