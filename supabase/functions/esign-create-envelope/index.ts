import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createCreateEnvelopeHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createCreateEnvelopeHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    smsEnv: rt.smsEnv,
  }),
);
