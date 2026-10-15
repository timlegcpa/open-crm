import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECIPIENT_STATUSES } from '../api';
import { RECIPIENT_STATUS, recipientStatus } from '../status';

/** The recipient status CHECK, read from the migration that ships. */
function checkedStatuses(): string[] {
  const sql = readFileSync('supabase/migrations/0010_email.sql', 'utf8');
  const match = /status text NOT NULL DEFAULT 'queued'\s+CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
  if (!match) throw new Error('recipient status CHECK not found in 0010_email.sql');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('recipient statuses', () => {
  it('the labels, the zod enum and the database CHECK name the same states', () => {
    const db = checkedStatuses().sort();
    expect(db.length).toBeGreaterThan(0);
    expect(Object.keys(RECIPIENT_STATUS).sort()).toEqual(db);
    expect([...RECIPIENT_STATUSES].sort()).toEqual(db);
  });

  it('unconfirmed is a warning, never the failure colour', () => {
    expect(recipientStatus('unknown')).toEqual({ label: 'Unconfirmed', dot: 'bg-warning' });
    expect(recipientStatus('failed').dot).toBe('bg-destructive');
  });

  it('an unexpected value still renders', () => {
    expect(recipientStatus('mystery').label).toBe('mystery');
  });
});
