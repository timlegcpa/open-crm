// The connector's browser calls: the owner's consent screen (through the mcp-oauth edge
// function) and the live connections in Settings (two owner-only database functions).
// Every answer is parsed with Zod before a screen sees it.
import { z } from 'zod';
import { invokeEdge } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';

export const mcpKeys = {
  all: ['mcp'] as const,
  grants: () => ['mcp', 'grants'] as const,
  request: (requestId: string) => ['mcp', 'request', requestId] as const,
};

/** The URL an assistant is given when the owner adds this CRM as a connector. */
export function connectorUrl(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  return `${base.replace(/\/+$/, '')}/functions/v1/mcp-crm`;
}

const isoDate = z.string().min(1);

export const grantSchema = z.object({
  id: z.string().uuid(),
  client_name: z.string().nullable(),
  created_at: isoDate,
  last_used_at: isoDate.nullable(),
  expires_at: isoDate,
});
export type Grant = z.infer<typeof grantSchema>;

/** Live connections, newest first. Few by nature (each is an approval), and the function returns them all. */
export async function listGrants(): Promise<Grant[]> {
  const { data, error } = await getSupabase().rpc('mcp_list_grants');
  if (error) throw error;
  return z.array(grantSchema).parse(data ?? []);
}

/** Disconnect one assistant now. False when it was already disconnected. */
export async function revokeGrant(grantId: string): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('mcp_revoke_grant', { p_grant_id: grantId });
  if (error) throw error;
  return z.boolean().parse(data);
}

/**
 * Where the browser may be sent after a decision: https, or plain http to this machine (a
 * desktop app's loopback callback). The server only ever answers an allowlisted callback;
 * this is the page refusing to assign anything else even if it were told to.
 */
export function safeRedirect(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

export const pendingRequestSchema = z.object({
  request_id: z.string(),
  client_name: z.string().nullable(),
  redirect_uri: z.string().refine(safeRedirect),
  scope: z.string(),
});
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

const decisionSchema = z.object({ redirect_to: z.string().refine(safeRedirect) });

/** What is being approved. A 404 means the request expired or was already decided. */
export function readRequest(requestId: string): Promise<PendingRequest> {
  return invokeEdge('mcp-oauth', { action: 'read', request_id: requestId }, { parse: (d) => pendingRequestSchema.parse(d) });
}

/** Approve or deny; answers where to send the browser (the assistant's callback). */
export async function decideRequest(requestId: string, approve: boolean): Promise<string> {
  const answer = await invokeEdge('mcp-oauth', { action: 'decide', request_id: requestId, approve }, { parse: (d) => decisionSchema.parse(d) });
  return answer.redirect_to;
}
