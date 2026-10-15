// Review tokens for the request tools' outward and destructive acts (send_request,
// remind_request, delete_request).
//
// An assistant holds a standing credential and no screen: nothing in a call evidences that
// anyone looked at what is about to be emailed to a client or deleted. A review token is
// an HMAC over the request's EXACT client-visible content, its recipient and each item's
// fulfilment, and only list_requests mints one. So an outward call is necessarily preceded
// by a read of that content, and the token stops matching the moment any of it changes.
// What a token proves: the caller read the content it acts on. What it cannot prove: that
// a person approved it (confirmed_with_user is the caller's word for that).
//
// Load-bearing, each one:
//   * The key is derived from a server secret the caller never holds (the service-role
//     key, passed in), with domain separation. A key the bearer could compute would let
//     it mint a token for any content and the check would prove nothing.
//   * Minter and verifier canonicalize ONE snapshot shape, read through one database
//     function (mcp_request_snapshot): two readers that computed fulfilment differently
//     would make every token fail to verify, with nothing to diagnose.
//   * The recipient is bound with the content. send-needs-list mails whatever address
//     the contact holds; a token over the text alone stayed valid after the address
//     changed, and the approved content went somewhere nobody read out.
//   * Fulfilment is bound because a reminder's one claim is "N items still open".
//   * Verification is not what makes the send safe on its own: work sits between it and
//     the publish. The publish compares the content version the token was verified over
//     (send-needs-list sendList), which closes that gap.
//
// Pure: Web Crypto only, the key injected, so vitest mints and verifies with a test key.
// Rotating the service-role key invalidates outstanding tokens; list_requests mints fresh
// ones.

import { MIN_SECRET_LENGTH, timingSafeEqual } from '../_shared/secrets.ts';

/** Exactly what mint emits: validated at every input boundary before any crypto runs. */
export const REVIEW_TOKEN_RE = /^[0-9a-f]{32}$/;

export interface ReviewRecipient {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface ReviewItem {
  sort_order: number;
  kind: string;
  label: string;
  description: string | null;
  required: boolean;
  sensitive: boolean;
  category: string;
  tag: string;
  fulfilled: boolean;
}

/** A list as mcp_request_snapshot returns it. */
export interface ReviewList {
  id: string;
  status: string;
  title: string;
  intro_message: string | null;
  include_contact_confirm: boolean;
  created_at: string;
  sent_at: string | null;
  content_version: number;
  items: ReviewItem[];
}

/**
 * Everything the client will see, and who will see it, as one string. Item rows are
 * serialized and then sorted as strings: sort_order alone is not a total order (two items
 * may share one), and two reads of identical data must canonicalize identically. The
 * address is trimmed and lowercased because a case change is the same mailbox and must
 * not invalidate a token for nothing.
 */
export function canonicalRequest(list: ReviewList, recipient: ReviewRecipient): string {
  const rows = list.items
    .map((it) =>
      JSON.stringify([
        Number(it.sort_order ?? 0),
        it.kind ?? '',
        it.label ?? '',
        it.description ?? null,
        it.required === true,
        it.sensitive === true,
        it.category ?? '',
        it.tag ?? '',
        it.fulfilled === true,
      ]),
    )
    .sort();
  return JSON.stringify([
    String(recipient.id ?? ''),
    String(recipient.email ?? '').trim().toLowerCase(),
    String(recipient.first_name ?? ''),
    String(recipient.last_name ?? ''),
    list.title ?? '',
    list.intro_message ?? null,
    list.include_contact_confirm === true,
    rows,
  ]);
}

export interface ReviewSigner {
  mint(listId: string, canonical: string): Promise<string>;
  verify(presented: string, listId: string, canonical: string): Promise<boolean>;
}

const DOMAIN = 'open-crm/request-review-token/v1';

/**
 * A minter and verifier over `secret`. A secret shorter than MIN_SECRET_LENGTH throws on
 * use, never quietly signs with a guessable key; the contact tools keep working.
 */
export function createReviewSigner(secret: string): ReviewSigner {
  const enc = new TextEncoder();
  let key: Promise<CryptoKey> | null = null;
  const signingKey = () =>
    (key ??= (async () => {
      if (secret.length < MIN_SECRET_LENGTH) throw new Error('review-token: signing secret unavailable');
      const root = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derived = await crypto.subtle.sign('HMAC', root, enc.encode(DOMAIN));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })());

  async function mint(listId: string, canonical: string): Promise<string> {
    const sig = await crypto.subtle.sign('HMAC', await signingKey(), enc.encode(`${listId}:${canonical}`));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }

  return {
    mint,
    async verify(presented, listId, canonical) {
      if (!REVIEW_TOKEN_RE.test(presented)) return false;
      return timingSafeEqual(presented, await mint(listId, canonical));
    },
  };
}
