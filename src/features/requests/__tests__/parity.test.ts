// @vitest-environment node
// The browser and the database must agree on what "answered" means: listProgress
// (lib/requests.ts) against public.needs_list_progress (0005), over the same items in
// PGlite. Also: the folder name the portal makes is one the database accepts, and the
// pick-list key every new item defaults to is seeded as a built-in row.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../../../__tests__/db/harness';
import { listProgress, newDraftItem, requestFolderName, type RequestItem } from '../lib/requests';

let db: PGlite;
let contactId: string;
let docId: string;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactId = await seedContact(db, { first_name: 'Ada' });
  docId = (await db.query<{ id: string }>(
    `INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type)
     VALUES ($1, 'a.pdf', 'a.pdf', 'p', 1, 'application/pdf') RETURNING id`, [contactId])).rows[0].id;
}, 60_000);

interface Case {
  kind: RequestItem['kind'];
  status: RequestItem['status'];
  required: boolean;
  answer_text?: string | null;
  sensitive?: boolean;
  secret?: boolean;
  file?: boolean;
}

// Every kind crossed with every status and every kind of evidence.
const CASES: Case[] = [];
for (const kind of ['document', 'question', 'todo', 'info'] as const) {
  for (const status of ['pending', 'fulfilled', 'reviewed'] as const) {
    for (const required of [true, false]) {
      if (kind === 'document') CASES.push({ kind, status, required, file: true }, { kind, status, required, file: false });
      else if (kind === 'question') {
        for (const answer_text of [null, '', '  \n ', 'Yes']) CASES.push({ kind, status, required, answer_text });
        CASES.push({ kind, status, required, sensitive: true, secret: true }, { kind, status, required, sensitive: true, secret: false });
      } else CASES.push({ kind, status, required, answer_text: kind === 'info' ? 'x' : null });
    }
  }
}

describe('fulfilment parity', () => {
  it('the browser and needs_list_progress count the same, list by list', async () => {
    const chunks = Array.from({ length: Math.ceil(CASES.length / 7) }, (_, i) => CASES.slice(i * 7, i * 7 + 7));
    for (const chunk of chunks) {
      const listId = (await db.query<{ id: string }>(
        `INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Parity', 'sent', now()) RETURNING id`, [contactId])).rows[0].id;
      const items: RequestItem[] = [];
      for (const [i, c] of chunk.entries()) {
        const id = (await db.query<{ id: string }>(
          `INSERT INTO public.needs_items (list_id, kind, label, required, status, answer_text, sensitive, answer_ciphertext, sort_order)
           VALUES ($1, $2, 'x', $3, $4, $5, $6, $7, $8) RETURNING id`,
          [listId, c.kind, c.required, c.status, c.sensitive ? null : c.answer_text ?? null, c.sensitive ?? false,
            c.secret ? new Uint8Array([1, 2]) : null, i])).rows[0].id;
        if (c.file) await db.query(`INSERT INTO public.needs_item_documents (item_id, document_id) VALUES ($1, $2)`, [id, docId]);
        items.push({
          id, list_id: listId, kind: c.kind, label: 'x', description: null, sort_order: i, required: c.required, status: c.status,
          answer_text: c.sensitive ? null : c.answer_text ?? null, sensitive: c.sensitive ?? false, has_secret_answer: c.secret ?? false,
          category: 'general', tag: 'general',
          documents: c.file ? [{ id: 'l', document_id: docId, uploaded_at: '2026-01-01T00:00:00Z', original_filename: 'a.pdf', mime_type: null }] : [],
        });
      }
      const [sql] = (await db.query<{ actionable: number; fulfilled: number; required_open: number }>(
        `SELECT actionable, fulfilled, required_open FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [listId])).rows;
      const browser = listProgress(items);
      expect({ actionable: browser.actionable, fulfilled: browser.fulfilled, required_open: browser.requiredOpen }, JSON.stringify(chunk)).toEqual(sql);
    }
  });
});

describe('what the database accepts', () => {
  it('takes the folder name the portal makes, for awkward titles', async () => {
    const titles = ['Plain', 'a/b\\c', 'tab\there', 'zero​width', '  ..  ', 'x'.repeat(300), 'Ünïcødé – dash'];
    for (const title of titles) {
      const name = requestFolderName({ title, sent_at: '2026-03-04T05:06:07Z', created_at: '2026-03-04T05:06:07Z' });
      await expect(db.query(
        `INSERT INTO public.client_folders (contact_id, parent_path, name, held_by) VALUES ($1, '/', $2, 'client')`, [contactId, name]),
      title).resolves.toBeDefined();
    }
  });

  it('seeds the key a new item defaults to as a built-in row of each list', async () => {
    const item = newDraftItem();
    for (const [table, key] of [['request_categories', item.category], ['request_tags', item.tag]] as const) {
      const { rows } = await db.query<{ is_system: boolean }>(`SELECT is_system FROM public.${table} WHERE key = $1`, [key]);
      expect(rows, table).toEqual([{ is_system: true }]);
    }
  });
});
