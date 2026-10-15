// @vitest-environment node
// Every owner audit action the code writes by name has a label on the Audit log page, so a
// new action never shows as its raw key. The scan reads the three places an action is named
// literally: the browser's recordAudit('...'), an edge function's auditLog.write({ action:
// '...' }), and the connector's mcp_audit_row(actor, '...') in SQL.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_LABELS } from '../labels';

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(full, ext);
    return ext.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function written(): Set<string> {
  const actions = new Set<string>();
  const add = (text: string, re: RegExp) => {
    for (const m of text.matchAll(re)) actions.add(m[1]);
  };
  for (const f of files('src', /\.(ts|tsx)$/)) add(readFileSync(f, 'utf8'), /\brecordAudit\(\s*'([a-z][a-z0-9_.]*)'/g);
  for (const f of files('supabase/functions', /\.ts$/)) add(readFileSync(f, 'utf8'), /auditLog\.write\(\{[^}]*\baction:\s*'([a-z][a-z0-9_.]*)'/g);
  for (const f of files('supabase/migrations', /\.sql$/)) add(readFileSync(f, 'utf8'), /mcp_audit_row\(\s*[a-z_]+\s*,\s*'([a-z][a-z0-9_.]*)'/g);
  return actions;
}

describe('audit action labels', () => {
  it('label every action the code writes by name', () => {
    const actions = written();
    // The scan finds the writers it is meant to guard.
    expect([...actions]).toEqual(expect.arrayContaining(['password_change', 'impersonate_start', 'org_logo_updated', 'mcp_create_contact']));
    expect([...actions].filter((a) => !Object.hasOwn(AUDIT_ACTION_LABELS, a)).sort()).toEqual([]);
  });

  it('every label key is a valid audit action', () => {
    for (const key of Object.keys(AUDIT_ACTION_LABELS)) expect(key).toMatch(/^[a-z][a-z0-9_.]{0,99}$/);
  });
});
