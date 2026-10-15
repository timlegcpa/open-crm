/**
 * The rule for the owner's encryption password. Stricter than a sign-in password: it is
 * the only thing between a copy of the key row (the wrapped private key and its salt) and
 * every client message, and such a copy can be guessed against offline at leisure.
 */
export const MIN_ENCRYPTION_PASSWORD_LENGTH = 12;
const MAX_LENGTH = 128;

// ASCII punctuation, the same class Supabase Auth counts as a symbol.
const SYMBOL = /[!-/:-@[-`{-~]/;

export const ENCRYPTION_PASSWORD_HINT =
  `At least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters, with an uppercase letter, a lowercase letter, a number and a symbol.`;

/** The first rule the password breaks, as a sentence, or null when it passes. */
export function encryptionPasswordProblem(password: string): string | null {
  if (password.length < MIN_ENCRYPTION_PASSWORD_LENGTH) return `Use at least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return 'Use at most 128 characters.';
  if (!/[A-Z]/.test(password)) return 'Add an uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Add a lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Add a number.';
  if (!SYMBOL.test(password)) return 'Add a symbol.';
  return null;
}
