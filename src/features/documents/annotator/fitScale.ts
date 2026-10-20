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
