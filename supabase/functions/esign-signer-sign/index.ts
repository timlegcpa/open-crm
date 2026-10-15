import { createClient } from '@supabase/supabase-js';
import * as pdfLib from 'pdf-lib';
import { createPdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import { esignRuntime } from '../esign-finalize-envelope/lib/runtime.ts';
import { createSignerSignHandler } from './handler.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

Deno.serve(
  createSignerSignHandler({
    allowedOrigins: rt.config.allowedOrigins,
    db: rt.db,
    pdf: createPdfTools({ pdfLib }),
    finalize: rt.finalize,
  }),
);
