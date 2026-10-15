// log-portal-event: a client's session lifecycle (sign-in, sign-out, a timed-out
// session) into client_activity_log, with the caller's address, which only the server
// can record. Client only (an active portal account, MFA satisfied); 500 events an hour
// per user, which no real session reaches and a runaway loop does.
//
// The owner's View-as-client session is NOT refused (that would be clientWrites) but
// skipped: 204, nothing written. Its sign-out and timeout run the same code a client's
// do, and a row from it would put the owner's actions in the client's history. The
// write trigger cannot catch this one, because the insert runs as the server. The
// impersonation lookup fails closed (an error reads as View as client), so a database
// hiccup can drop a real client's lifecycle row: a lost log line, never a wrong one.
//
// A sign-in also counts on the account, atomically (record_portal_login, 0012).

import type { AuthOutcome, ClientPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS, type RequestContext } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';

/** What a client may log here. Everything else in the activity log is written where it happens. */
export const PORTAL_EVENTS = ['login', 'logout', 'session_start', 'session_expired'] as const;
export type PortalEvent = (typeof PORTAL_EVENTS)[number];

export interface LogPortalEventDeps {
  allowedOrigins: string[];
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  rateLimit(ctx: RequestContext<ClientPrincipal>): Promise<RateLimitOutcome>;
  insertEvent(row: { contactId: string; userId: string; action: PortalEvent; ip: string | null; userAgent: string | null }): Promise<void>;
  recordLogin(userId: string): Promise<void>;
  logSink?: LogSink;
}

const isPortalEvent = (value: unknown): value is PortalEvent =>
  typeof value === 'string' && (PORTAL_EVENTS as readonly string[]).includes(value);

export function createLogPortalEventHandler(deps: LogPortalEventDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'log-portal-event',
    allowedOrigins: deps.allowedOrigins,
    auth: { client: deps.authorizeClient },
    // Skipped below, not refused: see the file comment.
    clientWrites: false,
    rateLimit: deps.rateLimit,
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const action = (body as { action?: unknown } | null)?.action;
      if (!isPortalEvent(action)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      if (principal.impersonating) return new Response(null, { status: 204 });

      await deps.insertEvent({ contactId: principal.contactId, userId: principal.userId, action, ip, userAgent });
      if (action === 'login') {
        try {
          await deps.recordLogin(principal.userId);
        } catch (err) {
          log.error('could not count the sign-in', err);
        }
      }
      return json(200, { ok: true });
    },
  });
}
