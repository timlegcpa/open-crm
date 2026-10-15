import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { checkPublicLimits } from '../_shared/rate-limit.ts';
import { createCspReportHandler, CSP_LIMITS } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;

Deno.serve(
  createCspReportHandler({
    allowedOrigins: config.allowedOrigins,
    limits: (ip, userAgent) => checkPublicLimits(server, { ...CSP_LIMITS, ip, userAgent }),
    // supabase-js returns { error } rather than throwing; the handler reads it.
    insert: async (rows) => await server.from('csp_violation_reports').insert(rows),
  }),
);
