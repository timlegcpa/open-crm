import { expect, ID, signIn, test } from './test';

test.beforeEach(async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
});

const panel = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Contact list' });

test('the New menu holds every create, and a dialog opens where the owner is and hands focus back', async ({ page, mock }) => {
  await page.goto('/settings');
  const newButton = page.getByRole('button', { name: 'New', exact: true }).first();
  await newButton.click();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveText(['Contact', 'Work item', 'Request', 'E-sign envelope']);

  // Work item opens the board's own dialog on this page, not on the board.
  await page.getByRole('menuitem', { name: 'Work item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add work item' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await dialog.getByLabel('Title').fill('Call the printer');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(mock.callsTo('rpc', 'create_work_item')[0].json).toMatchObject({ p_title: 'Call the printer', p_stage: 'todo' });
  // Closing the dialog puts focus back on New, not on the page.
  await expect(newButton).toBeFocused();

  // Contact goes to the intake.
  await newButton.click();
  await page.getByRole('menuitem', { name: 'Contact' }).click();
  await expect(page).toHaveURL(/\/contacts\/new$/);

  // Request asks who it is for, then opens the builder for them.
  await newButton.click();
  await page.getByRole('menuitem', { name: 'Request' }).click();
  const request = page.getByRole('dialog', { name: 'New request' });
  await expect(request).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(request).toBeHidden();
  await expect(newButton).toBeFocused();
});

test('Ctrl K floats a search beside the rail, clears on dismiss, and opens a record', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox', { name: 'Find a contact' });
  await expect(box).toBeFocused();
  await box.fill('love');
  await expect(page.getByRole('option', { name: /Ada Lovelace/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  // Dismissed means cleared: it reopens empty.
  await page.keyboard.press('Control+k');
  await expect(box).toHaveValue('');
  await box.fill('grace');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/contacts/${ID.grace}$`));

  // Where the client panel shows, its box IS the search.
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(panel(page).getByRole('textbox', { name: 'Search contacts' })).toBeFocused();
  await expect(box).toHaveCount(0);
});

test('the bottom bar counts what is waiting and the size of the book, each a link', async ({ page, mock }) => {
  await page.goto('/settings');
  const bar = page.getByRole('region', { name: 'Status' });
  await expect(bar.getByRole('link', { name: /^To review/ })).toHaveText('To review1');
  await expect(bar.getByRole('link', { name: /^Unread/ })).toBeVisible();
  await expect(bar.getByRole('link', { name: /^To accept/ })).toBeVisible();
  // One client (Ada) and one open lead (Grace).
  await expect(bar.getByRole('link', { name: /^Clients/ })).toHaveText('Clients1');
  await expect(bar.getByRole('link', { name: /^Open leads/ })).toHaveText('Open leads1');
  // Off the workspace the bar asks for counts only: no contact row leaves the database.
  const contactReads = mock.callsTo('rest', 'contacts');
  expect(contactReads.length).toBeGreaterThan(0);
  expect(contactReads.map((c) => c.method)).toEqual(contactReads.map(() => 'HEAD'));
  await bar.getByRole('link', { name: /^To review/ }).click();
  await expect(page).toHaveURL(/\/documents$/);
  // The rail draws the same count once, on the Documents icon.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByLabel('Uploads to review: 1')).toHaveCount(1);
});

test('one workspace: the panel and the strip stay while the screen changes, and old tabs land', async ({ page }) => {
  await page.goto('/board');
  const strip = page.getByRole('tablist', { name: 'Workspace' });
  await expect(strip.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toBeVisible();
  // The page's own title sits under the tabs.
  await expect(page.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();

  await strip.getByRole('tab', { name: /^Requests/ }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(panel(page)).toBeVisible();
  await strip.getByRole('tab', { name: 'Marketing' }).click();
  await expect(page).toHaveURL(/\/marketing$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Marketing' })).toBeVisible();

  // The Contacts door is lit on every workspace screen no other door claims.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');

  // A link to a list tab that the panel's switch replaced lands on the pipeline.
  await page.goto('/contacts?tab=clients');
  await expect(page).toHaveURL(/\/contacts\?tab=pipeline$/);
});

test('on a phone the workspace keeps one pane: the panel where choosing a contact is the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A pick the page cannot read is no pick: the panel stays the screen.
  await page.goto('/documents?contact=invalid');
  await expect(panel(page)).toBeVisible();
  await page.goto('/documents');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('link', { name: 'Lovelace, Ada' }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('contact') === ID.ada);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Agreements/ })).toBeVisible();
  // The strip shows every tab as its icon, and never scrolls the page sideways.
  await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'Board' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('on a phone the drawer carries New, and its dialog opens over the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Open menu' }).click();
  // Found by its heading: once a dialog opened from it has closed, Radix leaves the drawer
  // without its accessible name, so a name match would call an open drawer hidden.
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Menu', exact: true }) });
  await drawer.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Work item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add work item' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill('From the phone');
  await expect(dialog.getByLabel('Title')).toHaveValue('From the phone');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A dialog that moves on to a screen (Request's Next) lands with the drawer closed.
  await drawer.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Request' }).click();
  const request = page.getByRole('dialog', { name: 'New request' });
  await request.getByRole('button', { name: /Contact/ }).click();
  await page.getByRole('option', { name: /Grace Hopper/ }).click();
  await request.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(`/requests/new?contact=${ID.grace}`);
  await expect(drawer).toBeHidden();

  // An entry that goes to a screen closes the drawer on the way.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await drawer.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Contact' }).click();
  await expect(page).toHaveURL(/\/contacts\/new$/);
  await expect(drawer).toBeHidden();
});
