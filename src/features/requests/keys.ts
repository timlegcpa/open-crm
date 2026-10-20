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

/**
 * How the owner's request lists stay current: a client answering in the portal writes
 * nothing that reaches the owner's cache, so a visible list reads again every 30 seconds,
 * pauses in a hidden tab, and catches up at once when the owner comes back to it (the app's
 * default is never to refetch on focus). For reads only: never on a screen that edits, where
 * a refetch could replace what is being typed.
 */
export const LIST_REFRESH = {
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: 'always',
  refetchOnMount: 'always',
} as const;
