import { expect, ID, OWNER, ORG_NAME, test } from './test';

test.describe('owner sign-in', () => {
  test('password, then the authenticator code, then the shell loads', async ({ page, mock }) => {
    await page.goto('/contacts');

    await expect(page.getByText(ORG_NAME)).toBeVisible();
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The account holds a verified authenticator, so the password alone is not enough.
    await expect(page.getByText('Authenticator code')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

    await page.getByLabel('Code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toHaveText('That code did not work. Try the current one.');

    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();

    // The rail holds the doors; the workspace's screens are the tabs across the top.
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    for (const item of ['Contacts', 'Documents', 'E-sign', 'Email', 'Settings']) {
      await expect(nav.getByRole('link', { name: item, exact: true })).toBeVisible();
    }
    const strip = page.getByRole('tablist', { name: 'Workspace' });
    for (const tab of ['Board', 'Pipeline', 'Marketing', 'Tiers', 'Table', 'Requests', 'Messages', 'E-sign']) {
      await expect(strip.getByRole('tab', { name: new RegExp(`^${tab}`) })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: `Signed in as ${OWNER.email}.` })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Contact list' }).getByRole('link', { name: /Lovelace, Ada/ })).toBeVisible();

    // The owner check asked the database, with the second-factor session.
    const ownerCheck = mock.callsTo('rpc', 'is_owner');
    expect(ownerCheck.length).toBeGreaterThan(0);
    expect(ownerCheck.every((c) => c.principal === 'owner')).toBe(true);
    // The completed sign-in is audited once the principal is known.
    await expect.poll(() => mock.table('audit_logs').map((r) => r.action)).toContain('owner_login');
    expect(mock.table('audit_logs')[0].user_id).toBe(ID.owner);
  });

  test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
    await page.goto('/contacts');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await expect(page.getByText('Authenticator code')).toHaveCount(0);
  });
});
