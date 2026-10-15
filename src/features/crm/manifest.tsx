import { Navigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

const ContactsList = lazyNamed(() => import('@/pages/contacts/ContactsList'), 'ContactsList');
const ContactIntake = lazyNamed(() => import('@/pages/contacts/ContactIntake'), 'ContactIntake');
const ContactWorkspace = lazyNamed(() => import('@/pages/contacts/ContactWorkspace'), 'ContactWorkspace');
const BillingTab = lazyNamed(() => import('./components/BillingTab'), 'BillingTab');
const ActivityTab = lazyNamed(() => import('./components/ActivityTab'), 'ActivityTab');

export const manifest: FeatureManifest = {
  id: 'crm',
  ownerNav: [{ label: 'Contacts', icon: Users, path: '/contacts', order: 10 }],
  ownerRoutes: [
    // The owner's home is the contacts page.
    { index: true, element: <Navigate to="/contacts" replace /> },
    { path: 'contacts/new', element: <ContactIntake /> },
    {
      // The index pane and the board lay out their own scrolling; the record nests beside
      // the index (links.contact, links.contactTab) and inherits the bounded page.
      path: 'contacts',
      element: <ContactsList />,
      handle: BOUNDED_PAGE,
      children: [
        { path: ':id', element: <ContactWorkspace /> },
        { path: ':id/:tab', element: <ContactWorkspace /> },
      ],
    },
  ],
  contactTabs: [
    { key: 'billing', label: 'Billing', order: 10, Component: BillingTab },
    { key: 'activity', label: 'Activity', order: 90, Component: ActivityTab },
  ],
};
