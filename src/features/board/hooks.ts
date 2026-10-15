import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useByKey, usePickList } from '@/hooks/usePickLists';
import { BOARD_STAGES, boardKeys, listOpenWorkItems, listWorkItemEvents, WORK_ITEM_TYPES } from './api';
import { boardColumns } from './board';

/** The lanes (labels, colours, order) and the rows by key. */
export function useBoardStages() {
  const query = usePickList(BOARD_STAGES);
  const rows = useByKey(query.data);
  const columns = useMemo(() => boardColumns(rows), [rows]);
  return { query, rows, columns };
}

/** The work item types and the rows by key. */
export function useWorkItemTypes() {
  const query = usePickList(WORK_ITEM_TYPES);
  const rows = useByKey(query.data);
  return { query, rows };
}

/** Every card on the board. */
export function useOpenWorkItems() {
  return useQuery({ queryKey: boardKeys.open(), queryFn: listOpenWorkItems, staleTime: 2 * 60_000 });
}

/**
 * The one definition of the history read. The board (each card's last note, the history
 * dialog) and the Activity tab share it, so a note or a move written from either settles
 * both. There must be no second, lighter wiring of it.
 */
export function useBoardHistory() {
  return useQuery({ queryKey: boardKeys.events(), queryFn: listWorkItemEvents, staleTime: 2 * 60_000 });
}
