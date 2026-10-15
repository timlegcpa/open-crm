import { ID } from './ids';
import type { Row } from './postgrest';
import type { CallContext, FnHandler, FnRequest } from './supabase';

/** E-sign (0006): one envelope out with Ada, and the owner's composer functions. */

export const ENVELOPE_ID = '00000000-0000-4000-8000-000000000601';
export const ENVELOPE_SIGNER = '00000000-0000-4000-8000-000000000611';

const adaAsSigner = {
  id: ID.ada,
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.test',
  status: 'client',
  spouse_first_name: null,
  spouse_last_name: null,
  spouse_email: null,
};

const adaAsPrimary = { ...adaAsSigner, phone: '(555) 010-0101', spouse_phone: null };

function envelope(fields: Row): Row {
  return {
    created_by: ID.owner,
    primary_contact_id: ID.ada,
    verification_level: 'standard',
    source_pdf_sha256: null,
    signed_pdf_path: null,
    signed_pdf_sha256: null,
    void_reason: null,
    expires_at: null,
    sent_at: null,
    completed_at: null,
    voided_at: null,
    updated_at: '2026-10-06T15:00:00Z',
    primary_contact: adaAsPrimary,
    signers: [],
    ...fields,
  };
}

function signer(fields: Row): Row {
  return {
    order: 1,
    role: 'primary',
    phone_last_four: null,
    invited_at: null,
    opened_email_at: null,
    first_viewed_at: null,
    signed_at: null,
    signed_signature_kind: null,
    signed_verification_method: null,
    consented_at: null,
    status: 'pending',
    client_task_id: null,
    created_at: new Date().toISOString(),
    ...fields,
  };
}

export const esignTables: Record<string, Row[]> = {
  esign_envelopes: [
    envelope({
      id: ENVELOPE_ID,
      title: 'Service agreement',
      status: 'sent',
      sent_at: '2026-10-06T15:00:00Z',
      expires_at: '2026-11-05T15:00:00Z',
      created_at: '2026-10-06T14:50:00Z',
      signers: [
        signer({
          id: ENVELOPE_SIGNER,
          envelope_id: ENVELOPE_ID,
          contact_id: ID.ada,
          email: 'ada@example.test',
          status: 'viewed',
          invited_at: '2026-10-06T15:00:00Z',
          first_viewed_at: '2026-10-07T09:00:00Z',
          created_at: '2026-10-06T14:55:00Z',
          contact: adaAsSigner,
        }),
      ],
    }),
  ],
};

/** The text value of one multipart field. */
function formField(req: FnRequest, name: string): string | null {
  const text = req.body?.toString('latin1') ?? '';
  return new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text)?.[1] ?? null;
}

export const esignFunctions: Record<string, FnHandler> = {
  'esign-create-envelope': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { title: string; verification_level: string; primary_contact_id?: string | null };
    const id = ctx.newId();
    const created_at = new Date().toISOString();
    const contact = ctx.table('contacts').find((c) => c.id === body.primary_contact_id);
    ctx.table('esign_envelopes').push(
      envelope({
        id,
        title: body.title,
        status: 'draft',
        verification_level: body.verification_level,
        primary_contact_id: body.primary_contact_id ?? null,
        primary_contact: contact ? { ...adaAsPrimary, id: contact.id, first_name: contact.first_name, last_name: contact.last_name, email: contact.email, phone: contact.phone } : null,
        created_at,
        updated_at: created_at,
      }),
    );
    return { json: { id, title: body.title, verification_level: body.verification_level, status: 'draft', created_at } };
  },
  'esign-upload-document': (req: FnRequest, ctx: CallContext) => {
    const envelopeId = formField(req, 'envelope_id');
    const fileName = formField(req, 'file_name') ?? 'document.pdf';
    if (!envelopeId) return { status: 400, json: { error: 'invalid_request' } };
    const documentId = ctx.newId();
    const pageId = ctx.newId();
    ctx.table('esign_envelope_documents').push({
      id: documentId,
      envelope_id: envelopeId,
      order: 0,
      file_name: fileName,
      storage_path: `${envelopeId}/${documentId}.pdf`,
      byte_size: req.body?.length ?? 0,
      page_count: 1,
      created_at: new Date().toISOString(),
    });
    ctx.table('esign_envelope_pages').push({ id: pageId, envelope_id: envelopeId, order: 0, source_document_id: documentId, source_page_index: 0, deleted: false });
    return { json: { document: { id: documentId, file_name: fileName, page_count: 1, order: 0 }, pages: [{ id: pageId, order: 0, source_page_index: 0 }] } };
  },
  'esign-manage-signers': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { envelope_id: string; action: string; signer: Row };
    if (body.action !== 'add') return { json: { success: true, signer_id: String(body.signer.signer_id ?? '') } };
    const id = ctx.newId();
    const contactId = (body.signer.contact_id as string | undefined) ?? ID.ada;
    const contact = ctx.table('contacts').find((c) => c.id === contactId);
    ctx.table('esign_envelope_signers').push(
      signer({
        id,
        envelope_id: body.envelope_id,
        contact_id: contactId,
        order: body.signer.order ?? 1,
        role: body.signer.role ?? 'primary',
        email: body.signer.email,
        contact: contact ? { ...adaAsSigner, id: contact.id, first_name: contact.first_name, last_name: contact.last_name, email: contact.email } : null,
      }),
    );
    return { json: { success: true, signer_id: id, contact_id: contactId } };
  },
  'esign-manage-fields': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { envelope_id: string; signer_id: string; fields: Row[] };
    const table = ctx.table('esign_envelope_fields');
    for (let i = table.length - 1; i >= 0; i--) if (table[i].signer_id === body.signer_id) table.splice(i, 1);
    const ids = body.fields.map((f) => {
      const id = ctx.newId();
      table.push({ id, envelope_id: body.envelope_id, signer_id: body.signer_id, required: true, ...f });
      return id;
    });
    return { json: { success: true, count: ids.length, inserted_ids: ids } };
  },
  'esign-send-envelope': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { envelope_id: string };
    const row = ctx.table('esign_envelopes').find((e) => e.id === body.envelope_id);
    if (!row) return { status: 404, json: { error: 'not_found' } };
    const signers = ctx.table('esign_envelope_signers').filter((s) => s.envelope_id === body.envelope_id);
    Object.assign(row, { status: 'sent', sent_at: new Date().toISOString() });
    for (const s of signers) Object.assign(s, { status: 'invited', invited_at: new Date().toISOString() });
    return { json: { ok: true, envelope_id: body.envelope_id, signers_invited: signers.length, failed_emails: [] } };
  },
};
