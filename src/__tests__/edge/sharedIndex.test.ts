// @vitest-environment node
// The shared layer's two structural rules, checked on disk:
//   1. every module is re-exported from _shared/index.ts, which is the file
//      `npm run deno:check` reaches (it checks supabase/functions/**/index.ts), so a
//      module missing from it would never be type-checked under Deno;
//   2. a module is plain TypeScript: no Deno global and no package or URL imports, only
//      relative './x.ts' imports. Clients and environment come in as arguments, which
//      is what lets vitest run every module as-is.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/functions/_shared';
const modules = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .sort();
const source = (file: string) => readFileSync(join(DIR, file), 'utf8');
/** Code with comments removed (a '//' after ':' is a URL, not a comment). */
const code = (file: string) => source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
/** Module specifiers: `from '...'`, `import '...'` and `import('...')`, not a query's `.from('table')`. */
const specifiers = (file: string) =>
  [...code(file).matchAll(/(?<!\.)\b(?:from|import)\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map((m) => m[1] ?? m[2]);

describe('_shared', () => {
  it('has the modules this layer promises', () => {
    expect(modules).toEqual(
      expect.arrayContaining([
        'audit.ts',
        'auth.ts',
        'config.ts',
        'crypto.ts',
        'email-layout.ts',
        'handler.ts',
        'http.ts',
        'log.ts',
        'magic-bytes.ts',
        'organization.ts',
        'outbound.ts',
        'paging.ts',
        'rate-limit.ts',
        'secrets.ts',
      ]),
    );
  });

  it('re-exports every module from index.ts, so deno:check covers it', () => {
    const exported = specifiers('index.ts').sort();
    expect(exported).toEqual(modules.map((m) => `./${m}`));
  });

  it.each(modules)('%s is plain TypeScript: no Deno global, only relative .ts imports', (file) => {
    expect(code(file)).not.toMatch(/\bDeno\./);
    for (const spec of specifiers(file)) expect([file, spec]).toEqual([file, expect.stringMatching(/^\.\/[a-z0-9-]+\.ts$/)]);
  });
});
