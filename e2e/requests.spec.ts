import { expect, ID, signIn, test } from './test';
import { QUESTION_ITEM, REQUEST_ID } from './mocks/requests';

test('the owner builds a request, saves it and sends it', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto(`/requests/new?contact=${ID.grace}`);
  await expect(page.getByText('For Grace Hopper')).toBeVisible();

  await page.getByLabel('Title').fill('Welcome pack');
  await page.getByLabel('Message to the client (optional)').fill('Two quick things before we start.');

  // The builder starts with one file item; fill it, then add a question.
  const first = page.getByRole('group', { name: 'Item 1' });
  await first.getByLabel('What you need').fill('Proof of address');
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('menuitem', { name: 'Answer a question' }).click();
  const second = page.getByRole('group', { name: 'Item 2' });
  await expect(second.getByRole('combobox', { name: 'Item 2 kind' })).toHaveText('Answer a question');
  await second.getByLabel('What you need').fill('Preferred contact hours');

  await page.getByRole('button', { name: 'Save and send' }).click();
  await expect(page.getByText('Sent.', { exact: true })).toBeVisible();

  // The draft was saved in one call with both items, then that list was sent.
  const save = mock.callsTo('rpc', 'needs_owner_save_draft');
  expect(save).toHaveLength(1);
  expect(save[0].json).toMatchObject({
    p_contact_id: ID.grace,
    p_title: 'Welcome pack',
    p_intro: 'Two quick things before we start.',
    p_list_id: null,
    p_items: [
      expect.objectContaining({ kind: 'document', label: 'Proof of address' }),
      expect.objectContaining({ kind: 'question', label: 'Preferred contact hours' }),
    ],
  });
  const created = mock.table('needs_lists').find((l) => l.title === 'Welcome pack')!;
  const send = mock.callsTo('functions', 'send-needs-list');
  expect(send.map((c) => c.json)).toEqual([{ list_id: created.id }]);

  // It opens on the sent request.
  await expect(page).toHaveURL(`/requests/${created.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome pack' })).toBeVisible();
  await expect(page.getByText('Waiting on client').first()).toBeVisible();
});

test('the builder refuses to send a request with no title', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto(`/requests/new?contact=${ID.grace}`);
  await page.getByRole('group', { name: 'Item 1' }).getByLabel('What you need').fill('Proof of address');
  await page.getByRole('button', { name: 'Save and send' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(mock.callsTo('rpc', 'needs_owner_save_draft')).toEqual([]);
  expect(mock.callsTo('functions', 'send-needs-list')).toEqual([]);
});

test('the client answers a question in the portal and the answer is saved', async ({ page, mock }) => {
  await signIn(page, mock, 'client');
  await page.goto(`/portal/requests/${REQUEST_ID}`);
  await expect(page.getByRole('heading', { name: 'Onboarding documents' })).toBeVisible();
  await expect(page.getByText('1 required item is still open.')).toBeVisible();

  const answer = page.getByRole('textbox', { name: 'Which day of the month suits a check-in call?' });
  await answer.fill('The first Monday works best.');
  await answer.blur();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  const saves = mock.callsTo('functions', 'needs-save');
  expect(saves.at(-1)!.json).toEqual({ action: 'save_answer', item_id: QUESTION_ITEM, answer: 'The first Monday works best.' });
  expect(saves.every((c) => c.principal === 'client')).toBe(true);

  // With the one required item answered (the file is optional), the request can be submitted.
  await expect(page.getByText('1 of 2 done. Ready to submit.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted. Thank you.')).toBeVisible();
  expect(mock.callsTo('functions', 'needs-save').at(-1)!.json).toEqual({ action: 'submit', list_id: REQUEST_ID });
});
