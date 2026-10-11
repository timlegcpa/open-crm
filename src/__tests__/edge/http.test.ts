// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BodyError,
  bearerToken,
  json,
  originRefused,
  readBodyBytes,
  readJsonBody,
  responseHeaders,
  SECURITY_HEADERS,
} from '../../../supabase/functions/_shared/http';

const ALLOWED = ['https://crm.example.test'];

const withOrigin = (origin: string | null, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (origin) headers.set('Origin', origin);
  return new Request('http://edge.test/fn', { method: 'POST', ...init, headers });
};

/** A chunked body: no Content-Length, delivered in pieces, recording whether it was cancelled. */
function streamed(chunks: Uint8Array[], contentLength?: string) {
  const state = { pulled: 0, cancelled: false };
  // highWaterMark 0: the stream produces a chunk only when it is read, so `pulled` counts reads.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++]);
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request('http://edge.test/fn', { method: 'POST', body, duplex: 'half' } as RequestInit);
  if (contentLength !== undefined) req.headers.set('Content-Length', contentLength);
  return { req, state };
}

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof BodyError ? e.status : e;
  }
};

describe('responseHeaders and json', () => {
  it('puts the security headers and Vary: Origin on every response, refused origin or not', () => {
    for (const origin of [ALLOWED[0], 'https://elsewhere.example', null]) {
      const res = json(withOrigin(origin), ALLOWED, 418, { error: 'x' });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect([k, res.headers.get(k)]).toEqual([k, v]);
      expect(res.headers.get('Vary')).toBe('Origin');
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(res.status).toBe(418);
    }
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
  });

  it('grants CORS only to an allowed origin', () => {
    expect(responseHeaders(withOrigin(ALLOWED[0]), ALLOWED)['Access-Control-Allow-Origin']).toBe(ALLOWED[0]);
    for (const origin of ['https://elsewhere.example', 'https://crm.example.test.evil.example', 'null', null]) {
      const h = responseHeaders(withOrigin(origin), ALLOWED);
      expect([origin, h['Access-Control-Allow-Origin'], h['Access-Control-Allow-Methods']]).toEqual([origin, undefined, undefined]);
    }
  });

  it('lists the methods the function accepts, plus OPTIONS once', () => {
    const methods = (m?: string[]) => responseHeaders(withOrigin(ALLOWED[0]), ALLOWED, m)['Access-Control-Allow-Methods'];
    expect(methods()).toBe('POST, OPTIONS');
    expect(methods(['GET', 'POST'])).toBe('GET, POST, OPTIONS');
    expect(methods(['GET', 'OPTIONS'])).toBe('GET, OPTIONS');
  });
});

describe('originRefused', () => {
  it('refuses a browser origin that is not allowed, and leaves origin-less calls to their credentials', () => {
    expect(originRefused(withOrigin(ALLOWED[0]), ALLOWED)).toBe(false);
    expect(originRefused(withOrigin(null), ALLOWED)).toBe(false);
    expect(originRefused(withOrigin('https://elsewhere.example'), ALLOWED)).toBe(true);
    expect(originRefused(withOrigin('null'), ALLOWED)).toBe(true);
  });
});

describe('readBodyBytes', () => {
  it('reads no body as empty bytes', async () => {
    expect(await readBodyBytes(new Request('http://edge.test/fn', { method: 'POST' }), 10)).toEqual(new Uint8Array(0));
  });

  it('joins chunks in order and allows exactly the cap', async () => {
    const { req } = streamed([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)]);
    expect(await readBodyBytes(req, 5)).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  });

  it('refuses a declared Content-Length over the cap before reading a byte', async () => {
    const { req, state } = streamed([new Uint8Array(4)], '11');
    expect(await caught(readBodyBytes(req, 10))).toBe(413);
    expect(state.pulled).toBe(0);
  });

  it('refuses a chunked body over the cap, stopping the stream instead of buffering the rest', async () => {
    const { req, state } = streamed([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    expect(await caught(readBodyBytes(req, 10))).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  it('refuses a body that outgrows a Content-Length claiming it is small', async () => {
    const { req } = streamed([new Uint8Array(8), new Uint8Array(8)], '4');
    expect(await caught(readBodyBytes(req, 10))).toBe(413);
  });
});

describe('readJsonBody', () => {
  const post = (body?: string) => new Request('http://edge.test/fn', { method: 'POST', body });

  it('parses JSON within the cap', async () => {
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it('answers 400 to an empty or malformed body and 413 to an oversized one', async () => {
    expect(await caught(readJsonBody(post(), 100))).toBe(400);
    expect(await caught(readJsonBody(post(''), 100))).toBe(400);
    expect(await caught(readJsonBody(post('{"a":'), 100))).toBe(400);
    expect(await caught(readJsonBody(post(JSON.stringify({ a: 'x'.repeat(200) })), 100))).toBe(413);
  });
});

describe('bearerToken', () => {
  const auth = (value?: string) =>
    bearerToken(new Request('http://edge.test/fn', { headers: value === undefined ? {} : { Authorization: value } }));

  it('reads one bearer token and nothing else', () => {
    expect(auth('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(auth('bearer abc')).toBe('abc');
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'abc']) {
      expect([bad, auth(bad)]).toEqual([bad, null]);
    }
  });
});
