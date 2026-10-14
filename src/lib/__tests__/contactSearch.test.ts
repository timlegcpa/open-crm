// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchesContactSearch, type SearchableContact } from '@/lib/contactSearch';

const ada: SearchableContact = {
  full_name: 'Ada Lovelace',
  business_name: 'Acme LLC',
  email: 'ada@example.com',
  phone: '(555) 010-0001',
};

describe('matchesContactSearch', () => {
  it('matches name, business and email, ignoring case and surrounding space', () => {
    expect(matchesContactSearch(ada, 'lovelace')).toBe(true);
    expect(matchesContactSearch(ada, '  ACME ')).toBe(true);
    expect(matchesContactSearch(ada, 'ada@example')).toBe(true);
    expect(matchesContactSearch(ada, 'babbage')).toBe(false);
  });

  it('matches phone digits whatever the punctuation', () => {
    expect(matchesContactSearch(ada, '5550100001')).toBe(true);
    expect(matchesContactSearch(ada, '555-010')).toBe(true);
    expect(matchesContactSearch(ada, '999')).toBe(false);
  });

  it('a contact with no phone never matches on digits alone', () => {
    expect(matchesContactSearch({ ...ada, phone: null }, '5550100001')).toBe(false);
  });

  it('a business-only contact is found by its business', () => {
    expect(matchesContactSearch({ full_name: '', business_name: 'Acme LLC', email: null, phone: null }, 'acme')).toBe(true);
  });

  it('an empty query matches everyone', () => {
    expect(matchesContactSearch(ada, '   ')).toBe(true);
  });
});
