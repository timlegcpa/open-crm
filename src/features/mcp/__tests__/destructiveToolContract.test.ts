// The safety contract of the connector's destructive tools, mechanized over the source.
//
// Ten tools need the user's explicit go-ahead (confirmed_with_user): delete_quote,
// delete_request and delete_note, which destroy a row; accept_quote, which turns a proposal
// into live work; correct_contact_email and change_portal_email, which move a routing or
// sign-in address; send_request and remind_request, which email a client and cannot be
// recalled; and close_request and accept_request, which change what the client sees and can
// do. The three request tools also need a review token, checked against the request
// as it stands, and the two outward ones spend the one client email an HTTP request
// allows, before they act. delete_quote destroys a row permanently. It is bounded by a state gate (proposed only, in
// the database), an explicit confirmed_with_user, a content binding (service and business
// re-checked against the locked row) and refusals that send the caller to the CRM. The
// behaviour is tested against the database in src/__tests__/db/mcp.test.ts; this pins the
// handler shape so a later edit that drops a guard fails here even when no behaviour test
// happens to cover that path.
//
// Parsed as an AST and printed WITHOUT comments: a comment is text, and a detector that
// reads comments goes green over a deleted guard whose explanation was left behind.
// Structural, not nominal: any tool named delete_* is held to the same rules the moment it
// exists. The MCP annotations are pinned too, so
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
const CONFIRMED = [
  'accept_quote', 'accept_request', 'change_portal_email', 'close_request', 'correct_contact_email', 'delete_note', 'delete_quote',
  'delete_request', 'remind_request', 'send_request',
];
/** The tools that email a client. Each spends the per-request send budget. */
const OUTWARD = ['remind_request', 'send_request'];
/** The tools that act on a request someone read: each takes and verifies a review token. */
const REVIEWED = ['delete_request', 'remind_request', 'send_request', 'update_request'];
/** The tools that record every refusal (through one `refuse` bound to their own action). */
const REFUSING = ['delete_request', 'remind_request', 'send_request'];
/** The body with its leading `const refuse = ...;` binding removed: what runs first. */
const afterRefuse = (body: string) => body.replace(/^\{\s*/, '').replace(/^const refuse = [^\n]*\n\s*/, '');
const destructive = Object.keys(required).filter((n) => n.startsWith('delete_'));
const confirming = Object.keys(required).filter((n) => required[n].includes('confirmed_with_user'));

describe('the destructive tool contract', () => {
  it('finds every tool and the guarded ones (the parser still works)', () => {
    expect(Object.keys(required)).toHaveLength(32);
    expect(Object.keys(bodies).sort()).toEqual(Object.keys(required).sort());
    expect(destructive.sort()).toEqual(['delete_note', 'delete_quote', 'delete_request']);
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

  it('accept_quote binds the accept to the quote that was read back, as delete_quote does, mapping every sentinel', () => {
    expect(required.accept_quote).toEqual(['contact_id', 'quote_id', 'service_type', 'confirmed_with_user']);
    const body = bodies.accept_quote;
    expect(body).toContain('p_service_type: args.service_type');
    expect(body).toContain('p_organization_id: organization.id');
    expect(body).toContain('optionalId(args.organization_id, isUuid)');
    expect(body.indexOf('args.confirmed_with_user !== true')).toBeLessThan(body.indexOf("rpc('mcp_accept_quote'"));
    for (const code of ['already_accepted', 'system_status', 'archived', 'not_found']) {
      expect(body).toContain(`sentinel(error, 'mcp_accept_quote: ${code}')`);
    }
    expect(body).not.toMatch(/error\.message|\$\{error/);
  });

  it('change_portal_email moves Auth before the record, only after the go-ahead and the compare-and-swap check', () => {
    expect(required.change_portal_email).toEqual(['portal_account_id', 'new_email', 'expected_current_email', 'confirmed_with_user']);
    const body = bodies.change_portal_email;
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('args.confirmed_with_user !== true')).toBeLessThan(at("ctx.db.rpc('portal_login_for_change'"));
    expect(at("ctx.db.rpc('portal_login_for_change'")).toBeLessThan(at('ctx.privileged.setSignInEmail('));
    expect(at('ctx.privileged.setSignInEmail(')).toBeLessThan(at("rpc('mcp_change_portal_email'"));
    // A half-done change is recorded and said, never reported as a clean refusal.
    expect(body).toContain("auditDelegated(ctx, 'mcp_change_portal_email_partial'");
    expect(body).toContain('normalizeEmail(args.new_email)');
  });

  it('the note tools write through their audited functions, and update_note never sends a source', () => {
    expect(bodies.update_note).toContain("rpc('mcp_update_note'");
    expect(bodies.delete_note).toContain("rpc('mcp_delete_note'");
    expect(bodies.update_note).not.toMatch(/source/);
  });

  it('delete_quote goes through the audited function, never a direct table delete', () => {
    expect(bodies.delete_quote).toContain("rpc('mcp_delete_quote'");
    expect(SOURCE).not.toMatch(/\.from\(|\.delete\(/);
  });

  it.each(REVIEWED)('%s requires a review token and verifies it against the request as stored', (tool) => {
    expect(required[tool]).toEqual(
      tool === 'update_request' ? ['list_id', 'contact_id', 'review_token', 'title', 'items'] : ['list_id', 'contact_id', 'review_token', 'confirmed_with_user'],
    );
    const body = bodies[tool];
    expect(body).toContain('reviewToken(args.review_token)');
    expect(body).toContain('readRequest(ctx, args.contact_id, args.list_id)');
    expect(body).toContain('ctx.review.verify(token.token, list.id, canonicalRequest(list, contact))');
  });

  it.each(OUTWARD)('%s checks the send budget first, and spends it after verifying and before sending', (tool) => {
    const body = bodies[tool];
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    // First statement of the block: nothing is read or checked before the budget.
    expect(afterRefuse(body).startsWith('if (ctx.budget.sends >= MAX_SENDS_PER_REQUEST)')).toBe(true);
    expect(at('ctx.review.verify(')).toBeLessThan(at('ctx.budget.sends++'));
    expect(at('args.confirmed_with_user !== true')).toBeLessThan(at('ctx.budget.sends++'));
    expect(at('ctx.budget.sends++')).toBeLessThan(at(`ctx.outward.${tool === 'send_request' ? 'send' : 'remind'}(`));
    // The attempt row is written, and checked, before anything goes out.
    expect(at(`if (!(await attemptRow(ctx, 'mcp_${tool}'`)).toBeLessThan(at(`ctx.outward.${tool === 'send_request' ? 'send' : 'remind'}(`));
  });

  it.each(REFUSING)('%s records its refusals under its own action, never returning a bare tool error', (tool) => {
    const body = bodies[tool];
    expect(afterRefuse(body)).not.toBe(body.replace(/^\{\s*/, ''));
    expect(body).toContain(`refused(ctx, 'mcp_${tool}', reason, args, message)`);
    // Every early exit goes through refuse; only the outcomes after an attempt are bare errors.
    const beforeAct = body.slice(0, body.indexOf(tool === 'delete_request' ? "auditedRpc(ctx, 'mcp_delete_request'" : 'ctx.budget.sends++;'));
    expect(beforeAct.replace(/^\{\s*/, '')).not.toMatch(/return toolError\(/);
  });

  it('remind_request hands its claim back on every exit after the claim but a reminder that went out', () => {
    const body = bodies.remind_request;
    const afterClaim = body.slice(body.indexOf("if (claim?.claimed !== true)"));
    // The attempt-row failure, a throw and a non-reminded outcome.
    expect(afterClaim.match(/await releaseClaim\(ctx, list\.id, claim\)/g)).toHaveLength(3);
    expect(afterClaim.slice(afterClaim.indexOf("if (reminded.status !== 'reminded')"))).toMatch(/^if \(reminded\.status !== 'reminded'\) \{\s*await releaseClaim/);
  });

  it('update_request rewrites at the verified version only', () => {
    const body = bodies.update_request;
    expect(body.indexOf('ctx.review.verify(')).toBeLessThan(body.indexOf("auditedRpc(ctx, 'mcp_update_request'"));
    expect(body).toContain('p_expected_version: list.content_version');
    expect(body).toContain("sentinel(error, 'mcp_update_request: changed')");
  });

  it('the outward tools pass the reviewed version and address on, and record every outcome', () => {
    expect(bodies.send_request).toContain('version: list.content_version, email: contact.email');
    expect(bodies.remind_request).toContain('version: list.content_version, email: contact.email');
    expect(bodies.remind_request).toContain("ctx.db.rpc('mcp_claim_reminder'");
    for (const tool of OUTWARD) expect(bodies[tool]).toContain(`auditDelegated(ctx, 'mcp_${tool}'`);
  });

  it.each(['close_request', 'accept_request'])('%s checks the go-ahead before it touches the database, and acts through its audited function', (tool) => {
    const body = bodies[tool];
    expect(body.indexOf('args.confirmed_with_user !== true')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('args.confirmed_with_user !== true')).toBeLessThan(body.indexOf(`auditedRpc(ctx, 'mcp_${tool}'`));
    expect(body).toContain('p_contact_id: args.contact_id');
    expect(body).not.toMatch(/error\.message|\$\{error/);
  });

  it('the moves are compare-and-swapped on what the caller read', () => {
    expect(required.set_contact_status).toEqual(['contact_id', 'status', 'expected_status']);
    expect(bodies.set_contact_status).toContain('p_expected_status: args.expected_status');
    expect(required.move_work_item).toEqual(['work_item_id', 'to_stage', 'expected_stage', 'reason']);
    expect(bodies.move_work_item).toContain('p_expected_stage: args.expected_stage');
  });

  it('delete_request deletes through the audited function at the verified version, mapping every sentinel without echoing', () => {
    const body = bodies.delete_request;
    expect(body.indexOf('ctx.review.verify(')).toBeLessThan(body.indexOf("auditedRpc(ctx, 'mcp_delete_request'"));
    expect(body).toContain('p_expected_version: list.content_version');
    for (const code of ['not_found', 'not_draft', 'stale_content', 'has_answers', 'has_documents']) {
      expect(body).toContain(`exactSentinel(error, '${code}')`);
    }
    expect(body).not.toMatch(/error\.message|\$\{error/);
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
    // The budget moved after the send: the ordering check reads the moved statement.
    const late = handlerBodies(SOURCE.replace(
      'if (ctx.budget.sends >= MAX_SENDS_PER_REQUEST) {',
      'if (false) {',
    ));
    expect(afterRefuse(late.send_request).startsWith('if (ctx.budget.sends >= MAX_SENDS_PER_REQUEST)')).toBe(false);
    // replaceAll: accept_quote shares delete_quote's required list, so a single replace
    // could strip one and leave the other.
    const unrequired = SOURCE.replaceAll(
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

  it('only the eight reads are read-only', () => {
    expect(TOOLS.filter((t) => hints[t.name]?.readOnlyHint === true).map((t) => t.name).sort()).toEqual([
      'get_contact', 'list_board', 'list_documents', 'list_open_requests', 'list_requests', 'read_document_text',
      'read_request_answers', 'search_contacts',
    ]);
  });

  it('every write states destructiveHint, since the protocol presumes true when it is absent', () => {
    for (const t of TOOLS) {
      if (hints[t.name]?.readOnlyHint) continue;
      expect([t.name, typeof hints[t.name]?.destructiveHint]).toEqual([t.name, 'boolean']);
    }
  });

  it('every confirmed and every delete_* tool is marked destructive; the append-only writes are not', () => {
    for (const tool of [...CONFIRMED, ...destructive]) expect([tool, hints[tool]?.destructiveHint]).toEqual([tool, true]);
    for (const tool of ['create_contact', 'add_business', 'log_call_note', 'create_request', 'create_work_item', 'add_work_item_note']) {
      expect([tool, hints[tool]?.destructiveHint]).toEqual([tool, false]);
    }
    // A full replacement removes what it is not sent.
    expect(hints.update_request?.destructiveHint).toBe(true);
  });

  it('an email to a client is never marked idempotent: a retry is a second email', () => {
    for (const tool of OUTWARD) expect([tool, hints[tool]?.idempotentHint]).toEqual([tool, false]);
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
