import { z } from 'zod';
import { queryKeys } from '@/api/queryKeys';
import type { PickListSpec } from '@/api/pickLists';
import { invokeEdge } from '@/lib/edge';
import { publicProjectConfig } from '@/lib/publicEdge';
import { getSupabase } from '@/lib/supabase';
import { assertAuditDetails, type AuditValue } from '../../../supabase/functions/_shared/audit';

/**
 * Everything the settings screens read and write. Query keys are this module's own; the
 * pick-list editors write through here and invalidate the shared pick-list keys, so a list
 * edited here is offered everywhere else without a reload.
 */

/**
 * A write that changed no row: the row is gone, or the database refused it without an
 * error (a row-level policy filters it out). Never reported as saved.
 */
export class NothingChangedError extends Error {
  constructor() {
    super('Nothing was saved. Reload the page and try again.');
    this.name = 'NothingChangedError';
  }
}

/** Throws NothingChangedError when a write that selected its rows back touched none. */
function mustChange(data: unknown[] | null): void {
  if (!data || data.length === 0) throw new NothingChangedError();
}

export const settingsKeys = {
  all: ['settings'] as const,
  orgProfile: () => ['settings', 'org-profile'] as const,
  leadIntakeKey: () => ['settings', 'lead-intake-key'] as const,
  lastDelivery: () => ['settings', 'lead-intake-last-delivery'] as const,
  factors: () => ['settings', 'mfa-factors'] as const,
};

// ---------------------------------------------------------------------------
// The audit log, from the browser
// ---------------------------------------------------------------------------

/** The server's action rule (_shared/audit.ts), so a row the browser writes obeys it too. */
const AUDIT_ACTION = /^[a-z][a-z0-9_.]{0,99}$/;

/**
 * Writes one owner audit row. The details hold ids, counts, flags and lowercase codes only,
 * checked by the same function the server's writer uses, and an action that breaks the rule
 * is refused here: the table's own CHECK is only a length check. Never throws: a broken
 * audit write must not block what was audited. Owner sessions only (the table takes rows
 * from the owner alone).
 */
export async function recordAudit(action: string, details: Record<string, AuditValue> = {}): Promise<boolean> {
  try {
    if (!AUDIT_ACTION.test(action)) throw new TypeError(`audit action "${action.slice(0, 100)}" is not a lowercase identifier`);
    assertAuditDetails(details);
    const supabase = getSupabase();
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) throw new Error('no session');
    const { error } = await supabase.from('audit_logs').insert({
      user_id: userId,
      action,
      details,
      user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 500),
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`Audit row ${action} was not written`, err);
    return false;
  }
}

/** The part of an address after @, lowercased, when it is a plain code; otherwise null. */
export function emailDomain(address: string): string | null {
  const domain = address.trim().split('@').pop()?.toLowerCase() ?? '';
  return /^(?=[a-z0-9_.:-]*[a-z])[a-z0-9_.:-]{1,64}$/.test(domain) ? domain : null;
}

// ---------------------------------------------------------------------------
// Identity (org_profile)
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;

const orgProfileSchema = z.object({
  display_name: z.string(),
  legal_name: z.string().nullable(),
  sender_name: z.string().nullable(),
  postal_address: z.string().nullable(),
  logo_path: z.string().nullable(),
  brand: z.record(z.string(), z.unknown()).nullable().transform((b) => b ?? {}),
});

export type OrgProfile = z.infer<typeof orgProfileSchema>;

export interface IdentityPatch {
  display_name: string;
  legal_name: string | null;
  sender_name: string | null;
  postal_address: string | null;
  primary_color: string | null;
}

export function brandColor(profile: OrgProfile): string | null {
  const value = profile.brand.primary_color;
  return typeof value === 'string' && HEX.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export async function fetchOrgProfile(): Promise<OrgProfile | null> {
  const { data, error } = await getSupabase()
    .from('org_profile')
    .select('display_name, legal_name, sender_name, postal_address, logo_path, brand')
    .maybeSingle();
  if (error) throw error;
  return data ? orgProfileSchema.parse(data) : null;
}

/** Saves the identity fields. The brand object keeps any key this form does not edit. */
export async function saveIdentity(current: OrgProfile, patch: IdentityPatch): Promise<void> {
  const brand = { ...current.brand };
  if (patch.primary_color) brand.primary_color = patch.primary_color;
  else delete brand.primary_color;
  const { data, error } = await getSupabase()
    .from('org_profile')
    .update({
      display_name: patch.display_name,
      legal_name: patch.legal_name,
      sender_name: patch.sender_name,
      postal_address: patch.postal_address,
      brand,
    })
    .eq('id', true)
    .select('id');
  if (error) throw error;
  mustChange(data);
}

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_LOGO_BYTES = 1_048_576;

/** Uploads a logo through the org-logo function, which checks the bytes and names the file. */
export async function uploadLogo(file: Blob): Promise<string> {
  const { logo_path } = await invokeEdge('org-logo', file, {
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    parse: (data) => z.object({ logo_path: z.string() }).parse(data),
  });
  return logo_path;
}

export async function removeLogo(): Promise<void> {
  const { data, error } = await getSupabase().from('org_profile').update({ logo_path: null }).eq('id', true).select('id');
  if (error) throw error;
  mustChange(data);
}

/** The public URL of a stored logo ('<bucket>/<path>'), or null for anything else. */
export function logoUrl(logoPath: string | null): string | null {
  const config = publicProjectConfig();
  if (!logoPath || !config || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)+$/.test(logoPath)) return null;
  return `${config.url}/storage/v1/object/public/${logoPath}`;
}

// ---------------------------------------------------------------------------
// Pick-lists
// ---------------------------------------------------------------------------

/** Deleting a row something still uses: the owner deactivates it instead. */
export class PickListInUseError extends Error {
  constructor() {
    super('In use; deactivate it instead.');
    this.name = 'PickListInUseError';
  }
}

export const pickListKey = (table: string) => queryKeys.pickLists.table(table);
/** The editor's own read of a list (every column it needs), apart from the app's narrower reads. */
export const editorListKey = (table: string) => ['settings', 'pick-list', table] as const;

/** A key from a label: lowercase words joined by underscores, starting with a letter, at most 40 characters. */
export function keyFromLabel(label: string): string | null {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return /^[a-z][a-z0-9_]{0,39}$/.test(slug) ? slug : null;
}

export type PickListPatch = Partial<{
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
  revenue_family: 'recurring' | 'one_time';
  default_cadence: 'monthly' | 'annual' | 'one_time';
}>;

export async function updatePickListRow<Row extends { key: string }>(list: PickListSpec<Row>, key: string, patch: PickListPatch): Promise<void> {
  const { data, error } = await getSupabase().from(list.table).update(patch).eq('key', key).select('key');
  if (error) throw error;
  mustChange(data);
}

export async function insertPickListRow<Row extends { key: string }>(
  list: PickListSpec<Row>,
  row: { key: string; label: string; colour: string | null; sort_order: number } & PickListPatch,
): Promise<void> {
  const { error } = await getSupabase().from(list.table).insert(row);
  if (error) throw error;
}

export async function deletePickListRow<Row extends { key: string }>(list: PickListSpec<Row>, key: string): Promise<void> {
  const { data, error } = await getSupabase().from(list.table).delete().eq('key', key).select('key');
  if ((error as { code?: string } | null)?.code === '23503') throw new PickListInUseError();
  if (error) throw error;
  mustChange(data);
}

// ---------------------------------------------------------------------------
// Lead intake
// ---------------------------------------------------------------------------

export interface LeadIntakeKeyStatus {
  key_hint: string;
  created_at: string;
}

export async function fetchLeadIntakeKey(): Promise<LeadIntakeKeyStatus | null> {
  const { data, error } = await getSupabase().from('lead_intake_keys').select('key_hint, created_at').maybeSingle();
  if (error) throw error;
  return data ? z.object({ key_hint: z.string(), created_at: z.string() }).parse(data) : null;
}

export async function fetchLastDelivery(): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('lead_intake_deliveries')
    .select('created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

/** Makes a new key (replacing any old one) and returns it: the only time it is ever shown. */
export async function rotateLeadIntakeKey(): Promise<string> {
  const { key } = await invokeEdge('lead-intake-key', { action: 'rotate' }, {
    parse: (data) => z.object({ key: z.string().regex(/^lik_[A-Za-z0-9_-]{20,}$/) }).parse(data),
  });
  return key;
}

export async function revokeLeadIntakeKey(): Promise<void> {
  await invokeEdge('lead-intake-key', { action: 'revoke' });
}

export function leadIntakeUrl(): string | null {
  const config = publicProjectConfig();
  return config ? `${config.url}/functions/v1/lead-intake` : null;
}

// ---------------------------------------------------------------------------
// Two-factor and backup codes
// ---------------------------------------------------------------------------

export interface TotpFactor {
  id: string;
  status: string;
}

/** The account's verified authenticator, or null. */
export async function fetchVerifiedTotp(): Promise<TotpFactor | null> {
  const { data, error } = await getSupabase().auth.mfa.listFactors();
  if (error) throw error;
  return data?.totp?.find((f) => f.status === 'verified') ?? null;
}

/** Codes are shown once: the server keeps only their digests. */
export async function generateBackupCodes(): Promise<string[]> {
  const { codes } = await invokeEdge('mfa-backup-codes', { action: 'generate' }, {
    parse: (data) => z.object({ codes: z.array(z.string()).length(8) }).parse(data),
  });
  return codes;
}

export async function revokeBackupCodes(): Promise<void> {
  await invokeEdge('mfa-backup-codes', { action: 'revoke' });
}

/** Redeems a backup code: two-factor comes off and every session is signed out. Returns the server's note. */
export async function redeemBackupCode(code: string): Promise<string> {
  const { note } = await invokeEdge('mfa-recovery', { code }, {
    parse: (data) => z.object({ note: z.string() }).parse(data),
  });
  return note;
}
