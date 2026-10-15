import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createResendWebhookHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createResendWebhookHandler({
    allowedOrigins: rt.config.allowedOrigins,
    db: rt.db,
    webhookSecret: rt.webhookSecret,
  }),
);
