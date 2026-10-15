import { expect, ID, signIn, test } from './test';
import { CLIENT_MESSAGE, ENCRYPTION_PASSWORD, withMessages } from './mocks/messages';

test('the owner unlocks messages, reads a client message and replies', async ({ page, mock }) => {
  await withMessages(mock);
  await signIn(page, mock, 'owner');
  await page.goto('/messages');

  // Messages stay locked until the encryption password opens the key in this browser.
  const unlock = page.getByRole('form', { name: 'Unlock messages' });
  await expect(unlock).toBeVisible();
  await unlock.getByRole('textbox', { name: 'Encryption password' }).fill('not the password at all');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('That password did not unlock your messages. Try again.');
  await unlock.getByRole('textbox', { name: 'Encryption password' }).fill(ENCRYPTION_PASSWORD);
  await unlock.getByRole('button', { name: 'Unlock' }).click();

  const conversations = page.getByRole('list', { name: 'Conversations' });
  await expect(conversations).toBeVisible({ timeout: 20_000 });
  const ada = conversations.getByRole('link', { name: /Ada Lovelace/ });
  await expect(ada).toContainText('Encrypted message');
  await ada.click();

  await expect(page).toHaveURL(`/messages/${ID.ada}`);
  // The client's message is decrypted here, in the browser.
  const thread = page.getByRole('list', { name: 'Messages with Ada Lovelace' });
  await expect(thread).toContainText(CLIENT_MESSAGE);
  await expect(thread).toContainText('Could you send the signed agreement when you have a moment?');
  // Opening the conversation marks the client's message read.
  await expect.poll(() => mock.table('client_messages').find((m) => m.sender_role === 'client')!.read_at).not.toBeNull();

  const reply = page.getByLabel('Reply to Ada Lovelace');
  await reply.fill('Thank you, received.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(thread).toContainText('Thank you, received.');
  const sent = mock.callsTo('rest', 'client_messages').filter((c) => c.method === 'POST');
  expect(sent).toHaveLength(1);
  expect(sent[0].json).toMatchObject({ contact_id: ID.ada, sender_role: 'owner', body: 'Thank you, received.', is_encrypted: false });
});
