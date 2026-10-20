// @vitest-environment node
// The pure rules of requests: fulfilment, progress, the roster's grouping, the upload folder's name,
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
  requestRosterSections,
  answersToAccept,
  ARCHIVED_SECTION,
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

describe('the roster', () => {
  type Item = { kind: string; status: string };
  const l = (id: string, status: string, contact = id, items: Item[] = [], created_at = '2026-01-01') =>
    ({ id, status, contact_id: contact, created_at, items });
  const names: Record<string, string> = { a: 'Adams', b: 'Baker', c: 'Cole', d: 'Diaz', z: 'Zed' };
  const nameOf = (id: string) => names[id] ?? id;
  const ids = (s: { rows: Array<{ id: string }> }) => s.rows.map((r) => r.id);

  it('groups by whose move it is: yours, the client, drafts, archived', () => {
    const out = requestRosterSections([l('a', 'submitted'), l('b', 'sent'), l('c', 'draft'), l('d', 'closed')], nameOf);
    expect(out.map((s) => s.label)).toEqual(['Waiting on you', 'Waiting on client', 'Drafts', 'Archived']);
    expect(out.map(ids)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(out.at(-1)!.key).toBe(ARCHIVED_SECTION);
  });

  it('puts a sent list with an answer to accept on your side; a note or an accepted answer does not count', () => {
    const answered = l('a', 'sent', 'a', [{ kind: 'question', status: 'pending' }, { kind: 'document', status: 'fulfilled' }]);
    const accepted = l('b', 'sent', 'b', [{ kind: 'todo', status: 'reviewed' }, { kind: 'info', status: 'fulfilled' }]);
    expect(requestRosterSections([answered, accepted], nameOf).map((s) => [s.key, ids(s)])).toEqual([['yours', ['a']], ['client', ['b']]]);
    expect(answersToAccept(answered)).toBe(1);
    expect(answersToAccept(accepted)).toBe(0);
  });

  it('runs A to Z by client inside a section, then newest first, then by id', () => {
    const out = requestRosterSections(
      [l('z1', 'sent', 'z'), l('a1', 'sent', 'a', [], '2026-01-01'), l('b1', 'sent', 'b'), l('a2', 'sent', 'a', [], '2026-03-01'),
        l('a4', 'sent', 'a', [], '2026-02-01'), l('a3', 'sent', 'a', [], '2026-02-01')],
      nameOf,
    );
    expect(ids(out[0])).toEqual(['a2', 'a3', 'a4', 'a1', 'b1', 'z1']);
  });

  it('drops empty sections and never drops an unknown status', () => {
    const out = requestRosterSections([l('a', 'sent'), l('z', 'paused')], nameOf);
    expect(out.map((s) => [s.key, s.label])).toEqual([['client', 'Waiting on client'], ['other:paused', 'paused']]);
  });

  it('never folds an unknown status into a known section that shares its name', () => {
    const out = requestRosterSections([l('a', 'closed'), l('b', 'archived')], nameOf);
    expect(out.map((s) => [s.key, ids(s)])).toEqual([[ARCHIVED_SECTION, ['a']], ['other:archived', ['b']]]);
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
