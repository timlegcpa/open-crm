import { useCallback, useEffect, useRef, useState } from 'react';
import { FileWarning, Loader2 } from 'lucide-react';
import type {
  DocumentAnnotation,
  HighlightMode,
  ReviewStampKey,
  StampKey,
} from '../lib/annotations';
import AnnotatorToolbar, { type AnnotatorTool } from './AnnotatorToolbar';
import AnnotationListPanel from './AnnotationListPanel';
import AnnotatorPage from './AnnotatorPage';
import { useAnnotatorDoc } from './useAnnotatorDoc';
import { useAnnotations } from './useAnnotations';
import type { AnnotatorDoc } from './types';

// px between/around pages in the scroll body (py-4 top offset + mb-4 per page).
const PAGE_GAP = 16;
// Horizontal breathing room inside the scroll body when computing fit-width.
const FIT_GUTTER = 40;

const EMPTY_ANNOTATIONS: DocumentAnnotation[] = [];

export interface PdfSurfaceProps {
  doc: AnnotatorDoc;
  zoomFactor: number;
  /** Tool state is owned by the shell: it is per-session, not per-document, so
   * it must survive an arrow-key document switch. */
  tool: AnnotatorTool;
  inkColor: string;
  highlightColor: string;
  highlightMode: HighlightMode;
  highlightBrush: number;
  stampKey: StampKey | ReviewStampKey;
  /** Fired when a review stamp is placed, with which one. Passed through to the
   * shell UNTOUCHED: the "only REVIEWED mirrors into reviewed_at" policy lives
   * in one place, next to the write (DocumentWorkstation.handleReviewStamped). */
  onReviewStamped?: (stamp: ReviewStampKey) => void;
  onToolChange: (tool: AnnotatorTool) => void;
  onInkColorChange: (color: string) => void;
  onHighlightColorChange: (color: string) => void;
  onHighlightModeChange: (mode: HighlightMode) => void;
  onHighlightBrushChange: (width: number) => void;
  onStampKeyChange: (key: StampKey | ReviewStampKey) => void;
  onPageChange: (page: number, total: number) => void;
  /** Lets the shell make the first Escape deselect rather than close. */
  onSelectionChange?: (hasSelection: boolean) => void;
  /** Shell increments to force a deselect. */
  deselectSignal?: number;
  /** Shell increments scrollToPageNonce to jump to scrollToPage (1-based). */
  scrollToPage?: number;
  scrollToPageNonce?: number;
  /** The bytes cannot be annotated (error 'image'); the host falls back to the plain preview. */
  onCannotAnnotate?: (docId: string) => void;
}

/**
 * The PDF viewing + annotation body. Chrome (header, close, review toggle,
 * keyboard) belongs to the shell that hosts this.
 *
 * Layout contract: root is `flex flex-col h-full min-h-0`; the scroll body is
 * `flex-1 overflow-auto`. A consumer must give it a bounded height.
 */
export default function PdfSurface({
  doc,
  zoomFactor,
  tool,
  inkColor,
  highlightColor,
  highlightMode,
  highlightBrush,
  stampKey,
  onReviewStamped,
  onToolChange,
  onInkColorChange,
  onHighlightColorChange,
  onHighlightModeChange,
  onHighlightBrushChange,
  onStampKeyChange,
  onPageChange,
  onSelectionChange,
  deselectSignal,
  scrollToPage,
  scrollToPageNonce,
  onCannotAnnotate,
}: PdfSurfaceProps) {
  const { status, error, pdf, pageMetas, getBytes, reportRenderStall, hasBytes, imageErrorDocId } =
    useAnnotatorDoc(doc.id);
  useEffect(() => {
    if (error === 'image' && imageErrorDocId === doc.id) onCannotAnnotate?.(doc.id);
  }, [error, imageErrorDocId, doc.id, onCannotAnnotate]);
  const { annotations, byPage, addAnnotation, updateAnnotation, removeAnnotation, undo } =
    useAnnotations(doc.id);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Selection is per-document: documentAnnotations.remove() deletes by primary
  // key with no document scoping, so a selection carried across a switch would
  // delete the PREVIOUS document's annotation.
  useEffect(() => {
    setSelectedId(null);
  }, [doc.id]);

  // Stable identity so the panel's rows aren't re-rendered by unrelated surface
  // state; the functional setter keeps selectedId out of the deps.
  const handlePanelRemove = useCallback(
    (id: string) => {
      removeAnnotation(id);
      setSelectedId((prev) => (prev === id ? null : prev));
    },
    [removeAnnotation],
  );

  useEffect(() => {
    onSelectionChange?.(selectedId !== null);
  }, [selectedId, onSelectionChange]);

  useEffect(() => {
    if (deselectSignal === undefined) return;
    setSelectedId(null);
  }, [deselectSignal]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setContainerWidth(el.clientWidth);
      setContainerHeight(el.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxPageWidthPt = pageMetas.length > 0 ? Math.max(...pageMetas.map((m) => m.widthPt)) : 612;
  const maxPageHeightPt = pageMetas.length > 0 ? Math.max(...pageMetas.map((m) => m.heightPt)) : 792;
  // Fit-PAGE base: at zoomFactor 1 the whole tallest page is visible. Never
  // exceeds fit-width, so narrow containers (mobile) still fill their width , 
  // there fit-page and fit-width coincide.
  const fitScale =
    containerWidth > 0 && containerHeight > 0
      ? Math.min(
          3,
          Math.max(
            0.1,
            Math.min(
              (containerWidth - FIT_GUTTER) / maxPageWidthPt,
              (containerHeight - PAGE_GAP * 2) / maxPageHeightPt,
            ),
          ),
        )
      : 1;
  const cssScale = fitScale * zoomFactor;

  // ── Page counter from scroll position ──
  const pageChangeRef = useRef(onPageChange);
  useEffect(() => {
    pageChangeRef.current = onPageChange;
  });

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || pageMetas.length === 0) return;
    const y = el.scrollTop + el.clientHeight * 0.4;
    let top = PAGE_GAP;
    let page = 1;
    for (let i = 0; i < pageMetas.length; i++) {
      const h = Math.floor(pageMetas[i].heightPt * cssScale);
      page = i + 1;
      if (y < top + h + PAGE_GAP) break;
      top += h + PAGE_GAP;
    }
    pageChangeRef.current(page, pageMetas.length);
  }, [pageMetas, cssScale]);

  // Re-derive the counter when zoom (page heights) changes.
  useEffect(() => {
    handleScroll();
  }, [handleScroll]);

  // ── Imperative page jump ──
  // Reads the page element's own offsetTop rather than re-deriving the
  // cumulative height math: AnnotatorPage already stamps data-annotator-page.
  // Shared by the shell's ←/→ and the annotation panel's row clicks.
  const scrollToPageIndex = useCallback((pageIndex: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-annotator-page="${pageIndex}"]`);
    if (target) el.scrollTo({ top: Math.max(0, target.offsetTop - PAGE_GAP) });
  }, []);

  useEffect(() => {
    if (scrollToPageNonce === undefined || scrollToPage === undefined) return;
    scrollToPageIndex(scrollToPage - 1);
  }, [scrollToPageNonce, scrollToPage, scrollToPageIndex]);

  // ── Keyboard owned here: only the annotation-local keys. Document/page/
  // review/Escape belong to the shell. ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // While typing (text-note textarea etc.) native behavior wins: including native undo.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false)) return;
      // Inside an open dialog / dropdown (export AlertDialog etc.) the overlay owns
      // the keys. PdfSurface itself renders inside the workstation's own
      // `role="dialog"` root, so the `:not(...)` exclusion is required or every
      // keypress here would match that root and these shortcuts would never fire.
      if (
        target?.closest?.(
          '[role="dialog"]:not([data-workstation-root]), [role="menu"], [role="alertdialog"]'
        )
      )
        return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          e.preventDefault();
          removeAnnotation(selectedId);
          setSelectedId(null);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const undoneId = undo();
        if (undoneId && undoneId === selectedId) setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, removeAnnotation, undo]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {status === 'ready' && (
        <AnnotatorToolbar
          tool={tool}
          onToolChange={onToolChange}
          inkColor={inkColor}
          onInkColorChange={onInkColorChange}
          highlightColor={highlightColor}
          onHighlightColorChange={onHighlightColorChange}
          highlightMode={highlightMode}
          onHighlightModeChange={onHighlightModeChange}
          highlightBrush={highlightBrush}
          onHighlightBrushChange={onHighlightBrushChange}
          stampKey={stampKey}
          onStampKeyChange={onStampKeyChange}
          doc={doc}
          getBytes={getBytes}
          hasBytes={hasBytes}
          annotations={annotations}
          panelOpen={panelOpen}
          onPanelToggle={() => setPanelOpen((o) => !o)}
        />
      )}

      {/* Scroll body + marks panel share a row; the body must carry min-w-0 or a
          wide page pushes the panel off instead of scrolling inside itself. */}
      <div className="flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-w-0 flex-1 overflow-auto overscroll-contain bg-muted px-4"
      >
        {status === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileWarning className="h-10 w-10 text-muted-foreground" />
            {/* Three states, three sentences. 'timeout' used to be reported as
                'invalid', which told the owner a document was corrupt when it had
                only taken too long to decode. */}
            <p className="text-sm font-medium text-foreground">
              {error === 'password'
                ? 'This PDF is password-protected'
                : error === 'timeout'
                  ? 'This document took too long to open'
                  : "Couldn't open this document"}
            </p>
            <p className="text-xs text-muted-foreground">
              {error === 'password'
                ? 'Unlock it outside the portal and re-upload to annotate.'
                : error === 'timeout'
                  ? 'It stopped at the time limit, so nothing here says it is damaged. Reopen it to try again; if it stalls every time, the file is heavier than the annotator can render.'
                  : 'It may not be a valid PDF file.'}
            </p>
          </div>
        )}

        {status === 'ready' && pdf && (
          // Keyed on the document: AnnotatorPage flushes an open text draft on
          // unmount, so without a remount a half-typed note would commit into
          // the NEXT document.
          <div className="py-4" key={doc.id}>
            {pageMetas.map((meta, i) => (
              <AnnotatorPage
                onDecodeStall={reportRenderStall}
                key={i}
                pdf={pdf}
                pageIndex={i}
                meta={meta}
                cssScale={cssScale}
                tool={tool}
                inkColor={inkColor}
                highlightColor={highlightColor}
                highlightMode={highlightMode}
                highlightBrush={highlightBrush}
                stampKey={stampKey}
                annotations={byPage.get(i) ?? EMPTY_ANNOTATIONS}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onCreate={addAnnotation}
                onUpdate={updateAnnotation}
                onRemove={removeAnnotation}
                // Passed through untouched: an inline filter here would mint a
                // fresh closure per render and defeat memo(AnnotatorPage) for
                // every page; the REVIEWED-only policy belongs to the shell.
                onReviewStamped={onReviewStamped}
              />
            ))}
          </div>
        )}
      </div>

        {status === 'ready' && panelOpen && (
          <AnnotationListPanel
            annotations={annotations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onJumpToPage={scrollToPageIndex}
            onRemove={handlePanelRemove}
          />
        )}
      </div>
    </div>
  );
}
