/** Query key factories. Every key starts with its domain so a whole domain can be invalidated. */
export const queryKeys = {
  contacts: {
    all: ['contacts'] as const,
    list: () => ['contacts', 'list'] as const,
    detail: (id: string) => ['contacts', 'detail', id] as const,
    // The pipeline cards' note line. Under the prefix, so a contact write refreshes it; the
    // notes card invalidates it too, since a note write is no contact write.
    leadNotes: () => ['contacts', 'leadNotes'] as const,
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
    all: ['pick-lists'] as const,
    /** One pick-list table; a screen that edits a list invalidates this key. */
    table: (table: string) => ['pick-lists', table] as const,
  },
};
