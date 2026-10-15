import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { isUuid } from '@/api/contacts';
import { links } from '@/features/links';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { exchangePortalSignerToken, listMySignatureTasks, type SignatureTask } from './api';
import { hasErrorCode, type TerminalState } from './contract';
import { esignKeys } from './keys';
import { SignerCompleteState, SignerErrorState, StateCard } from './public/signer/SignerStates';

// Dynamic, so the portal's own chunk does not carry pdf.js and the signer pages.
const SignerFlow = lazy(() => import('./public/signer/SignerFlow').then((m) => ({ default: m.SignerFlow })));

type Exchange =
  | { state: 'loading' }
  | { state: 'ready'; token: string }
  | { state: TerminalState }
  | { state: 'wrong_email' | 'viewing_as_client' | 'error' };

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  );
}

/** The signer id carried in a task link, when it is one of ours; anything else is ignored. */
function signerIdFromTaskLink(link: string | null): string | null {
  if (!link || !link.startsWith('/portal/sign?')) return null;
  const id = new URLSearchParams(link.slice(link.indexOf('?') + 1)).get('signer');
  return id && isUuid(id) ? id : null;
}

function taskHref(task: SignatureTask): string {
  const id = signerIdFromTaskLink(task.link);
  return id ? `${links.portalSign()}?signer=${encodeURIComponent(id)}` : links.portalSign();
}

/**
 * /portal/sign?signer=<id>: the signed-in client signs in the portal. The signer id is
 * exchanged for a fresh signing token, and only for the signer addressed to this login's
 * email (household members can share a contact; a token in the task link would let one
 * sign as the other). Refused outright during View as client. With no signer id, the page
 * lists what is waiting.
 */
export function PortalSignPage() {
  const [params] = useSearchParams();
  const raw = params.get('signer');
  const signerId = raw && isUuid(raw) ? raw : null;
  const { isViewAsClientSession } = useAuth();

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Sign documents</h1>
        <p className="text-sm text-muted-foreground">Review and sign what has been sent to you.</p>
      </div>
      {isViewAsClientSession ? (
        <ViewingAsClient />
      ) : signerId ? (
        <PortalExchange key={signerId} signerId={signerId} />
      ) : raw ? (
        <SignerErrorState kind="not_found" />
      ) : (
        <WaitingList />
      )}
    </div>
  );
}

function ViewingAsClient() {
  return (
    <StateCard tone="warning" title="Signing is off while viewing as client">
      <p>Only the client can sign. The link in their email still works.</p>
    </StateCard>
  );
}

function PortalExchange({ signerId }: { signerId: string }) {
  const [exchange, setExchange] = useState<Exchange>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    exchangePortalSignerToken(signerId)
      .then((answer) => {
        if (cancelled) return;
        setExchange(answer.state === 'ok' ? { state: 'ready', token: answer.token } : { state: answer.state });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (hasErrorCode(err, 'impersonation_read_only')) setExchange({ state: 'viewing_as_client' });
        else if (hasErrorCode(err, 'wrong_addressee')) setExchange({ state: 'wrong_email' });
        else setExchange({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [signerId]);

  switch (exchange.state) {
    case 'loading':
      return <Spinner />;
    case 'ready':
      return (
        <Suspense fallback={<Spinner />}>
          <SignerFlow initialToken={exchange.token} />
        </Suspense>
      );
    case 'already_signed':
      return <SignerCompleteState title={null} alreadySigned />;
    case 'viewing_as_client':
      return <ViewingAsClient />;
    case 'wrong_email':
      return (
        <StateCard tone="warning" title="This request is for someone else">
          <p>
            It was sent to a different email address (someone else on your account, for example). They can sign in with their
            own login, or use the link in their email.
          </p>
        </StateCard>
      );
    case 'error':
      return (
        <StateCard tone="warning" title="This request could not be opened">
          <p>Try again in a moment, or use the link in your email.</p>
        </StateCard>
      );
    default:
      return <SignerErrorState kind={exchange.state} />;
  }
}

function useMyTasks() {
  const { clientContactId } = useAuth();
  return useQuery({
    queryKey: esignKeys.myTasks(clientContactId ?? ''),
    queryFn: () => listMySignatureTasks(clientContactId!),
    enabled: !!clientContactId,
  });
}

function WaitingList() {
  const tasks = useMyTasks();
  if (tasks.isPending) return <Spinner />;
  if (tasks.isError) return <p className="text-sm text-muted-foreground">Your signature requests could not be loaded.</p>;
  if (tasks.data.length === 0) return <p className="text-sm text-muted-foreground">Nothing is waiting for your signature.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
      {tasks.data.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0 truncate">{t.title}</span>
          <Link to={taskHref(t)} className="shrink-0 font-medium text-link underline underline-offset-2">
            Review and sign
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The portal Home card: what is waiting for this client's signature. It always says
 * something, because the Home page frames every card in its own box.
 */
export function SignatureNeededCard() {
  const tasks = useMyTasks();
  const rows = tasks.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Signature needed</h2>
        {rows.length > 0 && (
          <Link to={links.portalSign()} className="text-[13px] font-medium underline underline-offset-2">
            Open
          </Link>
        )}
      </div>
      {tasks.isError ? (
        <p className="text-[13px] text-muted-foreground">Your signature requests could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{tasks.isPending ? 'Loading.' : 'Nothing is waiting for your signature.'}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.slice(0, 3).map((t) => (
            <li key={t.id} className="flex min-w-0 items-center justify-between gap-3 text-[13px]">
              <Link to={taskHref(t)} className="min-w-0 truncate underline-offset-2 hover:underline">
                {t.title}
              </Link>
              <span className="shrink-0 text-muted-foreground">{formatDate(t.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
