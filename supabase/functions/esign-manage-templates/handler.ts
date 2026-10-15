// esign-manage-templates: reusable field layouts. Owner only. (Listing templates and
// deleting one are plain reads and a soft delete the owner's session does directly.)
//
//   save_from_envelope  copies the primary signer's and the co-signer's boxes of an
//                       envelope into a new template (other signers' boxes are not
//                       templated: the template knows two roles).
//   apply_to_envelope   adds a template's boxes to a draft: primary boxes to the first
//                       primary signer, co-signer boxes to the first co-signer when the
//                       scope is with_co_signer. Boxes on pages the envelope does not have
//                       are skipped and counted.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { maybeOne, pgCode, rows, run, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, notDraft, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';

export type ManageTemplatesRequest =
  | { action: 'save_from_envelope'; envelope_id: string; name: string; description?: string }
  | { action: 'apply_to_envelope'; envelope_id: string; template_id: string; scope?: 'primary_only' | 'with_co_signer' };

export type ManageTemplatesResponse =
  | { success: true; template_id: string; field_count: number }
  | { success: true; inserted_count: number; skipped_count: number; template_page_count: number; envelope_page_count: number };

export const MANAGE_TEMPLATES_ERRORS = [
  'bad_request',
  'invalid_name',
  'no_template_fields',
  'too_many_fields',
  'no_pages',
  'duplicate_name',
  'template_not_found',
  'primary_signer_required',
  'co_signer_required',
  'nothing_to_apply',
  'not_found',
  'not_draft',
] as const;

export const MAX_NAME_LEN = 120;
export const MAX_DESC_LEN = 500;
export const MAX_FIELDS_PER_TEMPLATE = 400;

export interface ManageTemplatesDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  logSink?: LogSink;
}

interface FieldRow {
  signer_id: string;
  page_index: number;
  field_type: 'signature' | 'date';
  x: number;
  y: number;
  width: number;
  height: number;
}

const TEMPLATE_ROLES = new Set(['primary', 'co_signer']);

export function createManageTemplatesHandler(deps: ManageTemplatesDeps): (req: Request) => Promise<Response> {
  const { db } = deps;

  async function livePageCount(envelopeId: string): Promise<number> {
    const pages = await rows<{ deleted: boolean }>('page read', db.from('esign_envelope_pages').select('id, deleted').eq('envelope_id', envelopeId));
    return pages.filter((p) => !p.deleted).length;
  }

  async function save(principalId: string, b: Record<string, unknown>) {
    const name = typeof b.name === 'string' ? stripControl(b.name) : '';
    const description = typeof b.description === 'string' ? stripControl(b.description) : '';
    if (!isUuid(b.envelope_id)) throw badRequest();
    if (!name || name.length > MAX_NAME_LEN) throw badRequest('Give the template a name of 1 to 120 characters.', 'invalid_name');
    if (description.length > MAX_DESC_LEN) throw badRequest('The description can be up to 500 characters.', 'invalid_name');

    const envelope = await maybeOne('envelope read', db.from('esign_envelopes').select('id').eq('id', b.envelope_id).maybeSingle());
    if (!envelope) throw envelopeNotFound();
    const [signers, fields] = await Promise.all([
      rows<{ id: string; role: string }>('signer read', db.from('esign_envelope_signers').select('id, role').eq('envelope_id', b.envelope_id)),
      rows<FieldRow>(
        'field read',
        db.from('esign_envelope_fields').select('signer_id, page_index, field_type, x, y, width, height').eq('envelope_id', b.envelope_id),
      ),
    ]);
    const roleOf = new Map(signers.map((s) => [s.id, s.role]));
    const templateRows = fields
      .filter((f) => TEMPLATE_ROLES.has(roleOf.get(f.signer_id) ?? ''))
      .map((f) => ({
        role: roleOf.get(f.signer_id) as string,
        page_index: f.page_index,
        field_type: f.field_type,
        x: Number(f.x),
        y: Number(f.y),
        width: Number(f.width),
        height: Number(f.height),
      }));
    if (templateRows.length === 0) {
      throw badRequest('There are no primary signer or co-signer fields to save. Place fields for one of them first.', 'no_template_fields');
    }
    if (templateRows.length > MAX_FIELDS_PER_TEMPLATE) throw badRequest('A template can hold at most 400 fields.', 'too_many_fields');
    const pageCount = await livePageCount(b.envelope_id as string);
    if (pageCount === 0) throw badRequest('This envelope has no pages.', 'no_pages');

    const created = await db
      .from('esign_templates')
      .insert({ name, description: description || null, page_count: pageCount, created_by: principalId })
      .select('id')
      .single();
    if (created.error) {
      if (pgCode(created.error) === '23505') throw new HttpError(409, 'A template with that name already exists.', 'duplicate_name');
      throw created.error;
    }
    const templateId = (created.data as { id: string }).id;
    const inserted = await db.from('esign_template_fields').insert(templateRows.map((r) => ({ ...r, template_id: templateId })));
    if (inserted.error) {
      // Take the template back out, so a retry does not collide with its name.
      await run('template rollback', db.from('esign_templates').delete().eq('id', templateId));
      throw inserted.error;
    }
    return { success: true as const, template_id: templateId, field_count: templateRows.length };
  }

  async function apply(b: Record<string, unknown>) {
    if (!isUuid(b.envelope_id) || !isUuid(b.template_id)) throw badRequest();
    const scope = b.scope === 'with_co_signer' ? 'with_co_signer' : 'primary_only';
    const envelope = await maybeOne<{ status: string }>(
      'envelope read',
      db.from('esign_envelopes').select('id, status').eq('id', b.envelope_id).maybeSingle(),
    );
    if (!envelope) throw envelopeNotFound();
    if (envelope.status !== 'draft') throw notDraft();

    const [template, templateFields, signers, envelopePages] = await Promise.all([
      maybeOne<{ page_count: number; deleted_at: string | null }>(
        'template read',
        db.from('esign_templates').select('id, page_count, deleted_at').eq('id', b.template_id).maybeSingle(),
      ),
      rows<Omit<FieldRow, 'signer_id'> & { role: string }>(
        'template field read',
        db.from('esign_template_fields').select('role, page_index, field_type, x, y, width, height').eq('template_id', b.template_id),
      ),
      rows<{ id: string; role: string; order: number }>(
        'signer read',
        db.from('esign_envelope_signers').select('id, role, order').eq('envelope_id', b.envelope_id).order('order').order('id'),
      ),
      livePageCount(b.envelope_id as string),
    ]);
    if (!template || template.deleted_at) throw new HttpError(404, 'That template no longer exists.', 'template_not_found');

    const firstOf = (role: string) => signers.find((s) => s.role === role)?.id;
    const primaryId = firstOf('primary');
    if (!primaryId) throw badRequest('Add a primary signer before applying a template.', 'primary_signer_required');
    const coSignerId = scope === 'with_co_signer' ? firstOf('co_signer') : undefined;
    if (scope === 'with_co_signer' && !coSignerId) throw badRequest('Add a co-signer before applying the template with a co-signer.', 'co_signer_required');
    if (envelopePages === 0) throw badRequest('This envelope has no pages.', 'no_pages');

    let skipped = 0;
    const toInsert: Array<Record<string, unknown>> = [];
    for (const f of templateFields) {
      const signerId = f.role === 'primary' ? primaryId : f.role === 'co_signer' ? coSignerId : undefined;
      if (!signerId || f.page_index > envelopePages - 1) {
        skipped += 1;
        continue;
      }
      toInsert.push({
        envelope_id: b.envelope_id,
        signer_id: signerId,
        page_index: f.page_index,
        field_type: f.field_type,
        x: Number(f.x),
        y: Number(f.y),
        width: Number(f.width),
        height: Number(f.height),
        required: true,
      });
    }
    if (toInsert.length === 0) {
      throw badRequest(`The template has no fields for this scope and these pages (${skipped} skipped).`, 'nothing_to_apply');
    }
    await run('field insert', db.from('esign_envelope_fields').insert(toInsert));
    return {
      success: true as const,
      inserted_count: toInsert.length,
      skipped_count: skipped,
      template_page_count: template.page_count,
      envelope_page_count: envelopePages,
    };
  }

  return createHandler({
    name: 'esign-manage-templates',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 65_536,
    logSink: deps.logSink,
    async handle({ principal, body, json }) {
      const b = objectBody(body);
      if (b.action === 'save_from_envelope') return json(200, (await save(principal.userId, b)) satisfies ManageTemplatesResponse);
      if (b.action === 'apply_to_envelope') return json(200, (await apply(b)) satisfies ManageTemplatesResponse);
      throw badRequest();
    },
  });
}
