import type { DomainAllowlist } from './types';

/**
 * 0006_esign. No signed-in session calls an e-sign function: the owner reads the tables
 * and the e-sign edge functions do every write as the server, through these RPCs.
 */
export const allowlist: DomainAllowlist = {
  serverRpcs: [
    'esign_insert_document_with_pages(uuid,uuid,text,text,bigint,integer)',
    'esign_set_signer_fields(uuid,uuid,jsonb)',
    'esign_apply_page_reorder(uuid,jsonb,jsonb,uuid[])',
    'esign_delete_draft_document(uuid,uuid,jsonb,uuid[])',
    'esign_claim_signer_signature(uuid,text,text,text,text,timestamp with time zone,inet,text,text,text,text)',
    'esign_check_sms_code(uuid,text,integer,text,inet,integer)',
    'esign_delete_signature_images_for_envelope(uuid)',
    'esign_purge_terminal_signature_images(timestamp with time zone,integer)',
    'esign_prune_operational()',
    'esign_expire_envelope(uuid,timestamp with time zone)',
  ],
};
