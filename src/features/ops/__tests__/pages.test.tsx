import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
vi.mock('@/lib/edge', () => ({ invokeEdge: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { invokeEdge } from '@/lib/edge';
import { fakeClient, type Chain } from './fakeClient';
import { ID, job } from './fixtures';
import { JobsPage, jobsPollMs } from '../JobsPage';
import { OutboxPage, linkify } from '../OutboxPage';
import { AuditLogPage, shownDetail } from '../AuditLogPage';
import type { JobRow } from '../api';

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const selected = (chain: Chain) => String(fakeClient.argsOf(chain, 'select')[0]?.[0] ?? '');

beforeEach(() => {
  fakeClient.reset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(invokeEdge).mockReset();
  fakeClient.state.rpc.get_job_status_counts = { data: { pending: 1, running: 0, success: 1, failed: 1, dead: 1, all: 4 } };
});

describe('Jobs', () => {
  const rows = [
    job(1, { status: 'failed', provider: 'needs', action: 'reminder_dispatch', last_error: 'needs-reminder-dispatcher answered 502' }),
    job(2, { status: 'dead', provider: 'esign', action: 'expire_envelopes' }),
    job(3, { status: 'success', provider: 'ops', action: 'maintenance', result: { cleanup_core_operational_rows: { jobs_success: 4 } } }),
    job(4, { status: 'pending', finished_at: null }),
  ];

  const seed = (overdue = 0) => {
    fakeClient.state.answers.jobs = (chain) => {
      if (selected(chain) === 'finished_at') return { data: [{ finished_at: '2026-10-14T03:45:10Z' }] };
      if (selected(chain) === 'id') return { count: overdue };
      return { data: rows };
    };
  };

  it('lists jobs by name and offers Retry only on failed and dead ones', async () => {
    seed();
    renderPage(<JobsPage />);
    expect(await screen.findByText('Request reminders')).toBeInTheDocument();
    expect(screen.getByText('Clean up old records')).toBeInTheDocument();
    expect(screen.getByText('needs-reminder-dispatcher answered 502')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry Request reminders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry Expire e-signature envelopes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Clean up old records' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry Portal daily digest' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries through the RPC and says when it will run', async () => {
    seed();
    renderPage(<JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Request reminders' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Queued. It runs on the next tick, within a minute, when schedules are installed.'));
    expect(fakeClient.state.rpcCalls).toContainEqual({ name: 'retry_job', args: { p_job_id: ID(1) } });
  });

  it('shows a refused retry as an error', async () => {
    seed();
    fakeClient.state.rpc.retry_job = { error: { message: 'job not retryable (must be failed or dead)' } };
    renderPage(<JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Request reminders' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not retry: job not retryable (must be failed or dead)'));
  });

  it('runs the queue now and reports what ran', async () => {
    seed();
    vi.mocked(invokeEdge).mockResolvedValue({ claimed: 2, succeeded: 1, failed: 1, superseded: 0 });
    renderPage(<JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run queue now' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ran 2 jobs: 1 done, 1 failed.'));
    expect(vi.mocked(invokeEdge).mock.calls[0][0]).toBe('job-runner');
  });

  it('warns when pending jobs are late, which means nothing runs the queue', async () => {
    seed(2);
    renderPage(<JobsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 jobs are more than 5 minutes late');
    expect(alert).toHaveTextContent('Install the schedules');
  });

  it('opens a job to show its payload and result', async () => {
    seed();
    renderPage(<JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Clean up old records' }));
    expect(screen.getByText(/"jobs_success": 4/)).toBeInTheDocument();
  });

  it('polls fast only while something is waiting or running', () => {
    const r = (status: string) => job(1, { status }) as JobRow;
    expect(jobsPollMs([r('success'), r('pending')])).toBe(5_000);
    expect(jobsPollMs([r('running')])).toBe(5_000);
    expect(jobsPollMs([r('success'), r('dead')])).toBe(30_000);
    expect(jobsPollMs(undefined)).toBe(30_000);
  });

  it('says how to get jobs when there are none', async () => {
    fakeClient.state.answers.jobs = (chain) => (selected(chain) === 'id' ? { count: 0 } : { data: [] });
    renderPage(<JobsPage />);
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
    expect(screen.getByText(/See Schedules in the README/)).toBeInTheDocument();
  });
});

describe('Outbox', () => {
  const HTML = '<p>Hello</p><img id="planted" src="x" onerror="window.__ran = true"><script>window.__ran = true</script>';
  const messages = [
    {
      id: ID(1), channel: 'email', recipient: 'ada@example.com', sender: 'Acme LLC', subject: 'Your portal invitation',
      body_text: 'Open https://crm.example.com/invite?t=abc to start. Not javascript:alert(1) though.', body_html: HTML,
      created_at: '2026-10-14T12:00:00Z',
    },
    { id: ID(2), channel: 'sms', recipient: '+15550100001', sender: null, subject: null, body_text: 'Code 123456', body_html: null, created_at: '2026-10-14T11:00:00Z' },
  ];

  it('shows the email HTML only inside a sandbox with no permissions, never in the page', async () => {
    fakeClient.state.answers.dev_outbox = { data: messages };
    renderPage(<OutboxPage />);
    const frame = (await screen.findByTitle('Email preview')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(HTML);
    expect(document.getElementById('planted')).toBeNull();
    expect((window as { __ran?: boolean }).__ran).toBeUndefined();
  });

  it('makes web links in the text clickable, and nothing else', async () => {
    fakeClient.state.answers.dev_outbox = { data: messages };
    renderPage(<OutboxPage />);
    const link = await screen.findByRole('link', { name: 'https://crm.example.com/invite?t=abc' });
    expect(link).toHaveAttribute('href', 'https://crm.example.com/invite?t=abc');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.queryByRole('link', { name: /javascript/ })).toBeNull();
    render(<p data-testid="t">{linkify('see javascript:alert(1) and data:text/html,x')}</p>);
    expect(within(screen.getByTestId('t')).queryAllByRole('link')).toHaveLength(0);
  });

  it('opens a text message', async () => {
    fakeClient.state.answers.dev_outbox = { data: messages };
    renderPage(<OutboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: /\+15550100001/ }));
    expect(screen.getByText('Code 123456')).toBeInTheDocument();
  });

  it('clears every message after asking', async () => {
    fakeClient.state.answers.dev_outbox = (chain) => (chain.calls.some(([m]) => m === 'delete') ? { count: 2 } : { data: messages });
    renderPage(<OutboxPage />);
    await screen.findByTitle('Email preview');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cleared 2 messages.'));
    expect(fakeClient.chains('dev_outbox').some((c) => c.calls.some(([m]) => m === 'delete'))).toBe(true);
  });
});

describe('Audit log', () => {
  const OWNER = ID(90);
  const SYSTEM = ID(91);
  const ADA = ID(1);

  beforeEach(() => {
    fakeClient.state.answers.org_profile = { data: { owner_user_id: OWNER, system_user_id: SYSTEM } };
    fakeClient.state.answers.contacts = { data: [{ id: ADA, full_name: 'Ada Lovelace', business_name: null }] };
    fakeClient.state.answers.audit_logs = {
      data: [
        { id: ID(10), user_id: OWNER, action: 'contact_deleted', details: { contact_id: ADA, full_name: 'Leaked Name', portal_users_removed: 1 }, ip_address: null, user_agent: null, created_at: '2026-10-14T12:00:00Z' },
        { id: ID(11), user_id: SYSTEM, action: 'contact.read', details: { source: 'mcp', count: 3 }, ip_address: '203.0.113.9', user_agent: null, created_at: '2026-10-14T11:00:00Z' },
      ],
    };
    fakeClient.state.answers.client_activity_log = {
      data: [{ id: ID(20), contact_id: ADA, user_id: ID(5), action: 'document_upload', details: { document_id: ID(30) }, ip_address: null, created_at: '2026-10-14T10:00:00Z' }],
    };
  });

  it('names people from ids and contacts, never from the details', async () => {
    renderPage(<AuditLogPage />);
    expect(await screen.findByText('Contact deleted')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('href', `/contacts/${ADA}`);
    expect(screen.queryByText(/Leaked Name/)).toBeNull();
    expect(screen.getByText('via MCP')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
  });

  it('shows portal activity on its own tab', async () => {
    renderPage(<AuditLogPage />);
    await screen.findByText('Contact deleted');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Portal activity' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Portal activity' }));
    expect(await screen.findByText('Document uploaded')).toBeInTheDocument();
    expect(screen.getByText('Client')).toBeInTheDocument();
  });

  it('shows ids, numbers, flags and codes from details, and hides anything else', () => {
    expect(shownDetail(ADA)).toBe(ADA);
    expect(shownDetail(3)).toBe('3');
    expect(shownDetail(true)).toBe('yes');
    expect(shownDetail('enforce')).toBe('enforce');
    expect(shownDetail(['a', ADA])).toBe(`a, ${ADA}`);
    expect(shownDetail('Ada Lovelace')).toBeNull();
    expect(shownDetail('ada@example.com')).toBeNull();
    expect(shownDetail('5550100001')).toBeNull();
    expect(shownDetail(['ok', 'Not Ok'])).toBeNull();
    expect(shownDetail({ nested: 1 })).toBeNull();
  });
});
