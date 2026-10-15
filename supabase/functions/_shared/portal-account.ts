// What every portal-account writer agrees on: the ban that keeps a sign-in user from
// signing in, the invitation token's shape, and the password rule. Plain TypeScript, no
// Deno global, so vitest runs it as-is. Imported by the invite, accept and revoke
// functions. The token's hash and the random token itself come from crypto.ts.
//
// Ban protocol. A portal sign-in user is CREATED banned and un-banned only once its
// account row is provably linked to it; a deactivated account's user is banned again.
// Supabase Auth takes a duration: 876000 hours is a hundred years, and 'none' lifts it.

export const PORTAL_USER_BAN_DURATION = '876000h';
export const PORTAL_USER_BAN_LIFTED = 'none';

/** The shape a token from an invitation link must have before it is hashed and looked up. */
export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

/**
 * The password rule, server side. The browser twin is
 * src/lib/passwordRules.ts and a parity test holds them together. Matches
 * supabase/config.toml (minimum 8, lower, upper, digit and symbol): at least 8 characters
 * and at most 72 UTF-8 bytes (bcrypt reads no more, and Auth refuses longer),
 * one each of lowercase, uppercase, digit and ASCII punctuation. Spaces and printable
 * Unicode are allowed; only a control character is refused. Returns the first problem,
 * or null.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (new TextEncoder().encode(password).length > 72) return 'Use at most 72 bytes; accented letters and emoji count as more than one.';
  if (/\p{Cc}/u.test(password)) return 'Remove tabs, line breaks and other control characters.';
  if (!/[a-z]/.test(password)) return 'Add a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Add an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Add a digit.';
  if (!/[!-/:-@[-`{-~]/.test(password)) return 'Add a symbol, such as ! or #.';
  return null;
}
