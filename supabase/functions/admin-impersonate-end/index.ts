import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createImpersonateEndHandler, type CredentialChanges, type SessionRow } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createImpersonateEndHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async loadSession(rowId) {
      const { data, error } = await server
        .from('impersonation_sessions')
        .select('id, owner_user_id, started_at, ended_at')
        .eq('id', rowId)
        .maybeSingle();
      if (error) throw error;
      return (data as SessionRow | null) ?? null;
    },

    async revoke(rowId) {
      const { data, error } = await server.rpc('revoke_impersonation_auth_session', { p_row: rowId });
      if (error) throw error;
      return data === true;
    },

    async end(rowId) {
      const { data, error } = await server
        .from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', rowId)
        .is('ended_at', null)
        .select('id');
      if (error) throw error;
      return (data ?? []).length === 1;
    },

    async credentialChanges(rowId) {
      const { data, error } = await server.rpc('impersonation_credential_changes', { p_row: rowId });
      if (error) throw error;
      return (data as CredentialChanges | null) ?? null;
    },

    async audit({ ownerId, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action: 'impersonate_end', details, ip, userAgent });
    },
  }),
);
