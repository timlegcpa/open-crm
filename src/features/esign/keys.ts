/** Query keys of the e-signature feature. Every key starts with 'esign', so one call drops them all. */
export const esignKeys = {
  all: ['esign'] as const,
  envelopes: ['esign', 'envelopes'] as const,
  envelopeList: (status: string) => ['esign', 'envelopes', 'list', status] as const,
  forContact: (contactId: string) => ['esign', 'envelopes', 'contact', contactId] as const,
  pendingCount: (contactId: string) => ['esign', 'envelopes', 'pending-count', contactId] as const,
  envelope: (id: string) => ['esign', 'envelopes', 'one', id] as const,
  documents: (id: string) => ['esign', 'envelopes', 'one', id, 'documents'] as const,
  pages: (id: string) => ['esign', 'envelopes', 'one', id, 'pages'] as const,
  signers: (id: string) => ['esign', 'envelopes', 'one', id, 'signers'] as const,
  fields: (id: string) => ['esign', 'envelopes', 'one', id, 'fields'] as const,
  events: (id: string) => ['esign', 'envelopes', 'one', id, 'events'] as const,
  workingUrls: (id: string, paths: string) => ['esign', 'envelopes', 'one', id, 'working-urls', paths] as const,
  templates: ['esign', 'templates'] as const,
  settings: ['esign', 'settings'] as const,
  myTasks: (contactId: string) => ['esign', 'my-tasks', contactId] as const,
};
