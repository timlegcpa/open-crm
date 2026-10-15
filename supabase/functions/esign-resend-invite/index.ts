import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createResendInviteHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createResendInviteHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    siteUrl: rt.config.siteUrl,
  }),
);
