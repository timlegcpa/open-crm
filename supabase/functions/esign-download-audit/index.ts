import { createClient } from '@supabase/supabase-js';
import * as pdfLib from 'pdf-lib';
import { createPdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createDownloadAuditHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createDownloadAuditHandler({
    allowedOrigins: rt.config.allowedOrigins,
    authorizeOwner: rt.authorizeOwner,
    db: rt.db,
    pdf: createPdfTools({ pdfLib }),
    loadOrg: rt.loadOrg,
    siteUrl: rt.config.siteUrl,
  }),
);
