import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createVoidEnvelopeHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createVoidEnvelopeHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    ownerEmail: rt.ownerEmail,
  }),
);
