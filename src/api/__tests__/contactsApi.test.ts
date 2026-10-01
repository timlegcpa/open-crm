import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake, functionsHttpError } from '@/__tests__/fakeSupabase';
import {
  bulkUpdateStatus,
  createContact,
  deleteContact,
  deleteContacts,
  listContacts,
  updateContact,
} from '@/api/contacts';
import {
  addContactEmail,
  deleteContactEmail,
  setDefaultContactEmail,
  updateContactEmail,
} from '@/api/contactEmails';
import { addContactNote, listContactNotes } from '@/api/contactNotes';
import { addRelationship, listHousehold, removeRelationship } from '@/api/contactRelationships';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const C = '10000000-0000-4000-8000-00000000000c';

function contactRow(id: string, first: string, last = '') {
  return { id, first_name: first, last_name: last, full_name: last ? `${first} ${last}` : first, business_name: null, status: 'new_lead', source: 'other' };
}

beforeEach(() => fake.reset());

describe('contacts', () => {
  it('reads past 1,000 rows with keyset pages on id', async () => {
    fake.state.tables.contacts = Array.from({ length: 1001 }, (_, i) =>
      contactRow(`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Person ${i}`),
    );
    const all = await listContacts();
    expect(all).toHaveLength(1001);
    const selects = fake.calls('contacts', 'select');
    expect(selects).toHaveLength(2);
    expect(selects[0].filters).toEqual([]);
    expect(selects[1].filters).toEqual([{ type: 'gt', column: 'id', value: all[999].id }]);
  });

  it('throws instead of returning a partial list when a page fails', async () => {
    fake.state.errors['contacts:select'] = { message: 'permission denied for table contacts' };
    await expect(listContacts()).rejects.toEqual({ message: 'permission denied for table contacts' });
  });

  it('intake inserts exactly the intake columns', async () => {
    const id = await createContact({
      first_name: 'Ada',
      last_name: 'Example',
      email: 'ada@example.com',
      phone: '555-0100',
      business_name: 'Example Studio',
      status: 'new_lead',
      source: 'referral',
      submitted_at: '2026-01-02T05:00:00.000Z',
    });
    expect(id).toEqual(expect.any(String));
    const [insert] = fake.calls('contacts', 'insert');
    expect(insert.payload).toEqual({
      first_name: 'Ada',
      last_name: 'Example',
      email: 'ada@example.com',
      phone: '555-0100',
      business_name: 'Example Studio',
      status: 'new_lead',
      source: 'referral',
      submitted_at: '2026-01-02T05:00:00.000Z',
    });
  });

  it('a field update sends only allow-listed columns, dropping anything else', async () => {
    fake.state.tables.contacts = [contactRow(A, 'Ada')];
    await updateContact(A, {
      first_name: 'Ada',
      mailing_city: 'Springfield',
      // Not editable from the form: must not ride along.
      ...({ email: 'x@example.com', full_name: 'Forged', status_history: [], delete_claim: 'x' } as object),
    });
    const [update] = fake.calls('contacts', 'update');
    expect(update.payload).toEqual({ first_name: 'Ada', mailing_city: 'Springfield' });
    expect(update.filters).toEqual([{ type: 'eq', column: 'id', value: A }]);
  });

  it('a field update that reaches no row says so', async () => {
    await expect(updateContact(A, { first_name: 'Ada' })).rejects.toThrow('may have been deleted');
  });

  it('bulk status writes status and nothing else, and counts the rows it reached', async () => {
    fake.state.tables.contacts = [contactRow(A, 'Ada'), contactRow(B, 'Bo')];
    const result = await bulkUpdateStatus([A, B, C], 'client');
    expect(result).toEqual({ requested: 3, updated: 2, error: null });
    const updates = fake.calls('contacts', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ status: 'client' });
    expect(updates[0].filters).toEqual([{ type: 'in', column: 'id', value: [A, B, C] }]);
  });

  it('bulk status splits long id lists into requests of 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await bulkUpdateStatus(ids, 'lost');
    expect(fake.calls('contacts', 'update').map((c) => (c.filters[0].value as string[]).length)).toEqual([100, 100, 50]);
  });

  it('delete goes through the edge function, never a table delete', async () => {
    fake.state.tables.contacts = [contactRow(A, 'Ada')];
    await expect(deleteContact(A)).resolves.toEqual({ alreadyGone: false });
    expect(fake.state.invokeCalls).toEqual([{ name: 'delete-contact', body: { contact_id: A } }]);
    expect(fake.calls('contacts', 'delete')).toEqual([]);
  });

  it('treats already_gone as success', async () => {
    fake.state.invokeResults[A] = { data: { deleted: true, already_gone: true }, error: null };
    await expect(deleteContact(A)).resolves.toEqual({ alreadyGone: true });
  });

  it('turns a 409 into a plain "already being deleted" message', async () => {
    fake.state.invokeResults[A] = { data: null, error: functionsHttpError(409, { error: 'delete_in_progress' }) };
    await expect(deleteContact(A)).rejects.toThrow('already being deleted');
  });

  it("shows the server's generic message for any other failure", async () => {
    fake.state.invokeResults[A] = { data: null, error: functionsHttpError(500, { error: 'Delete failed. Try again.' }) };
    await expect(deleteContact(A)).rejects.toThrow('Delete failed. Try again.');
  });

  it('bulk delete calls the function once per contact, in order, and reports each outcome', async () => {
    fake.state.invokeResults[B] = { data: null, error: functionsHttpError(409, { error: 'delete_in_progress' }) };
    const outcomes = await deleteContacts([A, B, C]);
    expect(fake.state.invokeCalls.map((c) => c.body)).toEqual([{ contact_id: A }, { contact_id: B }, { contact_id: C }]);
    expect(outcomes).toEqual([
      { id: A, ok: true, alreadyGone: false },
      { id: B, ok: false, error: 'This contact is already being deleted. Try again in a moment.' },
      { id: C, ok: true, alreadyGone: false },
    ]);
    expect(fake.calls('contacts', 'delete')).toEqual([]);
  });

  it('the contacts module has no table-delete call on contacts at all', () => {
    // The browser's DELETE grant on contacts is being revoked; this outlives the grant.
    const source = readFileSync(path.resolve(__dirname, '..', 'contacts.ts'), 'utf8');
    expect(source).not.toMatch(/\.delete\s*\(/);
  });
});

describe('contact emails', () => {
  it('inserts a new address as non-default with exactly the insert columns', async () => {
    await addContactEmail({ contactId: A, kind: 'spouse', email: 'bo@example.com', label: 'personal' });
    expect(fake.calls('contact_emails', 'insert')[0].payload).toEqual({
      contact_id: A,
      kind: 'spouse',
      email: 'bo@example.com',
      label: 'personal',
      is_default: false,
    });
  });

  it('updates only email and label', async () => {
    await updateContactEmail('e1', { email: 'new@example.com', label: 'business' });
    const [update] = fake.calls('contact_emails', 'update');
    expect(update.payload).toEqual({ email: 'new@example.com', label: 'business' });
    expect(update.filters).toEqual([{ type: 'eq', column: 'id', value: 'e1' }]);
  });

  it('deletes by id', async () => {
    await deleteContactEmail('e1');
    expect(fake.calls('contact_emails', 'delete')[0].filters).toEqual([{ type: 'eq', column: 'id', value: 'e1' }]);
  });

  it('moves the default through the RPC', async () => {
    await setDefaultContactEmail('e1', A, 'primary');
    expect(fake.state.rpcCalls).toEqual([
      { name: 'contact_emails_set_default', args: { p_id: 'e1', p_contact_id: A, p_kind: 'primary' } },
    ]);
  });

  it('surfaces an RPC error', async () => {
    fake.state.rpcErrors.contact_emails_set_default = { message: 'no matching row' };
    await expect(setDefaultContactEmail('e1', A, 'primary')).rejects.toEqual({ message: 'no matching row' });
  });
});

describe('contact notes', () => {
  it("inserts body and kind with source 'owner'", async () => {
    await addContactNote(A, 'Called about the renewal.', 'call');
    expect(fake.calls('contact_notes', 'insert')[0].payload).toEqual({
      contact_id: A,
      body: 'Called about the renewal.',
      kind: 'call',
      source: 'owner',
    });
  });

  it('lists newest first', async () => {
    fake.state.tables.contact_notes = [
      { id: 'n1', contact_id: A, body: 'old', kind: 'note', source: 'owner', created_at: '2026-01-01T00:00:00Z' },
      { id: 'n2', contact_id: A, body: 'new', kind: 'note', source: 'owner', created_at: '2026-02-01T00:00:00Z' },
    ];
    expect((await listContactNotes(A)).map((n) => n.body)).toEqual(['new', 'old']);
  });

  it('reads every note past 1,000, newest first', async () => {
    fake.state.tables.contact_notes = Array.from({ length: 1001 }, (_, i) => ({
      id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      contact_id: A,
      body: `note ${i}`,
      kind: 'note',
      source: 'owner',
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    const notes = await listContactNotes(A);
    expect(notes).toHaveLength(1001);
    expect([notes[0].body, notes[1000].body]).toEqual(['note 1000', 'note 0']);
    expect(fake.calls('contact_notes', 'select')).toHaveLength(2);
  });
});

describe('contact relationships', () => {
  it('inserts exactly the link columns', async () => {
    await addRelationship({ contactId: A, relatedContactId: B, relationship: 'spouse' });
    expect(fake.calls('contact_relationships', 'insert')[0].payload).toEqual({
      contact_id: A,
      related_contact_id: B,
      relationship: 'spouse',
    });
  });

  it('refuses a self-link without calling the server', async () => {
    await expect(addRelationship({ contactId: A, relatedContactId: A, relationship: 'other' })).rejects.toThrow('itself');
    expect(fake.state.calls).toEqual([]);
  });

  it('deletes by id', async () => {
    await removeRelationship('r1');
    expect(fake.calls('contact_relationships', 'delete')[0].filters).toEqual([{ type: 'eq', column: 'id', value: 'r1' }]);
  });

  it('lists links in both directions with the other contact named', async () => {
    fake.state.tables.contacts = [contactRow(A, 'Ada'), contactRow(B, 'Bo', 'Example'), contactRow(C, 'Cy')];
    fake.state.tables.contact_relationships = [
      { id: 'r1', contact_id: A, related_contact_id: B, relationship: 'spouse', created_at: '2026-01-01' },
      { id: 'r2', contact_id: C, related_contact_id: A, relationship: 'dependent', created_at: '2026-01-02' },
      { id: 'r3', contact_id: B, related_contact_id: C, relationship: 'other', created_at: '2026-01-03' },
    ];
    expect(await listHousehold(A)).toEqual([
      { id: 'r1', relationship: 'spouse', direction: 'outgoing', otherId: B, otherName: 'Bo Example' },
      { id: 'r2', relationship: 'dependent', direction: 'incoming', otherId: C, otherName: 'Cy' },
    ]);
  });

  it('refuses a non-uuid before it reaches a filter string', async () => {
    await expect(listHousehold(`${A},contact_id.neq.x`)).rejects.toThrow();
    expect(fake.state.calls).toEqual([]);
  });
});
