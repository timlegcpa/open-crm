import { expect, OWNER, ORG_NAME, signIn, test } from './test';

test('every settings section opens from the section list', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto('/settings');
  const sections = page.getByRole('navigation', { name: 'Settings sections' });

  // The first section is the default: the organization's identity, read from org_profile.
  await expect(sections.getByRole('link', { name: 'Identity' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(ORG_NAME);

  const expected: [string, string, RegExp | string][] = [
    ['Lists', 'lists', 'Every contact sits in one stage.'],
    ['Lead intake', 'lead-intake', 'Let another system send leads straight in.'],
    ['Requests', 'requests', 'Send reminders automatically'],
    ['Security', 'security', `You sign in as ${OWNER.email}.`],
    ['AI connector', 'connector', 'Connector address'],
    ['Appearance', 'appearance', 'Remembered in this browser.'],
    ['Secure messages', 'messages', 'Secure messages are not set up yet.'],
    ['E-sign', 'esign', 'Filing folder'],
  ];
  for (const [label, key, text] of expected) {
    await sections.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(`/settings/${key}`);
    await expect(sections.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main').getByText(text).first()).toBeVisible();
  }
  // Two-factor reads as on for this account (it holds a verified authenticator).
  await page.goto('/settings/security');
  await expect(page.getByRole('button', { name: 'Turn off two-factor' })).toBeVisible();
});

test('an unknown section says so', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto('/settings/not-a-section');
  await expect(page.getByText('There is no settings section at this address.')).toBeVisible();
});
