import { describe, expect, it } from 'vitest';
import type { FieldRow, PageRow, SignerRow } from '../contract';
import { reorderOperations } from '../lib/pageOrder';
import { envelopeRefetchInterval, RESENDABLE_SIGNER_STATUSES } from '../contract';
import { fieldContentKey, moveRect, newServerFields, placeAt, resizeRect, MIN_H, MIN_W, type PlacedField } from '../lib/fieldPlacement';
import { filingFolderProblem } from '../lib/filingFolder';
import { escapeLikePattern } from '../lib/likePattern';
import { toE164 } from '../lib/phone';
import { esignSafeFilename } from '../lib/safeFilename';
import { readiness, sendProblems, stepGates } from '../lib/sendReadiness';
import { buildSignerPickerOptions, nextSignerOrder, type SignerPickerContact } from '../lib/signerPicker';
import { resolveSignerName, resolveSignerNameParts } from '../lib/signerName';
import { colorForIndex, SIGNER_COLORS } from '../lib/signerColors';
import { tokenFromHash } from '../public/signer/signingToken';

const canvas = { width: 720, height: 932 };

describe('field geometry', () => {
  it('centres a new box on the click and keeps it on the page', () => {
    expect(placeAt('signature', 400, 400, canvas)).toEqual({ x: 260, y: 383, w: 280, h: 34 });
    // A click at the very corner still lands the whole box on the page.
    expect(placeAt('date', 0, 0, canvas)).toEqual({ x: 0, y: 0, w: 160, h: 34 });
    expect(placeAt('date', 720, 932, canvas)).toEqual({ x: 560, y: 898, w: 160, h: 34 });
  });

  it('moves without crossing an edge', () => {
    const origin = { x: 10, y: 10, w: 100, h: 30 };
    expect(moveRect(origin, -50, -50, canvas)).toEqual({ x: 0, y: 0, w: 100, h: 30 });
    expect(moveRect(origin, 5000, 5000, canvas)).toEqual({ x: 620, y: 902, w: 100, h: 30 });
  });

  it('resizes from any handle, never below the minimum or off the page', () => {
    const origin = { x: 100, y: 100, w: 200, h: 40 };
    expect(resizeRect(origin, 'se', 50, 10, canvas)).toEqual({ x: 100, y: 100, w: 250, h: 50 });
    expect(resizeRect(origin, 'nw', 500, 500, canvas)).toEqual({ x: 300 - MIN_W, y: 140 - MIN_H, w: MIN_W, h: MIN_H });
    expect(resizeRect(origin, 'w', -500, 0, canvas)).toEqual({ x: 0, y: 100, w: 300, h: 40 });
    expect(resizeRect(origin, 'e', 5000, 0, canvas)).toEqual({ x: 100, y: 100, w: 620, h: 40 });
  });
});

const page = (id: string, order: number): PageRow => ({ id, envelope_id: 'e', order, source_document_id: 'd', source_page_index: order, deleted: false });
const field = (id: string, over: Partial<FieldRow> = {}): FieldRow => ({
  id,
  envelope_id: 'e',
  signer_id: 's1',
  page_index: 0,
  field_type: 'signature',
  x: '72.4',
  y: '100.2',
  width: '200',
  height: '30',
  required: true,
  ...over,
});

describe('merging the server fields into the layout', () => {
  const pages = [page('p0', 0), page('p1', 1)];

  it('adds unknown fields, reading numerics sent as strings', () => {
    const out = newServerFields([field('f1')], [], pages);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ localId: 'srv-f1', remoteId: 'f1', pageId: 'p0', pdf: { x: 72.4, y: 100.2, width: 200, height: 30 } });
  });

  it('never adds a field already held by id, or by content slot after the ids rotated', () => {
    const local: PlacedField[] = [
      { localId: 'l1', remoteId: 'old-id', signerId: 's1', pageId: 'p0', pageIndex: 0, fieldType: 'signature', pdf: { x: 72, y: 100, width: 200, height: 30 } },
    ];
    // Same slot (rounded to whole points), new id: a save rotated it.
    expect(newServerFields([field('new-id')], local, pages)).toEqual([]);
    expect(newServerFields([field('old-id', { x: 400 })], local, pages)).toEqual([]);
  });

  it('collapses duplicates within one answer, and skips a page past the end', () => {
    expect(newServerFields([field('a'), field('b', { x: '72.1' })], [], pages)).toHaveLength(1);
    expect(newServerFields([field('c', { page_index: 5 })], [], pages)).toEqual([]);
  });

  it('never brings back a field deleted here while the server still holds it', () => {
    // The delete happened during a save: the refetch that save triggers still has the field.
    expect(newServerFields([field('dead'), field('live', { x: 300 })], [], pages, new Set(['dead']))).toMatchObject([{ remoteId: 'live' }]);
  });

  it('keys content on signer, page, type and rounded corner', () => {
    expect(fieldContentKey({ signer_id: 's', page_index: 1, field_type: 'date', x: '9.6', y: 3.2 })).toBe('s|1|date|10|3');
  });
});

const signer = (id: string, over: Partial<SignerRow> = {}): SignerRow => ({
  id,
  envelope_id: 'e',
  contact_id: null,
  order: 0,
  role: 'primary',
  email: `${id}@example.com`,
  phone_last_four: null,
  invited_at: null,
  opened_email_at: null,
  first_viewed_at: null,
  signed_at: null,
  signed_signature_kind: null,
  signed_verification_method: null,
  consented_at: null,
  status: 'pending',
  client_task_id: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('send readiness', () => {
  it('needs a live page, a signer, and a REQUIRED field for every signer', () => {
    const r = readiness({
      pages: [{ ...page('p0', 0), deleted: true }],
      signers: [signer('ada'), signer('acme')],
      fields: [field('f1', { signer_id: 'ada' }), field('f2', { signer_id: 'acme', required: false })],
      verificationLevel: 'standard',
    });
    expect(stepGates(r)).toEqual([false, true, false]);
    expect(sendProblems(r, (s) => s.email)).toEqual(['Add at least one page.', 'acme@example.com has no field to sign.']);
  });

  it('High needs a phone for every signer, at the signers step', () => {
    const r = readiness({
      pages: [page('p0', 0)],
      signers: [signer('ada', { phone_last_four: '0001' }), signer('acme')],
      fields: [field('f1', { signer_id: 'ada' }), field('f2', { signer_id: 'acme' })],
      verificationLevel: 'high',
    });
    expect(stepGates(r)).toEqual([true, false, true]);
    expect(sendProblems(r, (s) => s.id)).toEqual(['acme has no phone, which High verification needs.']);
  });

  it('is ready when everything is in place', () => {
    const r = readiness({ pages: [page('p0', 0)], signers: [signer('ada')], fields: [field('f', { signer_id: 'ada' })], verificationLevel: 'standard' });
    expect(stepGates(r)).toEqual([true, true, true]);
    expect(sendProblems(r, (s) => s.id)).toEqual([]);
  });
});

describe('small rules', () => {
  it('next signer order is max + 1, not the count', () => {
    expect(nextSignerOrder([])).toBe(0);
    expect(nextSignerOrder([{ order: 0 }, { order: 2 }])).toBe(3);
  });

  it('phones must be E.164 as typed: no country is guessed', () => {
    expect(toE164('+1 (555) 010-0001')).toBe('+15550100001');
    expect(toE164('+44 20 7946 0000')).toBe('+442079460000');
    expect(toE164('555 010 0001')).toBeUndefined();
    expect(toE164('+1 555 0100 ext 1')).toBeUndefined();
    expect(toE164('+0123456789')).toBeUndefined();
    expect(toE164(null)).toBeUndefined();
  });

  it('escapes LIKE wildcards, backslash first', () => {
    expect(escapeLikePattern('ada_l%x\\y@example.com')).toBe('ada\\_l\\%x\\\\y@example.com');
  });

  it('safe filenames strip only what a filesystem cannot hold', () => {
    expect(esignSafeFilename('Acme: plan / Ada? "v2"')).toBe('Acme_ plan _ Ada_ _v2_');
    expect(esignSafeFilename('Élan, résumé')).toBe('Élan, résumé');
    expect(esignSafeFilename('a\\b')).toBe('a_b');
    expect(esignSafeFilename('x'.repeat(300))).toHaveLength(200);
  });

  it('filing folder: a name or a path of up to five names, no backslash, control or invisible character, bounded', () => {
    expect(filingFolderProblem('Signed documents')).toBeNull();
    expect(filingFolderProblem('Signed/Agreements')).toBeNull();
    expect(filingFolderProblem('  ')).not.toBeNull();
    expect(filingFolderProblem('a/b/c/d/e/f')).not.toBeNull();
    expect(filingFolderProblem('a​b')).not.toBeNull();
    expect(filingFolderProblem('a\\b')).not.toBeNull();
    expect(filingFolderProblem('a\u0007b')).not.toBeNull();
    expect(filingFolderProblem('x'.repeat(101))).not.toBeNull();
  });

  it('every signer colour is distinct, and the index wraps', () => {
    expect(new Set(SIGNER_COLORS.map((c) => c.css)).size).toBe(SIGNER_COLORS.length);
    expect(colorForIndex(SIGNER_COLORS.length)).toBe(SIGNER_COLORS[0]);
    expect(colorForIndex(-1)).toBe(SIGNER_COLORS[SIGNER_COLORS.length - 1]);
  });
});

describe('the signing token in the fragment', () => {
  it('reads a base64url token, alone or among other parameters', () => {
    const t = 'abcdefghijklmnop_-0123456789ABCD';
    expect(tokenFromHash(`#token=${t}`)).toBe(t);
    expect(tokenFromHash(`#x=1&token=${t}`)).toBe(t);
  });

  it('refuses anything that is not a token', () => {
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#token=short')).toBeNull();
    expect(tokenFromHash('#token=abcdefghijklmnop<script>')).toBeNull();
  });
});

describe('co-signer names', () => {
  const contact = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    spouse_first_name: 'William',
    spouse_last_name: null,
    spouse_email: 'william@example.com',
  };

  it('a co-signer link is named from the spouse fields, raw in a form', () => {
    const s = { email: 'William@example.com', role: 'co_signer', contact };
    expect(resolveSignerName(s)).toBe('William');
    expect(resolveSignerNameParts(s)).toEqual({ first_name: 'William', last_name: null });
  });

  it('the primary keeps its own name; a co-signer role without the address match is not a link', () => {
    expect(resolveSignerName({ email: 'ada@example.com', role: 'primary', contact })).toBe('Ada Lovelace');
    expect(resolveSignerNameParts({ email: 'other@example.com', role: 'co_signer', contact })).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('a display never comes back empty', () => {
    const blank = { first_name: null, last_name: null, email: null, spouse_first_name: null, spouse_last_name: null, spouse_email: 'w@example.com' };
    expect(resolveSignerName({ email: 'w@example.com', role: 'co_signer', contact: blank })).toBe('w@example.com');
    expect(resolveSignerName({ email: 'x@example.com', role: null, contact: null })).toBe('x@example.com');
  });
});

describe('the signer picker', () => {
  const base = (over: Partial<SignerPickerContact>): SignerPickerContact => ({
    id: 'c1',
    full_name: 'Ada Lovelace',
    business_name: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: null,
    status: 'client',
    spouse_first_name: 'William',
    spouse_last_name: 'King',
    spouse_email: 'william@example.com',
    spouse_phone: '+15550100002',
    ...over,
  });

  it('offers the spouse as a co-signer on the primary contact', () => {
    const options = buildSignerPickerOptions([base({})], new Set(), new Set());
    expect(options.map((o) => [o.kind, o.contactId, o.email])).toEqual([
      ['primary', 'c1', 'ada@example.com'],
      ['co_signer', 'c1', 'william@example.com'],
    ]);
  });

  it('excludes by EMAIL: adding the primary leaves the co-signer, and the reverse', () => {
    const byPrimary = buildSignerPickerOptions([base({})], new Set(['ada@example.com']), new Set(['c1']));
    expect(byPrimary.map((o) => o.kind)).toEqual(['co_signer']);
    const byCoSigner = buildSignerPickerOptions([base({})], new Set(['william@example.com']), new Set(['c1']));
    expect(byCoSigner.map((o) => o.kind)).toEqual(['primary']);
  });

  it('falls back to the id only for a contact with no address, and never offers a lost contact', () => {
    expect(buildSignerPickerOptions([base({ email: null, spouse_email: null })], new Set(), new Set(['c1']))).toEqual([]);
    expect(buildSignerPickerOptions([base({ status: 'lost' })], new Set(), new Set())).toEqual([]);
  });

  it('never offers an archived contact, nor its spouse', () => {
    expect(buildSignerPickerOptions([base({ archived_at: '2026-03-05T10:00:00Z' })], new Set(), new Set())).toEqual([]);
    expect(buildSignerPickerOptions([base({ archived_at: null })], new Set(), new Set())).toHaveLength(2);
  });
});

describe('the page reorder after a drag', () => {
  it('sends every live page at 0..n-1, never just the moved ones', () => {
    // Stored orders 0, 2, 3 after page 1 was deleted; drag the last page to the front.
    expect(reorderOperations([{ id: 'c' }, { id: 'a' }, { id: 'b' }])).toEqual([
      { page_id: 'c', order: 0 },
      { page_id: 'a', order: 1 },
      { page_id: 'b', order: 2 },
    ]);
  });
});

describe('resend and polling on a sent envelope', () => {
  it('a pending signer can be resent to', () => {
    expect(RESENDABLE_SIGNER_STATUSES).toEqual(expect.arrayContaining(['pending', 'invited', 'viewed']));
    expect(RESENDABLE_SIGNER_STATUSES).not.toContain('signed');
  });

  it('the envelope polls while out for signature and stops once terminal', () => {
    expect(envelopeRefetchInterval('sent')).toBe(30_000);
    expect(envelopeRefetchInterval('partially_signed')).toBe(30_000);
    for (const s of ['draft', 'completed', 'voided', 'declined', 'expired'] as const) expect(envelopeRefetchInterval(s)).toBe(false);
    expect(envelopeRefetchInterval(undefined)).toBe(false);
  });
});
