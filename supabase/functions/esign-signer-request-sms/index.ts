import { createClient } from '@supabase/supabase-js';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createSignerRequestSmsHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createSignerRequestSmsHandler({
    allowedOrigins: rt.config.allowedOrigins,
    db: rt.db,
    loadOrg: rt.loadOrg,
    sendSms: rt.sendSms,
    piiKey: rt.piiKey,
    smsCodeKey: rt.smsCodeKey,
  }),
);
