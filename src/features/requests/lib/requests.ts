/**
 * Requests, the pure parts: the shapes, the one fulfilment rule as the browser applies
 * it, how a list's progress and sections are derived, the folder a list's uploads go
 * into, and the reminder settings. No supabase-js here, so every screen and test can use
 * it, and the portal never loads the owner's code through it.
 *
 * isItemFulfilled is the browser's twin of public.needs_list_progress (0005_requests.sql);
 * __tests__/parity.test.ts runs both over the same items. Change one, change the other.
 */

export const ITEM_KINDS = ['document', 'question', 'todo', 'info'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = 'pending' | 'fulfilled' | 'reviewed';
export type ListStatus = 'draft' | 'sent' | 'submitted' | 'closed';

/** What each kind asks of the client, for the builder's kind picker. */
export const KIND_LABELS: Record<ItemKind, string> = {
  document: 'Upload a file',
  question: 'Answer a question',
  todo: 'Do a task',
  info: 'Read a note',
};

/** A list's status as the screens say it. */
export const LIST_STATUS_LABELS: Record<ListStatus, string> = {
  draft: 'Draft',
  sent: 'Waiting on client',
  submitted: 'Submitted',
  closed: 'Closed',
};

/** An item's status as the owner's screens say it: reviewed is Accepted. */
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  pending: 'Open',
  fulfilled: 'Answered',
  reviewed: 'Accepted',
};

/** The longest values the database takes (0005), checked before a save. */
export const LIMITS = {
  title: 200,
  intro: 5000,
  label: 500,
  description: 2000,
  answer: 5000,
  templateName: 200,
} as const;

export interface LinkedDocument {
  /** The link row. */
  id: string;
  document_id: string;
  uploaded_at: string;
  original_filename: string | null;
  mime_type: string | null;
}

export interface RequestItem {
  id: string;
  list_id: string;
  kind: ItemKind;
  label: string;
  description: string | null;
  sort_order: number;
  required: boolean;
  status: ItemStatus;
  answer_text: string | null;
  sensitive: boolean;
  /** Whether an encrypted answer is stored. The ciphertext itself is never read by a screen. */
  has_secret_answer: boolean;
  category: string;
  tag: string;
  documents: LinkedDocument[];
}

export interface RequestList {
  id: string;
  contact_id: string;
  title: string;
  status: ListStatus;
  intro_message: string | null;
  include_contact_confirm: boolean;
  reminders_paused: boolean;
  reminder_count: number;
  last_reminded_at: string | null;
  created_at: string;
  sent_at: string | null;
  submitted_at: string | null;
  closed_at: string | null;
  content_version: number;
}

export interface RequestWithItems extends RequestList {
  items: RequestItem[];
}

/** What the builder edits: an item before it has a row. */
export interface DraftItem {
  kind: ItemKind;
  label: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  category: string;
  tag: string;
}

export const newDraftItem = (kind: ItemKind = 'document'): DraftItem => ({
  kind,
  label: '',
  description: '',
  required: kind !== 'info',
  sensitive: false,
  category: 'general',
  tag: 'general',
});

/** Info items are display only: never counted, never required. */
export function isActionable(item: Pick<RequestItem, 'kind'>): boolean {
  return item.kind !== 'info';
}

/** The fulfilment rule (the twin of needs_list_progress). */
export function isItemFulfilled(
  item: Pick<RequestItem, 'kind' | 'status' | 'answer_text' | 'has_secret_answer'> & { documents: readonly unknown[] },
): boolean {
  switch (item.kind) {
    case 'document':
      return item.documents.length > 0;
    case 'todo':
      return item.status === 'fulfilled' || item.status === 'reviewed';
    case 'question':
      return item.has_secret_answer || /\S/.test(item.answer_text ?? '');
    default:
      return false;
  }
}

export interface ListProgress {
  actionable: number;
  fulfilled: number;
  requiredOpen: number;
  /** Answered items waiting on the owner's accept. */
  awaitingAccept: number;
  canSubmit: boolean;
}

export function listProgress(items: readonly RequestItem[]): ListProgress {
  let actionable = 0;
  let fulfilled = 0;
  let requiredOpen = 0;
  let awaitingAccept = 0;
  for (const item of items) {
    if (!isActionable(item)) continue;
    actionable++;
    const done = isItemFulfilled(item);
    if (done) fulfilled++;
    if (item.required && !done) requiredOpen++;
    if (done && item.status !== 'reviewed') awaitingAccept++;
  }
  return { actionable, fulfilled, requiredOpen, awaitingAccept, canSubmit: requiredOpen === 0 };
}

/** An item the owner can accept now: answered and not yet accepted. */
export function canAccept(item: RequestItem): boolean {
  return isActionable(item) && item.status === 'fulfilled' && isItemFulfilled(item);
}

/** The owner's requests page, in the order it shows them: what needs the owner first. */
export const SECTION_ORDER: readonly ListStatus[] = ['submitted', 'sent', 'draft', 'closed'];

export function requestSections<T extends Pick<RequestList, 'status' | 'created_at' | 'id'>>(
  lists: readonly T[],
): Array<{ status: ListStatus; lists: T[] }> {
  return SECTION_ORDER.map((status) => ({
    status,
    lists: lists
      .filter((l) => l.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1)),
  })).filter((s) => s.lists.length > 0);
}

/** The lists a client still has to work on (the portal home card). */
export function openRequestLists<T extends Pick<RequestList, 'status'>>(lists: readonly T[]): T[] {
  return lists.filter((l) => l.status === 'sent');
}

// ---------------------------------------------------------------------------
// The folder a list's uploads are filed into, under the contact's own section
// ---------------------------------------------------------------------------

/** What a folder name may not hold (0003 client_folders): separators, control and format characters. */
// eslint-disable-next-line no-control-regex
const NOT_IN_A_NAME = /[/\\\u0000-\u001f\u007f-\u009f­؀-؅؜۝܏࢐࢑࣢᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/gu;
const TITLE_MAX = 87;

/**
 * The folder for a list's uploads: its title, made safe as a name, then the date it was
 * sent in UTC ("Onboarding – 2026-06-19"). UTC, so the client who files into it and the
 * owner who later finds it compute the same name whatever their clock says. At most 100
 * characters (87 for the title).
 */
export function requestFolderName(list: Pick<RequestList, 'title' | 'sent_at' | 'created_at'>): string {
  const title = Array.from(list.title.replace(NOT_IN_A_NAME, ' ').replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX).join('').trim();
  const safe = title === '' || title === '.' || title === '..' ? 'Request' : title;
  const at = new Date(list.sent_at ?? list.created_at);
  const date = Number.isNaN(at.getTime()) ? 'undated' : at.toISOString().slice(0, 10);
  return `${safe} – ${date}`;
}

/** The folder path a list's uploads carry: '/<name>/'. */
export function requestFolderPath(list: Pick<RequestList, 'title' | 'sent_at' | 'created_at'>): string {
  return `/${requestFolderName(list)}/`;
}

// ---------------------------------------------------------------------------
// Reminders (app_settings 'needs_reminders'), mirrored from needs-reminder-dispatcher
// ---------------------------------------------------------------------------

export const REMINDER_SETTINGS_KEY = 'needs_reminders';

export interface ReminderSettings {
  enabled: boolean;
  interval_days: number;
  max_reminders: number;
}

/** Off until the owner turns it on; the dispatcher reads the same defaults. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: false, interval_days: 7, max_reminders: 4 };
export const INTERVAL_DAYS_RANGE = { min: 1, max: 365 } as const;
export const MAX_REMINDERS_RANGE = { min: 1, max: 20 } as const;

const clampInt = (v: unknown, fallback: number, range: { min: number; max: number }) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(Math.max(n, range.min), range.max);
};

/** The stored settings as the dispatcher will read them. */
export function normalizeReminderSettings(raw: unknown): ReminderSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: v.enabled === true,
    interval_days: clampInt(v.interval_days, DEFAULT_REMINDER_SETTINGS.interval_days, INTERVAL_DAYS_RANGE),
    max_reminders: clampInt(v.max_reminders, DEFAULT_REMINDER_SETTINGS.max_reminders, MAX_REMINDERS_RANGE),
  };
}

// ---------------------------------------------------------------------------
// The builder's checks
// ---------------------------------------------------------------------------

/** What stops a draft from being saved, or null. */
export function draftProblem(title: string, items: readonly DraftItem[], intro: string): string | null {
  if (!title.trim()) return 'Give the request a title.';
  if (title.length > LIMITS.title) return `Keep the title under ${LIMITS.title} characters.`;
  if (intro.length > LIMITS.intro) return `Keep the message under ${LIMITS.intro} characters.`;
  for (const [i, item] of items.entries()) {
    if (!item.label.trim()) return `Item ${i + 1} needs a label.`;
    if (item.label.length > LIMITS.label) return `Item ${i + 1}: keep the label under ${LIMITS.label} characters.`;
    if (item.description.length > LIMITS.description) return `Item ${i + 1}: keep the details under ${LIMITS.description} characters.`;
  }
  return null;
}

/** What stops a draft from being sent, beyond what stops it being saved. */
export function sendProblem(items: readonly DraftItem[]): string | null {
  if (items.length === 0) return 'Add at least one item before sending.';
  return null;
}

/** An item as the database takes it (needs_items columns; sensitive only on a question). */
export function itemRow(item: DraftItem, sortOrder: number) {
  return {
    kind: item.kind,
    label: item.label.trim(),
    description: item.description.trim() || null,
    required: item.kind === 'info' ? false : item.required,
    sensitive: item.kind === 'question' ? item.sensitive : false,
    category: item.category || 'general',
    tag: item.tag || 'general',
    sort_order: sortOrder,
  };
}

/** A template's or a list's items as the builder edits them; unknown keys fall back to general. */
export function toDraftItems(
  rows: ReadonlyArray<Partial<Record<keyof DraftItem, unknown>>>,
  known: { categories: ReadonlySet<string>; tags: ReadonlySet<string> },
): DraftItem[] {
  return rows
    .filter((r) => typeof r.kind === 'string' && (ITEM_KINDS as readonly string[]).includes(r.kind))
    .map((r) => {
      const kind = r.kind as ItemKind;
      return {
        kind,
        label: typeof r.label === 'string' ? r.label : '',
        description: typeof r.description === 'string' ? r.description : '',
        required: kind === 'info' ? false : r.required !== false,
        sensitive: kind === 'question' && r.sensitive === true,
        category: typeof r.category === 'string' && known.categories.has(r.category) ? r.category : 'general',
        tag: typeof r.tag === 'string' && known.tags.has(r.tag) ? r.tag : 'general',
      };
    });
}
