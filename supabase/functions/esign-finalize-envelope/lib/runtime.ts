// What every e-signature index.ts wires, built once from the environment getter and the
// createClient it imports. Free of the Deno global, so the wiring is plain TypeScript
// like the handlers; index.ts passes `(name) => Deno.env.get(name)`.

import { createAudit, type AuditEntry } from '../../_shared/audit.ts';
import { authorizeClient, authorizeOwner, supabaseClients, type EdgeClientOptions } from '../../_shared/auth.ts';
import { loadConfig } from '../../_shared/config.ts';
import { createOrgLoader } from '../../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../../_shared/outbound.ts';
import { loadOwnerEmail, type OwnerClient } from '../../_shared/owner.ts';
import type { EsignDb } from './db.ts';
import { createFinalizeTrigger } from './signer-access.ts';
import { supabaseEsignStorage, type StorageClient } from './storage.ts';
import { createLogger } from '../../_shared/log.ts';

// deno-lint-ignore no-explicit-any
type AnyClient = any;

export function esignRuntime(
  get: (name: string) => string | undefined,
  createClient: (url: string, key: string, options: EdgeClientOptions) => AnyClient,
) {
  const config = loadConfig(get);
  const clients = supabaseClients(createClient, config);
  const service = clients.service;
  const outboundEnv = readOutboundEnv(get);
  const outbound = createOutbound({ env: outboundEnv, db: service });
  const org = createOrgLoader({ db: service, supabaseUrl: config.supabaseUrl });
  const auditLog = createAudit({ db: service });
  const log = createLogger('esign-runtime');
  return {
    config,
    db: service as EsignDb,
    storage: supabaseEsignStorage(service as StorageClient),
    authorizeOwner: (token: string) => authorizeOwner(clients, token),
    authorizeClient: (token: string) => authorizeClient(clients, token),
    loadOrg: () => org.load(),
    sendEmail: outbound.sendEmail,
    sendSms: outbound.sendSms,
    audit: (entry: AuditEntry) => auditLog.write(entry),
    ownerEmail: () => loadOwnerEmail(service as OwnerClient),
    /** Production with no Twilio: a code cannot leave, so SMS is not offered. */
    smsEnv: {
      production: outboundEnv.production,
      twilioConfigured: !!(outboundEnv.twilioAccountSid && outboundEnv.twilioAuthToken && outboundEnv.twilioFrom),
    },
    piiKey: get('PII_ENCRYPTION_KEY') ?? null,
    smsCodeKey: get('ESIGN_SMS_CODE_KEY') ?? null,
    internalToken: get('ESIGN_INTERNAL_TOKEN') ?? null,
    cronSecret: get('CRON_SHARED_SECRET') ?? null,
    webhookSecret: get('RESEND_WEBHOOK_SECRET') ?? null,
    /** The getUserById the portal signer token needs (the client principal has no email). */
    userEmail: async (userId: string): Promise<string | null> => {
      const { data, error } = await service.auth.admin.getUserById(userId);
      if (error) throw error;
      return (data?.user?.email as string | undefined) ?? null;
    },
    finalize: createFinalizeTrigger({
      fetch,
      supabaseUrl: config.supabaseUrl,
      internalToken: get('ESIGN_INTERNAL_TOKEN'),
      timeoutMs: 60_000,
      onError: (event, err) => log.error(event, err),
    }),
  };
}
