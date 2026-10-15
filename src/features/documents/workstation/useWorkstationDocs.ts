import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { documentKeys, listDocumentsAtPath, listDocumentsForContact } from '../api';
import {
  toWorkstationDoc,
  groupDocsByFolder,
  flattenGroups,
  type WorkstationDoc,
  type WorkstationGroup,
} from '../lib/documentWorkstation';
import type { Section } from '../types';

export type WorkstationScope =
  | { kind: 'section'; heldBy: Section }
  | { kind: 'folder'; heldBy: Section; folderPath: string };

/**
 * The rail's document set. Section scope spans every folder of one section
 * (shared or uploaded) of the contact; folder scope is a single folder.
 *
 * Owned by the shell, not the rail: the shell needs `ordered` for arrow-key
 * traversal and the review sweep.
 */
export function useWorkstationDocs(
  contactId: string,
  scope: WorkstationScope,
): { groups: WorkstationGroup[]; ordered: WorkstationDoc[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey:
      scope.kind === 'section'
        ? [...documentKeys.forContact(contactId), scope.heldBy]
        : documentKeys.atPath(contactId, scope.folderPath, scope.heldBy),
    queryFn: () =>
      scope.kind === 'section'
        ? listDocumentsForContact(contactId, scope.heldBy)
        : listDocumentsAtPath(contactId, scope.folderPath, scope.heldBy),
    enabled: !!contactId,
  });

  const groups = useMemo(
    () => groupDocsByFolder((data ?? []).map((row) => toWorkstationDoc({ ...row }))),
    [data],
  );
  const ordered = useMemo(() => flattenGroups(groups), [groups]);

  return { groups, ordered, isLoading };
}
