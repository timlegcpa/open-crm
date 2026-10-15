// @vitest-environment node
// needs-reveal-answer against the real migrations in PGlite: a sensitive answer is shown
// only after its reveal is audited, with ids only, and never when the audit fails.
import type { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import { createRevealAnswerHandler, type RevealDeps, type SensitiveItemRow } from '../../../supabase/functions/needs-reveal-answer/handler';
import { createAudit } from '../../../supabase/functions/_shared/audit';
import { encryptPii } from '../../../supabase/functions/_shared/crypto';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

const PII_KEY = randomBytes(32).toString('base64');
const SECRET = 'secret-answer-0123456789';

let db: PGlite;
let contactId: string;
let listId: string;
let answered: string;
let unanswered: string;
let plain: string;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

function deps(over: Partial<RevealDeps> = {}): RevealDeps {
  const audit = createAudit({ db: serviceClient(db) });
  return {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    piiKey: PII_KEY,
    async loadItem(id) {
      const [row] = await q<SensitiveItemRow>(
        `SELECT i.id, i.list_id, l.contact_id, i.sensitive, i.answer_ciphertext
           FROM public.needs_items i JOIN public.needs_lists l ON l.id = i.list_id WHERE i.id = $1`, [id]);
      return row ?? null;
    },
    audit: (entry) => audit.write(entry),
    logSink: () => {},
    ...over,
  };
}

const reveal = (d: RevealDeps, itemId: string) =>
  createRevealAnswerHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body: { item_id: itemId } }));

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  // The contract's owner id must exist for the audit row's actor.
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'contract-owner@example.com')`, [OWNER_ID]);
  contactId = await seedContact(db, { first_name: 'Ada' });
  listId = (await q<{ id: string }>(
    `INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Setup', 'sent', now()) RETURNING id`, [contactId]))[0].id;
  const cipher = await encryptPii(SECRET, PII_KEY);
  answered = (await q<{ id: string }>(
    `INSERT INTO public.needs_items (list_id, kind, label, sensitive, answer_ciphertext, status)
     VALUES ($1, 'question', 'Passport number', true, $2, 'fulfilled') RETURNING id`, [listId, cipher]))[0].id;
  unanswered = (await q<{ id: string }>(
    `INSERT INTO public.needs_items (list_id, kind, label, sensitive) VALUES ($1, 'question', 'Account', true) RETURNING id`, [listId]))[0].id;
  plain = (await q<{ id: string }>(
    `INSERT INTO public.needs_items (list_id, kind, label, answer_text) VALUES ($1, 'question', 'Colour', 'Blue') RETURNING id`, [listId]))[0].id;
}, 60_000);

describeEdgeContract({
  name: 'needs-reveal-answer',
  handler: async (req) => createRevealAnswerHandler(deps())(req),
  failingHandler: async (req) => createRevealAnswerHandler(deps({ loadItem: throwInternal }))(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { item_id: '00000000-0000-4000-8000-00000000ffff' }, maxBytes: 1024 },
});

describe('needs-reveal-answer', () => {
  it('decrypts the answer and audits the reveal with ids only', async () => {
    const res = await reveal(deps(), answered);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: SECRET });
    const rows = await q<{ user_id: string; details: Record<string, unknown> }>(
      `SELECT user_id, details FROM public.audit_logs WHERE action = 'needs.reveal_answer'`);
    expect(rows).toEqual([{ user_id: OWNER_ID, details: { item_id: answered, list_id: listId, contact_id: contactId } }]);
    expect(JSON.stringify(rows)).not.toContain('Passport number');
  });

  it('shows nothing when the audit cannot be written', async () => {
    const res = await reveal(deps({ audit: throwInternal }), answered);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('answers 404 for an unanswered, a non-sensitive or a missing item', async () => {
    for (const id of [unanswered, plain, randomUUID()]) {
      const res = await reveal(deps(), id);
      expect([id, res.status]).toEqual([id, 404]);
    }
  });

  it('refuses without the key, before reading anything', async () => {
    let read = false;
    const res = await reveal(deps({ piiKey: null, loadItem: async () => { read = true; return null; } }), answered);
    expect(res.status).toBe(503);
    expect(read).toBe(false);
  });
});
