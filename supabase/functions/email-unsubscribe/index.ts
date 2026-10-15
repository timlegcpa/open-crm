import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createUnsubscribeHandler, unsubscribeLimits, type ConfirmState, type LookupState } from './handler.ts';

// Deployed with verify_jwt = false: a mail provider's one-click POST carries no headers.
const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await server.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

Deno.serve(
  createUnsubscribeHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,

    // The two limit calls, wired in the handler module so the tests run the same wiring.
    ...unsubscribeLimits(server),

    lookup: (tokenHash) => rpc<LookupState>('email_unsubscribe_lookup', { p_token_hash: tokenHash }),
    confirm: (tokenHash) => rpc<ConfirmState>('email_unsubscribe_confirm', { p_token_hash: tokenHash }),
  }),
);
