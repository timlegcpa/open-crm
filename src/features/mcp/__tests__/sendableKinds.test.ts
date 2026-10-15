// Every item kind a request can hold must be one the connector may compose and send. The
// outward tools refuse a request holding an unsendable kind, so a kind added to the table
// without a decision here would silently make such requests unsendable from the connector
// (or, the other way round, sendable without anyone deciding a read-back conveys it).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_SENDABLE_KINDS, REQUEST_ITEM_KINDS } from '../../../../supabase/functions/mcp-crm/validation';

/** needs_items.kind's CHECK list, read from the migration with comments removed. */
function tableKinds(): string[] {
  const sql = readFileSync(path.resolve(process.cwd(), 'supabase/migrations/0005_requests.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const table = sql.slice(sql.indexOf('CREATE TABLE public.needs_items'));
  const m = /kind text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(table);
  expect(m, 'needs_items.kind CHECK not found').not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('request item kinds', () => {
  it('the table, the composer and the sendable set agree', () => {
    const kinds = tableKinds();
    expect(kinds.length).toBeGreaterThan(0);
    expect([...REQUEST_ITEM_KINDS].sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(MCP_SENDABLE_KINDS).toContain(kind);
  });
});
