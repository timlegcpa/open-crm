import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Archive, ListPlus, Search, SquareKanban, X } from 'lucide-react';
import { contactDisplayName, isUuid } from '@/api/contacts';
import { EmptyState, PageHeader } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageTabsList, PageTabsTrigger } from '@/components/ui/page-tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { getErrorMessage } from '@/lib/errors';
import { safeStorage, storageKey } from '@/lib/storage';
import type { BoardStageKey } from './api';
import { boardCardCount, boardIsEmpty, bucketBoardCards, cardDescriptionsById, filterWorkItems, parseHiddenLanes } from './board';
import { AddWorkItemDialog } from './components/AddWorkItemDialog';
import { ArchivedDialog } from './components/ArchivedDialog';
import { Board } from './components/Board';
import { BoardActivity } from './components/BoardActivity';
import { BoardFigures } from './components/BoardFigures';
import { BoardOverview } from './components/BoardOverview';
import { useBoardStages, useOpenWorkItems, useWorkItemTypes } from './hooks';

type BoardTab = 'board' | 'overview' | 'activity';

/** Which lanes this viewer has hidden: a per-browser convenience, so browser storage. */
export const HIDDEN_LANES_KEY = storageKey('board', 'hiddenLanes');
const anyJson = (_value: unknown): _value is unknown => true;

function readHiddenLanes(): BoardStageKey[] {
  return parseHiddenLanes(safeStorage.getJson(HIDDEN_LANES_KEY, anyJson));
}

/**
 * The work board. One board, one query path: there is no second, lighter wiring of it
 * anywhere, since two boards fed by two query paths is how they drift apart.
 *
 * The page fills the window below the top bar (a bounded page) and never scrolls itself;
 * the lanes, the Overview and the Activity feed scroll inside their own areas.
 *
 * Deep links: `?contact=<id>` narrows the board to one contact's cards (and says whose it
 * is); `?new=work` opens Add work item once and is then stripped; /board/<id> opens that
 * card's history once it is on the board.
 */
export function BoardPage() {
  const { itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const contactParam = searchParams.get('contact') ?? undefined;
  // A parameter reaches a query only once it is known to be a uuid.
  const contactFilter = isUuid(contactParam) ? contactParam : null;

  const itemsQuery = useOpenWorkItems();
  const stages = useBoardStages();
  const types = useWorkItemTypes();

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<BoardTab>('board');
  const [hiddenLanes, setHiddenLanes] = useState<BoardStageKey[]>(readHiddenLanes);
  const updateHiddenLanes = (next: BoardStageKey[]) => {
    setHiddenLanes(next);
    // Storage may be unavailable; the choice then lasts until reload.
    safeStorage.setJson(HIDDEN_LANES_KEY, next);
  };
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addStage, setAddStage] = useState<BoardStageKey>('todo');
  const openAdd = (stage: BoardStageKey = 'todo') => {
    setAddStage(stage);
    setAddOpen(true);
  };

  // `?new=work` is consumed once and stripped, keeping the other params, so a reload does
  // not reopen the dialog.
  useEffect(() => {
    if (searchParams.get('new') !== 'work') return;
    setAddStage('todo');
    setAddOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const allItems = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const visibleItems = useMemo(() => filterWorkItems(allItems, query, contactFilter), [allItems, query, contactFilter]);
  // Bucketed once for the figures, the subtitle and the empty gate; the board buckets
  // again because it also draws the in-flight lane order.
  const columns = useMemo(() => bucketBoardCards(visibleItems), [visibleItems]);
  const cardCount = boardCardCount(columns);
  const descriptions = useMemo(() => cardDescriptionsById(allItems), [allItems]);
  const filteredContact = contactFilter ? allItems.find((i) => i.contact_id === contactFilter)?.contact ?? null : null;
  const filtersActive = query !== '' || contactParam !== undefined;

  const clearFilters = useCallback(() => {
    setQuery('');
    if (searchParams.has('contact')) {
      const next = new URLSearchParams(searchParams);
      next.delete('contact');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Every query the board's writes depend on gates it: painting a failed or still-loading
  // read as an empty board hides the failure, and a lane sort saved before the lanes had
  // loaded would save an order nobody saw.
  const loading = itemsQuery.isPending || stages.query.isPending || types.query.isPending;
  const failed = itemsQuery.error ?? stages.query.error ?? types.query.error;

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3.5 md:grid-cols-4" aria-busy="true" aria-label="Loading the board">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-64 w-full" />
        ))}
      </div>
    );
  } else if (failed) {
    body = <EmptyState icon={<SquareKanban />} title="Could not load the board" description={getErrorMessage(failed, 'Please try again.')} />;
  } else if (allItems.length === 0) {
    body = (
      <EmptyState
        icon={<SquareKanban />}
        title="Nothing on the board yet"
        description="Add a work item to start a lane."
        action={
          <Button type="button" size="sm" onClick={() => openAdd()}>
            Add work item
          </Button>
        }
      />
    );
  } else if (boardIsEmpty(columns)) {
    body = <EmptyState icon={<SquareKanban />} title="No card matches these filters" description="Clear them, or open Archived." />;
  } else {
    body = (
      <>
        <TabsContent value="board" className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <Board
            items={visibleItems}
            laneItems={allItems}
            hiddenLanes={hiddenLanes}
            onHideLane={(stage) => updateHiddenLanes([...hiddenLanes, stage])}
            onShowLane={(stage) => updateHiddenLanes(hiddenLanes.filter((s) => s !== stage))}
            onAddToLane={openAdd}
            openItemId={isUuid(itemId) ? itemId : null}
          />
        </TabsContent>
        <TabsContent value="overview" className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <BoardOverview
            columns={columns}
            board={stages.columns}
            onPickContact={(name) => {
              setQuery(name);
              setTab('board');
            }}
          />
        </TabsContent>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-4 pb-4 pt-4 md:px-5">
      <PageHeader
        title="Board"
        subtitle={`${cardCount} ${cardCount === 1 ? 'card' : 'cards'} on the board`}
        actions={
          <>
            <Button type="button" variant="outline" size="xs" onClick={() => openAdd()}>
              <ListPlus aria-hidden="true" />
              Add work item
            </Button>
            <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setArchivedOpen(true)}>
              <Archive aria-hidden="true" />
              Archived
            </Button>
          </>
        }
      />

      {!loading && !failed && <BoardFigures columns={columns} board={stages.columns} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as BoardTab)} className="flex min-h-0 flex-1 flex-col gap-4">
        <PageTabsList aria-label="Board view">
          <PageTabsTrigger value="board">Board</PageTabsTrigger>
          <PageTabsTrigger value="overview">Overview</PageTabsTrigger>
          <PageTabsTrigger value="activity">Activity</PageTabsTrigger>
        </PageTabsList>

        {/* The filters narrow the board and the Overview; Activity is the whole board's history. */}
        {tab !== 'activity' && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-[240px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search cards"
                aria-label="Search cards"
                className="h-8 pl-8 text-[12.5px]"
              />
            </div>
            {contactParam !== undefined && (
              // Say whose board this is: a silently narrowed list is the same defect as a
              // silently dropped filter, one screen later.
              <span className="text-[12px] text-muted-foreground">
                Showing{' '}
                <span className="font-medium text-foreground">{filteredContact ? contactDisplayName(filteredContact) : 'one contact'}</span>
              </span>
            )}
            {filtersActive && (
              <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>
                <X aria-hidden="true" />
                Clear
              </Button>
            )}
          </div>
        )}

        {tab === 'activity' ? null : body}
        <TabsContent value="activity" className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <BoardActivity descriptions={descriptions} />
        </TabsContent>
      </Tabs>

      <AddWorkItemDialog open={addOpen} onOpenChange={setAddOpen} defaultStage={addStage} />
      <ArchivedDialog open={archivedOpen} onOpenChange={setArchivedOpen} />
    </div>
  );
}

/** One card: the board, with that card's history open (links.boardItem). */
export const BoardItemPage = BoardPage;
