import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { isEdgeError } from '@/lib/publicEdge';
import type { OrgIdentity, ResolvedSigner } from '../../contract';
import { requestSmsCode, verifySmsCode } from './signerApi';

const CARD = 'mx-auto mt-6 w-full max-w-lg rounded-lg border border-border bg-card p-6 sm:p-8';

/** Step one: who is asking, for what. */
export function LandingStep({ resolved, sender, onContinue }: { resolved: ResolvedSigner; sender: string; onContinue: () => void }) {
  const first = resolved.signer.first_name?.trim();
  return (
    <section className={`${CARD} text-center`} aria-labelledby="esign-landing-title">
      <h2 id="esign-landing-title" className="text-xl font-semibold">
        {first ? `Hello ${first},` : 'Hello,'}
      </h2>
      <p className="mt-4 text-[15px] leading-relaxed">
        {sender === 'the sender' ? 'You have been asked to sign ' : `${sender} has asked you to sign `}
        <span className="font-medium">{resolved.envelope.title}</span>.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {resolved.envelope.verification_level === 'high'
          ? 'First you confirm a code sent to your phone, then you review the document and sign.'
          : 'You review the document, then sign. It takes a minute or two.'}
      </p>
      <Button className="mt-6" size="lg" onClick={onContinue}>
        Continue
      </Button>
    </section>
  );
}

const MAX_LOCAL_FAILURES = 5;
const RESEND_COOLDOWN_SEC = 30;

/**
 * High verification: a six-digit code by text. The server decides (and caps attempts); the
 * page counts failures too, so a signer is not left guessing after the server has locked.
 */
export function SmsStep({
  token,
  resolved,
  contactEmail,
  onVerified,
}: {
  token: string;
  resolved: ResolvedSigner;
  contactEmail: string | null;
  onVerified: (sessionToken: string) => void;
}) {
  const [phase, setPhase] = useState<'request' | 'verify' | 'locked'>('request');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'request' | 'verify' | null>(null);
  const [lastFour, setLastFour] = useState<string | null>(resolved.signer.phone_last_four);
  const [cooldown, setCooldown] = useState(0);
  const failures = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const startCooldown = () => {
    if (timer.current) window.clearInterval(timer.current);
    setCooldown(RESEND_COOLDOWN_SEC);
    timer.current = window.setInterval(() => {
      setCooldown((s) => {
        if (s > 1) return s - 1;
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        return 0;
      });
    }, 1000);
  };

  const failed = (message: string) => {
    failures.current += 1;
    setCode('');
    if (failures.current >= MAX_LOCAL_FAILURES) setPhase('locked');
    else setError(message);
  };

  const request = async () => {
    setError(null);
    setBusy('request');
    try {
      const four = await requestSmsCode(token);
      if (four) setLastFour(four);
      setPhase('verify');
      startCooldown();
    } catch (err) {
      setError(
        isEdgeError(err) && err.kind === 'rate_limited'
          ? 'Too many codes were asked for. Wait a while and try again.'
          : 'A code could not be sent right now. Wait a minute and try again.',
      );
    } finally {
      setBusy(null);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setError(null);
    setBusy('verify');
    try {
      const answer = await verifySmsCode(token, value);
      if (answer.ok) {
        onVerified(answer.session_token);
        return;
      }
      if (answer.locked) {
        setPhase('locked');
        return;
      }
      failed(
        typeof answer.attempts_left === 'number'
          ? `That code is not right. ${answer.attempts_left} attempt${answer.attempts_left === 1 ? '' : 's'} left.`
          : 'That code is not right, or it has expired.',
      );
    } catch {
      failed('The code could not be checked. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (phase === 'locked') {
    return (
      <section className={CARD} role="alert">
        <h2 className="text-lg font-semibold">Too many attempts</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          For your security, this code can no longer be tried. Ask for a new code later, or reply to the email you received.
          {contactEmail ? (
            <>
              {' '}
              You can also write to{' '}
              <a href={`mailto:${contactEmail}`} className="font-medium text-link underline underline-offset-2">
                {contactEmail}
              </a>
              .
            </>
          ) : null}
        </p>
      </section>
    );
  }

  if (phase === 'request') {
    return (
      <section className={`${CARD} text-center`} aria-labelledby="esign-sms-title">
        <ShieldCheck className="mx-auto size-10 text-link" aria-hidden="true" />
        <h2 id="esign-sms-title" className="mt-3 text-lg font-semibold">
          Confirm it is you
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This document needs a six-digit code sent by text message before you can open it.
          {lastFour ? (
            <>
              {' '}
              It goes to the phone ending in <span className="font-medium tabular-nums text-foreground">{lastFour}</span>.
            </>
          ) : (
            ' It goes to the phone the sender has on file.'
          )}
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-md border border-destructive bg-destructive-light px-3 py-2 text-left text-sm text-destructive-dark">
            {error}
          </p>
        )}
        <Button className="mt-6 w-full" size="lg" onClick={() => void request()} disabled={busy !== null}>
          {busy === 'request' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
          {busy === 'request' ? 'Sending...' : 'Text me a code'}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">Message and data rates may apply.</p>
      </section>
    );
  }

  return (
    <section className={CARD} aria-labelledby="esign-code-title">
      <p className="rounded-md border border-success bg-success-light px-3 py-2 text-center text-sm text-success-dark" role="status">
        Code sent{lastFour ? ` to the phone ending in ${lastFour}` : ''}.
      </p>
      <h2 id="esign-code-title" className="mt-5 text-center text-lg font-semibold">
        Enter the six-digit code
      </h2>
      <form
        className="mt-4 flex flex-col items-center gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
      >
        <Label htmlFor="esign-sms-code" className="sr-only">
          Six-digit code
        </Label>
        <InputOTP
          id="esign-sms-code"
          maxLength={6}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="^[0-9]*$"
          onChange={(v) => {
            setCode(v.replace(/\D/g, ''));
            if (error) setError(null);
          }}
          onComplete={(v: string) => void verify(v)}
          autoFocus
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
        {error && (
          <p role="alert" className="w-full rounded-md border border-destructive bg-destructive-light px-3 py-2 text-sm text-destructive-dark">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" size="lg" disabled={code.length !== 6 || busy !== null}>
          {busy === 'verify' && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy === 'verify' ? 'Checking...' : 'Confirm and continue'}
        </Button>
        <Button type="button" variant="link" onClick={() => void request()} disabled={cooldown > 0 || busy !== null}>
          {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
        </Button>
      </form>
    </section>
  );
}

/**
 * The electronic-records disclosure. The sender's legal name and contact address are
 * filled in when the server supplies them; with no contact address the opt-out line points
 * to the invitation email instead (never an address the page guessed).
 */
export function ConsentStep({
  org,
  sender,
  declining,
  onAgree,
  onDecline,
}: {
  org: OrgIdentity | null;
  sender: string;
  declining: boolean;
  onAgree: () => void;
  onDecline: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const party = org?.legal_name?.trim() || sender;
  const contactEmail = org?.contact_email?.trim() || null;
  return (
    <section className={CARD} aria-labelledby="esign-consent-title">
      <h2 id="esign-consent-title" className="text-center text-lg font-semibold">
        Consent to sign electronically
      </h2>
      <p className="mt-1 text-center text-sm text-muted-foreground">Read this and agree before you continue.</p>
      <div className="mt-5 flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-4 text-sm leading-relaxed">
        <p>By choosing “I agree, continue” you agree that:</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          <li>
            You consent to doing this transaction electronically, under the U.S. Electronic Signatures in Global and National
            Commerce Act (ESIGN) and applicable state law.
          </li>
          <li>
            <span className="font-medium">The signature you type or draw is your legal signature</span>, with the same effect as
            signing on paper.
          </li>
          <li>A record of this signing, including your IP address, your browser and the time, is kept with the document.</li>
          <li>You can open and read PDF documents on the device you are using now.</li>
        </ol>
        <p className="text-muted-foreground">
          You may sign on paper instead, at no cost, by asking {party === 'the sender' ? 'the sender' : party} before you sign
          {contactEmail ? (
            <>
              {' '}
              at{' '}
              <a href={`mailto:${contactEmail}`} className="font-medium text-link underline underline-offset-2">
                {contactEmail}
              </a>
            </>
          ) : (
            ', by replying to the email this link came in'
          )}
          .
        </p>
      </div>
      <div className="mt-5 flex min-h-11 items-start gap-3">
        <Checkbox id="esign-consent" checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} className="mt-0.5 size-5" />
        <Label htmlFor="esign-consent" className="text-sm font-normal leading-snug">
          I have read the consent above and agree to it.
        </Label>
      </div>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onDecline} disabled={declining}>
          {declining ? 'Declining...' : 'Decline to sign'}
        </Button>
        <Button type="button" size="lg" onClick={onAgree} disabled={!agreed || declining}>
          I agree, continue
        </Button>
      </div>
    </section>
  );
}
