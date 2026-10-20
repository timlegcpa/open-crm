// @vitest-environment node
// 0005_requests and 0014_requests: who may read and write requests, their items, answers, item documents,
// the request pick-lists, templates and start links, and what the server functions refuse,
// by real policy evaluation in PGlite. Every fixture is fictional.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asOwner,
  asServer,
  become,
  becomeSuperuser,
  count,
  createDb,
  errorOf,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  SYSTEM_ID,
  user,
  type Principal,
} from './harness';

type Tx = Parameters<Parameters<typeof session>[2]>[0];

const TABLES = [
  'request_categories', 'request_tags', 'needs_lists', 'needs_items', 'needs_item_documents',
  'needs_templates', 'pending_signup_requests',
] as const;

const HASH = (c: string) => c.repeat(64).slice(0, 64);

let db: PGlite;
let contactA: string;
let contactB: string;
let clientA: string;
let clientB: string;
let draftA: string;
let sentA: string;
let closedA: string;
let sentB: string;
/** Items of sentA, by kind. */
let docItem: string;
let questionItem: string;
let secretItem: string;
let todoItem: string;
let infoItem: string;
let draftItem: string;
let itemB: string;
let docA: string;
let ownerDocA: string;
let docB: string;
let linkB: string;

const owner = asOwner;
const asA = (): Principal => user(clientA);
const asB = (): Principal => user(clientB);

async function list(contact: string, status: string, title = 'Year-end documents'): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO public.needs_lists (contact_id, title, status, created_by, sent_at)
     VALUES ($1, $2, $3::text, $4, CASE WHEN $3::text = 'draft' THEN NULL ELSE now() END) RETURNING id`,
    [contact, title, status, OWNER_ID])).rows[0].id;
}

async function item(listId: string, kind: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = { list_id: listId, kind, label: `A ${kind}`, ...fields };
  const cols = Object.keys(row);
  return (await db.query<{ id: string }>(
    `INSERT INTO public.needs_items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row))).rows[0].id;
}

async function doc(contact: string, heldBy: 'client' | 'owner'): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type, held_by)
     VALUES ($1::uuid, 'f.pdf', 'f.pdf', $1::text || '/f.pdf', 10, 'application/pdf', $2) RETURNING id`,
    [contact, heldBy])).rows[0].id;
}

const versionOf = async (tx: Tx, id: string) =>
  (await tx.query<{ v: number }>(`SELECT content_version AS v FROM public.needs_lists WHERE id = $1`, [id])).rows[0].v;

/** Whether this transaction holds a lock on the row: a row lock stamps the row's xmax with the locker. */
const lockedByMe = async (tx: Tx, table: string, id: string) =>
  (await tx.query<{ mine: boolean }>(
    `SELECT xmax::text = (txid_current() % 4294967296)::text AS mine FROM public.${table} WHERE id = $1`, [id])).rows[0].mine;

/**
 * Inside a session: give signed-in sessions the item and list writes the migration does not
 * grant, then act as the owner, so a test reaches the triggers behind the grants (they must
 * hold if the grants ever widen). Rolled back with the session.
 */
async function widenGrants(tx: Tx): Promise<void> {
  await becomeSuperuser(tx);
  await tx.exec(`GRANT INSERT, UPDATE, DELETE ON public.needs_lists, public.needs_items TO authenticated`);
  await become(tx, owner);
}

/** Run `fn` under a savepoint and return its error (null when it succeeded), rolling back a failure. */
async function refusal(tx: Tx, fn: () => Promise<unknown>): Promise<{ message: string; code?: string } | null> {
  await tx.exec('SAVEPOINT r');
  try {
    await fn();
    await tx.exec('RELEASE SAVEPOINT r');
    return null;
  } catch (err) {
    await tx.exec('ROLLBACK TO SAVEPOINT r');
    return err as { message: string; code?: string };
  }
}

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactA = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', status: 'client', email: 'ada@example.com' });
  contactB = await seedContact(db, { first_name: 'Bo', last_name: 'Example', status: 'client' });
  clientA = (await seedPortalAccount(db, contactA, { email: 'ada@example.com' })).userId;
  clientB = (await seedPortalAccount(db, contactB)).userId;

  draftA = await list(contactA, 'draft', 'Draft only');
  sentA = await list(contactA, 'sent');
  closedA = await list(contactA, 'closed', 'Closed one');
  sentB = await list(contactB, 'sent');
  draftItem = await item(draftA, 'question');
  docItem = await item(sentA, 'document', { sort_order: 1 });
  questionItem = await item(sentA, 'question', { sort_order: 2 });
  secretItem = await item(sentA, 'question', { sort_order: 3, sensitive: true, required: false });
  todoItem = await item(sentA, 'todo', { sort_order: 4 });
  infoItem = await item(sentA, 'info', { sort_order: 5 });
  await item(closedA, 'question');
  itemB = await item(sentB, 'document');
  docA = await doc(contactA, 'client');
  ownerDocA = await doc(contactA, 'owner');
  docB = await doc(contactB, 'client');
  linkB = (await db.query<{ id: string }>(
    `INSERT INTO public.needs_item_documents (item_id, document_id) VALUES ($1, $2) RETURNING id`, [itemB, docB])).rows[0].id;
  await db.query(`INSERT INTO public.needs_templates (name, items) VALUES ('Starter', '[{"kind":"todo","label":"Sign"}]')`);
  await db.query(
    `INSERT INTO public.pending_signup_requests (email, contact_id, needs_list_id, token_hash, expires_at)
     VALUES ('bo@example.com', $1, $2, $3, now() + interval '14 days')`, [contactB, sentB, HASH('b')]);
}, 60_000);

describe('who can read what', () => {
  it('anon reads and writes nothing here', async () => {
    for (const t of TABLES) await expectDenied(as(db, asAnon, `SELECT 1 FROM public.${t}`));
    await expectDenied(as(db, asAnon, `INSERT INTO public.needs_lists (contact_id, title) VALUES ($1, 'x')`, [contactA]));
  });

  it('the owner and the server read every row', async () => {
    for (const who of [owner, asServer]) {
      expect(await count(db, who, 'needs_lists')).toBe(4);
      expect(await count(db, who, 'needs_items')).toBe(8);
      expect(await count(db, who, 'needs_item_documents')).toBe(1);
      expect(await count(db, who, 'needs_templates')).toBe(1);
      expect(await count(db, who, 'pending_signup_requests')).toBe(1);
      expect(await count(db, who, 'request_categories')).toBe(6);
      expect(await count(db, who, 'request_tags')).toBe(3);
    }
  });

  it('a client reads its own lists once sent, never a draft, never another contact', async () => {
    const lists = await as<{ id: string }>(db, asA(), `SELECT id FROM public.needs_lists ORDER BY id`);
    expect(lists.map((r) => r.id).sort()).toEqual([sentA, closedA].sort());
    expect(await count(db, asA(), 'needs_items', `list_id = '${draftA}'`)).toBe(0);
    expect(await count(db, asA(), 'needs_items', `list_id = '${sentA}'`)).toBe(5);
    expect(await count(db, asA(), 'needs_items', `list_id = '${sentB}'`)).toBe(0);
    expect(await count(db, asA(), 'needs_item_documents')).toBe(0);
    expect(await count(db, asB(), 'needs_item_documents')).toBe(1);
  });

  it('a client reads none of the pick-lists, templates or start links', async () => {
    for (const t of ['request_categories', 'request_tags', 'needs_templates', 'pending_signup_requests']) {
      expect(await count(db, asA(), t), t).toBe(0);
    }
  });

  it('a session without its second factor reads nothing (the MFA gate)', async () => {
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [clientB]);
    try {
      expect(await count(db, user(clientB, { aal: 'aal1' }), 'needs_lists')).toBe(0);
      expect(await count(db, user(clientB, { aal: 'aal2' }), 'needs_lists')).toBe(1);
    } finally {
      await db.query(`DELETE FROM auth.mfa_factors WHERE user_id = $1`, [clientB]);
    }
  });

  it('needs_lists is in the realtime publication', async () => {
    const { rows } = await db.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename LIKE 'needs%'`);
    expect(rows.map((r) => r.t)).toEqual(['needs_lists']);
  });
});

describe('a client writes nothing directly', () => {
  it('inserts are refused on every table', async () => {
    await expectDenied(as(db, asA(), `INSERT INTO public.needs_lists (contact_id, title) VALUES ($1, 'x')`, [contactA]));
    await expectDenied(as(db, asA(), `INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'x')`, [sentA]));
    await expectDenied(as(db, asA(), `INSERT INTO public.needs_item_documents (item_id, document_id) VALUES ($1, $2)`, [docItem, docA]));
    await expectDenied(as(db, asA(), `INSERT INTO public.needs_templates (name) VALUES ('x')`));
    await expectDenied(as(db, asA(), `INSERT INTO public.request_tags (key, label) VALUES ('mine', 'Mine')`));
    await expectDenied(as(db, asA(),
      `INSERT INTO public.pending_signup_requests (email, token_hash, expires_at) VALUES ('a@example.com', $1, now())`, [HASH('c')]));
  });

  it('updates and deletes are refused or reach no row (answers, statuses, submit, links)', async () => {
    const denied = [
      `UPDATE public.needs_items SET answer_text = 'x', status = 'fulfilled' WHERE id = '${questionItem}' RETURNING id`,
      `DELETE FROM public.needs_lists WHERE id = '${sentA}' RETURNING id`,
      `DELETE FROM public.needs_items WHERE list_id = '${sentA}' RETURNING id`,
    ];
    for (const sql of denied) await expectDenied(as(db, asA(), sql));
    const none = [
      `UPDATE public.needs_items SET status = 'pending' WHERE list_id = '${sentA}' RETURNING id`,
      `UPDATE public.needs_lists SET status = 'submitted' WHERE id = '${sentA}' RETURNING id`,
    ];
    for (const sql of none) expect(await as(db, asA(), sql), sql).toEqual([]);
    expect(await as(db, asB(), `DELETE FROM public.needs_item_documents WHERE id = '${linkB}' RETURNING id`)).toEqual([]);
  });
});

describe('the pick-lists', () => {
  it('seeds general as the one built-in row of each list', async () => {
    for (const t of ['request_categories', 'request_tags']) {
      const { rows } = await db.query<{ key: string }>(`SELECT key FROM public.${t} WHERE is_system`);
      expect(rows.map((r) => r.key), t).toEqual(['general']);
    }
  });

  it('the owner adds, edits and removes its own rows, never a built-in one or a key', async () => {
    expect(await errorOf(db, owner, `INSERT INTO public.request_tags (key, label) VALUES ('family', 'Family')`)).toBeNull();
    await expectDenied(as(db, owner, `INSERT INTO public.request_tags (key, label, is_system) VALUES ('x', 'X', true)`));
    expect(await as(db, owner, `DELETE FROM public.request_categories WHERE key = 'general' RETURNING key`)).toEqual([]);
    // Even past RLS (the server), the guard keeps a built-in row.
    await expectDenied(as(db, asServer, `DELETE FROM public.request_categories WHERE key = 'general'`));
    await expectDenied(as(db, owner, `UPDATE public.request_categories SET key = 'renamed' WHERE key = 'invoice'`));
    expect(await as(db, owner, `UPDATE public.request_categories SET label = 'Invoices' WHERE key = 'invoice' RETURNING key`))
      .toEqual([{ key: 'invoice' }]);
    expect(await as(db, owner, `DELETE FROM public.request_categories WHERE key = 'receipt' RETURNING key`)).toEqual([{ key: 'receipt' }]);
  });

  it('a key an item uses cannot be deleted', async () => {
    const err = await errorOf(db, asServer, `DELETE FROM public.request_tags WHERE key = 'personal'`);
    expect(err).toBeNull(); // unused
    await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.needs_items SET tag = 'business' WHERE id = $1`, [questionItem]);
      await become(tx, owner);
      await tx.exec('SAVEPOINT s');
      await expect(tx.query(`DELETE FROM public.request_tags WHERE key = 'business'`)).rejects.toThrow(/foreign key/);
      await tx.exec('ROLLBACK TO SAVEPOINT s');
    });
  });
});

describe('status only moves forward, and only the server publishes', () => {
  it('the browser inserts no list (the builder save does); were it let, only a draft', async () => {
    await expectDenied(as(db, owner, `INSERT INTO public.needs_lists (contact_id, title) VALUES ($1, 'x')`, [contactA]));
    await session(db, owner, async (tx) => {
      await widenGrants(tx);
      expect((await refusal(tx, () => tx.query(
        `INSERT INTO public.needs_lists (contact_id, title, status) VALUES ($1, 'x', 'sent')`, [contactA])))?.code).toBe('42501');
      const { rows } = await tx.query<{ created_by: string; status: string }>(
        `INSERT INTO public.needs_lists (contact_id, title) VALUES ($1, 'x') RETURNING created_by, status`, [contactA]);
      expect(rows).toEqual([{ created_by: OWNER_ID, status: 'draft' }]);
    });
  });

  it('the owner cannot send or submit, or close a draft', async () => {
    await expectDenied(as(db, owner, `UPDATE public.needs_lists SET status = 'sent' WHERE id = $1`, [draftA]));
    await expectDenied(as(db, owner, `UPDATE public.needs_lists SET status = 'submitted' WHERE id = $1`, [sentA]));
    await expectDenied(as(db, owner, `UPDATE public.needs_lists SET status = 'closed' WHERE id = $1`, [draftA]));
    await expectDenied(as(db, owner, `UPDATE public.needs_lists SET status = 'draft' WHERE id = $1`, [sentA]));
    await expectDenied(as(db, owner, `UPDATE public.needs_lists SET status = 'sent' WHERE id = $1`, [closedA]));
  });

  it('the owner closes a sent list and pauses reminders; the server sends', async () => {
    expect(await as(db, owner, `UPDATE public.needs_lists SET status = 'closed' WHERE id = $1 RETURNING id`, [sentA])).toHaveLength(1);
    expect(await as(db, owner, `UPDATE public.needs_lists SET reminders_paused = true WHERE id = $1 RETURNING id`, [sentA])).toHaveLength(1);
    expect(await as(db, asServer, `UPDATE public.needs_lists SET status = 'sent' WHERE id = $1 RETURNING id`, [draftA])).toHaveLength(1);
    await expectDenied(as(db, asServer, `UPDATE public.needs_lists SET status = 'draft' WHERE id = $1`, [sentA]));
  });

  it('what the client reads is fixed once sent; the browser edits only status and pause', async () => {
    for (const id of [sentA, draftA]) {
      await expectDenied(as(db, owner, `UPDATE public.needs_lists SET title = 'Changed' WHERE id = $1`, [id]));
      await expectDenied(as(db, owner, `UPDATE public.needs_lists SET contact_id = $2 WHERE id = $1`, [id, contactB]));
      await expectDenied(as(db, owner, `UPDATE public.needs_lists SET content_version = 0 WHERE id = $1`, [id]));
    }
    // Behind the grants, the guard: a sent list's content stays, a draft's may change.
    await session(db, owner, async (tx) => {
      await widenGrants(tx);
      for (const sql of [
        `UPDATE public.needs_lists SET title = 'Changed' WHERE id = $1`,
        `UPDATE public.needs_lists SET intro_message = 'Hi' WHERE id = $1`,
        `UPDATE public.needs_lists SET contact_id = '${contactB}' WHERE id = $1`,
      ]) {
        expect((await refusal(tx, () => tx.query(sql, [sentA])))?.code, sql).toBe('42501');
      }
      expect(await refusal(tx, () => tx.query(`UPDATE public.needs_lists SET title = 'Changed' WHERE id = $1`, [draftA]))).toBeNull();
    });
  });
});

describe('items change only while their list is a draft', () => {
  it('the browser writes no item, of a sent list or a draft (the builder save does)', async () => {
    for (const [list, item] of [[sentA, todoItem], [draftA, draftItem]]) {
      await expectDenied(as(db, owner, `INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'x')`, [list]));
      await expectDenied(as(db, owner, `UPDATE public.needs_items SET label = 'New' WHERE id = $1`, [item]));
      await expectDenied(as(db, owner, `UPDATE public.needs_items SET required = false WHERE id = $1`, [item]));
      await expectDenied(as(db, owner, `DELETE FROM public.needs_items WHERE id = $1`, [item]));
    }
    await expectDenied(as(db, owner, `UPDATE public.needs_items SET list_id = $2 WHERE id = $1`, [draftItem, sentA]));
  });

  it('behind the grants, items change only on a draft and an answer is never the owner’s', async () => {
    await session(db, owner, async (tx) => {
      await widenGrants(tx);
      const refused = async (sql: string, params: unknown[]) =>
        expect((await refusal(tx, () => tx.query(sql, params)))?.code, sql).toBe('42501');
      await refused(`INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'x')`, [sentA]);
      await refused(`UPDATE public.needs_items SET label = 'New' WHERE id = $1`, [todoItem]);
      await refused(`DELETE FROM public.needs_items WHERE id = $1`, [todoItem]);
      await refused(`UPDATE public.needs_items SET list_id = $2 WHERE id = $1`, [draftItem, sentA]);
      await refused(`UPDATE public.needs_items SET list_id = $2 WHERE id = $1`, [todoItem, draftA]);
      await refused(`UPDATE public.needs_items SET answer_text = 'Rewritten' WHERE id = $1`, [questionItem]);
      await refused(`UPDATE public.needs_items SET answer_ciphertext = '\\x01' WHERE id = $1`, [secretItem]);
      await refused(`UPDATE public.needs_items SET answer_text = 'x' WHERE id = $1`, [draftItem]);
      expect(await refusal(tx, () => tx.query(`UPDATE public.needs_items SET label = 'Edited' WHERE id = $1`, [draftItem]))).toBeNull();
    });
  });

  it('the owner accepts an answer on a sent list', async () => {
    expect(await as(db, owner, `UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1 RETURNING id`, [todoItem])).toHaveLength(1);
  });

  it('an item holds one answer channel, by its sensitivity', async () => {
    expect(await errorOf(db, asServer, `UPDATE public.needs_items SET answer_text = 'x' WHERE id = $1`, [secretItem]))
      .toMatch(/needs_items_answer_channel/);
    expect(await errorOf(db, asServer, `UPDATE public.needs_items SET answer_ciphertext = '\\x01' WHERE id = $1`, [questionItem]))
      .toMatch(/needs_items_answer_channel/);
    expect(await errorOf(db, asServer, `UPDATE public.needs_items SET sensitive = true WHERE id = $1`, [todoItem]))
      .toMatch(/needs_items_sensitive_question_only/);
  });
});

describe('content_version moves on client-visible content only', () => {
  it('moves on an item added, removed, relabelled, on the title, and on the contact', async () => {
    await session(db, asServer, async (tx) => {
      const v0 = await versionOf(tx, draftA);
      await tx.query(`INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'a'), ($1, 'todo', 'b')`, [draftA]);
      const v1 = await versionOf(tx, draftA);
      expect(v1).toBe(v0 + 1); // once per statement
      await tx.query(`UPDATE public.needs_items SET label = 'c' WHERE id = $1`, [draftItem]);
      const v2 = await versionOf(tx, draftA);
      expect(v2).toBe(v1 + 1);
      await tx.query(`UPDATE public.needs_lists SET title = 'New title' WHERE id = $1`, [draftA]);
      const v3 = await versionOf(tx, draftA);
      expect(v3).toBe(v2 + 1);
      await tx.query(`DELETE FROM public.needs_items WHERE id = $1`, [draftItem]);
      const v4 = await versionOf(tx, draftA);
      expect(v4).toBe(v3 + 1);
      // A draft reassigned to another contact: a send that read the old contact publishes nothing.
      await tx.query(`UPDATE public.needs_lists SET contact_id = $2 WHERE id = $1`, [draftA, contactB]);
      expect(await versionOf(tx, draftA)).toBe(v4 + 1);
    });
  });

  it('never moves on an answer, an accept, a status or a reminder', async () => {
    await session(db, asServer, async (tx) => {
      const v0 = await versionOf(tx, sentA);
      await tx.query(`UPDATE public.needs_items SET answer_text = 'Yes', status = 'fulfilled' WHERE id = $1`, [questionItem]);
      await tx.query(`UPDATE public.needs_items SET answer_ciphertext = '\\x0102' WHERE id = $1`, [secretItem]);
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [todoItem]);
      await tx.query(`UPDATE public.needs_lists SET reminders_paused = true, reminder_count = 2 WHERE id = $1`, [sentA]);
      await tx.query(`UPDATE public.needs_lists SET status = 'submitted' WHERE id = $1`, [sentA]);
      expect(await versionOf(tx, sentA)).toBe(v0);
    });
  });
});

describe('sending', () => {
  it('needs_send_list publishes only at the version read, and names why not', async () => {
    await session(db, asServer, async (tx) => {
      const v = await versionOf(tx, draftA);
      const send = async (id: string, ver: number, contact = contactA, email = 'ada@example.com') =>
        (await tx.query<{ r: string }>(`SELECT public.needs_send_list($1, $2, $3, $4) AS r`, [id, ver, contact, email])).rows[0].r;
      expect(await send(draftA, v + 1)).toBe('changed');
      // The recipient the caller read: another contact, or an address the contact no longer has.
      expect(await send(draftA, v, contactB)).toBe('contact_changed');
      expect(await send(draftA, v, contactA, 'old@example.com')).toBe('address_changed');
      expect((await tx.query<{ status: string }>(`SELECT status FROM public.needs_lists WHERE id = $1`, [draftA])).rows[0].status).toBe('draft');
      expect(await send(draftA, v, contactA, ' ADA@example.com ')).toBe('sent');
      expect(await send(draftA, v)).toBe('already_sent');
      expect(await send(closedA, 0)).toBe('not_draft');
      expect(await send(randomUUID(), 0)).toBe('gone');
      const { rows } = await tx.query<{ sent_at: string | null }>(`SELECT sent_at FROM public.needs_lists WHERE id = $1`, [draftA]);
      expect(rows[0].sent_at).not.toBeNull();
    });
  });

  it('needs_claim_reminder takes the next count only from the count read; a failed one gives it back', async () => {
    await session(db, asServer, async (tx) => {
      type Claim = { status: string; previous?: string | null };
      const claim = async (id: string, n: number) =>
        (await tx.query<{ r: Claim }>(`SELECT public.needs_claim_reminder($1, $2) AS r`, [id, n])).rows[0].r;
      const release = async (id: string, n: number, previous: string | null) =>
        (await tx.query<{ r: boolean }>(`SELECT public.needs_release_reminder($1, $2, $3) AS r`, [id, n, previous])).rows[0].r;
      const countOf = async () => (await tx.query<{ n: number; at: string | null }>(
        `SELECT reminder_count AS n, last_reminded_at::text AS at FROM public.needs_lists WHERE id = $1`, [sentA])).rows[0];
      const first = await claim(sentA, 0);
      expect(first).toEqual({ status: 'claimed', previous: null });
      expect(await claim(sentA, 0)).toEqual({ status: 'in_progress' }); // a second reminder read the same count
      expect((await countOf()).n).toBe(1);
      expect((await countOf()).at).not.toBeNull();
      expect(await release(sentA, 0, first.previous ?? null)).toBe(true);
      // The failed reminder gave back its count AND its stamp: it never delays the next one.
      expect(await countOf()).toEqual({ n: 0, at: null });

      // An earlier stamp comes back at full precision.
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = '2026-01-02 03:04:05.123456+00' WHERE id = $1`, [sentA]);
      const earlier = (await countOf()).at;
      const again = await claim(sentA, 0);
      expect(again).toEqual({ status: 'claimed', previous: earlier });
      expect((await countOf()).at).not.toBe(earlier);
      expect(await release(sentA, 0, again.previous ?? null)).toBe(true);
      expect(await countOf()).toEqual({ n: 0, at: earlier });

      // A later reminder went: the stale release changes neither the count nor the stamp.
      const kept = await claim(sentA, 0);
      expect((await claim(sentA, 1)).status).toBe('claimed');
      const latest = await countOf();
      expect(await release(sentA, 0, kept.previous ?? null)).toBe(false);
      expect(await countOf()).toEqual(latest);
      expect(latest.n).toBe(2);
      expect(await claim(draftA, 0)).toEqual({ status: 'not_sent' });
      expect(await claim(closedA, 0)).toEqual({ status: 'not_sent' });
      expect(await claim(randomUUID(), 0)).toEqual({ status: 'not_sent' });
    });
  });
});

describe('the draft functions', () => {
  const ITEMS = JSON.stringify([
    { kind: 'document', label: 'Signed contract', category: 'contract' },
    { kind: 'question', label: 'Account number?', sensitive: true, required: false, sort_order: 1 },
  ]);

  it('needs_replace_draft replaces a draft and refuses anything else', async () => {
    await session(db, asServer, async (tx) => {
      const n = (await tx.query<{ n: number }>(
        `SELECT public.needs_replace_draft($1, 'Replaced', $2::jsonb, 'Intro', $3, true) AS n`, [draftA, ITEMS, contactA])).rows[0].n;
      expect(n).toBe(2);
      const { rows } = await tx.query<{ kind: string; category: string; tag: string; status: string }>(
        `SELECT kind, category, tag, status FROM public.needs_items WHERE list_id = $1 ORDER BY sort_order`, [draftA]);
      expect(rows).toEqual([
        { kind: 'document', category: 'contract', tag: 'general', status: 'pending' },
        { kind: 'question', category: 'general', tag: 'general', status: 'pending' },
      ]);
      const l = (await tx.query<{ title: string; include_contact_confirm: boolean }>(
        `SELECT title, include_contact_confirm FROM public.needs_lists WHERE id = $1`, [draftA])).rows[0];
      expect(l).toEqual({ title: 'Replaced', include_contact_confirm: true });
    });
    const call = (id: string, contact: string | null) =>
      as(db, asServer, `SELECT public.needs_replace_draft($1, 'x', '[]'::jsonb, NULL, $2)`, [id, contact]);
    await expect(call(sentA, null)).rejects.toThrow(/not_draft/);
    await expect(call(randomUUID(), null)).rejects.toThrow(/not_found/);
    await expect(call(draftA, contactB)).rejects.toThrow(/not_found/);
    await expect(as(db, asServer, `SELECT public.needs_replace_draft($1, 'x', '{}'::jsonb)`, [draftA])).rejects.toThrow(/array/);
  });

  it('needs_delete_draft deletes at the version read and audits ids and counts only', async () => {
    await session(db, asServer, async (tx) => {
      const v = await versionOf(tx, draftA);
      await tx.query(`SELECT public.needs_delete_draft($1, $2, $3, NULL, '192.0.2.1', 'agent')`, [draftA, contactA, v]);
      expect((await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [draftA])).rows).toHaveLength(0);
      const { rows } = await tx.query<{ user_id: string; action: string; details: Record<string, unknown> }>(
        `SELECT user_id, action, details FROM public.audit_logs WHERE action = 'needs_list_deleted'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(SYSTEM_ID);
      expect(Object.keys(rows[0].details).sort()).toEqual(
        ['contact_id', 'content_version', 'documents_deleted', 'item_count', 'list_id', 'source']);
      expect(JSON.stringify(rows[0].details)).not.toContain('Draft only');
    });
  });

  it('needs_delete_draft refuses a stale version, a sent list, a contact mismatch, an answer', async () => {
    const del = (id: string, contact: string, v: number) =>
      as(db, asServer, `SELECT public.needs_delete_draft($1, $2, $3, $4)`, [id, contact, v, OWNER_ID]);
    const v = (await db.query<{ v: number }>(`SELECT content_version AS v FROM public.needs_lists WHERE id = $1`, [draftA])).rows[0].v;
    await expect(del(draftA, contactA, v + 1)).rejects.toThrow(/stale_content/);
    await expect(del(draftA, contactB, v)).rejects.toThrow(/not_found/);
    await expect(del(sentA, contactA, 0)).rejects.toThrow(/not_draft/);
    await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.needs_items SET answer_text = 'x' WHERE id = $1`, [draftItem]);
      const now = await versionOf(tx, draftA);
      await tx.exec('SAVEPOINT s');
      await expect(tx.query(`SELECT public.needs_delete_draft($1, $2, $3, NULL)`, [draftA, contactA, now])).rejects.toThrow(/has_answers/);
      await tx.exec('ROLLBACK TO SAVEPOINT s');
      await tx.query(`UPDATE public.needs_items SET answer_text = NULL WHERE id = $1`, [draftItem]);
      const docItemDraft = (await tx.query<{ id: string }>(
        `INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'document', 'x') RETURNING id`, [draftA])).rows[0].id;
      await tx.query(`INSERT INTO public.needs_item_documents (item_id, document_id) VALUES ($1, $2)`, [docItemDraft, docA]);
      const later = await versionOf(tx, draftA);
      await expect(tx.query(`SELECT public.needs_delete_draft($1, $2, $3, NULL)`, [draftA, contactA, later])).rejects.toThrow(/has_documents/);
    });
  });
});

describe('needs_list_progress: the one fulfilment rule', () => {
  const progress = async (tx: Tx, id: string) => (await tx.query<{
    actionable: number; fulfilled: number; required_open: number;
  }>(`SELECT actionable, fulfilled, required_open FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [id])).rows[0];

  it('counts each kind by its own rule, and never info', async () => {
    await session(db, asServer, async (tx) => {
      expect(await progress(tx, sentA)).toEqual({ actionable: 4, fulfilled: 0, required_open: 3 });
      await tx.query(`UPDATE public.needs_items SET answer_text = '   ' WHERE id = $1`, [questionItem]);
      expect((await progress(tx, sentA)).fulfilled).toBe(0); // whitespace is no answer
      await tx.query(`UPDATE public.needs_items SET answer_text = 'Yes' WHERE id = $1`, [questionItem]);
      await tx.query(`UPDATE public.needs_items SET answer_ciphertext = '\\x01' WHERE id = $1`, [secretItem]);
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [todoItem]);
      expect(await progress(tx, sentA)).toEqual({ actionable: 4, fulfilled: 3, required_open: 1 });
      await tx.query(`UPDATE public.needs_items SET status = 'fulfilled' WHERE id = $1`, [docItem]);
      expect((await progress(tx, sentA)).required_open).toBe(1); // a document needs a file, not a status
      await tx.query(`INSERT INTO public.needs_item_documents (item_id, document_id) VALUES ($1, $2)`, [docItem, docA]);
      expect(await progress(tx, sentA)).toEqual({ actionable: 4, fulfilled: 4, required_open: 0 });
    });
  });

  it('answers a list with no actionable items with zeros', async () => {
    await session(db, asServer, async (tx) => {
      const empty = (await tx.query<{ id: string }>(
        `INSERT INTO public.needs_lists (contact_id, title) VALUES ($1, 'Empty') RETURNING id`, [contactA])).rows[0].id;
      expect(await progress(tx, empty)).toEqual({ actionable: 0, fulfilled: 0, required_open: 0 });
    });
  });
});

describe('a client writes through the server functions, guarded', () => {
  const one = async <T>(tx: Tx, sql: string, params: unknown[]) => (await tx.query<{ r: T }>(sql, params)).rows[0].r;
  const setAnswer = `SELECT public.needs_client_set_answer($1, $2, $3, $4) AS r`;

  it('needs_client_set_answer stores the answer only on its own open, unaccepted question', async () => {
    await session(db, asServer, async (tx) => {
      expect(await one(tx, setAnswer, [contactA, questionItem, 'Yes', null])).toBe('fulfilled');
      expect(await one(tx, setAnswer, [contactA, questionItem, null, null])).toBe('pending');
      expect(await one(tx, setAnswer, [contactB, questionItem, 'Yes', null])).toBeNull(); // not B's
      expect(await one(tx, setAnswer, [contactA, todoItem, 'Yes', null])).toBeNull(); // not a question
      expect(await one(tx, setAnswer, [contactA, draftItem, 'Yes', null])).toBeNull(); // a draft
      // A sensitive item takes only the ciphertext, whatever the caller passes.
      expect(await one(tx, setAnswer, [contactA, secretItem, 'plain', new Uint8Array([10, 11])])).toBe('fulfilled');
      const { rows } = await tx.query<{ answer_text: string | null }>(`SELECT answer_text FROM public.needs_items WHERE id = $1`, [secretItem]);
      expect(rows[0].answer_text).toBeNull();
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [questionItem]);
      expect(await one(tx, setAnswer, [contactA, questionItem, 'Changed', null])).toBeNull(); // accepted
      await tx.query(`UPDATE public.needs_lists SET status = 'submitted' WHERE id = $1`, [sentA]);
      expect(await one(tx, setAnswer, [contactA, secretItem, null, new Uint8Array([1])])).toBeNull(); // handed back
    });
  });

  it('needs_client_mark_todo ticks its own open to-do only', async () => {
    await session(db, asServer, async (tx) => {
      const mark = `SELECT public.needs_client_mark_todo($1, $2, $3) AS r`;
      expect(await one(tx, mark, [contactA, todoItem, true])).toBe('fulfilled');
      expect(await one(tx, mark, [contactA, todoItem, false])).toBe('pending');
      expect(await one(tx, mark, [contactB, todoItem, true])).toBeNull();
      expect(await one(tx, mark, [contactA, questionItem, true])).toBeNull();
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [todoItem]);
      expect(await one(tx, mark, [contactA, todoItem, false])).toBeNull();
    });
  });

  it('needs_client_link_document links only the caller’s own uploaded document', async () => {
    await session(db, asServer, async (tx) => {
      const link = `SELECT public.needs_client_link_document($1, $2, $3) AS r`;
      expect(await one(tx, link, [contactA, docItem, docB])).toBeNull(); // another contact's file
      expect(await one(tx, link, [contactA, docItem, ownerDocA])).toBeNull(); // the owner's section
      expect(await one(tx, link, [contactB, docItem, docB])).toBeNull(); // another contact's item
      expect(await one(tx, link, [contactA, questionItem, docA])).toBeNull(); // not a document item
      expect(await one(tx, link, [contactA, docItem, docA])).toBe('linked');
      expect(await one(tx, link, [contactA, docItem, docA])).toBe('already_linked');
      const { rows } = await tx.query<{ status: string }>(`SELECT status FROM public.needs_items WHERE id = $1`, [docItem]);
      expect(rows[0].status).toBe('fulfilled');
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [docItem]);
      const another = await one<string>(tx,
        `INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type)
         VALUES ($1, 'g.pdf', 'g.pdf', 'p', 1, 'application/pdf') RETURNING id AS r`, [contactA]);
      expect(await one(tx, link, [contactA, docItem, another])).toBeNull(); // accepted: no new file
      expect((await tx.query(`SELECT 1 FROM public.needs_item_documents WHERE item_id = $1`, [docItem])).rows).toHaveLength(1);
    });
  });

  it('needs_client_submit hands a list back only when complete, once', async () => {
    await session(db, asServer, async (tx) => {
      const submit = `SELECT public.needs_client_submit($1, $2) AS r`;
      expect(await one(tx, submit, [contactA, sentA])).toBe('incomplete');
      expect(await one(tx, submit, [contactB, sentA])).toBe('not_found');
      expect(await one(tx, submit, [contactA, draftA])).toBe('not_open');
      expect(await one(tx, submit, [contactA, closedA])).toBe('not_open');
      await tx.query(`SELECT public.needs_client_link_document($1, $2, $3)`, [contactA, docItem, docA]);
      await tx.query(setAnswer, [contactA, questionItem, 'Yes', null]);
      await tx.query(`SELECT public.needs_client_mark_todo($1, $2, true)`, [contactA, todoItem]);
      // The sensitive question is optional, so the list is complete without it.
      expect(await one(tx, submit, [contactA, sentA])).toBe('submitted');
      expect(await one(tx, submit, [contactA, sentA])).toBe('already_submitted');
    });
  });

  it('each client write locks its list first, as submit does, so the two run one after the other', async () => {
    const calls: Array<[string, unknown[]]> = [
      [setAnswer, [contactA, questionItem, 'Yes', null]],
      [`SELECT public.needs_client_mark_todo($1, $2, true) AS r`, [contactA, todoItem]],
      [`SELECT public.needs_client_link_document($1, $2, $3) AS r`, [contactA, docItem, docA]],
    ];
    for (const [sql, params] of calls) {
      await session(db, asServer, async (tx) => {
        expect(await lockedByMe(tx, 'needs_lists', sentA), sql).toBe(false);
        expect(await one(tx, sql, params), sql).not.toBeNull();
        expect(await lockedByMe(tx, 'needs_lists', sentA), sql).toBe(true);
      });
    }
  });

  it('the upload notice is claimed once per 24 hours and released only by its claimer', async () => {
    await session(db, asServer, async (tx) => {
      const claim = () => one<string | null>(tx, `SELECT public.needs_claim_upload_notice($1) AS r`, [sentA]);
      const stamp = await claim();
      expect(stamp).not.toBeNull();
      expect(await claim()).toBeNull();
      expect(await one(tx, `SELECT public.needs_release_upload_notice($1, now() - interval '1 hour') AS r`, [sentA])).toBe(false);
      expect(await one(tx, `SELECT public.needs_release_upload_notice($1, $2) AS r`, [sentA, stamp])).toBe(true);
      // A client uploading in bursts through the day: still the one claim (0014).
      await tx.query(`UPDATE public.needs_lists SET upload_notified_at = now() - interval '23 hours' WHERE id = $1`, [sentA]);
      expect(await claim()).toBeNull();
      await tx.query(`UPDATE public.needs_lists SET upload_notified_at = now() - interval '25 hours' WHERE id = $1`, [sentA]);
      expect(await claim()).not.toBeNull();
    });
  });
});

describe('a client cannot take back a handed-in file', () => {
  const linkDoc = (tx: Tx) => tx.query(`SELECT public.needs_client_link_document($1, $2, $3)`, [contactA, docItem, docA]);
  const itemStatus = async (tx: Tx) =>
    (await tx.query<{ status: string }>(`SELECT status FROM public.needs_items WHERE id = $1`, [docItem])).rows[0].status;
  const deleteDoc = (tx: Tx) => tx.query(`DELETE FROM public.client_documents WHERE id = $1 RETURNING id`, [docA]);

  it('on an open request the client may delete it, and the item is open again', async () => {
    await session(db, asServer, async (tx) => {
      await linkDoc(tx);
      expect(await itemStatus(tx)).toBe('fulfilled');
      await become(tx, asA());
      expect((await deleteDoc(tx)).rows).toHaveLength(1);
      await become(tx, asServer);
      expect(await itemStatus(tx)).toBe('pending');
    });
  });

  it('once the request was handed in or closed, or the item accepted, the client cannot', async () => {
    for (const handedIn of [
      `UPDATE public.needs_lists SET status = 'submitted' WHERE id = '${sentA}'`,
      `UPDATE public.needs_lists SET status = 'closed' WHERE id = '${sentA}'`,
      `UPDATE public.needs_items SET status = 'reviewed' WHERE id = '${docItem}'`,
    ]) {
      await session(db, asServer, async (tx) => {
        await linkDoc(tx);
        await tx.query(handedIn);
        await become(tx, asA());
        const err = await refusal(tx, () => deleteDoc(tx));
        expect(err?.code, handedIn).toBe('42501');
        expect(err?.message).toMatch(/handed in/);
        await become(tx, asServer);
        expect((await tx.query(`SELECT 1 FROM public.needs_item_documents WHERE document_id = $1`, [docA])).rows).toHaveLength(1);
      });
    }
  });

  it('the owner still deletes it, whatever the request', async () => {
    await session(db, asServer, async (tx) => {
      await linkDoc(tx);
      await tx.query(`UPDATE public.needs_lists SET status = 'submitted' WHERE id = $1`, [sentA]);
      await become(tx, owner);
      expect((await deleteDoc(tx)).rows).toHaveLength(1);
    });
  });
});

describe('start links', () => {
  const one = async <T>(tx: Tx, sql: string, params: unknown[]) => (await tx.query<{ r: T }>(sql, params)).rows[0].r;
  const issue = (tx: Tx, listId: string, contactId: string, email: string, hash: string) =>
    one<string>(tx, `SELECT public.needs_issue_start_link($1, $2, $3, $4, now() + interval '14 days', $5) AS r`,
      [listId, contactId, email, hash, OWNER_ID]);
  /** A pending link written directly, for the functions that redeem one. */
  const rawLink = (tx: Tx, contactId: string, listId: string, email: string, hash: string) =>
    one<string>(tx,
      `INSERT INTO public.pending_signup_requests (email, contact_id, needs_list_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days') RETURNING id AS r`, [email, contactId, listId, hash]);
  /** A contact with an address and no portal account, and a request sent to it: what a start link is for. */
  const fresh = async (tx: Tx, email = 'grace@example.com') => {
    await becomeSuperuser(tx);
    const contact = await one<string>(tx,
      `INSERT INTO public.contacts (first_name, last_name, status, email) VALUES ('Grace', 'Hopper', 'client', $1) RETURNING id AS r`, [email]);
    const list = await one<string>(tx,
      `INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Year-end documents', 'sent', now()) RETURNING id AS r`, [contact]);
    await become(tx, asServer);
    return { contact, list };
  };
  const newUser = async (tx: Tx, email: string) => {
    await becomeSuperuser(tx);
    const id = randomUUID();
    await tx.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
    await become(tx, asServer);
    return id;
  };

  it('issues a link stored lowercased, only for the contact and address the caller read', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const first = await issue(tx, list, contact, '  Grace@Example.COM ', HASH('d'));
      const { rows } = await tx.query<{ email: string; contact_id: string; status: string }>(
        `SELECT email, contact_id, status FROM public.pending_signup_requests WHERE id = $1`, [first]);
      expect(rows[0]).toEqual({ email: 'grace@example.com', contact_id: contact, status: 'pending' });
      expect((await refusal(tx, () => issue(tx, list, contactB, 'grace@example.com', HASH('e'))))?.message).toBe('contact_changed');
      expect((await refusal(tx, () => issue(tx, list, contact, 'someone@example.com', HASH('e'))))?.message).toBe('address_changed');
      expect((await refusal(tx, () => issue(tx, randomUUID(), contact, 'grace@example.com', HASH('e'))))?.message).toBe('contact_changed');
      // Reassigned after the caller read it: no link for the old contact's address.
      await tx.query(`UPDATE public.needs_lists SET contact_id = $2 WHERE id = $1`, [list, contactB]);
      expect((await refusal(tx, () => issue(tx, list, contact, 'grace@example.com', HASH('e'))))?.message).toBe('contact_changed');
    });
  });

  it('a reminder’s link replaces the list’s older ones only when told to, and keeps its own', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      await issue(tx, list, contact, 'grace@example.com', HASH('d'));
      const kept = await issue(tx, list, contact, 'grace@example.com', HASH('e'));
      expect(await one(tx, `SELECT public.needs_supersede_start_links($1, $2) AS r`, [list, kept])).toBe(1);
      const statuses = (await tx.query<{ token_hash: string; status: string }>(
        `SELECT token_hash, status FROM public.pending_signup_requests WHERE needs_list_id = $1 ORDER BY token_hash`, [list])).rows;
      expect(statuses).toEqual([
        { token_hash: HASH('d'), status: 'superseded' },
        { token_hash: HASH('e'), status: 'pending' },
      ]);
    });
  });

  it('a token hash is stored only as hex or a retired marker', async () => {
    expect(await errorOf(db, asServer,
      `INSERT INTO public.pending_signup_requests (email, token_hash, expires_at) VALUES ('a@example.com', 'raw-token', now())`))
      .toMatch(/check constraint/);
  });

  it('a link stops working when access, the request, the address or a sign-in says so', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const revoked = (c: string | null = contact, email = 'grace@example.com', l: string | null = list) =>
        one<boolean>(tx, `SELECT public.start_link_access_revoked($1, $2, $3) AS r`, [c, email, l]);
      expect(await revoked()).toBe(false);
      const signIn = randomUUID();
      const cases: Array<[string, () => Promise<boolean>, string?]> = [
        ['no contact', () => revoked(null)],
        ['no request', () => revoked(contact, 'grace@example.com', null)],
        ['another contact’s request', () => revoked(contact, 'grace@example.com', sentB)],
        ['not the contact’s address', () => revoked(contact, 'other@example.com')],
        ['the request closed', revoked, `UPDATE public.needs_lists SET status = 'closed' WHERE id = '${list}'`],
        ['the address is no longer the contact’s', revoked,
          `UPDATE public.contacts SET email = 'new@example.com' WHERE id = '${contact}';
           DELETE FROM public.contact_emails WHERE contact_id = '${contact}' AND email = 'grace@example.com';`],
        ['access revoked for the address', revoked,
          `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ('${contact}', 'deactivated', 'GRACE@example.com')`],
        ['the contact already signs in', revoked,
          `INSERT INTO auth.users (id, email) VALUES ('${signIn}', 'elsewhere@example.com');
           INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES ('${contact}', '${signIn}', 'active', 'elsewhere@example.com')`],
      ];
      for (const [why, check, setup] of cases) {
        await tx.exec('SAVEPOINT c');
        if (setup) {
          await becomeSuperuser(tx);
          await tx.exec(setup);
          await become(tx, asServer);
        }
        expect(await check(), why).toBe(true);
        await tx.exec('ROLLBACK TO SAVEPOINT c');
      }
      // A second address of the contact's own still counts as theirs.
      await becomeSuperuser(tx);
      await tx.query(`INSERT INTO public.contact_emails (contact_id, kind, email) VALUES ($1, 'primary', 'grace@work.example.com')`, [contact]);
      await become(tx, asServer);
      expect(await revoked(contact, 'Grace@Work.example.com')).toBe(false);
      // The lookup reports it.
      await rawLink(tx, contact, list, 'grace@example.com', HASH('9'));
      const lookup = async () => (await tx.query<{ access_revoked: boolean; status: string }>(
        `SELECT access_revoked, status FROM public.start_link_lookup($1)`, [HASH('9')])).rows[0];
      expect(await lookup()).toEqual({ access_revoked: false, status: 'pending' });
      await tx.query(`UPDATE public.client_portal_accounts SET status = 'deactivated' WHERE contact_id = $1`, [contactB]);
      await becomeSuperuser(tx);
      await tx.query(`INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'suspended', 'GRACE@example.com')`, [contact]);
      await become(tx, asServer);
      expect((await lookup()).access_revoked).toBe(true);
      expect((await tx.query(`SELECT * FROM public.start_link_lookup($1)`, [HASH('f')])).rows).toHaveLength(0);
    });
  });

  it('closing or deleting the request, or changing the address, expires its pending links', async () => {
    await session(db, asServer, async (tx) => {
      const statusOf = async (id: string) =>
        (await tx.query<{ status: string }>(`SELECT status FROM public.pending_signup_requests WHERE id = $1`, [id])).rows[0].status;
      const a = await fresh(tx);
      const closed = await rawLink(tx, a.contact, a.list, 'grace@example.com', HASH('1'));
      await become(tx, owner);
      await tx.query(`UPDATE public.needs_lists SET status = 'closed' WHERE id = $1`, [a.list]);
      await become(tx, asServer);
      expect(await statusOf(closed)).toBe('expired');

      const b = await fresh(tx, 'grace2@example.com');
      const deleted = await rawLink(tx, b.contact, b.list, 'grace2@example.com', HASH('2'));
      await become(tx, owner);
      await tx.query(`SELECT public.needs_owner_delete_list($1)`, [b.list]);
      await become(tx, asServer);
      expect(await statusOf(deleted)).toBe('expired');

      const c = await fresh(tx, 'grace3@example.com');
      const old = await rawLink(tx, c.contact, c.list, 'grace3@example.com', HASH('3'));
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.contacts SET email = 'grace4@example.com' WHERE id = $1`, [c.contact]);
      await become(tx, asServer);
      const current = await rawLink(tx, c.contact, c.list, 'grace4@example.com', HASH('4'));
      expect(await statusOf(old)).toBe('expired');
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.contacts SET phone = '555-0100' WHERE id = $1`, [c.contact]);
      await become(tx, asServer);
      expect(await statusOf(current)).toBe('pending');
    });
  });

  it('one redemption at a time; a stale claim may be taken over; only the holder releases', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const id = await rawLink(tx, contact, list, 'grace@example.com', HASH('1'));
      const [c1, c2] = [randomUUID(), randomUUID()];
      const claim = (c: string) => one<boolean>(tx, `SELECT public.claim_start_link($1, $2) AS r`, [id, c]);
      expect(await claim(c1)).toBe(true);
      expect(await claim(c2)).toBe(false);
      await tx.query(`SELECT public.release_start_link_claim($1, $2)`, [id, c2]);
      expect(await claim(c2)).toBe(false); // the stranger's release did nothing
      await tx.query(`UPDATE public.pending_signup_requests SET claimed_at = now() - interval '6 minutes' WHERE id = $1`, [id]);
      expect(await claim(c2)).toBe(true);
      await tx.query(`UPDATE public.pending_signup_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      expect(await one(tx, `SELECT public.claim_start_link($1, $2) AS r`, [id, randomUUID()])).toBe(false);
      expect(await one(tx, `SELECT public.expire_start_link($1) AS r`, [id])).toBe(true);
      expect(await one(tx, `SELECT public.expire_start_link($1) AS r`, [id])).toBe(false);
    });
  });

  it('link_start_link reuses the open account for the address, else creates one, only for the claim holder', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const id = await rawLink(tx, contact, list, 'grace@example.com', HASH('2'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      const u = await newUser(tx, 'grace@example.com');
      const invited = await one<string>(tx,
        `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'invited', 'GRACE@example.com') RETURNING id AS r`,
        [contact]);
      const link = (user: string, c: string) => one<string | null>(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, user, c]);
      expect(await link(u, randomUUID())).toBeNull(); // not the claim holder
      expect(await link(u, claim)).toBe(invited);
      const acct = (await tx.query<{ status: string; user_id: string; activated_at: string | null }>(
        `SELECT status, user_id, activated_at FROM public.client_portal_accounts WHERE id = $1`, [invited])).rows[0];
      expect(acct.status).toBe('active');
      expect(acct.user_id).toBe(u);
      expect(acct.activated_at).not.toBeNull();
    });
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const id = await rawLink(tx, contact, list, 'grace@example.com', HASH('3'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      const u = await newUser(tx, 'grace@example.com');
      const accountId = await one<string>(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, u, claim]);
      const acct = (await tx.query<{ role: string; invited_email: string; status: string }>(
        `SELECT role, invited_email, status FROM public.client_portal_accounts WHERE id = $1`, [accountId])).rows[0];
      expect(acct).toEqual({ role: 'primary', invited_email: 'grace@example.com', status: 'active' });
      // Now the contact signs in: the same link (were it still pending) refuses.
      expect(await one(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, u, claim])).toBeNull();
    });
  });

  it('link_start_link refuses a contact that already has a sign-in, and inserts nothing', async () => {
    await session(db, asServer, async (tx) => {
      const id = await rawLink(tx, contactA, sentA, 'ada@example.com', HASH('4'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      const u = await newUser(tx, 'ada2@example.com');
      const before = (await tx.query(`SELECT 1 FROM public.client_portal_accounts WHERE contact_id = $1`, [contactA])).rows.length;
      expect(await one(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, u, claim])).toBeNull();
      expect((await tx.query(`SELECT 1 FROM public.client_portal_accounts WHERE contact_id = $1`, [contactA])).rows).toHaveLength(before);
    });
  });

  it('link_start_link locks the contact’s accounts before it checks access', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const id = await rawLink(tx, contact, list, 'grace@example.com', HASH('5'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      // Another address's open invitation on the same contact: not the one linked, so only
      // the lock can have stamped it.
      const spouse = await one<string>(tx,
        `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'invited', 'partner@example.com') RETURNING id AS r`,
        [contact]);
      const u = await newUser(tx, 'grace@example.com');
      expect(await lockedByMe(tx, 'client_portal_accounts', spouse)).toBe(false);
      expect(await one(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, u, claim])).not.toBeNull();
      expect(await lockedByMe(tx, 'client_portal_accounts', spouse)).toBe(true);
    });
  });

  it('a revoke landing right after the access check creates no account beside it', async () => {
    await session(db, asServer, async (tx) => {
      const { contact, list } = await fresh(tx);
      const id = await rawLink(tx, contact, list, 'grace@example.com', HASH('6'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      const invited = await one<string>(tx,
        `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'invited', 'grace@example.com') RETURNING id AS r`,
        [contact]);
      // The interleaving hook: the access check answers "fine" from before the revoke, and
      // the owner's deactivate lands right after it (in this one connection, inside it).
      await becomeSuperuser(tx);
      await tx.exec(`
        CREATE OR REPLACE FUNCTION public.start_link_access_revoked(p_contact_id uuid, p_email text, p_list_id uuid)
        RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $f$
        BEGIN
          UPDATE public.client_portal_accounts a SET status = 'deactivated'
           WHERE a.contact_id = p_contact_id AND lower(a.invited_email) = p_email;
          RETURN false;
        END;
        $f$;`);
      await become(tx, asServer);
      const u = await newUser(tx, 'grace@example.com');
      expect(await one(tx, `SELECT public.link_start_link($1, $2, $3) AS r`, [id, u, claim])).toBeNull();
      const rows = (await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.client_portal_accounts WHERE contact_id = $1`, [contact])).rows;
      expect(rows).toEqual([{ id: invited, status: 'deactivated' }]);
    });
  });

  it('delete_stale_start_link_user deletes only a banned, stamped, unbound user under the claim', async () => {
    await session(db, asServer, async (tx) => {
      const id = await rawLink(tx, contactA, sentA, 'left@example.com', HASH('5'));
      const claim = randomUUID();
      await tx.query(`SELECT public.claim_start_link($1, $2)`, [id, claim]);
      await becomeSuperuser(tx);
      const mk = async (meta: Record<string, unknown>, banned: boolean) => {
        const u = randomUUID();
        await tx.query(`INSERT INTO auth.users (id, email, raw_app_meta_data, banned_until) VALUES ($1, $2, $3, $4)`,
          [u, `${u.slice(0, 6)}@example.com`, JSON.stringify(meta), banned ? '2999-01-01' : null]);
        return u;
      };
      const stamped = await mk({ pending_signup: id }, true);
      const unbanned = await mk({ pending_signup: id }, false);
      const unstamped = await mk({}, true);
      const otherStampBound = await mk({ pending_signup: randomUUID() }, true);
      await tx.query(`INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email)
                      VALUES ($1, $2, 'active', 'bound@example.com')`, [contactB, otherStampBound]);
      const otherStampFree = await mk({ pending_signup: randomUUID() }, true);
      await become(tx, asServer);
      const del = (u: string, c = claim) => one<boolean>(tx, `SELECT public.delete_stale_start_link_user($1, $2, $3) AS r`, [u, id, c]);
      expect(await del(stamped, randomUUID())).toBe(false); // not the claim holder
      expect(await del(unbanned)).toBe(false);
      expect(await del(unstamped)).toBe(false);
      expect(await del(otherStampBound)).toBe(false);
      expect(await del(OWNER_ID)).toBe(false);
      expect(await del(stamped)).toBe(true);
      expect(await del(otherStampFree)).toBe(true);
    });
  });

  it('retire_start_link kills the token and revokes this address’s pending invitations only', async () => {
    await session(db, asServer, async (tx) => {
      const id = await rawLink(tx, contactB, sentB, 'bo@example.com', HASH('6'));
      const inv = async (email: string) => one<string>(tx,
        `INSERT INTO public.portal_invitations (email, contact_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days') RETURNING id AS r`, [email, contactB, randomUUID()]);
      const mine = await inv(' Bo@Example.com ');
      const spouse = await inv('partner@example.com');
      const revoked = await one<string[]>(tx, `SELECT public.retire_start_link($1) AS r`, [id]);
      expect(revoked).toEqual([mine]);
      const rows = (await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.portal_invitations WHERE id IN ($1, $2)`, [mine, spouse])).rows;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [mine]: 'revoked', [spouse]: 'pending' });
      const link = (await tx.query<{ status: string; token_hash: string }>(
        `SELECT status, token_hash FROM public.pending_signup_requests WHERE id = $1`, [id])).rows[0];
      expect(link).toEqual({ status: 'consumed', token_hash: `consumed:${id}` });
      expect((await tx.query(`SELECT * FROM public.start_link_lookup($1)`, [HASH('6')])).rows).toHaveLength(0);
      const older = (await tx.query<{ status: string }>(
        `SELECT status FROM public.pending_signup_requests WHERE token_hash = $1`, [HASH('b')])).rows[0];
      expect(older.status).toBe('superseded');
    });
  });

  it('cleanup removes only links expired over 30 days ago and never used', async () => {
    await session(db, asServer, async (tx) => {
      await tx.query(`INSERT INTO public.pending_signup_requests (email, token_hash, expires_at, status)
                      VALUES ('old@example.com', $1, now() - interval '31 days', 'expired'),
                             ('recent@example.com', $2, now() - interval '2 days', 'expired')`, [HASH('7'), HASH('8')]);
      expect(await one(tx, `SELECT public.cleanup_stale_start_links() AS r`, [])).toEqual({ start_links: 1 });
    });
  });
});

describe('the owner deletes a request through one audited call', () => {
  it('the browser deletes no list directly', async () => {
    await expectDenied(as(db, owner, `DELETE FROM public.needs_lists WHERE id = $1`, [sentA]));
  });

  it('deletes at any status with its items, audits ids and counts, and names the linked files', async () => {
    await session(db, owner, async (tx) => {
      const docs = (await tx.query<{ r: string[] }>(`SELECT public.needs_owner_delete_list($1) AS r`, [sentB])).rows[0].r;
      expect(docs).toEqual([docB]);
      await become(tx, asServer);
      expect((await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [sentB])).rows).toHaveLength(0);
      expect((await tx.query(`SELECT 1 FROM public.needs_items WHERE list_id = $1`, [sentB])).rows).toHaveLength(0);
      expect((await tx.query(`SELECT 1 FROM public.client_documents WHERE id = $1`, [docB])).rows).toHaveLength(1); // files stay
      const { rows } = await tx.query<{ user_id: string; details: Record<string, unknown> }>(
        `SELECT user_id, details FROM public.audit_logs WHERE action = 'needs_list_deleted' AND details ->> 'list_id' = $1`, [sentB]);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(OWNER_ID);
      expect(rows[0].details).toEqual({
        list_id: sentB, contact_id: contactB, status: 'sent', item_count: 1, document_count: 1, source: 'owner',
      });
    });
    await session(db, owner, async (tx) => {
      expect((await refusal(tx, () => tx.query(`SELECT public.needs_owner_delete_list($1)`, [randomUUID()])))?.message).toBe('not_found');
    });
  });

  it('only the owner calls it', async () => {
    for (const who of [asA(), asB()]) {
      const err = await expectDenied(as(db, who, `SELECT public.needs_owner_delete_list($1)`, [sentB]));
      expect(err.message).toBe('owner required');
    }
    await expectDenied(as(db, asAnon, `SELECT public.needs_owner_delete_list($1)`, [sentB]));
    expect(await count(db, asServer, 'needs_lists', `id = '${sentB}'`)).toBe(1);
  });
});

describe('needs_owner_save_draft: the builder saves a draft in one call', () => {
  // Every case runs in one rolled-back transaction as the owner; a call expected to fail
  // runs under a savepoint so the transaction carries on.
  const SAVE = `SELECT public.needs_owner_save_draft($1::uuid, $2::uuid, $3::integer, $4::text, $5::text, $6::boolean, $7::jsonb) AS r`;
  const ITEMS = JSON.stringify([
    { kind: 'todo', label: 'Sign the engagement form', sort_order: 0 },
    { kind: 'question', label: 'Preferred phone?', required: false, sort_order: 1 },
  ]);
  type Saved = { id: string; content_version: number };
  const save = async (tx: Tx, id: string | null, v: number | null, title: string, items: string, contact = contactA) =>
    (await tx.query<{ r: Saved }>(SAVE, [id, contact, v, title, 'Hello', true, items])).rows[0].r;
  const refused = async (tx: Tx, run: () => Promise<unknown>): Promise<{ message: string; code?: string }> => {
    await tx.exec('SAVEPOINT s');
    try {
      await run();
    } catch (err) {
      await tx.exec('ROLLBACK TO SAVEPOINT s');
      return err as { message: string; code?: string };
    }
    throw new Error('expected the save to be refused, but it succeeded');
  };
  const labels = async (tx: Tx, id: string) =>
    (await tx.query<{ label: string }>(`SELECT label FROM public.needs_items WHERE list_id = $1 ORDER BY sort_order`, [id])).rows.map((r) => r.label);
  const listRow = async (tx: Tx, id: string) =>
    (await tx.query<{ title: string; status: string; created_by: string; intro_message: string; include_contact_confirm: boolean; content_version: number }>(
      `SELECT title, status, created_by, intro_message, include_contact_confirm, content_version FROM public.needs_lists WHERE id = $1`, [id])).rows[0];

  it('creates a draft with its items, then replaces it only at the version read', async () => {
    await session(db, owner, async (tx) => {
      const made = await save(tx, null, null, 'Onboarding', ITEMS);
      expect(await labels(tx, made.id)).toEqual(['Sign the engagement form', 'Preferred phone?']);
      expect(await listRow(tx, made.id)).toMatchObject({ status: 'draft', created_by: OWNER_ID, intro_message: 'Hello', include_contact_confirm: true });

      const next = await save(tx, made.id, made.content_version, 'Onboarding, updated', JSON.stringify([{ kind: 'info', label: 'Welcome' }]));
      expect(next.id).toBe(made.id);
      expect(next.content_version).toBeGreaterThan(made.content_version);
      expect(await labels(tx, made.id)).toEqual(['Welcome']);
      expect((await refused(tx, () => save(tx, made.id, made.content_version, 'Stale', ITEMS))).message).toMatch(/stale_content/);
      expect((await refused(tx, () => save(tx, made.id, next.content_version, 'Wrong contact', ITEMS, contactB))).message).toMatch(/not_found/);
      expect((await listRow(tx, made.id)).title).toBe('Onboarding, updated');
    });
  });

  it('a failure mid-save leaves the old draft exactly as it was', async () => {
    await session(db, owner, async (tx) => {
      const made = await save(tx, null, null, 'Kept', ITEMS);
      const before = await listRow(tx, made.id);
      // The second item breaks a CHECK after the list row was updated and the old items deleted.
      const bad = JSON.stringify([{ kind: 'todo', label: 'New one' }, { kind: 'not-a-kind', label: 'Broken' }]);
      await refused(tx, () => save(tx, made.id, made.content_version, 'Replaced', bad));
      expect(await listRow(tx, made.id)).toEqual(before);
      expect(await labels(tx, made.id)).toEqual(['Sign the engagement form', 'Preferred phone?']);
      // A failed create leaves no list behind either.
      const lists = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_lists`)).rows[0].n;
      await refused(tx, () => save(tx, null, null, 'Never', bad));
      expect((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_lists`)).rows[0].n).toBe(lists);
    });
  });

  it('a save after a send is refused and changes nothing', async () => {
    await session(db, owner, async (tx) => {
      const made = await save(tx, null, null, 'Sent soon', ITEMS);
      await become(tx, asServer);
      expect((await tx.query<{ r: string }>(`SELECT public.needs_send_list($1, $2, $3, 'ada@example.com') AS r`,
        [made.id, made.content_version, contactA])).rows[0].r).toBe('sent');
      await become(tx, owner);
      expect((await refused(tx, () => save(tx, made.id, made.content_version, 'Too late', '[]'))).message).toMatch(/not_draft/);
      expect((await listRow(tx, made.id)).title).toBe('Sent soon');
      expect(await labels(tx, made.id)).toEqual(['Sign the engagement form', 'Preferred phone?']);
    });
  });

  it('only the owner calls it: not a client, not View as client, not anon', async () => {
    const minted = randomUUID();
    await session(db, asServer, async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
         VALUES ($1, $2, $3, 'ada@example.com', $4)`, [OWNER_ID, contactA, clientA, minted]);
      const lists = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_lists`)).rows[0].n;
      for (const who of [user(clientA, { sessionId: minted, aal: 'aal2' }), user(clientA, { aal: 'aal2' })]) {
        await become(tx, who);
        const err = await refused(tx, () => save(tx, null, null, 'From the portal', ITEMS));
        expect(err.code).toBe('42501');
        expect(err.message).toBe('owner required');
        const sentErr = await refused(tx, () => save(tx, sentA, 0, 'Over a sent list', '[]'));
        expect(sentErr.message).toBe('owner required');
      }
      await become(tx, asAnon);
      expect((await refused(tx, () => save(tx, null, null, 'Anon', ITEMS))).code).toBe('42501');
      await becomeSuperuser(tx);
      expect((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_lists`)).rows[0].n).toBe(lists);
    });
  });
});

describe('function privileges', () => {
  it('a signed-in session or anon can call none of the server functions', async () => {
    for (const who of [owner, asA(), asAnon]) {
      await expectDenied(as(db, who, `SELECT public.needs_send_list($1, 0, $2, 'ada@example.com')`, [draftA, contactA]));
      await expectDenied(as(db, who, `SELECT public.needs_recipient_current($1, $2, 'ada@example.com')`, [draftA, contactA]));
      await expectDenied(as(db, who, `SELECT public.needs_client_submit($1, $2)`, [contactA, sentA]));
      await expectDenied(as(db, who, `SELECT public.needs_replace_draft($1, 'x', '[]'::jsonb)`, [draftA]));
      await expectDenied(as(db, who, `SELECT * FROM public.start_link_lookup($1)`, [HASH('b')]));
      await expectDenied(as(db, who, `SELECT * FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [sentA]));
    }
  });
});

describe('a request closes itself once nothing is left to do (0014)', () => {
  const one = async <T>(tx: Tx, sql: string, params: unknown[]) => (await tx.query<{ r: T }>(sql, params)).rows[0].r;
  type Seed = { kind: string; status: string; required?: boolean };
  /** A list of contact A at `status`, with `items`, written as the database superuser inside the session. */
  async function seedList(tx: Tx, status: 'sent' | 'submitted', items: Seed[]): Promise<{ listId: string; ids: string[] }> {
    await becomeSuperuser(tx);
    const listId = await one<string>(tx,
      `INSERT INTO public.needs_lists (contact_id, title, status, sent_at, submitted_at)
       VALUES ($1, 'Closing', $2::text, now(), CASE WHEN $2::text = 'submitted' THEN now() END) RETURNING id AS r`, [contactA, status]);
    const ids: string[] = [];
    for (const [i, it] of items.entries()) {
      ids.push(await one<string>(tx,
        `INSERT INTO public.needs_items (list_id, kind, label, status, required, sort_order)
         VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id AS r`, [listId, it.kind, it.status, it.required ?? it.kind !== 'info', i]));
    }
    return { listId, ids };
  }
  const listRow = async (tx: Tx, id: string) =>
    (await tx.query<{ status: string; closed: boolean }>(
      `SELECT status, closed_at IS NOT NULL AS closed FROM public.needs_lists WHERE id = $1`, [id])).rows[0];
  const accept = (tx: Tx, ids: string[]) =>
    tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = ANY($1::uuid[]) AND status = 'fulfilled'`, [ids]);

  it('the owner accepting the last answer closes the list', async () => {
    await session(db, owner, async (tx) => {
      const { listId, ids } = await seedList(tx, 'sent', [
        { kind: 'question', status: 'fulfilled' }, { kind: 'todo', status: 'reviewed' }, { kind: 'info', status: 'pending' },
      ]);
      await become(tx, owner);
      await accept(tx, [ids[0]]);
      expect(await listRow(tx, listId)).toEqual({ status: 'closed', closed: true });
    });
  });

  it('accept all closes the list in the one statement', async () => {
    await session(db, owner, async (tx) => {
      const { listId, ids } = await seedList(tx, 'submitted', [
        { kind: 'question', status: 'fulfilled' }, { kind: 'document', status: 'fulfilled' }, { kind: 'todo', status: 'fulfilled' },
      ]);
      await become(tx, owner);
      await accept(tx, ids);
      expect(await listRow(tx, listId)).toEqual({ status: 'closed', closed: true });
    });
  });

  it('stays open while an answer waits to be accepted, and locks the list as it checks', async () => {
    // Committed first: a row this transaction wrote already carries its id, so the lock
    // check needs a list written before it. Removed again below.
    const listId = await list(contactA, 'submitted', 'Lock check');
    const first = await item(listId, 'question', { status: 'fulfilled' });
    await item(listId, 'todo', { status: 'fulfilled' });
    try {
      await session(db, owner, async (tx) => {
        expect(await lockedByMe(tx, 'needs_lists', listId)).toBe(false);
        await accept(tx, [first]);
        // The lock is what lets two accepts at once read each other's (0014's header).
        expect(await lockedByMe(tx, 'needs_lists', listId)).toBe(true);
        expect(await listRow(tx, listId)).toEqual({ status: 'submitted', closed: false });
      });
    } finally {
      await db.query(`DELETE FROM public.needs_lists WHERE id = $1`, [listId]);
    }
  });

  it('a sent list waits for every item; once submitted, only for the required ones', async () => {
    for (const [status, expected] of [['sent', 'sent'], ['submitted', 'closed']] as const) {
      await session(db, owner, async (tx) => {
        const { listId, ids } = await seedList(tx, status, [
          { kind: 'question', status: 'fulfilled' }, { kind: 'document', status: 'pending', required: false },
        ]);
        await become(tx, owner);
        await accept(tx, [ids[0]]);
        expect((await listRow(tx, listId)).status, status).toBe(expected);
      });
    }
  });

  it('a submit after every required answer was accepted closes the list, and submit still reports submitted', async () => {
    await session(db, asServer, async (tx) => {
      const { listId } = await seedList(tx, 'sent', [
        { kind: 'todo', status: 'reviewed' }, { kind: 'question', status: 'pending', required: false },
      ]);
      await become(tx, asServer);
      expect(await one(tx, `SELECT public.needs_client_submit($1, $2) AS r`, [contactA, listId])).toBe('submitted');
      expect(await listRow(tx, listId)).toEqual({ status: 'closed', closed: true });
    });
  });

  it('a list with nothing to answer never closes on its own', async () => {
    await session(db, asServer, async (tx) => {
      const { listId } = await seedList(tx, 'sent', [{ kind: 'info', status: 'pending' }]);
      await become(tx, asServer);
      await tx.query(`UPDATE public.needs_lists SET status = 'submitted', submitted_at = now() WHERE id = $1`, [listId]);
      expect((await listRow(tx, listId)).status).toBe('submitted');
    });
  });

  it('an answer arriving is never a reason to close, and a closed list stays closed', async () => {
    await session(db, asServer, async (tx) => {
      const { listId, ids } = await seedList(tx, 'sent', [{ kind: 'todo', status: 'pending' }]);
      await become(tx, asServer);
      await tx.query(`UPDATE public.needs_items SET status = 'fulfilled' WHERE id = $1`, [ids[0]]);
      expect(await listRow(tx, listId)).toEqual({ status: 'sent', closed: false });
      await tx.query(`UPDATE public.needs_lists SET status = 'closed', closed_at = now() WHERE id = $1`, [listId]);
      await tx.query(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [ids[0]]);
      await tx.query(`UPDATE public.needs_items SET status = 'fulfilled' WHERE id = $1`, [ids[0]]);
      expect((await listRow(tx, listId)).status).toBe('closed');
    });
  });

  it('closing on its own expires the list start links, as a close by hand does', async () => {
    await session(db, owner, async (tx) => {
      const { listId, ids } = await seedList(tx, 'sent', [{ kind: 'todo', status: 'fulfilled' }]);
      await tx.query(
        `INSERT INTO public.pending_signup_requests (email, contact_id, needs_list_id, token_hash, expires_at)
         VALUES ('ada@example.com', $1, $2, $3, now() + interval '14 days')`, [contactA, listId, HASH('c')]);
      await become(tx, owner);
      await accept(tx, ids);
      await becomeSuperuser(tx);
      expect(await one(tx, `SELECT status AS r FROM public.pending_signup_requests WHERE needs_list_id = $1`, [listId])).toBe('expired');
    });
  });

  it('the migration closes the lists that were already finished, and only those', async () => {
    const sql = readFileSync(path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', '0014_requests.sql'), 'utf8');
    const backfill = sql.split('-- 3. Close the lists that were already finished')[1];
    expect(backfill).toMatch(/UPDATE public\.needs_lists/);
    await session(db, asServer, async (tx) => {
      const done = (await seedList(tx, 'sent', [{ kind: 'todo', status: 'reviewed' }, { kind: 'info', status: 'pending' }])).listId;
      const doneSubmitted = (await seedList(tx, 'submitted', [
        { kind: 'todo', status: 'reviewed' }, { kind: 'question', status: 'pending', required: false },
      ])).listId;
      const waiting = (await seedList(tx, 'submitted', [{ kind: 'todo', status: 'fulfilled' }])).listId;
      const owed = (await seedList(tx, 'sent', [{ kind: 'todo', status: 'reviewed' }, { kind: 'todo', status: 'pending', required: false }])).listId;
      const empty = (await seedList(tx, 'sent', [{ kind: 'info', status: 'pending' }])).listId;
      await tx.exec(backfill);
      expect(await listRow(tx, done)).toEqual({ status: 'closed', closed: true });
      expect((await listRow(tx, doneSubmitted)).status).toBe('closed');
      for (const id of [waiting, owed, empty]) expect((await listRow(tx, id)).status, id).not.toBe('closed');
      expect((await listRow(tx, sentA)).status).toBe('sent');
      expect((await listRow(tx, draftA)).status).toBe('draft');
    });
  });
});
