import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createSignerViewPdfHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createSignerViewPdfHandler({
    allowedOrigins: rt.config.allowedOrigins,
    db: rt.db,
    storage: rt.storage,
  }),
);
