/**
 * THE cross-feature URL contract. To send someone to ANOTHER feature's screen, build the URL
 * here, never by hand, so features can link to each other before the target screen exists
 * and a screen can move without breaking its callers. Each feature registers routes that
 * serve its own targets below (registry.test.ts resolves every one against the routes).
 *
 *   <Link to={links.contact(contactId)}>Open record</Link>
 *   navigate(links.newEnvelope({ contactId, documentId }))
 *
 * Inside your own feature, build your own URLs as you like. Ids are URL-encoded here.
 * Public paths (PUBLIC_PATHS) are also what edge functions put in emails: SITE_URL plus the
 * path, so a link sent today keeps working.
 */

const enc = encodeURIComponent;

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export const links = {
  // crm
  contacts: () => '/contacts',
  newContact: () => '/contacts/new',
  contact: (id: string) => `/contacts/${enc(id)}`,
  /** A tab of the record; `tab` is a ContactTab key ('documents', 'requests', ...). */
  contactTab: (id: string, tab: string) => `/contacts/${enc(id)}/${enc(tab)}`,

  // board
  board: () => '/board',
  boardItem: (id: string) => `/board/${enc(id)}`,

  // requests
  requests: () => '/requests',
  newRequest: (contactId: string) => withQuery('/requests/new', { contact: contactId }),
  request: (id: string) => `/requests/${enc(id)}`,

  // documents
  /** The document explorer, opened on one contact's files when given. */
  documents: (contactId?: string) => withQuery('/documents', { contact: contactId }),
  document: (id: string) => `/documents/${enc(id)}`,

  // messages
  messages: () => '/messages',
  conversation: (contactId: string) => `/messages/${enc(contactId)}`,
  /** The conversation with the composer focused. */
  newMessage: (contactId: string) => withQuery(`/messages/${enc(contactId)}`, { compose: '1' }),

  // e-sign
  esign: () => '/esign',
  newEnvelope: (opts: { contactId?: string; documentId?: string } = {}) =>
    withQuery('/esign/new', { contact: opts.contactId, document: opts.documentId }),
  envelope: (id: string) => `/esign/${enc(id)}`,

  // email
  email: () => '/email',
  /** Compose a group email to these contacts. */
  newGroupEmail: (contactIds: readonly string[]) => withQuery('/email/new', { to: contactIds.join(',') || undefined }),

  // marketing
  marketing: () => '/marketing',

  // ops
  auditLog: () => '/audit',
  jobs: () => '/jobs',

  // settings
  settings: () => '/settings',
  settingsSection: (key: string) => `/settings/${enc(key)}`,

  // the client portal (a client's session)
  portalHome: () => '/portal',
  portalDocuments: () => '/portal/documents',
  portalMessages: () => '/portal/messages',
  portalRequest: (id: string) => `/portal/requests/${enc(id)}`,
  portalSign: () => '/portal/sign',
  portalProfile: () => '/portal/profile',

  // public (no session)
  forgotPassword: () => '/forgot-password',
} as const;

/**
 * The public routes, by first segment: what each feature registers in `publicRoutes` and
 * what an edge function appends to SITE_URL in an email. The capability (a signing token,
 * an invitation token) goes in the rest of the path or the query, chosen by the owning
 * feature.
 */
export const PUBLIC_PATHS = {
  /** e-sign: a signer's link, /sign/<token> */
  sign: '/sign',
  /** e-sign: check a signed document's certificate */
  esignVerify: '/esign/verify',
  /** email: one-click unsubscribe */
  unsubscribe: '/unsubscribe',
  /** requests: a start link for a contact without a portal account, /start/<token> */
  start: '/start',
  /** portal: accept a portal invitation, /invite/<token> */
  invite: '/invite',
  /** settings: ask for a password-reset email */
  forgotPassword: '/forgot-password',
  /** settings: where the reset email lands to choose a new password */
  resetPassword: '/reset-password',
} as const;
