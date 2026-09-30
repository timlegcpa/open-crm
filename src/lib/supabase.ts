import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False on a clone that has not run `npm run dev:bootstrap` yet. */
export const supabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

/**
 * The one browser client. Created on first use rather than at import, because
 * createClient throws on an empty URL and the app must be able to render its
 * "run the bootstrap" message on an unconfigured clone.
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error('Supabase is not configured. Run `npm run dev:bootstrap`.');
  }
  client ??= createClient(url!, anonKey!);
  return client;
}
