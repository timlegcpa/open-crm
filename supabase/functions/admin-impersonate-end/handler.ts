// admin-impersonate-end: end "View as client". Owner only, and only the owner who
// started the row.
//
// The minted session is revoked EVERY time, before the already-ended check: a row the
// stale sweep closed still gets its session deleted on the next try. A revoke that fails
// is a 502 and the row stays open, so the end is retried rather than reported done. Revoking deletes the auth.sessions row, which kills its
// refresh token; the access token in hand stays read-only for as long as the row exists,
// because a bound session is restricted whatever ended_at says.
//
// The audit row also says whether the client's password, email or second factors changed
// during the view, against the snapshot 0012 takes when the row is created.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';

export interface SessionRow {
  id: string;
  owner_user_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface CredentialChanges {
  password_changed: boolean;
  email_changed: boolean;
  factors_added: number;
}

export interface ImpersonateEndDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  loadSession(rowId: string): Promise<SessionRow | null>;
  /** revoke_impersonation_auth_session: whether a session was removed. */
  revoke(rowId: string): Promise<boolean>;
  /** Close the row if it is open; whether this call closed it. */
  end(rowId: string): Promise<boolean>;
  /**
   * impersonation_credential_changes: whether the client's password, email or factors
   * changed since the view started (the lock in 0012 should make all three false). Null
   * when the start snapshot is missing.
   */
  credentialChanges(rowId: string): Promise<CredentialChanges | null>;
  audit(entry: { ownerId: string; details: Record<string, string | number | boolean>; ip: string | null; userAgent: string | null }): Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

export function createImpersonateEndHandler(deps: ImpersonateEndDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'admin-impersonate-end',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const rowId = (body as { session_id?: unknown } | null)?.session_id;
      if (!isUuid(rowId)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);

      const row = await deps.loadSession(rowId);
      if (!row) throw new HttpError(404, 'That View as client session does not exist.', 'not_found');
      if (row.owner_user_id !== principal.userId) {
        throw new HttpError(REFUSALS.forbidden.status, REFUSALS.forbidden.error, REFUSALS.forbidden.code);
      }

      // A revoke that fails leaves the row open and says so: the minted session is still
      // alive, so the view is not over. The owner's tab keeps the view and can retry, the
      // credential lock keeps holding, and the stale sweep still sees an open row.
      let revoked: boolean;
      try {
        revoked = await deps.revoke(row.id);
      } catch (err) {
        log.error('revoke failed', err);
        throw new HttpError(502, 'View as client could not be ended. Try again.', 'revoke_failed');
      }

      if (row.ended_at) return json(200, { success: true, already_ended: true, session_revoked: revoked });

      const closed = await deps.end(row.id);
      if (closed) {
        let credentials: Record<string, boolean | number> = { credentials_checked: false };
        try {
          const changes = await deps.credentialChanges(row.id);
          if (changes) credentials = { credentials_checked: true, ...changes };
        } catch (err) {
          log.error('credential check failed', err);
        }
        if (credentials.password_changed || credentials.email_changed || Number(credentials.factors_added) > 0) {
          log.error('the client credentials changed during View as client');
        }
        try {
          await deps.audit({
            ownerId: principal.userId,
            details: {
              session_id: row.id,
              duration_ms: Math.max(0, now().getTime() - Date.parse(row.started_at)),
              session_revoked: revoked,
              ...credentials,
            },
            ip,
            userAgent,
          });
        } catch (err) {
          log.error('audit failed', err);
        }
      }
      return json(200, { success: true, already_ended: !closed, session_revoked: revoked });
    },
  });
}
