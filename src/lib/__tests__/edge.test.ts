import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const supabase = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabaseConfigured: true,
  getSupabase: () => ({ functions: { invoke: supabase.invoke } }),
}));

import { EDGE_ERROR_MESSAGES, EdgeError, invokeEdge } from '@/lib/edge';
import { fetchPublicBranding, invokePublicEdge, publicEdgeFetch } from '@/lib/publicEdge';

/** What supabase-js returns as `error` for a non-2xx answer: the Response rides on `context`. */
const httpError = (status: number, body: string) => ({
  name: 'FunctionsHttpError',
  message: 'Edge Function returned a non-2xx status code',
  context: new Response(body, { status }),
});

async function failure(promise: Promise<unknown>): Promise<EdgeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EdgeError);
    return err as EdgeError;
  }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  supabase.invoke.mockReset();
});

describe('invokeEdge (signed in)', () => {
  it('posts the body with the session client and returns the answer', async () => {
    supabase.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(invokeEdge('send-message', { text: 'hi' })).resolves.toEqual({ ok: true });
    expect(supabase.invoke).toHaveBeenCalledWith('send-message', expect.objectContaining({ body: { text: 'hi' }, method: 'POST' }));
  });

  it('never shows what a 5xx said: a stack trace becomes the fixed server message', async () => {
    supabase.invoke.mockResolvedValue({
      data: null,
      error: httpError(500, JSON.stringify({ error: 'TypeError: cannot read properties of undefined (reading id) at handler.ts:42' })),
    });
    const err = await failure(invokeEdge('send-message'));
    expect(err.kind).toBe('server');
    expect(err.status).toBe(500);
    expect(err.message).toBe(EDGE_ERROR_MESSAGES.server);
  });

  it('shows a 4xx sentence written for people, and keeps a machine code for branching', async () => {
    supabase.invoke.mockResolvedValueOnce({ data: null, error: httpError(400, JSON.stringify({ error: 'Enter a valid email address.' })) });
    const sentence = await failure(invokeEdge('send-message'));
    expect(sentence).toMatchObject({ kind: 'invalid', status: 400, message: 'Enter a valid email address.' });

    supabase.invoke.mockResolvedValueOnce({ data: null, error: httpError(409, JSON.stringify({ error: 'delete_in_progress' })) });
    const coded = await failure(invokeEdge('delete-contact'));
    expect(coded).toMatchObject({ kind: 'conflict', code: 'delete_in_progress', message: EDGE_ERROR_MESSAGES.conflict });
  });

  it('replaces a 4xx error that is not a sentence (markup, internals) with the fixed message', async () => {
    supabase.invoke.mockResolvedValue({ data: null, error: httpError(403, JSON.stringify({ error: '<b>denied</b> by policy owner_only.' })) });
    const err = await failure(invokeEdge('send-message'));
    expect(err).toMatchObject({ kind: 'forbidden', message: EDGE_ERROR_MESSAGES.forbidden });
  });

  it('turns a gateway page or a dropped connection into its kind', async () => {
    supabase.invoke.mockResolvedValueOnce({ data: null, error: httpError(502, '<html>Bad gateway</html>') });
    expect((await failure(invokeEdge('send-message'))).kind).toBe('server');

    supabase.invoke.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await failure(invokeEdge('send-message'))).kind).toBe('network');

    const controller = new AbortController();
    controller.abort();
    supabase.invoke.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect((await failure(invokeEdge('send-message', undefined, { signal: controller.signal }))).kind).toBe('aborted');
  });

  it('turns an answer that fails validation into a server error, not a raw parse error', async () => {
    supabase.invoke.mockResolvedValue({ data: { unexpected: true }, error: null });
    const parse = (data: unknown) => {
      if (!(data as { ok?: unknown }).ok) throw new Error('ZodError: ok is required');
      return data;
    };
    const err = await failure(invokeEdge('send-message', undefined, { parse }));
    expect(err.kind).toBe('server');
    expect(err.message).not.toContain('ZodError');
  });

  it('refuses anything that is not a function name', async () => {
    await expect(invokeEdge('../rest/v1/contacts')).rejects.toThrow('Not an edge function name');
    expect(supabase.invoke).not.toHaveBeenCalled();
  });
});

describe('publicEdge (no session)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.example.test/');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts JSON to the function with the anon key, no cookies and no referrer', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(invokePublicEdge('esign-signer-view', { token: 't' })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/functions/v1/esign-signer-view');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', body: '{"token":"t"}' });
    expect(init?.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer anon-key', 'Content-Type': 'application/json' });
  });

  it('maps errors exactly as the signed-in helper does', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>stack trace</html>', { status: 500 }));
    expect(await failure(invokePublicEdge('unsubscribe', {}))).toMatchObject({ kind: 'server', message: EDGE_ERROR_MESSAGES.server });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This link has expired.' }), { status: 410 }));
    expect(await failure(invokePublicEdge('unsubscribe', {}))).toMatchObject({ kind: 'invalid', message: 'This link has expired.' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await failure(invokePublicEdge('unsubscribe', {}))).kind).toBe('network');
  });

  it('hands back the raw Response for a caller that reads it itself', async () => {
    fetchMock.mockResolvedValue(new Response('pdf-bytes', { status: 401 }));
    const res = await publicEdgeFetch('esign-document', { query: { token: 't', page: 2, skip: undefined } });
    expect(res.status).toBe(401);
    expect(fetchMock.mock.calls[0][0]).toBe('https://project.example.test/functions/v1/esign-document?token=t&page=2');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('says the app is not connected when the build has no project', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    const err = await failure(invokePublicEdge('unsubscribe', {}));
    expect(err.kind).toBe('network');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads branding, and treats any failure as no branding', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ display_name: 'Example Org', logo_path: null, legal_name: 'Example Org LLC', contact_email: 'hello@example.com', brand: {} }),
        { status: 200 },
      ),
    );
    await expect(fetchPublicBranding()).resolves.toEqual({
      displayName: 'Example Org',
      logoPath: null,
      legalName: 'Example Org LLC',
      contactEmail: 'hello@example.com',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchPublicBranding()).resolves.toEqual({ displayName: null, logoPath: null, legalName: null, contactEmail: null });
  });
});
