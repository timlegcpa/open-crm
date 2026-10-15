import { expect, signIn, test } from './test';

test('marketing: revenue from accepted quotes, lead sources, and the tabs', async ({ page, mock }) => {
  // The page counts "year to date" and "last 12 months" from today; pin today so the
  // fixture dates always fall in the same windows.
  await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'));
  await signIn(page, mock, 'owner');
  await page.goto('/marketing');

  await expect(page.getByRole('heading', { name: 'Marketing', level: 1 })).toBeVisible();
  // Ada's accepted monthly retainer is the monthly recurring revenue.
  const mrr = page.getByText('Monthly recurring').locator('..');
  await expect(mrr).toContainText('$1,200');
  await expect(page.getByText('Nothing to fix.')).toBeVisible();

  // Where this year's contacts came from: Ada by referral (won), Grace from the website.
  const sources = page.getByRole('region', { name: 'Where clients came from' });
  await expect(sources).toContainText(/Referral\s*1\s*1/);
  await expect(sources).toContainText(/Website\s*1\s*0/);

  for (const tab of ['Revenue', 'Sources', 'Monthly', 'Goals', 'Overview']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
});
