import { ID } from './ids';
import type { Row } from './postgrest';

/** The pick lists 0002_contacts.sql seeds, as the owner reads them. */
export const pickLists: Record<string, Row[]> = {
  contact_statuses: [
    ['new_lead', 'New', '#2563eb', 10],
    ['active_lead', 'Active', '#7c3aed', 20],
    ['hot', 'Hot', '#dc2626', 30],
    ['warm', 'Warm', '#d97706', 40],
    ['cold', 'Cold', '#0891b2', 50],
    ['client', 'Client', '#16a34a', 60],
    ['one_time', 'One-time client', '#0d9488', 70],
    ['former_client', 'Former client', '#78716c', 80],
    ['lost', 'Lost', '#71717a', 90],
    ['esign_signer', 'Signer only', '#a1a1aa', 100],
  ].map(([key, label, colour, sort_order]) => ({ key, label, colour, sort_order })),
  lead_sources: [
    ['referral', 'Referral', 10, false],
    ['website', 'Website', 20, false],
    ['search', 'Search', 30, false],
    ['social_media', 'Social media', 40, false],
    ['advertising', 'Advertising', 50, false],
    ['event', 'Event', 60, false],
    ['lead_intake', 'Lead intake API', 80, true],
    ['esign', 'E-signature', 90, true],
    ['other', 'Other', 100, true],
  ].map(([key, label, sort_order, is_system]) => ({ key, label, colour: null, sort_order, is_active: true, is_system })),
  organization_types: [
    ['sole_proprietorship', 'Sole proprietorship', 10, false],
    ['llc', 'LLC', 20, false],
    ['partnership', 'Partnership', 30, false],
    ['corporation', 'Corporation', 40, false],
    ['nonprofit', 'Nonprofit', 50, false],
    ['other', 'Other', 100, true],
  ].map(([key, label, sort_order, is_system]) => ({ key, label, colour: null, sort_order, is_active: true, is_system })),
  service_types: [
    ['retainer', 'Monthly retainer', 10, false, 'recurring', 'monthly'],
    ['annual_plan', 'Annual plan', 20, false, 'recurring', 'annual'],
    ['project', 'Project', 30, false, 'one_time', 'one_time'],
    ['consultation', 'Consultation', 40, false, 'one_time', 'one_time'],
    ['other', 'Other', 100, true, 'one_time', 'one_time'],
  ].map(([key, label, sort_order, is_system, revenue_family, default_cadence]) => ({
    key, label, colour: null, sort_order, is_active: true, is_system, revenue_family, default_cadence,
  })),
};

function contact(fields: Row): Row {
  return {
    created_at: '2026-03-02T15:00:00Z',
    updated_at: '2026-09-20T15:00:00Z',
    submitted_at: null,
    phone: null,
    business_name: null,
    spouse_first_name: null,
    spouse_last_name: null,
    spouse_name: null,
    spouse_email: null,
    spouse_phone: null,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    source: 'referral',
    client_since: null,
    tier: null,
    archived_at: null,
    status_history: [],
    portal_sidebar_config: {},
    contact_services: [],
    ...fields,
    full_name: `${fields.first_name} ${fields.last_name}`,
  };
}

export const contacts: Row[] = [
  contact({
    id: ID.ada,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.test',
    phone: '(555) 010-0101',
    business_name: 'Acme LLC',
    mailing_street: '1 Analytical Way',
    mailing_city: 'Springfield',
    mailing_state: 'IL',
    mailing_zip: '62701',
    status: 'client',
    client_since: '2026-04-01',
    tier: 'S',
    contact_services: [
      {
        id: '00000000-0000-4000-8000-000000000301',
        contact_id: ID.ada,
        organization_id: ID.acme,
        service_type: 'retainer',
        state: 'accepted',
        cadence: 'monthly',
        amount: 1200,
        created_at: '2026-04-01T15:00:00Z',
        updated_at: '2026-04-01T15:00:00Z',
      },
    ],
  }),
  contact({
    id: ID.grace,
    first_name: 'Grace',
    last_name: 'Hopper',
    email: 'grace@example.test',
    phone: '(555) 010-0102',
    status: 'hot',
    source: 'website',
    submitted_at: '2026-10-01T14:00:00Z',
  }),
];

export const organizations: Row[] = [
  { id: ID.acme, contact_id: ID.ada, name: 'Acme LLC', organization_type: 'llc', status: 'active', created_at: '2026-04-01T15:00:00Z' },
];

export const contactEmails: Row[] = [
  { id: '00000000-0000-4000-8000-000000000111', contact_id: ID.ada, kind: 'primary', email: 'ada@example.test', label: 'business', is_default: true, created_at: '2026-03-02T15:00:00Z' },
  { id: '00000000-0000-4000-8000-000000000112', contact_id: ID.grace, kind: 'primary', email: 'grace@example.test', label: 'personal', is_default: true, created_at: '2026-10-01T14:00:00Z' },
];

export const portalAccounts: Row[] = [
  {
    id: '00000000-0000-4000-8000-000000000121',
    user_id: ID.clientUser,
    contact_id: ID.ada,
    role: 'primary',
    status: 'active',
    invited_email: 'ada@example.test',
    invited_at: '2026-04-01T15:00:00Z',
    activated_at: '2026-04-02T15:00:00Z',
    last_login_at: '2026-10-10T15:00:00Z',
    login_count: 7,
  },
];

export const contactNotes: Row[] = [
  { id: '00000000-0000-4000-8000-000000000131', contact_id: ID.ada, body: 'Kickoff call went well. Wants a monthly check-in.', kind: 'call', source: 'owner', created_at: '2026-04-01T16:00:00Z' },
];
