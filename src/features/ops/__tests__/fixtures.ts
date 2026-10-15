/** Rows shaped as the System pages read them. */
export const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function job(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    provider: 'portal',
    action: 'daily_digest',
    payload: {},
    status: 'success',
    attempts: 1,
    max_attempts: 5,
    scheduled_at: '2026-10-14T12:30:00Z',
    started_at: '2026-10-14T12:30:05Z',
    finished_at: '2026-10-14T12:30:09Z',
    claimed_until: null,
    last_error: null,
    result: { sent: 1 },
    created_at: '2026-10-14T12:30:00Z',
    updated_at: '2026-10-14T12:30:09Z',
    ...extra,
  };
}
