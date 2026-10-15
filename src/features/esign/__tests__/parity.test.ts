import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../contract';
import { EVENT_LABELS, summarizeEvent } from '../lib/eventLabels';
import { SIGNATURE_FONTS } from '../lib/signatureFonts';
import { SIGNATURE_TEXT_CHARS, SIGNATURE_TEXT_MAX, signatureTextProblem } from '../lib/signatureText';

const ROOT = resolve(__dirname, '../../../..');
const FEATURE = resolve(__dirname, '..');
const TTF_DIR = join(ROOT, 'supabase/functions/_shared/esign-fonts/fonts');
const FONT_DIR = join(FEATURE, 'fonts');

interface Font {
  hasGlyphForCodePoint(cp: number): boolean;
}
const fontkit = ((fontkitModule as unknown as { default?: unknown }).default ?? fontkitModule) as { create(b: Buffer): Font };

describe('signature fonts: one list, three places', () => {
  const css = readFileSync(join(FONT_DIR, 'signatureFonts.css'), 'utf8');
  const faces = [...css.matchAll(/font-family:\s*'([^']+)';\s*src:\s*url\('\.\/([^']+)'\)/g)].map((m) => ({ family: m[1], file: m[2] }));

  it('has six fonts with unique keys', () => {
    expect(SIGNATURE_FONTS).toHaveLength(6);
    expect(new Set(SIGNATURE_FONTS.map((f) => f.key)).size).toBe(6);
  });

  it('each font has an @font-face of the same family over its own woff2, and nothing else does', () => {
    expect(faces.map((f) => `${f.family}|${f.file}`).sort()).toEqual(
      SIGNATURE_FONTS.map((f) => `${/'([^']+)'/.exec(f.family)?.[1]}|${f.woff2}`).sort(),
    );
  });

  it('every woff2 and every server TTF is on disk, with a licence beside it', () => {
    const local = readdirSync(FONT_DIR);
    for (const f of SIGNATURE_FONTS) {
      expect(local).toContain(f.woff2);
      expect(existsSync(join(TTF_DIR, f.ttf))).toBe(true);
    }
    expect(local.filter((n) => n.endsWith('.woff2'))).toHaveLength(6);
    expect(local.filter((n) => /-(OFL|LICENSE)\.txt$/.test(n))).toHaveLength(6);
  });
});

describe('typed signature text', () => {
  it('every allowed character (and the space) has a glyph in EVERY stamping font', () => {
    for (const f of SIGNATURE_FONTS) {
      const font = fontkit.create(readFileSync(join(TTF_DIR, f.ttf)));
      const missing = [...`${SIGNATURE_TEXT_CHARS} `].filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)!));
      expect(missing, f.ttf).toEqual([]);
    }
  });

  it('refuses what a font cannot draw, an empty name and an overlong one', () => {
    expect(signatureTextProblem('Ada Lovelace')).toBeNull();
    expect(signatureTextProblem("Zoë O'Brien-Núñez")).toBeNull();
    expect(signatureTextProblem('   ')).toBe('empty');
    expect(signatureTextProblem('..')).toBe('empty');
    expect(signatureTextProblem('a'.repeat(SIGNATURE_TEXT_MAX + 1))).toBe('too_long');
    expect(signatureTextProblem('Ada 😀')).toBe('unsupported');
    expect(signatureTextProblem('Łukasz')).toBe('unsupported');
    expect(signatureTextProblem('李')).toBe('unsupported');
  });
});

describe('event labels', () => {
  it('label every event type, and only those', () => {
    expect(Object.keys(EVENT_LABELS).sort()).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES).toHaveLength(18);
  });

  const migration = join(ROOT, 'supabase/migrations/0006_esign.sql');
  const sql = existsSync(migration) ? readFileSync(migration, 'utf8') : '';
  const check = /event_type text NOT NULL CHECK \(event_type IN \(([^)]*)\)\)/.exec(sql);
  // Live once 0006 carries the events table; until then the placeholder has no list to compare.
  it.skipIf(!check)('equal the events table CHECK list in 0006', () => {
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...EVENT_TYPES].sort());
  });

  it('summaries read the keys the producers write, and mask the phone', () => {
    expect(summarizeEvent('sms_code_sent', { last_four: '0001' })).toBe('Sent to •••• 0001');
    expect(summarizeEvent('envelope_sent', { signers_invited: 2, invite_failures: 1 })).toBe('2 signers invited, 1 not delivered');
    expect(summarizeEvent('signer_declined', { reason: ' Wrong document ' })).toBe('Reason: Wrong document');
    expect(summarizeEvent('signer_signed', { timezone: 'Europe/London', consent_version: '2026-10-15.v2' })).toBe('Europe/London · consent 2026-10-15.v2');
  });
});
