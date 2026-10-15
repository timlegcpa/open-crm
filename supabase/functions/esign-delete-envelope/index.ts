import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createDeleteEnvelopeHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createDeleteEnvelopeHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    storage: rt.storage,
    audit: rt.audit,
  }),
);
