import type { CSSProperties } from 'react';
import type { LeadSource } from '@/api/pickLists';

/**
 * How a source is named and coloured on every widget that draws one, read from
 * `lead_sources` (the owner's list), never a list in code: a fixed list silently drops the
 * sources it does not name, and then a chart and the table beside it disagree about the same
 * range.
 *
 * One colour per source, never shared: a source with no colour of its own gets a muted
 * neutral, not a chart hue another source might hold. The colour is the owner's free text,
 * so it is only ever applied as an inline background style.
 */
export function sourceLabel(byKey: ReadonlyMap<string, LeadSource>, key: string): string {
  return byKey.get(key)?.label ?? key;
}

const NEUTRAL = 'hsl(var(--muted-foreground) / 0.55)';

export function sourceSwatch(byKey: ReadonlyMap<string, LeadSource>, key: string): CSSProperties {
  return { backgroundColor: byKey.get(key)?.colour || NEUTRAL };
}
