/**
 * The options of the signer form's "Pick a contact" list: every contact's primary person
 * AND, where the contact records one, its spouse as a co-signer.
 *
 * A co-signer is not a contact row: contacts carry spouse_email, spouse_first_name,
 * spouse_last_name and spouse_phone, and a co-signer signer links back to the PRIMARY
 * contact rather than minting a duplicate row (signers are unique per envelope by email,
 * not by contact). A list of contact rows alone could never reach a co-signer.
 *
 * THE TRAP: exclusion is by EMAIL. A co-signer option carries its primary's contact id,
 * so "contact already on the envelope" cannot tell the two apart, and an id test fails in
 * both directions: it hides the co-signer once the primary is added, and (tested before
 * the address) hides the primary once the co-signer is added first. The id is only a
 * fallback, for a primary with no address at all.
 */
import { matchesContactSearch } from '@/lib/contactSearch';

export interface SignerPickerContact {
  id: string;
  full_name: string;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_email: string | null;
  spouse_phone: string | null;
}

export interface SignerPickerOption {
  /** React key: a co-signer shares its primary's contact id. */
  optionKey: string;
  kind: 'primary' | 'co_signer';
  /** The contact row the signer links to; for a co-signer, the PRIMARY's. */
  contactId: string;
  email: string;
  firstName: string;
  lastName: string;
  /** The person's own number as stored (the form still requires E.164). */
  phone: string | null;
  status: string | null;
  label: string;
  /** For a co-signer, whose record it lives on. */
  coSignerOf: string | null;
}

/** Clients first, then the open pipeline, then the cooler stages, then signer-only stubs. */
const STATUS_ORDER: Record<string, number> = {
  client: 0,
  one_time: 1,
  new_lead: 2,
  active_lead: 2,
  hot: 2,
  warm: 3,
  cold: 4,
  former_client: 4,
  esign_signer: 5,
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const sortKey = (c: SignerPickerContact) => (c.last_name || c.full_name || c.business_name || c.email || '').toLowerCase();

function displayName(c: SignerPickerContact): string {
  return c.full_name || c.business_name || 'Unnamed contact';
}

/**
 * Everyone who can still be added: lost contacts never, anyone whose address is already on
 * the envelope never.
 *
 * @param existingEmails     addresses already on the envelope, lowercased
 * @param existingContactIds contact ids already on the envelope (fallback only)
 */
export function buildSignerPickerOptions(
  contacts: SignerPickerContact[],
  existingEmails: ReadonlySet<string>,
  existingContactIds: ReadonlySet<string>,
): SignerPickerOption[] {
  const ordered = contacts
    .filter((c) => !!c.id && c.status !== 'lost')
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.status ?? ''] ?? 99;
      const sb = STATUS_ORDER[b.status ?? ''] ?? 99;
      if (sa !== sb) return sa - sb;
      return sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id);
    });

  const out: SignerPickerOption[] = [];
  for (const c of ordered) {
    const primaryEmail = norm(c.email);
    const primaryLabel = displayName(c);
    // Email first, the id only for a contact with no address: the order IS the rule.
    const primaryTaken = primaryEmail ? existingEmails.has(primaryEmail) : existingContactIds.has(c.id);
    if (!primaryTaken) {
      out.push({
        optionKey: `primary:${c.id}`,
        kind: 'primary',
        contactId: c.id,
        email: primaryEmail,
        firstName: c.first_name ?? '',
        lastName: c.last_name ?? '',
        phone: c.phone,
        status: c.status,
        label: primaryLabel,
        coSignerOf: null,
      });
    }

    // The co-signer is judged on its OWN address only, so it survives its primary being added.
    const spouseEmail = norm(c.spouse_email);
    if (!spouseEmail || existingEmails.has(spouseEmail)) continue;
    const first = (c.spouse_first_name ?? '').trim();
    const last = (c.spouse_last_name ?? '').trim();
    out.push({
      optionKey: `co_signer:${c.id}`,
      kind: 'co_signer',
      contactId: c.id,
      email: spouseEmail,
      firstName: first,
      lastName: last,
      // Never blank: an unnamed row with an add action beside it is worse than an address.
      label: `${first} ${last}`.trim() || spouseEmail,
      phone: c.spouse_phone,
      status: c.status,
      coSignerOf: primaryLabel,
    });
  }
  return out;
}

/** The contacts search rule, applied to an option (its own name and address, and whose record it is). */
export function optionMatches(option: SignerPickerOption, query: string): boolean {
  return matchesContactSearch(
    { full_name: option.label, business_name: option.coSignerOf, email: option.email, phone: option.phone },
    query,
  );
}

/** The next free position: max(order) + 1, never the count (after a removal the count is an order in use). */
export function nextSignerOrder(signers: readonly { order: number }[]): number {
  return signers.reduce((m, s) => Math.max(m, s.order), -1) + 1;
}
