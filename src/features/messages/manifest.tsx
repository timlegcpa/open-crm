import { MessageSquare } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const MessagesPage = lazyNamed(() => import('./pages'), 'MessagesPage');
const ConversationPage = lazyNamed(() => import('./pages'), 'ConversationPage');
const PortalMessagesPage = lazyNamed(() => import('./pages'), 'PortalMessagesPage');
const MessagesTab = lazyNamed(() => import('./pages'), 'MessagesTab');

export const manifest: FeatureManifest = {
  id: 'messages',
  ownerNav: [{ label: 'Messages', icon: MessageSquare, path: '/messages', order: 40, section: 'workflow' }],
  ownerRoutes: [
    { path: 'messages', element: <MessagesPage /> },
    { path: 'messages/:contactId', element: <ConversationPage /> },
  ],
  portalTabs: [{ label: 'Messages', icon: MessageSquare, path: '/portal/messages', order: 30 }],
  portalRoutes: [{ path: 'messages', element: <PortalMessagesPage /> }],
  contactTabs: [{ key: 'messages', label: 'Messages', order: 40, Component: MessagesTab }],
};
