import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TABLE_TH, TABLE_TR } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime, NO_VALUE_TEXT } from '@/lib/format';
import { getEvents } from '../api';
import { esignKeys } from '../keys';
import { eventLabel, summarizeEvent } from '../lib/eventLabels';
import { resolveSignerName } from '../lib/signerName';

const EVENTS_PAGE_SIZE = 50;

/** The envelope's event log, newest first, fifty to a page. Polls while the envelope is out. */
export function EventLogTable({ envelopeId, live }: { envelopeId: string; live: boolean }) {
  const [page, setPage] = useState(0);
  const events = useQuery({
    queryKey: esignKeys.events(envelopeId),
    queryFn: () => getEvents(envelopeId),
    refetchInterval: live ? 30_000 : false,
    refetchOnWindowFocus: live,
  });

  const all = events.data ?? [];
  const totalPages = Math.max(1, Math.ceil(all.length / EVENTS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const shown = all.slice(safePage * EVENTS_PAGE_SIZE, (safePage + 1) * EVENTS_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border">
        <ScrollArea horizontal>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={`${TABLE_TH} w-44`}>When</TableHead>
                <TableHead className={`${TABLE_TH} w-44`}>Event</TableHead>
                <TableHead className={`${TABLE_TH} w-48`}>Signer</TableHead>
                <TableHead className={`${TABLE_TH} w-32`}>IP</TableHead>
                <TableHead className={TABLE_TH}>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Loading events...
                  </TableCell>
                </TableRow>
              ) : events.isError ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-destructive" role="alert">
                    Could not load the events: {getErrorMessage(events.error)}
                  </TableCell>
                </TableRow>
              ) : shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    No events yet.
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((e) => (
                  <TableRow key={e.id} className={TABLE_TR}>
                    <TableCell className="whitespace-nowrap text-[13px] text-muted-foreground">{formatDateTime(e.created_at)}</TableCell>
                    <TableCell className="text-[13px] font-medium">{eventLabel(e.event_type)}</TableCell>
                    <TableCell className="text-[13px]">{e.signer ? resolveSignerName(e.signer) : NO_VALUE_TEXT}</TableCell>
                    <TableCell className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">{e.ip ? String(e.ip) : NO_VALUE_TEXT}</TableCell>
                    <TableCell className="break-words text-[13px] text-muted-foreground">{summarizeEvent(e.event_type, e.metadata)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      {all.length > EVENTS_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Page {safePage + 1} of {totalPages}, {all.length} events
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
