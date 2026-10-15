// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PIPELINE_STATUSES,
  CLIENT_LIKE_STATUSES,
  EMAILABLE_STATUSES,
  LEAD_LIKE_STATUSES,
  PIPELINE_STATUSES,
  SELECTABLE_STATUSES,
  STORED_STATUSES,
  SYSTEM_STATUSES,
  TERMINAL_STATUSES,
  WON_STATUSES,
  isActivePipelineStatus,
  isClientLike,
  isEmailableStatus,
  isTerminalStatus,
  isWonStatus,
} from '@/lib/contactStatus';

const MIGRATION = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', '0002_contacts.sql');

/** The `contact_statuses` seed's keys, ordered by sort_order. Throws if the seed cannot be found. */
function seededStatusKeys(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('INSERT INTO public.contact_statuses');
  if (start < 0) throw new Error('no contact_statuses seed in 0002_contacts.sql');
  const statement = sql.slice(start, sql.indexOf(';', start));
  const rows = [...statement.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*\)/g)].map((m) => ({
    key: m[1],
    order: Number(m[2]),
  }));
  if (rows.length === 0) throw new Error('the contact_statuses seed parsed to no rows');
  return rows.sort((a, b) => a.order - b.order).map((r) => r.key);
}

const sorted = (list: readonly string[]) => [...list].sort();

describe('contact-status taxonomy', () => {
  it('STORED is exactly the seeded contact_statuses keys, in seed order', () => {
    expect([...STORED_STATUSES]).toEqual(seededStatusKeys());
  });

  it('STORED is SELECTABLE and SYSTEM, which do not overlap', () => {
    expect(sorted([...SELECTABLE_STATUSES, ...SYSTEM_STATUSES])).toEqual(sorted(STORED_STATUSES));
    expect(SELECTABLE_STATUSES.filter((s) => (SYSTEM_STATUSES as readonly string[]).includes(s))).toEqual([]);
    expect([...SYSTEM_STATUSES]).toEqual(['esign_signer']);
  });

  it('every set is a subset of STORED', () => {
    const stored = new Set<string>(STORED_STATUSES);
    for (const set of [LEAD_LIKE_STATUSES, PIPELINE_STATUSES, CLIENT_LIKE_STATUSES, ACTIVE_PIPELINE_STATUSES, EMAILABLE_STATUSES, TERMINAL_STATUSES, WON_STATUSES]) {
      expect(set.filter((s) => !stored.has(s))).toEqual([]);
    }
  });

  it('no system status is emailable or active pipeline', () => {
    for (const s of SYSTEM_STATUSES) {
      expect(isEmailableStatus(s)).toBe(false);
      expect(isActivePipelineStatus(s)).toBe(false);
    }
  });

  it('terminal is lost, cold and former client, and none of them is active pipeline', () => {
    expect(sorted(TERMINAL_STATUSES)).toEqual(['cold', 'former_client', 'lost']);
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminalStatus(s)).toBe(true);
      expect(isActivePipelineStatus(s)).toBe(false);
    }
    expect(isTerminalStatus('client')).toBe(false);
  });

  it('the pipeline board shows cold; the active rollups do not', () => {
    expect([...PIPELINE_STATUSES]).toEqual(['new_lead', 'active_lead', 'hot', 'warm', 'cold']);
    expect(sorted(ACTIVE_PIPELINE_STATUSES)).toEqual(sorted([...LEAD_LIKE_STATUSES, 'client', 'one_time']));
  });

  it('a lost lead is never mailed; a client who left still is', () => {
    expect(isEmailableStatus('lost')).toBe(false);
    expect(isEmailableStatus('former_client')).toBe(true);
    expect(isEmailableStatus('cold')).toBe(true);
  });

  it('client-like is client and one-time', () => {
    expect(isClientLike('client')).toBe(true);
    expect(isClientLike('one_time')).toBe(true);
    expect(isClientLike('former_client')).toBe(false);
  });

  it('won is client-like plus a client who left, and never a lead that did not pay', () => {
    expect(sorted(WON_STATUSES)).toEqual(sorted([...CLIENT_LIKE_STATUSES, 'former_client']));
    for (const s of STORED_STATUSES) expect([s, isWonStatus(s)]).toEqual([s, (WON_STATUSES as readonly string[]).includes(s)]);
    for (const s of ['lost', 'cold', ...LEAD_LIKE_STATUSES, ...SYSTEM_STATUSES]) expect([s, isWonStatus(s)]).toEqual([s, false]);
  });
});
