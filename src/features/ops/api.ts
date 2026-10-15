import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { invokeEdge } from '@/lib/edge';
import { parseDateOnly } from '@/lib/format';
import { contactDisplayName } from '@/api/contacts';

/**
 * The System pages' reads and writes: the job queue, the dev outbox and the audit log.
 * Every list is read a page at a time, newest first, with the id as the tiebreaker so a
 * page boundary never skips or repeats a row that shares a timestamp. Rows are checked
 * with Zod at this boundary.
 */

export const opsKeys = {
  all: ['ops'] as const,
  jobs: (status: JobStatusFilter, page: number) => ['ops', 'jobs', status, page] as const,
  jobCounts: () => ['ops', 'job-counts'] as const,
  jobHealth: () => ['ops', 'job-health'] as const,
  outbox: (page: number) => ['ops', 'outbox', page] as const,
  audit: (filters: AuditFilters, page: number) => ['ops', 'audit', filters, page] as const,
  activity: (filters: AuditFilters, page: number) => ['ops', 'activity', filters, page] as const,
  people: (ids: readonly string[]) => ['ops', 'people', [...ids].sort()] as const,
};

export const PAGE_ROWS = 50;

export interface Page<T> {
  rows: T[];
  hasMore: boolean;
}

/** One page: asks for one row more than it shows, to know whether another page follows. */
function toPage<T>(rows: T[]): Page<T> {
  return { rows: rows.slice(0, PAGE_ROWS), hasMore: rows.length > PAGE_ROWS };
}

const range = (page: number) => [page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS] as const;

const json = z.record(z.string(), z.unknown());

// ── Jobs ────────────────────────────────────────────────────────

export const JOB_STATUSES = ['pending', 'running', 'success', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobStatusFilter = JobStatus | 'all';

/**
 * The columns the Jobs page reads. Never claim_token: it is the runner's lease secret,
 * and a page has no use for it.
 */
export const JOB_COLUMNS =
  'id, provider, action, payload, status, attempts, max_attempts, scheduled_at, started_at, finished_at, ' +
  'claimed_until, last_error, result, created_at, updated_at';

const jobSchema = z.object({
  id: z.string(),
  provider: z.string(),
  action: z.string(),
  payload: json.nullable(),
  status: z.enum(JOB_STATUSES),
  attempts: z.number(),
  max_attempts: z.number(),
  scheduled_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  claimed_until: z.string().nullable(),
  last_error: z.string().nullable(),
  result: z.unknown().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type JobRow = z.infer<typeof jobSchema>;

export async function listJobs(status: JobStatusFilter, page: number): Promise<Page<JobRow>> {
  let query = getSupabase()
    .from('jobs')
    .select(JOB_COLUMNS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query.range(...range(page));
  if (error) throw error;
  return toPage(z.array(jobSchema).parse(data ?? []));
}

const countsSchema = z.object({
  pending: z.number(),
  running: z.number(),
  success: z.number(),
  failed: z.number(),
  dead: z.number(),
  all: z.number(),
});
export type JobCounts = z.infer<typeof countsSchema>;

export async function getJobStatusCounts(): Promise<JobCounts> {
  const { data, error } = await getSupabase().rpc('get_job_status_counts');
  if (error) throw error;
  return countsSchema.parse(data);
}

/** A pending job this far past its time means nothing is running the queue. */
export const OVERDUE_MINUTES = 5;

export interface JobHealth {
  /** When any job last finished; null when none ever has. */
  lastFinishedAt: string | null;
  /** Pending jobs more than OVERDUE_MINUTES past their time. */
  overdue: number;
}

export async function getJobHealth(now: Date = new Date()): Promise<JobHealth> {
  const supabase = getSupabase();
  const cutoff = new Date(now.getTime() - OVERDUE_MINUTES * 60_000).toISOString();
  const [last, overdue] = await Promise.all([
    supabase.from('jobs').select('finished_at').not('finished_at', 'is', null)
      .order('finished_at', { ascending: false }).limit(1),
    supabase.from('jobs').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').lt('scheduled_at', cutoff),
  ]);
  if (last.error) throw last.error;
  if (overdue.error) throw overdue.error;
  const lastRow = z.array(z.object({ finished_at: z.string() })).parse(last.data ?? [])[0];
  return { lastFinishedAt: lastRow?.finished_at ?? null, overdue: overdue.count ?? 0 };
}

/** Puts a failed or dead job back in the queue; the database refuses anyone but the owner. */
export async function retryJob(jobId: string): Promise<void> {
  const { error } = await getSupabase().rpc('retry_job', { p_job_id: jobId });
  if (error) throw error;
}

const tickSchema = z.object({ claimed: z.number(), succeeded: z.number(), failed: z.number(), superseded: z.number() });
export type TickSummary = z.infer<typeof tickSchema>;

/** Runs one tick of the queue now, as the owner. */
export function runQueueNow(): Promise<TickSummary> {
  return invokeEdge('job-runner', undefined, { parse: (d) => tickSchema.parse(d) });
}

// ── Dev outbox ──────────────────────────────────────────────────

const outboxSchema = z.object({
  id: z.string(),
  channel: z.enum(['email', 'sms']),
  recipient: z.string(),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  body_text: z.string().nullable(),
  body_html: z.string().nullable(),
  created_at: z.string(),
});
export type OutboxRow = z.infer<typeof outboxSchema>;

export async function listOutbox(page: number): Promise<Page<OutboxRow>> {
  const { data, error } = await getSupabase()
    .from('dev_outbox')
    .select('id, channel, recipient, sender, subject, body_text, body_html, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(...range(page));
  if (error) throw error;
  return toPage(z.array(outboxSchema).parse(data ?? []));
}

/** Deletes every message in the outbox. Resolves to how many went. */
export async function clearOutbox(): Promise<number> {
  const { error, count } = await getSupabase().from('dev_outbox').delete({ count: 'exact' }).not('id', 'is', null);
  if (error) throw error;
  return count ?? 0;
}

// ── Audit log ───────────────────────────────────────────────────

export interface AuditFilters {
  /** A local calendar day, 'YYYY-MM-DD', or '' for no bound. */
  from: string;
  to: string;
  /** An action key, or '' for every action. */
  action: string;
}

export const NO_AUDIT_FILTERS: AuditFilters = { from: '', to: '', action: '' };

const details = json.catch({});

const auditSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  action: z.string(),
  details,
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.string(),
});
export type AuditRow = z.infer<typeof auditSchema>;

const activitySchema = z.object({
  id: z.string(),
  contact_id: z.string(),
  user_id: z.string().nullable(),
  action: z.string(),
  details,
  ip_address: z.string().nullable(),
  created_at: z.string(),
});
export type ActivityRow = z.infer<typeof activitySchema>;

/** The instant a local calendar day starts, as ISO; null for no day. */
function dayStart(day: string, offsetDays = 0): string | null {
  const d = parseDateOnly(day);
  if (!d) return null;
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

interface Filterable<Q> {
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
  eq(column: string, value: string): Q;
}

/** From the start of `from` up to the end of `to`, both local days, and one action. */
function applyFilters<Q extends Filterable<Q>>(query: Q, filters: AuditFilters): Q {
  let q = query;
  const from = dayStart(filters.from);
  const to = dayStart(filters.to, 1);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lt('created_at', to);
  if (filters.action) q = q.eq('action', filters.action);
  return q;
}

/** What the owner and the server did: sign-ins, security changes, deletions. */
export async function listAuditLog(filters: AuditFilters, page: number): Promise<Page<AuditRow>> {
  const query = getSupabase()
    .from('audit_logs')
    .select('id, user_id, action, details, ip_address, user_agent, created_at');
  const { data, error } = await applyFilters(query, filters)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(...range(page));
  if (error) throw error;
  return toPage(z.array(auditSchema).parse(data ?? []));
}

/** What happened in the portal, per contact. */
export async function listPortalActivity(filters: AuditFilters, page: number): Promise<Page<ActivityRow>> {
  const query = getSupabase()
    .from('client_activity_log')
    .select('id, contact_id, user_id, action, details, ip_address, created_at');
  const { data, error } = await applyFilters(query, filters)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(...range(page));
  if (error) throw error;
  return toPage(z.array(activitySchema).parse(data ?? []));
}

export interface People {
  /** Contact names by id: always from the contacts table, never from a row's details. */
  contacts: Map<string, string>;
  ownerUserId: string | null;
  systemUserId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The contact ids a page of rows names: the activity column, or details.contact_id. */
export function contactIdsOf(rows: ReadonlyArray<{ contact_id?: string; details: Record<string, unknown> }>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.contact_id) ids.add(row.contact_id);
    const fromDetails = row.details.contact_id;
    if (typeof fromDetails === 'string' && UUID.test(fromDetails)) ids.add(fromDetails);
  }
  return [...ids].sort();
}

export async function getPeople(contactIds: readonly string[]): Promise<People> {
  const supabase = getSupabase();
  const [org, contacts] = await Promise.all([
    supabase.from('org_profile').select('owner_user_id, system_user_id').maybeSingle(),
    contactIds.length > 0
      ? supabase.from('contacts').select('id, full_name, business_name').in('id', [...contactIds])
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (org.error) throw org.error;
  if (contacts.error) throw contacts.error;
  const orgRow = z.object({ owner_user_id: z.string().nullable(), system_user_id: z.string().nullable() }).nullable().parse(org.data);
  const names = z.array(z.object({ id: z.string(), full_name: z.string().nullable(), business_name: z.string().nullable() })).parse(contacts.data ?? []);
  return {
    contacts: new Map(names.map((c) => [c.id, contactDisplayName({ full_name: c.full_name ?? '', business_name: c.business_name })])),
    ownerUserId: orgRow?.owner_user_id ?? null,
    systemUserId: orgRow?.system_user_id ?? null,
  };
}
