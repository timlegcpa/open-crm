import { test as base, expect, type Page } from '@playwright/test';
import { AUTH_STORAGE_KEY, MOCK_ORIGIN, MockSupabase, type Principal } from './mocks/supabase';
import { baseScenario } from './mocks/scenario';

export { expect };
export { ID, ORG_NAME, OWNER, CLIENT } from './mocks/scenario';

/**
 * Every spec imports `test` from here. Each test gets its own mock project (`mock`), and an
 * automatic guard that fails the test if ANY request or WebSocket left for an origin other
 * than the local app server and the mock Supabase origin. Such a request is aborted, and such
 * a socket closed, before it leaves; the guard then reports it. WebSockets need their own
 * route: `context.on('request')` and `context.route` never see them.
 */

function allowed(url: string, appOrigin: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return true;
  const { origin, protocol, host } = new URL(url);
  if (origin === appOrigin || origin === MOCK_ORIGIN) return true;
  // The dev server's hot-reload socket and the mock's Realtime socket.
  if ((protocol === 'ws:' || protocol === 'wss:') && (host === new URL(appOrigin).host || host === new URL(MOCK_ORIGIN).host)) return true;
  return false;
}

interface Fixtures {
  mock: MockSupabase;
  /** URLs that tried to leave for a foreign origin (the guard asserts this is empty). */
  foreignRequests: string[];
}

export const test = base.extend<Fixtures>({
  foreignRequests: [
    async ({ context, baseURL }, use) => {
      const appOrigin = new URL(baseURL!).origin;
      const foreign: string[] = [];
      context.on('request', (request) => {
        if (!allowed(request.url(), appOrigin)) foreign.push(request.url());
      });
      await context.route((url) => !allowed(url.toString(), appOrigin), (route) => route.abort('blockedbyclient'));
      // Never connected to a server: the socket is recorded and closed on the spot.
      await context.routeWebSocket(
        (url) => !allowed(url.toString(), appOrigin),
        (ws) => {
          foreign.push(ws.url());
          void ws.close();
        },
      );
      // Backstop: any socket a page opens, routed or not, is checked as it opens.
      context.on('page', (page) =>
        page.on('websocket', (ws) => {
          if (!allowed(ws.url(), appOrigin) && !foreign.includes(ws.url())) foreign.push(ws.url());
        }),
      );
      await use(foreign);
      expect(foreign, 'requests to an origin other than the app and the mock Supabase').toEqual([]);
    },
    { auto: true },
  ],
  // Automatic: a test that never names `mock` still gets one, so the app's calls to the
  // mock origin are always answered here and never attempt a real lookup.
  mock: [
    async ({ context }, use) => {
      const mock = new MockSupabase(await baseScenario());
      await mock.install(context);
      await use(mock);
      // Every call the app made had an answer in the scenario: an unmocked function or RPC
      // would otherwise pass as a quiet 404 and hide a screen that never loaded.
      expect([...new Set(mock.unhandled)], 'calls the mock project had no answer for').toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Start the page already signed in (the second factor done), as supabase-js would have left
 * it: the session in localStorage. Seeded once per tab, so a sign-out in the test sticks.
 */
export async function signIn(page: Page, mock: MockSupabase, principal: Exclude<Principal, 'anon'>): Promise<void> {
  const session = mock.session(principal, 'aal2');
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem('e2e-seeded')) return;
      window.sessionStorage.setItem('e2e-seeded', '1');
      window.localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, JSON.stringify(session)] as const,
  );
}

/**
 * What a public page (no session) may ask the mock project: edge functions, plus the one
 * anon-callable branding RPC the public frame reads (src/lib/publicEdge.ts,
 * fetchPublicBranding). Never Auth, never a table, never with a user's token.
 */
export function expectPublicCallsOnly(mock: MockSupabase): void {
  const offending = mock.calls.filter(
    (c) => c.principal !== 'anon' || c.kind === 'auth' || c.kind === 'rest' || c.kind === 'storage' || (c.kind === 'rpc' && c.name !== 'get_org_branding'),
  );
  expect(offending.map((c) => `${c.kind} ${c.method} ${c.name}`), 'a public page reached past the edge functions').toEqual([]);
}
