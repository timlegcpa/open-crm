// @vitest-environment node
// esign-manage-signers against the real migrations: every signer links to the right
// contact or a new signer-only one, an address two contacts share is never guessed, and
// a phone is stored only encrypted.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { decryptPiiSplit, fromBytea } from '../../../supabase/functions/_shared/crypto';
import { createManageSignersHandler, exactIlike, type ManageSignersDeps } from '../../../supabase/functions/esign-manage-signers/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID } from './contract';
import { createWorld, landsBeforeFirst, ORIGINS, PII_KEY, SEND_SQL, seedContact, withRace, type World } from './esign-world';

let w: World;

function deps(over: Partial<ManageSignersDeps> = {}): ManageSignersDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, piiKey: PII_KEY, logSink: w.logSink, ...over };
}

const manage = (body: unknown, d = deps()) => createManageSignersHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

async function draft(status = 'draft'): Promise<string> {
  const [row] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelopes (created_by, title, status, expires_at) VALUES ($1, 'Letter', $2, CASE WHEN $2 = 'draft' THEN NULL ELSE now() + interval '1 day' END) RETURNING id`,
    [OWNER_ID, status],
  );
  return row.id;
}

const add = (envelope_id: string, signer: Record<string, unknown>) =>
  manage({ envelope_id, action: 'add', signer: { first_name: 'Ada', last_name: 'Lovelace', order: 0, ...signer } });

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-manage-signers', () => {
  describeEdgeContract({
    name: 'esign-manage-signers',
    get handler() {
      return createManageSignersHandler(deps());
    },
    get failingHandler() {
      return createManageSignersHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); } } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: randomUUID(), action: 'remove', signer: { signer_id: randomUUID() } }, maxBytes: 16_384 },
  });

  it('links an existing contact by email, any case, and stores the email lowercased', async () => {
    const contact = await seedContact(w, { email: 'Charles.Babbage@Example.com', first_name: 'Charles', last_name: 'Babbage' });
    const env = await draft();
    const res = await add(env, { email: 'CHARLES.babbage@example.com' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, signer_id: expect.any(String), contact_id: contact });
    const [row] = await w.q<{ email: string; role: string; status: string }>(`SELECT email, role, status FROM public.esign_envelope_signers WHERE id = $1`, [body.signer_id]);
    expect(row).toEqual({ email: 'charles.babbage@example.com', role: 'other', status: 'pending' });
  });

  it('creates a signer-only contact when no one has the address', async () => {
    const env = await draft();
    const res = await add(env, { email: 'new.person@example.com', first_name: 'Mary\u0000', last_name: 'Somerville' });
    const { contact_id } = await res.json();
    const [c] = await w.q<{ first_name: string; source: string; status: string; email: string }>(
      `SELECT first_name, source, status, email FROM public.contacts WHERE id = $1`, [contact_id]);
    expect(c).toEqual({ first_name: 'Mary', source: 'esign', status: 'esign_signer', email: 'new.person@example.com' });
  });

  it('never treats _ or % as a wildcard', async () => {
    await seedContact(w, { email: 'bobxsmith@example.com', first_name: 'Bob' });
    const env = await draft();
    const { contact_id } = await (await add(env, { email: 'bob_smith@example.com' })).json();
    const [c] = await w.q<{ status: string }>(`SELECT status FROM public.contacts WHERE id = $1`, [contact_id]);
    expect(c.status).toBe('esign_signer');
    expect(exactIlike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('refuses an address two contacts share, across email and spouse_email', async () => {
    await seedContact(w, { email: 'shared@example.com' });
    await seedContact(w, { email: 'other@example.com', spouse_email: 'Shared@example.com' });
    const env = await draft();
    const res = await add(env, { email: 'shared@example.com' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'More than one contact uses this email. Pick the contact for this signer.', code: 'ambiguous_email' });
  });

  it('links a co-signer by spouse_email with the co_signer role by default', async () => {
    const primary = await seedContact(w, { email: 'ada.k@example.com', spouse_email: 'william@example.com', spouse_first_name: 'William' });
    const env = await draft();
    const { signer_id, contact_id } = await (await add(env, { email: 'william@example.com' })).json();
    expect(contact_id).toBe(primary);
    const [row] = await w.q<{ role: string }>(`SELECT role FROM public.esign_envelope_signers WHERE id = $1`, [signer_id]);
    expect(row.role).toBe('co_signer');
  });

  it('links an explicit contact only when the address is theirs, and fills in a missing co-signer', async () => {
    const primary = await seedContact(w, { email: 'augusta@example.com', first_name: 'Augusta' });
    const env = await draft();
    // Not their address and not a co-signer: never linked to the chosen contact.
    const stranger = await (await add(env, { email: 'stranger@example.com', contact_id: primary })).json();
    expect(stranger.contact_id).not.toBe(primary);
    // A co-signer on a contact with no spouse_email: the record gains the second person.
    const co = await add(env, { email: 'Byron@Example.com', first_name: 'George', last_name: 'Byron', role: 'co_signer', contact_id: primary, order: 1 });
    expect((await co.json()).contact_id).toBe(primary);
    const [c] = await w.q<Record<string, string>>(`SELECT spouse_email, spouse_first_name, spouse_last_name FROM public.contacts WHERE id = $1`, [primary]);
    expect(c).toEqual({ spouse_email: 'byron@example.com', spouse_first_name: 'George', spouse_last_name: 'Byron' });
  });

  it('stores a phone only encrypted, requires E.164, and clears it on update', async () => {
    const env = await draft();
    expect((await add(env, { email: 'p1@example.com', phone: '(555) 555-0123' })).status).toBe(400);
    const { signer_id } = await (await add(env, { email: 'p2@example.com', phone: '+15555550123' })).json();
    const [row] = await w.q<{ phone_ciphertext: Uint8Array; phone_iv: Uint8Array; phone_last_four: string }>(
      `SELECT phone_ciphertext, phone_iv, phone_last_four FROM public.esign_envelope_signers WHERE id = $1`, [signer_id]);
    expect(row.phone_last_four).toBe('0123');
    expect(new TextDecoder().decode(row.phone_ciphertext)).not.toContain('5555550123');
    expect(await decryptPiiSplit(fromBytea(row.phone_ciphertext), fromBytea(row.phone_iv), PII_KEY)).toBe('+15555550123');

    const upd = await manage({ envelope_id: env, action: 'update', signer: { signer_id, phone: null } });
    expect(await upd.json()).toEqual({ success: true, signer_id });
    const [cleared] = await w.q<{ phone_ciphertext: unknown; phone_last_four: unknown }>(
      `SELECT phone_ciphertext, phone_last_four FROM public.esign_envelope_signers WHERE id = $1`, [signer_id]);
    expect(cleared).toEqual({ phone_ciphertext: null, phone_last_four: null });
  });

  it('refuses a second signer with the same address (409)', async () => {
    const env = await draft();
    await add(env, { email: 'twice@example.com' });
    const res = await add(env, { email: 'TWICE@example.com', order: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('duplicate_signer');
  });

  it('updates and removes only a signer of this envelope', async () => {
    const env = await draft();
    const other = await draft();
    const { signer_id } = await (await add(env, { email: 'mover@example.com' })).json();
    expect((await manage({ envelope_id: other, action: 'remove', signer: { signer_id } })).status).toBe(404);
    const upd = await manage({ envelope_id: env, action: 'update', signer: { signer_id, order: 4, role: 'primary', email: 'Moved@example.com' } });
    expect(upd.status).toBe(200);
    const [row] = await w.q<Record<string, unknown>>(`SELECT "order", role, email FROM public.esign_envelope_signers WHERE id = $1`, [signer_id]);
    expect(row).toEqual({ order: 4, role: 'primary', email: 'moved@example.com' });
    expect(await (await manage({ envelope_id: env, action: 'remove', signer: { signer_id } })).json()).toEqual({ success: true });
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_signers WHERE id = $1`, [signer_id])).toEqual([]);
  });

  it('refuses any change once the envelope is sent', async () => {
    const env = await draft('sent');
    const res = await add(env, { email: 'late@example.com' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_draft');
  });

  it('a late edit never touches a signer of an envelope sent meanwhile', async () => {
    const env = await draft();
    const { signer_id } = await (await add(env, { email: 'late-edit@example.com' })).json();
    // The send and a signature land after the edit read the draft, before its write.
    const racing = withRace(w, 'esign_envelope_signers', (v) => 'role' in v, `
      WITH sent AS (UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1 RETURNING id)
      UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $2`, [env, signer_id]);
    const res = await manage({ envelope_id: env, action: 'update', signer: { signer_id, role: 'primary' } }, deps({ db: racing }));
    expect([res.status, (await res.json()).code]).toEqual([409, 'not_draft']);
    const [row] = await w.q<{ status: string; role: string }>(`SELECT status, role FROM public.esign_envelope_signers WHERE id = $1`, [signer_id]);
    expect(row).toEqual({ status: 'signed', role: 'other' });
    expect((await manage({ envelope_id: env, action: 'remove', signer: { signer_id } })).status).toBe(409);
  });

  it('a removal that lands after a send is refused by the database, as not_draft', async () => {
    const env = await draft();
    const { signer_id } = await (await add(env, { email: 'late-remove@example.com' })).json();
    const db = landsBeforeFirst(w, 'esign_envelope_signers', SEND_SQL, [env]);
    const res = await manage({ envelope_id: env, action: 'remove', signer: { signer_id } }, deps({ db }));
    expect([res.status, (await res.json()).code]).toEqual([409, 'not_draft']);
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_signers WHERE id = $1`, [signer_id])).toHaveLength(1);
  });

  it('a changed email links the signer to the contact of the new address', async () => {
    const grace = await seedContact(w, { email: 'grace.relink@example.com', first_name: 'Grace', last_name: 'Hopper' });
    const env = await draft();
    const added = await (await add(env, { email: 'nobody.relink@example.com' })).json();
    expect(added.contact_id).not.toBe(grace);
    const upd = await manage({ envelope_id: env, action: 'update', signer: { signer_id: added.signer_id, email: 'Grace.Relink@example.com', first_name: 'Ada', last_name: 'Lovelace' } });
    expect(upd.status).toBe(200);
    const [row] = await w.q<{ contact_id: string; email: string }>(`SELECT contact_id, email FROM public.esign_envelope_signers WHERE id = $1`, [added.signer_id]);
    expect(row).toEqual({ contact_id: grace, email: 'grace.relink@example.com' });
  });

  it('a name change is saved on a signer-only contact, and refused on a contact the owner keeps', async () => {
    const env = await draft();
    const stub = await (await add(env, { email: 'rename.stub@example.com' })).json();
    const renamed = await manage({ envelope_id: env, action: 'update', signer: { signer_id: stub.signer_id, first_name: 'Augusta', last_name: 'King' } });
    expect(renamed.status).toBe(200);
    const [c] = await w.q<{ first_name: string; last_name: string }>(`SELECT first_name, last_name FROM public.contacts WHERE id = $1`, [stub.contact_id]);
    expect(c).toEqual({ first_name: 'Augusta', last_name: 'King' });

    const kept = await seedContact(w, { email: 'rename.kept@example.com', first_name: 'Charles', last_name: 'Babbage' });
    const linked = await (await add(env, { email: 'rename.kept@example.com', order: 1, first_name: 'Charles', last_name: 'Babbage' })).json();
    expect(linked.contact_id).toBe(kept);
    // The same names, sent back by the form, are not a change.
    expect((await manage({ envelope_id: env, action: 'update', signer: { signer_id: linked.signer_id, first_name: 'Charles', last_name: 'Babbage', order: 2 } })).status).toBe(200);
    const refused = await manage({ envelope_id: env, action: 'update', signer: { signer_id: linked.signer_id, first_name: 'Chuck', last_name: 'Babbage' } });
    expect([refused.status, (await refused.json()).code]).toEqual([409, 'name_on_contact']);
    const [k] = await w.q<{ first_name: string }>(`SELECT first_name FROM public.contacts WHERE id = $1`, [kept]);
    expect(k.first_name).toBe('Charles');
  });

  it('validates the request before reading the envelope', async () => {
    const env = await draft();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ email: 'not an email' }, 'invalid_email'],
      [{ email: 'a@example.com', role: 'spouse' }, 'invalid_role'],
      [{ email: 'a@example.com', order: 1000 }, 'invalid_order'],
      [{ email: 'a@example.com', first_name: 'x'.repeat(101) }, 'invalid_name'],
      [{ email: 'a@example.com', first_name: '' }, 'invalid_name'],
    ];
    for (const [signer, code] of cases) {
      const res = await add(env, signer);
      expect([res.status, (await res.json()).code]).toEqual([400, code]);
    }
  });
});
