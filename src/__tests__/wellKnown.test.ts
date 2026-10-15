// @vitest-environment node
// The site's /.well-known/oauth-authorization-server (written by the build,
// scripts/well-known.mjs) must be the very document mcp-oauth answers with: an MCP client
// reads the issuer's copy, then holds the function to it.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../supabase/functions/_shared/config';
import { authorizationServerMetadata } from '../../supabase/functions/mcp-oauth/handler';
import { authorizationServerDocument, WELL_KNOWN_PATH, wellKnownMetadata } from '../../scripts/well-known.mjs';

/** What the deployed function would answer, with SITE_URL read the way every function reads it. */
function functionDocument(site: string, supabaseUrl: string) {
  const { siteUrl } = loadConfig((name) =>
    ({ SITE_URL: site, SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[name],
  );
  return authorizationServerMetadata(siteUrl!, supabaseUrl);
}

describe('the built .well-known document', () => {
  it.each([
    ['https://crm.example.com', 'https://abcdefghijklmnop.supabase.co'],
    ['https://crm.example.com/', 'https://abcdefghijklmnop.supabase.co/'],
    ['  https://crm.example.com/some/path?x=1 ', 'https://abcdefghijklmnop.supabase.co'],
    ['http://localhost:5173', 'http://127.0.0.1:54321'],
  ])('equals the function metadata for %s and %s', (site, supabaseUrl) => {
    expect(authorizationServerDocument(site, supabaseUrl)).toEqual(functionDocument(site, supabaseUrl));
  });

  it('is not written without both addresses, or with one that is not an http(s) URL', () => {
    for (const [site, supabaseUrl] of [
      [undefined, 'https://abcdefghijklmnop.supabase.co'],
      ['https://crm.example.com', undefined],
      ['', ''],
      ['crm.example.com', 'https://abcdefghijklmnop.supabase.co'],
      ['javascript:alert(1)', 'https://abcdefghijklmnop.supabase.co'],
    ]) {
      expect(authorizationServerDocument(site, supabaseUrl)).toBeNull();
    }
  });

  it('the build emits it as JSON at the well-known path, and only when configured', () => {
    const emit = (env: Record<string, string>) => {
      const plugin = wellKnownMetadata();
      const files: Array<{ fileName: string; source: string }> = [];
      plugin.configResolved({ env, command: 'build', logger: { info: () => {} } });
      plugin.generateBundle.call({ emitFile: (f: { fileName: string; source: string }) => files.push(f) });
      return files;
    };
    const [file, ...rest] = emit({ VITE_SITE_URL: 'https://crm.example.com', VITE_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' });
    expect(rest).toEqual([]);
    expect(file.fileName).toBe(WELL_KNOWN_PATH);
    expect(JSON.parse(file.source)).toEqual(functionDocument('https://crm.example.com', 'https://abcdefghijklmnop.supabase.co'));
    expect(emit({ VITE_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' })).toEqual([]);
  });
});
