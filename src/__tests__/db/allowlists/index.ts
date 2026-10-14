import type { DomainAllowlist } from './types';

export type { DomainAllowlist } from './types';

// Every domain file in this folder, found by name, so a new domain adds a file and edits nothing shared.
const files = import.meta.glob<{ allowlist: DomainAllowlist }>(['./*.ts', '!./index.ts', '!./types.ts'], { eager: true });

/** The domain files, by file name ('core', 'contacts', ...). */
export const domains: Record<string, DomainAllowlist> = Object.fromEntries(
  Object.entries(files).map(([file, mod]) => [file.replace(/^\.\/|\.ts$/g, ''), mod.allowlist]),
);

const all = Object.values(domains);
const list = (pick: (d: DomainAllowlist) => string[] | undefined) => [...new Set(all.flatMap((d) => pick(d) ?? []))].sort();
const record = (pick: (d: DomainAllowlist) => Record<string, string> | undefined) =>
  Object.assign({}, ...all.map((d) => pick(d) ?? {})) as Record<string, string>;

export const ANON_CALLABLE = list((d) => d.anonCallable);
export const AUTHENTICATED_CALLABLE = list((d) => d.authenticatedCallable);
export const SERVER_RPCS = list((d) => d.serverRpcs);
export const IMPERSONATION_EXEMPT = record((d) => d.impersonationExempt);
export const DEFINER_WRITE_EXEMPT = record((d) => d.definerWriteExempt);
export const PUBLIC_BUCKETS = record((d) => d.publicBuckets);
