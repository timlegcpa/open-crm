import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { boardKeys, listArchivedWorkItems, restoreWorkItem, type WorkItem } from '../api';
import { cardContactName } from '../board';

/**
 * Archived: the one place archived cards are listed. It is a dialog behind a page action,
 * not a strip on the board. Newest archive first; Restore puts a card back in the lane it
 * left (and restarts its 14-day clock if that lane is Done).
 */
export function ArchivedDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const archived = useQuery({ queryKey: boardKeys.archived(), queryFn: listArchivedWorkItems, enabled: open });
  const restoreMutation = useMutation({
    mutationFn: (item: WorkItem) => restoreWorkItem(item.id),
    onSuccess: () => toast.success('Restored to the board.'),
    onError: (err) => toast.error('Could not restore this card.', { description: getErrorMessage(err, 'Please try again.') }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });

  const items = useMemo(
    () => [...(archived.data ?? [])].sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '') || a.id.localeCompare(b.id)),
    [archived.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col">
        <DialogHeader>
          <DialogTitle>Archived</DialogTitle>
          <DialogDescription>Archived cards, newest first. Restore puts one back in the lane it left.</DialogDescription>
        </DialogHeader>
        {archived.isPending ? (
          <p className="py-4 text-[13px] text-muted-foreground">Loading...</p>
        ) : archived.isError ? (
          <p role="alert" className="py-4 text-[13px] text-destructive">
            {getErrorMessage(archived.error, 'Could not load archived cards.')}
          </p>
        ) : items.length === 0 ? (
          <p className="py-4 text-[13px] text-muted-foreground">Nothing archived.</p>
        ) : (
          <ScrollArea fitWidth className="min-h-0 [&>[data-radix-scroll-area-viewport]]:max-h-[60vh]">
            <ul className="divide-y divide-border pr-3">
              {items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-foreground">{item.title}</div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {[cardContactName(item), `archived ${formatDate(item.archived_at)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    aria-label={`Restore ${item.title}`}
                    disabled={restoreMutation.isPending}
                    onClick={() => restoreMutation.mutateAsync(item).catch(() => undefined)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
