import { createHash } from 'node:crypto';
import { expect, expectPublicCallsOnly, test } from './test';
import { samplePdf } from './mocks/scenario';
import type { MockSupabase } from './mocks/supabase';

const TOKEN = 'signing-token-0123456789abcdef';
const ENVELOPE = '00000000-0000-4000-8000-000000000601';
const SIGNER = '00000000-0000-4000-8000-000000000611';

async function signerFunctions(mock: MockSupabase) {
  const pdf = await samplePdf();
  mock.scenario.functions['esign-resolve-token'] = () => ({
    json: {
      state: 'ok',
      envelope: { id: ENVELOPE, title: 'Service agreement', verification_level: 'standard', status: 'sent' },
      signer: { id: SIGNER, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', status: 'invited', signed_at: null, phone_last_four: null },
      document: { page_count: 1 },
      fields: [
        { id: '00000000-0000-4000-8000-000000000621', page_index: 0, field_type: 'signature', x: 72, y: 140, width: 200, height: 40 },
        { id: '00000000-0000-4000-8000-000000000622', page_index: 0, field_type: 'date', x: 320, y: 140, width: 120, height: 24 },
      ],
      needs_sms: false,
    },
  });
  mock.scenario.functions['esign-signer-view-pdf'] = () => ({ body: pdf, contentType: 'application/pdf' });
  mock.scenario.functions['esign-signer-sign'] = () => ({ json: { ok: true, finalized: true } });
}

test.describe('public signing page', () => {
  test('a signer opens the link, consents, adopts a typed signature and signs', async ({ page, mock }) => {
    await signerFunctions(mock);
    await page.goto(`/sign#token=${TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Hello Ada,' })).toBeVisible();
    // The token moved out of the address bar (it lives in the fragment only until read).
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Consent to sign electronically' })).toBeVisible();
    const agree = page.getByRole('button', { name: 'I agree, continue' });
    await expect(agree).toBeDisabled();
    await page.getByLabel('I have read the consent above and agree to it.').check();
    await agree.click();

    // The document is fetched only after consent, and the request says so.
    // pdf.js draws the page; on a loaded machine that can take a while.
    await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 20_000 });
    const view = mock.callsTo('functions', 'esign-signer-view-pdf');
    expect(view.length).toBeGreaterThan(0);
    expect(view[0].json).toMatchObject({ token: TOKEN, consent: true });

    await page.getByRole('button', { name: 'Adopt signature' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adopt your signature' });
    await expect(dialog.getByLabel('Full name')).toHaveValue('Ada Lovelace');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();

    const signButton = page.getByRole('button', { name: 'Sign', exact: true });
    await expect(signButton).toBeDisabled();
    await page.getByLabel(/signature is my legal signature/).check();
    await signButton.click();

    await expect(page.getByRole('heading', { name: 'You have signed' })).toBeVisible();
    const signCall = mock.callsTo('functions', 'esign-signer-sign');
    expect(signCall).toHaveLength(1);
    expect(signCall[0].json).toMatchObject({ token: TOKEN, kind: 'typed', signature_text: 'Ada Lovelace', consent: true });
    expectPublicCallsOnly(mock);
  });

  test('a link without a token says so and calls nothing', async ({ page, mock }) => {
    await page.goto('/sign');
    await expect(page.getByRole('heading', { name: 'Sign a document' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This signing link is incomplete' })).toBeVisible();
    expect(mock.callsTo('functions')).toEqual([]);
    expectPublicCallsOnly(mock);
  });
});

test.describe('public verification page', () => {
  test('hashes the file in the browser and sends only the digest', async ({ page, mock }) => {
    const pdf = await samplePdf();
    const digest = createHash('sha256').update(pdf).digest('hex');
    mock.scenario.functions['esign-verify-document'] = (req) => ({
      json: (req.json as { sha256?: string }).sha256 === digest
        ? { verified: true, title: 'Service agreement', completed_at: '2026-10-02T15:00:00Z', sha256: digest, signers: [{ name: 'Ada Lovelace', status: 'signed', signed_at: '2026-10-02T15:00:00Z' }] }
        : { verified: false, reason: '', sha256: (req.json as { sha256?: string }).sha256 ?? '' },
    });

    await page.goto('/esign/verify');
    await page.locator('#esign-verify-file').setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.getByRole('button', { name: 'Verify document' }).click();

    await expect(page.getByRole('status')).toContainText('Document verified');
    await expect(page.getByRole('status')).toContainText(digest);

    const calls = mock.callsTo('functions', 'esign-verify-document');
    expect(calls).toHaveLength(1);
    // The body is exactly the digest: no file bytes, no name, nothing else.
    expect(calls[0].json).toEqual({ sha256: digest });
    expect(calls[0].body!.length).toBeLessThan(200);
    expect(calls[0].body!.includes(Buffer.from('%PDF-'))).toBe(false);
    // Nothing else carried a body of the file's size anywhere.
    expect(mock.calls.every((c) => (c.body?.length ?? 0) < pdf.length)).toBe(true);
    expectPublicCallsOnly(mock);
  });

  test('a file that is not on record is reported as not verified', async ({ page, mock }) => {
    mock.scenario.functions['esign-verify-document'] = (req) => ({
      json: { verified: false, reason: '', sha256: (req.json as { sha256: string }).sha256 },
    });
    const altered = Buffer.concat([await samplePdf(), Buffer.from('\n% changed')]);
    await page.goto('/esign/verify');
    await page.locator('#esign-verify-file').setInputFiles({ name: 'changed.pdf', mimeType: 'application/pdf', buffer: altered });
    await page.getByRole('button', { name: 'Verify document' }).click();
    await expect(page.getByRole('status')).toContainText('Not verified');
  });
});
