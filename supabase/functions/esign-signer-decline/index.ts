import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createSignerDeclineHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createSignerDeclineHandler({
    allowedOrigins: rt.config.allowedOrigins,
    db: rt.db,
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    ownerEmail: rt.ownerEmail,
    siteUrl: rt.config.siteUrl,
  }),
);
