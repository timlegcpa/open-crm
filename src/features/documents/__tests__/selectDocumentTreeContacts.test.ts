import { describe, it, expect } from 'vitest';
import { selectDocumentTreeContacts } from '../explorer/selectDocumentTreeContacts';
import type { ExplorerContact } from '../explorer/types';

const mk = (id: string, status: string): ExplorerContact => ({
  id,
  full_name: 'Ada Lovelace',
  business_name: 'Acme LLC',
  email: `${id}@example.com`,
  phone: null,
  status,
});

describe('selectDocumentTreeContacts', () => {
  it('includes active clients regardless of whether they have documents', () => {
    const contacts = [mk('a', 'client'), mk('b', 'client')];
    const result = selectDocumentTreeContacts(contacts, []);
    expect(result.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('includes a non-client contact that still has documents (the one_time regression)', () => {
    const contacts = [mk('ada', 'one_time'), mk('lead', 'new_lead')];
    const result = selectDocumentTreeContacts(contacts, ['ada']);
    expect(result.map((c) => c.id)).toEqual(['ada']);
  });

  it('excludes non-client contacts with no documents', () => {
    const contacts = [mk('lost', 'lost'), mk('lead', 'new_lead'), mk('onetime', 'one_time')];
    const result = selectDocumentTreeContacts(contacts, []);
    expect(result).toEqual([]);
  });

  it('does not duplicate a client who also appears in the docs set', () => {
    const contacts = [mk('a', 'client')];
    const result = selectDocumentTreeContacts(contacts, ['a']);
    expect(result.map((c) => c.id)).toEqual(['a']);
  });
});
