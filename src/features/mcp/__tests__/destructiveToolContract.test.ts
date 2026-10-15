// The safety contract of the connector's destructive tools, mechanized over the source.
//
// Two tools need the user's explicit go-ahead (confirmed_with_user): delete_quote, which
// destroys a row, and correct_contact_email, which moves a routing address. delete_quote
// destroys a row permanently. It is bounded by a state gate (proposed only, in
// the database), an explicit confirmed_with_user, a content binding (service and business
// re-checked against the locked row) and refusals that send the caller to the CRM. The
// behaviour is tested against the database in src/__tests__/db/mcp.test.ts; this pins the
// handler shape so a later edit that drops a guard fails here even when no behaviour test
// happens to cover that path.
//
// Parsed as an AST and printed WITHOUT comments: a comment is text, and a detector that
// reads comments goes green over a deleted guard whose explanation was left behind.
// Structural, not nominal: any tool named delete_* is held to the same rules the moment it
// exists (the request tools arrive in a later wave). The MCP annotations are pinned too, so
// an assistant is told the truth about which tools only read and which destroy.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../../../supabase/functions/mcp-crm/tools';

const SOURCE = readFileSync(path.resolve(process.cwd(), 'supabase/functions/mcp-crm/tools.ts'), 'utf8');
const parse = (text: string) => ts.createSourceFile('tools.ts', text, ts.ScriptTarget.ES2022, true);

/** The `required` list of each TOOLS entry, by tool name. */
function requiredByTool(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'TOOLS' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        let name: string | null = null;
        let required: string[] = [];
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === 'name' && ts.isStringLiteral(prop.initializer)) name = prop.initializer.text;
          if (prop.name.text === 'inputSchema' && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const sub of prop.initializer.properties) {
              if (ts.isPropertyAssignment(sub) && ts.isIdentifier(sub.name) && sub.name.text === 'required' && ts.isArrayLiteralExpression(sub.initializer)) {
                required = sub.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text);
              }
            }
          }
        }
        if (name) out[name] = required;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(parse(text));
  return out;
}

/** The body of each `if (name === '<tool>') { ... }` block in callTool, comments removed. */
function handlerBodies(text: string): Record<string, string> {
  const sf = parse(text);
  const printer = ts.createPrinter({ removeComments: true });
  const out: Record<string, string> = {};
  const walk = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const e = node.expression;
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isIdentifier(e.left) &&
        e.left.text === 'name' &&
        ts.isStringLiteral(e.right)
      ) {
        out[e.right.text] = printer.printNode(ts.EmitHint.Unspecified, node.thenStatement, sf);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

/** Remove `--` line comments from SQL, quote-aware (`--` inside a literal stays). */
function stripSqlComments(sql: string): string {
  let out = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inSingle) {
      out += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

const required = requiredByTool(SOURCE);
const bodies = handlerBodies(SOURCE);
/** The tools that act only on the user's explicit go-ahead. Every delete_* tool must be one. */
const CONFIRMED = ['correct_contact_email', 'delete_quote'];
const destructive = Object.keys(required).filter((n) => n.startsWith('delete_'));
const confirming = Object.keys(required).filter((n) => required[n].includes('confirmed_with_user'));

describe('the destructive tool contract', () => {
  it('finds every tool and the guarded ones (the parser still works)', () => {
    expect(Object.keys(required)).toHaveLength(9);
    expect(Object.keys(bodies).sort()).toEqual(Object.keys(required).sort());
    expect(destructive).toEqual(['delete_quote']);
    for (const tool of destructive) expect(CONFIRMED).toContain(tool);
  });

  it('exactly the confirmed tools require confirmed_with_user in their schema', () => {
    expect(confirming.sort()).toEqual([...CONFIRMED].sort());
  });

  it.each(CONFIRMED)('%s refuses unless confirmed_with_user is exactly true', (tool) => {
    // `!== true`, never truthiness: the string "false" is truthy.
    expect(bodies[tool]).toContain('args.confirmed_with_user !== true');
  });

  it('delete_quote binds the delete to the quote that was read back, on both axes', () => {
    expect(required.delete_quote).toEqual(['contact_id', 'quote_id', 'service_type', 'confirmed_with_user']);
    expect(bodies.delete_quote).toContain('p_service_type: args.service_type');
    expect(bodies.delete_quote).toContain('p_organization_id: organization.id');
    // Presence decides the business, never truthiness: '' must not mean "on the contact".
    expect(bodies.delete_quote).toContain('optionalId(args.organization_id, isUuid)');
  });

  it('delete_quote maps both sentinels, sends the caller to the CRM, and never echoes the error', () => {
    const body = bodies.delete_quote;
    expect(body).toContain("sentinel(error, 'mcp_delete_quote: accepted_quote')");
    expect(body).toContain("sentinel(error, 'mcp_delete_quote: not_found')");
    expect(body).toContain('in the CRM');
    expect(body).not.toMatch(/error\.message|\$\{error/);
  });

  it('delete_quote goes through the audited function, never a direct table delete', () => {
    expect(bodies.delete_quote).toContain("rpc('mcp_delete_quote'");
    expect(SOURCE).not.toMatch(/\.from\(|\.delete\(/);
  });

  it('the detectors go red when the guards are removed', () => {
    const broken = handlerBodies(
      SOURCE.replaceAll('args.confirmed_with_user !== true', 'args.confirmed_with_user === false').replace(
        "sentinel(error, 'mcp_delete_quote: accepted_quote')",
        "sentinel(error, 'nope')",
      ),
    );
    for (const tool of CONFIRMED) expect(broken[tool]).not.toContain('args.confirmed_with_user !== true');
    expect(broken.delete_quote).not.toContain("sentinel(error, 'mcp_delete_quote: accepted_quote')");
    const unrequired = SOURCE.replace(
      "required: ['contact_id', 'quote_id', 'service_type', 'confirmed_with_user']",
      "required: ['contact_id', 'quote_id', 'service_type']",
    );
    expect(unrequired).not.toBe(SOURCE);
    expect(requiredByTool(unrequired).delete_quote).not.toContain('confirmed_with_user');
  });

  it('does not accept a comment in place of the guard', () => {
    const commentOnly = SOURCE.replaceAll('args.confirmed_with_user !== true', 'false /* was: args.confirmed_with_user !== true */');
    expect(commentOnly).toContain('args.confirmed_with_user !== true');
    for (const tool of CONFIRMED) expect(handlerBodies(commentOnly)[tool]).not.toContain('args.confirmed_with_user !== true');
  });
});

describe('the tool annotations', () => {
  type Hints = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  const hints = Object.fromEntries(TOOLS.map((t) => [t.name, (t as { annotations?: Hints }).annotations]));

  it('every tool carries annotations and says it is closed-world', () => {
    for (const t of TOOLS) expect([t.name, hints[t.name]?.openWorldHint]).toEqual([t.name, false]);
  });

  it('only the two reads are read-only', () => {
    expect(TOOLS.filter((t) => hints[t.name]?.readOnlyHint === true).map((t) => t.name).sort()).toEqual(['get_contact', 'search_contacts']);
  });

  it('every write states destructiveHint, since the protocol presumes true when it is absent', () => {
    for (const t of TOOLS) {
      if (hints[t.name]?.readOnlyHint) continue;
      expect([t.name, typeof hints[t.name]?.destructiveHint]).toEqual([t.name, 'boolean']);
    }
  });

  it('every confirmed and every delete_* tool is marked destructive; the append-only writes are not', () => {
    for (const tool of [...CONFIRMED, ...destructive]) expect([tool, hints[tool]?.destructiveHint]).toEqual([tool, true]);
    for (const tool of ['create_contact', 'add_business', 'log_call_note']) expect([tool, hints[tool]?.destructiveHint]).toEqual([tool, false]);
  });
});

describe('the deletable window mcp_delete_quote assumes', () => {
  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const migration = (name: string) => stripSqlComments(readFileSync(path.join(dir, name), 'utf8'));

  it('contact_services.state still carries exactly proposed and accepted', () => {
    // The function refuses on state = 'accepted'. That equals "proposed only" ONLY while the
    // column is two-valued: a third state would silently become deletable.
    const hits = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => /contact_services/.test(migration(f)) && /CHECK \(state IN \(/.test(migration(f)));
    expect(hits.length, 'no migration defines the contact_services state CHECK').toBeGreaterThan(0);
    const m = /CHECK \(state IN \(([^)]*)\)\)/.exec(migration(hits[hits.length - 1]));
    expect([...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()).toEqual(['accepted', 'proposed']);
  });

  it('the delete function refuses an accepted row and binds contact, service and business with IS DISTINCT FROM', () => {
    const sql = migration('0007_mcp.sql');
    const fn = sql.slice(sql.indexOf('FUNCTION public.mcp_delete_quote('), sql.indexOf('$$;', sql.indexOf('FUNCTION public.mcp_delete_quote(')));
    expect(fn).toContain("v_row.state = 'accepted'");
    for (const col of ['contact_id', 'service_type', 'organization_id']) expect(fn).toMatch(new RegExp(`${col} IS DISTINCT FROM`));
  });
});
