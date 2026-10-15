import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createExpireEnvelopesHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createExpireEnvelopesHandler({
    allowedOrigins: rt.config.allowedOrigins,
    cronSecret: rt.cronSecret,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    storage: rt.storage,
    finalize: rt.finalize,
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    ownerEmail: rt.ownerEmail,
    siteUrl: rt.config.siteUrl,
  }),
);
