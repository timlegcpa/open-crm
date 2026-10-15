// @vitest-environment node
// 0003_documents against real policy evaluation: who reads and writes documents, folders
// and annotations, the column guards, the path triggers, every RPC, View as client, and
// the documents bucket.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from '../../../supabase/functions/_shared/magic-bytes';
import { anon, as, become, becomeSuperuser, count as countRows, createDb, errorOf, expectDenied, service, session, tryIn, user, type Principal } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const USER_H = '00000000-0000-4000-8000-00000000000d'; // the household member a document is shared with

const CONTACT_A = '10000000-0000-4000-8000-00000000000a';
const CONTACT_B = '10000000-0000-4000-8000-00000000000b';
const CONTACT_H = '10000000-0000-4000-8000-00000000000d';

// Contact A: uploads under /Receipts/ (and /Receipts/2025/), shared documents under /Statements/.
const F_A_RECEIPTS = '30000000-0000-4000-8000-0000000000a1';
const F_A_2025 = '30000000-0000-4000-8000-0000000000a2';
const F_A_STATEMENTS = '30000000-0000-4000-8000-0000000000a3';
const F_B_RECEIPTS = '30000000-0000-4000-8000-0000000000b1';

const D_A_UPLOAD = '40000000-0000-4000-8000-0000000000a1'; // client, /Receipts/
const D_A_DEEP = '40000000-0000-4000-8000-0000000000a2'; // client, /Receipts/2025/
const D_A_ROOT = '40000000-0000-4000-8000-0000000000a3'; // client, /
const D_A_SHARED = '40000000-0000-4000-8000-0000000000a4'; // owner, /Statements/, shared with H
const D_A_OWNER = '40000000-0000-4000-8000-0000000000a5'; // owner, /
const D_B_UPLOAD = '40000000-0000-4000-8000-0000000000b1'; // client, /Receipts/ of B
const ANNOTATION = '50000000-0000-4000-8000-0000000000a1';

const owner = user(OWNER);
const clientA = user(USER_A);
const clientB = user(USER_B);
const household = user(USER_H);
const forger = user('00000000-0000-4000-8000-00000000000f', { appRole: 'admin' });

const TABLES = ['client_documents', 'client_folders', 'document_annotations'] as const;

let db: PGlite;

const doc = (id: string, contact: string, heldBy: string, path: string, name: string, extra = '') => `
  INSERT INTO public.client_documents (id, contact_id, filename, original_filename, storage_path, file_size, mime_type,
    folder_path, held_by, encryption_status, encryption_iv${extra ? ', shared_with_contact_id' : ''})
  VALUES ('${id}', '${contact}', '${id}.pdf.enc', '${name}', '${contact}/2025/${id}.pdf.enc', 10, 'application/pdf',
    '${path}', '${heldBy}', 'encrypted', 'AAAAAAAAAAAAAAAA'${extra ? `, '${extra}'` : ''});`;

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test'), ('${USER_H}', 'h@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, status) VALUES
      ('${CONTACT_A}', 'Ada', 'Lovelace', 'client'), ('${CONTACT_B}', 'Bo', 'Baker', 'client'),
      ('${CONTACT_H}', 'Hal', 'Lovelace', 'client');
    INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES
      ('${CONTACT_A}', '${USER_A}', 'active', 'a@example.test'),
      ('${CONTACT_B}', '${USER_B}', 'active', 'b@example.test'),
      ('${CONTACT_H}', '${USER_H}', 'active', 'h@example.test');
    INSERT INTO public.client_folders (id, contact_id, parent_path, name, held_by) VALUES
      ('${F_A_RECEIPTS}', '${CONTACT_A}', '/', 'Receipts', 'client'),
      ('${F_A_2025}', '${CONTACT_A}', '/Receipts/', '2025', 'client'),
      ('${F_A_STATEMENTS}', '${CONTACT_A}', '/', 'Statements', 'owner'),
      ('${F_B_RECEIPTS}', '${CONTACT_B}', '/', 'Receipts', 'client');
    ${doc(D_A_UPLOAD, CONTACT_A, 'client', '/Receipts/', 'receipt.pdf')}
    ${doc(D_A_DEEP, CONTACT_A, 'client', '/Receipts/2025/', 'march.pdf')}
    ${doc(D_A_ROOT, CONTACT_A, 'client', '/', 'id.pdf')}
    ${doc(D_A_SHARED, CONTACT_A, 'owner', '/Statements/', 'statement.pdf', CONTACT_H)}
    ${doc(D_A_OWNER, CONTACT_A, 'owner', '/', 'welcome.pdf')}
    ${doc(D_B_UPLOAD, CONTACT_B, 'client', '/Receipts/', 'b.pdf')}
    INSERT INTO public.document_annotations (id, document_id, page_index, kind, data)
      VALUES ('${ANNOTATION}', '${D_A_UPLOAD}', 0, 'text', '{"text":"checked"}');
    INSERT INTO storage.objects (bucket_id, name) VALUES ('client-documents', '${CONTACT_A}/2025/${D_A_UPLOAD}.pdf.enc');
  `);
}, 60_000);

const count = (who: Principal, table: string, where?: string) => countRows(db, who, table, where);
const ids = async (who: Principal, table: string, where = 'true') =>
  (await as<{ id: string }>(db, who, `SELECT id FROM public.${table} WHERE ${where} ORDER BY id`)).map((r) => r.id);

/** Set up as the server, then run `sql` as `who`; rolled back. Resolves to the rows RETURNING gave. */
async function asAfter<T = Record<string, unknown>>(setup: string, who: Principal, sql: string, params: unknown[] = []): Promise<T[]> {
  return session(db, service, async (tx) => {
    if (setup) await tx.exec(setup);
    await become(tx, who);
    return (await tx.query<T>(sql, params)).rows;
  });
}

describe('who reads what', () => {
  it('anon has no access to any documents table', async () => {
    for (const t of TABLES) expect(await errorOf(db, anon, `SELECT 1 FROM public.${t}`), t).toMatch(/permission denied/);
  });

  it('the owner and the server read every row; a forged admin claim reads none', async () => {
    for (const t of TABLES) {
      const all = await count(service, t);
      expect(all, t).toBeGreaterThan(0);
      expect(await count(owner, t), t).toBe(all);
      expect(await count(forger, t), t).toBe(0);
    }
  });

  it('a client reads both sections of its own store and nothing of another contact', async () => {
    expect(await ids(clientA, 'client_documents')).toEqual([D_A_UPLOAD, D_A_DEEP, D_A_ROOT, D_A_SHARED, D_A_OWNER].sort());
    expect(await ids(clientA, 'client_folders')).toEqual([F_A_RECEIPTS, F_A_2025, F_A_STATEMENTS].sort());
    expect(await ids(clientB, 'client_documents')).toEqual([D_B_UPLOAD]);
    expect(await ids(clientB, 'client_folders')).toEqual([F_B_RECEIPTS]);
  });

  it('a household recipient reads the one shared document, and no folder', async () => {
    expect(await ids(household, 'client_documents')).toEqual([D_A_SHARED]);
    expect(await count(household, 'client_folders')).toBe(0);
  });

  it('annotations are invisible to every client', async () => {
    for (const who of [clientA, clientB, household]) expect(await count(who, 'document_annotations')).toBe(0);
  });

  it('get_contact_ids_with_documents lists every holder for the owner, and only itself for a client', async () => {
    const list = async (who: Principal) =>
      (await as<{ contact_id: string }>(db, who, 'SELECT contact_id FROM public.get_contact_ids_with_documents() ORDER BY 1')).map((r) => r.contact_id);
    expect(await list(owner)).toEqual([CONTACT_A, CONTACT_B]);
    expect(await list(clientA)).toEqual([CONTACT_A]);
    expect(await list(household)).toEqual([CONTACT_A]); // the shared row is visible, its contact id with it
    expect(await errorOf(db, anon, 'SELECT * FROM public.get_contact_ids_with_documents()')).toMatch(/permission denied/);
  });

  it('none of the documents tables is published to realtime', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`);
    for (const t of TABLES) expect(rows.map((r) => r.tablename)).not.toContain(t);
  });
});

describe('who writes documents', () => {
  it('a client never inserts a document row, in either section', async () => {
    for (const heldBy of ['client', 'owner']) {
      await expectDenied(as(db, clientA, doc('40000000-0000-4000-8000-0000000000c1', CONTACT_A, heldBy, '/', 'x.pdf')));
    }
  });

  it('the owner and the server insert', async () => {
    for (const who of [owner, service]) {
      expect(await errorOf(db, who, doc('40000000-0000-4000-8000-0000000000c1', CONTACT_A, 'owner', '/Statements/', 'x.pdf'))).toBeNull();
    }
  });

  it('a client renames and moves its own upload directly, and nothing else', async () => {
    expect(await as(db, clientA, `UPDATE public.client_documents SET original_filename = 'r.pdf' WHERE id = '${D_A_UPLOAD}' RETURNING id`))
      .toEqual([{ id: D_A_UPLOAD }]);
    expect(await as(db, clientA, `UPDATE public.client_documents SET folder_path = '/' WHERE id = '${D_A_UPLOAD}' RETURNING id`))
      .toEqual([{ id: D_A_UPLOAD }]);
    for (const [who, id] of [[clientA, D_A_OWNER], [clientA, D_A_SHARED], [clientA, D_B_UPLOAD], [household, D_A_SHARED]] as const) {
      expect(await as(db, who, `UPDATE public.client_documents SET original_filename = 'x.pdf' WHERE id = '${id}' RETURNING id`)).toEqual([]);
    }
  });

  it('a client changes no other column of its own upload', async () => {
    const sets = [
      `held_by = 'owner'`, `contact_id = '${CONTACT_B}'`, `shared_with_contact_id = '${CONTACT_H}'`, `reviewed_at = now()`,
      `reviewed_by = '${USER_A}'`, `description = 'x'`, `category = 'invoice'`, `storage_path = 'x'`, `filename = 'x'`,
      `file_size = 1`, `mime_type = 'text/plain'`, `encryption_status = 'none', encryption_iv = NULL`, `uploaded_by = '${USER_A}'`,
      `created_at = now() - interval '1 day'`,
    ];
    for (const set of sets) {
      const err = await expectDenied(as(db, clientA, `UPDATE public.client_documents SET ${set} WHERE id = '${D_A_UPLOAD}'`));
      expect(err.message, set).toMatch(/not client-writable/);
    }
  });

  it('a client deletes its own upload row, and no other row', async () => {
    expect(await as(db, clientA, `DELETE FROM public.client_documents WHERE id = '${D_A_UPLOAD}' RETURNING id`)).toEqual([{ id: D_A_UPLOAD }]);
    for (const [who, id] of [[clientA, D_A_OWNER], [clientA, D_A_SHARED], [clientA, D_B_UPLOAD], [household, D_A_SHARED]] as const) {
      expect(await as(db, who, `DELETE FROM public.client_documents WHERE id = '${id}' RETURNING id`)).toEqual([]);
    }
  });

  it('the owner shares, reviews and moves a document into the shared section', async () => {
    const rows = await as<{ held_by: string; folder_path: string; shared_with_contact_id: string; reviewed: boolean }>(db, owner,
      `UPDATE public.client_documents
          SET held_by = 'owner', folder_path = '/Statements/', shared_with_contact_id = '${CONTACT_H}',
              reviewed_at = now(), reviewed_by = '${OWNER}'
        WHERE id = '${D_A_UPLOAD}'
        RETURNING held_by, folder_path, shared_with_contact_id, reviewed_at IS NOT NULL AS reviewed`);
    expect(rows).toEqual([{ held_by: 'owner', folder_path: '/Statements/', shared_with_contact_id: CONTACT_H, reviewed: true }]);
  });

  it('a copy into the shared section shares the object and never the share', async () => {
    const rows = await session(db, owner, async (tx) => {
      await tx.exec(`
        INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type,
          folder_path, held_by, encryption_status, encryption_iv)
        SELECT contact_id, filename, original_filename, storage_path, file_size, mime_type, '/', 'owner', encryption_status, encryption_iv
          FROM public.client_documents WHERE id = '${D_A_UPLOAD}'`);
      return (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.client_documents
        WHERE storage_path = (SELECT storage_path FROM public.client_documents WHERE id = '${D_A_UPLOAD}')`)).rows[0].n;
    });
    expect(rows).toBe(2);
  });

  it('the row keeps its encryption honest and its sizes bounded', async () => {
    const bad = [
      `encryption_status = 'none'`, // still has an IV
      `encryption_iv = NULL`, // still says encrypted
      `shared_with_contact_id = contact_id`,
      `category = ''`, `category = repeat('x', 101)`, `description = repeat('x', 501)`,
      `file_size = 0`, `file_size = ${MAX_UPLOAD_BYTES + 17}`,
      `original_filename = 'a/b.pdf'`, `original_filename = 'a\\b.pdf'`, `original_filename = ''`,
      // Unicode format characters: a right-to-left override, a zero-width space, a tag.
      `original_filename = E'invoice\\u202Efdp.exe'`, `original_filename = E'a\\u200Bb.pdf'`, `original_filename = E'a\\U000E0041.pdf'`,
    ];
    for (const set of bad) expect(await errorOf(db, owner, `UPDATE public.client_documents SET ${set} WHERE id = '${D_A_UPLOAD}'`), set).toMatch(/check constraint/);
    expect(await errorOf(db, owner, `UPDATE public.client_documents SET file_size = ${MAX_UPLOAD_BYTES + 16} WHERE id = '${D_A_UPLOAD}'`)).toBeNull();
    expect(await errorOf(db, owner, `UPDATE public.client_documents SET held_by = 'other' WHERE id = '${D_A_OWNER}'`)).toMatch(/check constraint/);
  });
});

describe('who writes folders', () => {
  it('a client creates folders in its uploads only', async () => {
    expect(await errorOf(db, clientA, `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'New', 'client')`)).toBeNull();
    await expectDenied(as(db, clientA, `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'New', 'owner')`));
    await expectDenied(as(db, clientA, `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_B}', '/', 'New', 'client')`));
    await expectDenied(as(db, household, `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'New', 'client')`));
  });

  it('a client folder starts unreviewed and dated now: the review columns and created_at cannot be preset', async () => {
    const presets: Array<[string, string]> = [
      ['reviewed_at', 'now()'],
      ['reviewed_by', `'${OWNER}'`],
      ['created_at', `now() - interval '1 year'`],
    ];
    for (const [column, value] of presets) {
      await expectDenied(as(db, clientA,
        `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by, ${column}) VALUES ('${CONTACT_A}', '/', 'Preset', 'client', ${value})`));
    }
    // Without presets the same insert passes, so the refusals above are the presets'.
    expect(await errorOf(db, clientA,
      `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'Preset', 'client')`)).toBeNull();
    // The owner still files a folder already reviewed.
    expect(await errorOf(db, owner,
      `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by, reviewed_at, reviewed_by) VALUES ('${CONTACT_A}', '/', 'P4', 'client', now(), '${OWNER}')`)).toBeNull();
  });

  it('a client renames and deletes only its own upload folders', async () => {
    expect(await as(db, clientA, `UPDATE public.client_folders SET name = 'Bills' WHERE id = '${F_A_RECEIPTS}' RETURNING id`)).toEqual([{ id: F_A_RECEIPTS }]);
    for (const id of [F_A_STATEMENTS, F_B_RECEIPTS]) {
      expect(await as(db, clientA, `UPDATE public.client_folders SET name = 'x' WHERE id = '${id}' RETURNING id`)).toEqual([]);
      expect(await as(db, clientA, `DELETE FROM public.client_folders WHERE id = '${id}' RETURNING id`)).toEqual([]);
    }
  });

  it('a client deletes only an EMPTY folder directly; one with folders or documents in it is refused', async () => {
    // F_A_RECEIPTS holds a folder and a document; F_A_2025 holds a document.
    for (const id of [F_A_RECEIPTS, F_A_2025]) {
      expect(await errorOf(db, clientA, `DELETE FROM public.client_folders WHERE id = '${id}'`)).toMatch(/not empty/);
    }
    // Emptied first (its one document moved to the root), the same delete passes.
    const deleted = await session(db, clientA, async (tx) => {
      await tx.exec(`UPDATE public.client_documents SET folder_path = '/' WHERE id = '${D_A_DEEP}'`);
      return (await tx.query<{ id: string }>(`DELETE FROM public.client_folders WHERE id = '${F_A_2025}' RETURNING id`)).rows;
    });
    expect(deleted).toEqual([{ id: F_A_2025 }]);
    // The owner is not held to it (its delete path moves documents out first).
    expect(await errorOf(db, owner, `DELETE FROM public.client_folders WHERE id = '${F_A_2025}'`)).toBeNull();
  });

  it('a client cannot mark its folder reviewed or move it to another contact or section', async () => {
    for (const set of [`reviewed_at = now()`, `reviewed_by = '${USER_A}'`, `held_by = 'owner'`, `contact_id = '${CONTACT_B}'`, `created_at = now()`]) {
      const err = await expectDenied(as(db, clientA, `UPDATE public.client_folders SET ${set} WHERE id = '${F_A_RECEIPTS}'`));
      expect(err.message, set).toMatch(/not client-writable/);
    }
  });

  it('a folder stays in its contact and section, even for the owner', async () => {
    expect(await errorOf(db, owner, `UPDATE public.client_folders SET held_by = 'owner' WHERE id = '${F_A_2025}'`)).toMatch(/stays with its contact/);
  });

  it('folder names are one clean path segment', async () => {
    for (const name of ['', 'a/b', 'a\\b', '.', '..', ' padded', 'x'.repeat(101), 'tab\there', 'rep\u202Efdp', 'zero\u200Bwidth', 'tag\u{E0041}']) {
      expect(await errorOf(db, owner, `INSERT INTO public.client_folders (contact_id, name, held_by) VALUES ('${CONTACT_A}', $1, 'client')`, [name]), JSON.stringify(name))
        .toMatch(/check constraint/);
    }
  });
});

describe('path integrity', () => {
  it('a document lands only at the root or in an existing folder of its own section', async () => {
    for (const path of ['/Nowhere/', '/Statements/']) { // /Statements/ exists, but in the other section
      const err = await expectDenied(as(db, clientA, `UPDATE public.client_documents SET folder_path = $1 WHERE id = '${D_A_UPLOAD}'`, [path]), 'P0002');
      expect(err.message).toMatch(/Destination folder not found/);
    }
    await expectDenied(as(db, service, doc('40000000-0000-4000-8000-0000000000c1', CONTACT_B, 'client', '/Receipts/2025/', 'x.pdf')), 'P0002');
    // Malformed paths: the placement trigger or the CHECK refuses them, whichever runs first.
    for (const path of ['Receipts', 'Receipts/', '/../', '/a//']) {
      expect(await errorOf(db, owner, `UPDATE public.client_documents SET folder_path = $1 WHERE id = '${D_A_UPLOAD}'`, [path]), path).toBeTruthy();
    }
  });

  it('a folder needs an existing parent and never moves into its own subtree', async () => {
    await expectDenied(as(db, clientA, `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/Nowhere/', 'x', 'client')`), 'P0002');
    const err = await expectDenied(as(db, owner, `UPDATE public.client_folders SET parent_path = '/Receipts/2025/' WHERE id = '${F_A_RECEIPTS}'`), '22023');
    expect(err.message).toMatch(/cannot move into itself/);
  });

  it('a bare rename by a client carries the whole subtree with it', async () => {
    const out = await asAfter('', clientA, `
      WITH r AS (UPDATE public.client_folders SET name = 'Bills' WHERE id = '${F_A_RECEIPTS}' RETURNING id)
      SELECT 1`);
    expect(out).toHaveLength(1);
    const after = await session(db, clientA, async (tx) => {
      await tx.exec(`UPDATE public.client_folders SET name = 'Bills' WHERE id = '${F_A_RECEIPTS}'`);
      const f = (await tx.query<{ parent_path: string }>(`SELECT parent_path FROM public.client_folders WHERE id = '${F_A_2025}'`)).rows[0];
      const d = (await tx.query<{ id: string; folder_path: string }>(
        `SELECT id, folder_path FROM public.client_documents WHERE id IN ('${D_A_UPLOAD}', '${D_A_DEEP}') ORDER BY id`)).rows;
      return { f, d };
    });
    expect(after.f.parent_path).toBe('/Bills/');
    expect(after.d).toEqual([{ id: D_A_UPLOAD, folder_path: '/Bills/' }, { id: D_A_DEEP, folder_path: '/Bills/2025/' }]);
  });

  it('a rename touches only its own section: the same path in the other section stays', async () => {
    const out = await session(db, owner, async (tx) => {
      await tx.exec(`INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'Receipts', 'owner')`);
      await tx.exec(`UPDATE public.client_documents SET folder_path = '/Receipts/' WHERE id = '${D_A_OWNER}'`);
      await tx.exec(`UPDATE public.client_folders SET name = 'Bills' WHERE id = '${F_A_RECEIPTS}'`);
      return (await tx.query<{ folder_path: string }>(`SELECT folder_path FROM public.client_documents WHERE id = '${D_A_OWNER}'`)).rows[0];
    });
    expect(out.folder_path).toBe('/Receipts/');
  });
});

describe('the RPCs', () => {
  it('client_document_rename: own uploads for a client, any row for the owner', async () => {
    expect(await errorOf(db, clientA, 'SELECT public.client_document_rename($1, $2)', [D_A_UPLOAD, '  renamed.pdf  '])).toBeNull();
    expect(await errorOf(db, owner, 'SELECT public.client_document_rename($1, $2)', [D_A_OWNER, 'renamed.pdf'])).toBeNull();
    for (const id of [D_A_OWNER, D_A_SHARED, D_B_UPLOAD, '40000000-0000-4000-8000-0000000000ff']) {
      await expectDenied(as(db, clientA, 'SELECT public.client_document_rename($1, $2)', [id, 'x.pdf']), 'P0002');
    }
    await expectDenied(as(db, household, 'SELECT public.client_document_rename($1, $2)', [D_A_SHARED, 'x.pdf']), 'P0002');
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'x'.repeat(256), null]) {
      await expectDenied(as(db, clientA, 'SELECT public.client_document_rename($1, $2)', [D_A_UPLOAD, bad]), '22023');
    }
    const [{ original_filename }] = await session(db, clientA, async (tx) => {
      await tx.query('SELECT public.client_document_rename($1, $2)', [D_A_UPLOAD, '  renamed.pdf  ']);
      return (await tx.query<{ original_filename: string }>(`SELECT original_filename FROM public.client_documents WHERE id = $1`, [D_A_UPLOAD])).rows;
    });
    expect(original_filename).toBe('renamed.pdf');
  });

  it('client_document_move: into an existing folder of the same section only', async () => {
    expect(await errorOf(db, clientA, 'SELECT public.client_document_move($1, $2)', [D_A_ROOT, '/Receipts/2025/'])).toBeNull();
    await expectDenied(as(db, clientA, 'SELECT public.client_document_move($1, $2)', [D_A_ROOT, '/Statements/']), 'P0002');
    await expectDenied(as(db, clientA, 'SELECT public.client_document_move($1, $2)', [D_B_UPLOAD, '/Receipts/']), 'P0002');
    await expectDenied(as(db, clientA, 'SELECT public.client_document_move($1, $2)', [D_A_OWNER, '/Statements/']), 'P0002');
    for (const bad of ['Receipts/', '/Receipts', '', null]) {
      await expectDenied(as(db, clientA, 'SELECT public.client_document_move($1, $2)', [D_A_ROOT, bad]), '22023');
    }
    expect(await errorOf(db, owner, 'SELECT public.client_document_move($1, $2)', [D_A_OWNER, '/Statements/'])).toBeNull();
  });

  it('rename_client_folder: rewrites the subtree, refuses a collision and another section', async () => {
    const after = await session(db, clientA, async (tx) => {
      await tx.query('SELECT public.rename_client_folder($1, $2)', [F_A_RECEIPTS, 'Bills']);
      return (await tx.query<{ folder_path: string }>(`SELECT folder_path FROM public.client_documents WHERE id = $1`, [D_A_DEEP])).rows[0];
    });
    expect(after.folder_path).toBe('/Bills/2025/');
    expect(await errorOf(db, clientA, 'SELECT public.rename_client_folder($1, $2)', [F_A_RECEIPTS, 'Receipts'])).toBeNull(); // same name: no-op
    const collision = await session(db, clientA, async (tx) => {
      await tx.exec(`INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'Bills', 'client')`);
      return tryIn(tx, 'SELECT public.rename_client_folder($1, $2)', [F_A_RECEIPTS, 'Bills']);
    });
    expect(collision).toMatch(/already exists/);
    await expectDenied(as(db, clientA, 'SELECT public.rename_client_folder($1, $2)', [F_A_STATEMENTS, 'x']), 'P0002');
    await expectDenied(as(db, clientA, 'SELECT public.rename_client_folder($1, $2)', [F_B_RECEIPTS, 'x']), 'P0002');
    await expectDenied(as(db, clientA, 'SELECT public.rename_client_folder($1, $2)', [F_A_RECEIPTS, 'a/b']), '22023');
    expect(await errorOf(db, owner, 'SELECT public.rename_client_folder($1, $2)', [F_A_STATEMENTS, 'Reports'])).toBeNull();
  });

  it('move_client_folder: the owner only; never into itself or onto a sibling of the same name', async () => {
    await expectDenied(as(db, clientA, 'SELECT public.move_client_folder($1, $2)', [F_A_2025, '/']));
    const after = await session(db, owner, async (tx) => {
      await tx.query('SELECT public.move_client_folder($1, $2)', [F_A_2025, '/']);
      return (await tx.query<{ folder_path: string }>(`SELECT folder_path FROM public.client_documents WHERE id = $1`, [D_A_DEEP])).rows[0];
    });
    expect(after.folder_path).toBe('/2025/');
    await expectDenied(as(db, owner, 'SELECT public.move_client_folder($1, $2)', [F_A_RECEIPTS, '/Receipts/2025/']), '22023');
    await expectDenied(as(db, owner, 'SELECT public.move_client_folder($1, $2)', [F_A_RECEIPTS, '/Nowhere/']), 'P0002');
    await expectDenied(as(db, owner, 'SELECT public.move_client_folder($1, $2)', [F_A_RECEIPTS, 'Receipts']), '22023');
    const collision = await session(db, owner, async (tx) => {
      await tx.exec(`INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', '2025', 'client')`);
      return tryIn(tx, 'SELECT public.move_client_folder($1, $2)', [F_A_2025, '/']);
    });
    expect(collision).toMatch(/already exists/);
  });

  it('admin_client_folder_remove: the owner only; folders go, documents move to the root, objects stay', async () => {
    await expectDenied(as(db, clientA, 'SELECT public.admin_client_folder_remove($1)', [F_A_RECEIPTS]));
    const out = await session(db, owner, async (tx) => {
      const result = (await tx.query<{ r: unknown }>('SELECT public.admin_client_folder_remove($1) AS r', [F_A_RECEIPTS])).rows[0].r;
      const docs = (await tx.query<{ id: string; folder_path: string }>(
        `SELECT id, folder_path FROM public.client_documents WHERE id IN ('${D_A_UPLOAD}', '${D_A_DEEP}') ORDER BY id`)).rows;
      const folders = (await tx.query<{ id: string }>(`SELECT id FROM public.client_folders WHERE contact_id = '${CONTACT_A}' ORDER BY id`)).rows;
      await tx.exec('RESET ROLE');
      const objects = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'client-documents'`)).rows[0].n;
      return { result, docs, folders, objects };
    });
    expect(out.result).toEqual({ folders_deleted: 2, documents_moved: 2 });
    expect(out.docs).toEqual([{ id: D_A_UPLOAD, folder_path: '/' }, { id: D_A_DEEP, folder_path: '/' }]);
    expect(out.folders.map((f) => f.id)).toEqual([F_A_STATEMENTS]);
    expect(out.objects).toBe(1);
  });

  it('portal_folder_purge: a client drops its own rows, logs each one, and never another section or contact', async () => {
    const out = await session(db, clientA, async (tx) => {
      await tx.query('SELECT public.portal_folder_purge($1)', [F_A_RECEIPTS]);
      const left = (await tx.query<{ id: string }>(`SELECT id FROM public.client_documents ORDER BY id`)).rows.map((r) => r.id);
      const folders = (await tx.query<{ id: string }>(`SELECT id FROM public.client_folders ORDER BY id`)).rows.map((r) => r.id);
      await tx.exec('RESET ROLE');
      const log = (await tx.query<{ user_id: string; details: Record<string, unknown> }>(
        `SELECT user_id, details FROM public.client_activity_log WHERE action = 'document_delete' ORDER BY details->>'document_id'`)).rows;
      const objects = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects`)).rows[0].n;
      return { left, folders, log, objects };
    });
    expect(out.left).toEqual([D_A_ROOT, D_A_SHARED, D_A_OWNER].sort());
    expect(out.folders).toEqual([F_A_STATEMENTS]);
    expect(out.log).toEqual([
      { user_id: USER_A, details: { document_id: D_A_UPLOAD, filename: 'receipt.pdf', actor_role: 'client' } },
      { user_id: USER_A, details: { document_id: D_A_DEEP, filename: 'march.pdf', actor_role: 'client' } },
    ]);
    expect(out.objects).toBe(1);
    await expectDenied(as(db, clientA, 'SELECT public.portal_folder_purge($1)', [F_A_STATEMENTS]), 'P0002');
    await expectDenied(as(db, clientA, 'SELECT public.portal_folder_purge($1)', [F_B_RECEIPTS]), 'P0002');
  });

  it('portal_folder_purge empties a deep subtree for a client, one level at a time (each folder empty when deleted)', async () => {
    const out = await session(db, clientA, async (tx) => {
      // Receipts > 2025 > Q1 > March, with a document at the bottom: three levels under the root.
      await tx.exec(`
        INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/Receipts/2025/', 'Q1', 'client');
        INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/Receipts/2025/Q1/', 'March', 'client');
        UPDATE public.client_documents SET folder_path = '/Receipts/2025/Q1/March/' WHERE id = '${D_A_DEEP}';`);
      await tx.query('SELECT public.portal_folder_purge($1)', [F_A_RECEIPTS]);
      return (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.client_folders WHERE held_by = 'client' AND contact_id = '${CONTACT_A}'`)).rows[0].n;
    });
    expect(out).toBe(0);
  });

  it('portal_folder_purge by the owner writes no client activity', async () => {
    const n = await session(db, owner, async (tx) => {
      await tx.query('SELECT public.portal_folder_purge($1)', [F_A_RECEIPTS]);
      await tx.exec('RESET ROLE');
      return (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.client_activity_log`)).rows[0].n;
    });
    expect(n).toBe(0);
  });

  it('mark_client_folder_reviewed: the owner only; stamps the unreviewed subtree and keeps earlier stamps', async () => {
    await expectDenied(as(db, clientA, 'SELECT public.mark_client_folder_reviewed($1)', [F_A_RECEIPTS]));
    const out = await session(db, owner, async (tx) => {
      await tx.exec(`UPDATE public.client_documents SET reviewed_at = '2020-01-01', reviewed_by = '${OWNER}' WHERE id = '${D_A_DEEP}'`);
      const r = (await tx.query<{ r: { folders_marked: number; document_ids: string[] } }>(
        'SELECT public.mark_client_folder_reviewed($1) AS r', [F_A_RECEIPTS])).rows[0].r;
      const rows = (await tx.query<{ id: string; at: string; by: string }>(
        `SELECT id, reviewed_at::date::text AS at, reviewed_by AS by FROM public.client_documents
          WHERE id IN ('${D_A_UPLOAD}', '${D_A_DEEP}', '${D_A_ROOT}') ORDER BY id`)).rows;
      return { r, rows };
    });
    expect(out.r).toEqual({ folders_marked: 2, document_ids: [D_A_UPLOAD] });
    expect(out.rows[0]).toMatchObject({ id: D_A_UPLOAD, by: OWNER });
    expect(out.rows[1]).toEqual({ id: D_A_DEEP, at: '2020-01-01', by: OWNER });
    expect(out.rows[2]).toEqual({ id: D_A_ROOT, at: null, by: null });
  });
});

describe('names that look like patterns match only themselves', () => {
  // Siblings whose names a LIKE pattern would confuse: 'a_b' matches 'aXb', 'a%' matches 'ab'
  // and 'a%b'. (A backslash, LIKE's escape character, cannot be in a name at all.)
  const SIBLINGS = ['a_b', 'aXb', 'a%', 'ab', 'a%b'];
  const seed = `
    INSERT INTO public.client_folders (contact_id, parent_path, name, held_by)
      SELECT '${CONTACT_B}', '/', n, 'client' FROM unnest($1::text[]) n;
    INSERT INTO public.client_folders (contact_id, parent_path, name, held_by)
      SELECT '${CONTACT_B}', '/' || n || '/', 'inner', 'client' FROM unnest($1::text[]) n;`;

  const run = async (fn: (tx: Parameters<Parameters<typeof session>[2]>[0], idOf: (n: string) => Promise<string>) => Promise<void>) =>
    session(db, owner, async (tx) => {
      for (const stmt of seed.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(stmt, [SIBLINGS]);
      for (const n of SIBLINGS) {
        await tx.query(`
          INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type, folder_path, held_by)
          VALUES ('${CONTACT_B}', 'f', 'f.txt', 'p', 1, 'text/plain', '/' || $1 || '/inner/', 'client')`, [n]);
      }
      const idOf = async (n: string) =>
        (await tx.query<{ id: string }>(`SELECT id FROM public.client_folders WHERE contact_id = '${CONTACT_B}' AND parent_path = '/' AND name = $1`, [n])).rows[0].id;
      await fn(tx, idOf);
      const paths = (await tx.query<{ p: string }>(
        `SELECT folder_path AS p FROM public.client_documents WHERE contact_id = '${CONTACT_B}' AND original_filename = 'f.txt' ORDER BY 1`)).rows.map((r) => r.p);
      paths.sort();
      return paths;
    });

  it('rename, move, remove and mark-reviewed leave every look-alike sibling alone', async () => {
    const untouched = (except: string, to: string | null) =>
      SIBLINGS.map((n) => (n === except ? to : `/${n}/inner/`)).filter((p): p is string => p !== null).sort();

    for (const target of SIBLINGS) {
      const renamed = await run(async (tx, idOf) => {
        await tx.query('SELECT public.rename_client_folder($1, $2)', [await idOf(target), 'renamed']);
      });
      expect(renamed, `rename ${target}`).toEqual(untouched(target, '/renamed/inner/'));

      const removed = await run(async (tx, idOf) => {
        await tx.query('SELECT public.admin_client_folder_remove($1)', [await idOf(target)]);
      });
      expect(removed, `remove ${target}`).toEqual(untouched(target, '/'));

      const purged = await run(async (tx, idOf) => {
        await tx.query('SELECT public.portal_folder_purge($1)', [await idOf(target)]);
      });
      expect(purged, `purge ${target}`).toEqual(untouched(target, null));
    }

    const marked = await session(db, owner, async (tx) => {
      for (const stmt of seed.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(stmt, [SIBLINGS]);
      const id = (await tx.query<{ id: string }>(`SELECT id FROM public.client_folders WHERE contact_id = '${CONTACT_B}' AND parent_path = '/' AND name = 'a_b'`)).rows[0].id;
      return (await tx.query<{ r: { folders_marked: number } }>('SELECT public.mark_client_folder_reviewed($1) AS r', [id])).rows[0].r;
    });
    expect(marked.folders_marked).toBe(2); // a_b and its inner folder, never aXb's
  });
});

describe('View as client is read-only', () => {
  const MINTED = '60000000-0000-4000-8000-0000000000a1';
  const bind = `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
                VALUES ('${OWNER}', '${CONTACT_A}', '${USER_A}', 'a@example.test', '${MINTED}');
                INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ('${CONTACT_A}', '/', 'Empty', 'client');`;
  const minted = user(USER_A, { sessionId: MINTED });
  const writes: Array<[string, string, unknown[]]> = [
    ['rename a document', `UPDATE public.client_documents SET original_filename = 'x.pdf' WHERE id = $1`, [D_A_UPLOAD]],
    ['delete a document', `DELETE FROM public.client_documents WHERE id = $1`, [D_A_UPLOAD]],
    ['create a folder', `INSERT INTO public.client_folders (contact_id, name, held_by) VALUES ($1, 'x', 'client')`, [CONTACT_A]],
    ['rename a folder', `UPDATE public.client_folders SET name = 'x' WHERE id = $1`, [F_A_RECEIPTS]],
    // An empty one: a client may delete only an empty folder (trg_client_folders_delete_empty).
    ['delete a folder', `DELETE FROM public.client_folders WHERE contact_id = $1 AND parent_path = '/' AND name = 'Empty'`, [CONTACT_A]],
    ['client_document_rename', 'SELECT public.client_document_rename($1, $2)', [D_A_UPLOAD, 'x.pdf']],
    ['client_document_move', 'SELECT public.client_document_move($1, $2)', [D_A_UPLOAD, '/']],
    ['rename_client_folder', 'SELECT public.rename_client_folder($1, $2)', [F_A_RECEIPTS, 'x']],
    ['portal_folder_purge', 'SELECT public.portal_folder_purge($1)', [F_A_RECEIPTS]],
  ];

  it.each(writes)('refuses: %s', async (_what, sql, params) => {
    const err = await expectDenied(asAfter(bind, minted, sql, params));
    expect(err.message).toBe('impersonation_read_only');
  });

  it('the same writes pass for the client on its own device', async () => {
    for (const [what, sql, params] of writes) {
      expect(await session(db, service, async (tx) => {
        await tx.exec(bind);
        await become(tx, clientA);
        return tryIn(tx, sql, params);
      }), what).toBeNull();
    }
  });

  it('still reads what the client reads', async () => {
    const rows = await asAfter<{ id: string }>(bind, minted, 'SELECT id FROM public.client_documents ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([D_A_UPLOAD, D_A_DEEP, D_A_ROOT, D_A_SHARED, D_A_OWNER].sort());
  });
});

describe('annotations', () => {
  it('the owner writes them; updated_at is the database’s', async () => {
    const rows = await session(db, owner, async (tx) => {
      await tx.exec(`INSERT INTO public.document_annotations (document_id, page_index, kind, data) VALUES ('${D_A_UPLOAD}', 1, 'ink', '{"points":[]}')`);
      await tx.exec(`SELECT pg_sleep(0.01)`);
      return (await tx.query<{ moved: boolean }>(
        `UPDATE public.document_annotations SET data = '{"text":"x"}', updated_at = '2000-01-01' WHERE id = '${ANNOTATION}' RETURNING updated_at = now() AS moved`)).rows;
    });
    expect(rows).toEqual([{ moved: true }]);
    expect(await as(db, owner, `DELETE FROM public.document_annotations WHERE id = '${ANNOTATION}' RETURNING id`)).toEqual([{ id: ANNOTATION }]);
  });

  it('no client writes one, even on its own document', async () => {
    await expectDenied(as(db, clientA, `INSERT INTO public.document_annotations (document_id, page_index, kind, data) VALUES ('${D_A_UPLOAD}', 0, 'ink', '{}')`));
    expect(await as(db, clientA, `UPDATE public.document_annotations SET data = '{}' RETURNING id`)).toEqual([]);
    expect(await as(db, clientA, `DELETE FROM public.document_annotations RETURNING id`)).toEqual([]);
  });

  it('bounds kind, page and size', async () => {
    const insert = (kind: string, page: number, data: string) => errorOf(db, owner,
      `INSERT INTO public.document_annotations (document_id, page_index, kind, data) VALUES ('${D_A_UPLOAD}', ${page}, '${kind}', '${data}')`);
    expect(await insert('scribble', 0, '{}')).toMatch(/check constraint/);
    expect(await insert('ink', 5000, '{}')).toMatch(/check constraint/);
    expect(await insert('ink', 0, '[]')).toMatch(/check constraint/);
    expect(await errorOf(db, owner, `INSERT INTO public.document_annotations (document_id, page_index, kind, data)
      VALUES ('${D_A_UPLOAD}', 0, 'ink', jsonb_build_object('x', (SELECT string_agg(md5(i::text), '') FROM generate_series(1, 3000) i)))`))
      .toMatch(/check constraint/);
  });

  it('go with their document', async () => {
    const n = await session(db, owner, async (tx) => {
      await tx.exec(`DELETE FROM public.client_documents WHERE id = '${D_A_UPLOAD}'`);
      return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.document_annotations')).rows[0].n;
    });
    expect(n).toBe(0);
  });
});

describe('the documents bucket', () => {
  const OBJECT = `${CONTACT_A}/2025/${D_A_UPLOAD}.pdf.enc`;

  it('is private, sized for one upload plus its tag, and takes the upload types plus octet-stream', async () => {
    const { rows } = await db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      `SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'client-documents'`);
    expect(rows[0].public).toBe(false);
    expect(Number(rows[0].file_size_limit)).toBe(MAX_UPLOAD_BYTES + 16);
    expect([...rows[0].allowed_mime_types].sort()).toEqual([...ALLOWED_UPLOAD_MIME_TYPES, 'application/octet-stream'].sort());
  });

  it('the owner reads its objects; no client does, not even under its own contact id', async () => {
    const read = (who: Principal) => as<{ name: string }>(db, who, `SELECT name FROM storage.objects WHERE bucket_id = 'client-documents'`);
    expect((await read(owner)).map((r) => r.name)).toEqual([OBJECT]);
    for (const who of [clientA, clientB, household, forger]) expect(await read(who)).toEqual([]);
    expect(await read(anon)).toEqual([]);
  });

  it('nobody signed in writes or deletes an object, the owner included', async () => {
    for (const who of [owner, clientA]) {
      await expectDenied(as(db, who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('client-documents', '${CONTACT_A}/x.enc')`));
      expect(await as(db, who, `UPDATE storage.objects SET name = 'moved' WHERE bucket_id = 'client-documents' RETURNING id`)).toEqual([]);
      expect(await as(db, who, `DELETE FROM storage.objects WHERE bucket_id = 'client-documents' RETURNING id`)).toEqual([]);
    }
  });

  it('the owner policy reaches no other bucket', async () => {
    const names = await session(db, service, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec(`INSERT INTO storage.buckets (id, name) VALUES ('zz-other', 'zz-other');
                     INSERT INTO storage.objects (bucket_id, name) VALUES ('zz-other', 'secret.pdf');`);
      await become(tx, owner);
      return (await tx.query<{ name: string }>(`SELECT name FROM storage.objects WHERE bucket_id = 'zz-other'`)).rows;
    });
    expect(names).toEqual([]);
  });
});

describe('deleting a contact', () => {
  it('drops its rows and strands its objects for the orphan report, never deleting one', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`DELETE FROM public.contacts WHERE id = '${CONTACT_A}'`);
      const rows = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.client_documents WHERE contact_id = '${CONTACT_A}'`)).rows[0].n;
      const objects = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'client-documents'`)).rows[0].n;
      return { rows, objects };
    });
    expect(out).toEqual({ rows: 0, objects: 1 });
  });

  it('a share to a deleted contact is cleared, never the document', async () => {
    const row = await session(db, service, async (tx) => {
      await tx.exec(`DELETE FROM public.contacts WHERE id = '${CONTACT_H}'`);
      return (await tx.query<{ shared_with_contact_id: string | null }>(
        `SELECT shared_with_contact_id FROM public.client_documents WHERE id = '${D_A_SHARED}'`)).rows;
    });
    expect(row).toEqual([{ shared_with_contact_id: null }]);
  });
});
