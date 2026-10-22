import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { queryKeys } from '@/api/queryKeys';
import { ContactNotesCard } from '@/components/contacts/ContactNotesCard';
import { toast } from '@/components/ui/sonner';

const ADA = '10000000-0000-4000-8000-00000000000a';

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const note = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, contact_id: ADA, body, kind: 'note', source: 'owner', created_at: '2026-03-01T15:00:00Z', ...extra,
});

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fake.state.tables.contact_notes = [note('n1', 'Asked about the renewal.', { source: 'mcp' })];
});

describe('ContactNotesCard', () => {
  it('corrects a note in place, sending only its text and kind, and refreshes the pipeline cards', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(<ContactNotesCard contactId={ADA} />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    const box = screen.getByRole('textbox', { name: 'Edit note text' });
    expect(box).toHaveValue('Asked about the renewal.');
    fireEvent.change(box, { target: { value: '  Asked about the renewal date.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Waited on as a whole: the row re-renders as the edit closes and the list refetches.
    await waitFor(() => expect(screen.getByText('Asked about the renewal date.')).toBeInTheDocument());
    expect(fake.calls('contact_notes', 'update')[0].payload).toEqual({ body: 'Asked about the renewal date.', kind: 'note' });
    expect(fake.state.tables.contact_notes[0]).toMatchObject({ source: 'mcp' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.contacts.leadNotes() });
    expect(screen.queryByRole('textbox', { name: 'Edit note text' })).not.toBeInTheDocument();
  });

  it('will not save an emptied note, and Cancel leaves it as it was', async () => {
    render(<ContactNotesCard contactId={ADA} />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note text' }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Asked about the renewal.')).toBeInTheDocument();
    expect(fake.calls('contact_notes', 'update')).toHaveLength(0);
  });

  it('deletes only after the confirm', async () => {
    render(<ContactNotesCard contactId={ADA} />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete note' }));
    expect(fake.calls('contact_notes', 'delete')).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(fake.calls('contact_notes', 'delete')).toHaveLength(1));
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
  });

  it('a correction to a note deleted meanwhile is said, not swallowed', async () => {
    const error = vi.spyOn(toast, 'error');
    render(<ContactNotesCard contactId={ADA} />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    fake.state.tables.contact_notes = [];
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note text' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('That note no longer exists.'));
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
  });
});
