// @vitest-environment node
/**
 * Zero-firm-strings guard.
 *
 * This codebase was extracted from one firm's private deployment. Nothing from that
 * deployment may survive here: not its names, contact details, license numbers,
 * infrastructure ids, or the vocabulary of the domains that were left behind
 * (tax organizers, the bookkeeping ledger and its bank/payroll/shop integrations).
 *
 * Two lists, matched the same way (lowercase, split on anything that is not a-z or 0-9,
 * compare whole word sequences):
 *
 *  - IDENTITY entries are stored as salted SHA-256 hashes, so this file does not itself
 *    carry the strings it forbids. `words` is how many consecutive words the entry spans.
 *  - DOMAIN terms are public product and domain words, kept readable so a contributor can
 *    see why a line failed.
 *
 * The scan covers every file under the repo root (source, docs, config, migrations,
 * built output in dist/ when present) and every path name, skipping only dependency and
 * VCS directories and binary files.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SALT = 'workflow-denylist-v1:';

interface IdentityEntry {
  id: string;
  words: number;
  sha256: string;
}

const IDENTITY: IdentityEntry[] = [
  { id: 'owner-surname', words: 1, sha256: '1098491dc155fc7f34e59c243f2fe24a4adde1d3937f626ff43a2a434ff5fe3f' },
  { id: 'firm-domain', words: 1, sha256: '842bce5057c411ed55137a8f63377e233abf1b04cdc65589ce2dc57f32404783' },
  { id: 'social-handle', words: 1, sha256: '5c62880cf023e248586ae5674837c46391d87527347e611f230a5f6484b8fec5' },
  { id: 'phone', words: 3, sha256: 'ef17b52a5550c984985fc96cdf0ae70e5fb9b7126cc8c216ed07c8b741e01094' },
  { id: 'phone', words: 1, sha256: '4c6aef662df65b9b1c68b76f64b02012e88eb29412dd57328fba13ef0b0a1ecb' },
  { id: 'phone', words: 1, sha256: 'c4c6eccb00e1acd5dffe28aab150e986717097333649a718db63d07becf203b4' },
  { id: 'license-individual', words: 1, sha256: 'c8c8710f9933d89b71ce759c36b4c17d501459d8716d4be838bc4e7064b7ef0e' },
  { id: 'license-firm', words: 1, sha256: '220cab6e041eaa5401deb6ef0dace0cef52d026fa2cddb2eb6224b2aaff3bbd4' },
  { id: 'supabase-project-ref', words: 1, sha256: 'e691a5525254a34cfd2df0b90af75d17b9aee59fdd1e95c5c05960fe82711f45' },
  { id: 'street', words: 1, sha256: '599aced658555357f4974c06ce7e8923cdbaf65878dae8380d6d190f57a328ae' },
  { id: 'city', words: 2, sha256: '45962eafb118f16e036c6b4e15b789d6ba5dc74c8ef4822ec10e0c2258771fb7' },
  { id: 'maps-id', words: 1, sha256: '2d17e927875b8c881240d91190663663dc836fa58f9f674ec1a62d674fbcea10' },
];

/**
 * Readable: these name the domains and integrations that were deliberately left out.
 * An entry may be a phrase (`ccc one`, because a bare `ccc` is also a CSS colour).
 */
export const DOMAIN_TERMS = [
  'organizer',
  'organizers',
  'bookkeeping',
  'qbo',
  'quickbooks',
  'intuit',
  'plaid',
  'mercury',
  'gusto',
  'jobtread',
  'ccc one',
  'cpa',
];

/**
 * Per-file exceptions, by identity id or domain term. Keep this short: every entry is a
 * place the firm's identity is allowed to appear on purpose.
 * - LICENSE names the copyright holder, who is the author.
 */
const ALLOW: Record<string, string[]> = {
  LICENSE: ['owner-surname'],
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', '.temp', '.branches']);
const SELF = path.normalize('src/__tests__/zeroFirmStrings.test.ts');
const ROOT = path.resolve(__dirname, '..', '..');

const hash = (words: string[]) => createHash('sha256').update(SALT + words.join(' ')).digest('hex');

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const maxWords = Math.max(...IDENTITY.map((e) => e.words));
const byHash = new Map(IDENTITY.map((e) => [e.sha256, e]));
const domainPhrases = DOMAIN_TERMS.map((t) => tokenize(t));

/** Every identity id and domain term found in `text`, each reported once. */
export function findFirmStrings(text: string): string[] {
  const tokens = tokenize(text);
  const hits = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of domainPhrases) {
      if (phrase.every((w, k) => tokens[i + k] === w)) hits.add(phrase.join(' '));
    }
    for (let n = 1; n <= maxWords && i + n <= tokens.length; n++) {
      const entry = byHash.get(hash(tokens.slice(i, i + n)));
      if (entry && entry.words === n) hits.add(entry.id);
    }
  }
  return [...hits];
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

describe('zero firm strings', () => {
  it('the matcher finds what it is built to find', () => {
    // Guards the guard: if tokenizing or hashing drifts, every scan below passes vacuously.
    expect(findFirmStrings('Synced from QuickBooks via Plaid')).toEqual(['quickbooks', 'plaid']);
    expect(findFirmStrings('an organizer for the CPA')).toEqual(['organizer', 'cpa']);
    expect(findFirmStrings('nothing to see: pcc, accpa, organize')).toEqual([]);
    expect(findFirmStrings('border: 1px solid #ccc')).toEqual([]);
    expect(findFirmStrings('the CCC ONE export')).toEqual(['ccc one']);
    for (const e of IDENTITY) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.words).toBeGreaterThan(0);
    }
  });

  it('no file or path in the repository carries a firm string', () => {
    const files: string[] = [];
    walk(ROOT, files);
    const offenders: string[] = [];
    for (const full of files) {
      const rel = path.relative(ROOT, full);
      if (path.normalize(rel) === SELF) continue;
      const allowed = new Set(ALLOW[rel.split(path.sep).join('/')] ?? []);
      const buf = readFileSync(full);
      const found = [...findFirmStrings(rel), ...(isBinary(buf) ? [] : findFirmStrings(buf.toString('utf8')))];
      const bad = [...new Set(found)].filter((h) => !allowed.has(h));
      if (bad.length) offenders.push(`${rel}: ${bad.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
