import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getErrorMessage } from '@/lib/errors';
import { listRequests } from '../api';
import { LIST_REFRESH, requestKeys } from '../keys';
import { ARCHIVED_SECTION, requestRosterSections } from '../lib/requests';
import { NewRequestDialog } from './NewRequestDialog';
import { RequestRoster } from './RequestRoster';

/**
 * One contact's requests above their folders on the Documents screen, so the owner can pick
 * a contact and work through what they asked for and what came in without leaving the
 * files. The same rows and grouping as the Requests page (archived folded until asked), a
 * New request with the contact filled in, and its own scroll region capped at a share of
 * the pane so the folders keep the rest. Additive: the folder view below is unchanged.
 */
export function ContactRequestsStrip({ contactId, contactName }: { contactId: string; contactName: string }) {
  const [expanded, setExpanded] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const requests = useQuery({ queryKey: requestKeys.forContact(contactId), queryFn: () => listRequests(contactId), ...LIST_REFRESH });
  const data = requests.data ?? [];
  const openCount = requestRosterSections(data, () => '')
    .filter((s) => s.key !== ARCHIVED_SECTION)
    .reduce((n, s) => n + s.rows.length, 0);

  return (
    <section aria-label="Requests" className="shrink-0 border-b border-border">
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <Button size="sm" variant="ghost" className="font-semibold" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {requests.data ? `Requests (${openCount} open)` : 'Requests'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
          <Plus aria-hidden /> New request
        </Button>
      </div>
      {expanded && (
        <ScrollArea fitWidth className="[&>[data-radix-scroll-area-viewport]]:max-h-[40vh]">
          <div className="pb-2">
            {requests.isPending && <p className="px-4 py-1.5 text-[13px] text-muted-foreground">Loading requests...</p>}
            {requests.error && (
              <p role="alert" className="px-4 py-1.5 text-[13px] text-destructive">
                Could not load requests: {getErrorMessage(requests.error)}
              </p>
            )}
            {requests.data?.length === 0 && <p className="px-4 py-1.5 text-[13px] text-muted-foreground">No requests for this contact.</p>}
            {data.length > 0 && <RequestRoster requests={data} variant="compact" />}
          </div>
        </ScrollArea>
      )}
      <NewRequestDialog open={newOpen} onOpenChange={setNewOpen} defaultContact={{ id: contactId, name: contactName }} />
    </section>
  );
}
