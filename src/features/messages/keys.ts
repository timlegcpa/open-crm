/**
 * Query keys for secure messages. Owner keys start with 'messages', portal keys with
 * 'portal-messages', so either side can be invalidated whole. Portal keys carry no contact
 * id: the signed-in gate clears the whole cache whenever the account changes.
 */
export const messagesKeys = {
  all: ['messages'] as const,
  conversations: () => ['messages', 'conversations'] as const,
  conversation: (contactId: string) => ['messages', 'conversation', contactId] as const,
  contact: (contactId: string) => ['messages', 'contact', contactId] as const,
  unread: () => ['messages', 'unread'] as const,
  unreadFor: (contactId: string) => ['messages', 'unread', contactId] as const,
  ownerKey: () => ['messages', 'owner-key'] as const,
};

export const portalMessagesKeys = {
  all: ['portal-messages'] as const,
  list: () => ['portal-messages', 'list'] as const,
  unread: () => ['portal-messages', 'unread'] as const,
  publicKey: () => ['portal-messages', 'public-key'] as const,
  viewAsClient: () => ['portal-messages', 'view-as-client'] as const,
  orgName: () => ['portal-messages', 'org-name'] as const,
};
