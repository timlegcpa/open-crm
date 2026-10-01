// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../supabase/functions/_shared/config';

const base: Record<string, string> = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const env = (extra: Record<string, string> = {}) => (name: string) => ({ ...base, ...extra })[name];

describe('loadConfig', () => {
  it('allows the local dev origins unless the environment is production', () => {
    expect(loadConfig(env()).allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(loadConfig(env({ ENVIRONMENT: 'production' })).allowedOrigins).toEqual([]);
  });

  it('adds the site and extra origins as bare origins, and drops anything that is not one', () => {
    const cfg = loadConfig(
      env({
        ENVIRONMENT: 'production',
        SITE_URL: 'https://crm.example.com/some/path',
        ALLOWED_ORIGINS: 'https://admin.example.com, javascript:alert(1), not a url,',
      }),
    );
    expect(cfg.siteUrl).toBe('https://crm.example.com');
    expect(cfg.allowedOrigins).toEqual(['https://crm.example.com', 'https://admin.example.com']);
  });

  it('in production drops a local origin even when it is listed by hand', () => {
    const cfg = loadConfig(
      env({
        ENVIRONMENT: 'production',
        SITE_URL: 'http://localhost:5173',
        ALLOWED_ORIGINS: 'http://127.0.0.1:4173, http://app.localhost:3000, https://crm.example.com',
      }),
    );
    expect(cfg.allowedOrigins).toEqual(['https://crm.example.com']);
  });

  it('refuses to start without the Supabase values', () => {
    expect(() => loadConfig((name) => (name === 'SUPABASE_URL' ? undefined : base[name]))).toThrow(/SUPABASE_URL/);
    expect(() => loadConfig((name) => (name === 'SUPABASE_SERVICE_ROLE_KEY' ? undefined : base[name]))).toThrow(/SERVICE_ROLE/);
  });
});
