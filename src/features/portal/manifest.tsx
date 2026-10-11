import { House, UserRound } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const PortalLayout = lazyNamed(() => import('./PortalLayout'), 'PortalLayout');
const PortalHomePage = lazyNamed(() => import('./pages'), 'PortalHomePage');
const PortalProfilePage = lazyNamed(() => import('./pages'), 'PortalProfilePage');
const PortalAccessTab = lazyNamed(() => import('./pages'), 'PortalAccessTab');
const InvitePage = lazyNamed(() => import('./public/InvitePage'), 'InvitePage');

export const manifest: FeatureManifest = {
  id: 'portal',
  portalLayout: PortalLayout,
  portalTabs: [
    { label: 'Home', icon: House, path: '/portal', order: 10, end: true },
    { label: 'Profile', icon: UserRound, path: '/portal/profile', order: 90 },
  ],
  portalRoutes: [
    { index: true, element: <PortalHomePage /> },
    { path: 'profile', element: <PortalProfilePage /> },
  ],
  publicRoutes: [{ path: 'invite/*', element: <InvitePage /> }],
  contactTabs: [{ key: 'portal', label: 'Portal', order: 60, Component: PortalAccessTab }],
};
