import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Download, Loader2, FileWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/errors';
import { readPreviewText } from '../lib/previewSource';
import { CSV_MIME, TEXT_MIME, XLSX_MIME, isPdf, isPreviewable, isWordDoc } from './mime';

const DocxRenderer = lazy(() => import('./renderers/DocxRenderer'));
const XlsxRenderer = lazy(() => import('./renderers/XlsxRenderer'));
const CsvRenderer = lazy(() => import('./renderers/CsvRenderer'));

function TextPreview({ url, blob }: { url: string; blob?: Blob }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    readPreviewText(url, blob)
      .then(t => { setText(t); setLoading(false); })
      .catch(() => { setText('Failed to load text content.'); setLoading(false); });
  }, [url, blob]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <pre className="p-4 text-sm text-foreground whitespace-pre-wrap break-words font-mono leading-relaxed overflow-auto h-full bg-muted">
      {text}
    </pre>
  );
}

export interface PreviewSurfaceProps {
  docId: string;
  name: string;
  fallbackMimeType?: string;
  /** Absolute scale from ZOOM_STEPS. The parent owns the controls. */
  zoom: number;
  onDownload: (docId: string) => void;
  onLoadPreview: (docId: string) => Promise<{ url: string; mimeType: string; filename: string; blob?: Blob }>;
  /** Reports the resolved mime so the parent can pick chrome (zoomable? PDF?). */
  onMimeResolved?: (mimeType: string | null) => void;
}

/**
 * Renders one decrypted document. Shared by the inline DocumentViewer and the
 * full-screen workstation so the six render branches exist in exactly one place.
 *
 * Layout contract: the root is `h-full min-h-0` and owns its own scroll: every
 * consumer must give it a bounded height (a `flex-1 min-h-0` slot).
 */
export default function PreviewSurface({
  docId,
  name,
  fallbackMimeType,
  zoom,
  onDownload,
  onLoadPreview,
  onMimeResolved,
}: PreviewSurfaceProps) {
  const [preview, setPreview] = useState<{ url: string; mimeType: string; filename: string; blob?: Blob } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Latest-ref rather than deps: the effect must fire on docId ONLY (one
  // caller passes an inline arrow for onLoadPreview, so listing it would
  // re-decrypt on every parent render), but it must not stale-closure onto an
  // older handler or fallback mime either.
  const loadRef = useRef(onLoadPreview);
  const fallbackMimeRef = useRef(fallbackMimeType);
  const mimeResolvedRef = useRef(onMimeResolved);
  // Intentionally unbound: this effect syncs the refs above on EVERY render, so
  // the load effect below always reads the current handlers without listing them
  // as deps. Three ref writes per parent render is the whole cost.
  useEffect(() => {
    loadRef.current = onLoadPreview;
    fallbackMimeRef.current = fallbackMimeType;
    mimeResolvedRef.current = onMimeResolved;
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    mimeResolvedRef.current?.(null);

    loadRef.current(docId)
      .then((result) => {
        if (!cancelled) {
          // Backfill mimeType from the row's known type when the loader
          // couldn't determine it (legacy redirect path without mime_type).
          const resolvedMime = (!result.mimeType || result.mimeType === 'unknown' || result.mimeType === 'application/octet-stream')
            ? (fallbackMimeRef.current || result.mimeType || 'application/octet-stream')
            : result.mimeType;
          setPreview({ ...result, mimeType: resolvedMime });
          setLoading(false);
          mimeResolvedRef.current?.(resolvedMime);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(getErrorMessage(err, 'The preview could not be loaded.'));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Revoke blob URL on unmount or when preview changes
  useEffect(() => {
    return () => {
      if (preview?.url?.startsWith('blob:')) {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [preview]);

  return (
    <div className="h-full min-h-0 overflow-auto">
      {loading && (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
          <FileWarning className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" onClick={() => onDownload(docId)}>
            Download instead
          </Button>
        </div>
      )}

      {preview && !loading && !error && (
        <>
          {isPdf(preview.mimeType) && (
            // No `sandbox`: Chromium's built-in PDF viewer refuses to load inside any
            // sandboxed frame (it shows a "blocked" page whatever allow-* tokens are given),
            // so a sandbox would break every PDF preview there. What the frame can show is
            // held instead: the blob is retyped from the row as application/pdf and its
            // bytes were checked to be a PDF on upload, so it cannot be an HTML page, and a
            // plaintext document's signed link serves from the storage origin, not this one.
            <iframe
              src={preview.url}
              className="h-full"
              style={{ width: `${100 * zoom}%`, transformOrigin: 'top left' }}
              title={name}
            />
          )}
          {preview.mimeType.startsWith('image/') && (
            <div className="flex items-center justify-center min-h-full p-4 bg-muted">
              <img
                src={preview.url}
                alt={name}
                className="object-contain"
                style={{
                  maxWidth: zoom <= 1 ? '100%' : 'none',
                  maxHeight: zoom <= 1 ? '100%' : 'none',
                  width: zoom > 1 ? `${zoom * 100}%` : undefined,
                  transform: zoom < 1 ? `scale(${zoom})` : undefined,
                  transformOrigin: 'center center',
                }}
              />
            </div>
          )}
          {isWordDoc(preview.mimeType) && (
            <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}>
              <div style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%` } : undefined}>
                <DocxRenderer url={preview.url} blob={preview.blob} />
              </div>
            </Suspense>
          )}
          {preview.mimeType === XLSX_MIME && (
            <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}>
              <XlsxRenderer url={preview.url} />
            </Suspense>
          )}
          {preview.mimeType === CSV_MIME && (
            <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}>
              <CsvRenderer url={preview.url} blob={preview.blob} />
            </Suspense>
          )}
          {preview.mimeType === TEXT_MIME && (
            <div style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%` } : undefined}>
              <TextPreview url={preview.url} blob={preview.blob} />
            </div>
          )}
          {!isPreviewable(preview.mimeType) && (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
              <FileWarning className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Preview not available for this file type.</p>
              <Button size="sm" onClick={() => onDownload(docId)}>
                <Download className="w-4 h-4 mr-1.5" />
                Download
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
