import { createClient } from '@supabase/supabase-js';
import { authorizeClient, authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { decryptDocument, importAesKey } from '../_shared/crypto.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import { createDecryptDocumentHandler, type StoredDocument } from './handler.ts';

const BUCKET = 'client-documents';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;

// Refuse to start without a usable key: anything but exactly 32 bytes of base64 throws here.
const DOCUMENT_KEY = Deno.env.get('DOCUMENT_ENCRYPTION_KEY') ?? '';
await importAesKey(DOCUMENT_KEY, 'decrypt');

Deno.serve(
  createDecryptDocumentHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    authorizeClient: (token) => authorizeClient(clients, token),
    limitClient: (userId) => checkUserLimit(server, { action: 'decrypt_document.client', userId, max: 200, windowMinutes: 60 }),

    async loadDocument(id) {
      const { data, error } = await server
        .from('client_documents')
        .select('id, contact_id, shared_with_contact_id, original_filename, mime_type, storage_path, encryption_status, encryption_iv')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as StoredDocument | null) ?? null;
    },

    async getObject(path) {
      const { data, error } = await server.storage.from(BUCKET).download(path);
      if (error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },

    decrypt: (ciphertext, iv) => decryptDocument(ciphertext, iv, DOCUMENT_KEY),

    async signedUrl(path, seconds) {
      const { data, error } = await server.storage.from(BUCKET).createSignedUrl(path, seconds);
      if (error) throw error;
      return data.signedUrl;
    },

    async recordActivity(activity) {
      const { error } = await server.from('client_activity_log').insert({ ...activity, action: 'document_download' });
      if (error) throw error;
    },
  }),
);
