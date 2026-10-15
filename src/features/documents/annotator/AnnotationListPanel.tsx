import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { ClickRegion } from '@/components/ui/click-region';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SectionHeader } from '@/components/layout/page';
import { describeAnnotation, type DocumentAnnotation } from '../lib/annotations';

interface AnnotationListPanelProps {
  annotations: DocumentAnnotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 0-based, matching `page_index` and the `data-annotator-page` attribute. */
  onJumpToPage: (pageIndex: number) => void;
  onRemove: (id: string) => void;
}

/**
 * Every mark on the OPEN document, in reading order, each row clicking through
 * to where it sits. Deliberately per-document rather than a cross-document
 * roll-up: the workstation rail's green ticks already carry review state
 * across documents.
 */
export default function AnnotationListPanel({
  annotations,
  selectedId,
  onSelect,
  onJumpToPage,
  onRemove,
}: AnnotationListPanelProps) {
  // Reading order: page first, then when it was drawn. `annotations` arrives in
  // insertion order, which walks pages arbitrarily once you scroll back up.
  // Memoized: the open panel re-renders with every PdfSurface render (scroll,
  // selection), and the list itself only changes when the annotations do.
  const ordered = useMemo(
    () =>
      [...annotations].sort(
        (a, b) => a.page_index - b.page_index || a.created_at.localeCompare(b.created_at),
      ),
    [annotations],
  );

  return (
    <div className="flex h-full w-[240px] shrink-0 flex-col border-l border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <SectionHeader
          title={<>Marks{ordered.length > 0 && ` (${ordered.length})`}</>}
          className="mb-0"
        />
      </div>

      {ordered.length === 0 ? (
        <p className="px-3 py-6 text-center text-[12px] italic text-muted-foreground">
          No marks on this document yet.
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {ordered.map((a) => {
            const isSelected = a.id === selectedId;
            return (
              <div
                key={a.id}
                className={`group flex items-start gap-2 border-b border-border px-3 py-2 transition-colors ${
                  isSelected ? 'bg-accent' : 'hover:bg-muted'
                }`}
              >
                <ClickRegion
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    onSelect(a.id);
                    onJumpToPage(a.page_index);
                  }}
                >
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {describeAnnotation(a)}
                  </div>
                  <div className="text-[12px] text-muted-foreground">
                    Page {a.page_index + 1} · {formatDateTime(a.created_at)}
                  </div>
                </ClickRegion>
                <Button variant="ghost" size="icon-sm" className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive [&_svg]:size-3.5"
                  type="button"
                  aria-label="Delete mark"
                  onClick={() => onRemove(a.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </ScrollArea>
      )}
    </div>
  );
}
