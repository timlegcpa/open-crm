import { Navigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

// The existing contact screens, loaded on first visit.
const ContactsList = lazyNamed(() => import('@/pages/contacts/ContactsList'), 'ContactsList');
const ContactIntake = lazyNamed(() => import('@/pages/contacts/ContactIntake'), 'ContactIntake');
const ContactWorkspace = lazyNamed(() => import('@/pages/contacts/ContactWorkspace'), 'ContactWorkspace');

export const manifest: FeatureManifest = {
  id: 'crm',
  ownerNav: [{ label: 'Contacts', icon: Users, path: '/contacts', order: 10 }],
  ownerRoutes: [
    // The owner's home is the contact list.
    { index: true, element: <Navigate to="/contacts" replace /> },
    { path: 'contacts', element: <ContactsList /> },
    { path: 'contacts/new', element: <ContactIntake /> },
    { path: 'contacts/:id', element: <ContactWorkspace /> },
    // A record tab (links.contactTab). Until the record grows a tab strip that renders the
    // registry's `contactTabs`, a tab URL opens the record itself.
    { path: 'contacts/:id/:tab', element: <ContactWorkspace /> },
  ],
};
