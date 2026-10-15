// The owner's e-signature settings (app_settings key 'esign', edited on the settings
// page) and the organization's public contact address.
//
//   { "filing_folder": "Signed documents", "sms_enabled": true }
//
// filing_folder is where finalize files the executed copy in each signer's documents:
// one folder name, or a path of names separated by '/'. Anything the documents folder
// rules would refuse falls back to the default rather than failing an envelope everyone
// has signed.

import { maybeOne, type EsignDb } from './db.ts';

export const DEFAULT_FILING_FOLDER = 'Signed documents';

export interface EsignSettings {
  /** The folder chain, outermost first. */
  filingFolder: string[];
  smsEnabled: boolean;
}

/** One folder name as 0003's client_folders.name CHECK takes it. */
const FOLDER_NAME = /^[^/\\\p{Cc}\p{Cf}]{1,100}$/u;

/** The folder chain a setting names, or null when any part breaks the folder rules. */
export function parseFilingFolder(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 5) return null;
  for (const p of parts) {
    if (!FOLDER_NAME.test(p) || p === '.' || p === '..') return null;
  }
  // folder_path is '/' + parts joined + '/', at most 200 characters.
  if (parts.join('/').length + 2 > 200) return null;
  return parts;
}

export async function loadEsignSettings(db: EsignDb): Promise<EsignSettings> {
  const row = await maybeOne<{ value: Record<string, unknown> | null }>(
    'esign settings read',
    db.from('app_settings').select('value').eq('key', 'esign').maybeSingle(),
  );
  const value = row?.value ?? {};
  return {
    filingFolder: parseFilingFolder(value.filing_folder) ?? [DEFAULT_FILING_FOLDER],
    smsEnabled: value.sms_enabled !== false,
  };
}

/**
 * Whether a signer can be sent a code: the owner has not switched SMS off, and a text
 * can actually leave (Twilio is set up) or this is not production, where outbound writes
 * the code to dev_outbox for the owner to read.
 */
export function smsAvailable(settings: EsignSettings, env: { production: boolean; twilioConfigured: boolean }): boolean {
  return settings.smsEnabled && (env.twilioConfigured || !env.production);
}

/** org_profile.contact_email: the address signers are told to write to, or null. */
export async function loadOrgContactEmail(db: EsignDb): Promise<string | null> {
  const row = await maybeOne<{ contact_email: string | null }>(
    'org contact email read',
    db.from('org_profile').select('contact_email').maybeSingle(),
  );
  return row?.contact_email ?? null;
}

/** The PDF's organization name: the registered name when there is one. */
export function pdfOrgName(org: { legalName: string | null; displayName: string }): string {
  return org.legalName ?? org.displayName;
}
