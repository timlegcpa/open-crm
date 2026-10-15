import { createClient } from '@supabase/supabase-js';
import * as pdfLib from 'pdf-lib';
import { createPdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createSendEnvelopeHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createSendEnvelopeHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    storage: rt.storage,
    pdf: createPdfTools({ pdfLib }),
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    siteUrl: rt.config.siteUrl,
    smsEnv: rt.smsEnv,
  }),
);
