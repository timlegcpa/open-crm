/** The contact fields a search box matches. */
export interface SearchableContact {
  full_name: string;
  business_name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * THE contact search rule, shared by the contacts list and the contact picker so the two
 * always agree: a case-insensitive substring of the name, business, email or phone, or the
 * query's digits inside the phone's digits (so "5550100" finds "(555) 010-0"). An empty
 * query matches everyone.
 */
export function matchesContactSearch(contact: SearchableContact, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const text = [contact.full_name, contact.business_name, contact.email, contact.phone].filter(Boolean).join(' ').toLowerCase();
  if (text.includes(needle)) return true;
  const digits = needle.replace(/\D/g, '');
  return digits.length > 0 && (contact.phone ?? '').replace(/\D/g, '').includes(digits);
}
