// No em dashes in the connector's model-facing and browser-facing copy. Tool descriptions,
// tool results, OAuth error descriptions and the refusal page are all read by a model or a
// person. Comments are not copy, so this walks the AST and checks string literals only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILES = [
  'supabase/functions/mcp-crm/tools.ts',
  'supabase/functions/mcp-crm/handler.ts',
  'supabase/functions/mcp-crm/validation.ts',
  'supabase/functions/mcp-oauth/handler.ts',
];

function emDashLiterals(src: string): string[] {
  const sf = ts.createSourceFile('copy.ts', src, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const record = (text: string) => {
    if (text.includes('—')) hits.push(text.slice(0, 80));
  };
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node.text);
    if (ts.isTemplateExpression(node)) {
      record(node.head.text);
      for (const span of node.templateSpans) record(span.literal.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return hits;
}

describe('connector copy rules', () => {
  it.each(FILES)('%s has no em dash in any string literal', (file) => {
    const hits = emDashLiterals(readFileSync(path.resolve(process.cwd(), file), 'utf8'));
    expect(hits).toEqual([]);
  });

  it('the detector sees an em dash in a literal and ignores one in a comment', () => {
    expect(emDashLiterals('const x = "a — b";')).toHaveLength(1);
    expect(emDashLiterals('const x = `a — ${y} — b`;')).toHaveLength(2);
    expect(emDashLiterals('// a — comment is fine\nconst x = 1;')).toHaveLength(0);
  });
});
