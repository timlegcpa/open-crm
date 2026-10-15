import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel } from '@/components/layout/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { CopyValue } from '@/components/ui/copy-value';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import type { ContactTabProps } from '@/features/types';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import {
  getPortalAccess,
  portalKeys,
  resendInvite,
  revokeAccess,
  sendInvite,
  setPortalSidebarFlag,
  type ContactEmailRow,
  type InviteAnswer,
  type PortalAccessView,
} from '../api';
import {
  bestPortalAccount,
  bestPortalAccountStatus,
  PORTAL_ACCESS_DOT,
  PORTAL_ACCESS_LABEL,
  type PortalAccount,
  type PortalSidebarConfig,
} from '../lib/portalAccess';

const KIND_LABEL: Record<ContactEmailRow['kind'], string> = { primary: 'Primary', spouse: 'Spouse' };

const SWITCHES: Array<{ key: keyof PortalSidebarConfig; label: string }> = [
  { key: 'hide_documents', label: 'Hide Documents' },
  { key: 'hide_messages', label: 'Hide Messages' },
];

/** One address on the record and the portal account invited at it, if any. */
interface AddressRow {
  key: string;
  email: string;
  kind: ContactEmailRow['kind'] | null;
  account: PortalAccount | null;
}

function addressRows(view: PortalAccessView): AddressRow[] {
  const byEmail = new Map<string, PortalAccount>();
  for (const account of view.accounts) {
    const email = (account.invited_email ?? '').toLowerCase();
    const held = byEmail.get(email);
    // The account that matters for an address is its best one (an active login over an old deactivated row).
    if (!held || bestPortalAccount([held, account]) === account) byEmail.set(email, account);
  }
  const rows: AddressRow[] = view.emails.map((e) => ({
    key: e.id,
    email: e.email,
    kind: e.kind,
    account: byEmail.get(e.email.toLowerCase()) ?? null,
  }));
  const listed = new Set(view.emails.map((e) => e.email.toLowerCase()));
  // An account invited at an address since removed from the record still shows, so it can be deactivated.
  for (const account of view.accounts) {
    const email = (account.invited_email ?? '').toLowerCase();
    if (!listed.has(email) && byEmail.get(email) === account) {
      rows.push({ key: account.id, email: account.invited_email ?? '', kind: null, account });
    }
  }
  return rows;
}

/**
 * The record's Portal section: whether this contact can sign in to the portal, the last
 * sign-in, one invite action per address on the record (primary and spouse), View as
 * client, and the owner's switches that hide sections of this client's portal.
 */
export function PortalAccessPanel({ contactId }: ContactTabProps) {
  const queryClient = useQueryClient();
  const { startViewAsClient } = useAuth();
  const key = portalKeys.access(contactId);
  const access = useQuery({ queryKey: key, queryFn: () => getPortalAccess(contactId) });
  const [linkDialog, setLinkDialog] = useState<{ email: string; url: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AddressRow | null>(null);
  const [confirmView, setConfirmView] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const afterInvite = (email: string, answer: InviteAnswer) => {
    if (answer.emailSent) toast.success(`Invitation sent to ${email}.`);
    else setLinkDialog({ email, url: answer.inviteUrl });
  };

  const invite = useMutation({
    mutationFn: (row: AddressRow) => sendInvite(contactId, row.email),
    onSuccess: (answer, row) => afterInvite(row.email, answer),
    onError: (err) => toast.error(getErrorMessage(err, 'The invitation was not sent.')),
    onSettled: refresh,
  });
  const resend = useMutation({
    mutationFn: (row: AddressRow) => resendInvite(row.account!.id),
    onSuccess: (answer, row) => afterInvite(row.email, answer),
    onError: (err) => toast.error(getErrorMessage(err, 'The invitation was not sent.')),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (row: AddressRow) => revokeAccess(row.account!.id),
    onSuccess: (_answer, row) => toast.success(`Portal access for ${row.email} is off.`),
    onError: (err) => toast.error(getErrorMessage(err, 'Portal access was not turned off.')),
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: ({ flag, value }: { flag: keyof PortalSidebarConfig; value: boolean }) => setPortalSidebarFlag(contactId, flag, value),
    onMutate: async ({ flag, value }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PortalAccessView>(key);
      queryClient.setQueryData<PortalAccessView>(key, (view) => (view ? { ...view, config: { ...view.config, [flag]: value } } : view));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(getErrorMessage(err, 'The setting was not saved.'));
    },
    onSettled: refresh,
  });
  const view = useMutation({
    mutationFn: () => startViewAsClient(contactId),
    onError: (err) => toast.error(getErrorMessage(err, 'View as client did not start.')),
  });

  const busy = invite.isPending || resend.isPending || revoke.isPending;
  const data = access.data;
  const status = data ? bestPortalAccountStatus(data.accounts) : null;
  const best = data ? bestPortalAccount(data.accounts) : null;
  const rows = data ? addressRows(data) : [];

  return (
    <Panel title="Portal" bodyClassName="flex flex-col divide-y divide-border text-[13px]">
      {access.isPending && <p className="px-3.5 py-3 text-muted-foreground">Loading...</p>}
      {access.isError && (
        <p role="alert" className="px-3.5 py-3 text-destructive">
          Could not load portal access: {getErrorMessage(access.error)}
        </p>
      )}
      {data && status && (
        <>
          <div className="flex flex-col gap-1.5 px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <StatusPill dotClassName={PORTAL_ACCESS_DOT[status]} muted={status === 'none' || status === 'deactivated'}>
                {PORTAL_ACCESS_LABEL[status]}
              </StatusPill>
              {status === 'active' && (
                <Button size="xs" variant="outline" disabled={view.isPending} onClick={() => setConfirmView(true)}>
                  View as client
                </Button>
              )}
            </div>
            <p className="text-muted-foreground">
              Last sign-in: {best?.last_login_at ? formatRelativeTime(best.last_login_at) : 'never'}
            </p>
          </div>

          <ul aria-label="Portal addresses" className="flex flex-col">
            {rows.length === 0 && <li className="px-3.5 py-3 text-muted-foreground">Add an email address to invite this contact.</li>}
            {rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-1.5 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <CopyValue value={row.email} label="email" className="min-w-0 font-medium" />
                  {row.kind && <span className="shrink-0 text-[11px] text-muted-foreground">{KIND_LABEL[row.kind]}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {row.account && (
                    <StatusPill dotClassName={PORTAL_ACCESS_DOT[row.account.status]} muted={row.account.status === 'deactivated'}>
                      {PORTAL_ACCESS_LABEL[row.account.status]}
                    </StatusPill>
                  )}
                  <AddressActions
                    row={row}
                    busy={busy}
                    onInvite={() => void invite.mutateAsync(row).catch(() => {})}
                    onResend={() => void resend.mutateAsync(row).catch(() => {})}
                    onRevoke={() => setConfirmRevoke(row)}
                  />
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2 px-3.5 py-3">
            {SWITCHES.map(({ key: flag, label }) => (
              <div key={flag} className="flex items-center justify-between gap-2">
                <Label htmlFor={`portal-${flag}`} className="text-[13px] font-normal">
                  {label}
                </Label>
                <Switch
                  id={`portal-${flag}`}
                  checked={data.config[flag]}
                  // One switch write at a time: the second waits for the first to land.
                  disabled={toggle.isPending}
                  onCheckedChange={(value) => void toggle.mutateAsync({ flag, value }).catch(() => {})}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={confirmRevoke !== null} onOpenChange={(open) => !open && setConfirmRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off portal access?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRevoke?.email} will no longer be able to sign in, and any unused invitation link stops working. You can
              invite this address again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRevoke) void revoke.mutateAsync(confirmRevoke).catch(() => {});
                setConfirmRevoke(null);
              }}
            >
              Turn off access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmView} onOpenChange={setConfirmView}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>View the portal as this client?</AlertDialogTitle>
            <AlertDialogDescription>
              You will see exactly what they see, read-only: nothing you do changes their account. Their own devices stay
              signed in. Starting and ending the view are recorded in the audit log. Other tabs of this app switch to the
              client's view too until you exit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmView(false);
                void view.mutateAsync().catch(() => {});
              }}
            >
              View as client
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={linkDialog !== null} onOpenChange={(open) => !open && setLinkDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The email did not go out</DialogTitle>
            <DialogDescription>
              The invitation for {linkDialog?.email} is ready, but the email could not be sent. Copy the link and send it
              yourself. It works once and expires in 7 days.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 rounded-md border border-border px-3 py-2 text-[13px]">
            <CopyValue value={linkDialog?.url} label="invitation link" className="break-all" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialog(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function AddressActions({
  row,
  busy,
  onInvite,
  onResend,
  onRevoke,
}: {
  row: AddressRow;
  busy: boolean;
  onInvite: () => void;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const status = row.account?.status ?? null;
  return (
    <>
      {status === null && row.kind !== null && (
        <Button size="xs" variant="outline" disabled={busy} onClick={onInvite} aria-label={`Invite ${row.email}`}>
          Invite
        </Button>
      )}
      {status === 'invited' && (
        <Button size="xs" variant="outline" disabled={busy} onClick={onResend} aria-label={`Resend the invitation to ${row.email}`}>
          Resend
        </Button>
      )}
      {status === 'deactivated' && (
        <Button size="xs" variant="outline" disabled={busy} onClick={onResend} aria-label={`Invite ${row.email} again`}>
          Re-invite
        </Button>
      )}
      {(status === 'invited' || status === 'active' || status === 'suspended') && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onRevoke} aria-label={`Turn off portal access for ${row.email}`}>
          Deactivate
        </Button>
      )}
    </>
  );
}
