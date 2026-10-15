import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
vi.mock('@/lib/edge', () => ({ invokeEdge: vi.fn() }));

import { invokeEdge } from '@/lib/edge';
import { fakeClient } from './fakeClient';
import {
  clearOutbox,
  contactIdsOf,
  getJobHealth,
  getPeople,
  JOB_COLUMNS,
  listAuditLog,
  listJobs,
  listOutbox,
  PAGE_ROWS,
  retryJob,
  runQueueNow,
} from '../api';
import { ACTIVITY_ACTION_LABELS, JOB_KIND_LABELS, actionLabel, humanize, jobKindLabel } from '../labels';
import { JOB_KINDS } from '../../../../supabase/functions/job-runner/kinds';

import { ID, job } from './fixtures';

beforeEach(() => fakeClient.reset());

describe('jobs', () => {
  it('names its columns and never reads the claim token', async () => {
    await listJobs('all', 0);
    const [chain] = fakeClient.chains('jobs');
    expect(fakeClient.argsOf(chain, 'select')).toEqual([[JOB_COLUMNS]]);
    expect(JOB_COLUMNS).not.toMatch(/claim_token|\*/);
  });

  it('pages newest first with the id as tiebreaker, one row past the page to know if more follow', async () => {
    fakeClient.state.answers.jobs = { data: Array.from({ length: PAGE_ROWS + 1 }, (_, i) => job(i)) };
    const page = await listJobs('failed', 2);
    const [chain] = fakeClient.chains('jobs');
    expect(fakeClient.argsOf(chain, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
    expect(fakeClient.argsOf(chain, 'eq')).toEqual([['status', 'failed']]);
    expect(fakeClient.argsOf(chain, 'range')).toEqual([[2 * PAGE_ROWS, 3 * PAGE_ROWS]]);
    expect(page.rows).toHaveLength(PAGE_ROWS);
    expect(page.hasMore).toBe(true);
  });

  it('refuses a row that is not a job (Zod at the boundary)', async () => {
    fakeClient.state.answers.jobs = { data: [job(1, { status: 'exploded' })] };
    await expect(listJobs('all', 0)).rejects.toThrow();
  });

  it('throws a query error instead of showing an empty queue', async () => {
    fakeClient.state.answers.jobs = { error: { message: 'permission denied' } };
    await expect(listJobs('all', 0)).rejects.toEqual({ message: 'permission denied' });
  });

  it('reports overdue pending jobs and the last finish', async () => {
    fakeClient.state.answers.jobs = (chain) =>
      fakeClient.argsOf(chain, 'select')[0][0] === 'finished_at' ? { data: [{ finished_at: '2026-10-14T03:45:10Z' }] } : { count: 3 };
    const now = new Date('2026-10-14T12:00:00Z');
    expect(await getJobHealth(now)).toEqual({ lastFinishedAt: '2026-10-14T03:45:10Z', overdue: 3 });
    const overdue = fakeClient.chains('jobs').find((c) => fakeClient.argsOf(c, 'lt').length > 0)!;
    expect(fakeClient.argsOf(overdue, 'lt')).toEqual([['scheduled_at', '2026-10-14T11:55:00.000Z']]);
    expect(fakeClient.argsOf(overdue, 'eq')).toEqual([['status', 'pending']]);
  });

  it('retries through the owner-only RPC and runs the queue through the edge function', async () => {
    await retryJob(ID(7));
    expect(fakeClient.state.rpcCalls).toEqual([{ name: 'retry_job', args: { p_job_id: ID(7) } }]);
    vi.mocked(invokeEdge).mockResolvedValueOnce({ claimed: 0, succeeded: 0, failed: 0, superseded: 0 });
    await runQueueNow();
    expect(vi.mocked(invokeEdge).mock.calls[0][0]).toBe('job-runner');
  });
});

describe('outbox', () => {
  it('pages newest first, and clearing deletes every row with a filter PostgREST accepts', async () => {
    await listOutbox(0);
    const [list] = fakeClient.chains('dev_outbox');
    expect(fakeClient.argsOf(list, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
    fakeClient.state.answers.dev_outbox = { count: 4 };
    expect(await clearOutbox()).toBe(4);
    const del = fakeClient.chains('dev_outbox')[1];
    expect(fakeClient.argsOf(del, 'delete')).toEqual([[{ count: 'exact' }]]);
    expect(fakeClient.argsOf(del, 'not')).toEqual([['id', 'is', null]]);
  });
});

describe('audit log', () => {
  it('filters whole local days and one action, newest first', async () => {
    await listAuditLog({ from: '2026-10-01', to: '2026-10-03', action: 'owner_login' }, 0);
    const [chain] = fakeClient.chains('audit_logs');
    expect(fakeClient.argsOf(chain, 'gte')).toEqual([['created_at', new Date(2026, 9, 1).toISOString()]]);
    expect(fakeClient.argsOf(chain, 'lt')).toEqual([['created_at', new Date(2026, 9, 4).toISOString()]]);
    expect(fakeClient.argsOf(chain, 'eq')).toEqual([['action', 'owner_login']]);
    expect(fakeClient.argsOf(chain, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
  });

  it('applies no bound for an empty filter', async () => {
    await listAuditLog({ from: '', to: '', action: '' }, 0);
    const [chain] = fakeClient.chains('audit_logs');
    expect(chain.calls.map(([m]) => m)).not.toContain('gte');
    expect(chain.calls.map(([m]) => m)).not.toContain('eq');
  });

  it('collects contact ids from the column and from details, ignoring anything not an id', () => {
    expect(contactIdsOf([
      { contact_id: ID(1), details: {} },
      { details: { contact_id: ID(2), full_name: 'Ada Lovelace' } },
      { details: { contact_id: 'not-an-id' } },
    ])).toEqual([ID(1), ID(2)]);
  });

  it('names contacts from the contacts table', async () => {
    fakeClient.state.answers.org_profile = { data: { owner_user_id: ID(9), system_user_id: ID(8) } };
    fakeClient.state.answers.contacts = { data: [{ id: ID(1), full_name: 'Ada Lovelace', business_name: null }, { id: ID(2), full_name: '', business_name: 'Acme LLC' }] };
    const people = await getPeople([ID(1), ID(2)]);
    expect(people.contacts.get(ID(1))).toBe('Ada Lovelace');
    expect(people.contacts.get(ID(2))).toBe('Acme LLC');
    expect(people.ownerUserId).toBe(ID(9));
    const [chain] = fakeClient.chains('contacts');
    expect(fakeClient.argsOf(chain, 'in')).toEqual([['id', [ID(1), ID(2)]]]);
  });
});

describe('labels', () => {
  it('names every job-runner kind, and nothing else', () => {
    expect(Object.keys(JOB_KIND_LABELS).sort()).toEqual([...JOB_KINDS].sort());
    expect(jobKindLabel('ops', 'maintenance')).toBe('Clean up old records');
    expect(jobKindLabel('shop', 'sync')).toBe('shop:sync');
    expect(jobKindLabel('constructor', '')).toBe('constructor:');
  });

  it('names every portal activity action the database accepts', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/0002_contacts.sql'), 'utf8');
    const list = /CREATE TABLE public\.client_activity_log[\s\S]*?action text NOT NULL CHECK \(action IN \(([\s\S]*?)\)\)/.exec(sql)![1];
    const actions = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(Object.keys(ACTIVITY_ACTION_LABELS).sort()).toEqual(actions);
  });

  it('humanizes an action it has no label for', () => {
    expect(humanize('contact.status_changed')).toBe('Contact status changed');
    expect(actionLabel({}, 'toString')).toBe('ToString');
  });
});
