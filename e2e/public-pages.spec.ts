import { expect, expectPublicCallsOnly, test } from './test';
import { CLIENT } from './mocks/scenario';

const LINK_TOKEN = 'link-token-0123456789abcdefghijklmnopqrstuv';

test.describe('public pages make no session calls on load', () => {
  test('/start: a request start link', async ({ page, mock }) => {
    await page.goto(`/start#token=${LINK_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Set up your portal sign-in' })).toBeVisible();
    await expect(page.getByText('You have a request waiting.')).toBeVisible();
    // The token left the address bar at once.
    await expect(page).toHaveURL(/\/start$/);
    await expect.poll(() => mock.callsTo('rpc', 'get_org_branding').length).toBeGreaterThan(0);
    expectPublicCallsOnly(mock);
  });

  test('/unsubscribe: asks first, and only the button unsubscribes', async ({ page, mock }) => {
    mock.scenario.functions['email-unsubscribe'] = (req) => ({ json: { state: req.method === 'GET' ? 'confirm' : 'unsubscribed' } });
    await page.goto(`/unsubscribe?t=${LINK_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Unsubscribe from group emails?' })).toBeVisible();
    expect(mock.callsTo('functions', 'email-unsubscribe').map((c) => c.method)).toEqual(expect.arrayContaining(['GET']));
    expect(mock.callsTo('functions', 'email-unsubscribe').some((c) => c.method === 'POST')).toBe(false);
    expectPublicCallsOnly(mock);

    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();
    expect(mock.callsTo('functions', 'email-unsubscribe').some((c) => c.method === 'POST')).toBe(true);
    expectPublicCallsOnly(mock);
  });

  test('/invite: redeeming an invitation sets a password, then signs in to the portal', async ({ page, mock }) => {
    const password = 'Analytical-Engine-1843';
    mock.scenario.functions['validate-portal-invite'] = () => ({
      json: { valid: true, contact: { first_name: 'Ada', last_name: 'Lovelace', email: CLIENT.email } },
    });
    mock.scenario.functions['accept-portal-invite'] = (req) => {
      const body = req.json as { token: string; password: string };
      if (body.token !== LINK_TOKEN) return { status: 404, json: { error: 'not_found' } };
      mock.scenario.users.find((u) => u.id === CLIENT.id)!.password = body.password;
      return { json: { success: true, email: CLIENT.email } };
    };

    await page.goto(`/invite#token=${LINK_TOKEN}`);
    await expect(page.getByText('Welcome, Ada.')).toBeVisible();
    await expect(page).toHaveURL(/\/invite$/);
    // Up to here the page has only checked the link.
    expect(mock.callsTo('functions').map((c) => c.name)).toEqual(expect.arrayContaining(['validate-portal-invite']));
    expectPublicCallsOnly(mock);

    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Password again').fill(password);
    await page.getByRole('button', { name: 'Set up and sign in' }).click();

    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByText(/Good (morning|afternoon|evening), Ada\./)).toBeVisible();
    expect(mock.callsTo('functions', 'accept-portal-invite')[0].json).toEqual({ token: LINK_TOKEN, password });
    // Only now, with the account made, does the page sign in.
    expect(mock.callsTo('auth', 'token').length).toBe(1);
  });

  test('/invite: a used invitation says so', async ({ page, mock }) => {
    mock.scenario.functions['validate-portal-invite'] = () => ({ json: { valid: false, reason: 'used' } });
    await page.goto(`/invite#token=${LINK_TOKEN}`);
    await expect(page.getByRole('alert')).toHaveText('This invitation has already been used. Sign in with the password you chose.');
    expectPublicCallsOnly(mock);
  });
});
