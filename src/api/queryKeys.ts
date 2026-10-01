/** Query key factories. Every key starts with its domain so a whole domain can be invalidated. */
export const queryKeys = {
  contacts: {
    all: ['contacts'] as const,
    list: () => ['contacts', 'list'] as const,
    detail: (id: string) => ['contacts', 'detail', id] as const,
  },
  contactEmails: {
    forContact: (contactId: string) => ['contact-emails', contactId] as const,
  },
  contactNotes: {
    forContact: (contactId: string) => ['contact-notes', contactId] as const,
  },
  contactRelationships: {
    all: ['contact-relationships'] as const,
    forContact: (contactId: string) => ['contact-relationships', contactId] as const,
  },
  pickLists: {
    contactStatuses: () => ['pick-lists', 'contact-statuses'] as const,
    leadSources: () => ['pick-lists', 'lead-sources'] as const,
  },
};
