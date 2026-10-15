// The composer leaving the field step: it waits for the field saves and rereads the fields
// before the review opens, and a save that fails keeps the owner on the field step.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

const state = vi.hoisted(() => ({
  getPages: vi.fn(),
  getSigners: vi.fn(),
  getFields: vi.fn(),
  flush: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('../api', () => ({
  getPages: (...a: unknown[]) => state.getPages(...a),
  getSigners: (...a: unknown[]) => state.getSigners(...a),
  getFields: (...a: unknown[]) => state.getFields(...a),
}));
vi.mock('../components/DocumentsStep', () => ({ DocumentsStep: () => <p>documents step</p> }));
vi.mock('../components/SignersStep', () => ({ SignersStep: () => <p>signers step</p> }));
vi.mock('../components/ReviewSend', () => ({ ReviewSend: () => <p>review step</p> }));
vi.mock('../components/FieldPlacer', () => ({
  FieldPlacer: ({ registerFlush }: { registerFlush?: (f: (() => Promise<void>) | null) => void }) => {
    useEffect(() => {
      registerFlush?.(() => state.flush());
      return () => registerFlush?.(null);
    }, [registerFlush]);
    return <p>fields step</p>;
  },
}));

import { Composer } from '../components/Composer';
import type { EnvelopeWithContact } from '../api';

const envelope = { id: 'env-1', title: 'Acme plan', status: 'draft', verification_level: 'standard', primary_contact: null } as unknown as EnvelopeWithContact;

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Composer envelope={envelope} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function toFieldStep() {
  wrap();
  await screen.findByText('documents step');
  const next = screen.getByRole('button', { name: /Next/ });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
  await screen.findByText('signers step');
  fireEvent.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByText('fields step');
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.getPages.mockResolvedValue([{ id: 'p', deleted: false, order: 0 }]);
  state.getSigners.mockResolvedValue([{ id: 'ada', email: 'ada@example.com', role: 'primary', order: 0, phone_last_four: null, contact: null }]);
  state.getFields.mockResolvedValue([{ id: 'f', signer_id: 'ada', required: true }]);
});

describe('leaving the field step', () => {
  it('waits for the pending saves, rereads the fields, then opens the review', async () => {
    await toFieldStep();
    let finish!: () => void;
    state.flush.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const readsBefore = state.getFields.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByRole('button', { name: /Saving fields/ })).toBeDisabled();
    expect(screen.queryByText('review step')).not.toBeInTheDocument();
    finish();
    await screen.findByText('review step');
    expect(state.getFields.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('stays on the field step when a save fails', async () => {
    await toFieldStep();
    state.flush.mockRejectedValue(new Error('save failed'));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(state.flush).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled());
    expect(screen.getByText('fields step')).toBeInTheDocument();
    expect(screen.queryByText('review step')).not.toBeInTheDocument();
  });
});
