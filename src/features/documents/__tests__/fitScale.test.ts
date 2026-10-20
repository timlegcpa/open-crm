import { describe, expect, it } from 'vitest';
import { computeFitScale } from '../annotator/fitScale';

const SCROLLBAR = 15;
// What the scroll body really adds around a page: py-4 top and bottom plus the page's mb-4
// (scrollHeight = page + 48 when measured in a browser).
const LAYOUT_VERTICAL_PX = 48;

/** The page height AnnotatorPage renders (Math.floor, as its cssH). */
function pageHeight(w: number, h: number, wPt: number, hPt: number) {
  return Math.floor(hPt * computeFitScale(w, h, wPt, hPt));
}

/**
 * Plays the browser's part: a vertical scrollbar appears when the page plus the scroll
 * body's vertical chrome overflows, and it takes SCROLLBAR px of width. Returns how many
 * times the scrollbar toggled before the layout settled.
 */
function scrollbarToggles(outerW: number, h: number, wPt: number, hPt: number) {
  let hasBar = false;
  let toggles = 0;
  for (let i = 0; i < 20; i++) {
    const clientW: number = outerW - (hasBar ? SCROLLBAR : 0);
    const overflows: boolean = pageHeight(clientW, h, wPt, hPt) + LAYOUT_VERTICAL_PX > h;
    if (overflows === hasBar) break;
    hasBar = overflows;
    toggles++;
  }
  return toggles;
}

describe('computeFitScale', () => {
  it('fit-page never overflows the scroll body, so no scrollbar appears at 100%', () => {
    for (const [wPt, hPt] of [[960, 581], [612, 792], [3024, 4032], [4032, 3024], [800, 800]]) {
      for (let h = 300; h <= 1400; h += 37) {
        for (let w = 300; w <= 2200; w += 53) {
          // The 0.1 floor deliberately lets a huge page outgrow a tiny pane.
          if (computeFitScale(w, h, wPt, hPt) === 0.1) continue;
          expect(pageHeight(w, h, wPt, hPt) + LAYOUT_VERTICAL_PX).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it('a landscape photo wrapped as a page settles with no scrollbar', () => {
    // A 960x581 photo wraps to a 792x479.325 pt page. In this pane a 32px reservation
    // toggled the scrollbar on every pass (20 of 20).
    expect(scrollbarToggles(624, 400, 792, 479.325)).toBe(0);
  });

  it('falls back to 1 before the container is measured', () => {
    expect(computeFitScale(0, 0, 612, 792)).toBe(1);
  });
});
