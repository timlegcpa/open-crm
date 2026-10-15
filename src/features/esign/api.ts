/**
 * Every read and write of the e-signature feature for a SIGNED-IN session: the owner's
 * screens and the portal's signing exchange. The public signer pages never import this
 * module (it reaches supabase-js); they use public/signer/signerApi.ts.
 *
 * The browser writes almost nothing directly. Two owner writes only: the template soft
 * delete and a draft document's delete (both held to the owner, and the document to a
 * draft envelope, by RLS). Everything else goes through an edge function with the service
 * role, so a stolen owner session cannot forge an executed envelope by writing rows.
 *
 * Lists are read in keyset pages on `id` (never a silent 1,000-row cap) and sorted here.
 * Signer rows are always read by an explicit column list: the owner's grant leaves out the
 * token hash and the phone ciphertext, and a `*` would fail.
 */
import { getSupabase } from '@/lib/supabase';
import { invokeEdge, toEdgeError } from '@/lib/edge';
import { EdgeError, edgeErrorFromBody, parseAnswer } from '@/lib/edgeCore';
import { fetchAllPaged, PAGE_SIZE, type PageResult } from '@/lib/pagedFetch';
import { downloadBlob } from '@/lib/download';
import { downloadDocument, fetchDocument, getDocument } from '@/features/documents/api';
import { refOf } from '@/features/documents/types';
import {
  DEFAULT_ESIGN_SETTINGS,
  DOCUMENT_COLUMNS,
  ENVELOPE_COLUMNS,
  ESIGN_SETTINGS_KEY,
  EVENT_COLUMNS,
  FIELD_COLUMNS,
  FILE_NAME_MAX,
  FN,
  PAGE_COLUMNS,
  PENDING_ENVELOPE_STATUSES,
  SIGNER_COLUMNS,
  SIGNER_CONTACT_COLUMNS,
  TEMPLATE_COLUMNS,
  addSignerAnswer,
  applyTemplateAnswer,
  createEnvelopeAnswer,
  deleteEnvelopeAnswer,
  hasErrorCode,
  portalSignerTokenAnswer,
  removeSignerAnswer,
  reorderPagesAnswer,
  resendInviteAnswer,
  saveTemplateAnswer,
  sendEnvelopeAnswer,
  sendValidationError,
  setFieldsAnswer,
  updateSignerAnswer,
  uploadDocumentAnswer,
  voidEnvelopeAnswer,
  type CreateEnvelopeRequest,
  type DocumentRow,
  type EnvelopeRow,
  type EsignSettings,
  type EventRow,
  type FieldInput,
  type FieldRow,
  type PageRow,
  type PortalSignerTokenAnswer,
  type ReorderOp,
  type SignerContact,
  type SignerInput,
  type SignerRow,
  type TemplateRow,
  type TemplateScope,
} from './contract';
import { normalizeFilingFolder, parseFilingFolder } from './lib/filingFolder';
import { esignSafeFilename } from './lib/safeFilename';

// ---------------------------------------------------------------------------
// Paged reads
// ---------------------------------------------------------------------------

// The builder methods this module chains; supabase-js's own type is far wider.
interface PagedQuery {
  eq(column: string, value: unknown): PagedQuery;
  in(column: string, values: readonly unknown[]): PagedQuery;
  is(column: string, value: null): PagedQuery;
  gt(column: string, value: unknown): PagedQuery;
  order(column: string, options?: { ascending?: boolean }): PagedQuery;
  limit(n: number): PromiseLike<PageResult<never>>;
}

function readAll<T extends { id: string }>(table: string, columns: string, filter: (q: PagedQuery) => PagedQuery): Promise<T[]> {
  return fetchAllPaged<T>((afterId) => {
    let query = filter(getSupabase().from(table).select(columns) as unknown as PagedQuery);
    if (afterId) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(PAGE_SIZE) as PromiseLike<PageResult<T>>;
  });
}

const tieId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newestFirst = <T extends { id: string; created_at: string }>(a: T, b: T) =>
  a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : tieId(a, b);
const byOrder = <T extends { id: string; order: number }>(a: T, b: T) => a.order - b.order || tieId(a, b);

/** PostgREST returns a to-one embed as an object or as a one-element array; read either. */
function one<T>(raw: unknown): T | null {
  if (Array.isArray(raw)) return (raw[0] as T | undefined) ?? null;
  return (raw as T | null | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface EnvelopeListRow extends EnvelopeRow {
  signer_count: number;
}

/** Every envelope, or those in one status, newest first. */
export async function listEnvelopes(status: string): Promise<EnvelopeListRow[]> {
  const rows = await readAll<EnvelopeRow & { signers?: unknown }>(
    'esign_envelopes',
    `${ENVELOPE_COLUMNS}, signers:esign_envelope_signers(count)`,
    (q) => (status === 'all' ? q : q.eq('status', status)),
  );
  return rows
    .map(({ signers, ...row }) => ({ ...row, signer_count: one<{ count: number }>(signers)?.count ?? 0 }))
    .sort(newestFirst);
}

export interface SignerWithContact extends SignerRow {
  contact: SignerContact | null;
}

export interface ContactEnvelope extends EnvelopeRow {
  signers: SignerWithContact[];
}

/** The envelopes whose primary contact is this contact, newest first, with their signers. */
export async function listEnvelopesForContact(contactId: string): Promise<ContactEnvelope[]> {
  const rows = await readAll<EnvelopeRow & { signers?: unknown }>(
    'esign_envelopes',
    `${ENVELOPE_COLUMNS}, signers:esign_envelope_signers(${SIGNER_COLUMNS}, contact:contacts(${SIGNER_CONTACT_COLUMNS}))`,
    (q) => q.eq('primary_contact_id', contactId),
  );
  return rows
    .map(({ signers, ...row }) => ({
      ...row,
      signers: (Array.isArray(signers) ? signers : [])
        .map((s: SignerRow & { contact?: unknown }) => ({ ...s, contact: one<SignerContact>(s.contact) }))
        .sort(byOrder),
    }))
    .sort(newestFirst);
}

/** What is WAITING on this contact: its envelopes still in draft or out for signature. */
export async function countPendingForContact(contactId: string): Promise<number> {
  const { count, error } = await getSupabase()
    .from('esign_envelopes')
    .select('id', { count: 'exact', head: true })
    .eq('primary_contact_id', contactId)
    .in('status', [...PENDING_ENVELOPE_STATUSES]);
  if (error) throw error;
  return count ?? 0;
}

export interface EnvelopePrimaryContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_email: string | null;
  spouse_phone: string | null;
}

export interface EnvelopeWithContact extends EnvelopeRow {
  /** Embedded so the signers step can offer "add this person" without a second request. */
  primary_contact: EnvelopePrimaryContact | null;
}

/** One envelope, or null when it is gone. */
export async function getEnvelope(id: string): Promise<EnvelopeWithContact | null> {
  const { data, error } = await getSupabase()
    .from('esign_envelopes')
    .select(
      `${ENVELOPE_COLUMNS}, primary_contact:contacts(id, first_name, last_name, email, phone, spouse_first_name, spouse_last_name, spouse_email, spouse_phone)`,
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as EnvelopeRow & { primary_contact?: unknown };
  return { ...row, primary_contact: one<EnvelopePrimaryContact>(row.primary_contact) };
}

export async function getDocuments(envelopeId: string): Promise<DocumentRow[]> {
  const rows = await readAll<DocumentRow>('esign_envelope_documents', DOCUMENT_COLUMNS, (q) => q.eq('envelope_id', envelopeId));
  return rows.sort(byOrder);
}

/** Every page row, deleted ones included (the reorder keeps them), by order. */
export async function getPages(envelopeId: string): Promise<PageRow[]> {
  const rows = await readAll<PageRow>('esign_envelope_pages', PAGE_COLUMNS, (q) => q.eq('envelope_id', envelopeId));
  return rows.sort(byOrder);
}

export async function getSigners(envelopeId: string): Promise<SignerWithContact[]> {
  const rows = await readAll<SignerRow & { contact?: unknown }>(
    'esign_envelope_signers',
    `${SIGNER_COLUMNS}, contact:contacts(${SIGNER_CONTACT_COLUMNS})`,
    (q) => q.eq('envelope_id', envelopeId),
  );
  return rows.map((s) => ({ ...s, contact: one<SignerContact>(s.contact) })).sort(byOrder);
}

export async function getFields(envelopeId: string): Promise<FieldRow[]> {
  return readAll<FieldRow>('esign_envelope_fields', FIELD_COLUMNS, (q) => q.eq('envelope_id', envelopeId));
}

export interface EventWithSigner extends EventRow {
  signer: { id: string; email: string; role: string | null; contact: SignerContact | null } | null;
}

/** The envelope's whole event log, newest first. */
export async function getEvents(envelopeId: string): Promise<EventWithSigner[]> {
  const rows = await readAll<EventRow & { signer?: unknown }>(
    'esign_envelope_events',
    `${EVENT_COLUMNS}, signer:esign_envelope_signers(id, email, role, contact:contacts(${SIGNER_CONTACT_COLUMNS}))`,
    (q) => q.eq('envelope_id', envelopeId),
  );
  return rows
    .map((e) => {
      const signer = one<{ id: string; email: string; role: string | null; contact?: unknown }>(e.signer);
      return { ...e, signer: signer ? { ...signer, contact: one<SignerContact>(signer.contact) } : null };
    })
    .sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Envelope writes (edge functions)
// ---------------------------------------------------------------------------

export function createEnvelope(input: CreateEnvelopeRequest) {
  return invokeEdge(FN.createEnvelope, { ...input }, { parse: (d) => createEnvelopeAnswer.parse(d) });
}

/**
 * One source PDF into a draft envelope, as multipart: base64 inside JSON made the worker
 * hold four copies of a large file at once, and a 20 MB PDF killed it.
 */
export function uploadDocument(envelopeId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  form.append('envelope_id', envelopeId);
  form.append('file_name', fitFileName(file.name));
  return invokeEdge(FN.uploadDocument, form, { parse: (d) => uploadDocumentAnswer.parse(d) });
}

/**
 * A file name upload-document accepts: control characters out (as its stripControl does),
 * at most FILE_NAME_MAX characters, the extension kept when it has to be shortened. A
 * stored document's name may be up to 255 characters, so one sent from the documents
 * viewer can need this.
 */
export function fitFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() || 'document.pdf';
  if (clean.length <= FILE_NAME_MAX) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, FILE_NAME_MAX - ext.length).trimEnd() + ext;
}

/**
 * A document already filed for a contact, as a source of a draft envelope: its bytes are
 * read through the documents feature (decrypted on the server when stored encrypted) and
 * uploaded like any other PDF, so the same server checks apply.
 */
export async function importStoredDocument(envelopeId: string, documentId: string): Promise<void> {
  const doc = await getDocument(documentId);
  if (!doc) throw new Error('That document could not be found. It may have been removed.');
  if (doc.mime_type !== 'application/pdf') throw new Error('Only a PDF can be sent for signature.');
  const got = await fetchDocument(refOf(doc), 'download');
  let blob: Blob;
  if (got.kind === 'bytes') {
    blob = got.blob;
  } else {
    const res = await fetch(got.url);
    // An expired link answers with an error page; never upload that as the document.
    if (!res.ok) throw new Error('The document could not be read. Try again.');
    blob = await res.blob();
  }
  // upload-document checks the part's type, the %PDF bytes and a name of at most 200 characters.
  await uploadDocument(envelopeId, new File([blob], fitFileName(doc.original_filename), { type: 'application/pdf' }));
}

/** Reorder or delete pages. The server remaps every field's page index in the same call. */
export function reorderPages(envelopeId: string, operations: ReorderOp[]) {
  return invokeEdge(FN.reorderPages, { envelope_id: envelopeId, operations }, { parse: (d) => reorderPagesAnswer.parse(d) });
}

/**
 * Delete a draft envelope's document. The server does all of it in one call: retires the
 * document's pages (fields point at pages by POSITION, so every later field moves up and
 * the ones on its pages go), deletes the row, and removes the working object. The browser
 * never removes a storage object itself (clientDocumentsStorageDeleteGuard.test.ts).
 */
export async function deleteEnvelopeDocument(envelopeId: string, doc: Pick<DocumentRow, 'id'>): Promise<void> {
  await invokeEdge(
    FN.reorderPages,
    { action: 'delete_document', envelope_id: envelopeId, document_id: doc.id },
    { parse: (d) => reorderPagesAnswer.parse(d) },
  );
}

export type ManageSignerAction = 'add' | 'update' | 'remove';

/** Each action answers its own shape: add links a contact, update names the signer, remove says only success. */
const SIGNER_ANSWERS = { add: addSignerAnswer, update: updateSignerAnswer, remove: removeSignerAnswer } as const;

export function manageSigner(envelopeId: string, action: ManageSignerAction, signer: SignerInput) {
  return invokeEdge(FN.manageSigners, { envelope_id: envelopeId, action, signer: { ...signer } }, { parse: (d) => SIGNER_ANSWERS[action].parse(d) });
}

/** Replace ONE signer's fields. Every save rotates the ids; `inserted_ids` come back in input order. */
export function setSignerFields(envelopeId: string, signerId: string, fields: FieldInput[]) {
  return invokeEdge(
    FN.manageFields,
    { envelope_id: envelopeId, action: 'set', signer_id: signerId, fields },
    { parse: (d) => setFieldsAnswer.parse(d) },
  );
}

/**
 * send-envelope's refusal when the draft is not ready: an EdgeError (code
 * `validation_failed`) that also carries every problem the server found, for the page to list.
 */
export class SendNotReadyError extends EdgeError {
  readonly problems: string[];
  constructor(base: EdgeError, problems: string[]) {
    super(base.kind, { status: base.status, code: base.code, message: base.message });
    this.problems = problems;
  }
}

/**
 * Send: the server re-checks everything, assembles the PDF and emails each signer a link.
 * Called through functions.invoke directly (not invokeEdge) so the 400's `validation` list,
 * which an EdgeError does not keep, can be read from the response first.
 */
export async function sendEnvelope(envelopeId: string) {
  let result: { data: unknown; error: unknown };
  try {
    result = await getSupabase().functions.invoke(FN.sendEnvelope, { body: { envelope_id: envelopeId }, method: 'POST' });
  } catch (err) {
    throw await toEdgeError(err);
  }
  if (result.error) {
    const context = (result.error as { context?: unknown }).context as { status?: unknown; clone?: unknown } | undefined;
    if (context && context.status === 400 && typeof context.clone === 'function') {
      let body: unknown = null;
      try {
        body = JSON.parse(await (context.clone as () => { text(): Promise<string> })().text());
      } catch {
        body = null;
      }
      const notReady = sendValidationError.safeParse(body);
      if (notReady.success) throw new SendNotReadyError(edgeErrorFromBody(400, body), notReady.data.validation);
    }
    throw await toEdgeError(result.error);
  }
  return parseAnswer(result.data, (d) => sendEnvelopeAnswer.parse(d));
}

export function voidEnvelope(envelopeId: string, reason: string | undefined) {
  return invokeEdge(
    FN.voidEnvelope,
    { envelope_id: envelopeId, ...(reason ? { void_reason: reason } : {}) },
    { parse: (d) => voidEnvelopeAnswer.parse(d) },
  );
}

export function resendInvite(envelopeId: string, signerId: string) {
  return invokeEdge(FN.resendInvite, { envelope_id: envelopeId, signer_id: signerId }, { parse: (d) => resendInviteAnswer.parse(d) });
}

/**
 * Delete an envelope. A completed one needs `force`: the server first keeps its hash and
 * audit trail in a tombstone, so the public verifier still recognises the signed copy.
 * Without `force` it answers 409 `requires_force` and removes nothing.
 */
export function deleteEnvelope(envelopeId: string, force: boolean) {
  return invokeEdge(FN.deleteEnvelope, { envelope_id: envelopeId, force }, { parse: (d) => deleteEnvelopeAnswer.parse(d) });
}

export function isRequiresForce(err: unknown): boolean {
  return hasErrorCode(err, 'requires_force');
}

/** The audit trail as a PDF, rendered on demand. */
export async function downloadAudit(envelope: Pick<EnvelopeRow, 'id' | 'title'>): Promise<void> {
  const data = await invokeEdge<unknown>(FN.downloadAudit, { envelope_id: envelope.id });
  if (!(data instanceof Blob)) throw new Error('The audit file did not arrive. Try again.');
  downloadBlob(new Blob([data], { type: 'application/pdf' }), `${esignSafeFilename(envelope.title)}_audit.pdf`);
}

/**
 * The executed PDF, exactly where finalize put it: one object in the documents store, filed
 * as a documents row (carrying esign_envelope_id) for each signer's contact. Any of those
 * rows opens the same object, so the first is read through the documents feature, which
 * logs the download and serves the plaintext copy by a short signed link.
 */
export async function downloadSignedCopy(envelope: Pick<EnvelopeRow, 'id' | 'signed_pdf_path'>): Promise<void> {
  if (!envelope.signed_pdf_path) throw new Error('This envelope has no signed copy yet.');
  const { data, error } = await getSupabase()
    .from('client_documents')
    .select('id, original_filename, mime_type')
    .eq('esign_envelope_id', envelope.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const filed = data as { id: string; original_filename: string; mime_type: string } | null;
  if (!filed) throw new Error('The signed copy is not filed in any contact’s documents yet. Try again in a minute.');
  await downloadDocument(refOf(filed));
}

/**
 * Short-lived links to a draft's working PDFs, for the page thumbnails and the field
 * placer (pdf.js fetches them). Thirty minutes covers a composing session; a path that
 * cannot be signed is left out, and its pages show as not loaded.
 */
export async function signWorkingUrls(paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (paths.length === 0) return out;
  const { data, error } = await getSupabase().storage.from('esign-working').createSignedUrls([...paths], 60 * 30);
  if (error) throw error;
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) out[entry.path] = entry.signedUrl;
  }
  return out;
}

/** A stub signer's contact joins the pipeline as a new lead. */
export async function moveContactToNew(contactId: string): Promise<void> {
  const { data, error } = await getSupabase().from('contacts').update({ status: 'new_lead' }).eq('id', contactId).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('The contact was not moved. It may have been removed.');
}

/**
 * Contacts matching an address in their own email or their spouse email (two rows at most
 * per column: a second match is all it takes to call it ambiguous). LIKE wildcards in the
 * address are escaped by the caller.
 */
export async function findContactsByEmail(pattern: string) {
  const supabase = getSupabase();
  const [byEmail, bySpouse] = await Promise.all([
    supabase.from('contacts').select('id, first_name, last_name').ilike('email', pattern).limit(2),
    supabase.from('contacts').select('id, first_name, last_name, spouse_first_name, spouse_last_name').ilike('spouse_email', pattern).limit(2),
  ]);
  if (byEmail.error) throw byEmail.error;
  if (bySpouse.error) throw bySpouse.error;
  return {
    byEmail: (byEmail.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>,
    bySpouse: (bySpouse.data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      spouse_first_name: string | null;
      spouse_last_name: string | null;
    }>,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = await readAll<TemplateRow>('esign_templates', TEMPLATE_COLUMNS, (q) => q.is('deleted_at', null));
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || tieId(a, b));
}

export function saveTemplateFromEnvelope(input: { envelope_id: string; name: string; description?: string }) {
  return invokeEdge(FN.manageTemplates, { action: 'save_from_envelope', ...input }, { parse: (d) => saveTemplateAnswer.parse(d) });
}

export function applyTemplateToEnvelope(input: { envelope_id: string; template_id: string; scope: TemplateScope }) {
  return invokeEdge(FN.manageTemplates, { action: 'apply_to_envelope', ...input }, { parse: (d) => applyTemplateAnswer.parse(d) });
}

/** The one template write the owner makes directly (the grant allows only deleted_at). */
export async function softDeleteTemplate(templateId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from('esign_templates')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', templateId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('The template was not deleted. It may already be gone.');
}

// ---------------------------------------------------------------------------
// Settings (app_settings key 'esign')
// ---------------------------------------------------------------------------

/** The filing folder and the SMS switch; a missing row or key reads as the default. */
export async function getEsignSettings(): Promise<EsignSettings> {
  const { data, error } = await getSupabase().from('app_settings').select('value').eq('key', ESIGN_SETTINGS_KEY).maybeSingle();
  if (error) throw error;
  const value = (data as { value?: Record<string, unknown> } | null)?.value ?? {};
  // Read exactly as the server reads it (lib/settings.ts): a folder it would refuse is the
  // default there, so it shows as the default here; only an explicit false turns SMS off.
  const folder = typeof value.filing_folder === 'string' ? parseFilingFolder(value.filing_folder) : null;
  return {
    filing_folder: folder ? folder.join('/') : DEFAULT_ESIGN_SETTINGS.filing_folder,
    sms_enabled: value.sms_enabled !== false,
  };
}

export async function saveEsignSettings(next: EsignSettings): Promise<void> {
  const supabase = getSupabase();
  const value = { filing_folder: normalizeFilingFolder(next.filing_folder), sms_enabled: next.sms_enabled };
  const { data, error } = await supabase.from('app_settings').update({ value }).eq('key', ESIGN_SETTINGS_KEY).select('key');
  if (error) throw error;
  if (data && data.length > 0) return;
  const { error: insertError } = await supabase.from('app_settings').insert({ key: ESIGN_SETTINGS_KEY, value });
  if (insertError) throw insertError;
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

export interface SignatureTask {
  id: string;
  title: string;
  link: string | null;
  created_at: string;
}

/** The signed-in client's pending signature requests, oldest first. */
export async function listMySignatureTasks(contactId: string): Promise<SignatureTask[]> {
  const rows = await readAll<SignatureTask>('client_tasks', 'id, title, link, created_at', (q) =>
    q.eq('contact_id', contactId).eq('type', 'esign').eq('status', 'pending'),
  );
  return rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : tieId(a, b)));
}

/**
 * The portal's signing exchange: the session for a fresh signing token, for the signer row
 * addressed to the signed-in email. Refused (403 `impersonation_read_only`) during View as
 * client, before the server touches anything.
 */
export function exchangePortalSignerToken(signerId: string): Promise<PortalSignerTokenAnswer> {
  return invokeEdge(FN.portalSignerToken, { signer_id: signerId }, { parse: (d) => portalSignerTokenAnswer.parse(d) });
}
