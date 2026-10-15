// @vitest-environment node
// 0006_esign against real policy evaluation: who reads and writes each e-sign table, the
// signer column grants, the draft-only deletes (rows and working files), the freeze
// trigger and CHECKs, every RPC's behaviour and who may execute it, and the three
// cross-domain edits e-sign carries (the signature task guard in 0002, the branding
// fields in 0001, the envelope link on a documents row in 0003).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, as, become, createDb, errorOf, expectDenied, service, session, tryIn, user, type Principal } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const MFA_OWNER = '00000000-0000-4000-8000-000000000003';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const CONTACT_A = '10000000-0000-4000-8000-00000000000a';
const CONTACT_B = '10000000-0000-4000-8000-00000000000b';

const E_DRAFT = '20000000-0000-4000-8000-000000000001';
const E_SENT = '20000000-0000-4000-8000-000000000002';
const E_DONE = '20000000-0000-4000-8000-000000000003';
const D_DRAFT = '21000000-0000-4000-8000-000000000001';
const D_SENT = '21000000-0000-4000-8000-000000000002';
const S_DRAFT = '22000000-0000-4000-8000-000000000001';
const S_SENT_A = '22000000-0000-4000-8000-000000000002';
const S_SENT_B = '22000000-0000-4000-8000-000000000003';
const S_DONE = '22000000-0000-4000-8000-000000000004';
const T_TEMPLATE = '23000000-0000-4000-8000-000000000001';
const TASK_ESIGN = '24000000-0000-4000-8000-000000000001';
const TASK_OTHER = '24000000-0000-4000-8000-000000000002';
const DOC_UPLOAD = '25000000-0000-4000-8000-000000000001';

const HASH = (c: string) => c.repeat(64);

const owner = user(OWNER);
const clientA = user(USER_A);
const clientB = user(USER_B);
const mfaOwnerAal1 = user(MFA_OWNER);
const forger = user('00000000-0000-4000-8000-00000000000f', { appRole: 'admin' });

/** Owner-visible tables, and the three the server alone may touch. */
const OWNER_READ = [
  'esign_envelopes', 'esign_envelope_documents', 'esign_envelope_pages', 'esign_envelope_signers',
  'esign_envelope_fields', 'esign_envelope_events', 'esign_templates', 'esign_template_fields',
  'esign_completed_tombstones',
] as const;
const SERVER_ONLY = ['esign_sms_verifications', 'esign_signer_sessions', 'esign_signer_signature_images'] as const;
const ALL = [...OWNER_READ, ...SERVER_ONLY];

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'), ('${MFA_OWNER}', 'mfa@example.test'),
      ('${USER_A}', 'ada@example.test'), ('${USER_B}', 'bo@example.test');
    INSERT INTO public.org_profile (display_name, legal_name, contact_email, owner_user_id, system_user_id)
      VALUES ('Example Co', 'Example Company LLC', 'hello@example.com', '${OWNER}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, email, status) VALUES
      ('${CONTACT_A}', 'Ada', 'Lovelace', 'ada@example.test', 'client'),
      ('${CONTACT_B}', 'Bo', 'Baker', 'bo@example.test', 'client');
    INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES
      ('${CONTACT_A}', '${USER_A}', 'active', 'ada@example.test'),
      ('${CONTACT_B}', '${USER_B}', 'active', 'bo@example.test');
    INSERT INTO public.client_tasks (id, contact_id, title, type, link) VALUES
      ('${TASK_ESIGN}', '${CONTACT_A}', 'Signature needed', 'esign', '/portal/sign?signer=${S_SENT_A}'),
      ('${TASK_OTHER}', '${CONTACT_A}', 'Upload a receipt', 'action_item', NULL);

    INSERT INTO public.esign_envelopes (id, created_by, primary_contact_id, title, status, expires_at, sent_at, completed_at, signed_pdf_sha256)
    VALUES ('${E_DRAFT}', '${OWNER}', '${CONTACT_A}', 'Engagement letter', 'draft', NULL, NULL, NULL, NULL),
           ('${E_SENT}', '${OWNER}', '${CONTACT_A}', 'Lease', 'draft', now() + interval '14 days', now(), NULL, NULL),
           ('${E_DONE}', '${OWNER}', '${CONTACT_B}', 'Order form', 'draft', now() - interval '1 day', now() - interval '3 days',
            now() - interval '2 days', '${HASH('a')}');
    INSERT INTO public.esign_envelope_documents (id, envelope_id, "order", file_name, storage_path, byte_size, page_count) VALUES
      ('${D_DRAFT}', '${E_DRAFT}', 0, 'letter.pdf', '${E_DRAFT}/sources/${D_DRAFT}.pdf', 100, 2),
      ('${D_SENT}', '${E_SENT}', 0, 'lease.pdf', '${E_SENT}/sources/${D_SENT}.pdf', 100, 1);
    INSERT INTO public.esign_envelope_pages (envelope_id, "order", source_document_id, source_page_index) VALUES
      ('${E_DRAFT}', 0, '${D_DRAFT}', 0), ('${E_DRAFT}', 1, '${D_DRAFT}', 1), ('${E_SENT}', 0, '${D_SENT}', 0);
    INSERT INTO public.esign_envelope_signers (id, envelope_id, contact_id, "order", role, email, status, token_hash, token_expires_at,
                                               phone_ciphertext, phone_iv, phone_last_four, client_task_id) VALUES
      ('${S_DRAFT}', '${E_DRAFT}', '${CONTACT_A}', 0, 'primary', 'ada@example.test', 'pending', NULL, NULL, NULL, NULL, NULL, NULL),
      ('${S_SENT_A}', '${E_SENT}', '${CONTACT_A}', 0, 'primary', 'ada@example.test', 'invited', '${HASH('b')}', now() + interval '14 days',
       '\\x0102', '\\x0304', '1234', '${TASK_ESIGN}'),
      ('${S_SENT_B}', '${E_SENT}', NULL, 1, 'other', 'zed@example.test', 'viewed', '${HASH('c')}', now() + interval '14 days', NULL, NULL, NULL, NULL),
      ('${S_DONE}', '${E_DONE}', '${CONTACT_B}', 0, 'primary', 'bo@example.test', 'signed', NULL, NULL, NULL, NULL, NULL, NULL);
    INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height) VALUES
      ('${E_DRAFT}', '${S_DRAFT}', 0, 'signature', 10, 10, 100, 30), ('${E_SENT}', '${S_SENT_A}', 0, 'date', 10, 50, 80, 20);
    INSERT INTO public.esign_envelope_events (envelope_id, signer_id, event_type) VALUES
      ('${E_SENT}', '${S_SENT_A}', 'invite_sent'), ('${E_DRAFT}', NULL, 'envelope_created');
    -- Built as drafts, then moved on: the database takes shape changes from drafts only.
    UPDATE public.esign_envelopes SET status = 'sent' WHERE id = '${E_SENT}';
    UPDATE public.esign_envelopes SET status = 'completed' WHERE id = '${E_DONE}';
    INSERT INTO public.esign_templates (id, name, page_count, created_by) VALUES ('${T_TEMPLATE}', 'Standard letter', 2, '${OWNER}');
    INSERT INTO public.esign_template_fields (template_id, role, page_index, field_type, x, y, width, height)
      VALUES ('${T_TEMPLATE}', 'primary', 0, 'signature', 1, 1, 10, 10);
    INSERT INTO public.esign_completed_tombstones (envelope_id, title, signed_pdf_sha256)
      VALUES ('20000000-0000-4000-8000-0000000000ff', 'Old order form', '${HASH('d')}');
    INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at)
      VALUES ('${S_SENT_A}', '${HASH('e')}', '1234', now() + interval '10 minutes');
    INSERT INTO public.esign_signer_sessions (signer_id, session_token_hash, expires_at, ip)
      VALUES ('${S_SENT_A}', '${HASH('f')}', now() + interval '30 minutes', '203.0.113.5');
    INSERT INTO public.esign_signer_signature_images (signer_id, image_base64) VALUES ('${S_DONE}', 'iVBORw0KGgo=');
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('esign-working', '${E_DRAFT}/sources/${D_DRAFT}.pdf'), ('esign-working', '${E_SENT}/sources/${D_SENT}.pdf'),
      ('esign-working', '${E_SENT}/source.pdf');
    INSERT INTO public.client_documents (id, contact_id, filename, original_filename, storage_path, file_size, mime_type, held_by)
      VALUES ('${DOC_UPLOAD}', '${CONTACT_A}', 'x.pdf', 'x.pdf', '${CONTACT_A}/2026/x.pdf', 10, 'application/pdf', 'client');
  `);
  // The MFA-enrolled owner: an owner whose factor is verified, signed in at aal1.
  await db.exec(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${MFA_OWNER}', 'verified')`);
}, 60_000);

/** Set up as the server, then run `sql` as `who`; rolled back. */
async function asAfter<T = Record<string, unknown>>(setup: string, who: Principal, sql: string, params: unknown[] = []): Promise<T[]> {
  return session(db, service, async (tx) => {
    if (setup) await tx.exec(setup);
    await become(tx, who);
    return (await tx.query<T>(sql, params)).rows;
  });
}
const rows = (who: Principal, table: string, where = 'true') =>
  as<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`).then((r) => r[0].n);
/** The id column every e-sign table has (the image table keys on signer_id). */
const key = (table: string) => (table === 'esign_signer_signature_images' ? 'signer_id' : 'id');
const asMfaOwner = (sql: string) =>
  asAfter(`UPDATE public.org_profile SET owner_user_id = '${MFA_OWNER}'`, mfaOwnerAal1, sql);

describe('who reads what', () => {
  it('anon holds nothing on any e-sign table', async () => {
    for (const t of ALL) {
      await expectDenied(as(db, anon, `SELECT 1 FROM public.${t}`));
      await expectDenied(as(db, anon, `DELETE FROM public.${t}`));
    }
  });

  it('the owner reads every row of the nine owner tables; the server reads them too', async () => {
    for (const t of OWNER_READ) {
      const all = await rows(service, t);
      expect(all, t).toBeGreaterThan(0);
      expect(await as<{ n: number }>(db, owner, `SELECT count(${key(t)})::int AS n FROM public.${t}`), t).toEqual([{ n: all }]);
    }
  });

  it('nobody signed in reads the sessions, SMS codes or drawn images: not even the owner', async () => {
    for (const t of SERVER_ONLY) {
      expect(await rows(service, t), t).toBe(1);
      for (const who of [owner, clientA, clientB]) await expectDenied(as(db, who, `SELECT ${key(t)} FROM public.${t}`));
    }
  });

  it('a portal client reads no e-sign row, not even its own signer row or envelope', async () => {
    for (const who of [clientA, clientB]) {
      for (const t of OWNER_READ) {
        expect(await as<{ n: number }>(db, who, `SELECT count(${key(t)})::int AS n FROM public.${t}`), t).toEqual([{ n: 0 }]);
      }
    }
  });

  it('a forged admin claim reads nothing', async () => {
    for (const t of OWNER_READ) {
      expect(await as<{ n: number }>(db, forger, `SELECT count(${key(t)})::int AS n FROM public.${t}`), t).toEqual([{ n: 0 }]);
    }
  });

  it('an MFA-enrolled owner at aal1 is held by each table’s MFA gate', async () => {
    for (const t of OWNER_READ) {
      expect(await asMfaOwner(`SELECT count(${key(t)})::int AS n FROM public.${t}`), t).toEqual([{ n: 0 }]);
    }
  });

  it('View as client reads what the client reads: nothing', async () => {
    const MINTED = '60000000-0000-4000-8000-0000000000e1';
    const bind = `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
                  VALUES ('${OWNER}', '${CONTACT_A}', '${USER_A}', 'ada@example.test', '${MINTED}')`;
    const minted = user(USER_A, { sessionId: MINTED });
    for (const t of OWNER_READ) {
      expect(await asAfter(bind, minted, `SELECT count(${key(t)})::int AS n FROM public.${t}`), t).toEqual([{ n: 0 }]);
    }
  });
});

describe('the signer columns a browser never receives', () => {
  it.each(['token_hash', 'token_expires_at', 'phone_ciphertext', 'phone_iv'])('the owner selecting %s is refused', async (col) => {
    await expectDenied(as(db, owner, `SELECT ${col} FROM public.esign_envelope_signers`));
  });

  it('a select of every column fails loudly; the granted columns read', async () => {
    await expectDenied(as(db, owner, 'SELECT * FROM public.esign_envelope_signers'));
    const [r] = await as<{ email: string; phone_last_four: string }>(db, owner,
      `SELECT email, phone_last_four FROM public.esign_envelope_signers WHERE id = '${S_SENT_A}'`);
    expect(r).toEqual({ email: 'ada@example.test', phone_last_four: '1234' });
  });
});

describe('who writes what', () => {
  const inserts: Record<string, string> = {
    esign_envelopes: `INSERT INTO public.esign_envelopes (created_by, title) VALUES ('${OWNER}', 'Forged')`,
    esign_envelope_documents: `INSERT INTO public.esign_envelope_documents (envelope_id, "order", file_name, storage_path, byte_size, page_count)
                               VALUES ('${E_DRAFT}', 5, 'x.pdf', 'x', 1, 1)`,
    esign_envelope_pages: `INSERT INTO public.esign_envelope_pages (envelope_id, "order", source_document_id, source_page_index)
                           VALUES ('${E_DRAFT}', 9, '${D_DRAFT}', 0)`,
    esign_envelope_signers: `INSERT INTO public.esign_envelope_signers (envelope_id, "order", email) VALUES ('${E_DRAFT}', 3, 'x@example.test')`,
    esign_envelope_fields: `INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height)
                            VALUES ('${E_DRAFT}', '${S_DRAFT}', 0, 'date', 1, 1, 1, 1)`,
    esign_envelope_events: `INSERT INTO public.esign_envelope_events (envelope_id, event_type) VALUES ('${E_SENT}', 'signer_signed')`,
    esign_templates: `INSERT INTO public.esign_templates (name, page_count, created_by) VALUES ('Forged', 1, '${OWNER}')`,
    esign_template_fields: `INSERT INTO public.esign_template_fields (template_id, role, page_index, field_type, x, y, width, height)
                            VALUES ('${T_TEMPLATE}', 'primary', 0, 'date', 1, 1, 1, 1)`,
    esign_completed_tombstones: `INSERT INTO public.esign_completed_tombstones (envelope_id, title) VALUES ('${E_DONE}', 'Forged')`,
    esign_sms_verifications: `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at)
                              VALUES ('${S_SENT_A}', '${HASH('1')}', '0000', now())`,
    esign_signer_sessions: `INSERT INTO public.esign_signer_sessions (signer_id, session_token_hash, expires_at, ip)
                            VALUES ('${S_SENT_A}', '${HASH('2')}', now(), '203.0.113.9')`,
    esign_signer_signature_images: `INSERT INTO public.esign_signer_signature_images (signer_id, image_base64) VALUES ('${S_SENT_B}', 'x')`,
  };

  it('no signed-in session inserts into any e-sign table; the server does', async () => {
    for (const [t, sql] of Object.entries(inserts)) {
      for (const who of [owner, clientA, clientB]) await expectDenied(as(db, who, sql));
      expect(await errorOf(db, service, sql), t).toBeNull();
    }
  });

  it('no signed-in session updates an e-sign table, except a template’s deleted_at by the owner', async () => {
    for (const t of ALL) {
      for (const who of [owner, clientA]) {
        await expectDenied(as(db, who, `UPDATE public.${t} SET ${key(t)} = ${key(t)}`));
      }
    }
    await expectDenied(as(db, owner, `UPDATE public.esign_templates SET name = 'Renamed'`));
    expect(await as(db, owner, `UPDATE public.esign_templates SET deleted_at = now() RETURNING id`)).toEqual([{ id: T_TEMPLATE }]);
    expect(await as(db, clientA, `UPDATE public.esign_templates SET deleted_at = now() RETURNING id`)).toEqual([]);
    // The owner cannot move a signer, sign for one or complete an envelope.
    await expectDenied(as(db, owner, `UPDATE public.esign_envelope_signers SET status = 'signed'`));
    await expectDenied(as(db, owner, `UPDATE public.esign_envelopes SET status = 'completed'`));
  });

  it('no signed-in session deletes, not even the owner removing a draft envelope’s document (that is server work)', async () => {
    for (const t of ALL) {
      for (const who of [owner, clientA]) await expectDenied(as(db, who, `DELETE FROM public.${t}`));
    }
    await expectDenied(as(db, owner, `DELETE FROM public.esign_envelope_documents WHERE id = '${D_DRAFT}'`));
    expect(await as<{ n: number }>(db, service, `SELECT count(*)::int AS n FROM public.esign_envelope_documents WHERE id = '${D_DRAFT}'`)).toEqual([{ n: 1 }]);
  });

  it('the server writes every table', async () => {
    for (const t of ALL) expect(await errorOf(db, service, `UPDATE public.${t} SET ${key(t)} = ${key(t)}`), t).toBeNull();
  });
});

describe('the working bucket', () => {
  const objects = (who: Principal) =>
    as<{ name: string }>(db, who, `SELECT name FROM storage.objects WHERE bucket_id = 'esign-working' ORDER BY name`);

  it('is private, PDF only, 25 MiB', async () => {
    const [b] = await as<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(db, service,
      `SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'esign-working'`);
    expect(b).toEqual({ public: false, file_size_limit: 26214400, allowed_mime_types: ['application/pdf'] });
  });

  it('the owner reads every object; a client and anon none', async () => {
    expect((await objects(owner)).map((o) => o.name)).toHaveLength(3);
    expect(await objects(clientA)).toEqual([]);
    expect(await objects(anon)).toEqual([]);
  });

  it('nobody signed in writes or removes an object, the owner included, even in a draft’s folder', async () => {
    for (const who of [owner, clientA]) {
      expect(await as(db, who, `DELETE FROM storage.objects WHERE bucket_id = 'esign-working' RETURNING id`)).toEqual([]);
    }
    expect((await objects(owner)).map((o) => o.name)).toContain(`${E_DRAFT}/sources/${D_DRAFT}.pdf`);
    for (const who of [owner, clientA]) {
      await expectDenied(as(db, who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('esign-working', '${E_DRAFT}/x.pdf')`));
      expect(await as(db, who, `UPDATE storage.objects SET name = 'moved' WHERE bucket_id = 'esign-working' RETURNING id`)).toEqual([]);
    }
  });
});

describe('the envelope record', () => {
  it('a completed envelope’s completion never changes, for the server either', async () => {
    for (const set of [`status = 'voided'`, `completed_at = now()`, `signed_pdf_path = 'x'`, `signed_pdf_sha256 = '${HASH('9')}'`]) {
      expect(await errorOf(db, service, `UPDATE public.esign_envelopes SET ${set} WHERE id = '${E_DONE}'`), set).toMatch(/immutable/);
    }
    // The retention run clears the working path of a completed envelope.
    expect(await errorOf(db, service, `UPDATE public.esign_envelopes SET source_pdf_path = NULL WHERE id = '${E_DONE}'`)).toBeNull();
  });

  it('every envelope past draft carries a deadline', async () => {
    expect(await errorOf(db, service, `UPDATE public.esign_envelopes SET status = 'sent' WHERE id = '${E_DRAFT}'`)).toMatch(/sent_requires_expiry/);
    expect(await errorOf(db, service, `UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() WHERE id = '${E_DRAFT}'`)).toBeNull();
  });

  it('signer and template roles are the generic three and two', async () => {
    const signer = (role: string) => errorOf(db, service,
      `INSERT INTO public.esign_envelope_signers (envelope_id, "order", role, email) VALUES ('${E_DRAFT}', 7, '${role}', 'r@example.test')`);
    for (const role of ['primary', 'co_signer', 'other']) expect(await signer(role), role).toBeNull();
    for (const role of ['witness', 'spouse', 'approver']) expect(await signer(role), role).toMatch(/check constraint/);
    const field = (role: string) => errorOf(db, service,
      `INSERT INTO public.esign_template_fields (template_id, role, page_index, field_type, x, y, width, height)
       VALUES ('${T_TEMPLATE}', '${role}', 0, 'date', 1, 1, 1, 1)`);
    expect(await field('co_signer')).toBeNull();
    expect(await field('other')).toMatch(/check constraint/);
  });

  it('a signer email is stored lowercased and unique per envelope', async () => {
    expect(await errorOf(db, service, `INSERT INTO public.esign_envelope_signers (envelope_id, "order", email) VALUES ('${E_DRAFT}', 4, 'Ada@Example.test')`))
      .toMatch(/check constraint/);
    expect(await errorOf(db, service, `INSERT INTO public.esign_envelope_signers (envelope_id, "order", email) VALUES ('${E_DRAFT}', 4, 'ada@example.test')`))
      .toMatch(/duplicate key/);
  });

  it('a deleted contact leaves its envelopes and signers, unlinked', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`DELETE FROM public.contacts WHERE id = '${CONTACT_B}'`);
      return (await tx.query(`SELECT (SELECT primary_contact_id FROM public.esign_envelopes WHERE id = '${E_DONE}') AS env,
                                     (SELECT contact_id FROM public.esign_envelope_signers WHERE id = '${S_DONE}') AS signer`)).rows;
    });
    expect(out).toEqual([{ env: null, signer: null }]);
  });
});

describe('esign_insert_document_with_pages', () => {
  const call = (envelope: string, doc: string, pages: number) =>
    `SELECT public.esign_insert_document_with_pages('${envelope}', '${doc}', 'f.pdf', '${envelope}/sources/${doc}.pdf', 10, ${pages}) AS r`;

  it('orders documents and continues page orders above every page, deleted ones too', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.esign_envelope_pages SET deleted = true WHERE envelope_id = '${E_DRAFT}' AND "order" = 1`);
      const r = (await tx.query<{ r: { document_order: number; pages: Array<{ order: number; source_page_index: number }> } }>(
        call(E_DRAFT, '21000000-0000-4000-8000-0000000000aa', 3))).rows[0].r;
      return r;
    });
    expect(out.document_order).toBe(1);
    expect(out.pages.map((p) => [p.order, p.source_page_index])).toEqual([[2, 0], [3, 1], [4, 2]]);
  });

  it('refuses an envelope that is not a draft, and a missing one', async () => {
    expect(await errorOf(db, service, call(E_SENT, '21000000-0000-4000-8000-0000000000ab', 1))).toMatch(/not a draft/);
    expect(await errorOf(db, service, call('20000000-0000-4000-8000-0000000000ee', '21000000-0000-4000-8000-0000000000ac', 1))).toMatch(/not found/);
    expect(await errorOf(db, service, call(E_DRAFT, '21000000-0000-4000-8000-0000000000ad', 0))).toMatch(/page_count/);
  });
});

describe('esign_set_signer_fields', () => {
  const fields = JSON.stringify([
    { page_index: 1, field_type: 'signature', x: 5, y: 6, width: 100, height: 30 },
    { page_index: 0, field_type: 'date', x: 7, y: 8, width: 60, height: 20, required: false },
  ]);

  it('replaces one signer’s fields and returns the ids in the order given', async () => {
    const out = await session(db, service, async (tx) => {
      const ids = (await tx.query<{ r: string[] }>(`SELECT public.esign_set_signer_fields($1, $2, $3::jsonb) AS r`, [E_DRAFT, S_DRAFT, fields])).rows[0].r;
      const stored = (await tx.query<{ id: string; page_index: number; required: boolean }>(
        `SELECT id, page_index, required FROM public.esign_envelope_fields WHERE signer_id = $1`, [S_DRAFT])).rows;
      return { ids, stored };
    });
    expect(out.ids).toHaveLength(2);
    expect(out.stored).toHaveLength(2);
    const byId = new Map(out.stored.map((f) => [f.id, f]));
    expect(byId.get(out.ids[0])).toMatchObject({ page_index: 1, required: true });
    expect(byId.get(out.ids[1])).toMatchObject({ page_index: 0, required: false });
  });

  it('refuses a sent envelope and a signer of another envelope, changing nothing', async () => {
    expect(await errorOf(db, service, `SELECT public.esign_set_signer_fields('${E_SENT}', '${S_SENT_A}', '[]'::jsonb)`)).toMatch(/not a draft/);
    expect(await errorOf(db, service, `SELECT public.esign_set_signer_fields('${E_DRAFT}', '${S_SENT_A}', '[]'::jsonb)`)).toMatch(/signer not found/);
    expect(await rows(service, 'esign_envelope_fields', `signer_id = '${S_SENT_A}'`)).toBe(1);
  });

  it('one bad field rolls the whole replacement back', async () => {
    const bad = JSON.stringify([{ page_index: 0, field_type: 'stamp', x: 1, y: 1, width: 1, height: 1 }]);
    expect(await errorOf(db, service, `SELECT public.esign_set_signer_fields($1, $2, $3::jsonb)`, [E_DRAFT, S_DRAFT, bad])).toMatch(/check constraint/);
    expect(await rows(service, 'esign_envelope_fields', `signer_id = '${S_DRAFT}'`)).toBe(1);
  });
});

describe('esign_apply_page_reorder', () => {
  it('swaps two live pages without tripping the live-order index, and applies the field remap', async () => {
    const out = await session(db, service, async (tx) => {
      const pages = (await tx.query<{ id: string; order: number }>(
        `SELECT id, "order" FROM public.esign_envelope_pages WHERE envelope_id = $1 ORDER BY "order"`, [E_DRAFT])).rows;
      const field = (await tx.query<{ id: string }>(`SELECT id FROM public.esign_envelope_fields WHERE signer_id = $1`, [S_DRAFT])).rows[0];
      const ops = JSON.stringify([{ page_id: pages[0].id, order: 1 }, { page_id: pages[1].id, order: 0 }]);
      const r = (await tx.query<{ r: unknown }>(`SELECT public.esign_apply_page_reorder($1, $2::jsonb, $3::jsonb, '{}'::uuid[]) AS r`,
        [E_DRAFT, ops, JSON.stringify([{ id: field.id, page_index: 1 }])])).rows[0].r;
      const after = (await tx.query<{ id: string; order: number }>(
        `SELECT id, "order" FROM public.esign_envelope_pages WHERE envelope_id = $1 ORDER BY "order"`, [E_DRAFT])).rows;
      const moved = (await tx.query<{ page_index: number }>(`SELECT page_index FROM public.esign_envelope_fields WHERE id = $1`, [field.id])).rows[0];
      return { r, before: pages.map((p) => p.id), after: after.map((p) => p.id), moved };
    });
    expect(out.r).toEqual({ pages_updated: 2, fields_updated: 1, fields_deleted: 0 });
    expect(out.after).toEqual([out.before[1], out.before[0]]);
    expect(out.moved.page_index).toBe(1);
  });

  it('deletes a page and its fields; refuses a sent envelope and a page of another envelope', async () => {
    const out = await session(db, service, async (tx) => {
      const page = (await tx.query<{ id: string }>(`SELECT id FROM public.esign_envelope_pages WHERE envelope_id = $1 AND "order" = 0`, [E_DRAFT])).rows[0];
      const field = (await tx.query<{ id: string }>(`SELECT id FROM public.esign_envelope_fields WHERE signer_id = $1`, [S_DRAFT])).rows[0];
      const r = (await tx.query(`SELECT public.esign_apply_page_reorder($1, $2::jsonb, '[]'::jsonb, $3::uuid[]) AS r`,
        [E_DRAFT, JSON.stringify([{ page_id: page.id, deleted: true }]), [field.id]])).rows[0];
      return r;
    });
    expect(out).toEqual({ r: { pages_updated: 1, fields_updated: 0, fields_deleted: 1 } });
    const sentPage = (await as<{ id: string }>(db, service, `SELECT id FROM public.esign_envelope_pages WHERE envelope_id = '${E_SENT}'`))[0].id;
    expect(await errorOf(db, service, `SELECT public.esign_apply_page_reorder($1, $2::jsonb, '[]'::jsonb, '{}'::uuid[])`,
      [E_SENT, JSON.stringify([{ page_id: sentPage, deleted: true }])])).toMatch(/not a draft/);
    expect(await errorOf(db, service, `SELECT public.esign_apply_page_reorder($1, $2::jsonb, '[]'::jsonb, '{}'::uuid[])`,
      [E_DRAFT, JSON.stringify([{ page_id: sentPage, deleted: true }])])).toMatch(/not in this envelope/);
  });
});

describe('esign_delete_draft_document', () => {
  it('applies the field remap and deletes the document with its pages; returns the object path', async () => {
    const out = await session(db, service, async (tx) => {
      const field = (await tx.query<{ id: string }>(`SELECT id FROM public.esign_envelope_fields WHERE signer_id = $1`, [S_DRAFT])).rows[0];
      const r = (await tx.query<{ r: string }>(`SELECT public.esign_delete_draft_document($1, $2, '[]'::jsonb, $3::uuid[]) AS r`,
        [E_DRAFT, D_DRAFT, [field.id]])).rows[0].r;
      const left = (await tx.query(`SELECT 1 FROM public.esign_envelope_pages WHERE source_document_id = $1
                                    UNION ALL SELECT 1 FROM public.esign_envelope_documents WHERE id = $1
                                    UNION ALL SELECT 1 FROM public.esign_envelope_fields WHERE id = $2`, [D_DRAFT, field.id])).rows;
      return { r, left };
    });
    expect(out).toEqual({ r: `${E_DRAFT}/sources/${D_DRAFT}.pdf`, left: [] });
  });

  it('refuses a sent envelope, and a document of another envelope', async () => {
    expect(await errorOf(db, service, `SELECT public.esign_delete_draft_document($1, $2, '[]'::jsonb, '{}'::uuid[])`, [E_SENT, D_SENT]))
      .toMatch(/not a draft/);
    expect(await errorOf(db, service, `SELECT public.esign_delete_draft_document($1, $2, '[]'::jsonb, '{}'::uuid[])`, [E_DRAFT, D_SENT]))
      .toMatch(/not in this envelope/);
    expect(await as(db, service, `SELECT id FROM public.esign_envelope_documents WHERE id IN ('${D_DRAFT}', '${D_SENT}') ORDER BY id`))
      .toEqual([{ id: D_DRAFT }, { id: D_SENT }]);
  });
});

describe('esign_claim_signer_signature', () => {
  const claim = (signer: string, kind = 'typed', image: string | null = null) =>
    `SELECT public.esign_claim_signer_signature('${signer}', '${kind}', 'Ada Lovelace', 'allison', ${image === null ? 'NULL' : `'${image}'`},
       now(), '203.0.113.5', 'ua', 'email', 'Europe/London', 'v1') AS ok`;

  it('claims an invited signer once; the second claim is refused', async () => {
    const out = await session(db, service, async (tx) => {
      const first = (await tx.query<{ ok: boolean }>(claim(S_SENT_A))).rows[0].ok;
      const second = (await tx.query<{ ok: boolean }>(claim(S_SENT_A))).rows[0].ok;
      const row = (await tx.query<{ status: string; expired: boolean; consent: string }>(
        `SELECT status, token_expires_at <= now() AS expired, consent_disclosure_version AS consent FROM public.esign_envelope_signers WHERE id = '${S_SENT_A}'`)).rows[0];
      return { first, second, row };
    });
    expect(out).toEqual({ first: true, second: false, row: { status: 'signed', expired: true, consent: 'v1' } });
  });

  it('refuses a voided envelope and a signer who already declined', async () => {
    expect(await asAfter(`UPDATE public.esign_envelopes SET status = 'voided' WHERE id = '${E_SENT}'`, service, claim(S_SENT_A))).toEqual([{ ok: false }]);
    expect(await asAfter(`UPDATE public.esign_envelope_signers SET status = 'declined' WHERE id = '${S_SENT_A}'`, service, claim(S_SENT_A)))
      .toEqual([{ ok: false }]);
  });

  it('keeps consent recorded earlier', async () => {
    const out = await asAfter<{ v: string }>(
      `UPDATE public.esign_envelope_signers SET consented_at = now() - interval '1 hour', consent_disclosure_version = 'v0' WHERE id = '${S_SENT_A}';
       ${claim(S_SENT_A)}`,
      service, `SELECT consent_disclosure_version AS v FROM public.esign_envelope_signers WHERE id = '${S_SENT_A}'`);
    expect(out).toEqual([{ v: 'v0' }]);
  });

  it('a drawn signature needs its image, stored beside the row; a typed one may not carry one', async () => {
    expect(await errorOf(db, service, claim(S_SENT_B, 'drawn'))).toMatch(/requires an image/);
    expect(await errorOf(db, service, claim(S_SENT_B, 'typed', 'abc='))).toMatch(/cannot carry an image/);
    expect(await errorOf(db, service, claim(S_SENT_B, 'stamp'))).toMatch(/invalid kind/);
    const out = await asAfter(claim(S_SENT_B, 'drawn', 'iVBORw0KGgo='), service,
      `SELECT image_base64 FROM public.esign_signer_signature_images WHERE signer_id = '${S_SENT_B}'`);
    expect(out).toEqual([{ image_base64: 'iVBORw0KGgo=' }]);
  });
});

describe('esign_check_sms_code', () => {
  const check = (hash: string, ip = `'203.0.113.5'`) =>
    `SELECT public.esign_check_sms_code('${S_SENT_A}', '${hash}', 5, '${HASH('7')}', ${ip}, 30) AS r`;
  const run = (setup: string, ...hashes: string[]) =>
    session(db, service, async (tx) => {
      if (setup) await tx.exec(setup);
      const out: unknown[] = [];
      for (const h of hashes) out.push((await tx.query<{ r: unknown }>(check(h))).rows[0].r);
      const sessions = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.esign_signer_sessions WHERE session_token_hash = '${HASH('7')}'`)).rows[0].n;
      return { out, sessions };
    });

  it('approves the right code once and opens one session; the code is then spent', async () => {
    expect(await run('', HASH('e'), HASH('e'))).toEqual({
      out: [{ status: 'approved', attempts: 1 }, { status: 'none', attempts: 0 }],
      sessions: 1,
    });
  });

  it('counts wrong codes and locks at the fifth, after which even the right code is refused', async () => {
    const r = await run('', HASH('0'), HASH('0'), HASH('0'), HASH('0'), HASH('0'), HASH('e'));
    expect(r.out).toEqual([
      { status: 'invalid', attempts: 1 }, { status: 'invalid', attempts: 2 }, { status: 'invalid', attempts: 3 },
      { status: 'invalid', attempts: 4 }, { status: 'locked', attempts: 5 }, { status: 'locked', attempts: 5 },
    ]);
    expect(r.sessions).toBe(0);
  });

  it('an expired code is refused', async () => {
    expect((await run(`UPDATE public.esign_sms_verifications SET expires_at = now() - interval '1 second'`, HASH('e'))).out)
      .toEqual([{ status: 'expired', attempts: 0 }]);
  });

  it('a newer code supersedes the older one', async () => {
    const newer = `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at)
                   VALUES ('${S_SENT_A}', '${HASH('8')}', '1234', now() + interval '10 minutes', now() + interval '1 second')`;
    expect((await run(newer, HASH('e'), HASH('8'))).out).toEqual([{ status: 'invalid', attempts: 1 }, { status: 'approved', attempts: 2 }]);
  });

  it('issuing a code spends the signer’s older ones at once', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at)
                     VALUES ('${S_SENT_A}', '${HASH('8')}', '1234', now() + interval '10 minutes')`);
      return (await tx.query<{ h: string; spent: boolean }>(
        `SELECT left(code_hash, 1) AS h, consumed_at IS NOT NULL AS spent FROM public.esign_sms_verifications WHERE signer_id = '${S_SENT_A}' ORDER BY h`,
      )).rows;
    });
    expect(out).toEqual([{ h: '8', spent: false }, { h: 'e', spent: true }]);
  });

  it('once the newest code is used, an older one never comes back to life', async () => {
    const newer = `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at)
                   VALUES ('${S_SENT_A}', '${HASH('8')}', '1234', now() + interval '10 minutes', now() + interval '1 second')`;
    expect((await run(newer, HASH('8'), HASH('e'))).out).toEqual([{ status: 'approved', attempts: 1 }, { status: 'none', attempts: 0 }]);
  });

  it('an approval spends every code the signer still holds, not just the one it matched', async () => {
    // Two outstanding codes, as if the older one had escaped the supersede trigger.
    const both = `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at)
                  VALUES ('${S_SENT_A}', '${HASH('8')}', '1234', now() + interval '10 minutes', now() + interval '1 second');
                  UPDATE public.esign_sms_verifications SET consumed_at = NULL WHERE code_hash = '${HASH('e')}'`;
    expect((await run(both, HASH('8'), HASH('e'))).out).toEqual([{ status: 'approved', attempts: 1 }, { status: 'none', attempts: 0 }]);
  });

  it('another signer’s code never approves this one', async () => {
    const other = `DELETE FROM public.esign_sms_verifications;
                   INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at)
                   VALUES ('${S_SENT_B}', '${HASH('e')}', '1234', now() + interval '10 minutes')`;
    expect((await run(other, HASH('e'))).out).toEqual([{ status: 'none', attempts: 0 }]);
  });

  it('refuses a call with no address', async () => {
    expect(await errorOf(db, service, check(HASH('e'), 'NULL'))).toMatch(/address is required/);
  });
});

describe('an envelope’s shape changes only while it is a draft', () => {
  it('the server too is refused a shape change once the envelope is sent or completed', async () => {
    const refused = [
      `INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height)
         VALUES ('${E_SENT}', '${S_SENT_A}', 0, 'signature', 1, 1, 10, 10)`,
      `DELETE FROM public.esign_envelope_fields WHERE envelope_id = '${E_SENT}'`,
      `UPDATE public.esign_envelope_fields SET x = 99 WHERE envelope_id = '${E_SENT}'`,
      `DELETE FROM public.esign_envelope_pages WHERE envelope_id = '${E_SENT}'`,
      `DELETE FROM public.esign_envelope_documents WHERE envelope_id = '${E_SENT}'`,
      `INSERT INTO public.esign_envelope_signers (envelope_id, "order", role, email) VALUES ('${E_SENT}', 9, 'other', 'late@example.test')`,
      `DELETE FROM public.esign_envelope_signers WHERE id = '${S_SENT_B}'`,
      `UPDATE public.esign_envelope_signers SET email = 'swap@example.test' WHERE id = '${S_SENT_A}'`,
      `UPDATE public.esign_envelope_signers SET role = 'other' WHERE id = '${S_SENT_A}'`,
      `UPDATE public.esign_envelope_signers SET status = 'pending' WHERE id = '${S_SENT_A}'`,
      `UPDATE public.esign_envelope_signers SET status = 'pending' WHERE id = '${S_DONE}'`,
    ];
    for (const sql of refused) expect(await errorOf(db, service, sql), sql).toMatch(/not a draft/);
  });

  it('a signer’s life after send, a deleted contact and a deleted envelope still pass', async () => {
    for (const sql of [
      `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = '${S_SENT_A}'`,
      `UPDATE public.esign_envelope_signers SET token_hash = '${HASH('9')}', opened_email_at = now() WHERE id = '${S_SENT_B}'`,
      `UPDATE public.esign_envelope_signers SET contact_id = NULL WHERE id = '${S_SENT_A}'`,
      `DELETE FROM public.esign_envelopes WHERE id = '${E_SENT}'`,
    ]) {
      expect(await errorOf(db, service, sql), sql).toBeNull();
    }
  });

  it('every draft edit bumps the draft revision', async () => {
    const out = await session(db, service, async (tx) => {
      const rev = async () => (await tx.query<{ r: number }>(`SELECT draft_revision AS r FROM public.esign_envelopes WHERE id = '${E_DRAFT}'`)).rows[0].r;
      const before = await rev();
      await tx.exec(`UPDATE public.esign_envelope_fields SET x = 11 WHERE envelope_id = '${E_DRAFT}'`);
      const afterField = await rev();
      await tx.exec(`UPDATE public.esign_envelope_signers SET role = 'other' WHERE id = '${S_DRAFT}'`);
      return { field: afterField - before, signer: (await rev()) - afterField };
    });
    expect(out).toEqual({ field: 1, signer: 1 });
  });
});

describe('esign_expire_envelope', () => {
  const expire = (setup: string) =>
    session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.esign_envelopes SET expires_at = now() - interval '1 minute' WHERE id = '${E_SENT}'; ${setup}`);
      const r = (await tx.query<{ r: Record<string, unknown> }>(`SELECT public.esign_expire_envelope('${E_SENT}', now()) AS r`)).rows[0].r;
      const env = (await tx.query<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = '${E_SENT}'`)).rows[0].status;
      const signers = (await tx.query<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = '${E_SENT}' ORDER BY "order"`)).rows.map((x) => x.status);
      return { r, env, signers };
    });

  it('expires the waiting signers and the envelope together, and names the tasks to dismiss', async () => {
    expect(await expire('')).toEqual({
      r: { status: 'expired', signers_expired: 2, task_ids: [TASK_ESIGN] },
      env: 'expired',
      signers: ['expired', 'expired'],
    });
  });

  it('leaves an envelope everyone signed for finalize, untouched', async () => {
    expect(await expire(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE envelope_id = '${E_SENT}'`)).toEqual({
      r: { status: 'all_signed', signers_expired: 0, task_ids: [] },
      env: 'sent',
      signers: ['signed', 'signed'],
    });
  });

  it('keeps a signer who signed, expiring only the rest', async () => {
    const out = await expire(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = '${S_SENT_A}'`);
    expect(out).toEqual({ r: { status: 'expired', signers_expired: 1, task_ids: [] }, env: 'expired', signers: ['signed', 'expired'] });
  });

  it('does nothing to an envelope no longer due: ended another way, or given more time', async () => {
    for (const setup of [
      `UPDATE public.esign_envelopes SET status = 'declined' WHERE id = '${E_SENT}'`,
      `UPDATE public.esign_envelopes SET expires_at = now() + interval '1 day' WHERE id = '${E_SENT}'`,
    ]) {
      expect((await expire(setup)).r).toEqual({ status: 'not_due', signers_expired: 0, task_ids: [] });
    }
  });
});

describe('one executed copy per envelope and contact', () => {
  it('a second documents row for the same envelope and contact is refused', async () => {
    const row = (id: string) => `('${id}', '${CONTACT_B}', 'e.pdf', 'e.pdf', '${CONTACT_B}/esign/${E_DONE}.pdf', 10, 'application/pdf', 'owner', '${E_DONE}')`;
    expect(await errorOf(db, service, `INSERT INTO public.client_documents (id, contact_id, filename, original_filename, storage_path, file_size, mime_type, held_by, esign_envelope_id)
      VALUES ${row('25000000-0000-4000-8000-0000000000e1')}, ${row('25000000-0000-4000-8000-0000000000e2')}`))
      .toMatch(/client_documents_esign_envelope_contact_key/);
  });
});

describe('retention', () => {
  const images = `INSERT INTO public.esign_signer_signature_images (signer_id, image_base64) VALUES ('${S_SENT_A}', 'x'), ('${S_SENT_B}', 'y')`;
  const purge = (cutoff: string) => `SELECT public.esign_purge_terminal_signature_images(${cutoff}, 100) AS n`;

  it('purges terminal envelopes by each status’s own moment, never a live one', async () => {
    // E_DONE completed 2 days ago; E_SENT is live.
    expect(await asAfter(images, service, purge(`now() - interval '3 days'`))).toEqual([{ n: 0 }]);
    expect(await asAfter(images, service, purge(`now() - interval '1 day'`))).toEqual([{ n: 1 }]);
    // Voided: aged by voided_at, not by when it was created.
    expect(await asAfter(`${images}; UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() - interval '5 days' WHERE id = '${E_SENT}'`,
      service, purge(`now() - interval '4 days'`))).toEqual([{ n: 2 }]);
    // Expired: aged by the deadline it passed (14 days ahead here, so not yet).
    expect(await asAfter(`${images}; UPDATE public.esign_envelopes SET status = 'expired' WHERE id = '${E_SENT}'`,
      service, purge(`now() - interval '1 day'`))).toEqual([{ n: 1 }]);
  });

  it('p_limit below one is refused', async () => {
    expect(await errorOf(db, service, `SELECT public.esign_purge_terminal_signature_images(now(), 0)`)).toMatch(/p_limit/);
  });

  it('drops one envelope’s images', async () => {
    expect(await asAfter(images, service, `SELECT public.esign_delete_signature_images_for_envelope('${E_SENT}') AS n`)).toEqual([{ n: 2 }]);
  });

  it('prunes SMS code rows after 30 days and sessions a day after they expire', async () => {
    const old = `UPDATE public.esign_sms_verifications SET created_at = now() - interval '31 days';
                 UPDATE public.esign_signer_sessions SET expires_at = now() - interval '2 days'`;
    expect(await asAfter(old, service, `SELECT public.esign_prune_operational() AS r`))
      .toEqual([{ r: { sms_codes_deleted: 1, sessions_deleted: 1 } }]);
    expect(await as(db, service, `SELECT public.esign_prune_operational() AS r`)).toEqual([{ r: { sms_codes_deleted: 0, sessions_deleted: 0 } }]);
  });
});

describe('who may execute the e-sign functions', () => {
  const SIGS = [
    'esign_insert_document_with_pages(uuid,uuid,text,text,bigint,integer)',
    'esign_set_signer_fields(uuid,uuid,jsonb)',
    'esign_apply_page_reorder(uuid,jsonb,jsonb,uuid[])',
    'esign_delete_draft_document(uuid,uuid,jsonb,uuid[])',
    'esign_claim_signer_signature(uuid,text,text,text,text,timestamptz,inet,text,text,text,text)',
    'esign_check_sms_code(uuid,text,integer,text,inet,integer)',
    'esign_delete_signature_images_for_envelope(uuid)',
    'esign_purge_terminal_signature_images(timestamptz,integer)',
    'esign_prune_operational()',
  ];
  const can = async (role: string, sig: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `public.${sig}`])).rows[0].ok;

  it.each(SIGS)('%s: the server only', async (sig) => {
    expect(await can('service_role', sig)).toBe(true);
    expect(await can('authenticated', sig)).toBe(false);
    expect(await can('anon', sig)).toBe(false);
  });

  it('the owner calling one is refused', async () => {
    await expectDenied(as(db, owner, 'SELECT public.esign_prune_operational()'));
    await expectDenied(as(db, owner, `SELECT public.esign_delete_signature_images_for_envelope('${E_DONE}')`));
  });

  it('the freeze trigger runs for everyone and is callable by no one', async () => {
    expect(await can('service_role', 'esign_freeze_completed_envelope()')).toBe(false);
    expect(await can('authenticated', 'esign_freeze_completed_envelope()')).toBe(false);
  });
});

describe('cross-domain: a signature task (0002)', () => {
  const setStatus = (task: string, status: string) => `UPDATE public.client_tasks SET status = '${status}' WHERE id = '${task}' RETURNING id`;

  it('a client cannot complete or dismiss its signature task', async () => {
    for (const status of ['completed', 'dismissed']) {
      const err = await expectDenied(as(db, clientA, setStatus(TASK_ESIGN, status)));
      expect(err.message).toMatch(/signature task/);
    }
  });

  it('a client still completes an ordinary task; the server and owner move a signature task', async () => {
    expect(await as(db, clientA, setStatus(TASK_OTHER, 'completed'))).toEqual([{ id: TASK_OTHER }]);
    expect(await as(db, service, setStatus(TASK_ESIGN, 'completed'))).toEqual([{ id: TASK_ESIGN }]);
    expect(await as(db, owner, setStatus(TASK_ESIGN, 'dismissed'))).toEqual([{ id: TASK_ESIGN }]);
  });
});

describe('cross-domain: branding for the signer pages (0001)', () => {
  it('anon reads the legal name and the contact email, never a user id', async () => {
    const [{ v }] = await as<{ v: Record<string, unknown> }>(db, anon, 'SELECT public.get_org_branding() AS v');
    expect(v).toMatchObject({ display_name: 'Example Co', legal_name: 'Example Company LLC', contact_email: 'hello@example.com' });
    expect(JSON.stringify(v)).not.toContain(OWNER);
  });

  it('the contact email must look like one address', async () => {
    for (const bad of ['no-at-sign', 'a@b', 'a b@example.com', 'x@example.com\ny@example.com']) {
      expect(await errorOf(db, service, `UPDATE public.org_profile SET contact_email = $1`, [bad]), bad).toMatch(/check constraint/);
    }
    expect(await errorOf(db, service, `UPDATE public.org_profile SET contact_email = 'help@example.org'`)).toBeNull();
  });
});

describe('cross-domain: an executed copy names its envelope (0003)', () => {
  it('the link goes when the envelope goes; the row stays', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.client_documents SET esign_envelope_id = '${E_DONE}' WHERE id = '${DOC_UPLOAD}'`);
      await tx.exec(`DELETE FROM public.esign_envelopes WHERE id = '${E_DONE}'`);
      return (await tx.query(`SELECT id, esign_envelope_id FROM public.client_documents WHERE id = '${DOC_UPLOAD}'`)).rows;
    });
    expect(out).toEqual([{ id: DOC_UPLOAD, esign_envelope_id: null }]);
  });

  it('a client cannot mark its own upload as an executed copy', async () => {
    const err = await session(db, clientA, (tx) =>
      tryIn(tx, `UPDATE public.client_documents SET esign_envelope_id = '${E_DONE}' WHERE id = '${DOC_UPLOAD}'`));
    expect(err).toMatch(/not client-writable/);
  });
});
