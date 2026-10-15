import { useState, useEffect, useCallback } from 'react';
import { X, Download, Check, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PreviewSurface from './PreviewSurface';
import { isZoomableMime } from './mime';
import { ZOOM_STEPS, nextZoomStep, prevZoomStep } from './zoom';

interface DocumentViewerProps {
  docId: string;
  name: string;
  /**
   * Mime type of the row, known from the file-listing query. Used as a fallback
   * when the preview-loader returns 'unknown' or 'application/octet-stream'
   * (e.g. unencrypted-doc redirect path before mime_type plumbing was added).
   */
  fallbackMimeType?: string;
  onClose: () => void;
  onDownload: (docId: string) => void;
  onLoadPreview: (docId: string) => Promise<{ url: string; mimeType: string; filename: string; blob?: Blob }>;
  reviewedAt?: string | null;
  onToggleReview?: () => void;
  /**
   * Owner only: opens the full-screen document workstation. Optional so the
   * portal never gains the affordance.
   */
  onOpenWorkstation?: () => void;
}

/**
 * Inline document preview pane: the quick peek. The full-screen workstation
 * (rail + keyboard navigation + annotation) is a separate surface reached via
 * `onOpenWorkstation`; both render their document through PreviewSurface.
 */
export default function DocumentViewer({
  docId,
  name,
  fallbackMimeType,
  onClose,
  onDownload,
  onLoadPreview,
  reviewedAt,
  onToggleReview,
  onOpenWorkstation,
}: DocumentViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [resolvedMime, setResolvedMime] = useState<string | null>(null);

  // Zoom reset used to live inside the preview effect that moved into
  // PreviewSurface: without this it stops resetting between documents.
  useEffect(() => setZoom(1), [docId]);

  const zoomIn = useCallback(() => {
    setZoom(z => nextZoomStep(ZOOM_STEPS, z));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom(z => prevZoomStep(ZOOM_STEPS, z));
  }, []);

  const resetZoom = useCallback(() => setZoom(1), []);

  const isZoomable = resolvedMime !== null && isZoomableMime(resolvedMime);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header: a 40px band, the name, then the verbs in one row. "Mark reviewed" is the one primary control on the pane, since
          reviewing is why the pane was opened; once reviewed it turns to a
          quiet ghost that undoes. Everything else is a ghost. */}
      <div className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground" title={name}>{name}</p>
        {isZoomable && (
          <div className="mr-1 flex items-center gap-0.5">
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={zoomOut} title="Zoom out" aria-label="Zoom out" disabled={zoom <= ZOOM_STEPS[0]}>
              <ZoomOut />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={resetZoom}
              className="h-[26px] min-w-[3rem] justify-center tabular-nums text-muted-foreground"
              title="Reset zoom"
            >
              {Math.round(zoom * 100)}%
            </Button>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={zoomIn} title="Zoom in" aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>
              <ZoomIn />
            </Button>
          </div>
        )}
        {onOpenWorkstation && (
          <Button
            variant="ghost"
            size="xs"
            className="h-[26px] text-muted-foreground hover:text-foreground"
            onClick={onOpenWorkstation}
            title="Open full screen"
            aria-label="Open full screen"
          >
            <Maximize2 />
            <span className="hidden sm:inline">Open full screen</span>
          </Button>
        )}
        <Button variant="ghost" size="xs" className="h-[26px] text-muted-foreground hover:text-foreground" onClick={() => onDownload(docId)} title="Download" aria-label="Download">
          <Download />
          <span className="hidden sm:inline">Download</span>
        </Button>
        {onToggleReview && (
          <Button
            variant={reviewedAt ? 'ghost' : 'default'}
            size="xs"
            className={reviewedAt ? 'h-[26px] text-success hover:text-success-dark' : 'h-[26px]'}
            onClick={onToggleReview}
            title={reviewedAt ? 'Mark as unreviewed' : 'Mark as reviewed'}
          >
            <Check />
            {reviewedAt ? 'Reviewed' : 'Mark reviewed'}
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" className="ml-0.5 text-muted-foreground" onClick={onClose} title="Close" aria-label="Close preview">
          <X />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        <PreviewSurface
          docId={docId}
          name={name}
          fallbackMimeType={fallbackMimeType}
          zoom={zoom}
          onDownload={onDownload}
          onLoadPreview={onLoadPreview}
          onMimeResolved={setResolvedMime}
        />
      </div>
    </div>
  );
}
