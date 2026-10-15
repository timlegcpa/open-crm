import { expect, ID, ORG_NAME, signIn, test } from './test';
import { REQUEST_ID } from './mocks/requests';
import { CLIENT_MESSAGE, withMessages } from './mocks/messages';
import type { CallContext, MockSupabase } from './mocks/supabase';

test.describe('client portal', () => {
  test('home: what is waiting on the client, their requests and documents', async ({ page, mock }) => {
    await signIn(page, mock, 'client');
    await page.goto('/portal');
    await expect(page.getByText(/^Good (morning|afternoon|evening), Ada\.$/)).toBeVisible();
    await expect(page.getByText('1 item needs you. Everything else is with us.')).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Sign: Service agreement');
    await expect(page.getByRole('main')).toContainText('Onboarding documents');
    await expect(page.getByRole('main')).toContainText('Service agreement.pdf');
    // A client never asks the owner check twice and never reads another contact's rows.
    expect(mock.callsTo('rpc', 'get_client_contact_id').every((c) => c.principal === 'client')).toBe(true);
    expect(mock.calls.filter((c) => c.kind === 'rest' && c.url.includes('contact_id=eq.') && !c.url.includes(ID.ada))).toEqual([]);
  });

  test('documents: what was shared with the client and what they uploaded', async ({ page, mock }) => {
    await signIn(page, mock, 'client');
    await page.goto('/portal/documents');
    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Shared with you')).toBeVisible();
    await expect(main.getByText('Agreements')).toBeVisible();
    await expect(main.getByText('Your uploads')).toBeVisible();
    await expect(main.getByText('Company registration')).toBeVisible();
  });

  test('messages: the client reads the conversation and sends only ciphertext', async ({ page, mock }) => {
    await withMessages(mock);
    await signIn(page, mock, 'client');
    await page.goto('/portal/messages');
    const thread = page.getByRole('list', { name: 'Your messages' });
    await expect(thread).toContainText('Could you send the signed agreement when you have a moment?');

    const plain = 'Is Thursday at ten good for the call?';
    await page.getByLabel(`New message to ${ORG_NAME}`).fill(plain);
    await page.getByRole('button', { name: 'Send securely' }).click();
    await expect(thread).toContainText(plain);

    const sent = mock.callsTo('rest', 'client_messages').filter((c) => c.method === 'POST');
    expect(sent).toHaveLength(1);
    const row = sent[0].json as Record<string, unknown>;
    expect(row).toMatchObject({ contact_id: ID.ada, sender_role: 'client', body: null, is_encrypted: true });
    expect(typeof row.encrypted_body).toBe('string');
    // Encrypted in the browser: the words never travel.
    expect(sent[0].body!.toString('utf8')).not.toContain(plain);
    expect(sent[0].body!.toString('utf8')).not.toContain(CLIENT_MESSAGE);
  });
});

/** The admin-impersonate function and the database's answer to is_view_as_client(). */
function viewAsClientBackend(mock: MockSupabase) {
  const sessions = mock.table('impersonation_sessions');
  mock.scenario.functions['admin-impersonate'] = (req, ctx) => {
    if (ctx.principal !== 'owner') return { status: 403, json: { error: 'forbidden' } };
    const id = ctx.newId();
    sessions.push({ id, contact_id: ID.ada, ended_at: null });
    const minted = mock.session('client', 'aal2');
    return {
      json: {
        session_id: id,
        access_token: minted.access_token,
        refresh_token: minted.refresh_token,
        contact_id: ID.ada,
        contact_name: 'Ada Lovelace',
        client_user_id: ID.clientUser,
      },
    };
  };
  mock.scenario.functions['admin-impersonate-end'] = (req) => {
    const row = sessions.find((s) => s.id === (req.json as { session_id: string }).session_id);
    if (row) row.ended_at = new Date().toISOString();
    return { json: { ok: true } };
  };
  mock.scenario.rpc.is_view_as_client = (_args: Record<string, unknown>, ctx: CallContext) =>
    ctx.principal === 'client' && sessions.some((s) => s.ended_at === null);
}

test('View as client: the owner sees the portal under a read-only banner, then exits', async ({ page, mock }) => {
  viewAsClientBackend(mock);
  await signIn(page, mock, 'owner');
  await page.goto(`/contacts/${ID.ada}/portal`);
  await page.getByRole('button', { name: 'View as client' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'View as client' }).click();

  const banner = page.getByRole('status').filter({ hasText: 'Read-only: nothing here changes their account.' });
  await expect(banner).toContainText('Viewing as Ada Lovelace. Read-only: nothing here changes their account.');
  await expect(page).toHaveURL(/\/portal/);
  await expect(page.getByText(/Good (morning|afternoon|evening), Ada\./)).toBeVisible();

  // A request in the view can be read but not answered or submitted.
  await page.goto(`/portal/requests/${REQUEST_ID}`);
  await expect(banner).toBeVisible();
  await expect(page.getByText('You are viewing as the client. Nothing here can be changed.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Which day of the month suits a check-in call?' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
  expect(mock.callsTo('functions', 'needs-save')).toEqual([]);

  await banner.getByRole('button', { name: 'Exit' }).click();
  await expect(page).toHaveURL(`/contacts/${ID.ada}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(mock.table('impersonation_sessions').every((s) => s.ended_at !== null)).toBe(true);
});
