import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Plug, ShieldCheck, TriangleAlert, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyValue } from '@/components/ui/copy-value';
import { links } from '@/features/links';
import { formatDate } from '@/lib/dates';
import { isEdgeError } from '@/lib/edge';
import { getErrorMessage } from '@/lib/errors';
import { connectorUrl, decideRequest, listGrants, mcpKeys, readRequest, revokeGrant, type Grant } from './api';

/**
 * What a connected assistant can and cannot do, as the consent screen states it. Every
 * power a tool grants is named here: a new kind of tool means a new line, and a bump of
 * CONSENT_VERSION in 0015_mcp.sql so connections approved on the old wording must be
 * approved again.
 */
export const CAN = [
  'Search and read contacts, their businesses, quotes and recent notes',
  'Add contacts and businesses, and update names and phone numbers',
  'Move a contact to another pipeline stage',
  'Log call notes',
  'Record proposed quotes, and delete a proposed quote you confirm',
  'Read, add, edit, move and note cards on your work board',
  'Draft requests, and send, remind, accept the answers on or close a request you confirm',
  'See every open request, and pause or resume its reminders',
];
export const CANNOT = ['Accept a quote', 'Change the address of a contact with a portal account', 'Delete a contact or a note'];

function Centered({ children }: { children: ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center p-4">{children}</main>;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** A callback on this computer (a desktop app), rather than a provider's website. */
function isLoopback(uri: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

/**
 * True when this page is shown inside another page. The consent screen must be its own
 * top-level window: framed, a hostile page could overlay it and steer the owner's click
 * onto Approve. A cross-origin parent makes reading window.top throw, which also counts.
 */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** Why the request could not be shown, in words the owner can act on. */
function RequestProblem({ error }: { error: unknown }) {
  const code = isEdgeError(error) ? error.code : null;
  const kind = isEdgeError(error) ? error.kind : null;
  if (code === 'mfa_required') {
    return (
      <Alert>
        <ShieldCheck aria-hidden="true" />
        <AlertTitle>Two-factor sign-in needed</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>Connecting an assistant hands it a standing key to your contacts, so it needs a sign-in with your authenticator app.</p>
          <p>
            Set one up in{' '}
            <Link className="text-link underline-offset-4 hover:underline" to={links.settingsSection('security')}>
              Security settings
            </Link>
            , sign in again with it, then start the connection again from your assistant.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  const message =
    kind === 'not_found'
      ? 'This connection request has expired or was already answered. Start again from your assistant.'
      : kind === 'unauthorized'
        ? 'Your session has ended. Sign in again, then start again from your assistant.'
        : getErrorMessage(error, 'The connection request could not be loaded.');
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Nothing was connected</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * The consent screen an AI assistant opens when it asks to connect. No shell around it: it
 * runs in a popup. Approve or Deny is the human gate; the server answers where to send the
 * browser, and this page only follows it.
 */
export function ConnectPage() {
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';
  const request = useQuery({
    queryKey: mcpKeys.request(requestId),
    queryFn: () => readRequest(requestId),
    enabled: requestId !== '' && !isFramed(),
    retry: false,
    staleTime: Infinity,
  });
  const [leaving, setLeaving] = useState(false);
  const decide = useMutation({ mutationFn: (approve: boolean) => decideRequest(requestId, approve) });

  const answer = async (approve: boolean) => {
    try {
      const to = await decide.mutateAsync(approve);
      setLeaving(true);
      window.location.assign(to);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Your answer was not recorded.'));
    }
  };

  if (isFramed()) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Open this page in its own window</AlertTitle>
            <AlertDescription>
              Connection requests are only answered in a window of their own, never inside another site. Nothing was connected.
            </AlertDescription>
          </Alert>
        </div>
      </Centered>
    );
  }

  if (requestId === '') {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>No connection request</AlertTitle>
            <AlertDescription>This link has no request in it. Start the connection again from your assistant.</AlertDescription>
          </Alert>
        </div>
      </Centered>
    );
  }

  if (request.isPending) {
    return (
      <Centered>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Loading the connection request...
        </p>
      </Centered>
    );
  }

  if (request.isError) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <RequestProblem error={request.error} />
        </div>
      </Centered>
    );
  }

  const name = request.data.client_name ?? 'An unnamed app';
  const busy = decide.isPending || leaving;
  return (
    <Centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2 text-lg">
              <Plug className="size-5" aria-hidden="true" />
              Connect an assistant
            </h1>
          </CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{name}</span> is asking to work in your CRM. It will return to{' '}
            <span className="font-medium text-foreground">{hostOf(request.data.redirect_uri)}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div>
            <h2 className="mb-1 font-medium">It will be able to</h2>
            <ul className="list-disc space-y-1 pl-5">
              {CAN.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="mb-1 font-medium">It will not be able to</h2>
            <ul className="list-disc space-y-1 pl-5">
              {CANNOT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground">
            Every read and change is recorded in the audit log. The connection lasts 30 days, and you can disconnect it at any time in Settings.
          </p>
          {isLoopback(request.data.redirect_uri) && (
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>This app returns to this computer</AlertTitle>
              <AlertDescription>
                The request will hand its key to a program running on this computer, not to a provider&apos;s website. Approve only if you
                just started this connection from an app you trust on this computer.
              </AlertDescription>
            </Alert>
          )}
          {decide.isError && (
            <p role="alert" className="text-destructive">
              {getErrorMessage(decide.error, 'Your answer was not recorded.')}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
            Deny
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            Approve
          </Button>
        </CardFooter>
      </Card>
    </Centered>
  );
}

function GrantRow({ grant }: { grant: Grant }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeGrant(grant.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: mcpKeys.grants() }),
  });
  const name = grant.client_name ?? 'An unnamed app';

  const confirm = async () => {
    try {
      await revoke.mutateAsync();
      toast.success(`${name} is disconnected.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'The assistant was not disconnected.'));
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-[13px]">
        <p className="truncate font-medium">{name}</p>
        <p className="text-muted-foreground">
          Connected {formatDate(grant.created_at)} · Last used {grant.last_used_at ? formatDate(grant.last_used_at) : 'never'} · Ends{' '}
          {formatDate(grant.expires_at)}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={revoke.isPending} aria-label={`Disconnect ${name}`}>
            <Unplug aria-hidden="true" />
            Disconnect
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
            <AlertDialogDescription>It loses access at once. To use it again, add the connector again and approve it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Settings, AI connector: the address to add, and every live connection with a way to end it. */
export function ConnectorSettings() {
  const grants = useQuery({ queryKey: mcpKeys.grants(), queryFn: listGrants });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">AI connector</h2>
        <p className="text-[13px] text-muted-foreground">
          Add this CRM to Claude or ChatGPT as a custom connector, using the address below. You approve each connection here, signed in with
          your authenticator app. A connection lasts 30 days.
        </p>
      </div>
      <div className="flex flex-col gap-1 text-[13px]">
        <span className="font-medium">Connector address</span>
        <CopyValue value={connectorUrl()} label="connector address" className="font-mono" />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Connected assistants</h3>
        {grants.isPending && <p className="text-[13px] text-muted-foreground">Loading connections...</p>}
        {grants.isError && (
          <p role="alert" className="text-[13px] text-destructive">
            Could not load connections: {getErrorMessage(grants.error)}
          </p>
        )}
        {grants.data?.length === 0 && <p className="text-[13px] text-muted-foreground">No assistant is connected.</p>}
        {grants.data && grants.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {grants.data.map((g) => (
              <GrantRow key={g.id} grant={g} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
