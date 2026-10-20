import { Inbox } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

// Owner screens, the portal page, the badges and settings are separate chunks: a badge in
// the tab strip must not pull the builder in with it, and the portal never loads the owner's code.
const RequestsPage = lazyNamed(() => import('./pages'), 'RequestsPage');
const NewRequestPage = lazyNamed(() => import('./pages'), 'NewRequestPage');
const RequestPage = lazyNamed(() => import('./pages'), 'RequestPage');
const RequestsTab = lazyNamed(() => import('./pages'), 'RequestsTab');
const NewRequestAction = lazyNamed(() => import('./pages'), 'NewRequestAction');
const OwnerAwaitingBadge = lazyNamed(() => import('./badges'), 'OwnerAwaitingBadge');
const OwnerAwaitingCount = lazyNamed(() => import('./badges'), 'OwnerAwaitingCount');
const NewRequestDialog = lazyNamed(() => import('./components/NewRequestDialog'), 'NewRequestDialog');
const ContactAwaitingBadge = lazyNamed(() => import('./badges'), 'ContactAwaitingBadge');
const RequestsSettings = lazyNamed(() => import('./settings'), 'RequestsSettings');
const PortalRequestPage = lazyNamed(() => import('./portal'), 'PortalRequestPage');
const RequestsCard = lazyNamed(() => import('./portal'), 'RequestsCard');
const StartPage = lazyNamed(() => import('./public/StartPage'), 'StartPage');

export const manifest: FeatureManifest = {
  id: 'requests',
  workspaceTabs: [{ key: 'requests', label: 'Requests', icon: Inbox, path: '/requests', order: 50, badge: OwnerAwaitingBadge }],
  workspaceRoutes: [{ path: 'requests', element: <RequestsPage /> }],
  ownerRoutes: [
    { path: 'requests/new', element: <NewRequestPage /> },
    { path: 'requests/:id', element: <RequestPage /> },
  ],
  // Choose the contact, then the builder opens for them.
  newMenu: [{ key: 'request', label: 'Request', icon: Inbox, order: 30, Dialog: NewRequestDialog }],
  shellCounts: [{ key: 'to-accept', label: 'To accept', path: '/requests', order: 30, kind: 'waiting', Count: OwnerAwaitingCount }],
  portalRoutes: [{ path: 'requests/:id', element: <PortalRequestPage /> }],
  portalHomeCards: [{ key: 'requests', order: 10, Component: RequestsCard }],
  publicRoutes: [{ path: 'start/*', element: <StartPage /> }],
  contactTabs: [{ key: 'requests', label: 'Requests', order: 30, Component: RequestsTab, badge: ContactAwaitingBadge }],
  contactHeaderActions: [{ key: 'new-request', order: 20, Component: NewRequestAction }],
  settingsSections: [{ key: 'requests', label: 'Requests', order: 40, Component: RequestsSettings }],
};
