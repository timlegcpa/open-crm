import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { OrgIdentity } from '../../contract';

/** Who sent the request, as the signer pages name them: the org's name, else "the sender". */
export function senderName(org: OrgIdentity | null | undefined, fallback: string | null): string {
  return org?.display_name?.trim() || org?.legal_name?.trim() || fallback?.trim() || 'the sender';
}

/** A centred message card: every end state of a signing link uses it. */
export function StateCard({ tone, title, children }: { tone: 'done' | 'warning'; title: string; children: ReactNode }) {
  return (
    <section className="mx-auto mt-6 w-full max-w-lg rounded-lg border border-border bg-card p-6 text-center sm:p-8" aria-labelledby="esign-state-title">
      {tone === 'done' ? (
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden="true" />
      ) : (
        <AlertTriangle className="mx-auto size-10 text-warning" aria-hidden="true" />
      )}
      <h2 id="esign-state-title" className="mt-4 text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-2 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export type ErrorKind = 'expired' | 'voided' | 'not_found' | 'declined' | 'co_signer_declined' | 'incomplete';

const COPY: Record<ErrorKind, { title: string; body: string }> = {
  expired: {
    title: 'This signing link has expired',
    body: 'For security, signing links expire after 14 days. Reply to the email it came in and ask for a fresh link.',
  },
  voided: {
    title: 'This signing request was cancelled',
    body: 'The sender cancelled this request. If you expected to sign, they can send you a new link.',
  },
  not_found: {
    title: 'This document could not be opened',
    body: 'The link may be wrong, already used, or the document may have been removed.',
  },
  declined: {
    title: 'You declined to sign',
    body: 'The request is closed and the sender has been told. If you declined by mistake, reply to their email and ask for a new request.',
  },
  co_signer_declined: {
    title: 'This signing request was closed',
    body: 'Another signer declined, so the request is closed. The sender has been told and will be in touch about next steps.',
  },
  incomplete: {
    title: 'This signing link is incomplete',
    body: 'Open the link straight from the email you received. Copying part of it, or opening it in another app, can leave the end off.',
  },
};

/** An end state reached before or instead of signing. Neutral voice: the signer may not know the sender well. */
export function SignerErrorState({ kind, contactEmail }: { kind: ErrorKind; contactEmail?: string | null }) {
  const { title, body } = COPY[kind];
  return (
    <StateCard tone="warning" title={title}>
      <p>{body}</p>
      {contactEmail && (
        <p>
          Questions:{' '}
          <a href={`mailto:${contactEmail}`} className="font-medium text-link underline underline-offset-2">
            {contactEmail}
          </a>
          .
        </p>
      )}
    </StateCard>
  );
}

/** After signing, or on reopening a link already signed. No links away: the signer just closes the tab. */
export function SignerCompleteState({ title, alreadySigned }: { title: string | null; alreadySigned: boolean }) {
  return (
    <StateCard tone="done" title={alreadySigned ? 'Already signed' : 'You have signed'}>
      <p>
        {alreadySigned ? 'You have already signed' : 'Thank you for signing'}
        {title ? (
          <>
            {' '}
            <span className="font-medium text-foreground">{title}</span>
          </>
        ) : null}
        .
      </p>
      <p>Once everyone has signed, a signed copy is emailed to you. You can close this page.</p>
    </StateCard>
  );
}
