import type { DomainAllowlist } from './types';

/** 0010_email. Every function is the server's: the owner's browser reads, never writes. */
export const allowlist: DomainAllowlist = {
  serverRpcs: [
    'group_email_begin(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,integer)',
    'group_email_replay(uuid)',
    'group_email_claim(uuid,text,text[])',
    'group_email_record(uuid,text,text,text,text)',
    'group_email_finish(uuid,integer,integer,integer,integer)',
    'email_unsubscribe_lookup(text)',
    'email_unsubscribe_confirm(text)',
  ],
};
