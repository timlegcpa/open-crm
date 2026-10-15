import { House } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const PortalLayout = lazyNamed(() => import('./PortalLayout'), 'PortalLayout');
const PortalHomePage = lazyNamed(() => import('./pages/HomePage'), 'PortalHomePage');
const PortalProfilePage = lazyNamed(() => import('./pages/ProfilePage'), 'PortalProfilePage');
const PortalAccessPanel = lazyNamed(() => import('./owner/PortalAccessPanel'), 'PortalAccessPanel');
const InvitePage = lazyNamed(() => import('./public/InvitePage'), 'InvitePage');

export const manifest: FeatureManifest = {
  id: 'portal',
  portalLayout: PortalLayout,
  // Profile is reached from the account menu ("Your account"), so it is not a section tab.
  portalTabs: [{ label: 'Home', icon: House, path: '/portal', order: 10, end: true }],
  portalRoutes: [
    { index: true, element: <PortalHomePage /> },
    { path: 'profile', element: <PortalProfilePage /> },
  ],
  publicRoutes: [{ path: 'invite/*', element: <InvitePage /> }],
  // The right bar shows on wide screens only, so the same panel is also a tab.
  contactSidePanels: [{ key: 'portal', order: 10, Component: PortalAccessPanel }],
  contactTabs: [{ key: 'portal', label: 'Portal', order: 60, Component: PortalAccessPanel }],
};
