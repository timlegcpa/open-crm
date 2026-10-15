import { createClient } from '@supabase/supabase-js';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { CRON_SECRET_HEADER } from '../_shared/secrets.ts';
import { createJobRunnerHandler, type ClaimedJob } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const cronSecret = Deno.env.get('CRON_SHARED_SECRET');

Deno.serve(
  createJobRunnerHandler({
    allowedOrigins: config.allowedOrigins,
    cronSecret,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async claim(limit, claimSeconds) {
      const { data, error } = await server.rpc('claim_next_jobs', { p_limit: limit, p_claim_seconds: claimSeconds });
      if (error) throw error;
      return (data as ClaimedJob[] | null) ?? [];
    },

    async complete(jobId, claimToken, result) {
      const { data, error } = await server.rpc('complete_job', {
        p_job_id: jobId,
        p_claim_token: claimToken,
        p_result: result,
      });
      if (error) throw error;
      return data === true;
    },

    async fail(jobId, claimToken, message) {
      const { data, error } = await server.rpc('fail_job', { p_job_id: jobId, p_claim_token: claimToken, p_error: message });
      if (error) throw error;
      return (data as { reason?: string } | null)?.reason !== 'claim_not_live';
    },

    // The callee authenticates the cron secret itself (verify_jwt off), so no bearer and
    // no Origin are sent.
    invoke: (name, body, signal) =>
      fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
        method: 'POST',
        headers: { [CRON_SECRET_HEADER]: cronSecret ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),

    async callSql(fn) {
      const { data, error } = await server.rpc(fn);
      if (error) throw error;
      return data;
    },
  }),
);
