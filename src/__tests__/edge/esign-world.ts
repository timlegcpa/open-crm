/**
 * The shared fixture for the e-signature function tests: a PGlite database from the real
 * migrations, the PostgREST-shaped client over it, in-memory buckets, captured outbound
 * mail and texts, and the real pdf-lib. Fixtures are fictional (example.com).
 */
import { randomUUID as randomUUIDv4 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import fontkit from '@pdf-lib/fontkit';
import * as pdfLib from 'pdf-lib';
import { createAudit } from '../../../supabase/functions/_shared/audit';
import { createOrgLoader, type OrgIdentity } from '../../../supabase/functions/_shared/organization';
import type { EmailMessage, SendResult, SmsMessage } from '../../../supabase/functions/_shared/outbound';
import { toByteaHex, sha256Hex, encryptPiiSplit } from '../../../supabase/functions/_shared/crypto';
import type { EsignDb } from '../../../supabase/functions/esign-finalize-envelope/lib/db';
import { createPdfTools, type PdfTools } from '../../../supabase/functions/esign-finalize-envelope/lib/pdf';
import type { EsignStorage } from '../../../supabase/functions/esign-finalize-envelope/lib/storage';
import { SIGNATURE_FONT_FILES, type SignerFontKey } from '../../../supabase/functions/esign-finalize-envelope/lib/typed-signature';
import { createDb } from '../db/harness';
import { OWNER_ID } from './contract';
import { pgrestClient } from './esign-pgrest';

export const FONT_DIR = 'supabase/functions/_shared/esign-fonts/fonts';
export const PII_KEY = Buffer.alloc(32, 7).toString('base64');
export const SMS_CODE_KEY = 'ab'.repeat(32);
export const SITE_URL = 'https://crm.example.com';
export const SUPABASE_URL = 'https://project.example.com';
export const ORIGINS = ['http://localhost:5173'];

/** Buckets in memory, with a switch to make the next call of a kind fail. */
export class MemoryStorage implements EsignStorage {
  readonly working = new Map<string, Uint8Array>();
  readonly documents = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  fail = new Set<'putWorking' | 'getWorking' | 'listWorking' | 'removeWorking' | 'putDocument' | 'getDocument'>();

  private check(op: string) {
    if ((this.fail as Set<string>).has(op)) throw new Error(`storage ${op} failed`);
  }
  async putWorking(path: string, bytes: Uint8Array, { upsert }: { upsert: boolean }) {
    this.check('putWorking');
    if (!upsert && this.working.has(path)) throw new Error('exists');
    this.working.set(path, bytes);
  }
  async getWorking(path: string) {
    this.check('getWorking');
    const b = this.working.get(path);
    if (!b) throw new Error('missing');
    return b;
  }
  async listWorking(folder: string, offset: number, limit: number) {
    this.check('listWorking');
    const prefix = `${folder}/`;
    const names = new Map<string, boolean>();
    for (const path of this.working.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    return [...names.entries()].sort().slice(offset, offset + limit).map(([name, folder]) => ({ name, folder }));
  }
  async removeWorking(paths: string[]) {
    this.check('removeWorking');
    for (const p of paths) {
      this.working.delete(p);
      this.removed.push(p);
    }
  }
  async putDocument(path: string, bytes: Uint8Array): Promise<'stored' | 'exists'> {
    this.check('putDocument');
    if (this.documents.has(path)) return 'exists';
    this.documents.set(path, bytes);
    return 'stored';
  }
  async getDocument(path: string) {
    this.check('getDocument');
    const b = this.documents.get(path);
    if (!b) throw new Error('missing');
    return b;
  }
}

export function fontBytes(): Record<SignerFontKey, Uint8Array> {
  const out = {} as Record<SignerFontKey, Uint8Array>;
  for (const [key, file] of Object.entries(SIGNATURE_FONT_FILES)) out[key as SignerFontKey] = new Uint8Array(readFileSync(join(FONT_DIR, file)));
  return out;
}

export function pdfTools(withFonts = false): PdfTools {
  return createPdfTools({ pdfLib, fontkit, fontBytes: withFonts ? fontBytes() : undefined });
}

/** A plain PDF of `pages` letter-size pages. */
export async function makePdf(pages = 1): Promise<Uint8Array> {
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 12 });
  return await doc.save();
}

export interface World {
  pg: PGlite;
  db: EsignDb;
  storage: MemoryStorage;
  emails: EmailMessage[];
  texts: SmsMessage[];
  logs: string[];
  loadOrg(): Promise<OrgIdentity>;
  sendEmail(m: EmailMessage): Promise<SendResult>;
  sendSms(m: SmsMessage): Promise<SendResult>;
  audit: ReturnType<typeof createAudit>['write'];
  logSink(level: string, line: string): void;
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const OWNER_EMAIL = 'owner@example.com';

export async function createWorld(): Promise<World> {
  const pg = await createDb();
  await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2), ('00000000-0000-4000-8000-0000000000a2', 'system@example.com')`, [OWNER_ID, OWNER_EMAIL]);
  await pg.query(
    `INSERT INTO public.org_profile (display_name, legal_name, owner_user_id, system_user_id) VALUES ('Acme', 'Acme LLC', $1, '00000000-0000-4000-8000-0000000000a2')`,
    [OWNER_ID],
  );
  const db = pgrestClient(pg);
  const emails: EmailMessage[] = [];
  const texts: SmsMessage[] = [];
  const logs: string[] = [];
  const org = createOrgLoader({ db, supabaseUrl: SUPABASE_URL, ttlMs: 0 });
  const auditLog = createAudit({ db });
  return {
    pg,
    db,
    storage: new MemoryStorage(),
    emails,
    texts,
    logs,
    loadOrg: () => org.load(),
    async sendEmail(m) {
      emails.push(m);
      return { status: 'sent', channel: 'local', id: null };
    },
    async sendSms(m) {
      texts.push(m);
      return { status: 'sent', channel: 'local', id: null };
    },
    audit: (e) => auditLog.write(e),
    logSink: (_level, line) => {
      logs.push(line);
    },
    q: async <T,>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows as T[],
  };
}

export async function seedContact(w: World, fields: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', ...fields };
  const cols = Object.keys(row);
  const [r] = await w.q<{ id: string }>(
    `INSERT INTO public.contacts (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return r.id;
}

export interface SeededSigner {
  id: string;
  email: string;
  token: string;
}

/**
 * A sent envelope straight in SQL: one 2-page document assembled into source.pdf, the
 * given signers invited with live links and one required signature field each. Built as
 * a draft and then flipped, as send does: the database takes shape changes from drafts only.
 */
export async function seedSentEnvelope(
  w: World,
  opts: {
    signers: Array<{ email: string; contactId?: string | null; role?: 'primary' | 'co_signer' | 'other'; phone?: string }>;
    level?: 'standard' | 'high';
    primaryContactId?: string | null;
    title?: string;
    status?: 'sent' | 'partially_signed';
  },
): Promise<{ envelopeId: string; signers: SeededSigner[] }> {
  const [env] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelopes (created_by, primary_contact_id, title, status, verification_level, expires_at, sent_at, source_pdf_path)
     VALUES ($1, $2, $3, 'draft', $4, now() + interval '14 days', now(), 'placeholder') RETURNING id`,
    [OWNER_ID, opts.primaryContactId ?? null, opts.title ?? 'Engagement letter', opts.level ?? 'standard'],
  );
  const envelopeId = env.id;
  const pdf = await makePdf(2);
  const docPath = `${envelopeId}/sources/doc.pdf`;
  w.storage.working.set(docPath, pdf);
  w.storage.working.set(`${envelopeId}/source.pdf`, pdf);
  await w.q(`UPDATE public.esign_envelopes SET source_pdf_path = $2 WHERE id = $1`, [envelopeId, `${envelopeId}/source.pdf`]);
  const [doc] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelope_documents (envelope_id, "order", file_name, storage_path, byte_size, page_count)
     VALUES ($1, 0, 'letter.pdf', $2, $3, 2) RETURNING id`,
    [envelopeId, docPath, pdf.byteLength],
  );
  await w.q(
    `INSERT INTO public.esign_envelope_pages (envelope_id, "order", source_document_id, source_page_index) VALUES ($1, 0, $2, 0), ($1, 1, $2, 1)`,
    [envelopeId, doc.id],
  );
  const signers: SeededSigner[] = [];
  let order = 0;
  for (const s of opts.signers) {
    const token = `tok${String(order)}${'x'.repeat(40)}${envelopeId.slice(0, 8)}`.replace(/-/g, 'y');
    let phoneCols: [string | null, string | null, string | null] = [null, null, null];
    if (s.phone) {
      const enc = await encryptPiiSplit(s.phone, PII_KEY);
      phoneCols = [toByteaHex(enc.ciphertext), toByteaHex(enc.iv), s.phone.slice(-4)];
    }
    const [row] = await w.q<{ id: string }>(
      `INSERT INTO public.esign_envelope_signers (envelope_id, contact_id, "order", role, email, status, token_hash, token_expires_at, invited_at,
         phone_ciphertext, phone_iv, phone_last_four)
       VALUES ($1, $2, $3, $4, $5, 'invited', $6, now() + interval '14 days', now(), $7::text::bytea, $8::text::bytea, $9) RETURNING id`,
      [envelopeId, s.contactId ?? null, order, s.role ?? 'other', s.email, await sha256Hex(token), ...phoneCols],
    );
    await w.q(
      `INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height) VALUES ($1, $2, 0, 'signature', 50, 100, 200, 40)`,
      [envelopeId, row.id],
    );
    signers.push({ id: row.id, email: s.email, token });
    order += 1;
  }
  await w.q(`UPDATE public.esign_envelopes SET status = $2 WHERE id = $1`, [envelopeId, opts.status ?? 'sent']);
  return { envelopeId, signers };
}

/**
 * The database with `sql` queued just before the handler first touches `table`, as if a
 * send committed after the handler's own draft check. PGlite runs statements in the order
 * they are submitted, so the queued one lands before the handler's query.
 */
export function landsBeforeFirst(w: World, table: string, sql: string, params: unknown[] = []): EsignDb {
  let fired = false;
  return {
    from(name: string) {
      if (name === table && !fired) {
        fired = true;
        void w.q(sql, params);
      }
      return w.db.from(name);
    },
    rpc: (...args: Parameters<EsignDb['rpc']>) => w.db.rpc(...args),
  } as EsignDb;
}

/** The SQL that sends an envelope, for landsBeforeFirst. */
export const SEND_SQL = `UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`;

/**
 * A signer of a sent envelope left pending, as a send whose token write failed leaves one.
 * The database refuses moving a signer back to pending once the envelope left draft, so
 * the fixture builds that state the way it arises: while the envelope is still a draft.
 */
export async function leaveSignerPending(w: World, envelopeId: string, signerId: string, alsoSet = ''): Promise<void> {
  const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
  await w.q(`UPDATE public.esign_envelopes SET status = 'draft' WHERE id = $1`, [envelopeId]);
  await w.q(`UPDATE public.esign_envelope_signers SET status = 'pending'${alsoSet ? `, ${alsoSet}` : ''} WHERE id = $1`, [signerId]);
  await w.q(`UPDATE public.esign_envelopes SET status = $2 WHERE id = $1`, [envelopeId, env.status]);
}

/** A small valid drawn signature: an 8-bit RGBA PNG with a dark stroke. */
export async function drawnSignaturePng(width = 120, height = 40): Promise<string> {
  const { deflateSync } = await import('node:zlib');
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 4;
      const ink = Math.abs(y - height / 2) < 3;
      raw[at] = 0;
      raw[at + 1] = 0;
      raw[at + 2] = 0;
      raw[at + 3] = ink ? 255 : 0;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

/** A draft straight in SQL: one document of `pages` pages and the given signers (no fields). */
export async function seedDraft(
  w: World,
  opts: { pages?: number; signers?: Array<{ email: string; role?: 'primary' | 'co_signer' | 'other'; contactId?: string | null; phone?: string }>; level?: 'standard' | 'high'; title?: string; primaryContactId?: string | null } = {},
): Promise<{ envelopeId: string; documentId: string; pageIds: string[]; signerIds: string[] }> {
  const pages = opts.pages ?? 2;
  const [env] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelopes (created_by, title, verification_level, primary_contact_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [OWNER_ID, opts.title ?? 'Engagement letter', opts.level ?? 'standard', opts.primaryContactId ?? null],
  );
  const envelopeId = env.id;
  const documentId = randomUUIDv4();
  const path = `${envelopeId}/sources/${documentId}.pdf`;
  const pdf = await makePdf(pages);
  w.storage.working.set(path, pdf);
  const [res] = await w.q<{ r: { pages: Array<{ id: string }> } }>(
    `SELECT public.esign_insert_document_with_pages($1, $2, 'letter.pdf', $3, $4, $5) AS r`,
    [envelopeId, documentId, path, pdf.byteLength, pages],
  );
  const signerIds: string[] = [];
  let order = 0;
  for (const s of opts.signers ?? []) {
    let phone: [string | null, string | null, string | null] = [null, null, null];
    if (s.phone) {
      const enc = await encryptPiiSplit(s.phone, PII_KEY);
      phone = [toByteaHex(enc.ciphertext), toByteaHex(enc.iv), s.phone.slice(-4)];
    }
    const [row] = await w.q<{ id: string }>(
      `INSERT INTO public.esign_envelope_signers (envelope_id, contact_id, "order", role, email, phone_ciphertext, phone_iv, phone_last_four)
       VALUES ($1, $2, $3, $4, $5, $6::text::bytea, $7::text::bytea, $8) RETURNING id`,
      [envelopeId, s.contactId ?? null, order++, s.role ?? 'other', s.email, ...phone],
    );
    signerIds.push(row.id);
  }
  return { envelopeId, documentId, pageIds: res.r.pages.map((p) => p.id), signerIds };
}

export async function addField(w: World, envelopeId: string, signerId: string, pageIndex = 0, type: 'signature' | 'date' = 'signature'): Promise<string> {
  const [row] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height) VALUES ($1, $2, $3, $4, 50, 100, 200, 40) RETURNING id`,
    [envelopeId, signerId, pageIndex, type],
  );
  return row.id;
}

/**
 * The database with a race injected: when `table` is updated with values `when` accepts,
 * `sql` runs first, as if another request landed between the handler's read and its
 * guarded write. The rest of the call chain (filters, select) is untouched.
 */
export function withRace(
  w: World,
  table: string,
  when: (values: Record<string, unknown>) => boolean,
  sql: string,
  params: unknown[] = [],
): EsignDb {
  const delayed = (builder: object, before: () => Promise<unknown>): object =>
    new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === 'then') {
          return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
            before().then(() => (target as PromiseLike<unknown>).then(ok, bad), bad);
        }
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const next = (value as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === 'object' ? delayed(next, before) : next;
        };
      },
    });
  return {
    from(name: string) {
      const q = w.db.from(name);
      if (name !== table) return q;
      return new Proxy(q, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop !== 'update' || typeof value !== 'function') return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          return (values: Record<string, unknown>, options?: unknown) => {
            const builder = (value as (v: unknown, o?: unknown) => object).call(target, values, options);
            if (!when(values)) return builder;
            let ran = false;
            return delayed(builder, async () => {
              if (ran) return;
              ran = true;
              await w.pg.query(sql, params);
            });
          };
        },
      });
    },
    rpc: (fn, args) => w.db.rpc(fn, args),
  };
}

export const SIGNER_IP = '203.0.113.5';

/** A live SMS session for a signer, pinned to `ip`, as verify-sms opens one. Returns its token. */
export async function openSession(w: World, signerId: string, ip = SIGNER_IP): Promise<string> {
  const token = `session${'s'.repeat(30)}${signerId.slice(0, 8)}`;
  await w.q(
    `INSERT INTO public.esign_signer_sessions (signer_id, session_token_hash, expires_at, ip) VALUES ($1, $2, now() + interval '30 minutes', $3)`,
    [signerId, await sha256Hex(token), ip],
  );
  return token;
}
