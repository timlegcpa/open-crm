import { FileText } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

const DocumentsPage = lazyNamed(() => import('./pages'), 'DocumentsPage');
const DocumentPage = lazyNamed(() => import('./pages'), 'DocumentPage');
const PortalDocumentsPage = lazyNamed(() => import('./pages'), 'PortalDocumentsPage');
const DocumentsTab = lazyNamed(() => import('./pages'), 'DocumentsTab');
const DocumentsCard = lazyNamed(() => import('./pages'), 'DocumentsCard');
const UnreviewedNavBadge = lazyNamed(() => import('./badges'), 'UnreviewedNavBadge');
const UnreviewedContactBadge = lazyNamed(() => import('./badges'), 'UnreviewedContactBadge');

export const manifest: FeatureManifest = {
  id: 'documents',
  ownerNav: [{ label: 'Documents', icon: FileText, path: '/documents', order: 30, section: 'workflow', badge: UnreviewedNavBadge }],
  ownerRoutes: [
    // The explorer and the workstation lay out their own scrolling panes.
    { path: 'documents', element: <DocumentsPage />, handle: BOUNDED_PAGE },
    { path: 'documents/:id', element: <DocumentPage />, handle: BOUNDED_PAGE },
  ],
  portalTabs: [{ label: 'Documents', icon: FileText, path: '/portal/documents', order: 20 }],
  portalRoutes: [{ path: 'documents', element: <PortalDocumentsPage /> }],
  portalHomeCards: [{ key: 'documents', order: 20, Component: DocumentsCard }],
  contactTabs: [{ key: 'documents', label: 'Documents', order: 20, Component: DocumentsTab, badge: UnreviewedContactBadge }],
};
