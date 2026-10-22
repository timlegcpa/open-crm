import { z } from 'zod';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { invokeEdge } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';
import { readSidebarConfig, type PortalAccount, type PortalSidebarConfig } from './lib/portalAccess';

/**
 * The portal feature's reads and writes, for both audiences: the client's own contact and
 * tasks (RLS scopes them to the signed-in client), and the owner's view of one contact's
 * portal access. Every answer is checked with Zod before the screens see it.
 */

export const portalKeys = {
  all: ['portal'] as const,
  myContact: () => ['portal', 'my-contact'] as const,
  myTasks: (contactId: string) => ['portal', 'my-tasks', contactId] as const,
  /** The owner's view of one contact: accounts, addresses, switches. */
  access: (contactId: string) => ['portal', 'access', contactId] as const,
};

// ---------------------------------------------------------------------------
// The client's side
// ---------------------------------------------------------------------------

const myContactSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  full_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  business_name: z.string().nullable(),
  spouse_first_name: z.string().nullable(),
  spouse_last_name: z.string().nullable(),
  spouse_name: z.string().nullable(),
  spouse_email: z.string().nullable(),
  client_since: z.string().nullable(),
  portal_sidebar_config: z.unknown(),
});

export type MyContact = Omit<z.infer<typeof myContactSchema>, 'portal_sidebar_config'> & {
  portal_sidebar_config: PortalSidebarConfig;
};

/** The signed-in client's own contact, or null when the database names none. */
export async function getMyContact(): Promise<MyContact | null> {
  const { data, error } = await getSupabase().rpc('get_my_contact');
  if (error) throw error;
  // A set-returning function answers with an array; take its one row.
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (row === undefined || row === null) return null;
  const parsed = myContactSchema.parse(row);
  return { ...parsed, portal_sidebar_config: readSidebarConfig(parsed.portal_sidebar_config) };
}

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  link: z.string().nullable(),
  created_at: z.string(),
});

export type PortalTask = z.infer<typeof taskSchema>;

/** Newest first; the id breaks a tie so the order never shuffles between reads. */
export function byNewestThenId(a: PortalTask, b: PortalTask): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The client's pending tasks: read page by page on id, then shown newest first. */
export async function listMyPendingTasks(contactId: string): Promise<PortalTask[]> {
  const rows = await fetchAllPaged<PortalTask>(async (afterId) => {
    let query = getSupabase()
      .from('client_tasks')
      .select('id,title,description,type,link,created_at')
      .eq('contact_id', contactId)
      .eq('status', 'pending');
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    return { data: data ? z.array(taskSchema).parse(data) : null, error };
  });
  return rows.sort(byNewestThenId);
}

/** Mark a pending task done or dismiss it. The database allows only that move. */
export async function settleTask(taskId: string, status: 'completed' | 'dismissed'): Promise<void> {
  const { error } = await getSupabase().from('client_tasks').update({ status }).eq('id', taskId).eq('status', 'pending');
  if (error) throw error;
}

/**
 * Live updates for the client's Home: a task added, finished or removed refreshes the list.
 * Returns the unsubscribe. Realtime is a nicety: when it cannot start, the page still works
 * by refetching on focus.
 */
export function subscribeToMyTasks(contactId: string, onChange: () => void): () => void {
  const supabase = getSupabase() as unknown as {
    channel?: (name: string) => {
      on: (type: string, filter: Record<string, string>, cb: () => void) => { subscribe: () => unknown };
    };
    removeChannel?: (channel: unknown) => unknown;
  };
  if (typeof supabase.channel !== 'function') return () => {};
  try {
    const channel = supabase
      .channel(`portal-home-${contactId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'client_tasks', filter: `contact_id=eq.${contactId}` }, onChange)
      .subscribe();
    return () => {
      try {
        supabase.removeChannel?.(channel);
      } catch {
        // Already gone.
      }
    };
  } catch {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// The owner's side
// ---------------------------------------------------------------------------

const accountSchema = z.object({
  id: z.string(),
  user_id: z.string().nullable(),
  contact_id: z.string(),
  role: z.string(),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated']),
  invited_email: z.string().nullable(),
  invited_at: z.string().nullable(),
  activated_at: z.string().nullable(),
  last_login_at: z.string().nullable(),
  login_count: z.number(),
});

const emailSchema = z.object({ id: z.string(), kind: z.enum(['primary', 'spouse']), email: z.string(), is_default: z.boolean() });

export interface ContactEmailRow {
  id: string;
  kind: 'primary' | 'spouse';
  email: string;
  is_default: boolean;
}

export interface PortalAccessView {
  accounts: PortalAccount[];
  emails: ContactEmailRow[];
  config: PortalSidebarConfig;
}

/** One contact's portal accounts, its addresses and the two switches, read under the owner's RLS. */
export async function getPortalAccess(contactId: string): Promise<PortalAccessView> {
  const supabase = getSupabase();
  const [accounts, emails, contact] = await Promise.all([
    supabase
      .from('client_portal_accounts')
      .select('id,user_id,contact_id,role,status,invited_email,invited_at,activated_at,last_login_at,login_count')
      .eq('contact_id', contactId)
      .order('invited_at', { ascending: true })
      .order('id', { ascending: true }),
    supabase.from('contact_emails').select('id,kind,email,is_default').eq('contact_id', contactId).order('kind').order('id'),
    supabase.from('contacts').select('portal_sidebar_config').eq('id', contactId).maybeSingle(),
  ]);
  if (accounts.error) throw accounts.error;
  if (emails.error) throw emails.error;
  if (contact.error) throw contact.error;
  return {
    accounts: z.array(accountSchema).parse(accounts.data ?? []),
    emails: z.array(emailSchema).parse(emails.data ?? []),
    config: readSidebarConfig((contact.data as { portal_sidebar_config?: unknown } | null)?.portal_sidebar_config),
  };
}

/**
 * Turn one switch. The stored object is read and merged, so keys this screen does not know
 * survive; the panel runs one switch write at a time, so two quick clicks never race.
 */
export async function setPortalSidebarFlag(contactId: string, key: keyof PortalSidebarConfig, value: boolean): Promise<void> {
  const supabase = getSupabase();
  const current = await supabase.from('contacts').select('portal_sidebar_config').eq('id', contactId).maybeSingle();
  if (current.error) throw current.error;
  const stored = (current.data as { portal_sidebar_config?: unknown } | null)?.portal_sidebar_config;
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const { error } = await supabase.from('contacts').update({ portal_sidebar_config: { ...base, [key]: value } }).eq('id', contactId);
  if (error) throw error;
}

const inviteAnswer = z.object({
  success: z.literal(true),
  inviteUrl: z.string(),
  emailSent: z.boolean(),
  delivery: z.string(),
});

export type InviteAnswer = z.infer<typeof inviteAnswer>;

/** Invite one of the contact's addresses (a contact_emails row). */
export function sendInvite(contactId: string, email: string): Promise<InviteAnswer> {
  return invokeEdge('invite-client-portal', { contact_id: contactId, email }, { parse: (v) => inviteAnswer.parse(v) });
}

/** Send a fresh link to one invited or deactivated account (Resend and Re-invite). */
export function resendInvite(accountId: string): Promise<InviteAnswer> {
  return invokeEdge('resend-portal-invite', { account_id: accountId }, { parse: (v) => inviteAnswer.parse(v) });
}

/** Deactivate one account: its sign-in is blocked and its pending link revoked. */
export async function revokeAccess(accountId: string): Promise<void> {
  await invokeEdge('revoke-portal-access', { account_id: accountId }, { parse: (v) => z.object({ success: z.literal(true) }).parse(v) });
}

const changeEmailAnswer = z.object({
  success: z.literal(true),
  contact_address: z.enum(['email', 'spouse_email', 'email_list']).nullable(),
});

export type ChangeSignInAnswer = z.infer<typeof changeEmailAnswer>;

/**
 * Move one account's sign-in to a new address, and the contact's matching address with it.
 * `expected` is the address this screen showed: a change made meanwhile is refused.
 */
export function changeSignInEmail(accountId: string, email: string, expected: string): Promise<ChangeSignInAnswer> {
  return invokeEdge(
    'change-portal-email',
    { account_id: accountId, email, expected_email: expected },
    { parse: (v) => changeEmailAnswer.parse(v) },
  );
}

/** The accounts that sign in (a user, not deactivated): only these have an address to move. */
export function signInAccounts(accounts: PortalAccount[]): PortalAccount[] {
  return accounts.filter((a) => a.user_id !== null && a.status !== 'deactivated' && a.invited_email);
}
