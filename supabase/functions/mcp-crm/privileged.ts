// The connector's reach beyond the database: the answer key, Storage and Auth. Pure over
// injected dependencies (index.ts passes the server's own clients and keys), so vitest runs
// it as it is. Nothing here audits: the mcp_* function each tool calls first has already
// written the record of the act.

import { decryptDocument, decryptPii, fromBytea } from '../_shared/crypto.ts';
import type { PrivilegedOps } from './tools.ts';

export interface PrivilegedDeps {
  /** PII_ENCRYPTION_KEY; null when unset (an answer then cannot be opened). */
  piiKey: string | null;
  /** DOCUMENT_ENCRYPTION_KEY; null when unset (an encrypted document then cannot be read). */
  documentKey: string | null;
  /** The bytes of an object in the client-documents bucket. Throws on any failure. */
  download(path: string): Promise<Uint8Array>;
  /** Auth's admin update of one user's address, confirmed; its error as Auth returned it. */
  updateUserEmail(userId: string, email: string): Promise<{ error: { status?: number } | null }>;
}

export function createPrivilegedOps(deps: PrivilegedDeps): PrivilegedOps {
  return {
    async openAnswer(ciphertext) {
      if (!deps.piiKey) throw new Error('PII_ENCRYPTION_KEY is not set');
      return await decryptPii(fromBytea(ciphertext), deps.piiKey);
    },

    async readDocument(doc) {
      const bytes = await deps.download(doc.storage_path);
      if (doc.encryption_status === 'none') return bytes;
      if (!deps.documentKey) throw new Error('DOCUMENT_ENCRYPTION_KEY is not set');
      if (!doc.encryption_iv) throw new Error('an encrypted document has no IV');
      return await decryptDocument(bytes, doc.encryption_iv, deps.documentKey);
    },

    async setSignInEmail(userId, email) {
      const { error } = await deps.updateUserEmail(userId, email);
      if (!error) return 'changed';
      // A 4xx is Auth refusing the change (an address in use, a malformed one): nothing
      // moved. Anything else leaves the outcome unknown, so it is thrown, never reported
      // as "nothing changed".
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return 'refused';
      throw new Error(`the sign-in address update failed with status ${String(error.status)}`);
    },
  };
}
