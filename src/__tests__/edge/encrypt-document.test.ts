// @vitest-environment node
// encrypt-document, run against the real migrations in PGlite for every database step.
// Storage is an in-memory map (the bucket's own rules are proven in db/documents.test.ts);
// the encryption is the real _shared/crypto.ts under a test key.
import type { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import { decryptDocument, encryptDocument } from '../../../supabase/functions/_shared/crypto';
import { MAX_UPLOAD_BYTES } from '../../../supabase/functions/_shared/magic-bytes';
import {
  createEncryptDocumentHandler,
  displayName,
  isFolderPath,
  MAX_FORM_BYTES,
  objectExtension,
  type EncryptDocumentDeps,
} from '../../../supabase/functions/encrypt-document/handler';
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
const KEY = randomBytes(32).toString('base64');
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let db: PGlite;

async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER_ID}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${CLIENT_USER_ID}', 'ada@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER_ID}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, status) VALUES
      ('${CLIENT_CONTACT_ID}', 'Ada', 'Lovelace', 'client'), ('${OTHER_CONTACT}', 'Bo', 'Baker', 'client');
    INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES
      ('${CLIENT_CONTACT_ID}', '/', 'Receipts', 'client'), ('${CLIENT_CONTACT_ID}', '/', 'Statements', 'owner');
  `);
}, 60_000);

interface World extends EncryptDocumentDeps {
  objects: Map<string, Uint8Array>;
  logs: string[];
}

async function insertDocument(row: Parameters<EncryptDocumentDeps['insertRow']>[0]): Promise<string> {
  const keys = Object.keys(row);
  const [r] = await asServer<{ id: string }>(
    `INSERT INTO public.client_documents (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row));
  return r.id;
}

function world(over: Partial<EncryptDocumentDeps> = {}): World {
  const objects = new Map<string, Uint8Array>();
  const logs: string[] = [];
  return {
    objects,
    logs,
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    authorizeClient: fakeClientAuth(),
    limitClient: async () => 'allowed',
    async destinationExists(contactId, heldBy, folderPath) {
      const [row] = await asServer<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM public.contacts WHERE id = $1)
            AND ($3 = '/' OR EXISTS (SELECT 1 FROM public.client_folders
                 WHERE contact_id = $1 AND held_by = $2 AND parent_path || name || '/' = $3)) AS ok`,
        [contactId, heldBy, folderPath]);
      return row.ok;
    },
    encrypt: (plaintext) => encryptDocument(plaintext, KEY),
    async putObject(path, bytes) {
      if (objects.has(path)) throw new Error('The resource already exists');
      objects.set(path, bytes);
    },
    async findRowByStoragePath(path) {
      const [r] = await asServer<{ id: string }>(`SELECT id FROM public.client_documents WHERE storage_path = $1 ORDER BY created_at LIMIT 1`, [path]);
      return r?.id ?? null;
    },
    insertRow: (row) => insertDocument(row),
    async recordActivity(a) {
      await asServer(
        `INSERT INTO public.client_activity_log (contact_id, user_id, action, details, ip_address, user_agent)
         VALUES ($1, $2, 'document_upload', $3, $4, $5)`,
        [a.contact_id, a.user_id, JSON.stringify(a.details), a.ip_address, a.user_agent]);
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date('2026-03-01T12:00:00Z'),
    logSink: (_level, line) => logs.push(line),
    ...over,
  };
}

function form(fields: Record<string, string> = {}, file: Blob | null = new File([PDF], 'Receipt March.pdf', { type: 'application/pdf' })): FormData {
  const f = new FormData();
  if (file) f.append('file', file);
  for (const [k, v] of Object.entries({ contact_id: CLIENT_CONTACT_ID, held_by: 'client', folder_path: '/', ...fields })) f.append(k, v);
  return f;
}

async function upload(w: World, body: FormData, credentials: Record<string, string> = CREDENTIALS.owner, init: { headers?: Record<string, string> } = {}) {
  const res = await createEncryptDocumentHandler(w)(edgeRequest({ body, headers: { ...credentials, ...init.headers } }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}

const rowOf = async (id: unknown) =>
  (await asServer<Record<string, unknown>>(`SELECT * FROM public.client_documents WHERE id = $1`, [id]))[0];
const activityOf = async (id: unknown) =>
  (await asServer<{ user_id: string; details: Record<string, unknown>; ip_address: string | null; user_agent: string | null }>(
    `SELECT user_id, details, host(ip_address) AS ip_address, user_agent FROM public.client_activity_log WHERE details->>'document_id' = $1`, [id]))[0];

describeEdgeContract({
  name: 'encrypt-document',
  handler: createEncryptDocumentHandler(world()),
  failingHandler: createEncryptDocumentHandler(world({ destinationExists: throwInternal })),
  credentials: CREDENTIALS.owner,
  clientWrites: true,
  body: { kind: 'form', valid: form(), maxBytes: MAX_FORM_BYTES },
});

describe('encrypt-document: a stored upload', () => {
  it('is encrypted under the key, filed where asked, and opens to the same bytes', async () => {
    const w = world();
    const { res, body } = await upload(w, form({ folder_path: '/Receipts/', category: 'receipt', description: 'March' }));
    expect(res.status).toBe(200);
    expect(body.filename).toBe('Receipt March.pdf');
    const row = await rowOf(body.id);
    expect(row).toMatchObject({
      contact_id: CLIENT_CONTACT_ID, uploaded_by: OWNER_ID, original_filename: 'Receipt March.pdf', mime_type: 'application/pdf',
      file_size: PDF.byteLength, category: 'receipt', description: 'March', folder_path: '/Receipts/', held_by: 'client',
      encryption_status: 'encrypted',
    });
    expect(row.storage_path).toMatch(new RegExp(`^${CLIENT_CONTACT_ID}/2026/[0-9a-f-]{36}\\.pdf\\.enc$`));
    expect(row.filename).toBe(String(row.storage_path).split('/').pop());
    const stored = w.objects.get(String(row.storage_path))!;
    expect(Buffer.from(stored).includes(Buffer.from(PDF))).toBe(false);
    expect(await decryptDocument(stored, String(row.encryption_iv), KEY)).toEqual(PDF);
  });

  it('lets the owner file into the shared section, and records no address for the owner', async () => {
    const { res, body } = await upload(world(), form({ held_by: 'owner', folder_path: '/Statements/' }), CREDENTIALS.owner,
      { headers: { 'cf-connecting-ip': '203.0.113.9', 'User-Agent': 'owner browser' } });
    expect(res.status).toBe(200);
    expect((await rowOf(body.id)).held_by).toBe('owner');
    expect(await activityOf(body.id)).toEqual({
      user_id: OWNER_ID,
      details: { document_id: body.id, filename: 'Receipt March.pdf', held_by: 'owner', actor_role: 'owner' },
      ip_address: null,
      user_agent: null,
    });
  });

  it('records a client’s own upload with its address', async () => {
    const { res, body } = await upload(world(), form(), CREDENTIALS.client, { headers: { 'cf-connecting-ip': '203.0.113.7', 'User-Agent': 'client browser' } });
    expect(res.status).toBe(200);
    expect((await rowOf(body.id)).uploaded_by).toBe(CLIENT_USER_ID);
    expect(await activityOf(body.id)).toEqual({
      user_id: CLIENT_USER_ID,
      details: { document_id: body.id, filename: 'Receipt March.pdf', held_by: 'client', actor_role: 'client' },
      ip_address: '203.0.113.7',
      user_agent: 'client browser',
    });
  });

  it('keeps the display name to one clean segment and the object extension plain', () => {
    expect(displayName('a/b\\c\u0007.pdf')).toBe('a_b_c_.pdf');
    expect(displayName('   ')).toBe('document');
    // Unicode format characters go: a right-to-left override, a zero-width space, a tag.
    expect(displayName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(displayName('a\u200Bb\u{E0041}.pdf')).toBe('ab.pdf');
    expect(displayName('\u202E')).toBe('document');
    const long = `${'x'.repeat(300)}.pdf`;
    expect(displayName(long)).toHaveLength(255);
    expect(displayName(long).endsWith('.pdf')).toBe(true);
    expect(objectExtension('scan.JPEG')).toBe('jpeg');
    expect(objectExtension('archive.tar.gz')).toBe('gz');
    expect(objectExtension('weird.<script>')).toBe('bin');
    expect(objectExtension('noext')).toBe('bin');
  });

  it('accepts only the folder paths the database stores', () => {
    for (const ok of ['/', '/a/', '/a b/c/']) expect(isFolderPath(ok), ok).toBe(true);
    for (const bad of ['', 'a/', '/a', '//', '/../', '/./', '/a\\b/', '/a\u0000/', `/${'x'.repeat(200)}/`]) expect(isFolderPath(bad), bad).toBe(false);
  });
});

describe('encrypt-document: refusals', () => {
  it('a client cannot upload into the shared section or for another contact', async () => {
    for (const fields of [{ held_by: 'owner', folder_path: '/Statements/' }, { contact_id: OTHER_CONTACT }] as Record<string, string>[]) {
      const w = world();
      const { res, body } = await upload(w, form(fields), CREDENTIALS.client);
      expect(res.status).toBe(403);
      expect(body.code).toBe('forbidden');
      expect(w.objects.size).toBe(0);
    }
  });

  it('View as client is refused before anything is stored', async () => {
    const w = world();
    const { res, body } = await upload(w, form(), CREDENTIALS.viewAsClient);
    expect(res.status).toBe(403);
    expect(body.code).toBe('impersonation_read_only');
    expect(w.objects.size).toBe(0);
  });

  it('a folder that does not exist, in that section or for that contact, is 404', async () => {
    const cases: Record<string, string>[] = [
      { folder_path: '/Nowhere/' },
      { folder_path: '/Statements/' }, // exists, but in the shared section
      { contact_id: '10000000-0000-4000-8000-0000000000ff' },
    ];
    for (const fields of cases) {
      const w = world();
      const { res, body } = await upload(w, form(fields));
      expect([JSON.stringify(fields), res.status, body.code]).toEqual([JSON.stringify(fields), 404, 'folder_not_found']);
      expect(w.objects.size).toBe(0);
    }
  });

  it('a file whose bytes are not its declared type, or a type not on the list, is refused', async () => {
    const cases = [
      new File([PNG], 'fake.pdf', { type: 'application/pdf' }),
      new File([PDF], 'fake.png', { type: 'image/png' }),
      new File([PDF], 'page.html', { type: 'text/html' }),
      new File([new Uint8Array([0x00, 0x01])], 'bin.txt', { type: 'text/plain' }),
    ];
    for (const file of cases) {
      const w = world();
      const { res, body } = await upload(w, form({}, file));
      expect([file.name, res.status, body.code]).toEqual([file.name, 415, 'unsupported_file']);
      expect(w.objects.size).toBe(0);
    }
  });

  it('an empty file, a missing file and bad fields are 400', async () => {
    const cases: Array<[string, FormData]> = [
      ['empty', form({}, new File([], 'empty.pdf', { type: 'application/pdf' }))],
      ['no file', form({}, null)],
      ['no contact', (() => { const f = form(); f.set('contact_id', 'nope'); return f; })()],
      ['bad section', form({ held_by: 'shared' })],
      ['bad path', form({ folder_path: '/../' })],
      ['long category', form({ category: 'x'.repeat(101) })],
      ['long description', form({ description: 'x'.repeat(501) })],
    ];
    for (const [what, body] of cases) {
      const w = world();
      const { res } = await upload(w, body);
      expect([what, res.status]).toEqual([what, 400]);
      expect(w.objects.size).toBe(0);
    }
  });

  it('a file over 25 MB is 413, and one of exactly 25 MB is stored', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PDF);
    const over = await upload(world(), form({}, new File([big], 'big.pdf', { type: 'application/pdf' })));
    expect(over.res.status).toBe(413);
    const exact = await upload(world(), form({}, new File([big.subarray(0, MAX_UPLOAD_BYTES)], 'exact.pdf', { type: 'application/pdf' })));
    expect(exact.res.status).toBe(200);
  }, 60_000);

  it('the client is rate limited (and refused when the limiter cannot answer); the owner never asks', async () => {
    const limited = await upload(world({ limitClient: async () => 'limited' }), form(), CREDENTIALS.client);
    expect(limited.res.status).toBe(429);
    const down = await upload(world({ limitClient: async () => 'unavailable' }), form(), CREDENTIALS.client);
    expect(down.res.status).toBe(503);
    const limitClient = vi.fn(async () => 'limited' as const);
    const owner = await upload(world({ limitClient }), form());
    expect(owner.res.status).toBe(200);
    expect(limitClient).not.toHaveBeenCalled();
  });
});

describe('encrypt-document: when the row write fails or its answer is lost', () => {
  it('never deletes the stored object: a row that was not written leaves an orphan, logged, and a generic 500', async () => {
    const w = world({ insertRow: throwInternal });
    const { res } = await upload(w, form());
    expect(res.status).toBe(500);
    expect(w.objects.size).toBe(1);
    const [path] = [...w.objects.keys()];
    expect(await asServer(`SELECT id FROM public.client_documents WHERE storage_path = $1`, [path])).toEqual([]);
    expect(w.logs.join('\n')).toMatch(/the object is an orphan/);
  });

  it('a lost acknowledgement: the insert committed but reported a failure, so the upload succeeds over the kept object', async () => {
    const w = world({
      async insertRow(row) {
        await insertDocument(row); // committed in the database ...
        throw new Error('connection reset'); // ... and the answer never arrived
      },
    });
    const { res, body } = await upload(w, form());
    expect(res.status).toBe(200);
    const [path] = [...w.objects.keys()];
    expect(w.objects.size).toBe(1);
    const rows = await asServer<{ id: string }>(`SELECT id FROM public.client_documents WHERE storage_path = $1`, [path]);
    expect(rows).toEqual([{ id: body.id }]);
    expect(await rowOf(body.id)).toMatchObject({ storage_path: path, encryption_status: 'encrypted' });
  });

  it('a lookup that fails after a failed insert keeps the object and answers a generic 500', async () => {
    const w = world({ insertRow: throwInternal, findRowByStoragePath: throwInternal });
    const { res } = await upload(w, form());
    expect(res.status).toBe(500);
    expect(w.objects.size).toBe(1);
    expect(w.logs.join('\n')).toMatch(/may be an orphan/);
  });

  it('a failed activity row does not fail the upload', async () => {
    const w = world({ recordActivity: throwInternal });
    const { res } = await upload(w, form());
    expect(res.status).toBe(200);
    expect(w.logs.join('\n')).toMatch(/activity row failed/);
  });
});
