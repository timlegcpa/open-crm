import { ID } from './ids';
import type { Row } from './postgrest';
import type { CallContext, FnHandler, FnRequest, RpcHandler } from './supabase';

/** Documents (0003): one shared folder with an agreement in it, and one unreviewed client upload. */

export const AGREEMENT_DOC = '00000000-0000-4000-8000-000000000501';
export const UPLOAD_DOC = '00000000-0000-4000-8000-000000000502';
export const AGREEMENTS_FOLDER = '00000000-0000-4000-8000-000000000511';

function doc(fields: Row): Row {
  return {
    contact_id: ID.ada,
    uploaded_by: ID.owner,
    file_size: 1840,
    mime_type: 'application/pdf',
    category: 'general',
    description: null,
    created_at: '2026-10-03T15:00:00Z',
    updated_at: '2026-10-03T15:00:00Z',
    reviewed_at: null,
    reviewed_by: null,
    encryption_iv: 'iv-placeholder',
    encryption_status: 'encrypted',
    shared_with_contact_id: null,
    ...fields,
  };
}

export const documentTables: Record<string, Row[]> = {
  client_folders: [
    {
      id: AGREEMENTS_FOLDER,
      contact_id: ID.ada,
      parent_path: '/',
      name: 'Agreements',
      created_at: '2026-10-03T14:00:00Z',
      held_by: 'owner',
      reviewed_at: '2026-10-03T14:00:00Z',
      reviewed_by: ID.owner,
    },
  ],
  client_documents: [
    doc({
      id: AGREEMENT_DOC,
      filename: 'service-agreement.pdf',
      original_filename: 'Service agreement.pdf',
      storage_path: `${ID.ada}/service-agreement.pdf`,
      folder_path: '/Agreements/',
      held_by: 'owner',
      reviewed_at: '2026-10-03T15:00:00Z',
      reviewed_by: ID.owner,
    }),
    doc({
      id: UPLOAD_DOC,
      uploaded_by: ID.clientUser,
      filename: 'company-registration.pdf',
      original_filename: 'Company registration.pdf',
      storage_path: `${ID.ada}/company-registration.pdf`,
      folder_path: '/',
      held_by: 'client',
      created_at: '2026-10-09T10:00:00Z',
      updated_at: '2026-10-09T10:00:00Z',
    }),
  ],
};

export const documentRpc: Record<string, RpcHandler> = {
  get_contact_ids_with_documents: (_args: Record<string, unknown>, ctx: CallContext) =>
    [...new Set([...ctx.table('client_documents'), ...ctx.table('client_folders')].map((r) => r.contact_id as string))].map((contact_id) => ({ contact_id })),
};

export function documentFunctions(pdf: Buffer): Record<string, FnHandler> {
  return {
    /** Every stored document is the sample PDF. */
    'decrypt-document': () => ({ body: pdf, contentType: 'application/octet-stream' }),
    'encrypt-document': (req: FnRequest, ctx: CallContext) => {
      const id = ctx.newId();
      const name = /filename="([^"]+)"/.exec(req.body?.toString('latin1') ?? '')?.[1] ?? 'upload.pdf';
      return { json: { id, filename: name } };
    },
  };
}
