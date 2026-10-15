import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Loader2, PenLine, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { getDocuments, getFields, getPages, getSigners, setSignerFields, type SignerWithContact } from '../api';
import type { FieldInput, FieldType } from '../contract';
import { esignKeys } from '../keys';
import { canvasToPdf, pdfToCanvas, type CanvasRect } from '../lib/coords';
import { moveRect, newServerFields, placeAt, resizeRect, type Handle, type PlacedField } from '../lib/fieldPlacement';
import { openPdf, type RenderedPage } from '../lib/pdfRender';
import { colorForIndex, type SignerColor } from '../lib/signerColors';
import { resolveSignerName } from '../lib/signerName';
import { TemplateControls } from './TemplateControls';
import { useWorkingUrls } from './useWorkingUrls';

/** Canvas width at 100%; a US letter page (612 pt) reads at about 1.18x. */
const BASE_CANVAS_WIDTH = 720;
const ZOOM_LEVELS = [1, 1.25, 1.5] as const;
/** The idle gap after the last edit. Never fires mid-gesture: a drag holds it off. */
const AUTOSAVE_DEBOUNCE_MS = 1500;

type Mode = 'idle' | FieldType;
type FieldsBySigner = Record<string, PlacedField[]>;

let localSeq = 0;
const makeLocalId = () => `local-${(localSeq += 1)}`;

const HANDLES: { key: Handle; style: CSSProperties; cursor: string }[] = [
  { key: 'n', style: { top: -4, left: '50%', transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
  { key: 's', style: { bottom: -4, left: '50%', transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
  { key: 'e', style: { right: -4, top: '50%', transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
  { key: 'w', style: { left: -4, top: '50%', transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
  { key: 'ne', style: { top: -4, right: -4 }, cursor: 'nesw-resize' },
  { key: 'nw', style: { top: -4, left: -4 }, cursor: 'nwse-resize' },
  { key: 'se', style: { bottom: -4, right: -4 }, cursor: 'nwse-resize' },
  { key: 'sw', style: { bottom: -4, left: -4 }, cursor: 'nwse-resize' },
];

/**
 * Place each signer's signature and date boxes on the pages. The PDF rect is the source of
 * truth; the canvas rect is derived at the current zoom. Saves are a server-side replace of
 * one signer's fields, so: one save at a time per signer (an older snapshot finishing last
 * would overwrite a newer one), an edit made during a save keeps the signer dirty (a
 * revision counter, not a flag), and leaving the step flushes whatever is unsaved.
 */
export function FieldPlacer({ envelopeId }: { envelopeId: string }) {
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: esignKeys.documents(envelopeId), queryFn: () => getDocuments(envelopeId) });
  const pages = useQuery({ queryKey: esignKeys.pages(envelopeId), queryFn: () => getPages(envelopeId) });
  const signersQuery = useQuery({ queryKey: esignKeys.signers(envelopeId), queryFn: () => getSigners(envelopeId) });
  const serverFields = useQuery({ queryKey: esignKeys.fields(envelopeId), queryFn: () => getFields(envelopeId) });
  const urls = useWorkingUrls(envelopeId, documents.data ?? []);

  const signers = useMemo(() => signersQuery.data ?? [], [signersQuery.data]);
  const visiblePages = useMemo(() => (pages.data ?? []).filter((p) => !p.deleted).sort((a, b) => a.order - b.order), [pages.data]);

  const [activeSignerId, setActiveSignerId] = useState<string | null>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('idle');
  const [zoomIndex, setZoomIndex] = useState(1);
  const zoom = ZOOM_LEVELS[zoomIndex];
  const targetWidth = Math.round(BASE_CANVAS_WIDTH * zoom);

  useEffect(() => {
    if (signers.length === 0) return;
    if (!activeSignerId || !signers.some((s) => s.id === activeSignerId)) setActiveSignerId(signers[0].id);
  }, [activeSignerId, signers]);

  useEffect(() => {
    if (activePageIndex >= visiblePages.length && visiblePages.length > 0) setActivePageIndex(0);
  }, [activePageIndex, visiblePages.length]);

  const activePage = visiblePages[activePageIndex];
  const activeUrl = activePage ? urls[activePage.source_document_id] : undefined;

  // ── Page rendering ──────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!activePage || !activeUrl || !canvas) return;
    let cancelled = false;
    setRendering(true);
    setRenderError(null);
    const pdf = openPdf({ url: activeUrl });
    pdf
      .renderPage(activePage.source_page_index, targetWidth, canvas)
      .then((meta) => {
        if (cancelled) return;
        setRendered(meta);
        setRendering(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A wedged decoder is torn down by the watchdog, which lands here: no endless spinner.
        setRenderError(getErrorMessage(err, 'This page could not be shown.'));
        setRendering(false);
      });
    return () => {
      cancelled = true;
      pdf.destroy();
    };
  }, [activePage, activeUrl, targetWidth]);

  // ── Local layout ────────────────────────────────────────────
  const [fields, setFields] = useState<FieldsBySigner>({});
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const revisionRef = useRef<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [saving, setSaving] = useState(0);
  const [savedOnce, setSavedOnce] = useState(false);

  const markDirty = useCallback((signerId: string) => {
    revisionRef.current[signerId] = (revisionRef.current[signerId] ?? 0) + 1;
    setDirty((prev) => (prev.has(signerId) ? prev : new Set(prev).add(signerId)));
  }, []);

  // Merge the server's fields in, never over: see newServerFields.
  useEffect(() => {
    if (!serverFields.data) return;
    const local = Object.values(fieldsRef.current).flat();
    const additions = newServerFields(serverFields.data, local, visiblePages);
    if (additions.length === 0) return;
    setFields((prev) => {
      const next = { ...prev };
      for (const a of additions) next[a.signerId] = [...(next[a.signerId] ?? []), a];
      return next;
    });
  }, [serverFields.data, visiblePages]);

  // ── Saving ──────────────────────────────────────────────────
  const saveNow = useCallback(
    async (signerId: string, silent: boolean) => {
      const revisionAtStart = revisionRef.current[signerId] ?? 0;
      const list = fieldsRef.current[signerId] ?? [];
      const inputs: FieldInput[] = list.map((f) => ({
        page_index: f.pageIndex,
        field_type: f.fieldType,
        x: f.pdf.x,
        y: f.pdf.y,
        width: f.pdf.width,
        height: f.pdf.height,
      }));
      const localIds = list.map((f) => f.localId);
      setSaving((n) => n + 1);
      try {
        const result = await setSignerFields(envelopeId, signerId, inputs);
        // A save rotates every id: rebind them, or the next refetch reads as new fields.
        if (result.inserted_ids.length === localIds.length) {
          const remote = new Map(localIds.map((id, i) => [id, result.inserted_ids[i]] as const));
          setFields((prev) => ({
            ...prev,
            [signerId]: (prev[signerId] ?? []).map((f) => (remote.has(f.localId) ? { ...f, remoteId: remote.get(f.localId) } : f)),
          }));
        }
        // Edited again while this save ran: stay dirty, so the debounce runs once more.
        if ((revisionRef.current[signerId] ?? 0) === revisionAtStart) {
          setDirty((prev) => {
            if (!prev.has(signerId)) return prev;
            const next = new Set(prev);
            next.delete(signerId);
            return next;
          });
        }
        setSavedOnce(true);
        if (!silent) toast.success(`${inputs.length} field${inputs.length === 1 ? '' : 's'} saved for this signer.`);
        void queryClient.invalidateQueries({ queryKey: esignKeys.fields(envelopeId) });
      } catch (err) {
        toast.error(getErrorMessage(err, 'The fields were not saved. Try again.'));
        throw err;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [envelopeId, queryClient],
  );

  // One save at a time per signer; a queued save reads the layout when it STARTS.
  const chainRef = useRef<Record<string, Promise<void>>>({});
  const save = useCallback(
    (signerId: string, silent = true) => {
      const previous = chainRef.current[signerId] ?? Promise.resolve();
      const run = previous.then(() => saveNow(signerId, silent));
      chainRef.current[signerId] = run.catch(() => undefined);
      return run;
    },
    [saveNow],
  );

  const flushAll = useCallback(async () => {
    await Promise.all([...dirtyRef.current].map((id) => save(id)));
  }, [save]);

  useEffect(() => {
    if (!activeSignerId || !dirty.has(activeSignerId) || interacting) return;
    const handle = window.setTimeout(() => void save(activeSignerId).catch(() => undefined), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [activeSignerId, dirty, interacting, save]);

  // Switching signer or page saves what was left behind.
  const previousSignerRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousSignerRef.current;
    if (previous && previous !== activeSignerId && dirtyRef.current.has(previous)) void save(previous).catch(() => undefined);
    previousSignerRef.current = activeSignerId;
  }, [activeSignerId, save]);
  const previousPageRef = useRef(activePageIndex);
  useEffect(() => {
    if (previousPageRef.current === activePageIndex) return;
    previousPageRef.current = activePageIndex;
    void flushAll().catch(() => undefined);
  }, [activePageIndex, flushAll]);

  // The composer unmounts this step on every step change; a drag then "Next" inside the
  // debounce window would otherwise drop the move.
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;
  useEffect(() => () => void flushRef.current().catch(() => undefined), []);

  // ── Editing ─────────────────────────────────────────────────
  const canvasSize = rendered ? { width: rendered.canvasWidthPx, height: rendered.canvasHeightPx } : null;

  const toCanvas = useCallback(
    (f: PlacedField): CanvasRect | null =>
      rendered ? pdfToCanvas(f.pdf, rendered.pageWidthPt, rendered.pageHeightPt, rendered.canvasWidthPx, rendered.canvasHeightPx) : null,
    [rendered],
  );

  const setRect = useCallback(
    (signerId: string, localId: string, rect: CanvasRect) => {
      if (!rendered) return;
      const pdf = canvasToPdf(rect, rendered.pageWidthPt, rendered.pageHeightPt, rendered.canvasWidthPx, rendered.canvasHeightPx);
      setFields((prev) => ({ ...prev, [signerId]: (prev[signerId] ?? []).map((f) => (f.localId === localId ? { ...f, pdf } : f)) }));
      markDirty(signerId);
    },
    [rendered, markDirty],
  );

  const removeField = useCallback(
    (signerId: string, localId: string) => {
      setFields((prev) => ({ ...prev, [signerId]: (prev[signerId] ?? []).filter((f) => f.localId !== localId) }));
      markDirty(signerId);
      setSelectedId((cur) => (cur === localId ? null : cur));
    },
    [markDirty],
  );

  const onOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode === 'idle') {
      setSelectedId(null);
      return;
    }
    if (!activeSignerId || !activePage || !rendered || !canvasSize || !overlayRef.current) return;
    const box = overlayRef.current.getBoundingClientRect();
    const rect = placeAt(mode, e.clientX - box.left, e.clientY - box.top, canvasSize);
    const pdf = canvasToPdf(rect, rendered.pageWidthPt, rendered.pageHeightPt, rendered.canvasWidthPx, rendered.canvasHeightPx);
    const field: PlacedField = {
      localId: makeLocalId(),
      signerId: activeSignerId,
      pageId: activePage.id,
      pageIndex: activePageIndex,
      fieldType: mode,
      pdf,
    };
    setFields((prev) => ({ ...prev, [activeSignerId]: [...(prev[activeSignerId] ?? []), field] }));
    markDirty(activeSignerId);
    setMode('idle');
  };

  const startGesture = (e: ReactPointerEvent, field: PlacedField, handle: Handle | null) => {
    e.stopPropagation();
    e.preventDefault();
    const origin = toCanvas(field);
    if (!origin || !canvasSize) return;
    setSelectedId(field.localId);
    setInteracting(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setRect(field.signerId, field.localId, handle ? resizeRect(origin, handle, dx, dy, canvasSize) : moveRect(origin, dx, dy, canvasSize));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setInteracting(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Delete or Backspace removes the selected box; Escape deselects. Never while typing.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'Escape') {
        setSelectedId(null);
        setMode('idle');
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const sel = selectedRef.current;
      if (!sel) return;
      for (const [signerId, list] of Object.entries(fieldsRef.current)) {
        if (list.some((f) => f.localId === sel)) {
          e.preventDefault();
          removeField(signerId, sel);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeField]);

  // ── Render ──────────────────────────────────────────────────
  const counts = signers.map((s) => ({ signer: s, count: (fields[s.id] ?? []).length }));
  const everyoneHasOne = counts.length > 0 && counts.every((c) => c.count > 0);

  const onPage = useMemo(() => {
    if (!activePage) return [] as { field: PlacedField; color: SignerColor; name: string; rect: CanvasRect }[];
    const out: { field: PlacedField; color: SignerColor; name: string; rect: CanvasRect }[] = [];
    signers.forEach((s: SignerWithContact, idx) => {
      for (const f of fields[s.id] ?? []) {
        if (f.pageId !== activePage.id) continue;
        const rect = toCanvas(f);
        if (rect) out.push({ field: f, color: colorForIndex(idx), name: resolveSignerName(s), rect });
      }
    });
    return out;
  }, [activePage, fields, signers, toCanvas]);

  if (documents.isPending || pages.isPending || signersQuery.isPending || serverFields.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading the layout" />
      </div>
    );
  }
  const loadError = documents.error ?? pages.error ?? signersQuery.error ?? serverFields.error;
  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the layout: {getErrorMessage(loadError)}
      </p>
    );
  }
  if (signers.length === 0) {
    return <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Add a signer before placing fields.</p>;
  }
  if (visiblePages.length === 0) {
    return <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No pages yet. Upload a PDF first.</p>;
  }

  const status = saving > 0 ? 'Saving...' : dirty.size > 0 ? 'Unsaved changes' : savedOnce ? 'Saved' : 'Saves as you go';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="status"
        className={cn(
          'rounded-md border px-4 py-3 text-sm',
          everyoneHasOne ? 'border-success bg-success-light text-success-dark' : 'border-warning bg-warning-light text-warning-dark',
        )}
      >
        <div className="font-medium">{everyoneHasOne ? 'Every signer has a field.' : 'Each signer needs at least one field before sending.'}</div>
        <div className="mt-1 text-xs">
          {counts.map((c) => `${resolveSignerName(c.signer)}: ${c.count} field${c.count === 1 ? '' : 's'}`).join(', ')}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Signer to place fields for">
          {signers.map((s, idx) => {
            const color = colorForIndex(idx);
            const active = s.id === activeSignerId;
            return (
              <Button
                key={s.id}
                type="button"
                variant="outline"
                onClick={() => setActiveSignerId(s.id)}
                aria-pressed={active}
                className={cn(
                  'h-auto gap-2 rounded-full px-3 py-1.5 text-sm font-normal',
                  active ? `${color.border} ${color.bg} ${color.text} font-medium` : 'text-muted-foreground',
                )}
              >
                <span className={cn('size-2.5 rounded-full', color.swatch)} aria-hidden="true" />
                {resolveSignerName(s)}
                {dirty.has(s.id) && <span className="text-[10px] text-warning-dark">unsaved</span>}
              </Button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant={mode === 'signature' ? 'default' : 'outline'} aria-pressed={mode === 'signature'} onClick={() => setMode((m) => (m === 'signature' ? 'idle' : 'signature'))}>
            <PenLine aria-hidden="true" />
            Add signature
          </Button>
          <Button type="button" size="sm" variant={mode === 'date' ? 'default' : 'outline'} aria-pressed={mode === 'date'} onClick={() => setMode((m) => (m === 'date' ? 'idle' : 'date'))}>
            <CalendarDays aria-hidden="true" />
            Add date
          </Button>
          {mode !== 'idle' && <span className="text-xs text-muted-foreground">Click the page to drop the field.</span>}
          <div className="flex-1" />
          <div className="flex items-center gap-1 rounded-md border border-border px-1 py-0.5">
            <Button type="button" size="icon-xs" variant="ghost" onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0} aria-label="Zoom out">
              <ZoomOut aria-hidden="true" />
            </Button>
            <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              aria-label="Zoom in"
            >
              <ZoomIn aria-hidden="true" />
            </Button>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {status}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => activeSignerId && void save(activeSignerId, false).catch(() => undefined)}
            disabled={!activeSignerId || saving > 0}
          >
            Save now
          </Button>
          <TemplateControls envelopeId={envelopeId} hasCoSigner={signers.some((s) => s.role === 'co_signer')} onBeforeTemplateAction={flushAll} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Page">
        <span className="text-xs font-medium text-muted-foreground">Page</span>
        {visiblePages.map((p, idx) => (
          <Button
            key={p.id}
            type="button"
            size="xs"
            variant={idx === activePageIndex ? 'default' : 'outline'}
            onClick={() => setActivePageIndex(idx)}
            aria-pressed={idx === activePageIndex}
            aria-label={`Page ${idx + 1}`}
          >
            {idx + 1}
          </Button>
        ))}
      </div>

      <div className="min-w-0 rounded-md border border-border bg-muted/30 p-3">
        <ScrollArea horizontal>
          {renderError && (
            <p role="alert" className="p-6 text-sm text-destructive">
              {renderError}
            </p>
          )}
          <div className="relative inline-block">
            <canvas ref={canvasRef} className={cn('block bg-card', rendering && 'opacity-30')} />
            {rendering && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Drawing the page" />
              </div>
            )}
            <div
              ref={overlayRef}
              onClick={onOverlayClick}
              className={cn('absolute inset-0', mode !== 'idle' ? 'cursor-crosshair' : 'cursor-default')}
              style={{ width: rendered?.canvasWidthPx, height: rendered?.canvasHeightPx, touchAction: interacting ? 'none' : undefined }}
            >
              {onPage.map(({ field, color, name, rect }) => {
                const selected = field.localId === selectedId;
                return (
                  <div
                    key={field.localId}
                    onPointerDown={(e) => startGesture(e, field, null)}
                    onClick={(e) => e.stopPropagation()}
                    className={cn('group absolute cursor-move select-none border-2', color.border, color.bg, selected && 'ring-2 ring-ring ring-offset-1')}
                    style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, touchAction: 'none' }}
                  >
                    <span className={cn('pointer-events-none absolute inset-0 flex items-center justify-center truncate px-1 text-[12px] font-medium', color.text)}>
                      {field.fieldType === 'signature' ? 'Signature' : 'Date'} · {name}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Remove ${field.fieldType === 'signature' ? 'signature' : 'date'} field for ${name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeField(field.signerId, field.localId);
                      }}
                      className={cn(
                        'absolute -right-2 -top-2 size-5 rounded-full bg-card text-muted-foreground shadow',
                        selected ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
                      )}
                    >
                      <X aria-hidden="true" />
                    </Button>
                    {HANDLES.map((h) => (
                      <div
                        key={h.key}
                        aria-hidden="true"
                        onPointerDown={(e) => startGesture(e, field, h.key)}
                        className="absolute size-2 rounded-sm border border-border bg-card"
                        style={{ ...h.style, cursor: h.cursor }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
