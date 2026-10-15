import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getFields, getPages, getSigners, type EnvelopeWithContact } from '../api';
import { esignKeys } from '../keys';
import { readiness, stepGates } from '../lib/sendReadiness';
import { resolveSignerName } from '../lib/signerName';
import { DocumentsStep } from './DocumentsStep';
import { FieldPlacer } from './FieldPlacer';
import { ReviewSend } from './ReviewSend';
import { SignersStep } from './SignersStep';
import { StepProgress, type ComposerStep } from './StepProgress';

const STEPS: readonly ComposerStep[] = [
  { key: 'documents', label: 'Documents' },
  { key: 'signers', label: 'Signers' },
  { key: 'fields', label: 'Fields' },
  { key: 'review', label: 'Review' },
];

/**
 * A draft envelope, step by step: documents, signers, fields, review. A step opens once
 * every step before it passes its gate (the same checks the send function makes).
 */
export function Composer({ envelope }: { envelope: EnvelopeWithContact }) {
  const [current, setCurrent] = useState(0);
  const pages = useQuery({ queryKey: esignKeys.pages(envelope.id), queryFn: () => getPages(envelope.id) });
  const signers = useQuery({ queryKey: esignKeys.signers(envelope.id), queryFn: () => getSigners(envelope.id) });
  const fields = useQuery({ queryKey: esignKeys.fields(envelope.id), queryFn: () => getFields(envelope.id) });

  const ready = readiness({
    pages: pages.data ?? [],
    signers: signers.data ?? [],
    fields: fields.data ?? [],
    verificationLevel: envelope.verification_level,
  });
  const gates = stepGates(ready);
  const isReachable = (index: number) => gates.slice(0, index).every(Boolean);
  const canProceed = current < gates.length ? gates[current] : true;

  let help: string | null = null;
  if (!canProceed) {
    if (current === 0) help = 'Upload a PDF with at least one page to continue.';
    else if (current === 1) help = ready.signersOk ? 'Add a phone for every signer to continue.' : 'Add a signer to continue.';
    else if (current === 2) {
      help = `Each signer needs a field. Missing: ${ready.missingFields.map((s) => resolveSignerName(s)).join(', ')}.`;
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col">
      <StepProgress steps={STEPS} currentIndex={current} isReachable={isReachable} onJump={(i) => isReachable(i) && setCurrent(i)} />

      {current === 0 && <DocumentsStep envelopeId={envelope.id} />}
      {current === 1 && (
        <SignersStep envelopeId={envelope.id} verificationLevel={envelope.verification_level} primaryContact={envelope.primary_contact} />
      )}
      {current === 2 && <FieldPlacer envelopeId={envelope.id} />}
      {current === 3 && <ReviewSend envelope={envelope} />}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        {current < STEPS.length - 1 ? (
          <div className="flex min-w-0 flex-col items-end gap-1">
            <Button type="button" onClick={() => canProceed && setCurrent((c) => c + 1)} disabled={!canProceed}>
              Next
              <ArrowRight aria-hidden="true" />
            </Button>
            {help && <span className="text-right text-xs text-muted-foreground">{help}</span>}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Send from the panel above when it is ready.</span>
        )}
      </div>
    </div>
  );
}
