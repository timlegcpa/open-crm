import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { MoreHorizontal, PenLine, Trash2 } from 'lucide-react';
import { EmptyState, Surface, TABLE_TH, TABLE_TR } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { listEnvelopes, type EnvelopeListRow } from '../api';
import { ENVELOPE_STATUSES, ENVELOPE_STATUS_LABELS } from '../contract';
import { esignKeys } from '../keys';
import { DeleteEnvelopeDialog } from './EnvelopeDialogs';
import { EsignStatusBadge } from './StatusBadge';

// Derived from the status list, so a status added there cannot be missing from the filter.
const FILTERS = [
  { value: 'all', label: 'All' },
  ...ENVELOPE_STATUSES.map((value) => ({ value, label: ENVELOPE_STATUS_LABELS[value] })),
];

/** Every envelope, filtered by status, newest first. A row opens the envelope. */
export function EnvelopeList() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('all');
  const [deleteTarget, setDeleteTarget] = useState<EnvelopeListRow | null>(null);
  const envelopes = useQuery({ queryKey: esignKeys.envelopeList(status), queryFn: () => listEnvelopes(status) });

  return (
    <div className="flex flex-col gap-3">
      <ScrollArea horizontal className="max-w-full">
        <Segmented label="Envelope status" value={status} onValueChange={setStatus} options={FILTERS} className="mb-2" />
      </ScrollArea>

      <Surface padding={false}>
        {envelopes.isPending ? (
          <div className="flex flex-col gap-2 p-4" aria-label="Loading envelopes">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : envelopes.isError ? (
          <p role="alert" className="p-6 text-center text-sm text-destructive">
            Could not load envelopes: {getErrorMessage(envelopes.error)}
          </p>
        ) : envelopes.data.length === 0 ? (
          <EmptyState
            icon={<PenLine />}
            title={status === 'all' ? 'No envelopes yet' : `No ${ENVELOPE_STATUS_LABELS[status as keyof typeof ENVELOPE_STATUS_LABELS]?.toLowerCase() ?? ''} envelopes`}
            description={status === 'all' ? 'Start one with New envelope.' : undefined}
          />
        ) : (
          <ScrollArea horizontal>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={TABLE_TH}>Title</TableHead>
                  <TableHead className={`${TABLE_TH} w-[150px]`}>Status</TableHead>
                  <TableHead className={`${TABLE_TH} w-[80px] text-right`}>Signers</TableHead>
                  <TableHead className={`${TABLE_TH} w-[130px]`}>Created</TableHead>
                  <TableHead className={`${TABLE_TH} w-[48px]`}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {envelopes.data.map((row) => (
                  <TableRow key={row.id} className={`cursor-pointer ${TABLE_TR}`} onClick={() => navigate(links.envelope(row.id))}>
                    <TableCell className="max-w-[320px] truncate text-[13px] font-medium">
                      {/* The row is clickable; the link is the keyboard and screen-reader way in. */}
                      <Link to={links.envelope(row.id)} onClick={(e) => e.stopPropagation()} className="hover:underline">
                        {row.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <EsignStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-right text-[13px] tabular-nums">{row.signer_count}</TableCell>
                    <TableCell className="whitespace-nowrap text-[13px] text-muted-foreground">{formatDate(row.created_at)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.title}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteTarget(row)}>
                            <Trash2 aria-hidden="true" />
                            Delete envelope
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </Surface>

      {deleteTarget && (
        <DeleteEnvelopeDialog
          envelopeId={deleteTarget.id}
          envelopeTitle={deleteTarget.title}
          envelopeStatus={deleteTarget.status}
          open
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
