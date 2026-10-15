import { describe, expect, it } from 'vitest';
import { isUuid, type ContactListRow } from '@/api/contacts';
import { EdgeError } from '@/lib/edgeCore';
import { idsFromQuery, MAX_RECIPIENTS, sendErrorMessage, splitRecipients } from '../compose';

const row = (id: string, status: string, email: string | null): ContactListRow => ({
  id,
  created_at: '2026-01-01T00:00:00Z',
  submitted_at: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  full_name: 'Ada Lovelace',
  email,
  phone: null,
  business_name: null,
  status,
  source: 'other',
});

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('splitRecipients', () => {
  it('keeps emailable contacts with an address and names why the rest are skipped', () => {
    const { eligible, skipped } = splitRecipients(
      [row(id(1), 'client', 'ada@example.com'), row(id(2), 'lost', 'x@example.com'), row(id(3), 'hot', null), row(id(4), 'esign_signer', 'y@example.com')],
      (key) => (key === 'lost' ? 'Lost' : key),
    );
    expect(eligible.map((c) => c.id)).toEqual([id(1)]);
    expect(skipped.map((s) => s.why)).toEqual(['Lost is never emailed', 'No email address', 'esign_signer is never emailed']);
  });
});

describe('idsFromQuery', () => {
  it('reads valid ids once each and drops the rest', () => {
    expect(idsFromQuery(`${id(1)},junk,${id(1)}, ${id(2)}`, isUuid)).toEqual([id(1), id(2)]);
    expect(idsFromQuery(null, isUuid)).toEqual([]);
  });

  it('caps the list at the server ceiling', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => id(i + 1)).join(',');
    expect(idsFromQuery(many, isUuid)).toHaveLength(MAX_RECIPIENTS);
  });
});

describe('sendErrorMessage', () => {
  it('names the configuration refusals a 5xx would otherwise hide', () => {
    expect(sendErrorMessage(new EdgeError('server', { status: 503, code: 'site_url_missing' }))).toMatch(/SITE_URL/);
    expect(sendErrorMessage(new EdgeError('server', { status: 503, code: 'email_not_configured' }))).toMatch(/RESEND_API_KEY/);
  });

  it('shows the server sentence for a 4xx, and a fixed line for anything else', () => {
    expect(sendErrorMessage(new EdgeError('conflict', { status: 409, message: 'That send did not go out. Try again.' }))).toBe(
      'That send did not go out. Try again.',
    );
    expect(sendErrorMessage(new Error('stack trace here'))).toBe('Something went wrong. Try again.');
  });
});
