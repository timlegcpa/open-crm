/**
 * THE signer palette, shared by the signers step (the numbered swatch) and the field placer
 * (each signer's boxes). Colour is a signer's identity while composing, so both screens
 * read this one list by the signer's position in the list, and every entry is distinct:
 * two copies of the list once drifted apart and two signers showed the same colour.
 */
export interface SignerColor {
  /** Inline-style colour for the swatch. */
  css: string;
  border: string;
  bg: string;
  text: string;
  swatch: string;
}

export const SIGNER_COLORS: readonly SignerColor[] = [
  { css: 'hsl(var(--link))', border: 'border-link', bg: 'bg-link/15', text: 'text-link', swatch: 'bg-link' },
  { css: 'hsl(var(--success))', border: 'border-success', bg: 'bg-success/15', text: 'text-success-dark', swatch: 'bg-success' },
  { css: 'hsl(var(--warning))', border: 'border-warning', bg: 'bg-warning/15', text: 'text-warning-dark', swatch: 'bg-warning' },
  { css: 'hsl(var(--destructive))', border: 'border-destructive', bg: 'bg-destructive/15', text: 'text-destructive', swatch: 'bg-destructive' },
  {
    css: 'hsl(var(--chart-6))',
    border: 'border-[hsl(var(--chart-6))]',
    bg: 'bg-[hsl(var(--chart-6)/0.15)]',
    text: 'text-[hsl(var(--chart-6))]',
    swatch: 'bg-[hsl(var(--chart-6))]',
  },
  {
    css: 'hsl(var(--chart-8))',
    border: 'border-[hsl(var(--chart-8))]',
    bg: 'bg-[hsl(var(--chart-8)/0.15)]',
    text: 'text-[hsl(var(--chart-8))]',
    swatch: 'bg-[hsl(var(--chart-8))]',
  },
];

/** The colour for the signer at list position `index` (wraps past the end, never negative). */
export function colorForIndex(index: number): SignerColor {
  const n = SIGNER_COLORS.length;
  return SIGNER_COLORS[((index % n) + n) % n];
}
