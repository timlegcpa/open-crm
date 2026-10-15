import { createClient } from '@supabase/supabase-js';
import { authorizeClient, authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import { createBackupCodeHasher } from '../_shared/mfa-backup-code.ts';
import { createMfaBackupCodesHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const hashCode = createBackupCodeHasher(config.serviceRoleKey);

Deno.serve(
  createMfaBackupCodesHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    authorizeClient: (token) => authorizeClient(clients, token),

    async guardDenied(userId, aal, iat) {
      const { data, error } = await server.rpc('mfa_guard_denied', { p_user_id: userId, p_aal: aal, p_iat: iat });
      if (error) throw error;
      // Anything but a plain false denies.
      return data !== false;
    },

    userLimit: (action, userId, max) => checkUserLimit(server, { action, userId, max, windowMinutes: 60 }),

    async revoke(userId) {
      const { error } = await server.rpc('mfa_backup_codes_revoke', { p_user_id: userId });
      if (error) throw error;
    },

    async verifiedFactorIds(userId) {
      const { data, error } = await server.rpc('mfa_verified_factor_ids', { p_user_id: userId });
      if (error) throw error;
      return Array.isArray(data) ? (data as string[]) : [];
    },

    async nextGeneration() {
      const { data, error } = await server.rpc('mfa_backup_code_next_generation');
      if (error) throw error;
      const generation = Number(data);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation token is not a positive integer');
      return generation;
    },

    async replace(userId, hashes, batchId, generation) {
      const { data, error } = await server.rpc('mfa_backup_codes_replace', {
        p_user_id: userId,
        p_hashes: hashes,
        p_batch: batchId,
        p_generation: generation,
      });
      if (error) throw error;
      return Number(data);
    },

    hashCode,
  }),
);
