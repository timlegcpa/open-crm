import { createClient } from '@supabase/supabase-js';
import { authorizeClient, authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { encryptDocument, importAesKey } from '../_shared/crypto.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import { createEncryptDocumentHandler } from './handler.ts';

const BUCKET = 'client-documents';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;

// Refuse to start without a usable key: anything but exactly 32 bytes of base64 throws here.
const DOCUMENT_KEY = Deno.env.get('DOCUMENT_ENCRYPTION_KEY') ?? '';
await importAesKey(DOCUMENT_KEY, 'encrypt');

Deno.serve(
  createEncryptDocumentHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    authorizeClient: (token) => authorizeClient(clients, token),
    limitClient: (userId) => checkUserLimit(server, { action: 'encrypt_document.client', userId, max: 60, windowMinutes: 60 }),

    async destinationExists(contactId, heldBy, folderPath) {
      const contact = await server.from('contacts').select('id').eq('id', contactId).maybeSingle();
      if (contact.error) throw contact.error;
      if (!contact.data) return false;
      if (folderPath === '/') return true;
      const parent = folderPath.replace(/[^/]+\/$/, '');
      const name = folderPath.slice(parent.length, -1);
      const folder = await server
        .from('client_folders')
        .select('id')
        .eq('contact_id', contactId)
        .eq('held_by', heldBy)
        .eq('parent_path', parent)
        .eq('name', name)
        .maybeSingle();
      if (folder.error) throw folder.error;
      return folder.data !== null;
    },

    encrypt: (plaintext) => encryptDocument(plaintext, DOCUMENT_KEY),

    async putObject(path, bytes) {
      const { error } = await server.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: 'application/octet-stream', upsert: false });
      if (error) throw error;
    },

    // The path is fresh (a new uuid), so the only row over it is the one this call filed.
    async findRowByStoragePath(path) {
      const { data, error } = await server
        .from('client_documents')
        .select('id')
        .eq('storage_path', path)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw error;
      return (data as Array<{ id: string }>)[0]?.id ?? null;
    },

    async insertRow(row) {
      const { data, error } = await server.from('client_documents').insert(row).select('id').single();
      if (error) throw error;
      return (data as { id: string }).id;
    },

    async recordActivity(activity) {
      const { error } = await server.from('client_activity_log').insert({ ...activity, action: 'document_upload' });
      if (error) throw error;
    },

    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  }),
);
