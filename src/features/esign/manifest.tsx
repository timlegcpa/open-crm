import { PenLine } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { links } from '@/features/links';
import type { FeatureManifest } from '@/features/types';

const EsignPage = lazyNamed(() => import('./pages'), 'EsignPage');
const NewEnvelopePage = lazyNamed(() => import('./pages'), 'NewEnvelopePage');
const EnvelopePage = lazyNamed(() => import('./pages'), 'EnvelopePage');
const EsignTab = lazyNamed(() => import('./pages'), 'EsignTab');
const PortalSignPage = lazyNamed(() => import('./portal'), 'PortalSignPage');
const SignatureNeededCard = lazyNamed(() => import('./portal'), 'SignatureNeededCard');
const EsignContactBadge = lazyNamed(() => import('./badges'), 'EsignContactBadge');
const EsignHeaderAction = lazyNamed(() => import('./badges'), 'EsignHeaderAction');
const EsignSettings = lazyNamed(() => import('./settings'), 'EsignSettings');
const SignPage = lazyNamed(() => import('./public/SignPage'), 'SignPage');
const VerifyPage = lazyNamed(() => import('./public/VerifyPage'), 'VerifyPage');

export const manifest: FeatureManifest = {
  id: 'esign',
  ownerNav: [{ label: 'E-sign', icon: PenLine, path: '/esign', order: 50, section: 'workflow' }],
  workspaceTabs: [{ key: 'esign', label: 'E-sign', icon: PenLine, path: '/esign', order: 70 }],
  workspaceRoutes: [{ path: 'esign', element: <EsignPage /> }],
  // The composer and an envelope are editors with their own chrome, outside the workspace.
  ownerRoutes: [
    { path: 'esign/new', element: <NewEnvelopePage /> },
    { path: 'esign/:id', element: <EnvelopePage /> },
  ],
  newMenu: [{ key: 'envelope', label: 'E-sign envelope', icon: PenLine, order: 40, path: links.newEnvelope() }],
  portalRoutes: [{ path: 'sign', element: <PortalSignPage /> }],
  portalHomeCards: [{ key: 'esign', order: 15, Component: SignatureNeededCard }],
  publicRoutes: [
    { path: 'sign/*', element: <SignPage /> },
    { path: 'esign/verify', element: <VerifyPage /> },
  ],
  contactTabs: [{ key: 'esign', label: 'E-sign', order: 50, Component: EsignTab, badge: EsignContactBadge }],
  contactHeaderActions: [{ key: 'esign', order: 50, Component: EsignHeaderAction }],
  settingsSections: [{ key: 'esign', label: 'E-sign', order: 60, Component: EsignSettings }],
};
