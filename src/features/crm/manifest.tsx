import { Navigate } from 'react-router-dom';
import { Layers, Table2, Users, Workflow } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { links } from '@/features/links';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

const ContactsList = lazyNamed(() => import('@/pages/contacts/ContactsList'), 'ContactsList');
const ContactIntake = lazyNamed(() => import('@/pages/contacts/ContactIntake'), 'ContactIntake');
const ContactWorkspace = lazyNamed(() => import('@/pages/contacts/ContactWorkspace'), 'ContactWorkspace');
const BillingTab = lazyNamed(() => import('./components/BillingTab'), 'BillingTab');
const ActivityTab = lazyNamed(() => import('./components/ActivityTab'), 'ActivityTab');
const ClientsCount = lazyNamed(() => import('@/features/workspace/bookCounts'), 'ClientsCount');
const OpenLeadsCount = lazyNamed(() => import('@/features/workspace/bookCounts'), 'OpenLeadsCount');

export const manifest: FeatureManifest = {
  id: 'crm',
  // The workspace's door: lit on every workspace screen no other rail item claims.
  ownerNav: [{ label: 'Contacts', icon: Users, path: '/contacts', order: 10, workspace: true }],
  ownerRoutes: [
    // The owner's home is the contacts page.
    { index: true, element: <Navigate to="/contacts" replace /> },
    { path: 'contacts/new', element: <ContactIntake /> },
  ],
  workspaceRoutes: [
    {
      // The board, the tier rows and the table lay out their own scrolling; the record
      // nests under the page (links.contact, links.contactTab). On a phone the client panel
      // is the screen, except on Tiers (its rows show at any width) and on a record.
      path: 'contacts',
      element: <ContactsList />,
      handle: { ...BOUNDED_PAGE, panelFirst: (search: URLSearchParams) => search.get('tab') !== 'tiers' },
      children: [
        { path: ':id', element: <ContactWorkspace />, handle: BOUNDED_PAGE },
        { path: ':id/:tab', element: <ContactWorkspace />, handle: BOUNDED_PAGE },
      ],
    },
  ],
  workspaceTabs: [
    { key: 'pipeline', label: 'Pipeline', icon: Workflow, path: '/contacts?tab=pipeline', order: 20 },
    { key: 'tiers', label: 'Tiers', icon: Layers, path: '/contacts?tab=tiers', order: 40 },
    { key: 'table', label: 'Table', icon: Table2, path: '/contacts?tab=table', order: 45 },
  ],
  newMenu: [{ key: 'contact', label: 'Contact', icon: Users, order: 10, path: links.newContact() }],
  shellCounts: [
    { key: 'clients', label: 'Clients', path: '/contacts', order: 10, kind: 'total', Count: ClientsCount },
    { key: 'open-leads', label: 'Open leads', path: '/contacts?tab=pipeline', order: 20, kind: 'total', Count: OpenLeadsCount },
  ],
  contactTabs: [
    { key: 'billing', label: 'Billing', order: 10, Component: BillingTab },
    { key: 'activity', label: 'Activity', order: 90, Component: ActivityTab },
  ],
};
