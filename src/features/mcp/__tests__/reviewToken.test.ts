// The request tools' review tokens (supabase/functions/mcp-crm/review-token.ts): every
// client-visible field, the recipient and each item's fulfilment move the canonical form;
// nothing else does; and a token verifies only for its own list, content and key.
import { describe, expect, it } from 'vitest';
import {
  canonicalRequest,
  createReviewSigner,
  REVIEW_TOKEN_RE,
  type ReviewList,
  type ReviewRecipient,
} from '../../../../supabase/functions/mcp-crm/review-token';

const LIST_ID = 'a3bb189e-8bf9-4888-9912-ace4e6543002';
const SECRET = 'test-review-secret-0123456789abcdef';

const item = (over: Partial<ReviewList['items'][number]> = {}): ReviewList['items'][number] => ({
  sort_order: 0, kind: 'document', label: 'Signed contract', description: null, required: true, sensitive: false,
  category: 'general', tag: 'general', fulfilled: false, ...over,
});
const list = (over: Partial<ReviewList> = {}): ReviewList => ({
  id: LIST_ID, status: 'draft', title: 'Onboarding', intro_message: 'Thanks!', include_contact_confirm: false,
  created_at: '2026-01-01T00:00:00Z', sent_at: null, content_version: 3,
  items: [item(), item({ sort_order: 1, kind: 'question', label: 'Account number', sensitive: true })], ...over,
});
const recipient: ReviewRecipient = { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

describe('canonicalRequest', () => {
  const base = canonicalRequest(list(), recipient);

  it.each<[string, ReviewList, ReviewRecipient]>([
    ['title', list({ title: 'Other' }), recipient],
    ['intro', list({ intro_message: null }), recipient],
    ['contact-confirm switch', list({ include_contact_confirm: true }), recipient],
    ['an item label', list({ items: [item({ label: 'Other' }), list().items[1]] }), recipient],
    ['an item description', list({ items: [item({ description: 'More' }), list().items[1]] }), recipient],
    ['an item kind', list({ items: [item({ kind: 'todo' }), list().items[1]] }), recipient],
    ['required', list({ items: [item({ required: false }), list().items[1]] }), recipient],
    ['sensitive', list({ items: [item(), item({ sort_order: 1, kind: 'question', label: 'Account number' })] }), recipient],
    ['category', list({ items: [item({ category: 'contract' }), list().items[1]] }), recipient],
    ['tag', list({ items: [item({ tag: 'business' }), list().items[1]] }), recipient],
    ['an item order', list({ items: [item({ sort_order: 5 }), list().items[1]] }), recipient],
    ['fulfilment', list({ items: [item({ fulfilled: true }), list().items[1]] }), recipient],
    ['an added item', list({ items: [...list().items, item({ sort_order: 2 })] }), recipient],
    ['the address', list(), { ...recipient, email: 'grace@example.com' }],
    ['the first name', list(), { ...recipient, first_name: 'Grace' }],
    ['the last name', list(), { ...recipient, last_name: 'Hopper' }],
    ['the contact', list(), { ...recipient, id: 'c2' }],
  ])('moves with %s', (_label, l, r) => {
    expect(canonicalRequest(l, r)).not.toBe(base);
  });

  it('ignores the address case and padding, the version, the status and the read order', () => {
    expect(canonicalRequest(list(), { ...recipient, email: ' ADA@Example.com ' })).toBe(base);
    expect(canonicalRequest(list({ content_version: 9, status: 'sent', sent_at: '2026-02-01T00:00:00Z' }), recipient)).toBe(base);
    expect(canonicalRequest(list({ items: [...list().items].reverse() }), recipient)).toBe(base);
  });
});

describe('createReviewSigner', () => {
  const signer = createReviewSigner(SECRET);
  const canonical = canonicalRequest(list(), recipient);

  it('mints 32 hex characters, stable for the same input', async () => {
    const token = await signer.mint(LIST_ID, canonical);
    expect(token).toMatch(REVIEW_TOKEN_RE);
    expect(await signer.mint(LIST_ID, canonical)).toBe(token);
  });

  it('verifies only its own list, content and key', async () => {
    const token = await signer.mint(LIST_ID, canonical);
    expect(await signer.verify(token, LIST_ID, canonical)).toBe(true);
    expect(await signer.verify(token, 'b3bb189e-8bf9-4888-9912-ace4e6543002', canonical)).toBe(false);
    expect(await signer.verify(token, LIST_ID, canonicalRequest(list({ title: 'Other' }), recipient))).toBe(false);
    expect(await createReviewSigner(`${SECRET}-other`).verify(token, LIST_ID, canonical)).toBe(false);
  });

  it('refuses a malformed token before any crypto', async () => {
    const token = await signer.mint(LIST_ID, canonical);
    for (const bad of [token.toUpperCase(), `${token}0`, token.slice(1), '', ' '.repeat(32)]) {
      expect(await signer.verify(bad, LIST_ID, canonical)).toBe(false);
    }
  });

  it('refuses to sign with a short secret instead of signing with a guessable key', async () => {
    await expect(createReviewSigner('short').mint(LIST_ID, canonical)).rejects.toThrow(/signing secret unavailable/);
    await expect(createReviewSigner('').verify('a'.repeat(32), LIST_ID, canonical)).rejects.toThrow(/signing secret unavailable/);
  });
});
