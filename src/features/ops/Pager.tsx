import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Previous / next under a paged list. Hidden when everything fits on the first page. */
export function Pager({ page, hasMore, onPage, label }: { page: number; hasMore: boolean; onPage: (page: number) => void; label: string }) {
  if (page === 0 && !hasMore) return null;
  return (
    <nav aria-label={`${label} pages`} className="flex items-center justify-end gap-2 pt-3">
      <span className="text-xs text-muted-foreground">Page {page + 1}</span>
      <Button variant="outline" size="xs" disabled={page === 0} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden="true" />
        Newer
      </Button>
      <Button variant="outline" size="xs" disabled={!hasMore} onClick={() => onPage(page + 1)}>
        Older
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
