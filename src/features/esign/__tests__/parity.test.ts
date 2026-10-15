// @vitest-environment node
// Everything the browser and the e-sign functions must agree on, checked against the
// server's own modules: the six signature fonts, the typed-signature rule (and that every
// character it allows has a glyph in every stamping font), the event labels (and the
// events table CHECK in 0006), the drawn-signature validator, and the settings the
// settings page writes and finalize reads.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import * as serverEvents from '../../../../supabase/functions/esign-finalize-envelope/lib/events';
import * as serverImage from '../../../../supabase/functions/esign-finalize-envelope/lib/signature-image';
import * as serverSettings from '../../../../supabase/functions/esign-finalize-envelope/lib/settings';
import { isSmsCodeKey } from '../../../../supabase/functions/esign-finalize-envelope/lib/sms';
import { FUNCTION_SECRETS, generateSecrets } from '../../../../scripts/lib/bootstrap-core.mjs';
import {
  normalizeTypedSignature,
  SIGNATURE_FONT_FILES,
  TYPED_SIGNATURE_LETTERS,
} from '../../../../supabase/functions/esign-finalize-envelope/lib/typed-signature';
import { DEFAULT_ESIGN_SETTINGS, ESIGN_SETTINGS_KEY, EVENT_TYPES } from '../contract';
import { EVENT_LABELS, summarizeEvent } from '../lib/eventLabels';
import { parseFilingFolder } from '../lib/filingFolder';
import * as uiImage from '../lib/signatureImage';
import { SIGNATURE_FONTS } from '../lib/signatureFonts';
import { SIGNATURE_TEXT_MAX, signatureTextProblem } from '../lib/signatureText';

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

  it('the six keys and their TTFs are exactly the server’s (the key the page sends is the font the PDF stamps)', () => {
    expect(Object.fromEntries(SIGNATURE_FONTS.map((f) => [f.key, f.ttf]))).toEqual(SIGNATURE_FONT_FILES);
    expect(SIGNATURE_FONTS).toHaveLength(6);
  });

  it('each font has an @font-face of the same family over its own woff2, and nothing else does', () => {
    expect(faces.map((f) => `${f.family}|${f.file}`).sort()).toEqual(
      SIGNATURE_FONTS.map((f) => `${/'([^']+)'/.exec(f.family)?.[1]}|${f.woff2}`).sort(),
    );
  });

  it('finalize deploys exactly the six TTFs it reads (static_files in config.toml), and each is on disk', () => {
    const toml = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
    const block = /^\[functions\.esign-finalize-envelope\][\s\S]*?static_files\s*=\s*\[([\s\S]*?)\]/m.exec(toml);
    expect(block).not.toBeNull();
    const listed = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(Object.values(SIGNATURE_FONT_FILES).map((f) => `./functions/_shared/esign-fonts/fonts/${f}`).sort());
    for (const path of listed) expect(existsSync(join(ROOT, 'supabase', path)), path).toBe(true);
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
  const allowed = new RegExp(`^[${TYPED_SIGNATURE_LETTERS} .,'-]$`);
  /** Every character the rule allows, enumerated over the range it can reach. */
  const ALLOWED_CHARS = Array.from({ length: 0x3000 }, (_, cp) => String.fromCodePoint(cp)).filter((ch) => allowed.test(ch));

  it('every allowed character has a glyph in EVERY stamping font', () => {
    expect(ALLOWED_CHARS.length).toBeGreaterThan(100);
    for (const f of SIGNATURE_FONTS) {
      const font = fontkit.create(readFileSync(join(TTF_DIR, f.ttf)));
      const missing = ALLOWED_CHARS.filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)!));
      expect(missing, f.ttf).toEqual([]);
    }
  });

  it('the page accepts exactly what the sign function accepts', () => {
    const corpus = [
      ...Array.from({ length: 0x600 }, (_, cp) => String.fromCodePoint(cp)),
      ...Array.from({ length: 0x600 }, (_, cp) => `Ada ${String.fromCodePoint(cp)} Lovelace`),
      'Ada Lovelace',
      "Zoë O'Brien-Núñez",
      'Łukasz Žák',
      'Søren Ærø',
      'Ada 😀',
      '李',
      '   ',
      '..',
      'étienne',
      'a'.repeat(SIGNATURE_TEXT_MAX),
      'a'.repeat(SIGNATURE_TEXT_MAX + 1),
      `  ${'b'.repeat(SIGNATURE_TEXT_MAX)}  `,
    ];
    const disagree = corpus.filter((s) => (signatureTextProblem(s) === null) !== (normalizeTypedSignature(s) !== null));
    expect(disagree).toEqual([]);
  });

  it('names the reason for the hint', () => {
    expect(signatureTextProblem('Ada Lovelace')).toBeNull();
    expect(signatureTextProblem('Łukasz Žák')).toBeNull();
    expect(signatureTextProblem('   ')).toBe('empty');
    expect(signatureTextProblem('..')).toBe('empty');
    expect(signatureTextProblem('a'.repeat(SIGNATURE_TEXT_MAX + 1))).toBe('too_long');
    expect(signatureTextProblem('Ada 😀')).toBe('unsupported');
    expect(signatureTextProblem('李')).toBe('unsupported');
  });
});

describe('event labels', () => {
  it('are the server’s types and the server’s words', () => {
    expect([...EVENT_TYPES].sort()).toEqual([...serverEvents.EVENT_TYPES].sort());
    expect(EVENT_LABELS).toEqual(serverEvents.EVENT_LABELS);
  });

  it('equal the events table CHECK list in 0006', () => {
    const sql = readFileSync(join(ROOT, 'supabase/migrations/0006_esign.sql'), 'utf8');
    const check = /event_type text NOT NULL CHECK \(event_type IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...EVENT_TYPES].sort());
  });

  it('summaries read the keys the producers write, and mask the phone', () => {
    expect(summarizeEvent('sms_code_sent', { last_four: '0001' })).toBe('Sent to •••• 0001');
    expect(summarizeEvent('envelope_sent', { signers_invited: 2, invite_failures: 1 })).toBe('2 signers invited, 1 not delivered');
    expect(summarizeEvent('signer_declined', { reason: ' Wrong document ' })).toBe('Reason: Wrong document');
    expect(summarizeEvent('signer_signed', { timezone: 'Europe/London', consent_version: '2026-10-15.v2' })).toBe('Europe/London · consent 2026-10-15.v2');
    expect(summarizeEvent('email_opened', { resend_email_id: 'x', kind: 'esign_invite' })).toBe('Invitation');
    expect(summarizeEvent('envelope_expired', { signers_expired: 2, tasks_dismissed: 1 })).toBe('2 signer links expired');
  });
});

describe('drawn-signature validator', () => {
  it('the page runs the sign function’s own module', () => {
    expect(uiImage.validateSignatureImageBase64).toBe(serverImage.validateSignatureImageBase64);
    expect(uiImage.MAX_SIGNATURE_IMAGE_BASE64_CHARS).toBe(serverImage.MAX_SIGNATURE_IMAGE_BASE64_CHARS);
  });
});

describe('secrets the bootstrap generates', () => {
  it('include the two e-sign keys, in the shape the functions accept', () => {
    const names = FUNCTION_SECRETS.map((s: { name: string }) => s.name);
    expect(names).toEqual(expect.arrayContaining(['ESIGN_INTERNAL_TOKEN', 'ESIGN_SMS_CODE_KEY', 'PII_ENCRYPTION_KEY']));
    const secrets = generateSecrets((size: number) => Buffer.alloc(size, 0xab));
    expect(isSmsCodeKey(secrets.ESIGN_SMS_CODE_KEY)).toBe(true);
    expect(secrets.ESIGN_INTERNAL_TOKEN.length).toBeGreaterThanOrEqual(32);
  });
});

describe('settings: what the page writes is what finalize reads', () => {
  /** The one query loadEsignSettings makes, answered with `value`; records what it asked for. */
  function fakeDb(value: unknown) {
    const asked: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (column: string, v: unknown) => {
        asked.push([column, v]);
        return builder;
      },
      maybeSingle: async () => ({ data: value === undefined ? null : { value }, error: null }),
    };
    const from = (table: string) => {
      asked.push(['table', table]);
      return builder;
    };
    return { db: { from }, asked };
  }

  it('reads the same app_settings key and field names, with the same defaults', async () => {
    const saved = fakeDb({ filing_folder: 'Signed/Agreements', sms_enabled: false });
    const read = await serverSettings.loadEsignSettings(saved.db as never);
    expect(saved.asked).toEqual([['table', 'app_settings'], ['key', ESIGN_SETTINGS_KEY]]);
    expect(read).toEqual({ filingFolder: ['Signed', 'Agreements'], smsEnabled: false });

    const empty = await serverSettings.loadEsignSettings(fakeDb(undefined).db as never);
    expect(empty).toEqual({ filingFolder: [DEFAULT_ESIGN_SETTINGS.filing_folder], smsEnabled: DEFAULT_ESIGN_SETTINGS.sms_enabled });
    expect(serverSettings.DEFAULT_FILING_FOLDER).toBe(DEFAULT_ESIGN_SETTINGS.filing_folder);
  });

  it('the page refuses exactly the folders the server would replace with the default', () => {
    const corpus = [
      'Signed documents',
      'Signed/Agreements',
      ' Signed / Agreements / ',
      '/',
      '',
      '   ',
      'a/b/c/d/e',
      'a/b/c/d/e/f',
      '.',
      '..',
      'a/../b',
      'back\\slash',
      'tab\there',
      'zero​width',
      'right‮left',
      'x'.repeat(100),
      'x'.repeat(101),
      `${'x'.repeat(100)}/${'y'.repeat(97)}`,
      `${'x'.repeat(100)}/${'y'.repeat(98)}`,
      'Café ✓',
      '😀 emoji',
    ];
    const disagree = corpus.filter((v) => JSON.stringify(parseFilingFolder(v)) !== JSON.stringify(serverSettings.parseFilingFolder(v)));
    expect(disagree).toEqual([]);
  });
});
