import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import { isEdgeError } from '@/lib/publicEdge';
import type { ResolvedSigner } from '../../contract';
import { DeclineDialog } from './DeclineDialog';
import { decline, resolveToken, SESSION_EXPIRED } from './signerApi';
import { SignerCompleteState, SignerErrorState, senderName, type ErrorKind } from './SignerStates';
import { ConsentStep, LandingStep, SmsStep } from './SignerSteps';
import { clearSigningToken, takeSigningToken } from './signingToken';

// pdf.js is large and needs a real browser: loaded only when the signer reaches the review.
const PdfReview = lazy(() => import('./PdfReview').then((m) => ({ default: m.PdfReview })));

type Phase =
  | { name: 'loading' }
  | { name: 'error'; kind: ErrorKind }
  | { name: 'landing' | 'sms' | 'consent' | 'review' }
  | { name: 'complete'; alreadySigned: boolean; title: string | null };

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-20">
      <Loader2 className="size-7 animate-spin text-muted-foreground" aria-label={label} />
    </div>
  );
}

/**
 * The signer's whole journey: landing, the text code (High only), consent, review and
 * sign, then done. Used at /sign (the token from the URL fragment) and inside the portal
 * (`initialToken` from the portal's exchange, never stored).
 */
export function SignerFlow({ initialToken }: { initialToken?: string }) {
  // Read once: taking the token strips it from the address bar.
  const token = useMemo(() => initialToken ?? takeSigningToken(), [initialToken]);
  const branding = usePublicBranding();
  const [phase, setPhase] = useState<Phase>(token ? { name: 'loading' } : { name: 'error', kind: 'incomplete' });
  const [resolved, setResolved] = useState<ResolvedSigner | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineError, setDeclineError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    resolveToken(token)
      .then((answer) => {
        if (cancelled) return;
        if (answer.state === 'ok') {
          setResolved(answer);
          setPhase({ name: 'landing' });
          return;
        }
        clearSigningToken();
        if (answer.state === 'already_signed') {
          setPhase({ name: 'complete', alreadySigned: true, title: answer.envelope.title });
        } else {
          setPhase({ name: 'error', kind: answer.state });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Only a refused link ends the tab's token; a network blip leaves it for a refresh.
        if (isEdgeError(err) && err.status !== null && err.status < 500) clearSigningToken();
        setPhase({ name: 'error', kind: 'not_found' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const sender = senderName(branding);
  const contactEmail = branding.contactEmail?.trim() || null;

  const confirmDecline = async (reason: string) => {
    if (!token) return;
    setDeclining(true);
    setDeclineError(null);
    try {
      const result = await decline(token, sessionToken, reason);
      if (result === SESSION_EXPIRED) {
        setDeclineOpen(false);
        setSessionToken(null);
        setPhase({ name: 'sms' });
        setDeclineError(null);
        return;
      }
      clearSigningToken();
      setDeclineOpen(false);
      setPhase({ name: 'error', kind: 'declined' });
    } catch {
      setDeclineError('That could not be recorded. Try again.');
    } finally {
      setDeclining(false);
    }
  };

  const openDecline = () => {
    setDeclineError(null);
    setDeclineOpen(true);
  };

  let body;
  if (phase.name === 'loading') {
    body = <Spinner label="Opening the document" />;
  } else if (phase.name === 'error') {
    body = <SignerErrorState kind={phase.kind} contactEmail={contactEmail} />;
  } else if (phase.name === 'complete') {
    body = <SignerCompleteState title={phase.title} alreadySigned={phase.alreadySigned} />;
  } else if (!resolved || !token) {
    body = <SignerErrorState kind="not_found" contactEmail={contactEmail} />;
  } else if (phase.name === 'landing') {
    body = (
      <LandingStep
        resolved={resolved}
        sender={sender}
        onContinue={() => setPhase({ name: resolved.needs_sms || resolved.envelope.verification_level === 'high' ? 'sms' : 'consent' })}
      />
    );
  } else if (phase.name === 'sms') {
    body = (
      <SmsStep
        token={token}
        resolved={resolved}
        contactEmail={contactEmail}
        onVerified={(st) => {
          setSessionToken(st);
          setPhase({ name: 'consent' });
        }}
      />
    );
  } else if (phase.name === 'consent') {
    body = <ConsentStep branding={branding} sender={sender} declining={declining} onAgree={() => setPhase({ name: 'review' })} onDecline={openDecline} />;
  } else {
    body = (
      <Suspense fallback={<Spinner label="Loading the document" />}>
      <PdfReview
        token={token}
        resolved={resolved}
        sessionToken={sessionToken}
        onSigned={() => {
          clearSigningToken();
          setPhase({ name: 'complete', alreadySigned: false, title: resolved.envelope.title });
        }}
        onSessionExpired={() => {
          setSessionToken(null);
          setPhase({ name: 'sms' });
        }}
        onDecline={openDecline}
      />
      </Suspense>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      {resolved && phase.name !== 'error' && phase.name !== 'complete' && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{resolved.envelope.title}</span>
        </p>
      )}
      {body}
      <DeclineDialog
        open={declineOpen}
        busy={declining}
        error={declineError}
        onCancel={() => setDeclineOpen(false)}
        onConfirm={(reason) => void confirmDecline(reason)}
      />
    </div>
  );
}
