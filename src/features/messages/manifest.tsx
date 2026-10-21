import { MessageSquare } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import { BOUNDED_PAGE, type FeatureManifest } from '@/features/types';

// Owner screens, the portal page and the badges are separate chunks: a badge in the
// tab strip must not pull the conversation screens in with it, and the portal never loads
// the owner's code.
const MessagesPage = lazyNamed(() => import('./pages'), 'MessagesPage');
const ConversationPage = lazyNamed(() => import('./pages'), 'ConversationPage');
const MessagesTab = lazyNamed(() => import('./pages'), 'MessagesTab');
const EncryptionSettings = lazyNamed(() => import('./settings'), 'EncryptionSettings');
const OwnerUnreadBadge = lazyNamed(() => import('./badges'), 'OwnerUnreadBadge');
const OwnerUnreadCount = lazyNamed(() => import('./badges'), 'OwnerUnreadCount');
const ContactUnreadBadge = lazyNamed(() => import('./badges'), 'ContactUnreadBadge');
const PortalMessagesPage = lazyNamed(() => import('./portal'), 'PortalMessagesPage');
const PortalUnreadBadge = lazyNamed(() => import('./portal'), 'PortalUnreadBadge');

export const manifest: FeatureManifest = {
  id: 'messages',
  workspaceTabs: [{ key: 'messages', label: 'Messages', icon: MessageSquare, path: '/messages', order: 60, badge: OwnerUnreadBadge }],
  workspaceRoutes: [{ path: 'messages', element: <MessagesPage /> }],
  ownerRoutes: [{ path: 'messages/:contactId', element: <ConversationPage />, handle: BOUNDED_PAGE }],
  shellCounts: [{ key: 'unread', label: 'Unread', path: '/messages', order: 10, kind: 'waiting', Count: OwnerUnreadCount }],
  portalTabs: [{ label: 'Messages', icon: MessageSquare, path: '/portal/messages', order: 30, badge: PortalUnreadBadge }],
  portalRoutes: [{ path: 'messages', element: <PortalMessagesPage /> }],
  contactTabs: [{ key: 'messages', label: 'Messages', order: 40, Component: MessagesTab, badge: ContactUnreadBadge }],
  settingsSections: [{ key: 'messages', label: 'Secure messages', order: 50, Component: EncryptionSettings }],
};
