/**
 * THE e-signature contract between this feature's screens and its edge functions and
 * tables. Every request body, every answer and every row shape the browser relies on is
 * declared here and nowhere else; the api modules (`api.ts` for the owner and the portal,
 * `public/signer/signerApi.ts` for the signer's public pages) send and parse only these.
 *
 * Supabase-free on purpose: the public signer pages import it.
 *
 * Error codes (`EdgeError.code`) the screens branch on:
 *   requires_force            delete-envelope: the envelope is completed; send `force: true`
 *   ambiguous_email           manage-signers: more than one contact uses this address
 *   signer_exists             manage-signers: that address is already on the envelope
 *   send_validation           send-envelope: the envelope is not ready (the message says why)
 *   sms_unavailable           create/send/request-sms: SMS verification is off or not set up
 *   impersonation_read_only   portal-signer-token: the session is View as client
 *   unsupported_characters    signer-sign: the typed signature uses a character the fonts lack
 *   session_required          signer-*: a high-verification step needs a fresh SMS session (401)
 */
import { z } from 'zod';

// ── Enumerations (each mirrors a CHECK in 0006_esign.sql) ─────────────────────

export const ENVELOPE_STATUSES = ['draft', 'sent', 'partially_signed', 'completed', 'voided', 'expired', 'declined'] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const SIGNER_STATUSES = ['pending', 'invited', 'viewed', 'signed', 'expired', 'declined'] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const VERIFICATION_LEVELS = ['standard', 'high'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const FIELD_TYPES = ['signature', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A signer's part. A co-signer links to the primary's contact through its spouse_* fields. */
export const SIGNER_ROLES = ['primary', 'co_signer', 'other'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

/** The roles a template keeps fields for. */
export const TEMPLATE_ROLES = ['primary', 'co_signer'] as const;

export const TEMPLATE_SCOPES = ['primary_only', 'with_co_signer'] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

export const EVENT_TYPES = [
  'envelope_created',
  'envelope_sent',
  'envelope_voided',
  'envelope_expired',
  'invite_sent',
  'invite_resent',
  'email_delivered',
  'email_opened',
  'signer_opened_link',
  'signer_viewed_pdf',
  'sms_code_sent',
  'sms_code_verified',
  'sms_code_failed',
  'signer_signed',
  'envelope_completed',
  'rate_limit_hit',
  'consent_accepted',
  'signer_declined',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What is still WAITING on an envelope (the contact tab's badge counts these, never a total). */
export const PENDING_ENVELOPE_STATUSES: readonly EnvelopeStatus[] = ['draft', 'sent', 'partially_signed'];

/** An envelope that is out for signature: void and resend apply, the detail polls. */
export const LIVE_ENVELOPE_STATUSES: readonly EnvelopeStatus[] = ['sent', 'partially_signed'];

/** A signer whose link is live: resend applies. */
export const RESENDABLE_SIGNER_STATUSES: readonly SignerStatus[] = ['invited', 'viewed'];

export const ENVELOPE_STATUS_LABELS: Record<EnvelopeStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_signed: 'Partially signed',
  completed: 'Completed',
  voided: 'Voided',
  expired: 'Expired',
  declined: 'Declined',
};

export const SIGNER_STATUS_LABELS: Record<SignerStatus, string> = {
  pending: 'Pending',
  invited: 'Invited',
  viewed: 'Viewed',
  signed: 'Signed',
  expired: 'Expired',
  declined: 'Declined',
};

export const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  primary: 'Primary signer',
  co_signer: 'Co-signer',
  other: 'Other',
};

// ── Limits the server enforces too ────────────────────────────────────────────

export const TITLE_MAX = 200;
export const TEMPLATE_NAME_MAX = 120;
export const REASON_MAX = 500;
/** Upload cap for one source PDF (the server's MAX_UPLOAD_BYTES). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
/** A signer phone, as manage-signers accepts it: E.164 only. */
export const E164 = /^\+[1-9]\d{7,14}$/;

// ── Rows the owner reads directly (explicit columns, never `*`) ───────────────

export interface EnvelopeRow {
  id: string;
  created_by: string;
  primary_contact_id: string | null;
  title: string;
  status: EnvelopeStatus;
  verification_level: VerificationLevel;
  source_pdf_sha256: string | null;
  signed_pdf_path: string | null;
  signed_pdf_sha256: string | null;
  void_reason: string | null;
  expires_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ENVELOPE_COLUMNS =
  'id, created_by, primary_contact_id, title, status, verification_level, source_pdf_sha256, signed_pdf_path, ' +
  'signed_pdf_sha256, void_reason, expires_at, sent_at, completed_at, voided_at, created_at, updated_at';

export interface DocumentRow {
  id: string;
  envelope_id: string;
  order: number;
  file_name: string;
  storage_path: string;
  byte_size: number;
  page_count: number;
  created_at: string;
}

export const DOCUMENT_COLUMNS = 'id, envelope_id, order, file_name, storage_path, byte_size, page_count, created_at';

export interface PageRow {
  id: string;
  envelope_id: string;
  order: number;
  source_document_id: string;
  source_page_index: number;
  deleted: boolean;
}

export const PAGE_COLUMNS = 'id, envelope_id, order, source_document_id, source_page_index, deleted';

/**
 * A signer as the owner may read it. The owner's column grant leaves out token_hash,
 * token_expires_at, phone_ciphertext and phone_iv, so selecting `*` fails with 42501; the
 * explicit list below is the only shape the browser ever asks for.
 */
export interface SignerRow {
  id: string;
  envelope_id: string;
  contact_id: string | null;
  order: number;
  role: SignerRole | null;
  email: string;
  phone_last_four: string | null;
  invited_at: string | null;
  opened_email_at: string | null;
  first_viewed_at: string | null;
  signed_at: string | null;
  signed_signature_kind: 'typed' | 'drawn' | null;
  signed_verification_method: 'email' | 'email+sms' | null;
  consented_at: string | null;
  status: SignerStatus;
  client_task_id: string | null;
  created_at: string;
}

export const SIGNER_COLUMNS =
  'id, envelope_id, contact_id, order, role, email, phone_last_four, invited_at, opened_email_at, first_viewed_at, ' +
  'signed_at, signed_signature_kind, signed_verification_method, consented_at, status, client_task_id, created_at';

/** The contact columns a signer row embeds (names, the co-signer link, the CRM stage). */
export interface SignerContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_email: string | null;
}

export const SIGNER_CONTACT_COLUMNS = 'id, first_name, last_name, email, status, spouse_first_name, spouse_last_name, spouse_email';

export interface FieldRow {
  id: string;
  envelope_id: string;
  signer_id: string;
  page_index: number;
  field_type: FieldType;
  /** numeric: PostgREST may send a string; read through Number(). */
  x: number | string;
  y: number | string;
  width: number | string;
  height: number | string;
  required: boolean;
}

export const FIELD_COLUMNS = 'id, envelope_id, signer_id, page_index, field_type, x, y, width, height, required';

export interface EventRow {
  id: string;
  envelope_id: string;
  signer_id: string | null;
  event_type: EventType | string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export const EVENT_COLUMNS = 'id, envelope_id, signer_id, event_type, ip, metadata, created_at';

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  page_count: number;
  created_at: string;
}

export const TEMPLATE_COLUMNS = 'id, name, description, page_count, created_at';

/** app_settings key 'esign'. Absent keys read as the defaults. */
export interface EsignSettings {
  filing_folder: string;
  sms_enabled: boolean;
}

export const ESIGN_SETTINGS_KEY = 'esign';
export const DEFAULT_ESIGN_SETTINGS: EsignSettings = { filing_folder: 'Signed documents', sms_enabled: true };
export const FILING_FOLDER_MAX = 100;

// ── Owner function requests ───────────────────────────────────────────────────

export interface CreateEnvelopeRequest {
  title: string;
  verification_level: VerificationLevel;
  primary_contact_id: string | null;
}

/** manage-signers `signer` body. `signer_id` on update and remove; phone in E.164. */
export interface SignerInput {
  signer_id?: string;
  contact_id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: SignerRole;
  order: number;
}

export interface FieldInput {
  signer_id: string;
  page_index: number;
  field_type: FieldType;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReorderOp {
  page_id: string;
  order?: number;
  deleted?: boolean;
}

// ── Owner function answers ────────────────────────────────────────────────────

export const createEnvelopeAnswer = z.object({ id: z.string() }).passthrough();
export const uploadDocumentAnswer = z
  .object({
    document: z.object({ id: z.string(), page_count: z.number() }).passthrough(),
    pages: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough();
export const okAnswer = z.object({}).passthrough();
export const manageSignerAnswer = z.object({ signer_id: z.string(), contact_id: z.string().nullish() }).passthrough();
export const setFieldsAnswer = z.object({ count: z.number(), inserted_ids: z.array(z.string()) }).passthrough();
export const saveTemplateAnswer = z.object({ template_id: z.string(), field_count: z.number() }).passthrough();
export const applyTemplateAnswer = z
  .object({
    inserted_count: z.number(),
    skipped_count: z.number(),
    template_page_count: z.number(),
    envelope_page_count: z.number(),
  })
  .passthrough();
/** `failed_emails`: invites the provider refused; those signers hold live links and need Resend invite. */
export const sendEnvelopeAnswer = z
  .object({ signers_invited: z.number(), failed_emails: z.array(z.string()).default([]) })
  .passthrough();
export const voidEnvelopeAnswer = z.object({ signers_voided: z.number(), tasks_dismissed: z.number() }).passthrough();

// ── Portal function ───────────────────────────────────────────────────────────

/** The states a signing link (or the portal exchange) can end in before the flow starts. */
export const TERMINAL_STATES = ['expired', 'voided', 'declined', 'co_signer_declined', 'already_signed'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const portalSignerTokenAnswer = z.union([
  z.object({ state: z.literal('ok'), token: z.string().min(1) }),
  z.object({ state: z.enum(TERMINAL_STATES) }),
]);
export type PortalSignerTokenAnswer = z.infer<typeof portalSignerTokenAnswer>;

// ── Public (signer) functions ─────────────────────────────────────────────────

const signerField = z.object({
  id: z.string(),
  page_index: z.number().int().min(0),
  field_type: z.enum(FIELD_TYPES),
  x: z.coerce.number(),
  y: z.coerce.number(),
  width: z.coerce.number(),
  height: z.coerce.number(),
});

/**
 * What the consent copy needs about the sender. Optional: until resolve-token returns it,
 * the page falls back to the public display name and leaves out every line that needs a
 * contact address (never the owner's private login address).
 */
const orgIdentity = z
  .object({
    display_name: z.string().nullish(),
    legal_name: z.string().nullish(),
    contact_email: z.string().nullish(),
    // The port map spells these in camelCase; either spelling is read, snake_case first.
    displayName: z.string().nullish(),
    legalName: z.string().nullish(),
    contactEmail: z.string().nullish(),
  })
  .nullish()
  .transform((o) =>
    o
      ? {
          display_name: o.display_name ?? o.displayName ?? null,
          legal_name: o.legal_name ?? o.legalName ?? null,
          contact_email: o.contact_email ?? o.contactEmail ?? null,
        }
      : null,
  );
export type OrgIdentity = z.output<typeof orgIdentity>;

export const resolvedSigner = z.object({
  state: z.literal('ok'),
  envelope: z.object({
    id: z.string(),
    title: z.string(),
    verification_level: z.enum(VERIFICATION_LEVELS),
    status: z.string(),
  }),
  signer: z.object({
    id: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string(),
    status: z.string(),
    signed_at: z.string().nullable(),
    phone_last_four: z.string().nullable(),
  }),
  document: z.object({ page_count: z.number().int().min(0) }),
  fields: z.array(signerField),
  needs_sms: z.boolean(),
  org: orgIdentity,
});
export type ResolvedSigner = z.infer<typeof resolvedSigner>;

export const resolveTerminal = z.object({
  state: z.enum(TERMINAL_STATES),
  envelope: z.object({ title: z.string() }).partial().nullish(),
  signer: z.object({ first_name: z.string().nullable(), last_name: z.string().nullable(), email: z.string() }).partial().nullish(),
  org: orgIdentity,
});
export type ResolveTerminal = z.infer<typeof resolveTerminal>;

export const resolveTokenAnswer = z.union([resolvedSigner, resolveTerminal]);
export type ResolveTokenAnswer = z.infer<typeof resolveTokenAnswer>;

export const requestSmsAnswer = z.object({ last_four: z.string().nullish() }).passthrough();

export const verifySmsAnswer = z.union([
  z.object({ ok: z.literal(true), session_token: z.string().min(1) }),
  z.object({ ok: z.literal(false), attempts_left: z.number().int().min(0).nullish(), locked: z.boolean().nullish() }),
]);
export type VerifySmsAnswer = z.infer<typeof verifySmsAnswer>;

/** What the signer adopted. A drawn signature has no text and no font. */
export type AdoptedSignature =
  | { kind: 'typed'; signature_text: string; font_key: string }
  | { kind: 'drawn'; image_base64: string };

export interface SignRequest {
  token: string;
  kind: 'typed' | 'drawn';
  signature_text?: string;
  font_key?: string;
  signature_image?: string;
  timezone: string;
  consent: true;
  consent_version: string;
  session_token?: string;
}

export const verifyDocumentAnswer = z.union([
  z.object({
    verified: z.literal(true),
    title: z.string(),
    completed_at: z.string().nullable(),
    sha256: z.string(),
    signers: z.array(z.object({ name: z.string(), status: z.string(), signed_at: z.string().nullable() })).default([]),
  }),
  z.object({ verified: z.literal(false), reason: z.string().nullish(), sha256: z.string().nullish() }),
]);
export type VerifyDocumentAnswer = z.infer<typeof verifyDocumentAnswer>;

/** The edge functions the browser calls, by name (finalize, expire and the webhook are server-only). */
export const FN = {
  createEnvelope: 'esign-create-envelope',
  uploadDocument: 'esign-upload-document',
  manageSigners: 'esign-manage-signers',
  manageFields: 'esign-manage-fields',
  manageTemplates: 'esign-manage-templates',
  reorderPages: 'esign-reorder-pages',
  sendEnvelope: 'esign-send-envelope',
  resendInvite: 'esign-resend-invite',
  voidEnvelope: 'esign-void-envelope',
  deleteEnvelope: 'esign-delete-envelope',
  downloadAudit: 'esign-download-audit',
  portalSignerToken: 'esign-portal-signer-token',
  resolveToken: 'esign-resolve-token',
  viewPdf: 'esign-signer-view-pdf',
  sign: 'esign-signer-sign',
  decline: 'esign-signer-decline',
  requestSms: 'esign-signer-request-sms',
  verifySms: 'esign-signer-verify-sms',
  verifyDocument: 'esign-verify-document',
} as const;
