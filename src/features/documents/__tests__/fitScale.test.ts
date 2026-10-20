import { describe, expect, it } from 'vitest';
import { FIT_GUTTER, computeDocumentFitScale, computeFitScale, stackHeight, type PageSize } from '../annotator/fitScale';

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

/**
 * The browser's part for a whole stacked document: the scrollbar shows while the stack
 * overflows, and `scaleFor(clientWidth, outerWidth)` is what the surface computes from what
 * it measures. Returns the toggles before the layout settled.
 */
function documentToggles(outerW: number, h: number, pages: PageSize[], scaleFor: (clientW: number, outerW: number) => number) {
  let hasBar = false;
  let toggles = 0;
  for (let i = 0; i < 20; i++) {
    const clientW: number = outerW - (hasBar ? SCROLLBAR : 0);
    const overflows: boolean = stackHeight(pages, scaleFor(clientW, outerW)) > h;
    if (overflows === hasBar) break;
    hasBar = overflows;
    toggles++;
  }
  return toggles;
}

describe('computeDocumentFitScale', () => {
  const landscape = { widthPt: 792, heightPt: 479.325 };

  it('two width-bound pages settle, where sizing from the width beside the scrollbar looped', () => {
    const pages = [landscape, landscape];
    // Without the scrollbar the pages are 353px and the stack 770px; with it, 344px and
    // 752px: either way the other state follows, across the 760px pane.
    const beside = (clientW: number) => computeFitScale(clientW, 760, 792, 479.325);
    expect(documentToggles(624, 760, pages, beside)).toBe(20);
    const stable = (_clientW: number, outerW: number) => computeDocumentFitScale(outerW, 760, pages, SCROLLBAR);
    expect(documentToggles(624, 760, pages, stable)).toBe(0);
  });

  it('pages always fit the width left beside a scrollbar whenever one shows, for any page count', () => {
    const shapes: PageSize[] = [landscape, { widthPt: 612, heightPt: 792 }, { widthPt: 800, heightPt: 800 }, { widthPt: 4032, heightPt: 3024 }];
    for (const shape of shapes) {
      for (let count = 1; count <= 4; count++) {
        const pages = Array.from({ length: count }, () => shape);
        for (let h = 300; h <= 1400; h += 37) {
          for (let w = 300; w <= 2200; w += 53) {
            const scale = computeDocumentFitScale(w, h, pages, SCROLLBAR);
            if (scale === 0.1) continue;
            const hasBar = stackHeight(pages, scale) > h;
            const room = w - (hasBar ? SCROLLBAR : 0) - FIT_GUTTER;
            expect(shape.widthPt * scale).toBeLessThanOrEqual(room + 1e-9);
          }
        }
      }
    }
  });

  it('a single page is fitted exactly as before', () => {
    expect(computeDocumentFitScale(900, 700, [{ widthPt: 612, heightPt: 792 }], SCROLLBAR)).toBe(computeFitScale(900, 700, 612, 792));
  });
});
