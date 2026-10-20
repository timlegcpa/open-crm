import { expect, ID, signIn, test } from './test';

test.beforeEach(async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
});

test('the contacts list shows every contact, grouped, and opens a record', async ({ page }) => {
  await page.goto('/contacts?tab=all');
  await expect(page.getByText('2 contacts')).toBeVisible();
  const ada = page.getByRole('link', { name: /Lovelace, Ada/ }).first();
  await expect(ada).toBeVisible();
  await expect(page.getByRole('link', { name: /Grace Hopper/ }).first()).toBeVisible();

  await ada.click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${ID.ada}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible();
});

test('the page opens on Clients; the tabs are links, and Tiers ranks the active clients', async ({ page }) => {
  await page.goto('/contacts');
  const tabs = page.getByRole('tablist', { name: 'Contact lists' });
  await expect(tabs.getByRole('tab', { name: 'Clients' })).toHaveAttribute('aria-selected', 'true');
  const index = page.getByRole('region', { name: 'Clients' });
  await expect(index.getByRole('link', { name: 'Lovelace, Ada' })).toBeVisible();
  // A lead is not a client: Grace is on the board, not in the Clients list.
  await expect(index.getByRole('link', { name: /Grace/ })).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'Tiers' }).click();
  await expect(page).toHaveURL(/\/contacts\?tab=tiers$/);
  await expect(page.getByRole('region', { name: 'S tier' }).getByRole('button', { name: 'Open Lovelace, Ada' })).toBeVisible();
  // Remembered: a bare /contacts comes back to Tiers.
  await page.goto('/contacts');
  await expect(tabs.getByRole('tab', { name: 'Tiers' })).toHaveAttribute('aria-selected', 'true');
});

test('a contact is archived from the list, leaves every list, and comes back from Archived', async ({ page, mock }) => {
  await page.goto('/contacts?tab=all');
  await expect(page.getByRole('link', { name: /Grace Hopper/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Archive Grace Hopper' }).first().click();
  await expect(page.getByText('Grace Hopper archived. The record is kept.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Grace Hopper/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show Grace Hopper' })).toHaveCount(0);
  const archive = mock.callsTo('rest', 'contacts').find((c) => c.method === 'PATCH');
  expect(Object.keys(archive?.json as object)).toEqual(['archived_at']);

  await page.getByRole('button', { name: 'Archived (1)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archived people' });
  await expect(dialog.getByText('Restores to Hot')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore Grace Hopper' }).click();
  await expect(page.getByText('Grace Hopper restored.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /Grace Hopper/ }).first()).toBeVisible();
});

test('a contact record: tabs, counts and header actions', async ({ page }) => {
  await page.goto(`/contacts/${ID.ada}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible();

  const tabs = page.getByRole('navigation', { name: 'Contact sections' });
  for (const label of ['Overview', 'Billing', 'Documents', 'Requests', 'Messages', 'E-sign', 'Portal', 'Activity']) {
    await expect(tabs.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  // What is waiting on the contact: one unreviewed upload, one envelope out for signature.
  await expect(tabs.getByRole('link', { name: /^Documents/ })).toContainText('1');
  await expect(tabs.getByRole('link', { name: /^E-sign/ })).toContainText('1');

  // Requests tab: the request sent to Ada, with its progress.
  await tabs.getByRole('link', { name: /^Requests/ }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${ID.ada}/requests$`));
  const request = page.getByRole('link', { name: /Onboarding documents/ });
  await expect(request).toBeVisible();
  await expect(request).toContainText('0 of 2 answered');
  await expect(request).toContainText('Waiting on client');

  // E-sign tab: the envelope, its status and its signer.
  await tabs.getByRole('link', { name: /^E-sign/ }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${ID.ada}/esign$`));
  const row = page.getByRole('row', { name: /Service agreement/ });
  await expect(row).toContainText('Sent');
  await expect(row).toContainText('Ada Lovelace');

  // Header actions lead to the request builder and the envelope composer for this contact.
  await page.getByRole('link', { name: 'New envelope for this contact' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/esign/new' && url.searchParams.get('contact') === ID.ada);
  await expect(page.getByRole('heading', { name: 'New envelope' })).toBeVisible();

  await page.goBack();
  await page.getByRole('main').getByRole('link', { name: 'New request', exact: true }).first().click();
  await expect(page).toHaveURL((url) => url.pathname === '/requests/new' && url.searchParams.get('contact') === ID.ada);
  await expect(page.getByText('For Ada Lovelace')).toBeVisible();
});

test('the portal tab shows the active portal account and View as client', async ({ page }) => {
  await page.goto(`/contacts/${ID.ada}/portal`);
  await expect(page.getByRole('button', { name: 'View as client' }).first()).toBeVisible();
  const account = page.getByRole('main').getByText('ada@example.test').filter({ visible: true }).first();
  await expect(account).toBeVisible();
});
