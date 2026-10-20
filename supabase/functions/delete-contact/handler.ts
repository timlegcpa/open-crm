// delete-contact: the only way to delete a contact. Owner only.
//
// A contact's portal accounts hold Auth sign-in users, which Postgres cannot delete in
// the same transaction as the rows. So the delete runs as a claim (0002_contacts.sql):
//   begin   locks the contact, suspends its accounts, returns their sign-in users
//   destroy deletes those Auth users (an already-missing user counts as destroyed)
//   finish  deletes the accounts and the contact under the claim
//   release on any failure after begin, restores what is left and clears the claim
//           (after expiring the contact's pending start links, once any sign-in was destroyed)
//
// The door (origin, method, owner check, body cap, headers, generic errors) is
// createHandler's. Everything outside this file is injected, so the tests run this exact
// code against the real migrations in PGlite with only the Auth boundary faked.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';

export interface BeginResult {
  exists_now: boolean;
  blocking_code: string | null;
  user_ids: string[];
  prior: Record<string, string>;
  claim: string | null;
}

export interface DeleteContactDeps {
  allowedOrigins: string[];
  /** _shared/auth.ts authorizeOwner, bound to the function's clients. */
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  begin(contactId: string): Promise<BeginResult>;
  /** 'missing' when the user was already gone. Throws on any other failure. */
  deleteAuthUser(userId: string): Promise<'deleted' | 'missing'>;
  finish(contactId: string, claim: string): Promise<string[]>;
  /** Marks every pending start link of the contact expired. */
  expireStartLinks(contactId: string): Promise<void>;
  release(contactId: string, prior: Record<string, string>, claim: string, destroyed: string[]): Promise<void>;
  /** `orphanedUserIds`: sign-ins that outlived their deleted rows, for the owner to remove. */
  audit(ownerId: string, contactId: string, portalUsersRemoved: number, orphanedUserIds: string[]): Promise<void>;
  /** Where log lines go; the console when omitted. Tests collect them. */
  logSink?: LogSink;
}

const GENERIC_FAILURE = { error: 'The contact could not be deleted. Try again.' };

export function createDeleteContactHandler(deps: DeleteContactDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'delete-contact',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log }) {
      const id = (body as { contact_id?: unknown } | null)?.contact_id;
      if (!isUuid(id)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);

      let begun: BeginResult;
      try {
        begun = await deps.begin(id);
      } catch (err) {
        log.error('begin failed', err);
        return json(500, GENERIC_FAILURE);
      }
      if (!begun.exists_now) return json(200, { deleted: true, already_gone: true });
      if (begun.blocking_code) return json(409, { error: 'delete_in_progress' });
      const claim = begun.claim!;

      const destroyed: string[] = [];
      const undo = async (stage: string, err: unknown): Promise<Response> => {
        log.error(`${stage} failed`, err);
        // Once a sign-in is destroyed its address is free, and lifting the claim lets an
        // account attach to this contact again, so a start link sent earlier to that address
        // could recreate the sign-in while another account keeps the contact alive. Expire
        // the contact's pending start links BEFORE the claim lifts: until then the claim
        // refuses any account write, and afterwards a redemption finds its link expired.
        // Only once something was destroyed, so a refusal before that changes nothing.
        // Logged, not fatal: the release must still run, and after it the redemption check
        // (start_link_access_revoked) refuses every link of the contact on its own, because
        // the release deactivates each account it left without a sign-in, so any account
        // still active holds one. This makes the links read as expired. revoke-portal-access
        // has no such cover, so it expires them inside its own transaction (0016).
        if (destroyed.length > 0) {
          try {
            await deps.expireStartLinks(id);
          } catch (linksErr) {
            log.error('start link expiry failed', linksErr);
          }
        }
        try {
          await deps.release(id, begun.prior, claim, destroyed);
        } catch (releaseErr) {
          // The claim expires on its own after five minutes; a retry then starts clean.
          log.error('release failed', releaseErr);
        }
        return json(500, GENERIC_FAILURE);
      };

      try {
        for (const userId of begun.user_ids) {
          await deps.deleteAuthUser(userId);
          destroyed.push(userId);
        }
      } catch (err) {
        return undo('destroy', err);
      }

      let heldAtDelete: string[];
      try {
        heldAtDelete = await deps.finish(id, claim);
      } catch (err) {
        return undo('finish', err);
      }

      // The claim refuses any new sign-in attaching to these accounts, so this is empty.
      // If it is not, the rows are gone and the sign-ins must not outlive them.
      const orphaned: string[] = [];
      for (const userId of heldAtDelete.filter((held) => !destroyed.includes(held))) {
        try {
          await deps.deleteAuthUser(userId);
          destroyed.push(userId);
        } catch (err) {
          orphaned.push(userId);
          // The user id goes to the audit row below, not to the function log.
          log.error('late sign-in delete failed', err);
        }
      }

      try {
        await deps.audit(principal.userId, id, destroyed.length, orphaned);
      } catch (err) {
        log.error('audit failed', err);
      }
      return json(200, { deleted: true });
    },
  });
}
