// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two status hues that sit side by side on the board, measured from the tokens actually
 * in src/index.css (a ratio claimed in a comment is worth nothing):
 *   --caution    lemon, "in progress"
 *   --attention  orange, "waiting"
 * Each one's deep text shade must read on its own pale fill (WCAG AA for small text) in
 * both themes, and the two must stay clearly different hues: a gold beside an amber reads
 * as one colour, and 25 degrees apart is the floor that separates them.
 */

const FLOOR = 4.5;
const CSS = readFileSync(path.resolve(__dirname, '..', 'index.css'), 'utf8');

type Hsl = [number, number, number];

/** The `--name: H S% L%;` tokens declared in the block that opens with `opener` (`:root {`). */
function tokensIn(opener: string): Map<string, Hsl> {
  const open = CSS.indexOf(opener);
  if (open < 0) throw new Error(`no "${opener}" block in index.css`);
  const body = CSS.slice(open + opener.length, CSS.indexOf('}', open));
  const out = new Map<string, Hsl>();
  for (const m of body.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) {
    out.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return out;
}

function hslToRgb([h, s, l]: Hsl): [number, number, number] {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lN - c / 2;
  return [r + m, g + m, b + m];
}

/** WCAG 2.1 relative luminance. */
function luminance(hsl: Hsl): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hslToRgb(hsl).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(tokens: Map<string, Hsl>, fg: string, bg: string): number {
  const a = tokens.get(fg);
  const b = tokens.get(bg);
  if (!a || !b) throw new Error(`missing token --${a ? bg : fg}`);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = [
  { name: 'light', tokens: tokensIn(':root {') },
  { name: 'dark', tokens: tokensIn('.dark {') },
];

describe('status hue contrast', () => {
  describe.each(THEMES)('$name theme', ({ tokens }) => {
    it.each(['caution', 'attention'])(`%s: the -dark text on the -light fill clears ${FLOOR}:1`, (hue) => {
      expect(ratio(tokens, `${hue}-dark`, `${hue}-light`)).toBeGreaterThanOrEqual(FLOOR);
    });

    it('caution is a lemon, attention an orange, at least 25 degrees apart', () => {
      for (const variant of ['', '-light', '-dark']) {
        const caution = tokens.get(`caution${variant}`)![0];
        const attention = tokens.get(`attention${variant}`)![0];
        expect(caution, `--caution${variant}`).toBeGreaterThanOrEqual(50);
        expect(caution, `--caution${variant}`).toBeLessThanOrEqual(60);
        expect(attention, `--attention${variant}`).toBeGreaterThanOrEqual(15);
        expect(attention, `--attention${variant}`).toBeLessThanOrEqual(30);
        expect(caution - attention, variant || 'base').toBeGreaterThanOrEqual(25);
      }
    });
  });

  it('measures two different themes, not one block twice', () => {
    const [light, dark] = THEMES;
    expect(light.tokens.size).toBeGreaterThan(10);
    expect(dark.tokens.size).toBeGreaterThan(10);
    expect(dark.tokens.get('caution-light')).not.toEqual(light.tokens.get('caution-light'));
    expect(dark.tokens.get('attention-light')).not.toEqual(light.tokens.get('attention-light'));
  });

  it('tailwind maps both hues, base, light and dark', () => {
    const config = readFileSync(path.resolve(__dirname, '..', '..', 'tailwind.config.js'), 'utf8');
    for (const hue of ['caution', 'attention']) {
      for (const variant of ['', '-light', '-dark']) {
        expect(config, `--${hue}${variant}`).toContain(`hsl(var(--${hue}${variant}))`);
      }
    }
  });
});
