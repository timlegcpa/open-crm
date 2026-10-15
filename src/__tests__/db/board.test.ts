// @vitest-environment node
// 0008_board: the work board. Every table is the owner's alone; a client (and so the owner's
// View-as-client session) reads and writes nothing. Creation, stage moves, notes and lane
// order go through four owner-only RPCs; the nightly archive is the server's.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  become,
  count,
  createDb,
  errorOf,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  tryIn,
  user,
  type Principal,
} from './harness';

type Tx = Parameters<Parameters<typeof session>[2]>[0];

const TABLES = ['board_stages', 'work_item_types', 'work_items', 'work_item_events'];

const forger = user('00000000-0000-4000-8000-00000000000f', { appRole: 'admin' }); // signed in, no account, forged claim

let db: PGlite;
let contactA: string;
let contactB: string; // business only: no person's name
let clientA: Principal;
let clientAUserId: string;
let todoItem: string;
let doingItem: string;
let doneItem: string;

async function seedItem(fields: Record<string, unknown>): Promise<string> {
  const row: Record<string, unknown> = { title: 'Send the signed proposal', ...fields };
  const columns = Object.keys(row);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.work_items (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0].id;
}

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactA = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', status: 'client' });
  contactB = await seedContact(db, { first_name: '', last_name: '', business_name: 'Acme LLC' });
  clientAUserId = (await seedPortalAccount(db, contactA)).userId;
  clientA = asClient(clientAUserId);
  todoItem = await seedItem({ contact_id: contactA, stage: 'todo' });
  doingItem = await seedItem({ contact_id: contactB, stage: 'doing', priority: 'urgent' });
  doneItem = await seedItem({ title: 'File the paperwork', stage: 'done' });
  await db.query(
    `INSERT INTO public.work_item_events (work_item_id, event_type, from_value, to_value, detail)
     VALUES ($1, 'stage_changed', 'todo', 'doing', '{"note":"Started work"}')`,
    [doingItem],
  );
}, 60_000);

/** Runs `fn` as the owner inside a rolled-back transaction. */
const asOwnerTx = <T>(fn: (tx: Tx) => Promise<T>) => session(db, asOwner, fn);

/** create_work_item with every argument named; the defaults are the board's. */
const CREATE = `SELECT public.create_work_item($1, $2, $3, $4, $5, $6, $7) AS id`;
const createArgs = (over: Partial<Record<'title' | 'contact' | 'type' | 'stage' | 'priority' | 'due' | 'note', unknown>> = {}) => {
  const a = { title: 'x', contact: null, type: null, stage: null, priority: null, due: null, note: null, ...over };
  return [a.title, a.contact, a.type, a.stage, a.priority, a.due, a.note];
};

const stageOf = async (tx: Tx, id: string) =>
  (await tx.query<{ stage: string; lane_position: number | null }>(
    'SELECT stage, lane_position FROM public.work_items WHERE id = $1', [id])).rows[0];

describe('who can read and write the board', () => {
  it('anon has no access to any board table', async () => {
    for (const t of TABLES) expect(await errorOf(db, asAnon, `SELECT 1 FROM public.${t}`), t).toMatch(/permission denied/);
  });

  it('the owner and the server read every table; a client and a forged admin claim read nothing', async () => {
    for (const t of TABLES) {
      expect(await count(db, asOwner, t), t).toBeGreaterThan(0);
      expect(await count(db, asServer, t), t).toBeGreaterThan(0);
      expect(await count(db, clientA, t), t).toBe(0);
      expect(await count(db, forger, t), t).toBe(0);
    }
  });

  it('a client and a forged claim cannot write any board table', async () => {
    for (const who of [clientA, forger]) {
      expect(await errorOf(db, who, `INSERT INTO public.work_items (title) VALUES ('x')`)).toMatch(/permission denied/);
      expect(await errorOf(db, who, CREATE, createArgs())).toMatch(/forbidden/);
      expect(await as(db, who, `UPDATE public.work_items SET title = 'x' RETURNING id`)).toEqual([]);
      expect(await as(db, who, `DELETE FROM public.work_items RETURNING id`)).toEqual([]);
      expect(await errorOf(db, who, `INSERT INTO public.work_item_types (key, label) VALUES ('x', 'X')`)).toMatch(/row-level security/);
      expect(await as(db, who, `UPDATE public.work_item_types SET label = 'x' RETURNING key`)).toEqual([]);
      expect(await as(db, who, `DELETE FROM public.work_item_types WHERE key = 'call' RETURNING key`)).toEqual([]);
      expect(await as(db, who, `UPDATE public.board_stages SET label = 'x' RETURNING key`)).toEqual([]);
      expect(await errorOf(db, who,
        `INSERT INTO public.work_item_events (work_item_id, event_type) VALUES ('${todoItem}', 'note_added')`)).toMatch(/permission denied/);
    }
  });

  it('the owner’s View-as-client session reads and writes nothing either', async () => {
    const MINTED = randomUUID();
    const viewing = asClient(clientAUserId, { sessionId: MINTED });
    const out = await session(db, asServer, async (tx) => {
      await tx.query(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
         VALUES ($1, $2, $3, 'a@example.test', $4)`,
        [OWNER_ID, contactA, clientAUserId, MINTED]);
      await become(tx, viewing);
      const seen = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_items')).rows[0].n;
      const insert = await tryIn(tx, CREATE, createArgs());
      const move = await tryIn(tx, `SELECT public.move_work_item_stage($1, 'done', 'x')`, [todoItem]);
      return { seen, insert, move };
    });
    expect(out.seen).toBe(0);
    expect(out.insert).toMatch(/forbidden/);
    expect(out.move).toMatch(/forbidden/);
  });

  it('an MFA-enrolled owner at aal1 reads nothing, at aal2 reads the board', async () => {
    const counts = await session(db, asServer, async (tx) => {
      await tx.exec(`RESET ROLE; INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${OWNER_ID}', 'verified')`);
      const read = async (aal: 'aal1' | 'aal2') => {
        await become(tx, user(OWNER_ID, { aal }));
        const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_items')).rows[0].n;
        await tx.exec('RESET ROLE');
        return n;
      };
      return { aal1: await read('aal1'), aal2: await read('aal2') };
    });
    expect(counts).toEqual({ aal1: 0, aal2: 3 });
  });

  it('the server has row access, but history is a record and nothing can be truncated', async () => {
    expect(await errorOf(db, asServer, `UPDATE public.work_item_events SET detail = NULL`)).toMatch(/permission denied/);
    expect(await errorOf(db, asServer, `DELETE FROM public.work_item_events`)).toMatch(/permission denied/);
    for (const t of TABLES) expect(await errorOf(db, asServer, `TRUNCATE public.${t} CASCADE`), t).toMatch(/permission denied/);
  });

  it('the owner creates, edits and deletes a card, and its history goes with it', async () => {
    const out = await asOwnerTx(async (tx) => {
      const id = (await tx.query<{ id: string }>(CREATE,
        createArgs({ title: 'Call back', contact: contactA, stage: 'waiting', priority: 'low', due: '2030-01-31' }))).rows[0].id;
      const { rows } = await tx.query<{ stage: string; work_item_type: string; priority: string }>(
        'SELECT stage, work_item_type, priority FROM public.work_items WHERE id = $1', [id]);
      await tx.query(`UPDATE public.work_items SET title = 'Call back today', priority = 'urgent', due_date = NULL, work_item_type = 'call' WHERE id = $1`, [id]);
      await tx.query(`SELECT public.add_work_item_note($1, 'Left a message')`, [id]);
      await tx.query('DELETE FROM public.work_items WHERE id = $1', [id]);
      await tx.exec('RESET ROLE');
      const left = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_item_events WHERE work_item_id = $1', [id])).rows[0].n;
      return { created: rows[0], left };
    });
    expect(out.created).toMatchObject({ stage: 'waiting', work_item_type: 'task', priority: 'low' });
    expect(out.left).toBe(0);
  });

  it('a contact delete takes its cards and their history', async () => {
    const left = await session(db, asServer, async (tx) => {
      await tx.query('DELETE FROM public.contacts WHERE id = $1', [contactB]);
      return {
        items: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_items WHERE id = $1', [doingItem])).rows[0].n,
        events: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_item_events WHERE work_item_id = $1', [doingItem])).rows[0].n,
      };
    });
    expect(left).toEqual({ items: 0, events: 0 });
  });
});

describe('columns a signed-in session cannot write', () => {
  const can = async (column: string, priv: 'INSERT' | 'UPDATE') =>
    (await db.query<{ ok: boolean }>(`SELECT has_column_privilege('authenticated', 'public.work_items', $1, $2) AS ok`, [column, priv])).rows[0].ok;

  const COLUMNS = ['id', 'contact_id', 'title', 'work_item_type', 'stage', 'priority', 'due_date', 'lane_position',
    'archived_at', 'restored_at', 'created_at', 'stage_updated_at'];

  it('no column is granted for insert; stage, lane place, restore stamp and timestamps are never granted for update', async () => {
    for (const c of COLUMNS) expect(await can(c, 'INSERT'), c).toBe(false);
    for (const c of ['stage', 'lane_position', 'restored_at', 'stage_updated_at', 'created_at', 'id']) expect(await can(c, 'UPDATE'), c).toBe(false);
    for (const c of ['title', 'contact_id', 'work_item_type', 'priority', 'due_date', 'archived_at']) expect(await can(c, 'UPDATE'), c).toBe(true);
  });

  it('the owner’s direct writes to those columns are refused', async () => {
    for (const set of [`stage = 'done'`, 'lane_position = 0', 'restored_at = now()', 'stage_updated_at = now()']) {
      await expectDenied(as(db, asOwner, `UPDATE public.work_items SET ${set} WHERE id = '${todoItem}'`));
    }
    await expectDenied(as(db, asOwner, `INSERT INTO public.work_items (title) VALUES ('x')`));
    await expectDenied(as(db, asOwner, `INSERT INTO public.work_items (title, stage) VALUES ('x', 'done')`));
    await expectDenied(as(db, asOwner,
      `INSERT INTO public.work_item_events (work_item_id, event_type) VALUES ('${todoItem}', 'note_added')`));
  });

  it('a title is required and at most 200 characters', async () => {
    expect(await errorOf(db, asOwner, CREATE, createArgs({ title: '   ' }))).toMatch(/check constraint/);
    expect(await errorOf(db, asOwner, CREATE, createArgs({ title: null }))).toMatch(/null value/);
    expect(await errorOf(db, asOwner, CREATE, createArgs({ title: 'x'.repeat(201) }))).toMatch(/check constraint/);
    expect(await errorOf(db, asOwner, CREATE, createArgs({ title: 'x'.repeat(200) }))).toBeNull();
  });

  it('priority is one of three; type and stage must exist', async () => {
    expect(await errorOf(db, asOwner, CREATE, createArgs({ priority: 'high' }))).toMatch(/check constraint/);
    expect(await errorOf(db, asOwner, CREATE, createArgs({ type: 'nope' }))).toMatch(/foreign key/);
    expect(await errorOf(db, asOwner, CREATE, createArgs({ stage: 'nope' }))).toMatch(/foreign key/);
  });
});

describe('create_work_item', () => {
  const created = (tx: Tx, id: string) =>
    tx.query('SELECT event_type, from_value, to_value, detail, actor_user_id FROM public.work_item_events WHERE work_item_id = $1', [id]);

  it('creates a card on the defaults and records where it started', async () => {
    const out = await asOwnerTx(async (tx) => {
      const id = (await tx.query<{ id: string }>(CREATE, createArgs({ note: '   ' }))).rows[0].id;
      const item = (await tx.query('SELECT stage, work_item_type, priority, lane_position FROM public.work_items WHERE id = $1', [id])).rows[0];
      return { item, events: (await created(tx, id)).rows };
    });
    expect(out.item).toEqual({ stage: 'todo', work_item_type: 'task', priority: 'normal', lane_position: null });
    expect(out.events).toEqual([{ event_type: 'created', from_value: null, to_value: 'todo', detail: null, actor_user_id: OWNER_ID }]);
  });

  it('a card started in Done says so in its history, with its starting note', async () => {
    const events = await asOwnerTx(async (tx) => {
      const id = (await tx.query<{ id: string }>(CREATE, createArgs({ stage: 'done', note: '  Already sent  ' }))).rows[0].id;
      return (await created(tx, id)).rows;
    });
    expect(events).toEqual([
      { event_type: 'created', from_value: null, to_value: 'done', detail: { note: 'Already sent' }, actor_user_id: OWNER_ID },
    ]);
  });

  it('a starting note is at most 2,000 characters, and an over-long one creates nothing', async () => {
    const out = await asOwnerTx(async (tx) => {
      const before = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_items')).rows[0].n;
      const error = await tryIn(tx, CREATE, createArgs({ note: 'x'.repeat(2001) }));
      const after = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_items')).rows[0].n;
      return { error, grew: after - before };
    });
    expect(out.error).toMatch(/work_item_events_note_length/);
    expect(out.grew).toBe(0);
  });

  it('anon cannot call it', async () => {
    expect(await errorOf(db, asAnon, CREATE, createArgs())).toMatch(/permission denied/);
  });
});

describe('move_work_item_stage', () => {
  it('refuses a blank reason', async () => {
    for (const note of ['', '   ', null]) {
      expect(await errorOf(db, asOwner, `SELECT public.move_work_item_stage($1, 'doing', $2, 'todo')`, [todoItem, note])).toMatch(/note_required/);
    }
  });

  it('refuses a card that has moved since the caller saw it, or does not exist', async () => {
    expect(await errorOf(db, asOwner, `SELECT public.move_work_item_stage($1, 'done', 'x', 'waiting')`, [todoItem])).toMatch(/move_rejected/);
    expect(await errorOf(db, asOwner, `SELECT public.move_work_item_stage($1, 'done', 'x', 'todo')`, [randomUUID()])).toMatch(/move_rejected/);
  });

  it('moves the card, records the reason and who gave it, and clears its old place', async () => {
    const out = await session(db, asServer, async (tx) => {
      await tx.query(`UPDATE public.work_items SET lane_position = 3, stage_updated_at = now() - interval '2 days' WHERE id = $1`, [todoItem]);
      await become(tx, asOwner);
      await tx.query(`SELECT public.move_work_item_stage($1, 'doing', '  Started work  ', 'todo')`, [todoItem]);
      const item = (await tx.query<{ stage: string; lane_position: number | null; fresh: boolean }>(
        `SELECT stage, lane_position, stage_updated_at > now() - interval '1 minute' AS fresh FROM public.work_items WHERE id = $1`, [todoItem])).rows[0];
      const events = (await tx.query(
        `SELECT event_type, from_value, to_value, detail, actor_user_id FROM public.work_item_events WHERE work_item_id = $1`, [todoItem])).rows;
      return { item, events };
    });
    expect(out.item).toEqual({ stage: 'doing', lane_position: null, fresh: true });
    expect(out.events).toEqual([
      { event_type: 'stage_changed', from_value: 'todo', to_value: 'doing', detail: { note: 'Started work' }, actor_user_id: OWNER_ID },
    ]);
  });

  it('a move to the stage it is already in writes nothing', async () => {
    const n = await asOwnerTx(async (tx) => {
      await tx.query(`SELECT public.move_work_item_stage($1, 'todo', 'x', 'todo')`, [todoItem]);
      return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.work_item_events WHERE work_item_id = $1', [todoItem])).rows[0].n;
    });
    expect(n).toBe(0);
  });

  it('an unknown stage is refused by the foreign key', async () => {
    expect(await errorOf(db, asOwner, `SELECT public.move_work_item_stage($1, 'nope', 'x', 'todo')`, [todoItem])).toMatch(/foreign key/);
  });

  it('refuses a client and a forged claim, and anon cannot call it', async () => {
    for (const who of [clientA, forger]) {
      expect(await errorOf(db, who, `SELECT public.move_work_item_stage($1, 'done', 'x')`, [todoItem])).toMatch(/forbidden/);
    }
    expect(await errorOf(db, asAnon, `SELECT public.move_work_item_stage($1, 'done', 'x')`, [todoItem])).toMatch(/permission denied/);
  });
});

describe('add_work_item_note', () => {
  it('writes a note with no stage ends', async () => {
    const rows = await asOwnerTx(async (tx) => {
      await tx.query(`SELECT public.add_work_item_note($1, 'Left a voicemail')`, [todoItem]);
      return (await tx.query(
        `SELECT event_type, from_value, to_value, detail, actor_user_id FROM public.work_item_events WHERE work_item_id = $1`, [todoItem])).rows;
    });
    expect(rows).toEqual([{ event_type: 'note_added', from_value: null, to_value: null, detail: { note: 'Left a voicemail' }, actor_user_id: OWNER_ID }]);
  });

  it('refuses a blank note and a missing card', async () => {
    expect(await errorOf(db, asOwner, `SELECT public.add_work_item_note($1, '  ')`, [todoItem])).toMatch(/note_required/);
    expect(await errorOf(db, asOwner, `SELECT public.add_work_item_note($1, 'x')`, [randomUUID()])).toMatch(/not_found/);
  });

  it('a note is at most 2,000 characters', async () => {
    expect(await errorOf(db, asOwner, `SELECT public.add_work_item_note($1, repeat('x', 2000))`, [todoItem])).toBeNull();
    expect(await errorOf(db, asOwner, `SELECT public.add_work_item_note($1, repeat('x', 2001))`, [todoItem]))
      .toMatch(/work_item_events_note_length/);
    expect(await errorOf(db, asOwner, `SELECT public.move_work_item_stage($1, 'doing', repeat('x', 2001), 'todo')`, [todoItem]))
      .toMatch(/work_item_events_note_length/);
  });

  it('refuses a client and a forged claim', async () => {
    for (const who of [clientA, forger]) {
      expect(await errorOf(db, who, `SELECT public.add_work_item_note($1, 'x')`, [todoItem])).toMatch(/forbidden/);
    }
  });
});

describe('archive and restore', () => {
  it('archiving leaves the restore stamp alone; restoring stamps it and clears the old place', async () => {
    const out = await session(db, asServer, async (tx) => {
      await tx.query('UPDATE public.work_items SET lane_position = 2 WHERE id = $1', [todoItem]);
      await become(tx, asOwner);
      await tx.query('UPDATE public.work_items SET archived_at = now() WHERE id = $1', [todoItem]);
      const archived = (await tx.query<{ restored_at: string | null; lane_position: number | null }>(
        'SELECT restored_at, lane_position FROM public.work_items WHERE id = $1', [todoItem])).rows[0];
      await tx.query('UPDATE public.work_items SET archived_at = NULL WHERE id = $1', [todoItem]);
      const restored = (await tx.query<{ restored_at: string | null; lane_position: number | null }>(
        'SELECT restored_at, lane_position FROM public.work_items WHERE id = $1', [todoItem])).rows[0];
      return { archived, restored };
    });
    expect(out.archived).toEqual({ restored_at: null, lane_position: 2 });
    expect(out.restored.restored_at).not.toBeNull();
    expect(out.restored.lane_position).toBeNull();
  });
});

describe('auto_archive_done_work_items', () => {
  it('archives Done cards 14 days after they entered Done or were last restored, and nothing else', async () => {
    const out = await session(db, asServer, async (tx) => {
      await tx.exec('RESET ROLE');
      const mk = async (stage: string, enteredAgo: string, restoredAgo: string | null, archived = false) =>
        (await tx.query<{ id: string }>(
          `INSERT INTO public.work_items (title, stage, stage_updated_at, restored_at, archived_at)
           VALUES ('x', $1, now() - $2::interval, now() - $3::interval, CASE WHEN $4 THEN now() - interval '1 year' END) RETURNING id`,
          [stage, enteredAgo, restoredAgo, archived])).rows[0].id;
      const stale = await mk('done', '15 days', null);
      const restoredRecently = await mk('done', '30 days', '1 day');
      const restoredLongAgo = await mk('done', '40 days', '20 days');
      const fresh = await mk('done', '13 days', null);
      const notDone = await mk('doing', '30 days', null);
      const alreadyArchived = await mk('done', '30 days', null, true);
      await become(tx, asServer);
      const archivedCount = (await tx.query<{ n: number }>('SELECT public.auto_archive_done_work_items() AS n')).rows[0].n;
      const state = async (id: string) =>
        (await tx.query<{ a: string | null; old: boolean }>(
          `SELECT archived_at AS a, archived_at < now() - interval '1 day' AS old FROM public.work_items WHERE id = $1`, [id])).rows[0];
      return {
        archivedCount,
        stale: (await state(stale)).a !== null,
        restoredRecently: (await state(restoredRecently)).a !== null,
        restoredLongAgo: (await state(restoredLongAgo)).a !== null,
        fresh: (await state(fresh)).a !== null,
        notDone: (await state(notDone)).a !== null,
        alreadyArchivedUntouched: (await state(alreadyArchived)).old,
      };
    });
    // The seeded Done card (created now) is not old enough either.
    expect(out).toEqual({
      archivedCount: 2,
      stale: true,
      restoredRecently: false,
      restoredLongAgo: true,
      fresh: false,
      notDone: false,
      alreadyArchivedUntouched: true,
    });
  });

  it('is the server’s alone', async () => {
    for (const who of [asOwner, clientA, asAnon]) {
      expect(await errorOf(db, who, 'SELECT public.auto_archive_done_work_items()')).toMatch(/permission denied/);
    }
    expect(await errorOf(db, asServer, 'SELECT public.auto_archive_done_work_items()')).toBeNull();
  });
});

describe('reorder_board_lane', () => {
  /** Inside a server session: four cards in `todo` (a, b, c, then d unplaced) and one in `doing`. */
  async function lane(tx: Tx) {
    await tx.exec('RESET ROLE');
    const mk = async (stage = 'todo') =>
      (await tx.query<{ id: string }>(`INSERT INTO public.work_items (title, stage) VALUES ('x', $1) RETURNING id`, [stage])).rows[0].id;
    const ids = { a: await mk(), b: await mk(), c: await mk(), d: await mk(), elsewhere: await mk('doing') };
    await tx.exec(`DELETE FROM public.work_item_events; UPDATE public.work_items SET lane_position = NULL`);
    return ids;
  }
  const positions = async (tx: Tx) =>
    Object.fromEntries((await tx.query<{ id: string; lane_position: number | null }>(
      `SELECT id, lane_position FROM public.work_items WHERE stage = 'todo' AND archived_at IS NULL`)).rows.map((r) => [r.id, r.lane_position]));
  const reorder = (tx: Tx, stage: string, ids: (string | null)[]) => tx.query('SELECT public.reorder_board_lane($1, $2::uuid[])', [stage, ids]);

  it('places the submitted cards in order and skips a card from another lane', async () => {
    const out = await session(db, asServer, async (tx) => {
      const ids = await lane(tx);
      await become(tx, asOwner);
      await reorder(tx, 'todo', [ids.c, ids.a, ids.elsewhere, ids.b]);
      const p = await positions(tx);
      const elsewhere = await stageOf(tx, ids.elsewhere);
      return { order: [p[ids.c], p[ids.a], p[ids.b], p[ids.d]], elsewhere };
    });
    expect(out.order).toEqual([0, 1, 2, null]);
    expect(out.elsewhere).toEqual({ stage: 'doing', lane_position: null });
  });

  it('a card new to the lane takes the top; submitted cards refill their own slots; one left out keeps its slot', async () => {
    const out = await session(db, asServer, async (tx) => {
      const ids = await lane(tx);
      await become(tx, asOwner);
      await reorder(tx, 'todo', [ids.a, ids.b, ids.c]);
      // d is new to the lane; b is left out; a and c swap.
      await reorder(tx, 'todo', [ids.d, ids.c, ids.a]);
      const p = await positions(tx);
      return [ids.d, ids.c, ids.b, ids.a].map((id) => p[id]);
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('never puts back a card that moved to another lane in the meantime', async () => {
    const out = await session(db, asServer, async (tx) => {
      const ids = await lane(tx);
      await become(tx, asOwner);
      await reorder(tx, 'todo', [ids.a, ids.b]);
      await tx.query(`SELECT public.move_work_item_stage($1, 'doing', 'Started work', 'todo')`, [ids.a]);
      // A second tab still shows a in the lane it left.
      await reorder(tx, 'todo', [ids.b, ids.a]);
      return { a: await stageOf(tx, ids.a), b: await stageOf(tx, ids.b) };
    });
    expect(out.a).toEqual({ stage: 'doing', lane_position: null });
    expect(out.b).toEqual({ stage: 'todo', lane_position: 0 });
  });

  it('skips an archived card', async () => {
    const out = await session(db, asServer, async (tx) => {
      const ids = await lane(tx);
      await tx.query('UPDATE public.work_items SET archived_at = now() WHERE id = $1', [ids.a]);
      await become(tx, asOwner);
      await reorder(tx, 'todo', [ids.a, ids.b]);
      return { a: await stageOf(tx, ids.a), b: await stageOf(tx, ids.b) };
    });
    expect(out.a.lane_position).toBeNull();
    expect(out.b.lane_position).toBe(0);
  });

  it('refuses a list naming a card twice, or a NULL, and changes nothing', async () => {
    const out = await session(db, asServer, async (tx) => {
      const ids = await lane(tx);
      await become(tx, asOwner);
      const twice = await tryIn(tx, 'SELECT public.reorder_board_lane($1, $2::uuid[])', ['todo', [ids.a, ids.b, ids.a]]);
      const withNull = await tryIn(tx, 'SELECT public.reorder_board_lane($1, $2::uuid[])', ['todo', [ids.a, null]]);
      const p = await positions(tx);
      return { twice, withNull, placed: Object.values(p).filter((v) => v !== null).length };
    });
    expect(out.twice).toMatch(/invalid_cards/);
    expect(out.withNull).toMatch(/invalid_cards/);
    expect(out.placed).toBe(0);
  });

  it('takes a list of 2,000 ids and refuses 2,001', async () => {
    const ids = Array.from({ length: 2001 }, () => randomUUID());
    expect(await errorOf(db, asOwner, 'SELECT public.reorder_board_lane($1, $2::uuid[])', ['todo', ids.slice(0, 2000)])).toBeNull();
    expect(await errorOf(db, asOwner, 'SELECT public.reorder_board_lane($1, $2::uuid[])', ['todo', ids])).toMatch(/invalid_cards/);
  });

  it('refuses an unknown lane, a missing list, a client and a forged claim', async () => {
    expect(await errorOf(db, asOwner, `SELECT public.reorder_board_lane('nope', '{}'::uuid[])`)).toMatch(/invalid_stage/);
    expect(await errorOf(db, asOwner, `SELECT public.reorder_board_lane('todo', NULL)`)).toMatch(/invalid_cards/);
    for (const who of [clientA, forger]) {
      expect(await errorOf(db, who, `SELECT public.reorder_board_lane('todo', $1::uuid[])`, [[todoItem]])).toMatch(/forbidden/);
    }
    expect(await errorOf(db, asAnon, `SELECT public.reorder_board_lane('todo', '{}'::uuid[])`)).toMatch(/permission denied/);
  });
});

describe('the board pick-lists', () => {
  it('the owner renames, recolours and reorders a stage', async () => {
    const rows = await as<{ label: string }>(db, asOwner,
      `UPDATE public.board_stages SET label = 'Next up', colour = '#336699', sort_order = 5 WHERE key = 'todo' RETURNING label`);
    expect(rows).toEqual([{ label: 'Next up' }]);
  });

  it('a colour is a six-digit hex colour or nothing, on stages and types alike', async () => {
    for (const t of ['board_stages', 'work_item_types']) {
      // Lowercase only, the same rule as the 0002 pick-lists and the frontend's colour check.
      for (const bad of ['red', '#336', '#3366999', '336699', 'url(x)', '#33669g', '#ABCDEF']) {
        expect(await errorOf(db, asOwner, `UPDATE public.${t} SET colour = $1 WHERE key IN ('todo', 'call')`, [bad]), `${t} ${bad}`)
          .toMatch(/check constraint/);
      }
      for (const good of ['#abcdef', null]) {
        expect(await errorOf(db, asOwner, `UPDATE public.${t} SET colour = $1 WHERE key IN ('todo', 'call')`, [good]), `${t} ${good}`).toBeNull();
      }
    }
    expect(await errorOf(db, asOwner, `INSERT INTO public.work_item_types (key, label, colour) VALUES ('review', 'Review', 'blue')`))
      .toMatch(/check constraint/);
  });

  it('the stages are a fixed set: no key change, no new stage, no delete, for anyone', async () => {
    await expectDenied(as(db, asOwner, `INSERT INTO public.board_stages (key, label) VALUES ('later', 'Later')`));
    await expectDenied(as(db, asOwner, `DELETE FROM public.board_stages WHERE key = 'waiting'`));
    await expectDenied(as(db, asOwner, `UPDATE public.board_stages SET key = 'later' WHERE key = 'waiting'`));
    await expectDenied(as(db, asServer, `INSERT INTO public.board_stages (key, label) VALUES ('later', 'Later')`));
    await expectDenied(as(db, asServer, `DELETE FROM public.board_stages WHERE key = 'waiting'`));
    await expectDenied(as(db, asServer, `UPDATE public.board_stages SET key = 'later' WHERE key = 'waiting'`));
  });

  it('the owner adds a type, retires it, and deletes it while unused', async () => {
    const out = await asOwnerTx(async (tx) => {
      await tx.exec(`INSERT INTO public.work_item_types (key, label) VALUES ('review', 'Review')`);
      await tx.exec(`UPDATE public.work_item_types SET is_active = false WHERE key = 'review'`);
      return (await tx.query('DELETE FROM public.work_item_types WHERE key = $1 RETURNING key', ['review'])).rows;
    });
    expect(out).toEqual([{ key: 'review' }]);
  });

  it('a type in use cannot be deleted, and the system type never can', async () => {
    const inUse = await asOwnerTx(async (tx) => {
      await tx.query(CREATE, createArgs({ type: 'call' }));
      return tryIn(tx, `DELETE FROM public.work_item_types WHERE key = 'call'`);
    });
    expect(inUse).toMatch(/foreign key/);
    expect(await as(db, asOwner, `DELETE FROM public.work_item_types WHERE key = 'task' RETURNING key`)).toEqual([]);
    await expectDenied(as(db, asServer, `DELETE FROM public.work_item_types WHERE key = 'task'`));
    await expectDenied(as(db, asOwner, `INSERT INTO public.work_item_types (key, label, is_system) VALUES ('mine', 'Mine', true)`));
    await expectDenied(as(db, asOwner, `UPDATE public.work_item_types SET is_system = false WHERE key = 'task'`));
    await expectDenied(as(db, asOwner, `UPDATE public.work_item_types SET key = 'job' WHERE key = 'call'`));
  });
});
