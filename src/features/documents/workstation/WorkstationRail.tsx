import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import type { WorkstationGroup } from '../lib/documentWorkstation';
import type { WorkstationScope } from './useWorkstationDocs';
import { Button } from '@/components/ui/button';
import { ClickRegion } from '@/components/ui/click-region';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import type { Section } from '../types';

const SECTION_OPTIONS: ReadonlyArray<{ value: Section; label: string }> = [
  { value: 'client', label: 'Uploaded' },
  { value: 'owner', label: 'Shared' },
];

export interface WorkstationRailProps {
  groups: WorkstationGroup[];
  activeId: string | null;
  scope: WorkstationScope;
  /** False in the shared section: only the contact's uploads carry a review state. */
  showReviewState: boolean;
  onSelect: (docId: string) => void;
  onSectionChange: (heldBy: Section) => void;
  /** Drop a file on a folder heading to move it there. */
  onMoveDoc?: (docId: string, folderPath: string) => void;
}

const DRAG_TYPE = 'application/x-document-id';

export default function WorkstationRail({
  groups,
  activeId,
  scope,
  showReviewState,
  onSelect,
  onSectionChange,
  onMoveDoc,
}: WorkstationRailProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropOn, setDropOn] = useState<string | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Keep the arrow-key selection visible when it moves past the fold.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function toggleGroup(folderPath: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }

  return (
    <div className="flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-card">
      {scope.kind === 'section' && (
        <div className="border-b border-border p-2">
          <Segmented
            value={scope.heldBy}
            onValueChange={onSectionChange}
            options={SECTION_OPTIONS}
            label="Document section"
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
      <div className="py-1" role="listbox" aria-label="Documents">
        {groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No documents here.</p>
        )}

        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.folderPath);
          return (
            <div
              key={group.folderPath}
              data-folder={group.folderPath}
              onDragOver={(e) => {
                if (!onMoveDoc || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropOn(group.folderPath);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
              }}
              onDrop={(e) => {
                const docId = e.dataTransfer.getData(DRAG_TYPE);
                setDropOn(null);
                if (!onMoveDoc || !docId) return;
                e.preventDefault();
                onMoveDoc(docId, group.folderPath);
              }}
              className={cn('rounded-md', dropOn === group.folderPath && 'bg-accent ring-1 ring-ring')}
            >
              <ClickRegion
                onClick={() => toggleGroup(group.folderPath)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3"
              >
                {isCollapsed ? (
                  <ChevronRight className="shrink-0" />
                ) : (
                  <ChevronDown className="shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide">
                  {group.label}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.docs.length}
                </span>
              </ClickRegion>

              {!isCollapsed &&
                group.docs.map((doc) => {
                  const isActive = doc.id === activeId;
                  return (
                    <Button
                      key={doc.id}
                      ref={isActive ? activeRef : undefined}
                      variant="ghost"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => onSelect(doc.id)}
                      title={doc.name}
                      draggable={!!onMoveDoc}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, doc.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDropOn(null)}
                      // The selected row is the SAME recipe as the explorer's
                      // contact index (`bg-accent`, one rounded bar).
                      className={cn(
                        'flex w-full items-center justify-start gap-1.5 rounded-md py-1 pl-6 pr-2',
                        'text-left text-xs [&_svg]:size-3.5',
                        isActive
                          ? 'bg-accent text-foreground hover:bg-accent'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {showReviewState && (
                        <span className="flex w-3 shrink-0 justify-center">
                          {doc.reviewedAt ? (
                            // `--success` fails 4.5:1 on a light background;
                            // the dark shade passes.
                            <Check className="text-success-dark" aria-label="Reviewed" />
                          ) : (
                            <span
                              className="size-1.5 rounded-full bg-primary"
                              aria-label="Unreviewed"
                            />
                          )}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                    </Button>
                  );
                })}
            </div>
          );
        })}
      </div>
      </ScrollArea>
    </div>
  );
}
