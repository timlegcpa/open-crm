import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FolderInput,
  Loader2,
  Menu,
  PenLine,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { toast } from '@/components/ui/sonner';
import { useAuth } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-mobile';
import { getErrorMessage } from '@/lib/errors';
import { links } from '@/features/links';
import {
  documentKeys,
  downloadDocument,
  folderKeys,
  moveDocument,
  moveFolder,
  previewDocument,
  setDocumentReviewed,
} from '../api';
import { refOf, type Section } from '../types';
import {
  HIGHLIGHT_BRUSHES,
  HIGHLIGHT_COLORS,
  INK_COLORS,
  type HighlightMode,
  type ReviewStampKey,
  type StampKey,
} from '../lib/annotations';
import {
  adjacentDocId,
  folderLabel,
  nextUnreviewedId,
  reconcileActiveId,
  resolveShortcut,
} from '../lib/documentWorkstation';
import { isAnnotatable, isPdf, isZoomableMime } from '../viewer/mime';
import WorkstationRail from './WorkstationRail';
import MoveDialog from '../explorer/MoveDialog';
import type { DialogTarget } from '../explorer/useExplorerState';
import { useWorkstationDocs, type WorkstationScope } from './useWorkstationDocs';
import type { AnnotatorTool } from '../annotator/AnnotatorToolbar';
import { ZOOM_FACTORS } from '../annotator/zoom';
import { ZOOM_STEPS, nextZoomStep, prevZoomStep } from '../viewer/zoom';

// Lazy: pdfjs and the docx/xlsx/csv renderers stay out of the entry chunk.
const PdfSurface = lazy(() => import('../annotator/PdfSurface'));
const PreviewSurface = lazy(() => import('../viewer/PreviewSurface'));

export interface DocumentWorkstationProps {
  contactId: string;
  contactName: string;
  initialDocId: string;
  initialScope: WorkstationScope;
  onClose: () => void;
  /** Contacts selectable from the header. OMIT to render the name as plain text:
   * a mount with no contact list has nothing to switch to. */
  clients?: Array<{ id: string; name: string }>;
  onClientChange?: (contactId: string, contactName: string) => void;
}

/**
 * Full-screen document workstation: rail + viewer + keyboard navigation.
 * Replaces the old single-document annotator overlay: annotation is now one
 * capability of this surface rather than a separate mode.
 */
export default function DocumentWorkstation({
  contactId,
  contactName,
  initialDocId,
  initialScope,
  onClose,
  clients,
  onClientChange,
}: DocumentWorkstationProps) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // Every listing, rail and count of documents and folders hangs off these two prefixes.
  const invalidateDocuments = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    void queryClient.invalidateQueries({ queryKey: folderKeys.all });
  }, [queryClient]);

  const [scope, setScope] = useState<WorkstationScope>(initialScope);
  const [activeId, setActiveId] = useState<string | null>(initialDocId);
  const [railOpen, setRailOpen] = useState(false);
  const [clientPickerOpen, setClientPickerOpen] = useState(false);

  // The switcher needs BOTH a list and a handler to do anything: without the
  // handler it would render a dropdown whose selections silently do nothing.
  const switchableClients = onClientChange ? (clients ?? []) : [];

  // Two zoom models: PdfSurface multiplies a fit-width base, PreviewSurface is
  // absolute on natural size. One shared number would carry 200%-of-fit-width
  // into 200%-of-natural-size when switching document types.
  const [zoomFactor, setZoomFactor] = useState(1);
  const [zoomAbsolute, setZoomAbsolute] = useState(1);

  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [deselectNonce, setDeselectNonce] = useState(0);
  const [scrollToPage, setScrollToPage] = useState(1);
  const [scrollToPageNonce, setScrollToPageNonce] = useState(0);
  const targetPageRef = useRef(1);

  // Tool state lives here, not in PdfSurface: it is per-session, so it must
  // survive an arrow-key document switch (which remounts the page list).
  const [tool, setTool] = useState<AnnotatorTool>('select');
  const [inkColor, setInkColor] = useState<string>(INK_COLORS[0]);
  const [highlightColor, setHighlightColor] = useState<string>(HIGHLIGHT_COLORS[0]);
  const [highlightMode, setHighlightMode] = useState<HighlightMode>('box');
  const [highlightBrush, setHighlightBrush] = useState<number>(HIGHLIGHT_BRUSHES[1]);
  const [stampKey, setStampKey] = useState<StampKey | ReviewStampKey>('reviewed');

  const { groups, ordered, isLoading } = useWorkstationDocs(contactId, scope);

  // Keep the active document valid across refetches (delete elsewhere, section
  // switch) so the body never fetches a dead id: and reset it on a client
  // switch, in the SAME effect. As two separate effects ([ordered] reconcile
  // then [contactId] reset) the reset ran last whenever the new client's list
  // was already cached (both fire in one commit), and `ordered`'s reference
  // never changed again: stranding the viewer on activeId=null ("No documents
  // in this section", dead arrow keys) until a rail row was clicked.
  //
  // On a client switch the remembered index resets too: reconcileActiveId falls
  // back to `ordered[min(previousIndex, len-1)]` when the id isn't found, so a
  // stale index would land on an ARBITRARY document in the new client's list
  // (index 7 of A becomes index 7 of B) rather than its first. Guarded by a ref
  // so the mount pass keeps `initialDocId`: resetting on first render would
  // discard the document we were asked to open on.
  const lastIndexRef = useRef(0);
  const firstContactRef = useRef(contactId);
  useEffect(() => {
    if (firstContactRef.current !== contactId) {
      firstContactRef.current = contactId;
      lastIndexRef.current = -1; // -1 ⇒ reconcileActiveId returns ordered[0]
      setActiveId(ordered.length > 0 ? reconcileActiveId(ordered, null, -1) : null);
      return;
    }
    if (ordered.length === 0) return;
    setActiveId((prev) => reconcileActiveId(ordered, prev, lastIndexRef.current));
  }, [contactId, ordered]);

  const activeIndex = ordered.findIndex((d) => d.id === activeId);
  useEffect(() => {
    if (activeIndex >= 0) lastIndexRef.current = activeIndex;
  }, [activeIndex]);

  const activeDoc = activeIndex >= 0 ? ordered[activeIndex] : null;
  // Images the annotator could not wrap fall back to the plain preview, per
  // document, for the life of the workstation.
  const [previewOnlyIds, setPreviewOnlyIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeAnnotatable = activeDoc
    ? isAnnotatable(activeDoc.mimeType) && !previewOnlyIds.has(activeDoc.id)
    : false;
  const handleCannotAnnotate = useCallback((docId: string) => {
    setPreviewOnlyIds((prev) => (prev.has(docId) ? prev : new Set(prev).add(docId)));
  }, []);
  const showReviewState = scope.heldBy === 'client';

  // ONE traversal for the arrow keys and the toolbar buttons. `adjacentDocId`
  // deliberately does not wrap around, so a null return is also the disabled
  // test: the buttons cannot disagree with the keys about where the ends are.
  const stepDoc = useCallback(
    (delta: 1 | -1) => {
      if (!activeId) return;
      const next = adjacentDocId(ordered, activeId, delta);
      if (next) setActiveId(next);
    },
    [ordered, activeId],
  );
  const prevDocId = activeId ? adjacentDocId(ordered, activeId, -1) : null;
  const nextDocId = activeId ? adjacentDocId(ordered, activeId, 1) : null;

  // Page counter resets per document.
  useEffect(() => {
    setPage(1);
    setPageCount(0);
    targetPageRef.current = 1;
  }, [activeId]);

  const handlePageChange = useCallback((p: number, total: number) => {
    setPage(p);
    setPageCount(total);
  }, []);

  // ── Review ──
  // Shared write path for both review controls. It takes the TARGET state, so
  // pressing twice never undoes itself. Returns false when the write failed so
  // callers can stop (e.g. not advance).
  const writeReview = useCallback(
    async (reviewed: boolean): Promise<boolean> => {
      if (!activeDoc || !userId) return false;
      try {
        await setDocumentReviewed(activeDoc.id, reviewed, userId);
      } catch (err) {
        toast.error('The review mark was not saved', { description: getErrorMessage(err) });
        return false;
      }
      invalidateDocuments();
      return true;
    },
    [activeDoc, userId, invalidateDocuments],
  );

  const markReviewed = useCallback(
    async (advance: boolean) => {
      if (!activeDoc || !userId || !showReviewState) return;
      // R MARKS, never toggles: an already reviewed document is left as it is.
      if (activeDoc.reviewedAt === null) {
        if (!(await writeReview(true))) return;
      }
      if (advance) {
        const next = nextUnreviewedId(ordered, activeDoc.id);
        if (next) setActiveId(next);
        else toast('All documents reviewed.');
      }
    },
    [activeDoc, userId, showReviewState, ordered, writeReview],
  );

  /**
   * A REVIEWED stamp is the same fact as the reviewed flag, expressed on the
   * page: so placing one marks the document reviewed (rail tick, next-unreviewed,
   * cache invalidation all come free via writeReview). APPROVED is a separate
   * sign-off step and deliberately does NOT mirror: this branch is the single
   * home of that policy (PdfSurface passes the stamp key through untouched).
   * Also deliberately one-way: deleting the stamp does NOT un-review, because
   * an undo must not silently rewind workflow state. Un-reviewing stays the
   * explicit header toggle.
   */
  const handleReviewStamped = useCallback(
    (stamp: ReviewStampKey) => {
      if (stamp !== 'reviewed') return;
      if (!activeDoc || !userId || !showReviewState) return;
      if (activeDoc.reviewedAt !== null) return; // already reviewed, nothing to write
      void writeReview(true);
    },
    [activeDoc, userId, showReviewState, writeReview],
  );

  const toggleReviewFromHeader = useCallback(async () => {
    if (!activeDoc || !userId || !showReviewState) return;
    await writeReview(activeDoc.reviewedAt === null);
  }, [activeDoc, userId, showReviewState, writeReview]);

  // ── Keyboard (window listener so Radix portals are reachable) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inTextEntry =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false);
      // The workstation's own root is `role="dialog"` (for a11y), so without the
      // `:not(...)` exclusion every keypress inside the workstation would match
      // its own overlay and every shortcut here would be permanently dead.
      const inOverlay = !!target?.closest?.(
        '[role="dialog"]:not([data-workstation-root]), [role="menu"], [role="alertdialog"]'
      );
      const action = resolveShortcut(e, { inTextEntry, inOverlay });
      if (!action) return;

      if (action.kind === 'doc') {
        if (!activeId) return;
        if (!adjacentDocId(ordered, activeId, action.delta)) return;
        e.preventDefault();
        stepDoc(action.delta);
        return;
      }
      if (action.kind === 'page') {
        if (!activeAnnotatable) return;
        e.preventDefault();
        // Advance from the last TARGET, not the scroll-reported page: during a
        // settling scroll consecutive presses would otherwise read a stale page.
        const max = Math.max(pageCount, 1);
        const next = Math.min(max, Math.max(1, targetPageRef.current + action.delta));
        targetPageRef.current = next;
        setScrollToPage(next);
        setScrollToPageNonce((n) => n + 1);
        return;
      }
      if (action.kind === 'review') {
        e.preventDefault();
        void markReviewed(action.advance);
        return;
      }
      // escape
      e.preventDefault();
      if (hasSelection) setDeselectNonce((n) => n + 1);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, ordered, activeAnnotatable, pageCount, hasSelection, markReviewed, onClose, stepDoc]);

  // Resizing below the tablet floor while open drops back to the inline flow , 
  // useIsMobile initialises undefined→false so it can't be trusted as a
  // render-time gate on its own.
  useEffect(() => {
    if (isMobile) onClose();
  }, [isMobile, onClose]);

  // ── Zoom ──
  const zoomSteps = activeAnnotatable ? ZOOM_FACTORS : ZOOM_STEPS;
  const zoom = activeAnnotatable ? zoomFactor : zoomAbsolute;
  const setZoom = activeAnnotatable ? setZoomFactor : setZoomAbsolute;
  const canZoom = activeDoc ? (activeAnnotatable || isZoomableMime(activeDoc.mimeType)) : false;

  const handleSectionChange = useCallback((heldBy: Section) => {
    setScope((prev) => (prev.kind === 'section' ? { kind: 'section', heldBy } : prev));
    setActiveId(null);
    lastIndexRef.current = 0;
  }, []);

  // ── Move ──
  // The folder page's own dialog and write (`client_document_move`), so a
  // move here is the same move there. A drag onto a folder heading in the
  // rail skips the dialog; the button reaches folders with no files in them.
  const [moveTarget, setMoveTarget] = useState<DialogTarget | null>(null);
  const moveFileTo = useCallback(
    async (docId: string, folderPath: string) => {
      try {
        await moveDocument(docId, folderPath);
      } catch (err) {
        toast.error('The document was not moved', { description: getErrorMessage(err) });
        return;
      }
      invalidateDocuments();
    },
    [invalidateDocuments],
  );
  const moveFolderTo = useCallback(
    async (folderId: string, parentPath: string) => {
      try {
        await moveFolder(folderId, parentPath);
      } catch (err) {
        toast.error('The folder was not moved', { description: getErrorMessage(err) });
        return;
      }
      invalidateDocuments();
    },
    [invalidateDocuments],
  );
  const moveDocTo = useCallback(
    (docId: string, folderPath: string) => {
      const doc = ordered.find((d) => d.id === docId);
      if (!doc || doc.folderPath === folderPath) return;
      void moveFileTo(docId, folderPath);
    },
    [ordered, moveFileTo],
  );

  const downloadActive = useCallback(async () => {
    if (!activeDoc) return;
    try {
      await downloadDocument(refOf({ id: activeDoc.id, original_filename: activeDoc.name, mime_type: activeDoc.mimeType }));
    } catch (err) {
      toast.error('The download failed', { description: getErrorMessage(err) });
    }
  }, [activeDoc]);

  const railNode = (
    <WorkstationRail
      onMoveDoc={moveDocTo}
      groups={groups}
      activeId={activeId}
      scope={scope}
      showReviewState={showReviewState}
      onSelect={(id) => {
        setActiveId(id);
        setRailOpen(false);
      }}
      onSectionChange={handleSectionChange}
    />
  );

  return (
    <div
      role="dialog"
      data-workstation-root
      aria-modal="true"
      aria-label="Document workstation"
      className="fixed inset-0 z-50 flex flex-col bg-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={() => setRailOpen((o) => !o)}
          aria-label="Toggle document list"
        >
          <Menu />
        </Button>

        {/* A labelled way out. The bare X on the far right was the only exit and
            read as "dismiss", not "back to my documents". */}
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <ArrowLeft />
          Documents
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-1">
          {switchableClients.length > 0 ? (
            <Popover open={clientPickerOpen} onOpenChange={setClientPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  role="combobox"
                  aria-expanded={clientPickerOpen}
                  className="shrink-0 text-sm font-medium"
                >
                  <span className="max-w-[220px] truncate">{contactName}</span>
                  <ChevronsUpDown className="shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search contacts" />
                  <CommandList>
                    <CommandEmpty>No contacts found.</CommandEmpty>
                    <CommandGroup>
                      {switchableClients.map((c) => (
                        <CommandItem
                          key={c.id}
                          value={c.name}
                          onSelect={() => {
                            setClientPickerOpen(false);
                            if (c.id !== contactId) onClientChange?.(c.id, c.name);
                          }}
                        >
                          <Check
                            className={`mr-2 size-3.5 ${c.id === contactId ? 'opacity-100' : 'opacity-0'}`}
                          />
                          <span className="truncate">{c.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : (
            <span className="shrink-0 truncate text-sm font-medium text-foreground">
              {contactName}
            </span>
          )}

          {activeDoc && (
            <span
              className="min-w-0 truncate text-sm text-muted-foreground"
              title={activeDoc.name}
            >
              {folderLabel(activeDoc.folderPath)} · {activeDoc.name}
            </span>
          )}
        </div>

        {/* Document traversal. The arrow keys have always done this; nothing on
            screen said so, and nothing said where in the stack you were.
            Shown for a single document too, disabled at both ends: "1 of 1" is
            the answer to "is there anything else in here", and hiding the
            control makes that question unanswerable. */}
        {ordered.length > 0 && (
          <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-border pl-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => stepDoc(-1)}
              disabled={!prevDocId}
              title="Previous document (Up arrow)"
              aria-label="Previous document"
            >
              <ChevronLeft />
              Back
            </Button>
            <span className="min-w-[4.5rem] whitespace-nowrap text-center text-xs tabular-nums text-muted-foreground">
              {activeIndex >= 0 ? `${activeIndex + 1} of ${ordered.length}` : `${ordered.length} docs`}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => stepDoc(1)}
              disabled={!nextDocId}
              title="Next document (Down arrow)"
              aria-label="Next document"
            >
              Next
              <ChevronRight />
            </Button>
          </div>
        )}

        {activeAnnotatable && pageCount > 0 && (
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            Page {page} of {pageCount}
          </span>
        )}

        {canZoom && (
          <div className="ml-1 flex items-center gap-0.5 border-l border-border pl-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setZoom((z) => prevZoomStep(zoomSteps, z))}
              title="Zoom out"
              aria-label="Zoom out"
              disabled={zoom <= zoomSteps[0]}
            >
              <ZoomOut />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setZoom(1)}
              className="min-w-[3.25rem] justify-center tabular-nums text-muted-foreground"
              title={activeAnnotatable ? 'Fit page' : 'Reset zoom'}
            >
              {Math.round(zoom * 100)}%
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setZoom((z) => nextZoomStep(zoomSteps, z))}
              title="Zoom in"
              aria-label="Zoom in"
              disabled={zoom >= zoomSteps[zoomSteps.length - 1]}
            >
              <ZoomIn />
            </Button>
          </div>
        )}

        {activeDoc && showReviewState && (
          <Button
            variant="ghost"
            size="icon-sm"
            className={
              activeDoc.reviewedAt
                ? 'text-success-dark hover:text-success-dark'
                : 'text-muted-foreground'
            }
            onClick={() => void toggleReviewFromHeader()}
            title={activeDoc.reviewedAt ? 'Mark as unreviewed' : 'Mark as reviewed'}
            aria-label={activeDoc.reviewedAt ? 'Mark as unreviewed' : 'Mark as reviewed'}
          >
            {activeDoc.reviewedAt ? <CheckCheck /> : <Check />}
          </Button>
        )}

        {activeDoc && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              setMoveTarget({ id: activeDoc.id, name: activeDoc.name, type: 'file', contactId, heldBy: scope.heldBy })
            }
            title="Move to another folder"
          >
            <FolderInput />
            Move
          </Button>
        )}

        {activeDoc && scope.heldBy === 'owner' && isPdf(activeDoc.mimeType) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => navigate(links.newEnvelope({ contactId, documentId: activeDoc.id }))}
            title="Send this document for signature"
          >
            <PenLine />
            Send for signature
          </Button>
        )}

        {activeDoc && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void downloadActive()}
            title="Download"
            aria-label="Download"
          >
            <Download />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close document workstation"
        >
          <X />
        </Button>
      </div>

      {/* Rail + body */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden lg:flex">{railNode}</div>

        {railOpen && (
          <>
            <button
              type="button"
              aria-label="Close document list"
              className="fixed inset-0 z-10 bg-foreground/20 lg:hidden"
              onClick={() => setRailOpen(false)}
            />
            <div className="fixed bottom-0 left-0 top-[45px] z-20 lg:hidden">{railNode}</div>
          </>
        )}

        <div className="min-h-0 min-w-0 flex-1">
          {isLoading && (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && !activeDoc && (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <p className="text-sm text-muted-foreground">No documents in this section.</p>
            </div>
          )}

          {activeDoc && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              {activeAnnotatable ? (
                <PdfSurface
                  doc={{
                    id: activeDoc.id,
                    name: activeDoc.name,
                    contactId,
                    folderPath: activeDoc.folderPath,
                    reviewedAt: activeDoc.reviewedAt,
                  }}
                  zoomFactor={zoomFactor}
                  tool={tool}
                  inkColor={inkColor}
                  highlightColor={highlightColor}
                  highlightMode={highlightMode}
                  highlightBrush={highlightBrush}
                  stampKey={stampKey}
                  onReviewStamped={handleReviewStamped}
                  onToolChange={setTool}
                  onInkColorChange={setInkColor}
                  onHighlightColorChange={setHighlightColor}
                  onHighlightModeChange={setHighlightMode}
                  onHighlightBrushChange={setHighlightBrush}
                  onStampKeyChange={setStampKey}
                  onPageChange={handlePageChange}
                  onSelectionChange={setHasSelection}
                  deselectSignal={deselectNonce}
                  scrollToPage={scrollToPage}
                  scrollToPageNonce={scrollToPageNonce}
                  onCannotAnnotate={handleCannotAnnotate}
                />
              ) : (
                <PreviewSurface
                  docId={activeDoc.id}
                  name={activeDoc.name}
                  fallbackMimeType={activeDoc.mimeType}
                  zoom={zoomAbsolute}
                  onDownload={() => void downloadActive()}
                  onLoadPreview={() => previewDocument(refOf({ id: activeDoc.id, original_filename: activeDoc.name, mime_type: activeDoc.mimeType }))}
                />
              )}
            </Suspense>
          )}
        </div>

        <MoveDialog
          target={moveTarget}
          onClose={() => setMoveTarget(null)}
          onMoveFile={moveFileTo}
          onMoveFolder={moveFolderTo}
        />

      </div>
    </div>
  );
}
