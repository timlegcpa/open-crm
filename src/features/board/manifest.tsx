import { SquareKanban } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

const BoardPage = lazyNamed(() => import('./pages'), 'BoardPage');
const BoardItemPage = lazyNamed(() => import('./pages'), 'BoardItemPage');
const AddWorkItemDialog = lazyNamed(() => import('./components/AddWorkItemDialog'), 'AddWorkItemDialog');

export const manifest: FeatureManifest = {
  id: 'board',
  workspaceTabs: [{ key: 'board', label: 'Board', icon: SquareKanban, path: '/board', order: 10 }],
  workspaceRoutes: [
    // The lanes scroll inside the page, never the page itself.
    { path: 'board', element: <BoardPage />, handle: BOUNDED_PAGE },
    // One card: the board with that card's history open.
    { path: 'board/:itemId', element: <BoardItemPage />, handle: BOUNDED_PAGE },
  ],
  // Opens on the page the owner is on, never by sending them to the board.
  newMenu: [{ key: 'work-item', label: 'Work item', icon: SquareKanban, order: 20, Dialog: AddWorkItemDialog }],
};
