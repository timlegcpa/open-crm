import { EdgeError, assertFunctionName, edgeErrorFromResponse, parseAnswer, UNREADABLE_ANSWER } from '@/lib/edgeCore';

export { EdgeError, EDGE_ERROR_MESSAGES, isEdgeError, type EdgeErrorKind } from '@/lib/edgeCore';

/**
 * Calling an edge function from a PUBLIC page: the signer flow, document verification,
 * unsubscribe, start links, invitations, password reset. Those pages render with no session
 * and must not load supabase-js or the auth provider (`publicRoutes.test.tsx` fails the
 * build if one does), so this is a plain `fetch` with the project's anon key.
 *
 * The capability on these pages is whatever token the link carried, passed in the body or
 * query. No cookies are sent and no Referer leaves the page (the page URL holds the token).
 * Errors are the same `EdgeError` the signed-in helper throws.
 */

/**
 * The project's URL (no trailing slash) and its public anon key, or null on a build with
 * no Supabase project configured. The one place a public page reads them: a page that must
 * call Supabase Auth's REST API itself (password recovery) takes them from here, never from
 * `import.meta.env` directly.
 */
export function publicProjectConfig(): { url: string; anonKey: string } | null {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
  return url && anonKey ? { url: url.replace(/\/+$/, ''), anonKey } : null;
}

const projectConfig = publicProjectConfig;

const NOT_CONNECTED = 'This app is not connected to its server yet.';

export type PublicQuery = Record<string, string | number | boolean | null | undefined>;

export interface PublicFetchOptions {
  method?: 'GET' | 'POST';
  /** JSON-serialised unless it is FormData or a Blob. */
  body?: unknown;
  /** Appended to the URL; null and undefined values are left out. */
  query?: PublicQuery;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** The function's URL. Throws an EdgeError when the build has no Supabase project configured. */
export function publicFunctionUrl(name: string, query?: PublicQuery): string {
  assertFunctionName(name);
  const config = projectConfig();
  if (!config) throw new EdgeError('network', { message: NOT_CONNECTED });
  const url = new URL(`${config.url}/functions/v1/${name}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * The raw Response, whatever its status, for callers that need a binary body or must read a
 * specific status themselves (a 401 that means "verify again"). Throws an EdgeError only
 * when no answer arrived at all.
 */
export async function publicEdgeFetch(name: string, options: PublicFetchOptions = {}): Promise<Response> {
  const url = publicFunctionUrl(name, options.query);
  const { anonKey } = projectConfig()!;
  const headers: Record<string, string> = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    Accept: 'application/json',
    ...options.headers,
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData || options.body instanceof Blob) {
      body = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }
  try {
    return await fetch(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: options.signal,
    });
  } catch {
    throw new EdgeError(options.signal?.aborted ? 'aborted' : 'network');
  }
}

export interface PublicInvokeOptions<T> extends Omit<PublicFetchOptions, 'body'> {
  /** Validates the success body, e.g. a Zod schema's `parse`. A throw becomes an EdgeError. */
  parse?: (data: unknown) => T;
}

/** Call a public function and resolve to its JSON answer; any failure is an EdgeError. */
export async function invokePublicEdge<T = unknown>(
  name: string,
  body?: unknown,
  options: PublicInvokeOptions<T> = {},
): Promise<T> {
  const { parse, ...fetchOptions } = options;
  const res = await publicEdgeFetch(name, { method: 'POST', ...fetchOptions, body });
  if (!res.ok) throw await edgeErrorFromResponse(res);
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new EdgeError('server', { status: res.status, message: UNREADABLE_ANSWER });
  }
  return parseAnswer(data, parse);
}

export interface PublicBranding {
  displayName: string | null;
  logoPath: string | null;
  /** The registered name, when the owner set one (consent copy names the party with it). */
  legalName: string | null;
  /** The public address people may write to (org_profile.contact_email), never the owner's login. */
  contactEmail: string | null;
}

export const NO_BRANDING: Readonly<PublicBranding> = Object.freeze({ displayName: null, logoPath: null, legalName: null, contactEmail: null });

/**
 * The organization's public identity for a page with no session (its display and legal
 * names, logo path and contact address), read through the anon-callable
 * `get_org_branding()` RPC. Decoration only: any failure resolves to nulls.
 */
export async function fetchPublicBranding(signal?: AbortSignal): Promise<PublicBranding> {
  const empty: PublicBranding = { ...NO_BRANDING };
  const config = projectConfig();
  if (!config) return empty;
  try {
    const res = await fetch(`${config.url}/rest/v1/rpc/get_org_branding`, {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as { display_name?: unknown; logo_path?: unknown; legal_name?: unknown; contact_email?: unknown } | null;
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      displayName: text(data?.display_name),
      logoPath: text(data?.logo_path),
      legalName: text(data?.legal_name),
      contactEmail: text(data?.contact_email),
    };
  } catch {
    return empty;
  }
}
