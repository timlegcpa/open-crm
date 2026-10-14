import { SquareKanban } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const BoardPage = lazyNamed(() => import('./pages'), 'BoardPage');
const BoardItemPage = lazyNamed(() => import('./pages'), 'BoardItemPage');

export const manifest: FeatureManifest = {
  id: 'board',
  ownerNav: [{ label: 'Board', icon: SquareKanban, path: '/board', order: 10, section: 'workflow' }],
  ownerRoutes: [
    { path: 'board', element: <BoardPage /> },
    { path: 'board/:itemId', element: <BoardItemPage /> },
  ],
};
