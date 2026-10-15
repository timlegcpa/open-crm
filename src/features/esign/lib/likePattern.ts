/**
 * An address as a literal ILIKE pattern. `_` and `%` are LIKE wildcards and are legal in an
 * email's local part, so an unescaped `ada_l@example.com` also matches `adaXl@example.com`
 * and would link the signer to the wrong contact. The backslash is escaped first.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
