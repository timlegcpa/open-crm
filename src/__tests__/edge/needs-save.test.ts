// @vitest-environment node
// needs-save against the real migrations in PGlite: every client write to a request goes
// through here, scoped to the caller's own contact by the database functions. The mail
// is faked and records every message.
import type { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore, seedPortalAccount } from '../db/harness';
import {
  ANSWER_MAX,
  contactUpdate,
  createNeedsSaveHandler,
  type NeedsSaveDeps,
} from '../../../supabase/functions/needs-save/handler';
import { decryptPii, fromBytea } from '../../../supabase/functions/_shared/crypto';
import type { SendResult } from '../../../supabase/functions/_shared/outbound';
import type { OrgIdentity } from '../../../supabase/functions/_shared/organization';
import { CLIENT_CONTACT_ID, CLIENT_USER_ID, CREDENTIALS, describeEdgeContract, edgeRequest, fakeClientAuth, throwInternal } from './contract';

const SITE = 'https://crm.example.com';
const PII_KEY = randomBytes(32).toString('base64');
const OWNER_EMAIL = 'owner@example.com';
const ORG: OrgIdentity = {
  displayName: 'Example Co', legalName: null, senderName: 'Example Co', postalAddress: null, logoUrl: null, brandColor: null,
};

interface Sent {
  to: string;
  subject: string;
  text: string;
}

let db: PGlite;
let other: string;
let listId: string;
let docItem: string;
let question: string;
let secret: string;
let todo: string;
let info: string;
let otherItem: string;
let n = 0;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}
const one = async <T>(sql: string, params: unknown[] = []) => (await q<{ r: T }>(sql, params))[0].r;

function deps(sent: Sent[], over: Partial<NeedsSaveDeps> = {}, status: () => SendResult = () => ({ status: 'sent', channel: 'local', id: null })): NeedsSaveDeps {
  const ownList = async (contactId: string, id: string) =>
    (await q<never>(`SELECT id, title, status, include_contact_confirm FROM public.needs_lists
                     WHERE id = $1 AND contact_id = $2 AND status <> 'draft'`, [id, contactId]))[0] ?? null;
  return {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: SITE,
    authorizeClient: fakeClientAuth(),
    piiKey: PII_KEY,
    async loadItem(contactId, itemId) {
      const [item] = await q<{ id: string; list_id: string; kind: never; sensitive: boolean }>(
        `SELECT id, list_id, kind, sensitive FROM public.needs_items WHERE id = $1`, [itemId]);
      if (!item || !(await ownList(contactId, item.list_id))) return null;
      return item;
    },
    loadList: ownList,
    async updateContact(contactId, fields) {
      const keys = Object.keys(fields);
      await q(`UPDATE public.contacts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [contactId, ...keys.map((k) => fields[k as keyof typeof fields])]);
    },
    setAnswer: (c, i, text, cipher) =>
      one(`SELECT public.needs_client_set_answer($1, $2, $3, $4) AS r`, [c, i, text, cipher === null ? null : fromBytea(cipher)]),
    markTodo: (c, i, done) => one(`SELECT public.needs_client_mark_todo($1, $2, $3) AS r`, [c, i, done]),
    linkDocument: (c, i, d) => one(`SELECT public.needs_client_link_document($1, $2, $3) AS r`, [c, i, d]),
    submit: (c, l) => one(`SELECT public.needs_client_submit($1, $2) AS r`, [c, l]),
    async progress(id) {
      return (await q<never>(`SELECT actionable, fulfilled, required_open FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [id]))[0];
    },
    async documentProgress(id) {
      const [row] = await q<{ asked: number; done: number }>(
        `SELECT count(*)::int AS asked,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.needs_item_documents d WHERE d.item_id = i.id))::int AS done
           FROM public.needs_items i WHERE i.list_id = $1 AND i.kind = 'document'`, [id]);
      return { filesAsked: row.asked, filesIn: row.done };
    },
    claimUploadNotice: async (id) => {
      const r = await one<Date | string | null>(`SELECT public.needs_claim_upload_notice($1) AS r`, [id]);
      return r === null ? null : r instanceof Date ? r.toISOString() : r;
    },
    async releaseUploadNotice(id, stamp) {
      await q(`SELECT public.needs_release_upload_notice($1, $2)`, [id, stamp]);
    },
    async loadContact(id) {
      return (await q<never>(`SELECT first_name, last_name, business_name, email FROM public.contacts WHERE id = $1`, [id]))[0] ?? null;
    },
    ownerEmail: async () => OWNER_EMAIL,
    loadOrg: async () => ORG,
    async sendEmail({ to, subject, content }) {
      const text = content.blocks.map((b) => ('text' in b ? b.text : 'url' in b ? `${b.label} ${b.url}` : b.items.join(' '))).join('\n');
      sent.push({ to, subject, text });
      return status();
    },
    async logActivity({ contactId, userId, action, details }) {
      await q(`INSERT INTO public.client_activity_log (contact_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [contactId, userId, action, JSON.stringify(details)]);
    },
    logSink: (_l, line) => { if (process.env.REQ_DEBUG) process.stderr.write(`${line}\n`); },
    ...over,
  };
}

const save = (d: NeedsSaveDeps, body: Record<string, unknown>) =>
  createNeedsSaveHandler(d)(edgeRequest({ headers: CREDENTIALS.client, body }));

async function result(res: Response): Promise<[number, string | undefined]> {
  const body = (await res.json()) as { status?: string; code?: string };
  return [res.status, body.code ?? body.status];
}

async function upload(contactId = CLIENT_CONTACT_ID, name = 'bank-letter.pdf', heldBy = 'client'): Promise<string> {
  return one(`INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type, held_by)
              VALUES ($1, $2, $2, 'p', 1, 'application/pdf', $3) RETURNING id AS r`, [contactId, name, heldBy]);
}

const item = (sql: string, id: string) => q<Record<string, unknown>>(`SELECT ${sql} FROM public.needs_items WHERE id = $1`, [id]).then((r) => r[0]);

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  await seedContact(db, { id: CLIENT_CONTACT_ID, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' });
  await seedPortalAccount(db, CLIENT_CONTACT_ID, { email: 'ada@example.com', userId: CLIENT_USER_ID });
  other = await seedContact(db, { first_name: 'Bo', email: 'bo@example.com' });
}, 60_000);

beforeEach(async () => {
  n += 1;
  listId = await one(`INSERT INTO public.needs_lists (contact_id, title, status, sent_at, include_contact_confirm)
                      VALUES ($1, $2, 'sent', now(), true) RETURNING id AS r`, [CLIENT_CONTACT_ID, `Request ${n}`]);
  const add = (kind: string, extra = '') =>
    one<string>(`INSERT INTO public.needs_items (list_id, kind, label${extra ? ', sensitive, required' : ''})
                 VALUES ($1, $2, 'Label'${extra}) RETURNING id AS r`, [listId, kind]);
  docItem = await add('document');
  question = await add('question');
  secret = await add('question', ', true, false');
  todo = await add('todo');
  info = await add('info');
  const otherList = await one<string>(`INSERT INTO public.needs_lists (contact_id, title, status, sent_at)
                                       VALUES ($1, 'Theirs', 'sent', now()) RETURNING id AS r`, [other]);
  otherItem = await one(`INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'question', 'x') RETURNING id AS r`, [otherList]);
});

describeEdgeContract({
  name: 'needs-save',
  handler: async (req) => createNeedsSaveHandler(deps([]))(req),
  failingHandler: async (req) => createNeedsSaveHandler(deps([], { submit: throwInternal }))(req),
  credentials: CREDENTIALS.client,
  wrongPrincipal: CREDENTIALS.owner,
  clientWrites: true,
  body: { kind: 'json', valid: { action: 'submit', list_id: '00000000-0000-4000-8000-00000000ffff' }, maxBytes: 32768 },
});

describe('needs-save: answers', () => {
  it('stores a plain answer and fulfils the item; a blank answer clears it', async () => {
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: question, answer: 'Yes, twice' }))).toEqual([200, 'fulfilled']);
    expect(await item('answer_text, status', question)).toEqual({ answer_text: 'Yes, twice', status: 'fulfilled' });
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: question, answer: '   ' }))).toEqual([200, 'pending']);
    expect(await item('answer_text, status', question)).toEqual({ answer_text: null, status: 'pending' });
  });

  it('stores a sensitive answer only encrypted, under the key', async () => {
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: secret, answer: 'secret-answer-0123456789' }))).toEqual([200, 'fulfilled']);
    const row = await item('answer_text, answer_ciphertext', secret);
    expect(row.answer_text).toBeNull();
    expect(Buffer.from(fromBytea(row.answer_ciphertext)).toString('utf8')).not.toContain('secret-answer-0123456789');
    expect(await decryptPii(fromBytea(row.answer_ciphertext), PII_KEY)).toBe('secret-answer-0123456789');
  });

  it('refuses a sensitive answer without the key, and stores nothing', async () => {
    expect(await result(await save(deps([], { piiKey: null }), { action: 'save_answer', item_id: secret, answer: 'x' })))
      .toEqual([503, 'encryption_unavailable']);
    expect(await item('answer_text, answer_ciphertext', secret)).toEqual({ answer_text: null, answer_ciphertext: null });
  });

  it('refuses an answer over the limit, another contact’s item, a non-question, an accepted item', async () => {
    expect((await result(await save(deps([]), { action: 'save_answer', item_id: question, answer: 'x'.repeat(ANSWER_MAX + 1) })))[1]).toBe('too_long');
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: otherItem, answer: 'x' }))).toEqual([404, 'not_found']);
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: todo, answer: 'x' }))).toEqual([404, 'not_found']);
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: info, answer: 'x' }))).toEqual([404, 'not_found']);
    await q(`UPDATE public.needs_items SET status = 'reviewed' WHERE id = $1`, [question]);
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: question, answer: 'changed' }))).toEqual([409, 'locked']);
    expect((await item('answer_text', question)).answer_text).toBeNull();
    expect(await item('answer_text', otherItem)).toEqual({ answer_text: null });
  });

  it('refuses an answer once the list is closed', async () => {
    await q(`UPDATE public.needs_lists SET status = 'closed' WHERE id = $1`, [listId]);
    // A closed list is still the client's to read; the guard in the function refuses the write.
    expect(await result(await save(deps([]), { action: 'save_answer', item_id: question, answer: 'late' }))).toEqual([409, 'locked']);
    expect((await item('answer_text', question)).answer_text).toBeNull();
  });

  it('ticks and unticks a to-do', async () => {
    expect(await result(await save(deps([]), { action: 'mark_item', item_id: todo, done: true }))).toEqual([200, 'fulfilled']);
    expect(await result(await save(deps([]), { action: 'mark_item', item_id: todo, done: false }))).toEqual([200, 'pending']);
    expect(await result(await save(deps([]), { action: 'mark_item', item_id: question, done: true }))).toEqual([409, 'locked']);
    expect(await result(await save(deps([]), { action: 'mark_item', item_id: todo, done: 'yes' }))).toEqual([400, 'bad_request']);
  });

  it('refuses an unknown action', async () => {
    expect(await result(await save(deps([]), { action: 'delete_everything' }))).toEqual([400, 'bad_request']);
  });
});

describe('needs-save: uploads', () => {
  it('links the client’s own upload and tells the owner once per half hour, without the file name', async () => {
    const sent: Sent[] = [];
    const d = deps(sent);
    const first = await upload();
    expect(await result(await save(d, { action: 'link_document', item_id: docItem, document_id: first }))).toEqual([200, 'linked']);
    expect(await item('status', docItem)).toEqual({ status: 'fulfilled' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].text).toContain('1 of 1 requested file in');
    expect(sent[0].text).toContain(`${SITE}/documents?contact=${CLIENT_CONTACT_ID}`);
    expect(JSON.stringify(sent)).not.toContain('bank-letter');
    expect(await result(await save(d, { action: 'link_document', item_id: docItem, document_id: first }))).toEqual([200, 'already_linked']);
    const second = await upload();
    await save(d, { action: 'link_document', item_id: docItem, document_id: second });
    expect(sent).toHaveLength(1);
  });

  it('a notice that failed gives its claim back, so the next upload tries again', async () => {
    let fail = true;
    const sent: Sent[] = [];
    const d = deps(sent, {}, () => (fail ? { status: 'failed', channel: 'resend', reason: 'provider_error', httpStatus: 500 } : { status: 'sent', channel: 'local', id: null }));
    await save(d, { action: 'link_document', item_id: docItem, document_id: await upload() });
    fail = false;
    await save(d, { action: 'link_document', item_id: docItem, document_id: await upload() });
    expect(sent).toHaveLength(2);
  });

  it('refuses another contact’s file, an owner-held file, and a non-document item', async () => {
    const theirs = await upload(other);
    expect(await result(await save(deps([]), { action: 'link_document', item_id: docItem, document_id: theirs }))).toEqual([409, 'locked']);
    const ownerFile = await upload(CLIENT_CONTACT_ID, 'engagement.pdf', 'owner');
    expect(await result(await save(deps([]), { action: 'link_document', item_id: docItem, document_id: ownerFile }))).toEqual([409, 'locked']);
    expect(await result(await save(deps([]), { action: 'link_document', item_id: question, document_id: await upload() }))).toEqual([404, 'not_found']);
    expect(await item('status', docItem)).toEqual({ status: 'pending' });
  });
});

describe('needs-save: submit', () => {
  it('refuses an incomplete list, then hands it back once, with one email each', async () => {
    const sent: Sent[] = [];
    const d = deps(sent);
    expect(await result(await save(d, { action: 'submit', list_id: listId }))).toEqual([409, 'incomplete']);
    await save(d, { action: 'link_document', item_id: docItem, document_id: await upload() });
    await save(d, { action: 'save_answer', item_id: question, answer: 'Yes' });
    await save(d, { action: 'mark_item', item_id: todo, done: true });
    sent.length = 0;
    expect(await result(await save(d, { action: 'submit', list_id: listId }))).toEqual([200, 'submitted']);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [OWNER_EMAIL, `Request submitted: Request ${n}`],
      ['ada@example.com', `Received: Request ${n}`],
    ]);
    expect(sent[0].text).toContain(`${SITE}/contacts/${CLIENT_CONTACT_ID}/requests`);
    expect(sent[0].text).toContain('3 of 4 items answered');
    expect(await result(await save(d, { action: 'submit', list_id: listId }))).toEqual([200, 'already_submitted']);
    expect(sent).toHaveLength(2);
  });

  it('refuses another contact’s list and a closed one', async () => {
    const theirs = await one<string>(`SELECT list_id AS r FROM public.needs_items WHERE id = $1`, [otherItem]);
    expect(await result(await save(deps([]), { action: 'submit', list_id: theirs }))).toEqual([404, 'not_found']);
    await q(`UPDATE public.needs_lists SET status = 'closed' WHERE id = $1`, [listId]);
    expect(await result(await save(deps([]), { action: 'submit', list_id: listId }))).toEqual([409, 'not_open']);
  });
});

describe('needs-save: contact details', () => {
  it('saves the allowed fields, and never an email address', async () => {
    const before = (await q<{ email: string }>(`SELECT email FROM public.contacts WHERE id = $1`, [CLIENT_CONTACT_ID]))[0].email;
    const res = await save(deps([]), {
      action: 'save_contact', list_id: listId,
      fields: { phone: '555-0100', business_name: 'Acme LLC', spouse_first_name: '' },
    });
    expect(await result(res)).toEqual([200, 'saved']);
    const [c] = await q<Record<string, unknown>>(`SELECT phone, email, business_name, spouse_first_name FROM public.contacts WHERE id = $1`, [CLIENT_CONTACT_ID]);
    expect(c).toEqual({ phone: '555-0100', email: before, business_name: 'Acme LLC', spouse_first_name: null });
    const activity = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM public.client_activity_log WHERE contact_id = $1 AND action = 'profile_update' ORDER BY created_at DESC LIMIT 1`, [CLIENT_CONTACT_ID]);
    expect(activity[0].details).toEqual({ source: 'request', list_id: listId, fields: ['business_name', 'phone', 'spouse_first_name'], actor_role: 'client' });
    for (const field of ['email', 'spouse_email']) {
      const r = await save(deps([]), { action: 'save_contact', list_id: listId, fields: { [field]: `someone-${n}@example.com` } });
      expect(await result(r), field).toEqual([400, 'invalid_field']);
    }
    expect((await q<{ email: string }>(`SELECT email FROM public.contacts WHERE id = $1`, [CLIENT_CONTACT_ID]))[0].email).toBe(before);
  });

  it('refuses a field outside the list, a blank name, a list that does not ask', async () => {
    expect(() => contactUpdate({ status: 'client' })).toThrow();
    expect(() => contactUpdate({ first_name: ' ' })).toThrow();
    expect(() => contactUpdate({ email: 'ada@example.com' })).toThrow();
    expect(() => contactUpdate({ spouse_email: 'ada@example.com' })).toThrow();
    expect(() => contactUpdate({ phone: 5 })).toThrow();
    expect(() => contactUpdate({})).toThrow();
    expect(await result(await save(deps([]), { action: 'save_contact', list_id: listId, fields: { notes: 'x' } }))).toEqual([400, 'invalid_field']);
    await q(`UPDATE public.needs_lists SET include_contact_confirm = false WHERE id = $1`, [listId]);
    expect(await result(await save(deps([]), { action: 'save_contact', list_id: listId, fields: { phone: '1' } }))).toEqual([409, 'not_open']);
    expect(await result(await save(deps([]), { action: 'save_contact', list_id: randomUUID(), fields: { phone: '1' } }))).toEqual([404, 'not_found']);
  });
});
