// needs-reminder-dispatcher: the scheduled reminder for sent requests. The job-runner's
// 'needs:reminder_dispatch' kind calls it with the cron secret; the owner may also run it.
//
// Off until the owner turns it on (app_settings 'needs_reminders'). A list is due when it
// is sent, not paused, under the cap, and the interval has passed since it was sent or
// last reminded. Only a contact with an active portal account is reminded on a schedule:
// a start link is minted by a person's send or Remind, never by a timer. A list with
// nothing left open is skipped, not reminded. Nothing to do is a success.
//
// The answer is counts only (no ids, names or addresses), for the job's result.

import { createHandler } from '../_shared/handler.ts';
import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import type { LogSink } from '../_shared/log.ts';
import { remindList, type NeedsListRow, type NeedsSendStore } from '../send-needs-list/handler.ts';

export interface ReminderSettings {
  enabled: boolean;
  interval_days: number;
  max_reminders: number;
}

/** What the reminders are before the owner saves anything: off. The settings screen shows the same. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: false, interval_days: 7, max_reminders: 4 };
export const INTERVAL_DAYS_RANGE = { min: 1, max: 365 } as const;
export const MAX_REMINDERS_RANGE = { min: 1, max: 20 } as const;

const clampInt = (v: unknown, fallback: number, range: { min: number; max: number }) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(Math.max(n, range.min), range.max);
};

/** The stored settings, read defensively: anything missing or out of range takes the default or the bound. */
export function normalizeReminderSettings(raw: unknown): ReminderSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: v.enabled === true,
    interval_days: clampInt(v.interval_days, DEFAULT_REMINDER_SETTINGS.interval_days, INTERVAL_DAYS_RANGE),
    max_reminders: clampInt(v.max_reminders, DEFAULT_REMINDER_SETTINGS.max_reminders, MAX_REMINDERS_RANGE),
  };
}

export interface DispatchListRow extends NeedsListRow {
  reminders_paused: boolean;
  sent_at: string | null;
  last_reminded_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a list is due a scheduled reminder at `now`. */
export function isReminderDue(row: DispatchListRow, settings: ReminderSettings, now: Date): boolean {
  if (row.status !== 'sent' || row.reminders_paused) return false;
  if (row.reminder_count >= settings.max_reminders) return false;
  const anchor = row.last_reminded_at ?? row.sent_at;
  if (!anchor) return false;
  const at = new Date(anchor).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at >= settings.interval_days * DAY_MS;
}

export interface DispatcherDeps {
  allowedOrigins: string[];
  siteUrl: string | null;
  cronSecret: string | null | undefined;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** app_settings 'needs_reminders' value, or null. */
  loadSettings(): Promise<unknown>;
  /** Every sent list, read in pages. */
  sentLists(): Promise<DispatchListRow[]>;
  /** Of these contacts, the ones with an active portal account. */
  activeContacts(contactIds: string[]): Promise<Set<string>>;
  /** Of these contacts, the archived ones. A scheduled reminder never mails them. */
  archivedContacts(contactIds: string[]): Promise<Set<string>>;
  store: NeedsSendStore;
  now?: () => Date;
  logSink?: LogSink;
}

export function createDispatcherHandler(deps: DispatcherDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'needs-reminder-dispatcher',
    allowedOrigins: deps.allowedOrigins,
    auth: { cron: { secret: deps.cronSecret }, owner: deps.authorizeOwner },
    body: 'optional_json',
    logSink: deps.logSink,
    async handle({ json, log }) {
      const settings = normalizeReminderSettings(await deps.loadSettings());
      const empty = { sent: 0, due: 0, failures: 0, skipped_zero_remaining: 0, skipped_in_progress: 0 };
      if (!settings.enabled) return json(200, { ...empty, enabled: false });
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; reminders need it for their links');
        return json(500, { error: 'Reminders are not set up yet.', code: 'site_url_missing' });
      }
      const now = (deps.now ?? (() => new Date()))();
      const due = (await deps.sentLists()).filter((row) => isReminderDue(row, settings, now));
      if (due.length === 0) return json(200, { ...empty, enabled: true });

      const ids = [...new Set(due.map((r) => r.contact_id))];
      const active = await deps.activeContacts(ids);
      const archived = await deps.archivedContacts(ids);
      const out = { ...empty, due: due.length };
      for (const row of due) {
        if (!active.has(row.contact_id) || archived.has(row.contact_id)) continue;
        try {
          const result = await remindList(deps.store, deps.siteUrl, row, null, log);
          if (result.status === 'reminded') out.sent++;
          else if (result.status === 'nothing_open') out.skipped_zero_remaining++;
          // Another reminder (a person's Remind) got there first: this list is not due now.
          else if (result.status === 'in_progress') out.skipped_in_progress++;
          else if (result.status !== 'not_sent') out.failures++;
        } catch (err) {
          out.failures++;
          log.error('reminder failed', err, { list_id: row.id });
        }
      }
      return json(200, { ...out, enabled: true });
    },
  });
}
