/**
 * The document a `PdfSurface` (or its toolbar/export sibling) renders. Its own
 * module: a leaf, no React, no pdfjs: because `AnnotatorToolbar` and
 * `AnnotatorExport` both need the type without importing `PdfSurface` itself
 * (which is loaded lazily, and previously created a type-only import cycle
 * between the two files).
 */
export interface AnnotatorDoc {
  id: string;
  name: string;
  contactId: string;
  folderPath: string;
  reviewedAt: string | null;
}
