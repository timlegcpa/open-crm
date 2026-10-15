import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { invokeEdge } from '@/lib/edge';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';

/**
 * Group email: the send log the owner reads, and the two calls to crm-send-group-email.
 * The owner's session only ever READS these tables (0010_email.sql gives it SELECT and
 * nothing else); every write is the edge function's.
 */

export const emailKeys = {
  all: ['group-email'] as const,
  campaigns: () => ['group-email', 'campaigns'] as const,
  campaign: (id: string) => ['group-email', 'campaign', id] as const,
  recipients: (campaignId: string) => ['group-email', 'recipients', campaignId] as const,
  forContact: (contactId: string) => ['group-email', 'contact', contactId] as const,
};

/** Every state a recipient row can be in (the CHECK in 0010_email.sql). */
export const RECIPIENT_STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped', 'unknown'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

const campaignSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(['sending', 'sent', 'failed']),
  audience_description: z.string().nullable(),
  recipient_count: z.number(),
  sent_count: z.number(),
  failed_count: z.number(),
  unknown_count: z.number(),
  skipped_count: z.number(),
  created_at: z.string(),
  sent_at: z.string().nullable(),
});
export type Campaign = z.infer<typeof campaignSchema>;

const campaignDetailSchema = campaignSchema.extend({ body: z.string(), from_identity: z.string() });
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;

const recipientSchema = z.object({
  id: z.string(),
  campaign_id: z.string(),
  contact_id: z.string().nullable(),
  address: z.string(),
  status: z.enum(RECIPIENT_STATUSES),
  error: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});
export type Recipient = z.infer<typeof recipientSchema>;

const contactRecipientSchema = recipientSchema.extend({
  // Three columns, not the row: a campaign body is up to 50,000 characters, and this card
  // shows one subject line.
  campaign: z.object({ id: z.string(), subject: z.string(), sent_at: z.string().nullable() }).nullable(),
});
export type ContactRecipient = z.infer<typeof contactRecipientSchema>;

const CAMPAIGN_COLUMNS =
  'id, subject, status, audience_description, recipient_count, sent_count, failed_count, unknown_count, skipped_count, created_at, sent_at';
const RECIPIENT_COLUMNS = 'id, campaign_id, contact_id, address, status, error, sent_at, created_at';

/** Newest first; the id breaks a tie so the order never shuffles. */
const newestFirst = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

/** Keyset pages on id (never a silent 1,000-row cap), then sorted for display. */
async function readAll<T extends { id: string }>(
  table: string,
  columns: string,
  schema: z.ZodType<T>,
  filter?: { column: string; value: string },
): Promise<T[]> {
  const raw = await fetchAllPaged<{ id: string }>((afterId) => {
    let query = getSupabase().from(table).select(columns).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (filter) query = query.eq(filter.column, filter.value);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<{ id: string }[]>();
  });
  return z.array(schema).parse(raw);
}

export async function listCampaigns(): Promise<Campaign[]> {
  return (await readAll('crm_email_campaigns', CAMPAIGN_COLUMNS, campaignSchema)).sort(newestFirst);
}

export async function getCampaign(id: string): Promise<CampaignDetail | null> {
  const { data, error } = await getSupabase()
    .from('crm_email_campaigns')
    .select(`${CAMPAIGN_COLUMNS}, body, from_identity`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? campaignDetailSchema.parse(data) : null;
}

/** Recipients by address, so a long list reads like a roster. */
export async function listCampaignRecipients(campaignId: string): Promise<Recipient[]> {
  const rows = await readAll('crm_email_recipients', RECIPIENT_COLUMNS, recipientSchema, { column: 'campaign_id', value: campaignId });
  return rows.sort((a, b) => a.address.localeCompare(b.address) || a.id.localeCompare(b.id));
}

export async function listRecipientsForContact(contactId: string): Promise<ContactRecipient[]> {
  const rows = await readAll(
    'crm_email_recipients',
    `${RECIPIENT_COLUMNS}, campaign:crm_email_campaigns(id, subject, sent_at)`,
    contactRecipientSchema,
    { column: 'contact_id', value: contactId },
  );
  return rows.sort(newestFirst);
}

// ---------------------------------------------------------------------------
// crm-send-group-email
// ---------------------------------------------------------------------------

const delivery = z.enum(['provider', 'dev_outbox']);
export type Delivery = z.infer<typeof delivery>;

const sendResultSchema = z.object({
  campaign_id: z.string(),
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  unknown: z.number().optional(),
  unsent: z.number().optional(),
  still_running: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  delivery,
});
export type GroupEmailSendResult = z.infer<typeof sendResultSchema>;

const previewSchema = z.object({
  preview: z.literal(true),
  html: z.string(),
  sample: z.object({ first_name: z.string(), address: z.string() }),
  eligible: z.number(),
  skipped: z.number(),
  delivery,
});
export type GroupEmailPreview = z.infer<typeof previewSchema>;

export interface Composition {
  subject: string;
  body: string;
  contactIds: string[];
}

/**
 * Send. `idempotencyKey` is ONE per composition and resent unchanged on every retry, so a
 * double-click or a retry after a lost answer returns the first campaign, never a second
 * delivery.
 */
export function sendGroupEmail(c: Composition, idempotencyKey: string): Promise<GroupEmailSendResult> {
  return invokeEdge('crm-send-group-email', {
    subject: c.subject.trim(),
    body: c.body.trim(),
    contact_ids: c.contactIds,
    audience_description: `${c.contactIds.length} selected contacts`,
    idempotency_key: idempotencyKey,
  }, { parse: (d) => sendResultSchema.parse(d) });
}

/**
 * The draft rendered by the SERVER: the same function, renderer and recipient resolution
 * as the send, returning before it writes. Deliberately sent WITHOUT an idempotency key:
 * every version of the function refuses a send that lacks one, so this can never mail.
 */
export function previewGroupEmail(c: Composition): Promise<GroupEmailPreview> {
  return invokeEdge('crm-send-group-email', {
    mode: 'preview',
    subject: c.subject.trim(),
    body: c.body.trim(),
    contact_ids: c.contactIds,
  }, { parse: (d) => previewSchema.parse(d) });
}
