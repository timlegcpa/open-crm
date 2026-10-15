import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import type { AdoptedSignature } from '../../contract';
import { SIGNATURE_FONTS, SIGNATURE_INK } from '../../lib/signatureFonts';
import { validateSignatureImageBase64 } from '../../lib/signatureImage';
import { SIGNATURE_TEXT_MAX, signatureTextProblem } from '../../lib/signatureText';
import '../../fonts/signatureFonts.css';
import { useSignaturePad } from './useSignaturePad';

type Mode = 'typed' | 'drawn';

/**
 * Adopt a signature: typed in one of the six script fonts, or drawn. A typed name with a
 * character the fonts cannot draw is refused here (the stamped copy would show a gap),
 * with "Draw instead" one click away; the sign function refuses it too.
 */
export function SignatureModal({
  defaultName,
  initial,
  onApply,
  onClose,
}: {
  defaultName: string;
  initial: AdoptedSignature | null;
  onApply: (signature: AdoptedSignature) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initial?.kind === 'drawn' ? 'drawn' : 'typed');
  const [name, setName] = useState((initial?.kind === 'typed' ? initial.signature_text : '') || defaultName.trim());
  const [fontKey, setFontKey] = useState(initial?.kind === 'typed' ? initial.font_key : SIGNATURE_FONTS[0].key);
  const [padError, setPadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const pad = useSignaturePad(mode === 'drawn');

  const trimmed = name.trim();
  const problem = signatureTextProblem(name);
  const canApply = mode === 'typed' ? problem === null : pad.hasInk && !checking;

  const apply = async () => {
    if (mode === 'typed') {
      if (problem) return;
      onApply({ kind: 'typed', signature_text: trimmed, font_key: fontKey });
      return;
    }
    const image = pad.exportBase64();
    if (!image) return;
    setPadError(null);
    setChecking(true);
    try {
      // The sign function's own validator, run early so a too-faint mark is caught while
      // it can still be fixed. A courtesy, not the gate: it fails open below, and the
      // server checks every drawn signature as if nothing had checked it here.
      const verdict = await validateSignatureImageBase64(image);
      if (!verdict.ok) {
        setPadError(
          verdict.reason === 'blank'
            ? 'That signature is too faint to record. Draw it a little larger.'
            : 'That signature could not be read. Clear it and draw it again.',
        );
        return;
      }
    } catch {
      // An older browser without DecompressionStream: let the server decide.
    } finally {
      setChecking(false);
    }
    onApply({ kind: 'drawn', image_base64: image });
  };

  const typedHint =
    problem === 'unsupported'
      ? 'Some characters in this name cannot be drawn in these fonts. Remove them, or draw your signature instead.'
      : problem === 'too_long'
        ? `Keep it to ${SIGNATURE_TEXT_MAX} characters.`
        : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[92svh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>Adopt your signature</DialogTitle>
          <DialogDescription>Type your name or draw your signature. It goes on every signature field for you.</DialogDescription>
        </DialogHeader>

        <Segmented
          label="Signature style"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'typed', label: 'Type' },
            { value: 'drawn', label: 'Draw' },
          ]}
          className="self-start"
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Both panels stay mounted, the hidden one display:none: unmounting the pad would
              throw away a drawing the moment someone looked at the typed styles. */}
          <div className={mode === 'typed' ? 'flex flex-col gap-4' : 'hidden'}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="esign-signature-name">Full name</Label>
              <Input
                id="esign-signature-name"
                value={name}
                maxLength={SIGNATURE_TEXT_MAX}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={typedHint ? true : undefined}
                aria-describedby={typedHint ? 'esign-signature-name-hint' : undefined}
              />
              {typedHint && (
                <div id="esign-signature-name-hint" role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                  <span>{typedHint}</span>
                  {problem === 'unsupported' && (
                    <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => setMode('drawn')}>
                      Draw instead
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Font">
              {SIGNATURE_FONTS.map((f) => {
                const selected = f.key === fontKey;
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={f.label}
                    onClick={() => setFontKey(f.key)}
                    className={cn(
                      'flex min-h-24 items-center justify-center overflow-hidden rounded-md border bg-card px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-link ring-1 ring-link' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    <span
                      className="block max-w-full truncate"
                      style={{ fontFamily: f.family, fontSize: `${f.tilePx}px`, lineHeight: f.tileLh, color: SIGNATURE_INK }}
                    >
                      {trimmed || f.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={mode === 'drawn' ? 'flex flex-col gap-1.5' : 'hidden'}>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium" id="esign-pad-label">
                Draw your signature
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => {
                  setPadError(null);
                  pad.clear();
                }}
                disabled={!pad.hasInk}
              >
                Clear
              </Button>
            </div>
            <div className="relative overflow-hidden rounded-md border border-border bg-card">
              {/* touch-action none: otherwise a phone takes the stroke as a scroll. */}
              <canvas
                ref={pad.canvasRef}
                className="block h-[180px] w-full cursor-crosshair touch-none"
                onPointerDown={(e) => {
                  setPadError(null);
                  pad.onPointerDown(e);
                }}
                onPointerMove={pad.onPointerMove}
                onPointerUp={pad.endStroke}
                onPointerCancel={pad.endStroke}
                onPointerLeave={pad.endStroke}
                role="img"
                aria-labelledby="esign-pad-label"
              />
              <div className="pointer-events-none absolute inset-x-6 bottom-10 border-b border-border" aria-hidden="true" />
              {!pad.hasInk && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" aria-hidden="true">
                  Sign here
                </div>
              )}
            </div>
            {padError ? (
              <p role="alert" className="text-xs text-destructive">
                {padError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Use a finger, a stylus or the mouse. Clear and redraw as often as you like.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void apply()} disabled={!canApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
