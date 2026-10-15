import { expect, signIn, test } from './test';

test('the board shows each lane with its cards, and a new card lands in its lane', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto('/board');

  await expect(page.getByText('4 cards on the board')).toBeVisible();
  const todo = page.getByRole('region', { name: /^To do, 1 card$/ });
  const waiting = page.getByRole('region', { name: /^Waiting, 1 card$/ });
  const doing = page.getByRole('region', { name: /^In progress, 1 card$/ });
  const done = page.getByRole('region', { name: /^Done, 1 card$/ });
  await expect(todo).toContainText('Send proposal');
  await expect(waiting).toContainText('Review onboarding answers');
  await expect(doing).toContainText('Update price sheet');
  await expect(done).toContainText('Kickoff call');

  await page.getByRole('button', { name: 'Add work item to To do' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add work item' });
  await dialog.getByLabel('Title').fill('Prepare welcome pack');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('region', { name: /^To do, 2 cards$/ })).toContainText('Prepare welcome pack');
  await expect(page.getByText('5 cards on the board')).toBeVisible();
  const create = mock.callsTo('rpc', 'create_work_item');
  expect(create).toHaveLength(1);
  expect(create[0].json).toMatchObject({ p_title: 'Prepare welcome pack', p_stage: 'todo' });
});
