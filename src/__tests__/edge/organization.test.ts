// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import { createOrgLoader, orgIdentityFromRow, type OrgClient } from '../../../supabase/functions/_shared/organization';
import { serviceClient } from './pgliteClient';

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';

describe('createOrgLoader against 0001 org_profile', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
    await db.exec(`
      INSERT INTO public.org_profile (display_name, legal_name, sender_name, postal_address, logo_path, brand)
      VALUES ('Example Co', 'Example Company LLC', 'Example Team', E'1 Main St\\nSpringfield', 'branding/logo.png',
              '{"primary_color": "#1d4ed8", "other": 1}');
    `);
  }, 60_000);

  it('reads every identity column the module names, in one query', async () => {
    const identity = await createOrgLoader({ db: serviceClient(db), supabaseUrl: SUPABASE_URL }).load();
    expect(identity).toEqual({
      displayName: 'Example Co',
      legalName: 'Example Company LLC',
      senderName: 'Example Team',
      postalAddress: '1 Main St\nSpringfield',
      logoUrl: `${SUPABASE_URL}/storage/v1/object/public/branding/logo.png`,
      brandColor: '#1d4ed8',
    });
  });
});

describe('orgIdentityFromRow', () => {
  const row = { display_name: ' Example Co ', legal_name: '', sender_name: null, postal_address: null, logo_path: null, brand: {} };

  it('falls back sensibly: sender name to display name, blanks to null, no colour', () => {
    expect(orgIdentityFromRow(row, SUPABASE_URL)).toEqual({
      displayName: 'Example Co',
      legalName: null,
      senderName: 'Example Co',
      postalAddress: null,
      logoUrl: null,
      brandColor: null,
    });
  });

  it.each([
    ['an https URL as-is', 'https://cdn.example.test/logo.png', 'https://cdn.example.test/logo.png'],
    ['a storage path under the public object URL', 'assets/brand/logo.svg', `${SUPABASE_URL}/storage/v1/object/public/assets/brand/logo.svg`],
    ['plain http refused', 'http://cdn.example.test/logo.png', null],
    ['a script URL refused', 'javascript:alert(1)', null],
    ['a traversal refused', 'assets/../secret.png', null],
    ['a bare file name refused', 'logo.png', null],
  ])('logo: %s', (_label, logo_path, expected) => {
    expect(orgIdentityFromRow({ ...row, logo_path }, SUPABASE_URL).logoUrl).toBe(expected);
  });

  it('takes brand.primary_color only when it is #rrggbb', () => {
    expect(orgIdentityFromRow({ ...row, brand: { primary_color: '#0F766E' } }, SUPABASE_URL).brandColor).toBe('#0F766E');
    for (const primary_color of ['red', '#fff', '#1d4ed8;background:url(x)', 7]) {
      expect(orgIdentityFromRow({ ...row, brand: { primary_color } }, SUPABASE_URL).brandColor).toBeNull();
    }
  });

  it('throws when there is no row or no display name', () => {
    expect(() => orgIdentityFromRow(null, SUPABASE_URL)).toThrow(/dev:bootstrap/);
    expect(() => orgIdentityFromRow({ display_name: '  ' }, SUPABASE_URL)).toThrow(/dev:bootstrap/);
  });
});

describe('createOrgLoader: the per-isolate cache', () => {
  function counting(answers: Array<{ data: unknown; error: unknown }>) {
    let calls = 0;
    const db: OrgClient = {
      from: () => ({
        select: () => ({
          maybeSingle: async () => answers[Math.min(calls++, answers.length - 1)],
        }),
      }),
    };
    return { db, calls: () => calls };
  }
  const good = (name: string) => ({ data: { display_name: name }, error: null });

  it('serves a fresh value from memory and re-reads after the TTL', async () => {
    let t = 0;
    const f = counting([good('First'), good('Second')]);
    const loader = createOrgLoader({ db: f.db, supabaseUrl: SUPABASE_URL, ttlMs: 1000, now: () => t });
    expect((await loader.load()).displayName).toBe('First');
    t = 999;
    expect((await loader.load()).displayName).toBe('First');
    expect(f.calls()).toBe(1);
    t = 1000;
    expect((await loader.load()).displayName).toBe('Second');
    expect(f.calls()).toBe(2);
  });

  it('shares one query between concurrent loads', async () => {
    const f = counting([good('Once')]);
    const loader = createOrgLoader({ db: f.db, supabaseUrl: SUPABASE_URL });
    const names = await Promise.all([loader.load(), loader.load(), loader.load()]);
    expect(names.map((n) => n.displayName)).toEqual(['Once', 'Once', 'Once']);
    expect(f.calls()).toBe(1);
  });

  it('serves the last good value when a refresh fails, and retries on the next call', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 0;
    const f = counting([good('Good'), { data: null, error: { code: '57014' } }, good('Back')]);
    const loader = createOrgLoader({ db: f.db, supabaseUrl: SUPABASE_URL, ttlMs: 10, now: () => t });
    await loader.load();
    t = 20;
    expect((await loader.load()).displayName).toBe('Good');
    expect(String(spy.mock.calls[0]?.[0])).toContain('serving the cached identity');
    expect((await loader.load()).displayName).toBe('Back');
    spy.mockRestore();
  });

  it('throws on a failed first load, and does not cache the failure', async () => {
    const f = counting([{ data: null, error: { code: '57014' } }, good('Later')]);
    const loader = createOrgLoader({ db: f.db, supabaseUrl: SUPABASE_URL });
    await expect(loader.load()).rejects.toEqual({ code: '57014' });
    expect((await loader.load()).displayName).toBe('Later');
  });
});
