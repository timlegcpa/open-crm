// The portal api against the shared fake: the contact row from a set-returning RPC, pending
// tasks only and newest first with a stable tie-break, and a switch write that keeps keys
// it does not own.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ answer: { data: null as unknown, error: null as unknown } }));

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/__tests__/fakeSupabase');
  const client = {
    ...fake.client,
    rpc: async (name: string, args?: unknown) => (name === 'get_my_contact' ? rpc.answer : fake.client.rpc(name, args)),
  };
  return { supabaseConfigured: true, getSupabase: () => client };
});

import { fake } from '@/__tests__/fakeSupabase';
import { getMyContact, listMyPendingTasks, setPortalSidebarFlag } from '../api';

const C = '10000000-0000-4000-8000-0000000000c1';
const row = {
  id: C,
  first_name: 'Ada',
  last_name: 'Lovelace',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  business_name: 'Acme LLC',
  spouse_first_name: null,
  spouse_last_name: null,
  spouse_name: null,
  spouse_email: null,
  client_since: null,
  portal_sidebar_config: { hide_messages: true },
};

beforeEach(() => {
  fake.reset();
  rpc.answer = { data: null, error: null };
});

describe('portal api', () => {
  it('reads the contact from the array a set-returning function answers with, or none', async () => {
    rpc.answer = { data: [row], error: null };
    expect(await getMyContact()).toMatchObject({ id: C, portal_sidebar_config: { hide_documents: false, hide_messages: true } });
    rpc.answer = { data: [], error: null };
    expect(await getMyContact()).toBeNull();
    rpc.answer = { data: null, error: { message: 'denied' } };
    await expect(getMyContact()).rejects.toMatchObject({ message: 'denied' });
  });

  it('lists pending tasks only, newest first, ties broken by id', async () => {
    const task = (id: string, created_at: string, status = 'pending') => ({
      id, contact_id: C, title: id, description: null, type: 'action_item', link: null, status, created_at,
    });
    fake.state.tables.client_tasks = [
      task('b', '2026-05-01T00:00:00Z'),
      task('a', '2026-05-01T00:00:00Z'),
      task('c', '2026-05-02T00:00:00Z'),
      task('d', '2026-05-03T00:00:00Z', 'completed'),
    ];
    expect((await listMyPendingTasks(C)).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('turns one switch and keeps every other key', async () => {
    fake.state.tables.contacts = [{ id: C, portal_sidebar_config: { hide_documents: false, theme: 'compact' } }];
    await setPortalSidebarFlag(C, 'hide_documents', true);
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ portal_sidebar_config: { hide_documents: true, theme: 'compact' } });
  });
});
