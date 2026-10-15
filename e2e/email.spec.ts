import { expect, ID, signIn, test } from './test';

test('composing a group email: recipients, review and a server preview, never a send', async ({ page, mock }) => {
  mock.scenario.functions['crm-send-group-email'] = (req) => {
    const body = req.json as { mode?: string };
    if (body.mode !== 'preview') return { status: 500, json: { error: 'this spec never sends' } };
    return {
      json: {
        preview: true,
        html: '<p>Hello Ada,</p><p>Our autumn hours have changed.</p>',
        sample: { first_name: 'Ada', address: 'ada@example.test' },
        eligible: 1,
        skipped: 0,
        delivery: 'dev_outbox',
      },
    };
  };
  await signIn(page, mock, 'owner');
  await page.goto('/email');
  await expect(page.getByText('No group emails yet')).toBeVisible();
  await page.getByRole('link', { name: 'New group email' }).first().click();
  await expect(page).toHaveURL('/email/new');

  const review = page.getByRole('button', { name: /^Review \d+ recipients?$/ });
  await expect(review).toBeDisabled();
  await page.getByLabel('Subject').fill('Autumn hours');
  await page.getByLabel('Message').fill('Hello {{first_name}},\n\nOur autumn hours have changed.');

  await page.getByRole('button', { name: 'Add a recipient' }).click();
  await page.getByRole('option', { name: /Ada Lovelace/ }).click();
  await expect(page.getByText('Recipients (1)')).toBeVisible();
  await expect(review).toHaveText('Review 1 recipient');
  await review.click();

  await expect(page.getByText(/Sending\s+1\s+separate email as/)).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  const dialog = page.getByRole('dialog', { name: 'Email preview' });
  await expect(dialog).toContainText('As Ada will see it (ada@example.test).');
  await expect(dialog.frameLocator('iframe[title="Group email preview"]').getByText('Our autumn hours have changed.')).toBeVisible();

  // The preview went to the server WITHOUT an idempotency key, so it can never mail.
  const calls = mock.callsTo('functions', 'crm-send-group-email');
  expect(calls).toHaveLength(1);
  expect(calls[0].json).toEqual({
    mode: 'preview',
    subject: 'Autumn hours',
    body: 'Hello {{first_name}},\n\nOur autumn hours have changed.',
    contact_ids: [ID.ada],
  });
  expect(calls.some((c) => (c.json as { idempotency_key?: string }).idempotency_key)).toBe(false);
});
