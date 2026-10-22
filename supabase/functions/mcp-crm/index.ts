import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { loadOwnerEmail } from '../_shared/owner.ts';
import { createNeedsSendStore } from '../send-needs-list/store.ts';
import { createMcpCrmHandler } from './handler.ts';
import { createPrivilegedOps } from './privileged.ts';
import { createRequestOutward } from './outward.ts';
import { createReviewSigner } from './review-token.ts';

const config = loadConfig((name) => Deno.env.get(name));
const { service } = supabaseClients(createClient, config);
const org = createOrgLoader({ db: service, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: service });

Deno.serve(
  createMcpCrmHandler({
    allowedOrigins: config.allowedOrigins,
    supabaseUrl: config.supabaseUrl,
    siteUrl: config.siteUrl,
    db: service,
    privileged: createPrivilegedOps({
      piiKey: Deno.env.get('PII_ENCRYPTION_KEY')?.trim() || null,
      documentKey: Deno.env.get('DOCUMENT_ENCRYPTION_KEY')?.trim() || null,
      async download(path) {
        const { data, error } = await service.storage.from('client-documents').download(path);
        if (error) throw error;
        return new Uint8Array(await data.arrayBuffer());
      },
    }),
    orgName: async () => (await org.load()).displayName,
    // The review-token key derives from the service-role key, which a connector never
    // holds, so a bearer cannot mint a token for content it did not read.
    review: createReviewSigner(config.serviceRoleKey),
    outward: createRequestOutward({
      store: createNeedsSendStore({ server: service, org, outbound }),
      siteUrl: config.siteUrl,
      ownerEmail: () => loadOwnerEmail(service),
    }),
  }),
);
