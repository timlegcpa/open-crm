import { SquareKanban } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

const BoardPage = lazyNamed(() => import('./pages'), 'BoardPage');
const BoardItemPage = lazyNamed(() => import('./pages'), 'BoardItemPage');

export const manifest: FeatureManifest = {
  id: 'board',
  ownerNav: [{ label: 'Board', icon: SquareKanban, path: '/board', order: 10, section: 'workflow' }],
  ownerRoutes: [
    // The lanes scroll inside the page, never the page itself.
    { path: 'board', element: <BoardPage />, handle: BOUNDED_PAGE },
    // One card: the board with that card's history open.
    { path: 'board/:itemId', element: <BoardItemPage />, handle: BOUNDED_PAGE },
  ],
};
