// @vitest-environment node
// The pure rules of requests: fulfilment, progress, sections, the upload folder's name,
// the reminder settings (and that the screen's defaults are the dispatcher's), and the
// builder's checks. Fixtures are fictional.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canAccept,
  DEFAULT_REMINDER_SETTINGS,
  draftProblem,
  isItemFulfilled,
  itemRow,
  listProgress,
  newDraftItem,
  normalizeReminderSettings,
  requestFolderName,
  requestFolderPath,
  requestSections,
  toDraftItems,
  type RequestItem,
} from '../lib/requests';
import {
  DEFAULT_REMINDER_SETTINGS as SERVER_DEFAULTS,
  normalizeReminderSettings as serverNormalize,
} from '../../../../supabase/functions/needs-reminder-dispatcher/handler';

function item(fields: Partial<RequestItem> = {}): RequestItem {
  return {
    id: crypto.randomUUID(), list_id: 'list', kind: 'question', label: 'Q', description: null, sort_order: 0, required: true,
    status: 'pending', answer_text: null, sensitive: false, has_secret_answer: false, category: 'general', tag: 'general',
    documents: [], ...fields,
  };
}
const doc = { id: 'l', document_id: 'd', uploaded_at: '2026-01-01T00:00:00Z', original_filename: 'a.pdf', mime_type: 'application/pdf' };

describe('the fulfilment rule', () => {
  it('reads each kind by its own evidence', () => {
    expect(isItemFulfilled(item({ kind: 'document', status: 'fulfilled' }))).toBe(false);
    expect(isItemFulfilled(item({ kind: 'document', documents: [doc] }))).toBe(true);
    expect(isItemFulfilled(item({ kind: 'todo', status: 'fulfilled' }))).toBe(true);
    expect(isItemFulfilled(item({ kind: 'todo', status: 'reviewed' }))).toBe(true);
    expect(isItemFulfilled(item({ kind: 'todo' }))).toBe(false);
    expect(isItemFulfilled(item({ answer_text: ' \n\t ' }))).toBe(false);
    expect(isItemFulfilled(item({ answer_text: 'Yes' }))).toBe(true);
    expect(isItemFulfilled(item({ sensitive: true, has_secret_answer: true }))).toBe(true);
    expect(isItemFulfilled(item({ kind: 'info', status: 'fulfilled' }))).toBe(false);
  });

  it('counts progress over actionable items only, and what waits on an accept', () => {
    const p = listProgress([
      item({ kind: 'info' }),
      item({ answer_text: 'Yes', status: 'fulfilled' }),
      item({ kind: 'todo', status: 'reviewed' }),
      item({ kind: 'document', required: false }),
      item({ kind: 'document' }),
    ]);
    expect(p).toEqual({ actionable: 4, fulfilled: 2, requiredOpen: 1, awaitingAccept: 1, canSubmit: false });
    expect(canAccept(item({ answer_text: 'Yes', status: 'fulfilled' }))).toBe(true);
    expect(canAccept(item({ answer_text: 'Yes', status: 'reviewed' }))).toBe(false);
    expect(canAccept(item({ status: 'fulfilled' }))).toBe(false);
  });
});

describe('sections', () => {
  it('puts what was handed back first, then waiting, drafts, closed, newest first within', () => {
    const l = (id: string, status: 'draft' | 'sent' | 'submitted' | 'closed', created_at: string) => ({ id, status, created_at });
    const out = requestSections([
      l('a', 'closed', '2026-01-01'), l('b', 'sent', '2026-01-01'), l('c', 'sent', '2026-02-01'), l('d', 'submitted', '2026-01-01'), l('e', 'draft', '2026-01-01'),
    ]);
    expect(out.map((s) => [s.status, s.lists.map((x) => x.id)])).toEqual([
      ['submitted', ['d']], ['sent', ['c', 'b']], ['draft', ['e']], ['closed', ['a']],
    ]);
  });
});

describe('the upload folder', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is the title and the UTC send date, whatever the clock zone', () => {
    const list = { title: 'Onboarding documents', sent_at: '2026-06-19T23:30:00-05:00', created_at: '2026-06-01T00:00:00Z' };
    expect(requestFolderName(list)).toBe('Onboarding documents – 2026-06-20');
    expect(requestFolderPath(list)).toBe('/Onboarding documents – 2026-06-20/');
  });

  it('never holds a separator, a control or format character, and fits 100 characters', () => {
    const names = [
      'a/b\\c', 'tab\there\nnew', 'zero​width‮flip', '  ..  ', '.', 'x'.repeat(300), '­',
    ].map((title) => requestFolderName({ title, sent_at: null, created_at: '2026-01-02T00:00:00Z' }));
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(100);
      // eslint-disable-next-line no-control-regex
      expect(name).not.toMatch(/[/\\\u0000-\u001f​-‏‪-‮­]/);
      expect(name).toBe(name.trim());
    }
    expect(names[3]).toBe('Request – 2026-01-02');
  });
});

describe('reminder settings', () => {
  it('are the dispatcher’s, default and clamp alike', () => {
    expect(DEFAULT_REMINDER_SETTINGS).toEqual(SERVER_DEFAULTS);
    for (const raw of [null, {}, { enabled: true, interval_days: 0, max_reminders: 50 }, { enabled: 'yes', interval_days: 3.4 }, []]) {
      expect(normalizeReminderSettings(raw)).toEqual(serverNormalize(raw));
    }
  });
});

describe('the builder', () => {
  it('names the first problem that stops a save', () => {
    expect(draftProblem(' ', [], '')).toMatch(/title/);
    expect(draftProblem('Docs', [newDraftItem()], '')).toBe('Item 1 needs a label.');
    expect(draftProblem('Docs', [{ ...newDraftItem(), label: 'x'.repeat(501) }], '')).toMatch(/Item 1/);
    expect(draftProblem('Docs', [{ ...newDraftItem(), label: 'Bank letter' }], '')).toBeNull();
  });

  it('writes sensitive only on a question and never requires an info item', () => {
    expect(itemRow({ ...newDraftItem('todo'), label: 'x', sensitive: true }, 0).sensitive).toBe(false);
    expect(itemRow({ ...newDraftItem('info'), label: 'x', required: true }, 0).required).toBe(false);
    expect(itemRow({ ...newDraftItem('question'), label: ' x ', sensitive: true, description: ' ' }, 3)).toMatchObject({
      label: 'x', sensitive: true, description: null, sort_order: 3,
    });
  });

  it('maps a template’s unknown kinds out and unknown keys to general', () => {
    const known = { categories: new Set(['general', 'invoice']), tags: new Set(['general']) };
    expect(toDraftItems([{ kind: 'transaction', label: 'x' }, { kind: 'document', label: 'Invoice', category: 'invoice', tag: 'gone' }], known)).toEqual([
      { kind: 'document', label: 'Invoice', description: '', required: true, sensitive: false, category: 'invoice', tag: 'general' },
    ]);
  });
});
