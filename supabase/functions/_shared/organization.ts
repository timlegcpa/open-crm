// Who runs this deployment, as emails, PDF footers and resource names show it: one
// read of the org_profile row (0001_core.sql) through the service client, cached per
// isolate for a short while. Every name a recipient sees renders from here, so the
// subject line, the footer and the e-sign consent text cannot disagree.
//
// org_profile.brand is free-form jsonb. The one key read here is
// `primary_color` ('#rrggbb'), used for headings and buttons; anything else falls back
// to a neutral colour.

import { createLogger } from './log.ts';

const log = createLogger('organization');

export interface OrgIdentity {
  /** Short name: email headers, subjects, page titles. */
  displayName: string;
  /** Registered name for footers and legal copy; null when unset. */
  legalName: string | null;
  /** The name in the From and reply-to display: sender_name, else displayName. */
  senderName: string;
  /** Postal address for email footers and consent copy; may span lines. */
  postalAddress: string | null;
  /** An absolute https URL for the logo, or null. */
  logoUrl: string | null;
  /** '#rrggbb' from brand.primary_color, or null. */
  brandColor: string | null;
}

/** The slice of a Supabase client this module calls. supabase-js clients satisfy it. */
export interface OrgClient {
  from(table: string): {
    select(columns: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
}

const COLUMNS = 'display_name, legal_name, sender_name, postal_address, logo_path, brand';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const STORAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)+$/;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * logo_path is either an absolute https URL or a public Storage object path
 * (`<bucket>/<path>`), which becomes `<SUPABASE_URL>/storage/v1/object/public/<path>`.
 * Anything else is ignored rather than put into an email.
 */
function logoUrl(path: string | null, supabaseUrl: string): string | null {
  if (!path) return null;
  if (path.startsWith('https://')) {
    try {
      return new URL(path).href;
    } catch {
      return null;
    }
  }
  if (!STORAGE_PATH.test(path) || path.split('/').some((p) => p === '..' || p === '.')) return null;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${path}`;
}

/** The identity from one org_profile row. Throws when the row has no display name. */
export function orgIdentityFromRow(row: unknown, supabaseUrl: string): OrgIdentity {
  const r = (row ?? {}) as Record<string, unknown>;
  const displayName = text(r.display_name);
  if (!displayName) throw new Error('org_profile has no row yet; run npm run dev:bootstrap');
  const brand = r.brand && typeof r.brand === 'object' ? (r.brand as Record<string, unknown>) : {};
  const color = typeof brand.primary_color === 'string' && HEX_COLOR.test(brand.primary_color) ? brand.primary_color : null;
  return {
    displayName,
    legalName: text(r.legal_name),
    senderName: text(r.sender_name) ?? displayName,
    postalAddress: text(r.postal_address),
    logoUrl: logoUrl(text(r.logo_path), supabaseUrl),
    brandColor: color,
  };
}

/**
 * A loader for one isolate. Create it once at module scope in index.ts. A fresh value
 * lasts `ttlMs` (default one minute); when a refresh fails, the last good value is
 * served rather than failing the send that asked, and only a first load can throw.
 */
export function createOrgLoader(deps: {
  db: OrgClient;
  supabaseUrl: string;
  ttlMs?: number;
  now?: () => number;
}): { load(): Promise<OrgIdentity> } {
  const ttl = deps.ttlMs ?? 60_000;
  const now = deps.now ?? (() => Date.now());
  let cached: { value: OrgIdentity; at: number } | null = null;
  let inflight: Promise<OrgIdentity> | null = null;

  async function fetchIdentity(): Promise<OrgIdentity> {
    const { data, error } = await deps.db.from('org_profile').select(COLUMNS).maybeSingle();
    if (error) throw error;
    const value = orgIdentityFromRow(data, deps.supabaseUrl);
    cached = { value, at: now() };
    return value;
  }

  return {
    load(): Promise<OrgIdentity> {
      if (cached && now() - cached.at < ttl) return Promise.resolve(cached.value);
      if (!inflight) {
        const stale = cached;
        inflight = fetchIdentity()
          .catch((err: unknown) => {
            if (!stale) throw err;
            log.error('org_profile refresh failed; serving the cached identity', err);
            return stale.value;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}
