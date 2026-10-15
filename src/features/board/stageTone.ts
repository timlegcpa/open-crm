import type { BoardStageKey } from './api';

/**
 * A lane's colour: the dot on its header, its figure and its history rail, and (softened)
 * the outline of every card in it. One decision, here, so a recoloured lane moves all of
 * them together.
 *
 * The owner's colour for the lane wins; without one each key has a default from the theme's
 * status pairs (never a literal), so it follows light and dark. Waiting is the orange and
 * In progress the lemon: the theme keeps those two hues far enough apart to tell at a glance.
 */
const DEFAULT_TONE: Record<BoardStageKey, string> = {
  todo: 'hsl(var(--link))',
  waiting: 'hsl(var(--attention))',
  doing: 'hsl(var(--caution))',
  done: 'hsl(var(--success))',
};

/** A stored value that is not a current key (it cannot happen while the keys are fixed): recessed, never a claim. */
const UNKNOWN_TONE = 'hsl(var(--muted-foreground) / 0.35)';

export interface StageTone {
  /** Solid: a dot or a rail. */
  dot: string;
  /**
   * The card outline: the same colour at partial strength, since a full-strength hairline
   * around every card vibrates, most of all on the dark canvas. The lemon carries more,
   * being the lightest hue, or it disappears on a white card.
   */
  border: string;
}

export function stageTone(key: string | null, colour?: string | null): StageTone {
  const known = key !== null && Object.hasOwn(DEFAULT_TONE, key);
  if (!known && !colour) return { dot: UNKNOWN_TONE, border: UNKNOWN_TONE };
  const dot = colour || DEFAULT_TONE[key as BoardStageKey];
  const strength = !colour && key === 'doing' ? 85 : 60;
  return { dot, border: `color-mix(in srgb, ${dot} ${strength}%, transparent)` };
}
