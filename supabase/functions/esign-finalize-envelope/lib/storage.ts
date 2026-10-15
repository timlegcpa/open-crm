// The two buckets e-signature touches, behind one small interface the handlers take.
//
//   esign-working     the draft's uploaded sources and the assembled source.pdf, under
//                     {envelope_id}/. Plaintext. Removed only by delete-envelope and by
//                     the 90-day retention purge, both after a COMPLETE listing.
//   client-documents  the executed copy, {owner_contact_id}/esign/{envelope_id}.pdf.
//                     Written once (no upsert) and read back; NEVER removed by anything
//                     here (src/features/documents/__tests__/clientDocumentsStorageDeleteGuard.test.ts):
//                     one object backs a documents row for every signer.

export interface EsignStorage {
  /** Store a working object. `upsert: false` refuses an existing path (throws). */
  putWorking(path: string, bytes: Uint8Array, options: { upsert: boolean }): Promise<void>;
  getWorking(path: string): Promise<Uint8Array>;
  /** One page of a folder: files and sub-folders. */
  listWorking(folder: string, offset: number, limit: number): Promise<Array<{ name: string; folder: boolean }>>;
  removeWorking(paths: string[]): Promise<void>;
  /** Store the executed copy once: 'exists' when the path is already taken (another finalize won). */
  putDocument(path: string, bytes: Uint8Array): Promise<'stored' | 'exists'>;
  getDocument(path: string): Promise<Uint8Array>;
}

const LIST_PAGE = 1000;
/** A runaway walk is a bug, not a big envelope: a draft holds tens of objects. */
const MAX_WALK_OBJECTS = 10_000;

/**
 * Every object beneath `prefix` in esign-working. Throws when any listing fails or the walk
 * runs away: a delete from a partial listing would strand the objects it missed, with no
 * envelope row left for a later sweep to find them by.
 */
export async function walkWorking(storage: EsignStorage, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  const queue: string[] = [prefix];
  while (queue.length > 0) {
    const folder = queue.shift() as string;
    for (let offset = 0; ; offset += LIST_PAGE) {
      const page = await storage.listWorking(folder, offset, LIST_PAGE);
      for (const entry of page) {
        const path = `${folder}/${entry.name}`;
        if (entry.folder) queue.push(path);
        else paths.push(path);
        if (paths.length + queue.length > MAX_WALK_OBJECTS) throw new Error('esign-working walk is too large');
      }
      if (page.length < LIST_PAGE) break;
    }
  }
  return paths;
}

/** The slice of a supabase-js client this module calls. */
export interface StorageClient {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean },
      ): PromiseLike<{ error: { message: string; statusCode?: string | number } | null }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
      list(
        folder: string,
        options: { limit: number; offset: number; sortBy?: { column: string; order: string } },
      ): PromiseLike<{ data: Array<{ name: string; id: string | null }> | null; error: { message: string } | null }>;
      remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

class StorageFailure extends Error {
  constructor(op: string) {
    super(`storage ${op} failed`);
    this.name = 'StorageFailure';
  }
}

function isDuplicate(error: { message: string; statusCode?: string | number }): boolean {
  return /already exists|duplicate/i.test(error.message) || String(error.statusCode ?? '') === '409';
}

async function bytesOf(op: string, res: { data: Blob | null; error: unknown }): Promise<Uint8Array> {
  if (res.error || !res.data) throw new StorageFailure(op);
  return new Uint8Array(await res.data.arrayBuffer());
}

/** EsignStorage over the service client. Bucket names are literals so the delete guard can read them. */
export function supabaseEsignStorage(client: StorageClient): EsignStorage {
  return {
    async putWorking(path, bytes, { upsert }) {
      const { error } = await client.storage.from('esign-working').upload(path, bytes, { contentType: 'application/pdf', upsert });
      if (error) throw new StorageFailure('working upload');
    },
    async getWorking(path) {
      return bytesOf('working download', await client.storage.from('esign-working').download(path));
    },
    async listWorking(folder, offset, limit) {
      const { data, error } = await client.storage
        .from('esign-working')
        .list(folder, { limit, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new StorageFailure('working list');
      // Storage lists a sub-folder as an entry with no id.
      return (data ?? []).map((e) => ({ name: e.name, folder: e.id === null }));
    },
    async removeWorking(paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from('esign-working').remove(paths);
      if (error) throw new StorageFailure('working remove');
    },
    async putDocument(path, bytes) {
      const { error } = await client.storage
        .from('client-documents')
        .upload(path, bytes, { contentType: 'application/pdf', upsert: false });
      if (!error) return 'stored';
      if (isDuplicate(error)) return 'exists';
      throw new StorageFailure('document upload');
    },
    async getDocument(path) {
      return bytesOf('document download', await client.storage.from('client-documents').download(path));
    },
  };
}
