// @vitest-environment node
// org-logo: images only, checked by their bytes, written under a new name, and named on
// org_profile (the real table, in PGlite).
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, seedCore } from '../db/harness';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { createOrgLogoHandler, MAX_LOGO_BYTES, sniffLogoType, type OrgLogoDeps } from '../../../supabase/functions/org-logo/handler';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const ID = '40000000-0000-4000-8000-000000000001';

function fakeDeps(over: Partial<OrgLogoDeps> = {}): OrgLogoDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    upload: async () => {},
    setLogoPath: async () => {},
    audit: async () => {},
    newId: () => ID,
    ...over,
  };
}

describeEdgeContract({
  name: 'org-logo',
  handler: createOrgLogoHandler(fakeDeps()),
  failingHandler: createOrgLogoHandler(fakeDeps({ upload: throwInternal })),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'bytes', valid: PNG, maxBytes: MAX_LOGO_BYTES },
});

describe('sniffLogoType', () => {
  it('knows PNG, JPEG and WebP by their bytes, and nothing else', () => {
    expect(sniffLogoType(PNG)).toBe('image/png');
    expect(sniffLogoType(JPEG)).toBe('image/jpeg');
    expect(sniffLogoType(WEBP)).toBe('image/webp');
    for (const other of [GIF, PDF, SVG, new Uint8Array(0)]) expect(sniffLogoType(other)).toBeNull();
  });
});

describe('org-logo', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createDb();
    await seedCore(db);
  }, 60_000);

  const send = (deps: OrgLogoDeps, body: Uint8Array, type?: string) =>
    createOrgLogoHandler(deps)(edgeRequest({ headers: { ...CREDENTIALS.owner, ...(type ? { 'Content-Type': type } : {}) }, body }));

  it('stores a PNG under a new name and points the profile at it', async () => {
    const uploads: Array<{ path: string; type: string }> = [];
    const audit = vi.fn(async () => {});
    const deps = fakeDeps({
      upload: async (path, _bytes, type) => void uploads.push({ path, type }),
      async setLogoPath(logoPath) {
        await db.query('UPDATE public.org_profile SET logo_path = $1', [logoPath]);
      },
      audit,
    });
    const res = await send(deps, PNG, 'image/png');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logo_path: `org-assets/logo/${ID}.png` });
    expect(uploads).toEqual([{ path: `logo/${ID}.png`, type: 'image/png' }]);
    expect((await db.query('SELECT logo_path FROM public.org_profile')).rows).toEqual([{ logo_path: `org-assets/logo/${ID}.png` }]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('names the file by what the bytes are, whatever generic type was sent', async () => {
    for (const [bytes, ext] of [[JPEG, 'jpg'], [WEBP, 'webp']] as const) {
      const res = await send(fakeDeps(), bytes, 'application/octet-stream');
      expect(await res.json()).toEqual({ logo_path: `org-assets/logo/${ID}.${ext}` });
    }
  });

  it('refuses SVG, GIF, PDF and a PNG claimed as JPEG, and stores nothing', async () => {
    const upload = vi.fn();
    const setLogoPath = vi.fn();
    const deps = fakeDeps({ upload, setLogoPath });
    for (const [bytes, type] of [[SVG, 'image/svg+xml'], [GIF, 'image/gif'], [PDF, 'application/pdf'], [PNG, 'image/jpeg'], [SVG, undefined]] as const) {
      const res = await send(deps, bytes, type);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'The logo must be a PNG, JPEG or WebP image.', code: 'unsupported_image' });
    }
    expect(upload).not.toHaveBeenCalled();
    expect(setLogoPath).not.toHaveBeenCalled();
  });

  it('a failed upload leaves the profile pointing at the old logo', async () => {
    await db.exec(`UPDATE public.org_profile SET logo_path = 'org-assets/logo/old.png'`);
    const res = await send(fakeDeps({
      upload: async () => { throw new Error('storage down'); },
      setLogoPath: async (p) => void (await db.query('UPDATE public.org_profile SET logo_path = $1', [p])),
    }), PNG, 'image/png');
    expect(res.status).toBe(500);
    expect((await db.query('SELECT logo_path FROM public.org_profile')).rows).toEqual([{ logo_path: 'org-assets/logo/old.png' }]);
  });
});
