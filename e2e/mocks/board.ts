import { ID } from './ids';
import type { Row } from './postgrest';
import type { CallContext, RpcHandler } from './supabase';

/** The board (0008): the four fixed lanes, the seeded card types and a few cards. */

const ada = { id: ID.ada, full_name: 'Ada Lovelace', business_name: 'Acme LLC' };
const grace = { id: ID.grace, full_name: 'Grace Hopper', business_name: null };

function card(fields: Row): Row {
  return { work_item_type: 'task', priority: 'normal', due_date: null, lane_position: null, archived_at: null, created_at: '2026-10-01T15:00:00Z', ...fields };
}

export const boardTables: Record<string, Row[]> = {
  board_stages: [
    { key: 'todo', label: 'To do', colour: null, sort_order: 10 },
    { key: 'waiting', label: 'Waiting', colour: null, sort_order: 20 },
    { key: 'doing', label: 'In progress', colour: null, sort_order: 30 },
    { key: 'done', label: 'Done', colour: null, sort_order: 40 },
  ],
  work_item_types: [
    ['task', 'Task', 10, true],
    ['follow_up', 'Follow-up', 20, false],
    ['call', 'Call', 30, false],
    ['meeting', 'Meeting', 40, false],
    ['paperwork', 'Paperwork', 50, false],
  ].map(([key, label, sort_order, is_system]) => ({ key, label, colour: null, sort_order, is_active: true, is_system })),
  work_items: [
    card({ id: '00000000-0000-4000-8000-000000000801', contact_id: ID.ada, title: 'Kickoff call', work_item_type: 'call', stage: 'done', contact: ada }),
    card({ id: '00000000-0000-4000-8000-000000000802', contact_id: ID.ada, title: 'Review onboarding answers', stage: 'waiting', priority: 'urgent', due_date: '2026-10-20', contact: ada }),
    card({ id: '00000000-0000-4000-8000-000000000803', contact_id: ID.grace, title: 'Send proposal', work_item_type: 'follow_up', stage: 'todo', contact: grace }),
    card({ id: '00000000-0000-4000-8000-000000000804', contact_id: null, title: 'Update price sheet', work_item_type: 'paperwork', stage: 'doing', priority: 'low', contact: null }),
  ],
  work_item_events: [],
};

export const boardRpc: Record<string, RpcHandler> = {
  create_work_item: (args: Record<string, unknown>, ctx: CallContext) => {
    const id = ctx.newId();
    const contact = ctx.table('contacts').find((c) => c.id === args.p_contact_id);
    ctx.table('work_items').push(
      card({
        id,
        contact_id: args.p_contact_id ?? null,
        title: args.p_title,
        work_item_type: args.p_work_item_type ?? 'task',
        stage: args.p_stage ?? 'todo',
        priority: args.p_priority ?? 'normal',
        due_date: args.p_due_date ?? null,
        created_at: new Date().toISOString(),
        contact: contact ? { id: contact.id, full_name: contact.full_name, business_name: contact.business_name } : null,
      }),
    );
    return id;
  },
};
