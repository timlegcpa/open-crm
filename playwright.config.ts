import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the app served by Vite and a MOCK Supabase project (e2e/mocks/): no
 * real project, no network beyond the local server. The Supabase URL below is a fake origin
 * that never resolves; every request to it is answered in-process by route interception.
 *
 *   npm run test:e2e      the specs (e2e/*.spec.ts), everything but the @screenshots tag
 *   npm run screenshots   only the @screenshots tag: the README images in docs/screenshots/
 */

const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  // Outside the repository, so a failed run's traces never show up in git status.
  outputDir: join(tmpdir(), 'open-crm-e2e'),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No network, so nothing to flake on: a retry would only hide a real race.
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: 'http://supabase.mock.test',
      VITE_SUPABASE_ANON_KEY: 'mock-anon-key-0123456789',
      VITE_SITE_URL: '',
    },
  },
});
