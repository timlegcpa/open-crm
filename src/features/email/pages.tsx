import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Mail, Plus } from 'lucide-react';
import { isUuid } from '@/api/contacts';
import { links } from '@/features/links';
import { EmptyState, PAGE, PageHeader, Panel, Surface, TABLE_TH, TABLE_TH_NUM, TABLE_TR } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, NO_VALUE_TEXT } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { emailKeys, getCampaign, listCampaignRecipients, listCampaigns, type Campaign } from './api';
import { recipientStatus } from './status';

export { NewGroupEmailPage } from './NewGroupEmailPage';

const NUM = 'text-right tabular-nums';

function NewButton() {
  return (
    <Button asChild size="sm">
      <Link to={links.newGroupEmail([])}><Plus aria-hidden="true" />New group email</Link>
    </Button>
  );
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p className="font-medium">Could not load group emails.</p>
      <p className="text-sm text-muted-foreground">{getErrorMessage(error)}</p>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  );
}

/** A campaign's status in words that do not overclaim: the run finishing is not everyone receiving it. */
export function campaignState(c: Pick<Campaign, 'status' | 'unknown_count' | 'failed_count'>): { label: string; dot: string } {
  if (c.status === 'sending') return { label: 'Sending', dot: 'bg-muted-foreground' };
  if (c.status === 'failed') return { label: 'Not sent', dot: 'bg-destructive' };
  if (c.unknown_count > 0) return { label: 'Some unconfirmed', dot: 'bg-warning' };
  if (c.failed_count > 0) return { label: 'Some failed', dot: 'bg-destructive' };
  return { label: 'Finished', dot: 'bg-success' };
}

/** Every group email, newest first, with how each one landed. */
export function EmailPage() {
  const campaigns = useQuery({ queryKey: emailKeys.campaigns(), queryFn: listCampaigns });

  return (
    <>
      <PageHeader title="Email" subtitle="Group emails and how each one landed" actions={<NewButton />} />
      <div className={PAGE}>
        {campaigns.isPending ? (
          <p className="text-[13px] text-muted-foreground">Loading...</p>
        ) : campaigns.isError ? (
          <LoadError error={campaigns.error} retry={() => void campaigns.refetch()} />
        ) : campaigns.data.length === 0 ? (
          <EmptyState
            icon={<Mail />}
            title="No group emails yet"
            description="Write one message and send each chosen contact their own copy."
            action={<NewButton />}
          />
        ) : (
          <Surface padding={false}>
            <Table>
              <TableHeader>
                <TableRow>
                  <th className={TABLE_TH}>Subject</th>
                  <th className={`${TABLE_TH} hidden sm:table-cell`}>Sent</th>
                  <th className={`${TABLE_TH_NUM} hidden md:table-cell`}>Delivered</th>
                  <th className={`${TABLE_TH_NUM} hidden md:table-cell`}>Failed</th>
                  <th className={`${TABLE_TH_NUM} hidden md:table-cell`}>Unconfirmed</th>
                  <th className={`${TABLE_TH_NUM} hidden md:table-cell`}>Skipped</th>
                  <th className={TABLE_TH}>Status</th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.data.map((c) => {
                  const state = campaignState(c);
                  return (
                    <TableRow key={c.id} className={TABLE_TR}>
                      <TableCell className="w-full max-w-0">
                        <Link to={`/email/${encodeURIComponent(c.id)}`} className="block truncate font-medium hover:underline">
                          {c.subject}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                        {formatDateTime(c.sent_at ?? c.created_at)}
                      </TableCell>
                      <TableCell className={`${NUM} hidden md:table-cell`}>{c.sent_count}</TableCell>
                      <TableCell className={`${NUM} hidden md:table-cell`}>{c.failed_count}</TableCell>
                      <TableCell className={`${NUM} hidden md:table-cell`}>{c.unknown_count}</TableCell>
                      <TableCell className={`${NUM} hidden md:table-cell`}>{c.skipped_count}</TableCell>
                      <TableCell><StatusPill dotClassName={state.dot}>{state.label}</StatusPill></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Surface>
        )}
      </div>
    </>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** One group email: what was sent, and every recipient's row. The rows are the authority. */
export function CampaignPage() {
  const { id } = useParams();
  const valid = isUuid(id);
  const campaign = useQuery({ queryKey: emailKeys.campaign(id ?? ''), queryFn: () => getCampaign(id!), enabled: valid });
  const recipients = useQuery({ queryKey: emailKeys.recipients(id ?? ''), queryFn: () => listCampaignRecipients(id!), enabled: valid });

  const back = <Link to={links.email()} className="text-sm underline">Back to email</Link>;
  if (!valid || (campaign.isSuccess && !campaign.data)) {
    return (
      <>
        <PageHeader title="Group email" />
        <div className={`${PAGE} flex flex-col items-start gap-2`}>
          <p className="font-medium">Group email not found</p>
          {back}
        </div>
      </>
    );
  }
  if (campaign.isPending) return <div className={PAGE}><p className="text-[13px] text-muted-foreground">Loading...</p></div>;
  if (campaign.isError) return <div className={PAGE}><LoadError error={campaign.error} retry={() => void campaign.refetch()} /></div>;
  const c = campaign.data!;
  const state = campaignState(c);

  return (
    <>
      <PageHeader title="Group email" />
      <div className={`${PAGE} flex flex-col gap-4`}>
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 break-words text-xl font-semibold">{c.subject}</h2>
          <StatusPill dotClassName={state.dot}>{state.label}</StatusPill>
        </div>
        <p className="text-[13px] text-muted-foreground">
          From {c.from_identity}, {formatDateTime(c.sent_at ?? c.created_at)}
          {c.audience_description ? `, to ${c.audience_description}` : ''}
        </p>
        <Surface className="flex flex-wrap gap-8">
          <Figure label="Delivered" value={c.sent_count} />
          <Figure label="Failed" value={c.failed_count} />
          <Figure label="Unconfirmed" value={c.unknown_count} />
          <Figure label="Skipped" value={c.skipped_count} />
        </Surface>
        {c.unknown_count > 0 && (
          <p className="text-[13px] text-muted-foreground">
            Unconfirmed means the email provider never answered, so the message may have arrived. Check before sending it
            to those people again.
          </p>
        )}
        <Panel title="Message" bodyClassName="p-3.5">
          <p className="whitespace-pre-wrap break-words text-[13px]">{c.body}</p>
        </Panel>
        <Panel title="Recipients">
          {recipients.isPending ? (
            <p className="px-3.5 py-3 text-[13px] text-muted-foreground">Loading...</p>
          ) : recipients.isError ? (
            <p role="alert" className="px-3.5 py-3 text-[13px] text-destructive">Could not load the recipients.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <th className={TABLE_TH}>Address</th>
                  <th className={TABLE_TH}>Status</th>
                  <th className={`${TABLE_TH} hidden md:table-cell`}>Detail</th>
                  <th className={`${TABLE_TH} hidden sm:table-cell`}>When</th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.data.map((r) => {
                  const s = recipientStatus(r.status);
                  return (
                    <TableRow key={r.id} className={TABLE_TR}>
                      <TableCell className="w-full max-w-0">
                        {r.contact_id ? (
                          <Link to={links.contact(r.contact_id)} className="block truncate hover:underline">{r.address}</Link>
                        ) : (
                          <span className="block truncate">{r.address}</span>
                        )}
                      </TableCell>
                      <TableCell><StatusPill dotClassName={s.dot}>{s.label}</StatusPill></TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{r.error ?? NO_VALUE_TEXT}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                        {formatDateTime(r.sent_at ?? r.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
