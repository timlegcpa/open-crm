/**
 * The one set of password rules the browser checks before Auth does, for every form that
 * sets a password: the owner's change and reset (settings), and the client's invitation and
 * profile (portal). A person is told what is missing before they submit.
 *
 * Two twins hold it in place:
 * - supabase/config.toml (`minimum_password_length = 8`, `password_requirements =
 *   "lower_upper_letters_digits_symbols"`): settingsRules.test.ts reads that file and fails
 *   when the two drift.
 * - The server's copy in supabase/functions/_shared/portal-account.ts (the invitation's
 *   account creation): portal/__tests__/password.test.ts runs one table of inputs through
 *   both, so a form never accepts what the server refuses or refuses what it accepts.
 *
 * A third twin, scripts/lib/bootstrap-core.mjs (the owner's first password), is held to
 * the same accept-or-refuse answers by bootstrap.test.ts.
 *
 * At least 8 characters and at most 72 bytes of UTF-8, with a lowercase letter, an
 * uppercase letter, a digit and a symbol. 72 bytes because Auth hashes with bcrypt, which
 * reads only the first 72 bytes, and Auth refuses anything longer; an accented letter or
 * an emoji is two to four bytes, so the ceiling is in bytes, not characters.
 * Spaces and any printable Unicode are allowed (a passphrase, an accented letter); only a
 * control character (a tab, a line break, a NUL) is refused, since it cannot be typed back
 * reliably on every keyboard and form. The first rule broken is the one reported. The
 * symbol class is exactly ASCII punctuation, the set Auth counts: a space or an accented
 * letter is allowed but is not the symbol. Every password these rules accept passes Auth's
 * length and character rules: Auth counts the minimum in bytes too, and a UTF-8 string
 * has at least as many bytes as it has characters here.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt's limit, in UTF-8 bytes. Also a form's maxLength: a character is at least one byte. */
export const MAX_PASSWORD_BYTES = 72;

/** UTF-8 bytes, as Auth counts them. */
const byteLength = (password: string) => new TextEncoder().encode(password).length;

const CONTROL = /\p{Cc}/u;
const SYMBOL = /[!-/:-@[-`{-~]/;

/** The first rule the password breaks, as a sentence, or null when it meets them all. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (byteLength(password) > MAX_PASSWORD_BYTES) return `Use at most ${MAX_PASSWORD_BYTES} bytes; accented letters and emoji count as more than one.`;
  if (CONTROL.test(password)) return 'Remove tabs, line breaks and other control characters.';
  if (!/[a-z]/.test(password)) return 'Add a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Add an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Add a digit.';
  if (!SYMBOL.test(password)) return 'Add a symbol, such as ! or #.';
  return null;
}

/** The rules in one sentence, for a hint under a password field. */
export const PASSWORD_RULES_TEXT = `At least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes (accented letters and emoji count as more than one), including an uppercase letter, a lowercase letter, a digit and a symbol.`;

/** The rules as a checklist for a form, in the order they are checked. */
export const PASSWORD_RULES: ReadonlyArray<{ label: string; ok: (password: string) => boolean }> = [
  { label: `At least ${MIN_PASSWORD_LENGTH} characters, at most ${MAX_PASSWORD_BYTES} bytes`, ok: (p) => p.length >= MIN_PASSWORD_LENGTH && byteLength(p) <= MAX_PASSWORD_BYTES },
  { label: 'No tabs or line breaks', ok: (p) => p.length > 0 && !CONTROL.test(p) },
  { label: 'A lowercase letter', ok: (p) => /[a-z]/.test(p) },
  { label: 'An uppercase letter', ok: (p) => /[A-Z]/.test(p) },
  { label: 'A digit', ok: (p) => /[0-9]/.test(p) },
  { label: 'A symbol, such as ! or #', ok: (p) => SYMBOL.test(p) },
];
