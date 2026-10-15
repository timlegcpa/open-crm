/**
 * THE e-signature contract between this feature's screens and its edge functions and
 * tables. Every request body, every answer and every error code the browser relies on is
 * declared here and nowhere else; the api modules (`api.ts` for the owner and the portal,
 * `public/signer/signerApi.ts` for the signer's public pages) send and parse only these.
 *
 * The server is the source of the function shapes: the request and answer types below are
 * IMPORTED from each function's handler.ts (type-only imports, erased at build, so no
 * server code reaches a bundle). The zod schemas parse an answer at runtime and are typed
 * against those imports, so a server change the page would misread fails typecheck.
 * Error codes come the same way: `EsignErrorCode` is the union of every function's
 * exported *_ERRORS list and the shared handler's refusals, and `hasErrorCode` takes only
 * a member of it. contract.test.ts reads the lists at runtime, checks every code the
 * screens name, and checks that every function the screens call exists.
 *
 * Supabase-free on purpose: the public signer pages import it.
 */
import { z } from 'zod';
import { isEdgeError } from '@/lib/edgeCore';
import type { REFUSALS } from '../../../supabase/functions/_shared/handler';
import type { CREATE_ENVELOPE_ERRORS, CreateEnvelopeRequest, CreateEnvelopeResponse } from '../../../supabase/functions/esign-create-envelope/handler';
import type { DELETE_ENVELOPE_ERRORS, DeleteEnvelopeRequest, DeleteEnvelopeResponse } from '../../../supabase/functions/esign-delete-envelope/handler';
import type { DOWNLOAD_AUDIT_ERRORS, DownloadAuditRequest } from '../../../supabase/functions/esign-download-audit/handler';
import type { EventType } from '../../../supabase/functions/esign-finalize-envelope/lib/events';
import type { TerminalState } from '../../../supabase/functions/esign-finalize-envelope/lib/signer-flow';
import type {
  FieldInput as ServerFieldInput,
  MANAGE_FIELDS_ERRORS,
  ManageFieldsRequest,
  ManageFieldsResponse,
} from '../../../supabase/functions/esign-manage-fields/handler';
import type { MANAGE_SIGNERS_ERRORS, ManageSignersRequest } from '../../../supabase/functions/esign-manage-signers/handler';
import type { MANAGE_TEMPLATES_ERRORS, ManageTemplatesRequest, ManageTemplatesResponse } from '../../../supabase/functions/esign-manage-templates/handler';
import type {
  PORTAL_SIGNER_TOKEN_ERRORS,
  PortalSignerTokenRequest,
  PortalSignerTokenResponse,
} from '../../../supabase/functions/esign-portal-signer-token/handler';
import type { REORDER_PAGES_ERRORS, ReorderPagesRequest, ReorderPagesResponse } from '../../../supabase/functions/esign-reorder-pages/handler';
import type { RESEND_INVITE_ERRORS, ResendInviteRequest, ResendInviteResponse } from '../../../supabase/functions/esign-resend-invite/handler';
import type { RESOLVE_TOKEN_ERRORS, ResolveTokenRequest, ResolveTokenResponse } from '../../../supabase/functions/esign-resolve-token/handler';
import type {
  SEND_ENVELOPE_ERRORS,
  SendEnvelopeRequest,
  SendEnvelopeResponse,
  SendValidationError,
} from '../../../supabase/functions/esign-send-envelope/handler';
import type { SIGNER_DECLINE_ERRORS, SignerDeclineRequest, SignerDeclineResponse } from '../../../supabase/functions/esign-signer-decline/handler';
import type {
  SIGNER_REQUEST_SMS_ERRORS,
  SignerRequestSmsRequest,
  SignerRequestSmsResponse,
} from '../../../supabase/functions/esign-signer-request-sms/handler';
import type { SIGNER_SIGN_ERRORS, SignerSignRequest, SignerSignResponse } from '../../../supabase/functions/esign-signer-sign/handler';
import type {
  SIGNER_VERIFY_SMS_ERRORS,
  SignerVerifySmsRequest,
  SignerVerifySmsResponse,
} from '../../../supabase/functions/esign-signer-verify-sms/handler';
import type { SIGNER_VIEW_PDF_ERRORS, SignerViewPdfRequest } from '../../../supabase/functions/esign-signer-view-pdf/handler';
import type { UPLOAD_DOCUMENT_ERRORS, UploadDocumentResponse } from '../../../supabase/functions/esign-upload-document/handler';
import type { VERIFY_DOCUMENT_ERRORS, VerifyDocumentRequest, VerifyDocumentResponse } from '../../../supabase/functions/esign-verify-document/handler';
import type { VOID_ENVELOPE_ERRORS, VoidEnvelopeRequest, VoidEnvelopeResponse } from '../../../supabase/functions/esign-void-envelope/handler';

/** A zod schema whose parsed value is exactly the server's type. */
type Answer<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** Compile time: the list names every member of the union (and, typed U[], nothing else). */
type Covers<L extends readonly string[], U extends string> = [Exclude<U, L[number]>] extends [never] ? L : never;
function allOf<U extends string>() {
  return <const L extends readonly U[]>(list: Covers<L, U>): L => list;
}

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

/** The server's event types (lib/events.ts), every one of them: the compiler checks the list. */
export const EVENT_TYPES = allOf<EventType>()([
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
]);
export type { EventType };

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
/** upload-document refuses a file name longer than this. */
export const FILE_NAME_MAX = 200;
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

/**
 * app_settings key 'esign', as the server's lib/settings.ts reads it. Absent keys read as
 * the defaults; a filing folder the server would refuse files to the default instead.
 */
export interface EsignSettings {
  filing_folder: string;
  sms_enabled: boolean;
}

export const ESIGN_SETTINGS_KEY = 'esign';
export const DEFAULT_ESIGN_SETTINGS: EsignSettings = { filing_folder: 'Signed documents', sms_enabled: true };
/** The whole folder path's length cap (the server's folder_path limit, less its two slashes). */
export const FILING_FOLDER_MAX = 198;

// ── Function requests (the server's types) ────────────────────────────────────

export type { CreateEnvelopeRequest, DeleteEnvelopeRequest, DownloadAuditRequest, ResendInviteRequest, SendEnvelopeRequest, VoidEnvelopeRequest };
export type { ManageFieldsRequest, ManageSignersRequest, ManageTemplatesRequest, PortalSignerTokenRequest, ReorderPagesRequest };
export type { ResolveTokenRequest, SignerDeclineRequest, SignerRequestSmsRequest, SignerSignRequest, SignerVerifySmsRequest, SignerViewPdfRequest };
export type { VerifyDocumentRequest };

/** manage-signers `signer` body. `signer_id` on update and remove; phone in E.164. */
export type SignerInput = ManageSignersRequest['signer'];
export type FieldInput = ServerFieldInput;
export type ReorderOp = Extract<ReorderPagesRequest, { operations: unknown }>['operations'][number];

// ── Owner function answers ────────────────────────────────────────────────────

export const createEnvelopeAnswer: Answer<CreateEnvelopeResponse> = z.object({
  id: z.string(),
  title: z.string(),
  verification_level: z.enum(VERIFICATION_LEVELS),
  status: z.literal('draft'),
  created_at: z.string(),
});

export const uploadDocumentAnswer: Answer<UploadDocumentResponse> = z.object({
  document: z.object({ id: z.string(), file_name: z.string(), page_count: z.number(), order: z.number() }),
  pages: z.array(z.object({ id: z.string(), order: z.number(), source_page_index: z.number() })),
});

export const reorderPagesAnswer: Answer<ReorderPagesResponse> = z.object({ ok: z.literal(true) });

/** manage-signers answers per action: add links a contact, update names the signer, remove says only success. */
export const addSignerAnswer = z.object({ success: z.literal(true), signer_id: z.string(), contact_id: z.string() });
export const updateSignerAnswer = z.object({ success: z.literal(true), signer_id: z.string() });
export const removeSignerAnswer = z.object({ success: z.literal(true) });

export const setFieldsAnswer: Answer<Extract<ManageFieldsResponse, { count: number }>> = z.object({
  success: z.literal(true),
  count: z.number(),
  inserted_ids: z.array(z.string()),
});

export const saveTemplateAnswer: Answer<Extract<ManageTemplatesResponse, { template_id: string }>> = z.object({
  success: z.literal(true),
  template_id: z.string(),
  field_count: z.number(),
});

export const applyTemplateAnswer: Answer<Extract<ManageTemplatesResponse, { inserted_count: number }>> = z.object({
  success: z.literal(true),
  inserted_count: z.number(),
  skipped_count: z.number(),
  template_page_count: z.number(),
  envelope_page_count: z.number(),
});

/** `failed_emails`: invites that did not go out; those signers need Resend invite. */
export const sendEnvelopeAnswer: Answer<SendEnvelopeResponse> = z.object({
  ok: z.literal(true),
  envelope_id: z.string(),
  signers_invited: z.number(),
  failed_emails: z.array(z.string()),
});

/** send-envelope's 400 when the draft is not ready: every problem, in words for the owner. */
export const sendValidationError: Answer<SendValidationError> = z.object({
  error: z.string(),
  code: z.literal('validation_failed'),
  validation: z.array(z.string()),
});

export const resendInviteAnswer: Answer<ResendInviteResponse> = z.object({ ok: z.literal(true) });

export const voidEnvelopeAnswer: Answer<VoidEnvelopeResponse> = z.object({
  ok: z.literal(true),
  signers_voided: z.number(),
  tasks_dismissed: z.number(),
});

export const deleteEnvelopeAnswer: Answer<DeleteEnvelopeResponse> = z.object({
  ok: z.literal(true),
  envelope_id: z.string(),
  working_objects_removed: z.number(),
});

// ── Portal function ───────────────────────────────────────────────────────────

/** The states a signing link (or the portal exchange) can end in before the flow starts. */
export const TERMINAL_STATES = allOf<TerminalState>()(['expired', 'voided', 'declined', 'co_signer_declined', 'already_signed']);
export type { TerminalState };

export const portalSignerTokenAnswer: Answer<PortalSignerTokenResponse> = z.union([
  z.object({ state: z.literal('ok'), token: z.string().min(1) }),
  z.object({ state: z.enum(TERMINAL_STATES), envelope: z.object({ title: z.string() }) }),
]);
export type PortalSignerTokenAnswer = PortalSignerTokenResponse;

// ── Public (signer) functions ─────────────────────────────────────────────────

const signerField = z.object({
  id: z.string(),
  page_index: z.number().int().min(0),
  field_type: z.enum(FIELD_TYPES),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const resolvedSignerSchema = z.object({
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
});

/**
 * resolve-token's answer. It carries no organization: the page reads the org's names and
 * its contact address from get_org_branding() (usePublicBranding).
 */
export const resolveTokenAnswer: Answer<ResolveTokenResponse> = z.union([
  resolvedSignerSchema,
  z.object({
    state: z.enum(TERMINAL_STATES),
    envelope: z.object({ title: z.string() }),
    signer: z.object({ first_name: z.string().nullable(), last_name: z.string().nullable(), email: z.string() }),
  }),
]);
export type ResolveTokenAnswer = ResolveTokenResponse;
export type ResolvedSigner = Extract<ResolveTokenResponse, { state: 'ok' }>;
export type ResolveTerminal = Exclude<ResolveTokenResponse, { state: 'ok' }>;

export const requestSmsAnswer: Answer<SignerRequestSmsResponse> = z.object({ ok: z.literal(true), last_four: z.string() });

/** `state` says why a code did not open a session: wrong (invalid), locked, expired, or none waiting. */
export const verifySmsAnswer: Answer<SignerVerifySmsResponse> = z.union([
  z.object({ ok: z.literal(true), session_token: z.string().min(1) }),
  z.object({
    ok: z.literal(false),
    state: z.enum(['invalid', 'locked', 'expired', 'none']),
    attempts_left: z.number().int().min(0),
  }),
]);
export type VerifySmsAnswer = SignerVerifySmsResponse;

export const signAnswer: Answer<SignerSignResponse> = z.union([
  z.object({ ok: z.literal(true), already_signed: z.literal(true), finalized: z.literal(false) }),
  z.object({ ok: z.literal(true), finalized: z.boolean() }),
]);

export const declineAnswer: Answer<SignerDeclineResponse> = z.union([
  z.object({ ok: z.literal(true), already_declined: z.literal(true) }),
  z.object({ ok: z.literal(true) }),
]);

/** What the signer adopted. A drawn signature has no text and no font. */
export type AdoptedSignature =
  | { kind: 'typed'; signature_text: string; font_key: string }
  | { kind: 'drawn'; image_base64: string };

export type SignRequest = SignerSignRequest;

export const verifyDocumentAnswer: Answer<VerifyDocumentResponse> = z.union([
  z.object({
    verified: z.literal(true),
    title: z.string(),
    completed_at: z.string().nullable(),
    sha256: z.string(),
    signers: z.array(z.object({ name: z.string(), status: z.string(), signed_at: z.string().nullable() })),
  }),
  z.object({ verified: z.literal(false), reason: z.string(), sha256: z.string() }),
]);
export type VerifyDocumentAnswer = VerifyDocumentResponse;

// ── Error codes ───────────────────────────────────────────────────────────────

type Codes<L extends readonly string[]> = L[number];

/** Every machine code an e-sign function can answer with, plus the shared refusals. */
export type EsignErrorCode =
  | (typeof REFUSALS)[keyof typeof REFUSALS]['code']
  | Codes<typeof CREATE_ENVELOPE_ERRORS>
  | Codes<typeof UPLOAD_DOCUMENT_ERRORS>
  | Codes<typeof MANAGE_SIGNERS_ERRORS>
  | Codes<typeof MANAGE_FIELDS_ERRORS>
  | Codes<typeof MANAGE_TEMPLATES_ERRORS>
  | Codes<typeof REORDER_PAGES_ERRORS>
  | Codes<typeof SEND_ENVELOPE_ERRORS>
  | Codes<typeof RESEND_INVITE_ERRORS>
  | Codes<typeof VOID_ENVELOPE_ERRORS>
  | Codes<typeof DELETE_ENVELOPE_ERRORS>
  | Codes<typeof DOWNLOAD_AUDIT_ERRORS>
  | Codes<typeof PORTAL_SIGNER_TOKEN_ERRORS>
  | Codes<typeof RESOLVE_TOKEN_ERRORS>
  | Codes<typeof SIGNER_VIEW_PDF_ERRORS>
  | Codes<typeof SIGNER_SIGN_ERRORS>
  | Codes<typeof SIGNER_DECLINE_ERRORS>
  | Codes<typeof SIGNER_REQUEST_SMS_ERRORS>
  | Codes<typeof SIGNER_VERIFY_SMS_ERRORS>
  | Codes<typeof VERIFY_DOCUMENT_ERRORS>;

/** True when `err` is an edge error carrying this code. Only a code some function answers compiles. */
export function hasErrorCode(err: unknown, code: EsignErrorCode): boolean {
  return isEdgeError(err) && err.code === code;
}

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
