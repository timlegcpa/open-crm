// Small shared rules: signing-link tokens, the stored PDF's file name, text cleaning.

import { randomTokenBase64Url, sha256Hex } from '../../_shared/crypto.ts';

/** A signing link lives this long from send (and from each resend). */
export const SIGNING_LINK_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Plaintext link token shape: 32 random bytes as base64url is 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** True when `value` looks like a link or session token; anything else is refused unhashed. */
export function isTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** A fresh link (or session) token and the SHA-256 the database stores in its place. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const token = randomTokenBase64Url();
  return { token, hash: await sha256Hex(token) };
}

/** The signer's link. The token rides in the fragment, so it never reaches a server log. */
export function signingUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/sign#token=${token}`;
}

/**
 * The file name the executed PDF is offered under. Strips only what a file system
 * cannot hold and caps at 200 characters: spaces, commas and non-ASCII survive, because
 * the title is what the signer recognises. (The doubled backslash in the class is
 * load-bearing: a single one would escape the colon after it.)
 */
export function esignSafeFilename(title: string): string {
  return title.replace(/[/\\:*?"<>|]+/g, '_').slice(0, 200);
}

/** True when the string holds a C0 or C1 control character. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Control characters out, then trimmed. */
export function stripControl(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out.trim();
}

/**
 * The charset both consent writers accept (view-pdf records consent first and sign keeps
 * it): the version is drawn on the audit page in a WinAnsi font, so a looser check in
 * either place would let one signer strand the envelope at finalize.
 */
export const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

/** A consent version as recorded, or null when absent or outside the charset. */
export function consentVersionOf(value: unknown): string | null {
  return typeof value === 'string' && CONSENT_VERSION_PATTERN.test(value) ? value : null;
}
