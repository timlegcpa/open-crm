import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createPortalSignerTokenHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createPortalSignerTokenHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeClient: rt.authorizeClient,
    db: rt.db,
    userEmail: rt.userEmail,
  }),
);
