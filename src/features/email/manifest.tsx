import { Mail } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const EmailPage = lazyNamed(() => import('./pages'), 'EmailPage');
const NewGroupEmailPage = lazyNamed(() => import('./pages'), 'NewGroupEmailPage');
const CampaignPage = lazyNamed(() => import('./pages'), 'CampaignPage');
const UnsubscribePage = lazyNamed(() => import('./public/UnsubscribePage'), 'UnsubscribePage');
const GroupEmailHistory = lazyNamed(() => import('./GroupEmailHistory'), 'GroupEmailHistory');

export const manifest: FeatureManifest = {
  id: 'email',
  ownerNav: [{ label: 'Email', icon: Mail, path: '/email', order: 20, section: 'growth' }],
  ownerRoutes: [
    { path: 'email', element: <EmailPage /> },
    { path: 'email/new', element: <NewGroupEmailPage /> },
    { path: 'email/:id', element: <CampaignPage /> },
  ],
  publicRoutes: [{ path: 'unsubscribe', element: <UnsubscribePage /> }],
  contactActivityCards: [{ key: 'group-email', order: 10, Component: GroupEmailHistory }],
};
