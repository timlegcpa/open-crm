/**
 * The one strict reading of a typed money amount, for every money box (quotes and prices in
 * the CRM, goals and ad spend in Marketing).
 *
 * Rule: an optional `$`, then either plain digits or digits in comma groups of three, then
 * at most two decimals: `^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$`. Positive, unless the caller
 * allows zero. Nothing else is read as a number: '-50', '50k', '1,2,3', '1.234' and '.5'
 * are refused, and characters are never stripped to find a number inside a typo ("oops0"
 * must not become 0 and erase a price).
 */
const AMOUNT = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** The amount `text` spells, or null when it is not one (blank included). */
export function parseMoneyAmount(text: string, options: { allowZero?: boolean } = {}): number | null {
  const t = text.trim().replace(/^\$\s*/, '');
  if (!AMOUNT.test(t)) return null;
  const value = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  if (options.allowZero ? value < 0 : value <= 0) return null;
  return value;
}
