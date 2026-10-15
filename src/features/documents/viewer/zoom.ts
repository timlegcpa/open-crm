// Absolute scale on natural size (PreviewSurface's zoom model). NOT
// interchangeable with the annotator's ZOOM_FACTORS, which multiply a fit-page
// base. Lives outside PreviewSurface.tsx so DocumentWorkstation can use it
// without statically pulling in the lazy-loaded PreviewSurface module.
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Next entry of a sorted zoom-steps array after `z`; clamps at the top. */
export function nextZoomStep(steps: readonly number[], z: number): number {
  return steps.find((s) => s > z) ?? z;
}

/** Previous entry of a sorted zoom-steps array before `z`; clamps at the bottom. */
export function prevZoomStep(steps: readonly number[], z: number): number {
  return [...steps].reverse().find((s) => s < z) ?? z;
}
