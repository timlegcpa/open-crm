// send-portal-digest: one email a day to the owner, summarizing what clients did in the
// portal over the last 24 hours. Run by the job-runner (job kind portal:daily_digest,
// cron secret) or by the owner on demand. No activity, no email.
//
// What counts, and what does not:
//   - client_activity_log rows, minus the owner's own (details.actor_role = 'owner');
//   - minus rows written for a contact during one of the owner's View-as-client windows:
//     the owner's clicks would otherwise read as the client's. If the windows cannot be
//     read, the digest goes out unfiltered and says nothing false about a real client's
//     day; dropping the whole digest would.
//   - plus messages clients sent (client_messages, sender_role 'client'), which the
//     messages feature does not log as activity. That read is a seam: on a project
//     without that table it answers null and the digest leaves messages out.
// Times are UTC and say so.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import type { EmailBlock, EmailContent } from '../_shared/email-layout.ts';
import { createHandler } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';

export interface ActivityRow {
  id: string;
  contact_id: string;
  contact_name: string;
  action: string;
  created_at: string;
  actor_role: string | null;
}

export interface ViewWindow {
  target_contact_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface MessageCount {
  contact_id: string;
  contact_name: string;
  count: number;
}

export interface RenderedMessage {
  to: string;
  subject: string;
  content: EmailContent;
  idempotencyKey: string;
}

export interface DigestDeps {
  allowedOrigins: string[];
  cronSecret: string | null | undefined;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  listActivitySince(sinceIso: string): Promise<ActivityRow[]>;
  listViewWindows(sinceIso: string): Promise<ViewWindow[]>;
  /** Client-sent messages per contact since then; null where the messages table does not exist. */
  countClientMessagesSince(sinceIso: string): Promise<MessageCount[] | null>;
  org(): Promise<OrgIdentity>;
  /** The app_settings override, else the owner's sign-in address; null when neither is known. */
  recipient(): Promise<string | null>;
  send(message: RenderedMessage, org: OrgIdentity): Promise<'sent' | 'failed' | 'unknown'>;
  now?: () => Date;
  logSink?: LogSink;
}

/** One phrase per action in client_activity_log's CHECK list (0002); a parity test holds them equal. */
export const ACTION_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  login: 'signed in',
  logout: 'signed out',
  session_start: 'started a session',
  session_expired: 'was signed out after inactivity',
  invitation_accepted: 'set up their portal account',
  start_link_consumed: 'redeemed a start link',
  profile_update: 'updated their profile',
  password_change: 'changed their password',
  password_reset_sent: 'asked for a password reset',
  document_upload: 'uploaded a document',
  document_download: 'downloaded a document',
  document_delete: 'deleted a document',
  message_sent: 'sent a message',
  message_read: 'read messages',
  esign_signed: 'signed a document',
  email_sent: 'was sent an email',
  account_suspended: 'had their account suspended',
  account_reactivated: 'had their account reactivated',
  account_deleted: 'had their account deleted',
});

export function phraseFor(action: string): string {
  return ACTION_PHRASES[action] ?? action.replace(/_/g, ' ');
}

/** Whether a row falls inside one of the owner's View-as-client windows on its contact. */
export function inViewWindow(row: Pick<ActivityRow, 'contact_id' | 'created_at'>, windows: ViewWindow[], now: Date): boolean {
  const at = Date.parse(row.created_at);
  return windows.some(
    (w) =>
      w.target_contact_id === row.contact_id &&
      at >= Date.parse(w.started_at) &&
      at <= (w.ended_at ? Date.parse(w.ended_at) : now.getTime()),
  );
}

const hhmm = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

interface ContactDay {
  name: string;
  lines: string[];
  events: number;
}

export function digestContent(opts: {
  org: OrgIdentity;
  windowEnd: Date;
  rows: ActivityRow[];
  messages: MessageCount[];
}): { content: EmailContent; events: number; contacts: number } {
  const byContact = new Map<string, ContactDay>();
  const day = (id: string, name: string) => {
    let entry = byContact.get(id);
    if (!entry) {
      entry = { name, lines: [], events: 0 };
      byContact.set(id, entry);
    }
    return entry;
  };
  const sorted = [...opts.rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const row of sorted) {
    const entry = day(row.contact_id, row.contact_name);
    entry.lines.push(`${hhmm(row.created_at)}: ${phraseFor(row.action)}`);
    entry.events += 1;
  }
  for (const m of opts.messages) {
    if (m.count <= 0) continue;
    const entry = day(m.contact_id, m.contact_name);
    entry.lines.push(m.count === 1 ? 'Sent 1 message' : `Sent ${m.count} messages`);
    entry.events += m.count;
  }

  const contacts = [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name));
  const events = contacts.reduce((sum, c) => sum + c.events, 0);
  const date = opts.windowEnd.toISOString().slice(0, 10);
  const blocks: EmailBlock[] = [
    { kind: 'heading', text: `Portal activity for ${date}` },
    {
      kind: 'paragraph',
      text: `${events} ${events === 1 ? 'event' : 'events'} from ${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'} in the 24 hours to ${hhmm(opts.windowEnd.toISOString())}.`,
    },
  ];
  for (const c of contacts) {
    blocks.push({ kind: 'paragraph', text: c.name }, { kind: 'list', items: c.lines });
  }
  blocks.push({ kind: 'note', text: `A daily summary from ${opts.org.displayName}. Your own activity and View as client are left out.` });
  return { content: { preheader: `${events} portal events from ${contacts.length} contacts.`, blocks }, events, contacts: contacts.length };
}

export function createDigestHandler(deps: DigestDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'send-portal-digest',
    allowedOrigins: deps.allowedOrigins,
    auth: { cron: { secret: deps.cronSecret }, owner: deps.authorizeOwner },
    body: 'none',
    logSink: deps.logSink,
    async handle({ json, log }) {
      const end = now();
      const since = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString();

      const activity = (await deps.listActivitySince(since)).filter((r) => r.actor_role !== 'owner');
      let windows: ViewWindow[] = [];
      try {
        windows = await deps.listViewWindows(since);
      } catch (err) {
        log.error('View-as-client windows unreadable; sending unfiltered', err);
      }
      const rows = activity.filter((r) => !inViewWindow(r, windows, end));
      const suppressed = activity.length - rows.length;

      let messages: MessageCount[] = [];
      try {
        messages = (await deps.countClientMessagesSince(since)) ?? [];
      } catch (err) {
        log.error('client messages unreadable; leaving them out', err);
      }

      if (rows.length === 0 && messages.every((m) => m.count <= 0)) {
        return json(200, { ok: true, sent: false, reason: 'no_activity', window_start: since, view_as_client_suppressed: suppressed });
      }

      const to = await deps.recipient();
      if (!to) {
        log.error('no digest recipient: set the owner sign-in address or app_settings portal_digest.recipient');
        return json(500, { error: 'The digest has no recipient.', code: 'no_recipient' });
      }
      const org = await deps.org();
      const { content, events, contacts } = digestContent({ org, windowEnd: end, rows, messages });
      const delivery = await deps.send(
        {
          to,
          subject: `Portal activity: ${events} ${events === 1 ? 'event' : 'events'} from ${contacts} ${contacts === 1 ? 'contact' : 'contacts'}`,
          content,
          // One per window: a job retried after a failed send reuses it, so a provider that
          // did accept the first try sends once.
          idempotencyKey: `portal-digest:${since.slice(0, 16)}`,
        },
        org,
      );
      // failed: nothing went out, so the job runner may retry. unknown: it may have, so it must not.
      if (delivery === 'failed') return json(502, { error: 'The digest email could not be sent.', code: 'send_failed' });
      return json(200, { ok: true, sent: true, delivery, events, contacts, window_start: since, view_as_client_suppressed: suppressed });
    },
  });
}
