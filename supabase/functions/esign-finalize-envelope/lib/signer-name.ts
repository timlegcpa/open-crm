// Signer name resolution, co-signer aware.
//
// A signer row stores an email, never a name; the name comes from the linked contact.
// A co-signer is the second person on the PRIMARY contact's record (contacts.spouse_*):
// when the role is 'co_signer' AND that contact's spouse_email matches the signer's
// email, this signer is that second person, so the spouse_first_name /
// spouse_last_name fields are theirs.

export interface SignerContact {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  spouse_first_name?: string | null;
  spouse_last_name?: string | null;
  spouse_email?: string | null;
}

export interface SignerLike {
  email: string;
  role?: string | null;
  contact: SignerContact | null;
}

/** The contact columns every name lookup selects. */
export const SIGNER_CONTACT_COLUMNS = 'id, first_name, last_name, email, spouse_first_name, spouse_last_name, spouse_email';

/** THE co-signer rule, defined once; both exports read it. */
function isCoSignerLink(signer: SignerLike): boolean {
  const c = signer.contact;
  return (
    !!c &&
    signer.role === 'co_signer' &&
    !!c.spouse_email &&
    c.spouse_email.trim().toLowerCase() === signer.email.trim().toLowerCase()
  );
}

/**
 * First and last name apart, for a form or a structured answer. On a co-signer link the
 * second person's fields come back RAW: a null stays null and never falls back to the
 * primary's name, because a form pre-filled that way would then write the primary's
 * name into the co-signer's fields.
 */
export function resolveSignerNameParts(signer: SignerLike): { first_name: string | null; last_name: string | null } {
  const c = signer.contact;
  if (!c) return { first_name: null, last_name: null };
  if (isCoSignerLink(signer)) {
    return { first_name: c.spouse_first_name ?? null, last_name: c.spouse_last_name ?? null };
  }
  return { first_name: c.first_name, last_name: c.last_name };
}

/**
 * One display string, never empty. Display may fall back where a form must not: a
 * co-signer link with no recorded name shows the contact's name or an address rather
 * than a blank line.
 */
export function resolveSignerName(signer: SignerLike): string {
  const c = signer.contact;
  if (!c) return signer.email;
  const parts = resolveSignerNameParts(signer);
  const full = `${parts.first_name ?? ''} ${parts.last_name ?? ''}`.trim();
  if (full) return full;
  const primary = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return primary || c.email || signer.email;
}
