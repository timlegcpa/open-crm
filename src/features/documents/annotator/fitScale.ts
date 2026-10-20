// px between/around pages in the scroll body (py-4 top offset + mb-4 per page).
export const PAGE_GAP = 16;
// Horizontal breathing room inside the scroll body when computing fit-width.
export const FIT_GUTTER = 40;
// Vertical px the scroll body adds around the tallest page: py-4 on the page stack (top and
// bottom) plus the page's own mb-4. Reserving less makes fit-page overflow: the vertical
// scrollbar appears, the width it takes shrinks the container, a width-bound (landscape)
// page rescales smaller, loses the overflow, drops the scrollbar and grows again, and the
// viewer flickers forever.
export const FIT_VERTICAL_CHROME = PAGE_GAP * 3;

/**
 * Fit-PAGE base: at zoomFactor 1 the whole tallest page is visible with no scrollbar. Never
 * exceeds fit-width, so narrow containers (phones) still fill their width; there fit-page
 * and fit-width coincide. 1 until the container has been measured.
 */
export function computeFitScale(
  containerWidth: number,
  containerHeight: number,
  maxPageWidthPt: number,
  maxPageHeightPt: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0) return 1;
  return Math.min(
    3,
    Math.max(
      0.1,
      Math.min(
        (containerWidth - FIT_GUTTER) / maxPageWidthPt,
        (containerHeight - FIT_VERTICAL_CHROME) / maxPageHeightPt,
      ),
    ),
  );
}

export interface PageSize {
  widthPt: number;
  heightPt: number;
}

/**
 * Height of the scroll body's content at a scale: py-4 above and below the stack, and each
 * page (drawn at Math.floor of its scaled height, as AnnotatorPage does) followed by its mb-4.
 */
export function stackHeight(pages: readonly PageSize[], scale: number): number {
  return pages.reduce((sum, p) => sum + Math.floor(p.heightPt * scale) + PAGE_GAP, PAGE_GAP * 2);
}

/**
 * The fit scale for the whole document, decided from the pane's width INCLUDING any vertical
 * scrollbar (`outerWidth`), so the scrollbar appearing or going never changes the answer.
 * Deciding from the width left beside the scrollbar fed back: with several width-bound pages,
 * the stack overflowed, the scrollbar took its width, the pages shrank until the stack fit,
 * the scrollbar went, and the pages grew again, forever. Here: when the stack at the full
 * width would overflow, the pages are sized for the width beside a scrollbar, and stay that
 * size even if the smaller stack then fits.
 */
export function computeDocumentFitScale(
  outerWidth: number,
  containerHeight: number,
  pages: readonly PageSize[],
  scrollbarWidth: number,
): number {
  const sizes = pages.length > 0 ? pages : [{ widthPt: 612, heightPt: 792 }];
  const maxW = Math.max(...sizes.map((p) => p.widthPt));
  const maxH = Math.max(...sizes.map((p) => p.heightPt));
  const full = computeFitScale(outerWidth, containerHeight, maxW, maxH);
  if (outerWidth <= 0 || containerHeight <= 0 || stackHeight(sizes, full) <= containerHeight) return full;
  return computeFitScale(outerWidth - scrollbarWidth, containerHeight, maxW, maxH);
}

/** The width a classic vertical scrollbar takes here (0 where scrollbars overlay content). */
export function measureScrollbarWidth(doc: Document): number {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}
