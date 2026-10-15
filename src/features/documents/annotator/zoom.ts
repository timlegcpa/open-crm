// Multiplier on the fit-page base scale; 1 = whole tallest page visible. NOT
// interchangeable with PreviewSurface's ZOOM_STEPS, which are absolute. The
// top end reaches ~6 because the base is fit-page, which on a wide desktop
// container is roughly a third of fit-width.
//
// Lives in its own pdfjs-free module so DocumentWorkstation's zoom controls
// (the % display and step buttons) share the exact factors PdfSurface renders
// with, without eagerly pulling the pdfjs chunk.
export const ZOOM_FACTORS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
