// Request and response handling shared by every edge function: the origin allowlist,
// CORS, security headers, generic JSON errors and a capped body read. Pure TypeScript
// over the web Request/Response types, so vitest runs it as-is.

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

/** Headers for a response to `req`. An origin not on the list gets no CORS grant. */
export function responseHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = req.headers.get('Origin');
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return headers;
}

export function json(req: Request, allowedOrigins: string[], status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(req, allowedOrigins) });
}

/**
 * A browser request from an origin that is not allowed is refused outright, not just
 * denied CORS: a page elsewhere must not be able to trigger the action blind.
 * Requests with no Origin (server to server, curl) are judged on their credentials.
 */
export function originRefused(req: Request, allowedOrigins: string[]): boolean {
  const origin = req.headers.get('Origin');
  return origin !== null && !allowedOrigins.includes(origin);
}

export class BodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? 'Request body too large' : 'Request body is not valid JSON');
  }
}

/**
 * Read a JSON body of at most `maxBytes`, counting the bytes as they stream in:
 * Content-Length is a claim, not a limit.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw new BodyError(413);
  if (!req.body) throw new BodyError(400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyError(413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BodyError(400);
  }
}

/** The bearer token from an Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
  return match ? match[1] : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
