import { PenLine } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const EsignPage = lazyNamed(() => import('./pages'), 'EsignPage');
const NewEnvelopePage = lazyNamed(() => import('./pages'), 'NewEnvelopePage');
const EnvelopePage = lazyNamed(() => import('./pages'), 'EnvelopePage');
const PortalSignPage = lazyNamed(() => import('./pages'), 'PortalSignPage');
const EsignTab = lazyNamed(() => import('./pages'), 'EsignTab');
const SignPage = lazyNamed(() => import('./public/SignPage'), 'SignPage');
const VerifyPage = lazyNamed(() => import('./public/VerifyPage'), 'VerifyPage');

export const manifest: FeatureManifest = {
  id: 'esign',
  ownerNav: [{ label: 'E-sign', icon: PenLine, path: '/esign', order: 50, section: 'workflow' }],
  ownerRoutes: [
    { path: 'esign', element: <EsignPage /> },
    { path: 'esign/new', element: <NewEnvelopePage /> },
    { path: 'esign/:id', element: <EnvelopePage /> },
  ],
  portalRoutes: [{ path: 'sign', element: <PortalSignPage /> }],
  publicRoutes: [
    { path: 'sign/*', element: <SignPage /> },
    { path: 'esign/verify', element: <VerifyPage /> },
  ],
  contactTabs: [{ key: 'esign', label: 'E-sign', order: 50, Component: EsignTab }],
};
