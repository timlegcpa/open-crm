// @vitest-environment node
// decrypt-document, run against the real migrations in PGlite for the row and the
// activity log. Storage is an in-memory map; the crypto is the real _shared/crypto.ts.
import type { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthOutcome, ClientPrincipal } from '../../../supabase/functions/_shared/auth';
import { decryptDocument, encryptDocument } from '../../../supabase/functions/_shared/crypto';
import { SECURITY_HEADERS } from '../../../supabase/functions/_shared/http';
import {
  createDecryptDocumentHandler,
  SIGNED_URL_SECONDS,
  type DecryptDocumentDeps,
  type StoredDocument,
} from '../../../supabase/functions/decrypt-document/handler';
import { createDb } from '../db/harness';
import {
  CLIENT_CONTACT_ID,
  CLIENT_USER_ID,
  CREDENTIALS,
  describeEdgeContract,
  edgeRequest,
  fakeClientAuth,
  fakeOwnerAuth,
  OWNER_ID,
  throwInternal,
} from './contract';

const SYSTEM = '00000000-0000-4000-8000-000000000002';
const OTHER_CONTACT = '10000000-0000-4000-8000-0000000000b2';
const HOUSEHOLD_CONTACT = '10000000-0000-4000-8000-0000000000d2';
const HOUSEHOLD_USER = '00000000-0000-4000-8000-0000000000d2';
const HOUSEHOLD_TOKEN = 'household-token';

const D_OWN = '40000000-0000-4000-8000-0000000000c1'; // the client's own upload (a PNG)
const D_SHARED = '40000000-0000-4000-8000-0000000000c2'; // another contact's, shared with the household contact
const D_OTHER = '40000000-0000-4000-8000-0000000000c3'; // another contact's, not shared
const D_SIGNED = '40000000-0000-4000-8000-0000000000c4'; // a plaintext e-signed PDF of the client
const MISSING = '40000000-0000-4000-8000-0000000000ff';

const KEY = randomBytes(32).toString('base64');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250, 251]);

let db: PGlite;
const objects = new Map<string, Uint8Array>();

async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

async function seedDoc(id: string, contactId: string, opts: { shared?: string; encrypted?: boolean; mime?: string } = {}) {
  const path = `${contactId}/2026/${id}.enc`;
  let iv: string | null = null;
  if (opts.encrypted !== false) {
    const sealed = await encryptDocument(PNG, KEY);
    objects.set(path, sealed.ciphertext);
    iv = sealed.iv;
  } else {
    objects.set(path, PNG);
  }
  await db.query(
    `INSERT INTO public.client_documents (id, contact_id, filename, original_filename, storage_path, file_size, mime_type,
       held_by, encryption_status, encryption_iv, shared_with_contact_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner', $8, $9, $10)`,
    [id, contactId, `${id}.enc`, `photo ${id.slice(-2)}.png`, path, PNG.byteLength, opts.mime ?? 'image/png',
      iv ? 'encrypted' : 'none', iv, opts.shared ?? null]);
}

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER_ID}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${CLIENT_USER_ID}', 'ada@example.test'), ('${HOUSEHOLD_USER}', 'hal@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER_ID}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, status) VALUES
      ('${CLIENT_CONTACT_ID}', 'Ada', 'Lovelace', 'client'), ('${OTHER_CONTACT}', 'Bo', 'Baker', 'client'),
      ('${HOUSEHOLD_CONTACT}', 'Hal', 'Lovelace', 'client');
  `);
  await seedDoc(D_OWN, CLIENT_CONTACT_ID);
  await seedDoc(D_SHARED, OTHER_CONTACT, { shared: CLIENT_CONTACT_ID });
  await seedDoc(D_OTHER, OTHER_CONTACT, { shared: HOUSEHOLD_CONTACT });
  await seedDoc(D_SIGNED, CLIENT_CONTACT_ID, { encrypted: false, mime: 'application/pdf' });
}, 60_000);

/** fakeClientAuth plus a second client, the household contact. */
function clientAuth(): (token: string) => Promise<AuthOutcome<ClientPrincipal>> {
  const base = fakeClientAuth();
  return async (token) =>
    token === HOUSEHOLD_TOKEN
      ? { ok: true, principal: { kind: 'client', userId: HOUSEHOLD_USER, contactId: HOUSEHOLD_CONTACT, sessionId: null, impersonating: false } }
      : base(token);
}

/** fakeOwnerAuth, with the household token a live session of another kind (403, so the client check runs). */
function ownerAuth(): DecryptDocumentDeps['authorizeOwner'] {
  const base = fakeOwnerAuth();
  return async (token) => (token === HOUSEHOLD_TOKEN ? { ok: false, status: 403 } : base(token));
}

function deps(over: Partial<DecryptDocumentDeps> = {}): DecryptDocumentDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: ownerAuth(),
    authorizeClient: clientAuth(),
    limitClient: async () => 'allowed',
    async loadDocument(id) {
      const [row] = await asServer<StoredDocument>(
        `SELECT id, contact_id, shared_with_contact_id, original_filename, mime_type, storage_path, encryption_status, encryption_iv
           FROM public.client_documents WHERE id = $1`, [id]);
      return row ?? null;
    },
    async getObject(path) {
      const bytes = objects.get(path);
      if (!bytes) throw new Error('Object not found');
      return bytes;
    },
    decrypt: (ciphertext, iv) => decryptDocument(ciphertext, iv, KEY),
    signedUrl: async (path, seconds) => `https://storage.example.test/sign/${path}?expires=${seconds}`,
    async recordActivity(a) {
      await asServer(
        `INSERT INTO public.client_activity_log (contact_id, user_id, action, details, ip_address, user_agent)
         VALUES ($1, $2, 'document_download', $3, $4, $5)`,
        [a.contact_id, a.user_id, JSON.stringify(a.details), a.ip_address, a.user_agent]);
    },
    logSink: (_level, line) => logs.push(line),
    ...over,
  };
}

const NETWORK = { 'cf-connecting-ip': '203.0.113.7', 'User-Agent': 'a browser' };

async function open(id: string, purpose: unknown, credentials: Record<string, string> = CREDENTIALS.owner, d = deps()) {
  return createDecryptDocumentHandler(d)(edgeRequest({ body: { document_id: id, purpose }, headers: { ...credentials, ...NETWORK } }));
}

async function downloadsOf(id: string) {
  return asServer<{ user_id: string; details: Record<string, unknown>; ip: string | null; user_agent: string | null }>(
    `SELECT user_id, details, host(ip_address) AS ip, user_agent FROM public.client_activity_log
      WHERE action = 'document_download' AND details->>'document_id' = $1 ORDER BY created_at`, [id]);
}

describeEdgeContract({
  name: 'decrypt-document',
  handler: createDecryptDocumentHandler(deps()),
  failingHandler: createDecryptDocumentHandler(deps({ loadDocument: throwInternal })),
  credentials: CREDENTIALS.owner,
  body: { kind: 'json', valid: { document_id: D_OWN, purpose: 'preview' }, maxBytes: 1024 },
});

describe('decrypt-document: who opens what', () => {
  it('the owner opens any document', async () => {
    for (const id of [D_OWN, D_SHARED, D_OTHER]) expect((await open(id, 'preview')).status, id).toBe(200);
  });

  it('a client opens its own document and one shared with it', async () => {
    for (const id of [D_OWN, D_SHARED]) expect((await open(id, 'preview', CREDENTIALS.client)).status, id).toBe(200);
  });

  it('anyone else gets the same 404 as for a document that does not exist', async () => {
    const missing = await open(MISSING, 'preview', CREDENTIALS.client);
    const notYours = await open(D_OTHER, 'preview', CREDENTIALS.client);
    expect(missing.status).toBe(404);
    expect(notYours.status).toBe(404);
    expect(await notYours.text()).toBe(await missing.text());
  });

  it('View as client still reads', async () => {
    expect((await open(D_OWN, 'preview', CREDENTIALS.viewAsClient)).status).toBe(200);
  });
});

describe('decrypt-document: what comes back', () => {
  it('an encrypted document is its plaintext, always as octet-stream, never cached', async () => {
    const res = await open(D_OWN, 'preview');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Length')).toBe(String(PNG.byteLength));
    expect(res.headers.get('Cache-Control')).toBe(SECURITY_HEADERS['Cache-Control']);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('a plaintext document is a short signed link with its name and type, never cached', async () => {
    const signedUrl = vi.fn(async (path: string, seconds: number) => `https://storage.example.test/${path}?e=${seconds}`);
    const res = await open(D_SIGNED, 'preview', CREDENTIALS.client, deps({ signedUrl }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      signed_url: `https://storage.example.test/${CLIENT_CONTACT_ID}/2026/${D_SIGNED}.enc?e=300`,
      filename: 'photo c4.png',
      mime_type: 'application/pdf',
      mode: 'redirect',
    });
    expect(signedUrl).toHaveBeenCalledWith(`${CLIENT_CONTACT_ID}/2026/${D_SIGNED}.enc`, SIGNED_URL_SECONDS);
    expect(SIGNED_URL_SECONDS).toBe(300);
  });

  it('a document that will not decrypt is a generic 500', async () => {
    const res = await open(D_OWN, 'preview', CREDENTIALS.owner, deps({ decrypt: throwInternal }));
    expect(res.status).toBe(500);
  });
});

describe('decrypt-document: purpose and activity', () => {
  it('needs a document id and a purpose of preview or download', async () => {
    for (const purpose of [undefined, 'view', 'DOWNLOAD', 1]) expect((await open(D_OWN, purpose)).status, String(purpose)).toBe(400);
    const res = await createDecryptDocumentHandler(deps())(edgeRequest({ body: { document_id: 'x', purpose: 'preview' }, headers: CREDENTIALS.owner }));
    expect(res.status).toBe(400);
  });

  it('a preview writes no activity; a download writes one row', async () => {
    const before = (await downloadsOf(D_SHARED)).length;
    await open(D_SHARED, 'preview');
    expect((await downloadsOf(D_SHARED)).length).toBe(before);
    await open(D_SHARED, 'download');
    expect((await downloadsOf(D_SHARED)).length).toBe(before + 1);
  });

  it('records the address only for the document’s own contact at its own keyboard', async () => {
    await open(D_OWN, 'download', CREDENTIALS.client);
    await open(D_OWN, 'download', CREDENTIALS.viewAsClient);
    await open(D_OWN, 'download', CREDENTIALS.owner);
    await open(D_OTHER, 'download', { Authorization: `Bearer ${HOUSEHOLD_TOKEN}` });
    const own = await downloadsOf(D_OWN);
    expect(own.map((r) => [r.details.actor_role, r.ip, r.user_agent, r.user_id])).toEqual([
      ['client', '203.0.113.7', 'a browser', CLIENT_USER_ID],
      ['owner', null, null, CLIENT_USER_ID], // View as client: the owner at the client's session
      ['owner', null, null, OWNER_ID],
    ]);
    const shared = await downloadsOf(D_OTHER);
    expect(shared.map((r) => [r.details.actor_role, r.ip, r.user_agent, r.user_id])).toEqual([['client', null, null, HOUSEHOLD_USER]]);
    expect(shared[0].details).toEqual({ document_id: D_OTHER, filename: 'photo c3.png', actor_role: 'client' });
  });

  it('a failed activity row does not fail the download', async () => {
    const d = deps({ recordActivity: throwInternal });
    const res = await open(D_OWN, 'download', CREDENTIALS.owner, d);
    expect(res.status).toBe(200);
    expect(d.logs.join('\n')).toMatch(/activity row failed/);
  });
});

describe('decrypt-document: rate limits', () => {
  it('limits the client, refuses when the limiter cannot answer, and never asks for the owner', async () => {
    expect((await open(D_OWN, 'preview', CREDENTIALS.client, deps({ limitClient: async () => 'limited' }))).status).toBe(429);
    expect((await open(D_OWN, 'preview', CREDENTIALS.client, deps({ limitClient: async () => 'unavailable' }))).status).toBe(503);
    const limitClient = vi.fn(async () => 'limited' as const);
    expect((await open(D_OWN, 'preview', CREDENTIALS.owner, deps({ limitClient }))).status).toBe(200);
    expect(limitClient).not.toHaveBeenCalled();
  });
});
