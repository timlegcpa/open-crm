import { expect, ID, signIn, test } from './test';
import { samplePdf } from './mocks/scenario';

test('the owner composes an envelope step by step and sends it', async ({ page, mock }) => {
  await signIn(page, mock, 'owner');
  await page.goto(`/esign/new?contact=${ID.ada}`);

  await page.getByLabel('Title').fill('Statement of work');
  await page.getByRole('button', { name: 'Create envelope' }).click();
  await expect(page).toHaveURL(/\/esign\/[0-9a-f-]{36}$/);
  const envelopeId = new URL(page.url()).pathname.split('/').pop()!;
  expect(mock.callsTo('functions', 'esign-create-envelope')[0].json).toMatchObject({
    title: 'Statement of work',
    verification_level: 'standard',
    primary_contact_id: ID.ada,
  });

  // Step 1, documents: Next stays shut until a PDF is in.
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeDisabled();
  await page.getByLabel('Choose PDFs').setInputFiles({ name: 'statement-of-work.pdf', mimeType: 'application/pdf', buffer: await samplePdf() });
  await expect(page.getByText('statement-of-work.pdf').first()).toBeVisible();
  const upload = mock.callsTo('functions', 'esign-upload-document');
  expect(upload).toHaveLength(1);
  expect(upload[0].body!.toString('latin1')).toContain(`name="envelope_id"\r\n\r\n${envelopeId}`);
  await expect(next).toBeEnabled();
  await next.click();

  // Step 2, signers: the envelope's contact is offered in one click.
  await expect(page.getByText('Add at least one signer to send.')).toBeVisible();
  await page.getByRole('button', { name: /Add Ada Lovelace/ }).click();
  await expect(page.getByRole('list', { name: 'Signers' })).toContainText('ada@example.test');
  expect(mock.callsTo('functions', 'esign-manage-signers')[0].json).toMatchObject({
    envelope_id: envelopeId,
    action: 'add',
    signer: { email: 'ada@example.test', role: 'primary', contact_id: ID.ada },
  });
  await next.click();

  // Step 3, fields: place a signature on the page; leaving the step saves it.
  await expect(page.getByText(/Each signer needs a field/)).toBeVisible();
  await page.getByRole('button', { name: 'Add signature' }).click();
  // The page surface takes clicks once pdf.js has drawn the page (it is then page-sized).
  await expect(page.getByLabel('Drawing the page')).toHaveCount(0, { timeout: 20_000 });
  const surface = page.getByTestId('esign-field-surface');
  await expect.poll(async () => (await surface.boundingBox())?.width ?? 0).toBeGreaterThan(400);
  const box = (await surface.boundingBox())!;
  await surface.click({ position: { x: box.width * 0.3, y: box.height * 0.8 } });
  await expect(page.getByText(/Signature · Ada Lovelace/)).toBeVisible();
  await next.click();

  const fields = mock.callsTo('functions', 'esign-manage-fields');
  expect(fields.length).toBeGreaterThan(0);
  expect(fields.at(-1)!.json).toMatchObject({ envelope_id: envelopeId, action: 'set', fields: [expect.objectContaining({ field_type: 'signature', page_index: 0 })] });

  // Step 4, review and send.
  await expect(page.getByText('Review and send')).toBeVisible();
  await page.getByRole('button', { name: 'Send envelope' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sent to 1 signer.')).toBeVisible();
  expect(mock.callsTo('functions', 'esign-send-envelope').map((c) => c.json)).toEqual([{ envelope_id: envelopeId }]);
});
