import fontkit from '@pdf-lib/fontkit';
import { createClient } from '@supabase/supabase-js';
import * as pdfLib from 'pdf-lib';
import { createFinalizeEnvelopeHandler } from './handler.ts';
import { createPdfTools, type SignerFontKey } from './lib/pdf.ts';
import { esignRuntime } from './lib/runtime.ts';
import { SIGNATURE_FONT_FILES } from './lib/typed-signature.ts';

const rt = esignRuntime((name) => Deno.env.get(name), createClient);

// The six signature fonts ship with the function (static_files in config.toml).
const fontBytes: Partial<Record<SignerFontKey, Uint8Array>> = {};
for (const [key, file] of Object.entries(SIGNATURE_FONT_FILES) as Array<[SignerFontKey, string]>) {
  fontBytes[key] = await Deno.readFile(new URL(`../_shared/esign-fonts/fonts/${file}`, import.meta.url));
}

Deno.serve(
  createFinalizeEnvelopeHandler({
    allowedOrigins: rt.config.allowedOrigins,
    internalToken: rt.internalToken,
    db: rt.db,
    storage: rt.storage,
    pdf: createPdfTools({ pdfLib, fontkit, fontBytes }),
    loadOrg: rt.loadOrg,
    sendEmail: rt.sendEmail,
    ownerEmail: rt.ownerEmail,
    siteUrl: rt.config.siteUrl,
  }),
);
