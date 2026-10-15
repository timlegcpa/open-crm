import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, ListChecks, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, PAGE, PageHeader, Surface } from '@/components/layout/page';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import {
  getJobHealth,
  getJobStatusCounts,
  listJobs,
  OVERDUE_MINUTES,
  opsKeys,
  retryJob,
  runQueueNow,
  type JobRow,
  type JobStatus,
  type JobStatusFilter,
} from './api';
import { jobKindLabel } from './labels';
import { Pager } from './Pager';

export const STATUS_META: Record<JobStatus, { label: string; dot: string }> = {
  pending: { label: 'Waiting', dot: 'bg-link' },
  running: { label: 'Running', dot: 'bg-caution' },
  success: { label: 'Done', dot: 'bg-success' },
  failed: { label: 'Failed', dot: 'bg-destructive' },
  dead: { label: 'Gave up', dot: 'bg-destructive' },
};

/** Fast while something is moving, slow otherwise; never while the tab is hidden (React Query's default). */
export function jobsPollMs(rows: readonly JobRow[] | undefined): number {
  return rows?.some((r) => r.status === 'pending' || r.status === 'running') ? 5_000 : 30_000;
}

const canRetry = (row: JobRow) => row.status === 'failed' || row.status === 'dead';

const FILTERS: Array<{ value: JobStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  ...(['pending', 'running', 'success', 'failed', 'dead'] as const).map((s) => ({ value: s, label: STATUS_META[s].label })),
];

function JobDetails({ row }: { row: JobRow }) {
  const block = (title: string, value: unknown) => (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
  return (
    <div className="grid gap-3 py-2 md:grid-cols-3">
      {block('Payload', row.payload ?? {})}
      {block('Result', row.result ?? 'None yet')}
      {block('Last error', row.last_error ?? 'None')}
      <p className="text-xs text-muted-foreground md:col-span-3">
        Created {formatDateTime(row.created_at)}. Started {formatDateTime(row.started_at)}. Job {row.id}.
      </p>
    </div>
  );
}

export function JobsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobStatusFilter>('all');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: opsKeys.jobs(status, page),
    queryFn: () => listJobs(status, page),
    refetchInterval: (query) => jobsPollMs(query.state.data?.rows),
  });
  const counts = useQuery({ queryKey: opsKeys.jobCounts(), queryFn: getJobStatusCounts, refetchInterval: 30_000 });
  const health = useQuery({ queryKey: opsKeys.jobHealth(), queryFn: () => getJobHealth(), refetchInterval: 30_000 });

  const refresh = () => queryClient.invalidateQueries({ queryKey: opsKeys.all });

  const retry = useMutation({ mutationFn: retryJob, onSettled: refresh });
  const runNow = useMutation({ mutationFn: runQueueNow, onSettled: refresh });

  const onRetry = async (row: JobRow) => {
    try {
      await retry.mutateAsync(row.id);
      toast.success('Queued. It runs on the next tick, within a minute, when schedules are installed.');
    } catch (err) {
      toast.error(`Could not retry: ${getErrorMessage(err)}`);
    }
  };

  const onRunNow = async () => {
    try {
      const s = await runNow.mutateAsync();
      toast.success(
        s.claimed === 0
          ? 'Nothing was due.'
          : `Ran ${s.claimed} ${s.claimed === 1 ? 'job' : 'jobs'}: ${s.succeeded} done, ${s.failed} failed${s.superseded ? `, ${s.superseded} taken over` : ''}.`,
      );
    } catch (err) {
      toast.error(`Could not run the queue: ${getErrorMessage(err)}`);
    }
  };

  const c = counts.data;
  const subtitle = c ? `${c.pending} waiting, ${c.running} running, ${c.failed + c.dead} failed` : undefined;
  const rows = jobs.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={subtitle}
        actions={
          <Button size="sm" variant="outline" disabled={runNow.isPending} onClick={() => void onRunNow()}>
            <Play aria-hidden="true" />
            {runNow.isPending ? 'Running...' : 'Run queue now'}
          </Button>
        }
      />
      <div className={`${PAGE} flex flex-col gap-3`}>
        {health.data && health.data.overdue > 0 && (
          <Alert>
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>The queue is not being run</AlertTitle>
            <AlertDescription>
              {health.data.overdue} {health.data.overdue === 1 ? 'job is' : 'jobs are'} more than {OVERDUE_MINUTES} minutes
              late. Install the schedules (README, Schedules) so the queue runs every minute, or run it now.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            label="Status"
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(0);
            }}
            options={FILTERS}
          />
          <p className="text-xs text-muted-foreground">
            {health.data
              ? health.data.lastFinishedAt
                ? `Last job finished ${formatRelativeTime(health.data.lastFinishedAt)}`
                : 'No job has finished yet'
              : null}
          </p>
        </div>

        {jobs.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm font-medium">Could not load jobs.</p>
            <p className="text-sm text-muted-foreground">{getErrorMessage(jobs.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>Try again</Button>
          </div>
        ) : jobs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading jobs...</p>
        ) : rows.length === 0 ? (
          <Surface>
            <EmptyState
              icon={<ListChecks />}
              title={status === 'all' ? 'No jobs yet' : `No ${STATUS_META[status].label.toLowerCase()} jobs`}
              description="Scheduled work (digests, reminders, clean-ups) appears here once the schedules are installed. See Schedules in the README."
            />
          </Surface>
        ) : (
          <Surface padding={false}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const expanded = open === row.id;
                  const label = jobKindLabel(row.provider, row.action);
                  return (
                    <Fragment key={row.id}>
                      <TableRow>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} details for ${label}`}
                            onClick={() => setOpen(expanded ? null : row.id)}
                          >
                            {expanded ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{label}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">{row.provider}:{row.action}</div>
                        </TableCell>
                        <TableCell>
                          <StatusPill dotClassName={STATUS_META[row.status].dot}>{STATUS_META[row.status].label}</StatusPill>
                        </TableCell>
                        <TableCell className="tabular-nums">{row.attempts} of {row.max_attempts}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(row.scheduled_at)}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(row.finished_at)}</TableCell>
                        <TableCell className="max-w-[280px] truncate text-muted-foreground" title={row.last_error ?? undefined}>
                          {row.last_error ?? ''}
                        </TableCell>
                        <TableCell className="text-right">
                          {canRetry(row) && (
                            <Button size="xs" variant="outline" disabled={retry.isPending} onClick={() => void onRetry(row)} aria-label={`Retry ${label}`}>
                              <RotateCcw aria-hidden="true" />
                              Retry
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell colSpan={8}>
                            <JobDetails row={row} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Surface>
        )}
        <Pager page={page} hasMore={jobs.data?.hasMore ?? false} onPage={setPage} label="Jobs" />
      </div>
    </>
  );
}
