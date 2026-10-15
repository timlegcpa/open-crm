// org-logo: the owner uploads the organization's logo. Owner only.
//
// The body is the raw image, at most 1 MiB. Only PNG, JPEG and WebP are taken, and the
// type is read from the bytes themselves; a Content-Type the request declares must agree
// with them. Never SVG (it can carry script, and the bucket is public), never GIF, PDF or
// an Office file, although the general upload allowlist takes those. The logo is written
// as the server to org-assets/logo/<new id>.<ext> (never over an existing object) and
// org_profile.logo_path then names it. Earlier logos are kept: emails already sent point
// at their URLs. Removing the logo is the owner's own update (logo_path = NULL); the
// editor never takes a URL from elsewhere, which the sign-in page's image policy would
// block anyway.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { verifyMagicBytes } from '../_shared/magic-bytes.ts';

export const LOGO_BUCKET = 'org-assets';
export const MAX_LOGO_BYTES = 1_048_576;
export const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
export type LogoType = keyof typeof LOGO_TYPES;

export interface OrgLogoDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** Writes the object; must refuse to overwrite. `path` is inside the bucket. */
  upload(path: string, bytes: Uint8Array, contentType: LogoType): Promise<void>;
  /** Sets org_profile.logo_path. */
  setLogoPath(logoPath: string): Promise<void>;
  audit(ownerId: string): Promise<void>;
  newId?: () => string;
  logSink?: LogSink;
}

/** The logo type the bytes are, or null for anything else. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  for (const type of Object.keys(LOGO_TYPES) as LogoType[]) if (verifyMagicBytes(type, bytes)) return type;
  return null;
}

const NOT_AN_IMAGE = { error: 'The logo must be a PNG, JPEG or WebP image.', code: 'unsupported_image' };

export function createOrgLogoHandler(deps: OrgLogoDeps): (req: Request) => Promise<Response> {
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return createHandler({
    name: 'org-logo',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    body: 'bytes',
    maxBodyBytes: MAX_LOGO_BYTES,
    logSink: deps.logSink,
    async handle({ req, principal, body, json, log }) {
      const type = sniffLogoType(body);
      if (!type) return json(400, NOT_AN_IMAGE);
      const declared = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
      // A declared image type must be the one the bytes are. (A generic or missing type
      // defers to the bytes.)
      if (declared.startsWith('image/') && declared !== type) return json(400, NOT_AN_IMAGE);

      const objectPath = `logo/${newId()}.${LOGO_TYPES[type]}`;
      await deps.upload(objectPath, body, type);
      const logoPath = `${LOGO_BUCKET}/${objectPath}`;
      await deps.setLogoPath(logoPath);
      try {
        await deps.audit(principal.userId);
      } catch (err) {
        log.error('audit failed', err);
      }
      return json(200, { logo_path: logoPath });
    },
  });
}
