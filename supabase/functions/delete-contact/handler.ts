// delete-contact: the only way to delete a contact. Owner only.
//
// A contact's portal accounts hold Auth sign-in users, which Postgres cannot delete in
// the same transaction as the rows. So the delete runs as a claim (0002_contacts.sql):
//   begin   locks the contact, suspends its accounts, returns their sign-in users
//   destroy deletes those Auth users (an already-missing user counts as destroyed)
//   finish  deletes the accounts and the contact under the claim
//   release on any failure after begin, restores what is left and clears the claim
//
// Everything outside this file is injected, so the tests run this exact code against
// the real migrations in PGlite with only the Auth boundary faked.

import { BodyError, bearerToken, isUuid, json, originRefused, readJsonBody, responseHeaders } from '../_shared/http.ts';

export interface BeginResult {
  exists_now: boolean;
  blocking_code: string | null;
  user_ids: string[];
  prior: Record<string, string>;
  claim: string | null;
}

export interface DeleteContactDeps {
  allowedOrigins: string[];
  /** The caller's user id if the token is valid AND the database says it is the owner. */
  authorizeOwner(token: string): Promise<string | null>;
  begin(contactId: string): Promise<BeginResult>;
  /** 'missing' when the user was already gone. Throws on any other failure. */
  deleteAuthUser(userId: string): Promise<'deleted' | 'missing'>;
  finish(contactId: string, claim: string): Promise<string[]>;
  release(contactId: string, prior: Record<string, string>, claim: string, destroyed: string[]): Promise<void>;
  /** `orphanedUserIds`: sign-ins that outlived their deleted rows, for the owner to remove. */
  audit(ownerId: string, contactId: string, portalUsersRemoved: number, orphanedUserIds: string[]): Promise<void>;
  log(message: string, detail?: unknown): void;
}

const MAX_BODY_BYTES = 1024;
const GENERIC_FAILURE = { error: 'The contact could not be deleted. Try again.' };

export function createDeleteContactHandler(deps: DeleteContactDeps) {
  return async (req: Request): Promise<Response> => {
    const origins = deps.allowedOrigins;
    if (req.method === 'OPTIONS') {
      if (originRefused(req, origins)) return new Response(null, { status: 403, headers: responseHeaders(req, origins) });
      return new Response(null, { status: 204, headers: responseHeaders(req, origins) });
    }
    if (req.method !== 'POST') return json(req, origins, 405, { error: 'Method not allowed' });
    if (originRefused(req, origins)) return json(req, origins, 403, { error: 'Origin not allowed' });

    const token = bearerToken(req);
    if (!token) return json(req, origins, 401, { error: 'Sign in again.' });
    let ownerId: string | null;
    try {
      ownerId = await deps.authorizeOwner(token);
    } catch (err) {
      deps.log('authorize failed', err);
      return json(req, origins, 401, { error: 'Sign in again.' });
    }
    if (!ownerId) return json(req, origins, 403, { error: 'Only the owner can delete contacts.' });

    let contactId: unknown;
    try {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      contactId = (body as { contact_id?: unknown } | null)?.contact_id;
    } catch (err) {
      const status = err instanceof BodyError ? err.status : 400;
      return json(req, origins, status, { error: 'Bad request' });
    }
    if (!isUuid(contactId)) return json(req, origins, 400, { error: 'Bad request' });
    const id = contactId;

    let begun: BeginResult;
    try {
      begun = await deps.begin(id);
    } catch (err) {
      deps.log('begin failed', err);
      return json(req, origins, 500, GENERIC_FAILURE);
    }
    if (!begun.exists_now) return json(req, origins, 200, { deleted: true, already_gone: true });
    if (begun.blocking_code) return json(req, origins, 409, { error: 'delete_in_progress' });
    const claim = begun.claim!;

    const destroyed: string[] = [];
    const undo = async (stage: string, err: unknown): Promise<Response> => {
      deps.log(`${stage} failed`, err);
      try {
        await deps.release(id, begun.prior, claim, destroyed);
      } catch (releaseErr) {
        // The claim expires on its own after five minutes; a retry then starts clean.
        deps.log('release failed', releaseErr);
      }
      return json(req, origins, 500, GENERIC_FAILURE);
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
        deps.log('late sign-in delete failed', err);
      }
    }

    try {
      await deps.audit(ownerId, id, destroyed.length, orphaned);
    } catch (err) {
      deps.log('audit failed', err);
    }
    return json(req, origins, 200, { deleted: true });
  };
}
