// Owner screens with the API stubbed per call: the delete confirmation and its force rule,
// the pending badge, and the review step's own checks.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EdgeError } from '@/lib/edgeCore';

const state = vi.hoisted(() => ({
  deleteEnvelope: vi.fn(),
  countPendingForContact: vi.fn(),
  getPages: vi.fn(),
  getSigners: vi.fn(),
  getFields: vi.fn(),
  sendEnvelope: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('@/components/ui/sonner', () => ({ toast: { error: state.toastError, success: state.toastSuccess } }));
vi.mock('../api', async () => {
  const core = await vi.importActual<typeof import('@/lib/edgeCore')>('@/lib/edgeCore');
  return {
    deleteEnvelope: (...a: unknown[]) => state.deleteEnvelope(...a),
    isRequiresForce: (e: unknown) => core.isEdgeError(e) && e.code === 'requires_force',
    countPendingForContact: (...a: unknown[]) => state.countPendingForContact(...a),
    getPages: (...a: unknown[]) => state.getPages(...a),
    getSigners: (...a: unknown[]) => state.getSigners(...a),
    getFields: (...a: unknown[]) => state.getFields(...a),
    sendEnvelope: (...a: unknown[]) => state.sendEnvelope(...a),
    voidEnvelope: vi.fn(),
    resendInvite: vi.fn(),
  };
});

import { EsignContactBadge } from '../badges';
import { DeleteEnvelopeDialog } from '../components/EnvelopeDialogs';
import { ReviewSend } from '../components/ReviewSend';
import type { EnvelopeWithContact } from '../api';
import { esignKeys } from '../keys';

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
});

describe('DeleteEnvelopeDialog', () => {
  const open = (status: string) =>
    wrap(<DeleteEnvelopeDialog envelopeId="env-1" envelopeTitle="Acme plan" envelopeStatus={status} open onOpenChange={() => undefined} />);

  it('stays shut until DELETE is typed, and sends force only for a completed envelope', async () => {
    state.deleteEnvelope.mockResolvedValue({});
    open('sent');
    const confirm = screen.getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'delete' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(state.deleteEnvelope).toHaveBeenCalledWith('env-1', false));
  });

  it('a completed envelope is deleted with force', async () => {
    state.deleteEnvelope.mockResolvedValue({});
    open('completed');
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(state.deleteEnvelope).toHaveBeenCalledWith('env-1', true));
  });

  it('requires_force says the envelope completed meanwhile and nothing went', async () => {
    state.deleteEnvelope.mockRejectedValue(new EdgeError('conflict', { status: 409, code: 'requires_force' }));
    open('sent');
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith(expect.stringMatching(/completed in the meantime, so nothing was deleted/)));
  });
});

describe('EsignContactBadge', () => {
  it('shows what is waiting, and nothing at zero', async () => {
    state.countPendingForContact.mockResolvedValueOnce(2);
    const { unmount } = wrap(<EsignContactBadge contactId="c1" />);
    expect(await screen.findByTitle('Envelopes waiting')).toHaveTextContent('2');
    unmount();
    state.countPendingForContact.mockResolvedValueOnce(0);
    const { container } = wrap(<EsignContactBadge contactId="c2" />);
    await waitFor(() => expect(state.countPendingForContact).toHaveBeenCalledWith('c2'));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ReviewSend', () => {
  const envelope = {
    id: 'env-1',
    title: 'Acme plan',
    status: 'draft',
    verification_level: 'high',
    primary_contact: null,
  } as unknown as EnvelopeWithContact;
  const signer = (id: string, phone: string | null) => ({ id, email: `${id}@example.com`, role: 'primary', order: 0, phone_last_four: phone, contact: null });

  it('lists every problem and keeps Send off', async () => {
    state.getPages.mockResolvedValue([{ id: 'p', deleted: false, order: 0 }]);
    state.getSigners.mockResolvedValue([signer('ada', null)]);
    state.getFields.mockResolvedValue([]);
    wrap(<ReviewSend envelope={envelope} />);
    expect(await screen.findByText('ada@example.com has no field to sign.')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com has no phone, which High verification needs.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send envelope' })).toBeDisabled();
  });

  it('rereads the fields on arrival and keeps Send off until they are back', async () => {
    state.getPages.mockResolvedValue([{ id: 'p', deleted: false, order: 0 }]);
    state.getSigners.mockResolvedValue([signer('ada', '0001')]);
    let answer!: (rows: unknown[]) => void;
    state.getFields.mockReturnValue(new Promise((r) => (answer = r)));
    // A cache that still holds a ready layout, and would never refetch on its own.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(esignKeys.fields('env-1'), [{ id: 'f', signer_id: 'ada', required: true }]);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ReviewSend envelope={envelope} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const send = await screen.findByRole('button', { name: 'Send envelope' });
    await waitFor(() => expect(state.getFields).toHaveBeenCalled());
    expect(send).toBeDisabled();
    answer([{ id: 'f2', signer_id: 'ada', required: true }]);
    await waitFor(() => expect(send).toBeEnabled());
  });

  it('sends after the confirmation and reports invitations that did not go out', async () => {
    state.getPages.mockResolvedValue([{ id: 'p', deleted: false, order: 0 }]);
    state.getSigners.mockResolvedValue([signer('ada', '0001')]);
    state.getFields.mockResolvedValue([{ id: 'f', signer_id: 'ada', required: true }]);
    state.sendEnvelope.mockResolvedValue({ signers_invited: 1, failed_emails: ['ada@example.com'] });
    wrap(<ReviewSend envelope={envelope} />);
    const send = await screen.findByRole('button', { name: 'Send envelope' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith(expect.stringMatching(/Resend invite for: ada@example.com/)));
  });
});
