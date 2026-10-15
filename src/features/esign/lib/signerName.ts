/**
 * Co-signer-aware signer names. The server's copy (_shared/esign-signer-name.ts) applies the
 * same rule; keep the two answers identical.
 *
 * A co-signer is not a contact row: it links to the PRIMARY's contact and is named by that
 * contact's spouse_* fields. A signer is a co-signer link when its role is 'co_signer' AND
 * the linked contact's spouse_email is the signer's own address.
 */

export interface SignerLike {
  email: string;
  role?: string | null;
  contact: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    spouse_first_name?: string | null;
    spouse_last_name?: string | null;
    spouse_email?: string | null;
  } | null;
}

/** THE co-signer rule, defined once: the list and the edit form must agree on who it is. */
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
 * First and last name separately, for a form. On a co-signer link the spouse_* names come
 * back RAW: a null stays null and never falls back to the primary's name, because the form
 * then writes the co-signer's row.
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
 * One display string, never empty. A display MAY fall back where a form must not: a
 * co-signer with no recorded name shows the primary's name, then an address, rather than
 * a blank row.
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
