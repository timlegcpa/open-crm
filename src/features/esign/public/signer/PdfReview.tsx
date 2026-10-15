import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { downloadBlob } from '@/lib/download';
import { cn } from '@/lib/utils';
import type { AdoptedSignature, ResolvedSigner } from '../../contract';
import { pdfToCanvas } from '../../lib/coords';
import { openPdf, type OpenedPdf, type RenderedPage } from '../../lib/pdfRender';
import { esignSafeFilename } from '../../lib/safeFilename';
import { fontFamilyForKey, SIGNATURE_INK } from '../../lib/signatureFonts';
import '../../fonts/signatureFonts.css';
import { buildSignRequest, sign, signerTimezone, SESSION_EXPIRED, viewPdf } from './signerApi';
import { SignatureModal } from './SignatureModal';

const MAX_PAGE_WIDTH = 720;

type Field = ResolvedSigner['fields'][number];

function todayText(): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** The width pages render at: the column, never wider than the page or the screen. */
function useColumnWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(MAX_PAGE_WIDTH, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function PageView({
  pdf,
  index,
  width,
  fields,
  signature,
  today,
  onSignatureField,
}: {
  pdf: OpenedPdf;
  index: number;
  width: number;
  fields: Field[];
  signature: AdoptedSignature | null;
  today: string;
  onSignatureField: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meta, setMeta] = useState<RenderedPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    let cancelled = false;
    pdf
      .renderPage(index, width, canvas)
      .then((m) => !cancelled && setMeta(m))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [pdf, index, width]);

  return (
    <div className="relative mx-auto mb-6 max-w-full border border-border bg-card shadow-sm" style={{ width: meta?.canvasWidthPx ?? width }}>
      {!meta && !failed && (
        <div className="flex items-center justify-center" style={{ height: Math.round(width * 1.29) }}>
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={`Drawing page ${index + 1}`} />
        </div>
      )}
      {failed && <p className="p-6 text-center text-sm text-destructive">Page {index + 1} could not be shown.</p>}
      <canvas ref={canvasRef} className={meta ? 'block' : 'hidden'} aria-label={`Page ${index + 1}`} role="img" />
      {meta &&
        fields.map((f) => {
          const r = pdfToCanvas(f, meta.pageWidthPt, meta.pageHeightPt, meta.canvasWidthPx, meta.canvasHeightPx);
          const style: CSSProperties = { position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h };
          if (f.field_type === 'signature') {
            return (
              <button
                key={f.id}
                type="button"
                style={style}
                onClick={onSignatureField}
                aria-label={signature ? 'Change your signature' : 'Sign here'}
                className={cn(
                  'flex items-center justify-center overflow-hidden rounded border px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  signature ? 'border-warning bg-warning/10' : 'border-2 border-dashed border-warning bg-warning/20 text-[11px] font-medium text-warning-dark',
                )}
              >
                {!signature ? (
                  'Sign here'
                ) : signature.kind === 'drawn' ? (
                  <img src={`data:image/png;base64,${signature.image_base64}`} alt="Your signature" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span
                    className="truncate leading-none"
                    style={{ fontFamily: fontFamilyForKey(signature.font_key), fontSize: Math.max(12, Math.floor(r.h * 0.7)), color: SIGNATURE_INK }}
                  >
                    {signature.signature_text}
                  </span>
                )}
              </button>
            );
          }
          return (
            <div
              key={f.id}
              style={style}
              className={cn(
                'flex items-center justify-center overflow-hidden rounded border px-1',
                signature ? 'border-border bg-muted/60' : 'border-2 border-dashed border-border bg-muted/60 text-[11px] font-medium text-muted-foreground',
              )}
              aria-label={signature ? `Date: ${today}` : 'Date, filled in when you sign'}
              role="img"
            >
              {signature ? (
                <span className="truncate leading-none" style={{ fontSize: Math.max(10, Math.floor(r.h * 0.55)), color: SIGNATURE_INK }}>
                  {today}
                </span>
              ) : (
                'Date'
              )}
            </div>
          );
        })}
    </div>
  );
}

/**
 * Review the document and sign. The PDF is fetched once (that call records the consent),
 * drawn page by page through @/lib/pdfjs, with this signer's fields over it. A 401 at any
 * point means the text-code session lapsed: back to that step.
 */
export function PdfReview({
  token,
  resolved,
  sessionToken,
  onSigned,
  onSessionExpired,
  onDecline,
}: {
  token: string;
  resolved: ResolvedSigner;
  sessionToken: string | null;
  onSigned: () => void;
  onSessionExpired: () => void;
  onDecline: () => void;
}) {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const width = useColumnWidth(columnRef);
  const [pdf, setPdf] = useState<OpenedPdf | null>(null);
  const [download, setDownload] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signature, setSignature] = useState<AdoptedSignature | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const today = useMemo(todayText, []);

  // Kept in a ref so a parent re-render with a new callback does not refetch (and re-record).
  const expiredRef = useRef(onSessionExpired);
  expiredRef.current = onSessionExpired;

  useEffect(() => {
    let cancelled = false;
    let opened: OpenedPdf | null = null;
    setLoadError(null);
    viewPdf(token, sessionToken)
      .then((answer) => {
        if (cancelled) return;
        if (answer === SESSION_EXPIRED) {
          expiredRef.current();
          return;
        }
        // The download gets its own copy FIRST: pdf.js transfers the bytes it is given to
        // its worker, which leaves this side's buffer empty, and an empty download.
        setDownload(new Blob([answer.slice(0)], { type: 'application/pdf' }));
        opened = openPdf({ data: new Uint8Array(answer) });
        setPdf(opened);
      })
      .catch(() => {
        if (!cancelled) setLoadError('The document could not be loaded. Refresh the page, or open the link from your email again.');
      });
    return () => {
      cancelled = true;
      opened?.destroy();
    };
  }, [token, sessionToken]);

  const byPage = useMemo(() => {
    const map = new Map<number, Field[]>();
    for (const f of resolved.fields) map.set(f.page_index, [...(map.get(f.page_index) ?? []), f]);
    return map;
  }, [resolved.fields]);

  const total = resolved.fields.length;
  const sigCount = resolved.fields.filter((f) => f.field_type === 'signature').length;
  const done = signature ? total : 0;
  const canSign = !!signature && agreed && !submitting && total > 0;
  const name = `${resolved.signer.first_name ?? ''} ${resolved.signer.last_name ?? ''}`.trim();

  const submit = async () => {
    if (!canSign || !signature) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await sign(buildSignRequest(token, signature, sessionToken, signerTimezone()));
      if (result === SESSION_EXPIRED) {
        onSessionExpired();
        return;
      }
      onSigned();
    } catch {
      setSubmitError('Your signature could not be recorded. Try again; if it keeps failing, open the link from your email again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {sigCount === 1 ? 'One place to sign' : `${sigCount} places to sign`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => download && downloadBlob(download, `${esignSafeFilename(resolved.envelope.title)}.pdf`)}
          disabled={!download}
        >
          <Download aria-hidden="true" />
          Download a copy (unsigned)
        </Button>
      </div>

      <div ref={columnRef} className="w-full min-w-0">
        {loadError ? (
          <p role="alert" className="mx-auto mt-10 max-w-md rounded-md border border-destructive bg-destructive-light p-4 text-center text-sm text-destructive-dark">
            {loadError}
          </p>
        ) : !pdf || width === 0 ? (
          <div className="flex justify-center py-20">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading the document" />
          </div>
        ) : (
          Array.from({ length: resolved.document.page_count }, (_, i) => (
            <PageView
              key={i}
              pdf={pdf}
              index={i}
              width={width}
              fields={byPage.get(i) ?? []}
              signature={signature}
              today={today}
              onSignatureField={() => setModalOpen(true)}
            />
          ))
        )}
      </div>

      {/* Sticky inside the flow's column, not fixed to the viewport: in the portal a fixed bar
          would lie across the portal's own frame. */}
      <div className="sticky bottom-0 z-30 mt-2 rounded-t-md border border-b-0 border-border bg-card shadow-[0_-6px_20px_rgba(0,0,0,0.06)]">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm" aria-live="polite">
            <span className="font-semibold tabular-nums">{done}</span>
            <span className="text-muted-foreground"> of {total} fields complete</span>
          </p>
          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-md border px-3 py-2',
                signature && !agreed ? 'border-warning bg-warning-light' : agreed ? 'border-success bg-success-light' : 'border-border',
              )}
            >
              <Checkbox id="esign-sign-agree" checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} className="size-5" />
              <Label htmlFor="esign-sign-agree" className="text-sm font-medium leading-snug">
                I agree this {signature ? `${signature.kind} ` : ''}signature is my legal signature.
              </Label>
            </div>
            <Button variant="ghost" onClick={onDecline} disabled={submitting}>
              Decline
            </Button>
            {!signature ? (
              <Button size="lg" onClick={() => setModalOpen(true)}>
                Adopt signature
              </Button>
            ) : (
              <Button size="lg" onClick={() => void submit()} disabled={!canSign}>
                {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                {submitting ? 'Signing...' : 'Sign'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {modalOpen && (
        <SignatureModal
          defaultName={name}
          initial={signature}
          onApply={(s) => {
            setSignature(s);
            setModalOpen(false);
          }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
