import { createContext, useContext } from 'react';

/**
 * The client panel's search, owned by the workspace layout and shared with the screens that
 * narrow by it (the pipeline board, the tier rows, the table): one box, one query. It
 * outlives a change of screen, since the panel stays mounted while the view beside it
 * changes. Outside the workspace there is nothing to share, so it reads empty.
 */
export interface WorkspaceSearch {
  query: string;
  setQuery: (query: string) => void;
}

export const WorkspaceSearchContext = createContext<WorkspaceSearch>({ query: '', setQuery: () => {} });

export function useWorkspaceSearch(): WorkspaceSearch {
  return useContext(WorkspaceSearchContext);
}
