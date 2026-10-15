// THE group email, rendered. One definition, because the preview returns exactly this:
// a preview drawn by a second copy of the markup agrees on the day it is written and
// drifts on the first footer edit, and a preview that disagrees with the delivery is
// worse than none. The one difference a preview cannot reproduce is the `?t=` token in
// the unsubscribe link, minted per recipient when the send runs.
//
// The body is plain text from the composer and is never passed through as HTML: the
// shared layout escapes every string, and a blank line starts a new paragraph. The
// unsubscribe link is added here, server-side, so it cannot be edited out of a body.

import { renderEmail, type RenderedEmail } from '../_shared/email-layout.ts';
import type { OrgIdentity } from '../_shared/organization.ts';

const FIRST_NAME = /\{\{\s*first_name\s*\}\}/g;

/**
 * `{{first_name}}` (spaced or not) becomes the recipient's first name, or "there". A
 * replacement FUNCTION, not a string: `$&`, `$1` and `$$` are substitution patterns to
 * String.replace, so a contact named `$&` would be mailed the placeholder instead.
 */
export function mergeFirstName(text: string, firstName: string): string {
  const name = firstName.trim() || 'there';
  return text.replace(FIRST_NAME, () => name);
}

export function renderGroupEmail(org: OrgIdentity, body: string, firstName: string, unsubscribeUrl: string): RenderedEmail {
  const paragraphs = mergeFirstName(body, firstName)
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return renderEmail(org, {
    blocks: [
      ...paragraphs.map((text) => ({ kind: 'paragraph' as const, text })),
      { kind: 'note', text: `You are receiving this because you are in ${org.displayName}'s contacts.` },
    ],
    unsubscribeUrl,
  });
}
