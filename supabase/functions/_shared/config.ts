// One reader for the values every edge function needs. Pure TypeScript with the
// environment passed in, so vitest can exercise it; functions pass `Deno.env.get`.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are set by Supabase on
// every deployed function. The rest are the adopter's:
//   SITE_URL         where the app is served, e.g. https://crm.example.com
//   ALLOWED_ORIGINS  extra browser origins, comma-separated (optional)
//   ENVIRONMENT      'production' drops the localhost dev origins

export interface EdgeConfig {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  siteUrl: string | null;
  allowedOrigins: string[];
}

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function originOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function isLocal(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.');
}

export function loadConfig(get: (name: string) => string | undefined): EdgeConfig {
  const required = (name: string): string => {
    const value = get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const site = get('SITE_URL');
  const siteUrl = site ? originOf(site) : null;
  const extra = (get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .filter((v) => v.trim())
    .map(originOf)
    .filter((v): v is string => v !== null);
  const production = get('ENVIRONMENT') === 'production';
  const origins = [...(siteUrl ? [siteUrl] : []), ...extra, ...(production ? [] : DEV_ORIGINS)];
  return {
    supabaseUrl: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    siteUrl,
    // Production allows no local origin, however it was supplied.
    allowedOrigins: [...new Set(production ? origins.filter((o) => !isLocal(o)) : origins)],
  };
}
