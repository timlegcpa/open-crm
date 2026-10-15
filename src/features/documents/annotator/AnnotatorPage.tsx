import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PDFJS_PARSE_TIMEOUT_MS, type PDFDocumentProxy } from '@/lib/pdfjs';
import {
  HIGHLIGHT_OPACITY,
  REVIEW_STAMP_META,
  REVIEW_STAMP_TYPO,
  STAMP_META,
  TEXT_MAX_LEN,
  isReviewStampKey,
  normalizeRect,
  reviewStampLines,
  reviewStampRect,
  round2,
  svgPathFromPoints,
  type AnnotationData,
  type AnnotationKind,
  type DocumentAnnotation,
  type HighlightData,
  type HighlightMode,
  type InkData,
  type ReviewStampData,
  type ReviewStampKey,
  type StampData,
  type StampKey,
  type TextData,
} from '../lib/annotations';
import type { PageMeta } from './useAnnotatorDoc';
import type { AnnotatorTool } from './AnnotatorToolbar';

// pdf.js page and viewport types, derived from the one type @/lib/pdfjs exports.
type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
type Viewport = ReturnType<PDFPageProxy['getViewport']>;

const INK_WIDTH_PT = 2;
const TEXT_FONT_SIZE_PT = 11;
const STAMP_SIZE_PT = 24;
// Per-stroke point cap: protects the DB's 64 KiB jsonb CHECK. Beyond the cap
// the stroke is decimated (drop every other point) and the capture throttle
// doubles so a minute-long stroke converges instead of growing unbounded.
const STROKE_POINT_CAP = 1500;
const STROKE_THROTTLE_MS = 15;
// Browser text top → pdf-lib baseline offset (line-height 1.25, Helvetica-ish
// ascent ≈ 0.75em): baseline ≈ top + 0.875 × fontSize.
const TEXT_BASELINE_RATIO = 0.875;
const SELECTION_STROKE = 'hsl(var(--primary))';

type Rect = { x: number; y: number; width: number; height: number };

interface TextDraft {
  pdfX: number;
  pdfY: number;
  value: string;
  createdId: string | null;
  color: string;
}

interface AnnotatorPageProps {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  meta: PageMeta;
  cssScale: number;
  tool: AnnotatorTool;
  inkColor: string;
  highlightColor: string;
  highlightMode: HighlightMode;
  highlightBrush: number;
  stampKey: StampKey | ReviewStampKey;
  annotations: DocumentAnnotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (pageIndex: number, kind: AnnotationKind, data: AnnotationData) => string;
  /** Fired after a review stamp is placed, so the shell can mirror it into
   * client_documents.reviewed_at. Placement itself stays local to the page. */
  onReviewStamped?: (stamp: ReviewStampKey) => void;
  onUpdate: (id: string, data: AnnotationData) => void;
  /** Fired when this page's render exceeds the decode deadline. The doc hook owns the
   * teardown, because only destroying the loading task stops a wedged WASM decoder. */
  onDecodeStall?: () => void;
  onRemove: (id: string) => void;
}

function translateAnnotationData(kind: AnnotationKind, data: AnnotationData, dx: number, dy: number): AnnotationData {
  if (kind === 'ink') {
    const d = data as InkData;
    return { ...d, points: d.points.map(([x, y]) => [round2(x + dx), round2(y + dy)] as [number, number]) };
  }
  // Every other kind (highlight, text, stamp, review_stamp) is anchored by a
  // single x/y, so one branch covers them: but a future kind that is NOT
  // x/y-anchored must get its own arm here rather than falling through.
  const d = data as HighlightData | TextData | StampData | ReviewStampData;
  return { ...d, x: round2(d.x + dx), y: round2(d.y + dy) };
}

/** Convert a PDF-space rect (bottom-left origin, unrotated) into a CSS-px rect via the logic viewport. */
function cssRectFromPdf(vp: Viewport, x: number, y: number, w: number, h: number): Rect {
  const p1 = vp.convertToViewportPoint(x, y);
  const p2 = vp.convertToViewportPoint(x + w, y + h);
  return normalizeRect([p1[0], p1[1]], [p2[0], p2[1]]);
}

function SelectionRect({ rect }: { rect: Rect }) {
  return (
    <rect
      x={rect.x - 3}
      y={rect.y - 3}
      width={rect.width + 6}
      height={rect.height + 6}
      fill="none"
      stroke={SELECTION_STROKE}
      strokeWidth={1.5}
      strokeDasharray="4 3"
      style={{ pointerEvents: 'none' }}
    />
  );
}

function AnnotatorPage({
  pdf,
  pageIndex,
  meta,
  cssScale,
  tool,
  inkColor,
  highlightColor,
  highlightMode,
  highlightBrush,
  stampKey,
  annotations,
  selectedId,
  onSelect,
  onCreate,
  onUpdate,
  onDecodeStall,
  onRemove,
  onReviewStamped,
}: AnnotatorPageProps) {
  const cssW = Math.floor(meta.widthPt * cssScale);
  const cssH = Math.floor(meta.heightPt * cssScale);
  const isSelectTool = tool === 'select';

  // ── Page proxy + logic viewport (CSS-px space; ALL coordinate math) ──
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  useEffect(() => {
    let cancelled = false;
    pdf
      .getPage(pageIndex + 1)
      .then((p) => {
        if (!cancelled) setPage(p);
      })
      .catch(() => {
        // Page-level failure: canvas stays blank; doc-level errors are handled upstream.
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex]);

  const logicViewport = useMemo<Viewport | null>(
    () => (page ? page.getViewport({ scale: cssScale }) : null),
    [page, cssScale],
  );

  // ── Windowed painting: only paint when within viewport ± ~2 pages ──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const margin = Math.max(600, Math.ceil(cssH * 2));
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: `${margin}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cssH]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible || !page) {
      // Un-paint far-offscreen canvases to bound memory on large PDFs.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    // Render viewport at cssScale × dpr: canvas painting ONLY; coordinate
    // conversions always go through the logic viewport (cssScale).
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const renderViewport = page.getViewport({ scale: cssScale * dpr });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    const context = canvas.getContext('2d');
    if (!context) return;
    const task = page.render({ canvasContext: context, viewport: renderViewport, canvas });
    // The decode deadline. `maxImageSize` bounds the image DICTIONARY, but pdf.js then
    // replaces those dimensions with the ones in the JPEG 2000 SIZ marker before handing
    // bytes to OpenJPEG: so a pathological codestream behind /Width 1 /Height 1 passes
    // the check and still reaches the decoder, here, during render. `task.cancel()` is a
    // flag the worker checks between operations and cannot preempt a wedged synchronous
    // decode, so the escalation is the hook's task teardown.
    let deadline: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      deadline = null;
      console.error('[annotator] page render exceeded the decode deadline', { pageNumber: page.pageNumber });
      onDecodeStall?.();
    }, PDFJS_PARSE_TIMEOUT_MS);
    const disarm = () => { if (deadline !== null) { clearTimeout(deadline); deadline = null; } };
    task.promise.then(disarm, disarm);
    task.promise.catch((err: unknown) => {
      // RenderingCancelledException on zoom/unmount is expected: ignore it.
      // Anything else is a REAL render failure (bad image filter, malformed
      // content stream, missing font), and pdf.js surfaces it only here. This
      // catch used to swallow every rejection, so such a failure painted a
      // blank white canvas with no console entry and no UI signal -- a document
      // that silently renders as nothing, which is indistinguishable from an
      // empty page. Never widen this back to a bare catch.
      const name = (err as { name?: string } | null)?.name;
      if (name === 'RenderingCancelledException') return;
      console.error('[annotator] page render failed', { pageNumber: page.pageNumber, err });
    });
    return () => {
      disarm();
      try {
        task.cancel();
      } catch {
        // ignore
      }
    };
  }, [visible, page, cssScale, onDecodeStall]);

  // ── Gesture state ──
  // `marker` distinguishes a freehand-highlight stroke from a pen stroke. It is
  // captured at pointer-DOWN, so switching mode mid-stroke can't change what the
  // in-flight stroke commits as.
  const strokeRef = useRef<{ points: [number, number][]; lastT: number; throttle: number; marker: boolean } | null>(null);
  const [liveStroke, setLiveStroke] = useState<[number, number][] | null>(null);
  // Mirrors strokeRef.current.marker for rendering. Held as state (not read off
  // the ref) so the preview stays pinned to what the stroke will COMMIT as, even
  // if the mode toggle is used mid-drag.
  const [liveStrokeIsMarker, setLiveStrokeIsMarker] = useState(false);
  const rectDragRef = useRef<{ start: [number, number] } | null>(null);
  const [liveRect, setLiveRect] = useState<Rect | null>(null);
  const moveRef = useRef<{ id: string; start: [number, number] } | null>(null);
  const [moveDelta, setMoveDelta] = useState<{ id: string; dx: number; dy: number } | null>(null);

  // ── Text draft (inline textarea; debounced upsert while typing) ──
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const draftTimerRef = useRef<number | null>(null);

  const applyDraft = useCallback((draft: TextDraft | null) => {
    textDraftRef.current = draft;
    setTextDraft(draft);
  }, []);

  const commitDraft = useCallback(
    (final: boolean) => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      const draft = textDraftRef.current;
      if (!draft) return;
      const data: TextData = {
        x: draft.pdfX,
        y: draft.pdfY,
        text: draft.value,
        color: draft.color,
        fontSize: TEXT_FONT_SIZE_PT,
      };
      if (!draft.createdId) {
        if (draft.value.trim().length > 0) {
          const id = onCreate(pageIndex, 'text', data);
          if (!final) applyDraft({ ...draft, createdId: id });
        }
      } else if (final && draft.value.trim().length === 0) {
        // Abandoned note: remove the row created by an earlier debounce tick.
        onRemove(draft.createdId);
      } else {
        onUpdate(draft.createdId, data);
      }
      if (final) applyDraft(null);
    },
    [onCreate, onUpdate, onRemove, pageIndex, applyDraft],
  );

  const commitDraftRef = useRef(commitDraft);
  useEffect(() => {
    commitDraftRef.current = commitDraft;
  }, [commitDraft]);

  // Switching away from the text tool commits the open draft.
  useEffect(() => {
    if (tool !== 'text' && textDraftRef.current) commitDraftRef.current(true);
  }, [tool]);

  // Flush a pending draft on unmount (closing the annotator mid-edit).
  useEffect(
    () => () => {
      commitDraftRef.current(true);
    },
    [],
  );

  const handleDraftChange = (value: string) => {
    const draft = textDraftRef.current;
    if (!draft) return;
    applyDraft({ ...draft, value: value.slice(0, TEXT_MAX_LEN) });
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => commitDraftRef.current(false), 800);
  };

  // ── Pointer handlers ──
  const toLocal = (e: React.PointerEvent): [number, number] => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? [e.clientX - rect.left, e.clientY - rect.top] : [0, 0];
  };

  const capturePointer = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!logicViewport) return;
    const target = e.target as Element;
    if (target.closest('textarea')) return; // the draft textarea owns its own events
    const pt = toLocal(e);

    if (tool === 'select') {
      const hit = target.closest('[data-annotation-id]');
      const id = hit?.getAttribute('data-annotation-id') ?? null;
      onSelect(id);
      if (id) {
        moveRef.current = { id, start: pt };
        capturePointer(e);
      }
      return;
    }
    if (tool === 'pen') {
      strokeRef.current = { points: [pt], lastT: performance.now(), throttle: STROKE_THROTTLE_MS, marker: false };
      setLiveStroke([pt]);
      setLiveStrokeIsMarker(false);
      capturePointer(e);
      return;
    }
    if (tool === 'highlight') {
      // Freehand marker reuses the pen's whole stroke pipeline (throttle, point
      // cap, decimation); only the committed data differs. `marker` is what the
      // pointer-up commit reads to decide colour/width/opacity.
      if (highlightMode === 'freehand') {
        strokeRef.current = { points: [pt], lastT: performance.now(), throttle: STROKE_THROTTLE_MS, marker: true };
        setLiveStroke([pt]);
        setLiveStrokeIsMarker(true);
      } else {
        rectDragRef.current = { start: pt };
        setLiveRect(null);
      }
      capturePointer(e);
      return;
    }
    if (tool === 'stamp') {
      // Review stamps ignore the cursor entirely: one click drops a dated mark
      // bottom-right of THIS page. Anchored to the page in
      // view rather than page 1: a stamp you can't see isn't feedback. Still
      // draggable afterward via the shared select/move path.
      if (isReviewStampKey(stampKey)) {
        // reviewStampRect works in DISPLAYED space (meta dims are post-/Rotate),
        // but storage is unrotated PDF space: so round-trip both corners through
        // the viewport exactly like the highlight drag does. Storing the displayed
        // rect raw put the stamp off-page on /Rotate 90/180/270 scans.
        const r = reviewStampRect(meta.widthPt, meta.heightPt);
        // Displayed pt (y-up) → viewport CSS px (y-down): (x·s, (H − y)·s).
        const a = logicViewport.convertToPdfPoint(r.x * cssScale, (meta.heightPt - r.y) * cssScale);
        const b = logicViewport.convertToPdfPoint(
          (r.x + r.width) * cssScale,
          (meta.heightPt - (r.y + r.height)) * cssScale,
        );
        onCreate(pageIndex, 'review_stamp', {
          ...normalizeRect([a[0], a[1]], [b[0], b[1]]),
          stamp: stampKey,
          stampedAt: new Date().toISOString(),
        });
        onReviewStamped?.(stampKey);
        return;
      }
      const [px, py] = logicViewport.convertToPdfPoint(pt[0], pt[1]);
      // StampData (x, y) = stamp box BOTTOM-LEFT corner in PDF space (locked
      // convention: the flatten anchors its y-down path at y + size).
      onCreate(pageIndex, 'stamp', {
        x: round2(px - STAMP_SIZE_PT / 2),
        y: round2(py - STAMP_SIZE_PT / 2),
        size: STAMP_SIZE_PT,
        stamp: stampKey,
      });
      return;
    }
    if (tool === 'text') {
      if (textDraftRef.current) {
        // A click outside the open draft just commits it: the next click places a new note.
        commitDraft(true);
        return;
      }
      const [px, py] = logicViewport.convertToPdfPoint(pt[0], pt[1]);
      applyDraft({ pdfX: round2(px), pdfY: round2(py), value: '', createdId: null, color: inkColor });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = toLocal(e);
    const stroke = strokeRef.current;
    if (stroke) {
      const now = performance.now();
      if (now - stroke.lastT < stroke.throttle) return;
      stroke.lastT = now;
      stroke.points.push(pt);
      if (stroke.points.length > STROKE_POINT_CAP) {
        stroke.points = stroke.points.filter((_, i, arr) => i % 2 === 0 || i === arr.length - 1);
        stroke.throttle *= 2;
      }
      setLiveStroke([...stroke.points]);
      return;
    }
    if (rectDragRef.current) {
      setLiveRect(normalizeRect(rectDragRef.current.start, pt));
      return;
    }
    if (moveRef.current) {
      setMoveDelta({
        id: moveRef.current.id,
        dx: pt[0] - moveRef.current.start[0],
        dy: pt[1] - moveRef.current.start[1],
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = logicViewport;
    const pt = toLocal(e);

    if (strokeRef.current) {
      const points = strokeRef.current.points;
      const marker = strokeRef.current.marker;
      strokeRef.current = null;
      setLiveStroke(null);
      if (vp && points.length >= 2) {
        const pdfPoints = points.map(([x, y]) => {
          const [px, py] = vp.convertToPdfPoint(x, y);
          return [round2(px), round2(py)] as [number, number];
        });
        // A marker is `ink` carrying an opacity: same kind, so no migration and
        // every existing consumer keeps working. See InkData's docstring.
        onCreate(
          pageIndex,
          'ink',
          marker
            ? { points: pdfPoints, color: highlightColor, width: highlightBrush, opacity: HIGHLIGHT_OPACITY }
            : { points: pdfPoints, color: inkColor, width: INK_WIDTH_PT },
        );
      }
      return;
    }
    if (rectDragRef.current) {
      const start = rectDragRef.current.start;
      rectDragRef.current = null;
      setLiveRect(null);
      if (vp && (Math.abs(pt[0] - start[0]) >= 3 || Math.abs(pt[1] - start[1]) >= 3)) {
        // Convert both drag corners, then normalize (rotation-aware).
        const a = vp.convertToPdfPoint(start[0], start[1]);
        const b = vp.convertToPdfPoint(pt[0], pt[1]);
        const rect = normalizeRect([a[0], a[1]], [b[0], b[1]]);
        if (rect.width >= 1 && rect.height >= 1) {
          onCreate(pageIndex, 'highlight', { ...rect, color: highlightColor });
        }
      }
      return;
    }
    if (moveRef.current) {
      const { id, start } = moveRef.current;
      moveRef.current = null;
      setMoveDelta(null);
      const dx = pt[0] - start[0];
      const dy = pt[1] - start[1];
      if (vp && (Math.abs(dx) >= 2 || Math.abs(dy) >= 2)) {
        const ann = annotations.find((a) => a.id === id);
        if (ann) {
          // Affine transform ⇒ a CSS-px delta maps to one consistent PDF-space delta.
          const p0 = vp.convertToPdfPoint(start[0], start[1]);
          const p1 = vp.convertToPdfPoint(pt[0], pt[1]);
          onUpdate(id, translateAnnotationData(ann.kind, ann.data, p1[0] - p0[0], p1[1] - p0[1]));
        }
      }
    }
  };

  const handlePointerCancel = () => {
    strokeRef.current = null;
    rectDragRef.current = null;
    moveRef.current = null;
    setLiveStroke(null);
    setLiveRect(null);
    setMoveDelta(null);
  };

  // ── Annotation rendering (SVG for ink/highlight/stamp, divs for text) ──
  const renderSvgAnnotation = (a: DocumentAnnotation) => {
    const vp = logicViewport;
    if (!vp) return null;
    const isSelected = a.id === selectedId;
    const delta = moveDelta && moveDelta.id === a.id ? moveDelta : null;
    const groupProps = {
      'data-annotation-id': a.id,
      transform: delta ? `translate(${delta.dx} ${delta.dy})` : undefined,
      style: {
        pointerEvents: (isSelectTool ? 'visiblePainted' : 'none') as React.CSSProperties['pointerEvents'],
        cursor: isSelectTool ? 'move' : undefined,
      },
    };

    if (a.kind === 'ink') {
      const d = a.data as InkData;
      const cssPoints = d.points.map(([x, y]) => {
        const [vx, vy] = vp.convertToViewportPoint(x, y);
        return [vx, vy] as [number, number];
      });
      const path = svgPathFromPoints(cssPoints);
      const xs = cssPoints.map((p) => p[0]);
      const ys = cssPoints.map((p) => p[1]);
      const bbox: Rect = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      return (
        <g key={a.id} {...groupProps}>
          {/* Transparent wide stroke = generous hit area for thin ink. The floor
              must clear the marker's own width or a 22pt brush is harder to grab
              than the 2pt pen it was sized for. */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(12, d.width * cssScale)}
          />
          <path
            d={path}
            fill="none"
            stroke={d.color}
            strokeWidth={d.width * cssScale}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={d.opacity ?? 1}
            // Multiply on the marker only: plain alpha over black text washes
            // the text out; multiply keeps it crisp, matching the flattened PDF.
            style={d.opacity === undefined ? undefined : { mixBlendMode: 'multiply' }}
          />
          {isSelected && <SelectionRect rect={bbox} />}
        </g>
      );
    }
    if (a.kind === 'highlight') {
      const d = a.data as HighlightData;
      const rect = cssRectFromPdf(vp, d.x, d.y, d.width, d.height);
      return (
        <g key={a.id} {...groupProps}>
          <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={d.color} fillOpacity={HIGHLIGHT_OPACITY} />
          {isSelected && <SelectionRect rect={rect} />}
        </g>
      );
    }
    if (a.kind === 'stamp') {
      const d = a.data as StampData;
      // (x, y) is the box's bottom-left in PDF space: convert both corners so
      // the visual box lands correctly on rotated pages too.
      const rect = cssRectFromPdf(vp, d.x, d.y, d.size, d.size);
      const scale = rect.width / 24 || 1;
      const stampMeta = STAMP_META[d.stamp];
      return (
        <g key={a.id} {...groupProps}>
          <g transform={`translate(${rect.x} ${rect.y}) scale(${scale})`}>
            <rect width={24} height={24} fill="transparent" />
            <path
              d={stampMeta.path}
              fill="none"
              stroke={stampMeta.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
          {isSelected && <SelectionRect rect={rect} />}
        </g>
      );
    }
    if (a.kind === 'review_stamp') {
      const d = a.data as ReviewStampData;
      const rect = cssRectFromPdf(vp, d.x, d.y, d.width, d.height);
      const meta = REVIEW_STAMP_META[d.stamp];
      const [label, when] = reviewStampLines(d);
      // Type scales with the box so zoom keeps the proportions of a real stamp.
      // Fractions shared with the flatten (REVIEW_STAMP_TYPO) so the export
      // matches this preview; baselines there are y-up, SVG is y-down.
      const labelSize = rect.height * REVIEW_STAMP_TYPO.labelSize;
      const whenSize = rect.height * REVIEW_STAMP_TYPO.whenSize;
      return (
        <g key={a.id} {...groupProps}>
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={rect.height * 0.12}
            fill="white"
            fillOpacity={0.75}
            stroke={meta.color}
            strokeWidth={Math.max(1, rect.height * 0.05)}
          />
          <text
            x={rect.x + rect.width / 2}
            y={rect.y + rect.height * (1 - REVIEW_STAMP_TYPO.labelBaseline)}
            textAnchor="middle"
            fill={meta.color}
            fontSize={labelSize}
            fontWeight={700}
            letterSpacing={labelSize * 0.06}
          >
            {label}
          </text>
          <text
            x={rect.x + rect.width / 2}
            y={rect.y + rect.height * (1 - REVIEW_STAMP_TYPO.whenBaseline)}
            textAnchor="middle"
            fill={meta.color}
            fontSize={whenSize}
          >
            {when}
          </text>
          {isSelected && <SelectionRect rect={rect} />}
        </g>
      );
    }
    return null; // text renders as positioned divs (wrapping)
  };

  const cursor =
    tool === 'pen' || tool === 'highlight' ? 'crosshair' : tool === 'text' ? 'text' : tool === 'stamp' ? 'copy' : 'default';

  const draftCss =
    textDraft && logicViewport ? logicViewport.convertToViewportPoint(textDraft.pdfX, textDraft.pdfY) : null;
  const draftFontSize = TEXT_FONT_SIZE_PT * cssScale;
  const draftNearLimit = textDraft ? textDraft.value.length >= TEXT_MAX_LEN - 200 : false;

  return (
    <div
      ref={containerRef}
      data-annotator-page={pageIndex}
      className="relative mx-auto mb-4 bg-card shadow-sm ring-1 ring-ring"
      style={{ width: cssW, height: cssH, cursor, touchAction: isSelectTool ? 'auto' : 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width: cssW, height: cssH }} />

      <svg className="absolute inset-0" width={cssW} height={cssH} style={{ pointerEvents: 'none' }} aria-hidden="true">
        {annotations.map(renderSvgAnnotation)}
        {/* The live preview must match what commits: a marker previewed as thin
            opaque ink and then landing fat and translucent reads as a bug. */}
        {liveStroke && (
          <path
            d={svgPathFromPoints(liveStroke)}
            fill="none"
            stroke={liveStrokeIsMarker ? highlightColor : inkColor}
            strokeWidth={(liveStrokeIsMarker ? highlightBrush : INK_WIDTH_PT) * cssScale}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={liveStrokeIsMarker ? HIGHLIGHT_OPACITY : 1}
            style={liveStrokeIsMarker ? { mixBlendMode: 'multiply' } : undefined}
          />
        )}
        {liveRect && (
          <rect x={liveRect.x} y={liveRect.y} width={liveRect.width} height={liveRect.height} fill={highlightColor} fillOpacity={HIGHLIGHT_OPACITY} />
        )}
      </svg>

      {/* Text annotations as divs so long notes wrap like the pdf-lib flatten does. */}
      {logicViewport &&
        annotations
          .filter((a) => a.kind === 'text')
          .map((a) => {
            const d = a.data as TextData;
            const [vx, vy] = logicViewport.convertToViewportPoint(d.x, d.y);
            const fontSize = d.fontSize * cssScale;
            const delta = moveDelta && moveDelta.id === a.id ? moveDelta : null;
            const isSelected = a.id === selectedId;
            return (
              <div
                key={a.id}
                data-annotation-id={a.id}
                className={isSelected ? 'ring-1 ring-primary ring-offset-1' : undefined}
                style={{
                  position: 'absolute',
                  left: vx,
                  top: vy - fontSize * TEXT_BASELINE_RATIO,
                  maxWidth: Math.max(60, cssW - vx - 8),
                  fontSize,
                  lineHeight: 1.25,
                  color: d.color,
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  pointerEvents: isSelectTool ? 'auto' : 'none',
                  cursor: isSelectTool ? 'move' : undefined,
                  userSelect: 'none',
                  transform: delta ? `translate(${delta.dx}px, ${delta.dy}px)` : undefined,
                }}
              >
                {d.text}
              </div>
            );
          })}

      {/* Inline textarea for a new text note. */}
      {textDraft && draftCss && (
        <div
          style={{
            position: 'absolute',
            left: draftCss[0],
            top: draftCss[1] - draftFontSize * TEXT_BASELINE_RATIO,
            width: Math.min(300, Math.max(140, cssW - draftCss[0] - 12)),
            zIndex: 10,
          }}
        >
          <textarea
            autoFocus
            value={textDraft.value}
            maxLength={TEXT_MAX_LEN}
            onChange={(e) => handleDraftChange(e.target.value)}
            onBlur={() => commitDraft(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="Type a note…"
            rows={3}
            className="w-full resize-none rounded-sm border border-primary bg-card/95 p-1.5 shadow-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ fontSize: draftFontSize, lineHeight: 1.25, color: textDraft.color, fontFamily: 'Helvetica, Arial, sans-serif' }}
          />
          {draftNearLimit && (
            <div className="mt-0.5 text-right text-[10px] tabular-nums text-warning">
              {textDraft.value.length} / {TEXT_MAX_LEN}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized: parent re-renders on scroll (page counter); with stable props the
// N-page list skips reconciliation work.
export default memo(AnnotatorPage);
