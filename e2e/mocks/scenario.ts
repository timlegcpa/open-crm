import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boardRpc, boardTables } from './board';
import { contactEmails, contactNotes, contacts, organizations, pickLists, portalAccounts } from './crm';
import { documentFunctions, documentRpc, documentTables } from './documents';
import { esignFunctions, esignTables } from './esign';
import { ID } from './ids';
import { requestFunctions, requestRpc, requestTables } from './requests';
import type { Row } from './postgrest';
import type { CallContext, MockUser, Scenario } from './supabase';

export { ID };

/**
 * The base scenario: one owner (with an authenticator), one client with a portal account, and
 * the identity RPCs every signed-in screen asks first. Each spec adds the tables its surface
 * reads. Everything is fictional: example.test addresses, 555-01xx numbers.
 */

export const OWNER: MockUser = {
  id: ID.owner,
  email: 'owner@example.test',
  password: 'correct horse battery staple',
  principal: 'owner',
  totpFactorId: ID.factor,
};

export const CLIENT: MockUser = {
  id: ID.clientUser,
  email: 'ada@example.test',
  password: 'client password 0123',
  principal: 'client',
};

export const ORG_NAME = 'Example Studio';

let pdf: Buffer | null = null;

/** A one-page PDF, made once per worker. */
export async function samplePdf(): Promise<Buffer> {
  if (pdf) return pdf;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = doc.addPage([612, 792]);
  sheet.drawText('Service agreement', { x: 72, y: 700, size: 24, font: bold });
  sheet.drawText('Between Example Studio LLC and Acme LLC', { x: 72, y: 672, size: 12, font });
  const body = [
    '1. Scope. Example Studio will deliver the work described in the attached schedule.',
    '2. Fees. Acme LLC pays the monthly retainer on the first business day of each month.',
    '3. Term. This agreement runs for twelve months and renews unless either side ends it.',
    '4. Confidentiality. Each side keeps what it learns about the other private.',
    '5. Notices. Notices go to the addresses on file, by email or by post.',
  ];
  body.forEach((line, i) => sheet.drawText(line, { x: 72, y: 620 - i * 24, size: 11, font }));
  sheet.drawLine({ start: { x: 72, y: 440 }, end: { x: 300, y: 440 }, thickness: 1 });
  sheet.drawText('Signature', { x: 72, y: 424, size: 10, font });
  sheet.drawLine({ start: { x: 340, y: 440 }, end: { x: 520, y: 440 }, thickness: 1 });
  sheet.drawText('Date', { x: 340, y: 424, size: 10, font });
  pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
  return pdf;
}

export async function baseScenario(): Promise<Scenario> {
  return {
    users: [{ ...OWNER }, { ...CLIENT }],
    tables: structuredClone({
      ...pickLists,
      contacts,
      contact_services: contacts.flatMap((c) => c.contact_services as Row[]),
      organizations,
      contact_emails: contactEmails,
      contact_notes: contactNotes,
      client_portal_accounts: portalAccounts,
      ...requestTables,
      ...documentTables,
      ...esignTables,
      ...boardTables,
      client_tasks: [
        {
          id: '00000000-0000-4000-8000-000000000901',
          contact_id: ID.ada,
          title: 'Sign: Service agreement',
          description: null,
          type: 'esign',
          status: 'pending',
          link: '/portal/sign?signer=00000000-0000-4000-8000-000000000611',
          created_at: '2026-10-06T15:00:00Z',
        },
      ],
      org_profile: [
        {
          id: true,
          display_name: ORG_NAME,
          legal_name: 'Example Studio LLC',
          sender_name: ORG_NAME,
          postal_address: '100 Example Street, Springfield, IL 62701',
          contact_email: 'hello@example.test',
          logo_path: null,
          brand: {},
        },
      ],
    }),
    rpc: {
      get_org_branding: { display_name: ORG_NAME, logo_path: null, legal_name: 'Example Studio LLC', contact_email: 'hello@example.test' },
      is_owner: (_args: Record<string, unknown>, ctx: CallContext) => ctx.principal === 'owner',
      get_client_contact_id: (_args: Record<string, unknown>, ctx: CallContext) => (ctx.principal === 'client' ? ID.ada : null),
      is_view_as_client: false,
      mcp_list_grants: [],
      /** The signed-in client's own contact row (a set-returning function: an array). */
      get_my_contact: (_args: Record<string, unknown>, ctx: CallContext) => {
        if (ctx.principal !== 'client') return [];
        const ada = ctx.table('contacts').find((c) => c.id === ID.ada)!;
        const pick = ['id', 'first_name', 'last_name', 'full_name', 'email', 'phone', 'business_name', 'spouse_first_name', 'spouse_last_name', 'spouse_name', 'spouse_email', 'client_since', 'portal_sidebar_config'];
        return [Object.fromEntries(pick.map((k) => [k, ada[k]]))];
      },
      ...requestRpc,
      ...documentRpc,
      ...boardRpc,
    },
    functions: {
      'log-portal-event': () => ({ json: { ok: true } }),
      ...requestFunctions,
      ...documentFunctions(await samplePdf()),
      ...esignFunctions,
    },
    files: {},
    defaultFile: await samplePdf(),
    defaults: {
      client_messages: { body: null, is_encrypted: false, encrypted_body: null, encrypted_key: null, encryption_iv: null, key_id: null, read_at: null },
    },
  };
}
