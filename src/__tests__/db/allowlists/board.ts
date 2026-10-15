import type { DomainAllowlist } from './types';

const OWNER_ONLY =
  'owner only: refuses everyone but the owner first, and a View-as-client session is a client session, which never passes is_owner(); the board tables are the owner’s alone, so they carry no read-only trigger';

/** 0008_board. */
export const allowlist: DomainAllowlist = {
  authenticatedCallable: [
    'create_work_item(text,uuid,text,text,text,date,text)',
    'add_work_item_note(uuid,text)',
    'move_work_item_stage(uuid,text,text,text)',
    'reorder_board_lane(text,uuid[])',
  ],
  serverRpcs: ['auto_archive_done_work_items()'],
  definerWriteExempt: {
    'create_work_item(text,uuid,text,text,text,date,text)': OWNER_ONLY,
    'add_work_item_note(uuid,text)': OWNER_ONLY,
    'move_work_item_stage(uuid,text,text,text)': OWNER_ONLY,
    'reorder_board_lane(text,uuid[])': OWNER_ONLY,
  },
};
