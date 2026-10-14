// One writer for audit_logs (0001_core.sql: append-only, user_id NOT NULL), through
// the service client.
//
// The actor is the human who acted, else the system actor (org_profile.system_user_id),
// so cron jobs, webhooks and other calls with no session are still attributed and never
// fail the NOT NULL. `details` carries ids and codes only: the audit log is read by the
// owner and kept for years, so a name, address or message body must never land in it.
// That is a checked rule, not a convention: any other value throws before the insert.

import { isIpLiteral } from './rate-limit.ts';

/** The slice of a Supabase client this module calls. supabase-js clients satisfy it. */
export interface AuditClient {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }>;
    select(columns: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
}

export type AuditScalar = string | number | boolean | null;
export type AuditValue = AuditScalar | readonly AuditScalar[];

export interface AuditEntry {
  /** The human who acted; omit or null for the system actor. */
  actorId?: string | null;
  /** e.g. 'contact_deleted'. Lowercase, dots and underscores, at most 100 characters. */
  action: string;
  /** Ids, counts, flags and lowercase codes only. */
  details?: Record<string, AuditValue>;
  ip?: string | null;
  userAgent?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.]{0,99}$/;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
// A code is a lowercase slug with at least one letter, so a bare digit run (a phone or
// an account number) is not one.
const CODE = /^(?=[a-z0-9_.:-]*[a-z])[a-z0-9_.:-]{1,64}$/;
const MAX_LIST = 100;

function scalarOk(v: unknown): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && (UUID.test(v) || CODE.test(v));
}

/** Throws a TypeError naming the first key that is not an id, count, flag or code. */
export function assertAuditDetails(details: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(details)) {
    if (!KEY.test(key)) throw new TypeError(`audit details: key "${key.slice(0, 64)}" is not a lowercase identifier`);
    const ok = Array.isArray(value) ? value.length <= MAX_LIST && value.every(scalarOk) : scalarOk(value);
    if (!ok) throw new TypeError(`audit details: "${key}" must hold ids, numbers, booleans or lowercase codes only`);
  }
}

export function createAudit(deps: { db: AuditClient }): { write(entry: AuditEntry): Promise<void> } {
  let systemActor: string | null = null;

  async function systemActorId(): Promise<string> {
    if (systemActor) return systemActor;
    const { data, error } = await deps.db.from('org_profile').select('system_user_id').maybeSingle();
    if (error) throw error;
    const id = (data as { system_user_id?: unknown } | null)?.system_user_id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('org_profile has no system actor; run npm run dev:bootstrap');
    systemActor = id;
    return id;
  }

  return {
    async write(entry: AuditEntry): Promise<void> {
      if (!ACTION.test(entry.action)) throw new TypeError(`audit action "${entry.action.slice(0, 100)}" is not a lowercase identifier`);
      const details = entry.details ?? {};
      assertAuditDetails(details);
      if (entry.actorId != null && !UUID.test(entry.actorId)) throw new TypeError('audit actorId must be a uuid');
      const userId = entry.actorId ?? (await systemActorId());
      const { error } = await deps.db.from('audit_logs').insert({
        user_id: userId,
        action: entry.action,
        details,
        // inet column: a value Postgres would refuse would fail the whole insert.
        ip_address: entry.ip && isIpLiteral(entry.ip) ? entry.ip : null,
        user_agent: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
      });
      if (error) throw error;
    },
  };
}
