// @vitest-environment node
// Every edge function has the same shape, checked on disk, so functions built side by
// side stay uniform:
//   1. handler.ts (pure TypeScript, run by vitest) builds on createHandler from
//      _shared/handler.ts and never touches the Deno global; index.ts wires Deno and
//      supabase-js and calls Deno.serve once.
//   2. Nothing logs through console except _shared/log.ts: createLogger keeps error
//      details, names and contact data out of the function logs; a raw console.error of
//      an error object is how a failing row's values reach them.
//   3. The function's deno.json maps every bare import it uses. Supabase bundles each
//      function with its own deno.json, while `npm run deno:check` runs from the repo
//      root and never reads it, so a missing entry would only fail at deploy.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'supabase/functions';
const functions = readdirSync(ROOT)
  .filter((name) => !name.startsWith('_') && statSync(join(ROOT, name)).isDirectory())
  .sort();
const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
/** Code with comments removed (a '//' after ':' is a URL, not a comment). */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
/** Module specifiers: `from '...'`, `import '...'` and `import('...')`, not a query's `.from('table')`. */
const specifiers = (path: string) =>
  [...code(path).matchAll(/(?<!\.)\b(?:from|import)\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map((m) => m[1] ?? m[2]);

describe('edge function layout', () => {
  it('finds the functions', () => {
    expect(functions).toContain('delete-contact');
  });

  it.each(functions)('%s: handler.ts builds on createHandler and stays free of Deno', (name) => {
    const dir = join(ROOT, name);
    for (const file of ['handler.ts', 'index.ts', 'deno.json']) expect([name, existsSync(join(dir, file))]).toEqual([name, true]);
    const handler = code(join(dir, 'handler.ts'));
    expect(specifiers(join(dir, 'handler.ts'))).toContain('../_shared/handler.ts');
    expect(handler).toMatch(/\bcreateHandler\s*[(<]/);
    expect(handler).not.toMatch(/\bDeno\./);
    expect(code(join(dir, 'index.ts')).match(/\bDeno\.serve\s*\(/g)).toHaveLength(1);
  });

  it.each(functions)('%s: deno.json maps every bare import the function uses', (name) => {
    const dir = join(ROOT, name);
    const mapped = Object.keys((JSON.parse(readFileSync(join(dir, 'deno.json'), 'utf8')) as { imports?: object }).imports ?? {});
    const bare = tsFiles(dir)
      .flatMap(specifiers)
      .filter((s) => !s.startsWith('.') && !/^(npm|jsr|node|https?):/.test(s));
    for (const spec of new Set(bare)) expect([name, spec, mapped.includes(spec)]).toEqual([name, spec, true]);
  });

  it('logs through createLogger: no console call outside _shared/log.ts', () => {
    const offenders = tsFiles(ROOT)
      .filter((path) => path.replace(/\\/g, '/') !== `${ROOT}/_shared/log.ts`)
      .filter((path) => /\bconsole\s*\.\s*[a-z]+\s*\(/.test(code(path)));
    expect(offenders).toEqual([]);
  });
});
