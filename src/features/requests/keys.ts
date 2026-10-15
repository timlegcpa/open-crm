/** Query keys. Every key starts with 'requests', so the whole family can be dropped at once. */
export const requestKeys = {
  all: ['requests'] as const,
  lists: () => ['requests', 'lists'] as const,
  forContact: (contactId: string) => ['requests', 'lists', 'contact', contactId] as const,
  detail: (id: string) => ['requests', 'detail', id] as const,
  drafts: (contactId: string) => ['requests', 'drafts', contactId] as const,
  awaiting: (contactId?: string) => ['requests', 'awaiting', contactId ?? 'all'] as const,
  templates: () => ['requests', 'templates'] as const,
  reminders: () => ['requests', 'reminder-settings'] as const,
  /** The client's own: home card and request page. */
  mine: (contactId: string) => ['requests', 'mine', contactId] as const,
  myRequest: (id: string) => ['requests', 'mine', 'detail', id] as const,
};
