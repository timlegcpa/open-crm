import { expect, ID, signIn, test } from './test';
import { AGREEMENT_DOC } from './mocks/documents';

test.beforeEach(async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
});

test('the folder view lists both sections and flags what needs review', async ({ page }) => {
  await page.goto('/documents');
  await expect(page.getByText('1 unreviewed across 1 contact')).toBeVisible();
  await expect(page.getByText('Pick a contact', { exact: true }).filter({ visible: true })).toBeVisible();
  // The workspace's client panel picks the contact, in place: their two sections open.
  await page.getByRole('complementary', { name: 'Contact list' }).getByRole('link', { name: 'Lovelace, Ada' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/documents' && url.searchParams.get('contact') === ID.ada);

  const shared = page.getByRole('row', { name: /Agreements/ });
  const upload = page.getByRole('row', { name: /Company registration/ });
  await expect(shared).toBeVisible();
  await expect(upload).toBeVisible();
  await expect(upload).toContainText('Needs review');

  // Another pick re-opens the same explorer on that contact, even a lead with no files yet.
  await page.getByRole('complementary', { name: 'Contact list' }).getByRole('link', { name: 'Grace Hopper' }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('contact') === ID.grace);
  await expect(page.getByRole('row', { name: /Company registration/ })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Grace Hopper' }).filter({ visible: true }).first()).toBeVisible();
});

test('a dialog open on one contact closes when the browser goes Back to another', async ({ page, mock }) => {
  await page.goto(`/documents?contact=${ID.grace}`);
  await page.getByRole('complementary', { name: 'Contact list' }).getByRole('link', { name: 'Lovelace, Ada' }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('contact') === ID.ada);
  await page.getByRole('row', { name: /Agreements/ }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Folder name').fill('For Ada');

  await page.goBack();
  await expect(page).toHaveURL((url) => url.searchParams.get('contact') === ID.grace);
  // Closed, so it can never make Ada's folder in Grace's documents.
  await expect(dialog).toBeHidden();
  expect(mock.callsTo('rest', 'client_folders').filter((c) => c.method === 'POST')).toEqual([]);
});

test('a document link opens the same viewer on its own page', async ({ page }) => {
  await page.goto(`/documents/${AGREEMENT_DOC}`);
  await expect(page.getByText('Page 1 of 1')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Send for signature' })).toBeVisible();
});

test('a document opens in the viewer, and Send for signature starts an envelope from it', async ({ page, mock }) => {
  await page.goto(`/documents?contact=${ID.ada}`);
  await page.getByRole('row', { name: /Agreements/ }).click();
  const file = page.getByRole('row', { name: /Service agreement/ });
  await expect(file).toBeVisible();
  // A double-click opens the full viewer in place.
  await file.dblclick();
  await expect(page.getByText('Page 1 of 1')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Agreements · Service agreement.pdf')).toBeVisible();
  // The viewer read the bytes through the decrypting function, never from storage directly.
  expect(mock.callsTo('functions', 'decrypt-document')[0].json).toMatchObject({ document_id: AGREEMENT_DOC });
  expect(mock.callsTo('storage')).toEqual([]);

  await page.getByRole('button', { name: 'Send for signature' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/esign/new' && url.searchParams.get('document') === AGREEMENT_DOC);
  await expect(page.getByText('Starts with Service agreement.pdf.')).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Service agreement');

  // Creating the envelope carries the stored PDF into it.
  await page.getByRole('button', { name: 'Create envelope' }).click();
  await expect(page).toHaveURL(/\/esign\/[0-9a-f-]{36}$/);
  const created = mock.callsTo('functions', 'esign-create-envelope');
  expect(created[0].json).toMatchObject({ title: 'Service agreement', primary_contact_id: ID.ada });
  const upload = mock.callsTo('functions', 'esign-upload-document');
  expect(upload).toHaveLength(1);
  expect(upload[0].body!.toString('latin1')).toContain('%PDF-');
  await expect(page.getByText('Service agreement.pdf').first()).toBeVisible();
});
