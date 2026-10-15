// esign-manage-signers: add, update or remove a signer on a draft envelope. Owner only.
//
// Every signer is linked to a contact, because the executed copy is filed to the
// signer's contact:
//   1. A contact_id the caller picked links only when the signer's email is that
//      contact's email or spouse_email. A co-signer added to a contact with no
//      spouse_email yet fills in that contact's spouse_email, spouse_first_name and
//      spouse_last_name and links (the record gets the second person instead of a stub).
//   2. Otherwise the email is matched, case-insensitively, against every contact's email
//      and spouse_email. More than one contact: 409 ambiguous_email, the owner picks.
//      LIKE wildcards in the address are escaped, so bob_smith@ never matches bobXsmith@.
//   3. No match: a signer-only contact (source 'esign', status 'esign_signer').
// A spouse_email match makes the default role co_signer.
//
// Update: a changed email links again by the same rules (the executed copy is filed to the
// contact the signer is linked to when finalize runs). A name lives on the contact: a
// change is written to a signer-only contact, or to an empty co-signer slot; a contact
// the owner keeps names its own people, so a different name there is refused
// (409 name_on_contact) rather than silently dropped.
//
// Every write to the signer row is a draft edit: the database refuses it once the
// envelope has left draft (409 not_draft), however late it lands.
//
// Phones are E.164 only, encrypted with PII_ENCRYPTION_KEY into two bytea columns, with
// the last four digits kept apart for display.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { encryptPiiSplit, toByteaHex } from '../_shared/crypto.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { isValidEmail } from '../_shared/outbound.ts';
import { maybeOne, pgCode, rows, run, type EsignDb, type Row } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, draftWrite, envelopeNotFound, notDraft, objectBody, signerNotFound } from '../esign-finalize-envelope/lib/errors.ts';
import { isE164, lastFour } from '../esign-finalize-envelope/lib/phone.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';

export type SignerRole = 'primary' | 'co_signer' | 'other';

export interface ManageSignersRequest {
  envelope_id: string;
  action: 'add' | 'update' | 'remove';
  signer: {
    /** update and remove. */
    signer_id?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    /** E.164; null on update clears it. */
    phone?: string | null;
    role?: SignerRole;
    /** Required on add: 0..999. */
    order?: number;
    contact_id?: string | null;
  };
}

export type ManageSignersResponse =
  | { success: true; signer_id: string; contact_id: string }
  | { success: true; signer_id: string }
  | { success: true };

export const MANAGE_SIGNERS_ERRORS = [
  'bad_request',
  'invalid_email',
  'invalid_name',
  'invalid_phone',
  'invalid_role',
  'invalid_order',
  'ambiguous_email',
  'duplicate_signer',
  'signer_not_found',
  'not_found',
  'not_draft',
  'name_on_contact',
] as const;

export interface ManageSignersDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  /** PII_ENCRYPTION_KEY. */
  piiKey: string | null;
  logSink?: LogSink;
}

const ROLES = new Set<SignerRole>(['primary', 'co_signer', 'other']);
const CAPS = { email: 254, name: 100, phone: 30 } as const;

const duplicateSigner = () => new HttpError(409, 'A signer with this email is already on the envelope.', 'duplicate_signer');
const ambiguousEmail = () =>
  new HttpError(409, 'More than one contact uses this email. Pick the contact for this signer.', 'ambiguous_email');
const nameOnContact = () =>
  new HttpError(409, 'This signer\'s name comes from their contact record. Change it on the contact.', 'name_on_contact');

interface NameContact {
  id: string;
  status: string | null;
  first_name: string | null;
  last_name: string | null;
  spouse_email: string | null;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
}

/** An escaped ILIKE pattern that matches exactly this address, any case. */
export function exactIlike(email: string): string {
  return email.replace(/[\\%_]/g, '\\$&');
}

export function createManageSignersHandler(deps: ManageSignersDeps): (req: Request) => Promise<Response> {
  async function encryptPhone(phone: string): Promise<Row> {
    if (!deps.piiKey) throw new Error('PII_ENCRYPTION_KEY is not set');
    const enc = await encryptPiiSplit(phone, deps.piiKey);
    return { phone_ciphertext: toByteaHex(enc.ciphertext), phone_iv: toByteaHex(enc.iv), phone_last_four: lastFour(phone) };
  }

  /** The contact a new signer links to, and whether it is as that contact's second person. */
  async function linkContact(input: {
    email: string;
    firstName: string;
    lastName: string;
    role: SignerRole | undefined;
    contactId: string | null;
  }): Promise<{ contactId: string; asCoSigner: boolean }> {
    const { email } = input;
    if (input.contactId) {
      const linked = await maybeOne<{ id: string; email: string | null; spouse_email: string | null }>(
        'linked contact read',
        deps.db.from('contacts').select('id, email, spouse_email').eq('id', input.contactId).maybeSingle(),
      );
      if (linked) {
        const primaryMatches = (linked.email ?? '').trim().toLowerCase() === email;
        const spouseMatches = (linked.spouse_email ?? '').trim().toLowerCase() === email;
        if (primaryMatches || spouseMatches) return { contactId: linked.id, asCoSigner: spouseMatches && !primaryMatches };
        if (input.role === 'co_signer' && !(linked.spouse_email ?? '').trim()) {
          const backfill: Row = { spouse_email: email };
          if (input.firstName) backfill.spouse_first_name = input.firstName;
          if (input.lastName) backfill.spouse_last_name = input.lastName;
          await run('co-signer backfill', deps.db.from('contacts').update(backfill).eq('id', linked.id));
          return { contactId: linked.id, asCoSigner: true };
        }
      }
      // A contact that does not carry this address is never linked: fall through to
      // matching by the address itself.
    }

    const pattern = exactIlike(email);
    const [byEmail, bySpouse] = await Promise.all([
      rows<{ id: string }>('contact match by email', deps.db.from('contacts').select('id').ilike('email', pattern).limit(2)),
      rows<{ id: string }>('contact match by co-signer email', deps.db.from('contacts').select('id').ilike('spouse_email', pattern).limit(2)),
    ]);
    const matched = new Set([...byEmail, ...bySpouse].map((r) => r.id));
    if (matched.size > 1) throw ambiguousEmail();
    if (byEmail.length === 1) return { contactId: byEmail[0].id, asCoSigner: false };
    if (bySpouse.length === 1) return { contactId: bySpouse[0].id, asCoSigner: true };

    const created = await maybeOne<{ id: string }>(
      'signer contact insert',
      deps.db
        .from('contacts')
        .insert({ first_name: input.firstName, last_name: input.lastName, email, source: 'esign', status: 'esign_signer' })
        .select('id')
        .single(),
    );
    if (!created) throw new Error('signer contact insert returned no row');
    return { contactId: created.id, asCoSigner: false };
  }

  async function nameContact(id: string): Promise<NameContact | null> {
    return await maybeOne<NameContact>(
      'contact name read',
      deps.db.from('contacts').select('id, status, first_name, last_name, spouse_email, spouse_first_name, spouse_last_name').eq('id', id).maybeSingle(),
    );
  }

  /** Whether this signer is the contact's second person (the co-signer rule of signer-name.ts). */
  function isSecondPerson(c: NameContact, email: string, role: SignerRole): boolean {
    return role === 'co_signer' && !!c.spouse_email && c.spouse_email.trim().toLowerCase() === email;
  }

  function namesOf(c: NameContact, email: string, role: SignerRole): { first: string; last: string } {
    return isSecondPerson(c, email, role)
      ? { first: c.spouse_first_name ?? '', last: c.spouse_last_name ?? '' }
      : { first: c.first_name ?? '', last: c.last_name ?? '' };
  }

  /** A name change, where the name lives: see the header. */
  async function applyName(c: NameContact | null, email: string, role: SignerRole, names: { firstName: string; lastName: string }) {
    if (!c) return;
    const second = isSecondPerson(c, email, role);
    const have = namesOf(c, email, role);
    if (have.first === names.firstName && have.last === names.lastName) return;
    if (!names.firstName || !names.lastName) throw badRequest('Enter the signer\'s first and last name.', 'invalid_name');
    const stub = c.status === 'esign_signer';
    const emptySlot = second && !have.first && !have.last;
    if (!stub && !emptySlot) throw nameOnContact();
    const write: Row = second
      ? { spouse_first_name: names.firstName, spouse_last_name: names.lastName }
      : { first_name: names.firstName, last_name: names.lastName };
    await run('signer name write', deps.db.from('contacts').update(write).eq('id', c.id));
  }

  return createHandler({
    name: 'esign-manage-signers',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ body, json }) {
      const b = objectBody(body);
      const envelopeId = b.envelope_id;
      const action = b.action;
      if (!isUuid(envelopeId) || (action !== 'add' && action !== 'update' && action !== 'remove')) throw badRequest();
      if (!b.signer || typeof b.signer !== 'object' || Array.isArray(b.signer)) throw badRequest();
      const s = b.signer as Record<string, unknown>;

      // Shape first, then the envelope.
      if (s.role !== undefined && s.role !== null && !ROLES.has(s.role as SignerRole)) {
        throw badRequest('Choose a role: primary signer, co-signer or other.', 'invalid_role');
      }
      if (s.order !== undefined && (typeof s.order !== 'number' || !Number.isInteger(s.order) || s.order < 0 || s.order > 999)) {
        throw badRequest('The signing order must be a whole number from 0 to 999.', 'invalid_order');
      }
      for (const key of ['first_name', 'last_name'] as const) {
        const v = s[key];
        if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > CAPS.name)) {
          throw badRequest('Names can be up to 100 characters.', 'invalid_name');
        }
      }
      if (s.phone !== undefined && s.phone !== null && (typeof s.phone !== 'string' || s.phone.length > CAPS.phone || (s.phone !== '' && !isE164(s.phone)))) {
        throw badRequest('Enter the phone number in international format, for example +15555550123.', 'invalid_phone');
      }
      const firstName = typeof s.first_name === 'string' ? stripControl(s.first_name) : '';
      const lastName = typeof s.last_name === 'string' ? stripControl(s.last_name) : '';
      const role = (s.role ?? undefined) as SignerRole | undefined;

      const envelope = await maybeOne<{ status: string }>(
        'envelope read',
        deps.db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status !== 'draft') throw notDraft();

      if (action === 'add') {
        const email = typeof s.email === 'string' ? s.email.trim().toLowerCase() : '';
        if (!isValidEmail(email) || email.length > CAPS.email) throw badRequest('Enter a valid email address.', 'invalid_email');
        if (!firstName || !lastName) throw badRequest('Enter the signer\'s first and last name.', 'invalid_name');
        if (s.order === undefined) throw badRequest('The signing order must be a whole number from 0 to 999.', 'invalid_order');
        if (s.contact_id !== undefined && s.contact_id !== null && !isUuid(s.contact_id)) throw badRequest();

        const link = await linkContact({ email, firstName, lastName, role, contactId: (s.contact_id as string | null) ?? null });
        const row: Row = {
          envelope_id: envelopeId,
          contact_id: link.contactId,
          order: s.order,
          email,
          status: 'pending',
          role: role ?? (link.asCoSigner ? 'co_signer' : 'other'),
        };
        if (typeof s.phone === 'string' && s.phone) Object.assign(row, await encryptPhone(s.phone));

        const res = await deps.db.from('esign_envelope_signers').insert(row).select('id').single();
        if (res.error) {
          if (pgCode(res.error) === '23505') throw duplicateSigner();
          if (pgCode(res.error) === '55000') throw notDraft();
          throw res.error;
        }
        const signerId = (res.data as { id: string }).id;
        return json(200, { success: true, signer_id: signerId, contact_id: link.contactId } satisfies ManageSignersResponse);
      }

      if (!isUuid(s.signer_id)) throw badRequest();
      const existing = await maybeOne<{ envelope_id: string; email: string; role: SignerRole; contact_id: string | null }>(
        'signer read',
        deps.db.from('esign_envelope_signers').select('id, envelope_id, email, role, contact_id').eq('id', s.signer_id).maybeSingle(),
      );
      if (!existing || existing.envelope_id !== envelopeId) throw signerNotFound();

      if (action === 'remove') {
        await draftWrite(run('signer delete', deps.db.from('esign_envelope_signers').delete().eq('id', s.signer_id).eq('envelope_id', envelopeId)));
        return json(200, { success: true } satisfies ManageSignersResponse);
      }

      // No status here: a draft's signers are pending until send, and an update never
      // moves a signer back (the database refuses that past draft in any case).
      const updates: Row = {};
      if (s.order !== undefined) updates.order = s.order;
      if (s.role !== undefined) updates.role = role ?? 'other';
      const nextRole: SignerRole = (updates.role as SignerRole | undefined) ?? existing.role;
      let nextEmail = existing.email;
      if (s.email !== undefined) {
        const email = typeof s.email === 'string' ? s.email.trim().toLowerCase() : '';
        if (!isValidEmail(email) || email.length > CAPS.email) throw badRequest('Enter a valid email address.', 'invalid_email');
        updates.email = email;
        nextEmail = email;
      }
      if (s.phone === null || s.phone === '') {
        Object.assign(updates, { phone_ciphertext: null, phone_iv: null, phone_last_four: null });
      } else if (typeof s.phone === 'string') {
        Object.assign(updates, await encryptPhone(s.phone));
      }

      const current = existing.contact_id ? await nameContact(existing.contact_id) : null;
      const before = current ? namesOf(current, existing.email, existing.role) : { first: '', last: '' };
      // Only a name the owner actually changed is written: the form sends the names back
      // with every update, and an unchanged one must not trip the contact's own rule.
      const sent = s.first_name !== undefined || s.last_name !== undefined;
      const names = sent && (firstName !== before.first || lastName !== before.last) ? { firstName, lastName } : null;
      // A new address links again; the signer's name carries over unless a new one came.
      if (nextEmail !== existing.email) {
        const link = await linkContact({
          email: nextEmail,
          firstName: names?.firstName || before.first,
          lastName: names?.lastName || before.last,
          role: nextRole,
          contactId: null,
        });
        updates.contact_id = link.contactId;
      }
      const target = (updates.contact_id as string | undefined) ?? existing.contact_id;
      if (names && target) await applyName(target === existing.contact_id && current ? current : await nameContact(target), nextEmail, nextRole, names);

      if (Object.keys(updates).length > 0) {
        const res = await deps.db.from('esign_envelope_signers').update(updates).eq('id', s.signer_id).eq('envelope_id', envelopeId);
        if (res.error) {
          if (pgCode(res.error) === '23505') throw duplicateSigner();
          if (pgCode(res.error) === '55000') throw notDraft();
          throw res.error;
        }
      }
      return json(200, { success: true, signer_id: s.signer_id } satisfies ManageSignersResponse);
    },
  });
}
