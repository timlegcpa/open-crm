// mfa-recovery: redeem a backup code to remove two-factor from an account whose
// authenticator is lost. For the owner and for a client.
//
// This door is deliberately BELOW the MFA bar: the person holds the password (an aal1
// session) but not the authenticator, so is_owner() and get_client_contact_id() both
// answer no for them, and the owner and client modes would refuse exactly the caller this
// exists for. So it is a public function with a per-address rate limit, and it proves the
// caller itself. Its dangers are held by, in order:
//   1. a live session (Auth getUser on the bearer token): no anonymous caller passes;
//   2. who that session is, decided with the service role: the owner, or a user with an
//      active portal account; never the system actor; never the owner's View-as-client
//      session (an owner holding a client's session must not strip that client's factors
//      and sign them out everywhere). The impersonation lookup fails closed;
//   3. rate limits per address, then for everyone, before the body is read; then per
//      user, before any code is looked at;
//   4. single-use codes claimed atomically (active to reserved, one winner). A
//      reservation is owned: only the request that claimed it may release it, and only
//      while no alert has been stamped;
//   5. ALERT BEFORE STRIP: the owner's alert must send AND its stamp must persist before
//      any factor is deleted. If either fails, the request releases its own code and
//      two-factor stays on. No silent removal, even a successful one. In production that
//      needs an email provider: with none, outbound refuses to send and no backup code
//      can ever be redeemed (the README says so). Locally the alert lands in dev_outbox;
//   6. resumable: a crash after the stamped alert leaves a reserved, alerted code that only
//      the same code resumes (no second alert). An unalerted reservation belongs to a
//      request still in flight and is never resumed or released by another;
//   7. ONE REQUEST AT A TIME: every claim and resume takes a lease (a fresh token, two
//      minutes). While a lease is live a second request is "in flight", never a second
//      resumer; a takeover after it runs out rotates the token. Every step after the claim
//      presents the token, so a delayed request that lost its lease stops, and an abort
//      gives the lease up so the same code can resume at once;
//   8. SIGN OUT EVERYWHERE before any factor dies: every refresh token is revoked first,
//      so no session from before the recovery can mint a new token afterwards. The lease
//      is renewed just before it; failure aborts, resumable;
//   9. finalize, in ONE transaction under the code's lock: checks the code is still
//      reserved and the lease still this request's, stamps the lockout (mfa_recovery_lockouts
//      kills every access token issued before this second), deletes every factor, burns
//      the code, revokes the rest of the set and writes the audit row. A request that lost
//      its lease raises lease_lost there and has deleted nothing, so it can never remove a
//      factor enrolled after another request finished.
// Every invalid code gets the SAME message, so the endpoint answers no more than "wrong"
// for each rate-limited guess.

import { HttpError, REFUSALS, createHandler } from '../_shared/handler.ts';
import { bearerToken } from '../_shared/http.ts';
import type { EmailContent } from '../_shared/email-layout.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { normalizeBackupCode } from '../_shared/mfa-backup-code.ts';
import { jwtSessionId } from '../_shared/auth.ts';

export type AccountKind = 'owner' | 'client';

export interface ClaimResult {
  state?: unknown;
  id?: unknown;
  lease?: unknown;
  alerted?: unknown;
}

/** One alert email, composed here, sent by index.ts through outbound. */
export interface AlertEmail {
  to: string;
  subject: string;
  content: EmailContent;
  idempotencyKey: string;
}

export interface MfaRecoveryDeps {
  allowedOrigins: string[];
  /** The site the links in the alert point at; null leaves them out. */
  siteUrl: string | null;
  /** checkPublicLimits for 'mfa_recovery': the address's bucket, then the global one, before the body. */
  publicLimits(ip: string | null, userAgent: string | null): Promise<RateLimitOutcome>;
  /** checkUserLimit for 'mfa_recovery'. */
  userLimit(userId: string): Promise<RateLimitOutcome>;
  /** _shared/auth.ts sessionUserId: the user of a live session, or null. */
  sessionUserId(token: string): Promise<string | null>;
  /** The owner, a client (an active portal account), or neither. The system actor is neither. */
  accountKind(userId: string): Promise<AccountKind | null>;
  /** is_impersonation_session. Must answer true when it cannot tell. */
  isViewAsClient(userId: string, sessionId: string | null): Promise<boolean>;
  /** The account's own address and the owner's address, from Auth. */
  addresses(userId: string): Promise<{ account: string | null; owner: string | null }>;
  hashCode(compact: string): Promise<string>;
  claim(userId: string, hash: string): Promise<ClaimResult | null>;
  /** mfa_backup_code_release: gives this request's lease up (an unalerted code goes back to active). */
  release(codeId: string, userId: string, lease: string): Promise<void>;
  /** True only when the provider accepted the message (or the dev outbox stored it). */
  sendEmail(message: AlertEmail): Promise<boolean>;
  /** mfa_backup_code_alerted: stamps alert_sent_at while the lease is ours; true when stamped. */
  stampAlert(codeId: string, userId: string, lease: string): Promise<boolean>;
  /** mfa_backup_code_lease_renew: false when the lease is no longer ours. */
  renewLease(codeId: string, userId: string, lease: string): Promise<boolean>;
  /** Auth admin sign-out of every session of the token's user. Throws on failure. */
  signOutEverywhere(token: string): Promise<void>;
  /** mfa_backup_code_finalize: lease check, lockout, factor deletion and burn in one transaction. Throws on lease_lost. */
  finalize(codeId: string, userId: string, lease: string, ip: string | null, userAgent: string | null): Promise<void>;
  /** Default: a real wait. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

export const INVALID_CODE = 'That code is not valid. Check it and try again.';
export const RETRY_LATER = 'Recovery could not be finished. Try again shortly.';

const SIGN_OUT_ATTEMPTS = 3;

function refusal(r: { status: number; error: string; code: string }): HttpError {
  return new HttpError(r.status, r.error, r.code);
}

/** The alert the owner gets, and the copy a client gets for their own account. */
export function recoveryAlerts(input: {
  kind: AccountKind;
  account: string | null;
  owner: string;
  ip: string | null;
  at: Date;
  codeId: string;
  siteUrl: string | null;
}): AlertEmail[] {
  const subject = 'Two-factor removed with a backup code';
  const when = input.at.toISOString();
  const effect =
    'Every authenticator on the account was removed, its other backup codes stopped working, and every session was signed out.';
  const ownerBlocks: EmailContent['blocks'] = [
    { kind: 'heading', text: subject },
    {
      kind: 'paragraph',
      text: `${input.kind === 'owner' ? 'Your account' : `A client account (${input.account ?? 'address unknown'})`} used a backup code to turn off two-factor sign-in.`,
    },
    { kind: 'list', items: [`When: ${when}`, `From address: ${input.ip ?? 'unknown'}`, effect] },
    {
      kind: 'note',
      text: 'If this was not expected, change the password now and set up an authenticator again.',
    },
    ...(input.siteUrl ? [{ kind: 'button' as const, label: 'Open settings', url: `${input.siteUrl}/settings` }] : []),
  ];
  const alerts: AlertEmail[] = [
    { to: input.owner, subject, content: { blocks: ownerBlocks }, idempotencyKey: `mfa-recovery:${input.codeId}:owner` },
  ];
  if (input.kind === 'client' && input.account) {
    alerts.push({
      to: input.account,
      subject,
      content: {
        blocks: [
          { kind: 'heading', text: subject },
          { kind: 'paragraph', text: 'A backup code was used to turn off two-factor sign-in on your account.' },
          { kind: 'list', items: [`When: ${when}`, effect] },
          { kind: 'note', text: 'If this was not you, change your password now and tell us.' },
          ...(input.siteUrl ? [{ kind: 'button' as const, label: 'Open your profile', url: `${input.siteUrl}/portal/profile` }] : []),
        ],
      },
      idempotencyKey: `mfa-recovery:${input.codeId}:account`,
    });
  }
  return alerts;
}

export function createMfaRecoveryHandler(deps: MfaRecoveryDeps): (req: Request) => Promise<Response> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());

  return createHandler({
    name: 'mfa-recovery',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: ({ ip, userAgent }) => deps.publicLimits(ip, userAgent),
    maxBodyBytes: 4000,
    logSink: deps.logSink,
    async handle({ req, body, ip, userAgent, json, log }) {
      // Public mode leaves ctx.token null; the session is proved here.
      const token = bearerToken(req);
      const userId = token ? await deps.sessionUserId(token) : null;
      if (!token || !userId) throw refusal(REFUSALS.unauthenticated);

      const kind = await deps.accountKind(userId);
      if (!kind) throw refusal(REFUSALS.forbidden);
      if (kind === 'client' && (await deps.isViewAsClient(userId, jwtSessionId(token)))) throw refusal(REFUSALS.readOnly);

      const limited = await deps.userLimit(userId);
      if (limited === 'limited') throw refusal(REFUSALS.rateLimited);
      if (limited !== 'allowed') throw refusal(REFUSALS.unavailable);

      const compact = normalizeBackupCode((body as { code?: unknown } | null)?.code);
      if (!compact) return json(400, { error: INVALID_CODE, code: 'invalid_code' });

      const claim = await deps.claim(userId, await deps.hashCode(compact));
      if (claim?.state === 'in_flight') return json(409, { error: RETRY_LATER, code: 'in_flight' });
      if ((claim?.state !== 'claimed' && claim?.state !== 'resume') || typeof claim.id !== 'string') {
        return json(400, { error: INVALID_CODE, code: 'invalid_code' });
      }
      if (typeof claim.lease !== 'string') throw new Error('claim returned no lease');
      const codeId = claim.id;
      const lease = claim.lease;
      const alerted = claim.alerted === true;

      // Gives up this request's lease: an unalerted code goes back to active, an alerted one
      // stays reserved and may resume at once. The RPC acts only for the lease holder.
      const releaseOwnClaim = async () => {
        try {
          await deps.release(codeId, userId, lease);
        } catch (err) {
          log.error('release failed', err);
        }
      };
      const retryLater = () => json(502, { error: RETRY_LATER, code: 'retry' });

      if (!alerted) {
        let sent = false;
        try {
          const { account, owner } = await deps.addresses(userId);
          if (!owner) throw new Error('the owner has no address to alert');
          const [ownerAlert, accountAlert] = recoveryAlerts({ kind, account, owner, ip, at: now(), codeId, siteUrl: deps.siteUrl });
          sent = await deps.sendEmail(ownerAlert);
          // The client's own copy is a courtesy; the owner's alert is the checkpoint.
          if (sent && accountAlert && !(await deps.sendEmail(accountAlert).catch(() => false))) {
            log.warn('the account copy of the alert was not sent');
          }
        } catch (err) {
          log.error('alert failed', err);
          sent = false;
        }
        if (!sent) {
          await releaseOwnClaim();
          log.error('recovery refused: the alert was not sent; code released');
          return retryLater();
        }
        let stamped = false;
        try {
          stamped = await deps.stampAlert(codeId, userId, lease);
        } catch (err) {
          log.error('alert stamp failed', err);
        }
        if (!stamped) {
          await releaseOwnClaim();
          log.error('recovery refused: the alert was not stamped; code released');
          return retryLater();
        }
      }

      // From here the code is reserved and alerted: a failure leaves it resumable by the
      // same code, and nothing has been removed until finalize.
      let leaseHeld = false;
      try {
        leaseHeld = await deps.renewLease(codeId, userId, lease);
      } catch (err) {
        log.error('lease renewal failed', err);
      }
      if (!leaseHeld) {
        // Another request holds the code now, or it is finished: touch nothing.
        log.error('recovery stopped: the lease was lost before sign-out');
        return retryLater();
      }

      let signedOut = false;
      for (let attempt = 1; attempt <= SIGN_OUT_ATTEMPTS && !signedOut; attempt++) {
        try {
          await deps.signOutEverywhere(token);
          signedOut = true;
        } catch (err) {
          log.error('sign-out everywhere failed', err, { attempt });
          if (attempt < SIGN_OUT_ATTEMPTS) await sleep(attempt * 300);
        }
      }
      if (!signedOut) {
        await releaseOwnClaim();
        return retryLater();
      }

      try {
        await deps.finalize(codeId, userId, lease, ip, userAgent ? userAgent.slice(0, 300) : null);
      } catch (err) {
        // lease_lost included: finalize is one transaction, so nothing was removed.
        log.error('finalize failed; nothing removed', err);
        await releaseOwnClaim();
        return retryLater();
      }

      return json(200, {
        removed: true,
        note: `Two-factor is off and every session for this account has been signed out. Sign in again with your password, then turn two-factor back on from ${kind === 'owner' ? 'Settings' : 'your profile'}.`,
      });
    },
  });
}
