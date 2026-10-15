import type { FieldRow, PageRow, SignerRow, VerificationLevel } from '../contract';

/**
 * What the composer checks before it offers Send. It mirrors the send function's own
 * checks so the owner sees every problem at once; the server checks again and has the
 * last word.
 */

export interface Readiness<S extends SignerRow = SignerRow> {
  pagesOk: boolean;
  signersOk: boolean;
  fieldsOk: boolean;
  phonesOk: boolean;
  /** Signers with no required field. */
  missingFields: S[];
  /** High only: signers with no phone on file. */
  missingPhones: S[];
}

export function readiness<S extends SignerRow>(input: {
  pages: readonly PageRow[];
  signers: readonly S[];
  fields: readonly FieldRow[];
  verificationLevel: VerificationLevel;
}): Readiness<S> {
  const pagesOk = input.pages.some((p) => !p.deleted);
  const withRequired = new Set(input.fields.filter((f) => f.required).map((f) => f.signer_id));
  const missingFields = input.signers.filter((s) => !withRequired.has(s.id));
  const missingPhones = input.verificationLevel === 'high' ? input.signers.filter((s) => !s.phone_last_four) : [];
  const signersOk = input.signers.length > 0;
  return {
    pagesOk,
    signersOk,
    fieldsOk: signersOk && missingFields.length === 0,
    phonesOk: missingPhones.length === 0,
    missingFields,
    missingPhones,
  };
}

/** The gate for leaving each of the first three steps (documents, signers, fields). */
export function stepGates(r: Readiness): [boolean, boolean, boolean] {
  return [r.pagesOk, r.signersOk && r.phonesOk, r.fieldsOk];
}

/** Every problem, as sentences; empty when the envelope may be sent. */
export function sendProblems<S extends SignerRow>(r: Readiness<S>, nameOf: (s: S) => string): string[] {
  const out: string[] = [];
  if (!r.pagesOk) out.push('Add at least one page.');
  if (!r.signersOk) out.push('Add at least one signer.');
  for (const s of r.missingFields) out.push(`${nameOf(s)} has no field to sign.`);
  for (const s of r.missingPhones) out.push(`${nameOf(s)} has no phone, which High verification needs.`);
  return out;
}
