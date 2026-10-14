import { Mail } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const EmailPage = lazyNamed(() => import('./pages'), 'EmailPage');
const NewGroupEmailPage = lazyNamed(() => import('./pages'), 'NewGroupEmailPage');
const UnsubscribePage = lazyNamed(() => import('./public/UnsubscribePage'), 'UnsubscribePage');

export const manifest: FeatureManifest = {
  id: 'email',
  ownerNav: [{ label: 'Email', icon: Mail, path: '/email', order: 20, section: 'growth' }],
  ownerRoutes: [
    { path: 'email', element: <EmailPage /> },
    { path: 'email/new', element: <NewGroupEmailPage /> },
  ],
  publicRoutes: [{ path: 'unsubscribe', element: <UnsubscribePage /> }],
};
