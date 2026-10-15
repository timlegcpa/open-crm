// @vitest-environment node
// Every owner audit action the code writes by name has a label on the Audit log page, so a
// new action never shows as its raw key (or goes missing from the page's action filter). The
// scan reads every place an action is named literally:
//   - the browser: recordAudit('...') and writeAudit('...');
//   - an edge function: an audit writer called with an object, auditLog.write({ action: '...' }),
//     deps.audit({ action: '...' }) or writeAudit(deps, log, { action: '...' }); an audit
//     callback called with the action alone, audit('...'); and the connector's attemptRow,
//     refused and auditDelegated(ctx, '...');
//   - SQL: mcp_audit_row(actor, '...'), and the first action literal of an
//     INSERT INTO public.audit_logs ... VALUES (...).
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
  for (const f of files('src', /\.(ts|tsx)$/)) add(readFileSync(f, 'utf8'), /\b(?:recordAudit|writeAudit)\(\s*'([a-z][a-z0-9_.]*)'/g);
  for (const f of files('supabase/functions', /\.ts$/)) {
    const text = readFileSync(f, 'utf8');
    add(text, /\b(?:auditLog\.write|deps\.audit|writeAudit)\([^)]*?\{[^}]*?\baction:\s*'([a-z][a-z0-9_.]*)'/g);
    add(text, /\baudit\(\s*'([a-z][a-z0-9_.]*)'/g);
    add(text, /\b(?:attemptRow|refused|auditDelegated)\(\s*ctx\s*,\s*'([a-z][a-z0-9_.]*)'/g);
  }
  for (const f of files('supabase/migrations', /\.sql$/)) {
    const text = readFileSync(f, 'utf8');
    add(text, /mcp_audit_row\(\s*[a-z_]+\s*,\s*'([a-z][a-z0-9_.]*)'/g);
    // Before the details: an action passed in a variable (mcp_audit_row's own insert) is not one.
    add(text, /INSERT INTO public\.audit_logs\s*\([^)]*\)\s*VALUES\s*\((?:(?!jsonb_build_object)[^'])*'([a-z][a-z0-9_.]*)'/g);
  }
  return actions;
}

describe('audit action labels', () => {
  it('label every action the code writes by name', () => {
    const actions = written();
    // The scan finds the writers it is meant to guard.
    expect([...actions]).toEqual(expect.arrayContaining([
      'password_change', 'impersonate_start', 'org_logo_updated', 'mcp_create_contact', 'mfa_recovery_used',
      'needs_list_sent', 'needs_list_deleted', 'needs_list_files_deleted', 'esign_envelope_deleted',
      'lead_intake_key_revoked', 'mcp_remind_request',
    ]));
    expect([...actions].filter((a) => !Object.hasOwn(AUDIT_ACTION_LABELS, a)).sort()).toEqual([]);
  });

  it('every label key is a valid audit action', () => {
    for (const key of Object.keys(AUDIT_ACTION_LABELS)) expect(key).toMatch(/^[a-z][a-z0-9_.]{0,99}$/);
  });
});
