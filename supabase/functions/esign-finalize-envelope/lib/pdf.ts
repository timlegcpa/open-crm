// Every pdf-lib call e-signature makes: page counts at upload, assembly at send, the
// trial embed at sign, the stamp and audit trail at finalize, the on-demand audit PDF.
//
// pdf-lib and fontkit are INJECTED (createPdfTools), never imported here: each PDF
// function's index.ts imports the one mapped `npm:pdf-lib@1.17.1` and
// `npm:@pdf-lib/fontkit@1.1.1` (src/__tests__/edge/esign-finalize-envelope.test.ts holds every PDF
// function's deno.json to the same two versions and package.json to the same ones), and
// vitest injects the node copies. That is what makes "sign validates a drawn signature
// with the decoder finalize embeds it with" true: one library, one version.
//
// Every string drawn in Helvetica goes through safe() (./pdf-text.ts): the standard font
// throws on anything outside WinAnsi, and at finalize that throw comes after every signer
// signed, so the envelope could never complete. That includes the organization's name,
// the site URL and the footer.

import type * as PdfLib from 'pdf-lib';
import { fontCanEncode, toEncodableText } from './pdf-text.ts';
import { decodeSignatureBase64 } from './signature-image.ts';
import type { SignerFontKey } from './typed-signature.ts';

export type { SignerFontKey } from './typed-signature.ts';

type PdfDocument = PdfLib.PDFDocument;
type PdfFont = PdfLib.PDFFont;
type Fontkit = Parameters<PdfDocument['registerFontkit']>[0];

export interface PdfToolsDeps {
  pdfLib: Pick<typeof PdfLib, 'PDFDocument' | 'StandardFonts' | 'rgb' | 'degrees'>;
  fontkit?: Fontkit;
  /** The script fonts' bytes. Only finalize stamps typed signatures, so only it passes them. */
  fontBytes?: Partial<Record<SignerFontKey, Uint8Array>>;
}

export interface MergeStep {
  source_document_id: string;
  source_page_index: number;
  final_index: number;
}

export interface PlanPage {
  order: number;
  source_document_id: string;
  source_page_index: number;
  deleted: boolean;
}

/**
 * The live pages in order, numbered from 0: the final document. A field's page_index
 * is a position in exactly this list. The one copy send runs (and the tests cover).
 */
export function planMerge(pages: readonly PlanPage[]): MergeStep[] {
  return pages
    .filter((p) => !p.deleted)
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((p, i) => ({ source_document_id: p.source_document_id, source_page_index: p.source_page_index, final_index: i }));
}

export interface StampField {
  page_index: number;
  field_type: 'signature' | 'date';
  /** The box in UNROTATED page user space (CropBox offset included), as the editor stores it. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A box as a reader sees it on a page shown with /Rotate `rotation` (clockwise, a multiple
 * of 90): its width and height as read, and where a point (u along the reading direction,
 * v up the reading direction, both from the box's visual bottom-left) lands in unrotated
 * user space. Drawing at at(u, v) with rotate = `rotation` degrees (counter-clockwise in
 * user space) cancels the viewer's turn, so the content reads upright inside the same box.
 */
export function uprightBox(box: { x: number; y: number; width: number; height: number }, rotation: number) {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const sideways = r === 90 || r === 270;
  const at = (u: number, v: number): { x: number; y: number } => {
    switch (r) {
      case 90:
        return { x: box.x + box.width - v, y: box.y + u };
      case 180:
        return { x: box.x + box.width - u, y: box.y + box.height - v };
      case 270:
        return { x: box.x + v, y: box.y + box.height - u };
      default:
        return { x: box.x + u, y: box.y + v };
    }
  };
  return { rotation: r, width: sideways ? box.height : box.width, height: sideways ? box.width : box.height, at };
}

interface SignerStampBase {
  signer_id: string;
  signer_name: string;
  signed_at: Date;
  /** The IANA zone the signer signed in: the date field is stamped in it. */
  tz?: string;
  fields: StampField[];
}

/** Discriminated on kind: a drawn signer has no text and no font at all. */
export type SignerStamp =
  | (SignerStampBase & { kind: 'typed'; signature_text: string; font_key: SignerFontKey })
  | (SignerStampBase & { kind: 'drawn'; image_base64: string });

export interface SignerSummary {
  name: string;
  email: string;
  identity_check: string;
  status?: string;
  tz?: string;
  consent?: string;
  /** Only for a signer who signed: an audit trail never asserts a type nobody chose. */
  signature_type?: string;
}

export interface AuditEvent {
  created_at: string;
  phrase: string;
  ip?: string | null;
}

export interface AuditBranding {
  /** legalName ?? displayName. */
  orgName: string;
  /** SITE_URL: the audit page tells a reader where to check the file. */
  siteUrl: string;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatMmDdYyyy(d: Date, tz?: string): string {
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric' }).format(d);
    } catch {
      // An unknown zone falls through to UTC rather than stamping nothing.
    }
  }
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${m}/${day}/${d.getUTCFullYear()}`;
}

function shortUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function createPdfTools(deps: PdfToolsDeps) {
  const { PDFDocument, StandardFonts, rgb, degrees } = deps.pdfLib;

  /** Page count of an upload; throws for an encrypted or unreadable PDF. */
  async function pageCount(bytes: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount();
  }

  /**
   * Prove a drawn signature embeds, with the library and call finalize uses. Structural
   * validation cannot replace this: an APNG passes it and pdf-lib still refuses it.
   */
  async function trialEmbedPng(imageBase64: string): Promise<boolean> {
    try {
      const bytes = decodeSignatureBase64(imageBase64);
      if (!bytes) return false;
      const probe = await PDFDocument.create();
      await probe.embedPng(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** The final document from the merge plan. */
  async function assemblePdf(plan: readonly MergeStep[], sources: ReadonlyArray<{ id: string; bytes: Uint8Array }>): Promise<Uint8Array> {
    const out = await PDFDocument.create();
    const cache = new Map<string, PdfDocument>();
    for (const s of sources) cache.set(s.id, await PDFDocument.load(s.bytes));
    for (const step of plan) {
      const doc = cache.get(step.source_document_id);
      if (!doc) throw new Error('a source document is missing');
      const [page] = await out.copyPages(doc, [step.source_page_index]);
      out.addPage(page);
    }
    return await out.save();
  }

  function drawFooters(pdf: PdfDocument, envelopeIdShort: string, stampIso: string, helv: PdfFont): void {
    const safe = (t: string) => toEncodableText(t, fontCanEncode(helv));
    const pages = pdf.getPages();
    pages.forEach((page, i) => {
      // Along the bottom of the page as it is shown, whatever its /Rotate.
      const { width, height } = page.getSize();
      const shown = uprightBox({ x: 0, y: 0, width, height }, page.getRotation().angle);
      const text = safe(`Page ${i + 1} of ${pages.length} · E-Sign ID: ${envelopeIdShort} · ${stampIso}`);
      const at = shown.at(shown.width - helv.widthOfTextAtSize(text, 7) - 18, 12);
      page.drawText(text, { ...at, rotate: degrees(shown.rotation), size: 7, font: helv, color: rgb(0.5, 0.5, 0.5) });
    });
  }

  /** The audit trail, appended as one or more pages. Shared by both producers. */
  function drawAuditPages(
    pdf: PdfDocument,
    helv: PdfFont,
    opts: { envelopeIdShort: string; subtitle: string; siteUrl: string; signers: readonly SignerSummary[]; events: readonly AuditEvent[] },
  ): void {
    const encodable = fontCanEncode(helv);
    const safe = (t: string) => toEncodableText(t, encodable);
    const grey = rgb(0.3, 0.3, 0.3);

    let page = pdf.addPage();
    let cursor = page.getSize().height - 50;
    const line = (text: string, x: number, size: number, color = rgb(0, 0, 0), gap = size + 3) => {
      if (cursor < 60) {
        page = pdf.addPage();
        cursor = page.getSize().height - 50;
      }
      page.drawText(safe(text), { x, y: cursor, size, font: helv, color });
      cursor -= gap;
    };

    line('Audit Trail', 50, 18, rgb(0, 0, 0), 24);
    line(opts.subtitle, 50, 9, rgb(0.4, 0.4, 0.4), 14);
    line(`E-Sign ID: ${opts.envelopeIdShort}`, 50, 9, rgb(0.4, 0.4, 0.4), 24);

    line('Tamper Verification', 50, 11, rgb(0, 0, 0), 14);
    line(`To check that this file has not been modified since signing, visit ${opts.siteUrl.replace(/\/+$/, '')}/esign/verify`, 50, 8, grey, 11);
    line('and choose the file. The check compares its SHA-256 fingerprint with the signed copy on record.', 50, 8, grey, 30);

    line('Signers', 50, 11, rgb(0, 0, 0), 14);
    for (const s of opts.signers) {
      line(s.status ? `${s.name} (${s.email}): ${s.status}` : `${s.name} (${s.email})`, 50, 9, rgb(0, 0, 0), 11);
      line(`Identity Check: ${s.identity_check}`, 60, 8, grey, 10);
      if (s.signature_type) line(`Signature Type: ${s.signature_type}`, 60, 8, grey, 10);
      if (s.consent) line(`Consent: ${s.consent}`, 60, 8, grey, 10);
      if (s.tz) line(`Time Zone: ${s.tz}`, 60, 8, grey, 10);
      cursor -= 6;
    }
    cursor -= 4;

    line('Event Log', 50, 11, rgb(0, 0, 0), 14);
    for (const e of opts.events) {
      line(`${e.created_at}  -  ${e.phrase}${e.ip ? `, from ${e.ip}` : ''}`, 50, 8, rgb(0.2, 0.2, 0.2), 10);
    }
    line('END OF LOG', 50, 8, rgb(0.5, 0.5, 0.5), 10);
  }

  /** The executed PDF: signatures and dates stamped, the audit trail appended, a footer on every page. */
  async function stampAndAudit(opts: AuditBranding & {
    sourcePdf: Uint8Array;
    envelopeIdShort: string;
    completedAtIso: string;
    signers: readonly SignerStamp[];
    signerSummaries: readonly SignerSummary[];
    events: readonly AuditEvent[];
  }): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(opts.sourcePdf);
    if (deps.fontkit) pdf.registerFontkit(deps.fontkit);

    // Flatten fillable form fields first: viewers paint them with a highlight box, and a
    // signature drawn over one looks pasted on. A malformed form is left as it is rather
    // than failing an envelope everyone has signed.
    try {
      const form = pdf.getForm();
      if (form.getFields().length > 0) form.flatten();
    } catch {
      // keep the unflattened page
    }

    const fonts = new Map<SignerFontKey, PdfFont>();
    const images = new Map<string, PdfLib.PDFImage>();
    for (const s of opts.signers) {
      if (s.kind === 'drawn') {
        const bytes = decodeSignatureBase64(s.image_base64);
        if (!bytes) throw new Error('a drawn signature is not decodable');
        images.set(s.signer_id, await pdf.embedPng(bytes));
      } else if (!fonts.has(s.font_key)) {
        const bytes = deps.fontBytes?.[s.font_key];
        if (!bytes || !deps.fontkit) throw new Error('a signature font is not loaded');
        fonts.set(s.font_key, await pdf.embedFont(bytes));
      }
    }
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const safe = (t: string) => toEncodableText(t, fontCanEncode(helv));

    const pages = pdf.getPages();
    for (const s of opts.signers) {
      for (const f of s.fields) {
        const page = pages[f.page_index];
        if (!page) continue;
        // Laid out in the box as the reader sees it, then turned with the page, so the
        // content reads upright on a page shown with /Rotate 90, 180 or 270.
        const box = uprightBox(f, page.getRotation().angle);
        const rotate = degrees(box.rotation);
        if (f.field_type === 'date') {
          const size = Math.min(box.height * 0.6, 12);
          page.drawText(formatMmDdYyyy(s.signed_at, s.tz), { ...box.at(4, (box.height - size) / 2), rotate, size, font: helv, color: rgb(0, 0, 0) });
          continue;
        }
        // The caption sits INSIDE the box along its bottom edge; the signature fills the
        // space above it, so neither bleeds into the form around the box.
        const captionSize = 5;
        const reserved = captionSize + 2;
        const targetWidth = box.width * 0.92;
        const availableHeight = box.height - reserved;
        if (s.kind === 'drawn') {
          const img = images.get(s.signer_id) as PdfLib.PDFImage;
          const scale = Math.min(targetWidth / img.width, availableHeight / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { ...box.at((box.width - w) / 2, reserved + (availableHeight - h) / 2), rotate, width: w, height: h });
        } else {
          const font = fonts.get(s.font_key) as PdfFont;
          let size = availableHeight * 0.85;
          const width = font.widthOfTextAtSize(s.signature_text, size);
          if (width > targetWidth) size = size * (targetWidth / width);
          page.drawText(s.signature_text, { ...box.at(4, reserved + (availableHeight - size) / 2), rotate, size, font, color: rgb(0.05, 0.05, 0.5) });
        }
        page.drawText(safe(`e-Signed by ${s.signer_name} · ${opts.envelopeIdShort} · ${shortUtc(s.signed_at)}`), {
          ...box.at(4, 1),
          rotate,
          size: captionSize,
          font: helv,
          color: rgb(0.5, 0.5, 0.5),
          maxWidth: Math.max(box.width - 8, 1),
        });
      }
    }

    // The audit pages first, so the footer's page count covers them.
    drawAuditPages(pdf, helv, {
      envelopeIdShort: opts.envelopeIdShort,
      subtitle: opts.orgName,
      siteUrl: opts.siteUrl,
      signers: opts.signerSummaries,
      events: opts.events,
    });
    drawFooters(pdf, opts.envelopeIdShort, opts.completedAtIso, helv);
    return await pdf.save();
  }

  /** The audit trail alone, for an envelope still in progress (or any past draft). */
  async function renderAuditOnly(opts: AuditBranding & {
    envelopeIdShort: string;
    generatedAtIso: string;
    signers: readonly SignerSummary[];
    events: readonly AuditEvent[];
  }): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    drawAuditPages(pdf, helv, {
      envelopeIdShort: opts.envelopeIdShort,
      subtitle: `${opts.orgName} · Generated ${opts.generatedAtIso}`,
      siteUrl: opts.siteUrl,
      signers: opts.signers,
      events: opts.events,
    });
    drawFooters(pdf, opts.envelopeIdShort, opts.generatedAtIso, helv);
    return await pdf.save();
  }

  return { pageCount, trialEmbedPng, assemblePdf, stampAndAudit, renderAuditOnly };
}

export type PdfTools = ReturnType<typeof createPdfTools>;
