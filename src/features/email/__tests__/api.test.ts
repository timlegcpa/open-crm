import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/edge', () => ({ invokeEdge: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => { throw new Error('not used'); } }));

import { invokeEdge } from '@/lib/edge';
import { previewGroupEmail, sendGroupEmail } from '../api';

const invoke = vi.mocked(invokeEdge);
const ID = '10000000-0000-4000-8000-000000000001';
const KEY = '60000000-0000-4000-8000-000000000001';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({});
});

describe('the group email calls', () => {
  it('a preview never carries a request id, so no version of the function can send it', async () => {
    await previewGroupEmail({ subject: ' Hello ', body: ' Body ', contactIds: [ID] });
    const body = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({ mode: 'preview', subject: 'Hello', body: 'Body', contact_ids: [ID] });
    expect(body).not.toHaveProperty('idempotency_key');
  });

  it('a send carries its request id and only contact ids, never an address', async () => {
    await sendGroupEmail({ subject: 'Hello', body: 'Body', contactIds: [ID] }, KEY);
    const [name, body] = invoke.mock.calls[0];
    expect(name).toBe('crm-send-group-email');
    expect(body).toEqual({ subject: 'Hello', body: 'Body', contact_ids: [ID], audience_description: '1 selected contacts', idempotency_key: KEY });
  });
});
