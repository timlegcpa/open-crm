// @vitest-environment node
// The screens against the functions they call, read from the source on both sides:
//   * every function the feature names exists as a deployable function;
//   * every error code a screen branches on is one some e-sign function (or the shared
//     handler) actually answers with, read at runtime from each handler's *_ERRORS list.
// typecheck already refuses a code outside EsignErrorCode in hasErrorCode(); this test
// also catches a code compared by hand, and a handler list that stopped naming a code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUSALS } from '../../../../supabase/functions/_shared/handler';
import { FN } from '../contract';

const ROOT = resolve(__dirname, '../../../..');
const FEATURE = resolve(__dirname, '..');
const FUNCTIONS = join(ROOT, 'supabase/functions');

/** The feature's own source files (tests excluded). */
function sources(dir = FEATURE, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'fonts') sources(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const deployable = (name: string) => existsSync(join(FUNCTIONS, name, 'handler.ts')) && existsSync(join(FUNCTIONS, name, 'index.ts'));

describe('the functions the screens call', () => {
  it('every FN entry is a function on disk', () => {
    const missing = Object.values(FN).filter((name) => !deployable(name));
    expect(missing).toEqual([]);
  });

  it('every call site names its function through FN (so the check above covers it)', () => {
    const calls: Array<{ file: string; target: string }> = [];
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(?:invokeEdge|invokePublicEdge|publicEdgeFetch|functions\.invoke)(?:<[^>()]*>)?\(\s*([^,)\s]+)/g)) {
        calls.push({ file: relative(ROOT, file), target: m[1] });
      }
    }
    // The scan finds the calls it is meant to guard (owner, portal and public).
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(FN).length);
    const keys = new Set(Object.keys(FN));
    expect(calls.filter((c) => !/^FN\.\w+$/.test(c.target) || !keys.has(c.target.slice(3)))).toEqual([]);
  });
});

describe('the error codes the screens branch on', () => {
  /** Every code an e-sign function can answer with: its *_ERRORS lists, plus the shared refusals. */
  async function serverCodes(): Promise<Set<string>> {
    const codes = new Set<string>(Object.values(REFUSALS).map((r) => r.code));
    const dirs = readdirSync(FUNCTIONS).filter((d) => d.startsWith('esign-') && existsSync(join(FUNCTIONS, d, 'handler.ts')));
    for (const dir of dirs) {
      const mod = (await import(`../../../../supabase/functions/${dir}/handler.ts`)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(mod)) {
        if (key.endsWith('_ERRORS') && Array.isArray(value)) for (const code of value) codes.add(String(code));
      }
    }
    return codes;
  }

  /** Codes named in a hasErrorCode(...) call or compared to `.code` by hand. */
  function uiCodes(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/hasErrorCode\(\s*[^,()]+,\s*'([a-z0-9_]+)'\s*\)|\.code\s*===\s*'([a-z0-9_]+)'/g)) {
        found.set(m[1] ?? m[2], relative(ROOT, file));
      }
    }
    return found;
  }

  it('each is answered by some function', async () => {
    const known = await serverCodes();
    const used = uiCodes();
    // The scan finds the branches it is meant to guard.
    expect([...used.keys()]).toEqual(expect.arrayContaining(['requires_force', 'impersonation_read_only', 'wrong_addressee', 'invalid_code', 'no_address']));
    expect([...used].filter(([code]) => !known.has(code))).toEqual([]);
  });

  it('every handler that refuses with a code lists it (the lists are what the screens trust)', async () => {
    const known = await serverCodes();
    const thrown = new Map<string, string>();
    const dirs = readdirSync(FUNCTIONS).filter((d) => d.startsWith('esign-'));
    const files = dirs.flatMap((d) => {
      const lib = join(FUNCTIONS, d, 'lib');
      const libFiles = existsSync(lib) ? readdirSync(lib).map((f) => join(lib, f)) : [];
      return [join(FUNCTIONS, d, 'handler.ts'), ...libFiles].filter(existsSync);
    });
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/new HttpError\(\s*\d{3},[\s\S]*?,\s*'([a-z0-9_]+)'\s*\)/g)) thrown.set(m[1], relative(ROOT, file));
    }
    expect(thrown.size).toBeGreaterThan(10);
    expect([...thrown].filter(([code]) => !known.has(code))).toEqual([]);
  });

  it('every code a handler lists is one something can actually send (a shared refusal, or named outside the list)', () => {
    const refusals = new Set<string>(Object.values(REFUSALS).map((r) => r.code));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) files.push(full);
      }
    };
    for (const d of readdirSync(FUNCTIONS)) if (d.startsWith('esign-') || d === '_shared') walk(join(FUNCTIONS, d));
    // Every source line except the *_ERRORS lists themselves.
    const elsewhere = files
      .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/))
      .filter((line) => !/_ERRORS\s*=\s*\[/.test(line))
      .join('\n');
    const listed = new Set<string>();
    for (const file of files.filter((f) => f.endsWith('handler.ts'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/_ERRORS\s*=\s*\[([^\]]*)\]/g)) {
        for (const c of m[1].matchAll(/'([a-z0-9_]+)'/g)) listed.add(c[1]);
      }
    }
    expect(listed.size).toBeGreaterThan(20);
    expect([...listed].filter((code) => !refusals.has(code) && !elsewhere.includes(`'${code}'`))).toEqual([]);
  });
});
