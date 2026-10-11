import { Inbox } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const RequestsPage = lazyNamed(() => import('./pages'), 'RequestsPage');
const NewRequestPage = lazyNamed(() => import('./pages'), 'NewRequestPage');
const RequestPage = lazyNamed(() => import('./pages'), 'RequestPage');
const PortalRequestPage = lazyNamed(() => import('./pages'), 'PortalRequestPage');
const RequestsTab = lazyNamed(() => import('./pages'), 'RequestsTab');
const RequestsCard = lazyNamed(() => import('./pages'), 'RequestsCard');
const StartPage = lazyNamed(() => import('./public/StartPage'), 'StartPage');

export const manifest: FeatureManifest = {
  id: 'requests',
  ownerNav: [{ label: 'Requests', icon: Inbox, path: '/requests', order: 20, section: 'workflow' }],
  ownerRoutes: [
    { path: 'requests', element: <RequestsPage /> },
    { path: 'requests/new', element: <NewRequestPage /> },
    { path: 'requests/:id', element: <RequestPage /> },
  ],
  portalRoutes: [{ path: 'requests/:id', element: <PortalRequestPage /> }],
  portalHomeCards: [{ key: 'requests', order: 10, Component: RequestsCard }],
  publicRoutes: [{ path: 'start/*', element: <StartPage /> }],
  contactTabs: [{ key: 'requests', label: 'Requests', order: 30, Component: RequestsTab }],
};
