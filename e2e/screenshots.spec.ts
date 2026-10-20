import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, ID, signIn, test } from './test';
import { samplePdf } from './mocks/scenario';

/**
 * The README's screenshots, from the same mock project the specs use. Tagged @screenshots:
 * `npm run test:e2e` leaves them out and `npm run screenshots` runs only them, rewriting
 * docs/screenshots/*.png at 1440x900.
 */

const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US' });

async function shoot(page: Page, name: string): Promise<void> {
  // No passing toasts in a README image; fonts settled so every run draws the same pixels.
  await page.addStyleTag({ content: '[data-sonner-toaster] { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled', caret: 'hide' });
}

test.describe('README screenshots', { tag: '@screenshots' }, () => {
  test.beforeEach(async ({ page }) => {
    // A fixed afternoon, so greetings, "days ago" and year-to-date figures never drift.
    await page.clock.setFixedTime(new Date('2026-10-15T14:00:00Z'));
  });

  test('owner dashboard', async ({ page, mock }) => {
    await signIn(page, mock, 'owner');
    await page.goto('/');
    await expect(page).toHaveURL('/contacts?tab=pipeline');
    await expect(page.getByRole('complementary', { name: 'Contact list' }).getByText('2 contacts')).toBeVisible();
    await shoot(page, 'owner-dashboard');
  });

  test('contact record', async ({ page, mock }) => {
    await signIn(page, mock, 'owner');
    await page.goto(`/contacts/${ID.ada}/requests`);
    await expect(page.getByRole('link', { name: /Onboarding documents/ })).toBeVisible();
    await shoot(page, 'contact-record');
  });

  test('board', async ({ page, mock }) => {
    await signIn(page, mock, 'owner');
    await page.goto('/board');
    await expect(page.getByText('4 cards on the board')).toBeVisible();
    await shoot(page, 'board');
  });

  test('request builder', async ({ page, mock }) => {
    await signIn(page, mock, 'owner');
    await page.goto(`/requests/new?contact=${ID.grace}`);
    await page.getByLabel('Title').fill('Welcome pack');
    await page.getByLabel('Message to the client (optional)').fill('Two quick things before we start. Thank you!');
    await page.getByRole('group', { name: 'Item 1' }).getByLabel('What you need').fill('Proof of address');
    await page.getByRole('button', { name: 'Add item' }).click();
    await page.getByRole('menuitem', { name: 'Answer a question' }).click();
    await page.getByRole('group', { name: 'Item 2' }).getByLabel('What you need').fill('Preferred contact hours');
    await page.getByRole('heading', { name: 'New request' }).first().click();
    await shoot(page, 'request-builder');
  });

  test('e-sign composer', async ({ page, mock }) => {
    await signIn(page, mock, 'owner');
    await page.goto(`/esign/new?contact=${ID.ada}`);
    await page.getByLabel('Title').fill('Statement of work');
    await page.getByRole('button', { name: 'Create envelope' }).click();
    await page.getByLabel('Choose PDFs').setInputFiles({ name: 'statement-of-work.pdf', mimeType: 'application/pdf', buffer: await samplePdf() });
    const next = page.getByRole('button', { name: 'Next' });
    await expect(next).toBeEnabled();
    await next.click();
    await page.getByRole('button', { name: /Add Ada Lovelace/ }).click();
    await expect(page.getByRole('list', { name: 'Signers' })).toContainText('ada@example.test');
    await next.click();
    // One step smaller, so the whole page fits the window.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Add signature' }).click();
    await expect(page.getByLabel('Drawing the page')).toHaveCount(0, { timeout: 20_000 });
    const surface = page.getByTestId('esign-field-surface');
    await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(400);
    const box = (await surface.boundingBox())!;
    // On the agreement's signature line.
    await surface.click({ position: { x: box.width * 0.27, y: box.height * 0.425 } });
    await expect(page.getByText(/Signature · Ada Lovelace/)).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot(page, 'esign-composer');
  });

  test('client portal home', async ({ page, mock }) => {
    await signIn(page, mock, 'client');
    await page.goto('/portal');
    await expect(page.getByText('Good afternoon, Ada.')).toBeVisible();
    await shoot(page, 'portal-home');
  });
});
