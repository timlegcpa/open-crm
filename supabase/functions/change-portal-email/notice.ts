// The notice a client's OLD sign-in address gets after the owner moves their sign-in: a
// change made to an account should reach the person who held it, so a change they did not
// ask for is noticed. It never names the new address: the old inbox may no longer be theirs.
// Plain TypeScript, no Deno global.

import type { EmailContent } from '../_shared/email-layout.ts';
import type { OrgIdentity } from '../_shared/organization.ts';

export function signInChangedSubject(org: OrgIdentity): string {
  return `Your ${org.displayName} portal sign-in email was changed`;
}

export function signInChangedContent(org: OrgIdentity): EmailContent {
  return {
    preheader: `The email you sign in to the ${org.displayName} client portal with was changed.`,
    blocks: [
      { kind: 'heading', text: 'Your sign-in email was changed' },
      {
        kind: 'paragraph',
        text: `${org.displayName} changed the email address you use to sign in to your client portal. This address no longer signs in; use the new one from now on.`,
      },
      { kind: 'note', text: 'If you did not ask for this change, reply to this email right away.' },
    ],
  };
}
