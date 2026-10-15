/**
 * A small in-memory Supabase client for the messages tests: the query builder calls this
 * feature makes (eq, gt, in, is, order, limit, a head count, single, maybeSingle), RPCs by
 * name, realtime channels and the auth listener. Every executed request is recorded so a
 * test can assert the exact payload a write sent.
 *
 *   vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
 *   import { fake } from './fakeClient';   // fake.reset() in beforeEach
 */
type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';
type Result = { data: unknown; error: unknown; count?: number | null };

interface Filter {
  type: 'eq' | 'gt' | 'in' | 'is';
  column: string;
  value: unknown;
}

export interface Call {
  table: string;
  op: Op;
  payload?: unknown;
  columns?: string;
  filters: Filter[];
  head: boolean;
}

function createState() {
  return {
    tables: {} as Record<string, Row[]>,
    calls: [] as Call[],
    /** Errors to return, in turn, per `table:op` (a queue, so a retry can succeed). */
    errors: {} as Record<string, unknown[]>,
    /** Per `table:op`: the request waits for this promise (to hold one in flight). */
    holds: {} as Record<string, Promise<void>>,
    rpc: {} as Record<string, (args: unknown) => Result>,
    rpcCalls: [] as Array<{ name: string; args: unknown }>,
    channels: [] as Array<{ name: string; config: Record<string, unknown>; handler: () => void; removed: boolean }>,
    removed: 0,
    authListeners: [] as Array<(event: string, session: { user: { id: string } } | null) => void>,
  };
}

const state = createState();
let ids = 0;

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.type === 'eq') return row[f.column] === f.value;
    if (f.type === 'gt') return String(row[f.column]) > String(f.value);
    if (f.type === 'in') return (f.value as unknown[]).includes(row[f.column]);
    return (row[f.column] ?? null) === f.value;
  });
}

class Query implements PromiseLike<Result> {
  private op: Op | null = null;
  private payload: unknown;
  private columns: string | undefined;
  private returning = false;
  private head = false;
  private filters: Filter[] = [];
  private orderBy: string | null = null;
  private max = 1000;
  private shape: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly table: string) {}

  select(columns: string, options?: { head?: boolean }) {
    if (this.op === null) this.op = 'select';
    else this.returning = true;
    this.columns = columns;
    this.head = options?.head === true;
    return this;
  }
  insert(payload: unknown) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: unknown) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push({ type: 'eq', column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ type: 'gt', column, value }); return this; }
  in(column: string, value: unknown[]) { this.filters.push({ type: 'in', column, value }); return this; }
  is(column: string, value: unknown) { this.filters.push({ type: 'is', column, value }); return this; }
  order(column: string) { this.orderBy = column; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.shape = 'single'; return this; }
  maybeSingle() { this.shape = 'maybeSingle'; return this; }
  returns() { return this; }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(state.holds[`${this.table}:${this.op ?? 'select'}`])
      .then(() => this.execute())
      .then(onFulfilled, onRejected);
  }

  private execute(): Result {
    const op = this.op ?? 'select';
    state.calls.push({ table: this.table, op, payload: this.payload, columns: this.columns, filters: this.filters, head: this.head });
    const queued = state.errors[`${this.table}:${op}`];
    if (queued && queued.length > 0) return { data: null, error: queued.shift() };

    const rows = (state.tables[this.table] ??= []);
    let out: Row[];
    if (op === 'select') {
      out = rows.filter((r) => matches(r, this.filters));
      if (this.head) return { data: null, error: null, count: out.length };
      if (this.orderBy) {
        const col = this.orderBy;
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0));
      }
      out = out.slice(0, this.max);
    } else if (op === 'insert') {
      ids += 1;
      out = [{ id: `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`, created_at: new Date().toISOString(), ...(this.payload as Row) }];
      rows.push(...out);
    } else if (op === 'update') {
      out = rows.filter((r) => matches(r, this.filters));
      out.forEach((r) => Object.assign(r, this.payload as Row));
    } else {
      out = rows.filter((r) => matches(r, this.filters));
      state.tables[this.table] = rows.filter((r) => !out.includes(r));
    }

    if (op !== 'select' && !this.returning) return { data: null, error: null };
    const copies = out.map((r) => ({ ...r }));
    if (this.shape === 'many') return { data: copies, error: null };
    if (this.shape === 'maybeSingle') return { data: copies[0] ?? null, error: null };
    return copies.length === 1 ? { data: copies[0], error: null } : { data: null, error: { message: 'not one row' } };
  }
}

const client = {
  from: (table: string) => new Query(table),
  rpc: async (name: string, args?: unknown): Promise<Result> => {
    state.rpcCalls.push({ name, args });
    const handler = state.rpc[name];
    return handler ? handler(args) : { data: null, error: null };
  },
  channel: (name: string) => {
    const entry = { name, config: {} as Record<string, unknown>, handler: () => {}, removed: false };
    state.channels.push(entry);
    const channel = {
      entry,
      on: (_type: string, config: Record<string, unknown>, handler: () => void) => {
        entry.config = config;
        entry.handler = handler;
        return channel;
      },
      subscribe: () => channel,
    };
    return channel;
  },
  removeChannel: async (channel: { entry: { removed: boolean } }) => {
    channel.entry.removed = true;
    state.removed += 1;
    return 'ok';
  },
  auth: {
    onAuthStateChange: (cb: (event: string, session: { user: { id: string } } | null) => void) => {
      state.authListeners.push(cb);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
  },
};

export const fake = {
  state,
  client,
  reset() {
    // Auth listeners belong to modules loaded once per file; they survive a reset.
    const listeners = state.authListeners;
    Object.assign(state, createState(), { authListeners: listeners });
  },
  calls(table: string, op?: Op): Call[] {
    return state.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
  },
  /**
   * Delivers a realtime change as the server would: to each live channel whose event matches
   * and whose filter, if any, names this contact (a delete carries no contact, so a filtered
   * channel never gets one).
   */
  emitChange(event: 'INSERT' | 'UPDATE' | 'DELETE', contactId: string | null) {
    for (const c of state.channels) {
      if (c.removed) continue;
      if (c.config.event !== '*' && c.config.event !== event) continue;
      const filter = c.config.filter as string | undefined;
      if (filter && (event === 'DELETE' || filter !== `contact_id=eq.${contactId}`)) continue;
      c.handler();
    }
  },
  /** Fires an auth event at every listener, as supabase-js does. */
  emitAuth(event: string, userId: string | null) {
    state.authListeners.forEach((cb) => cb(event, userId ? { user: { id: userId } } : null));
  },
};

export const supabaseModule = {
  supabaseConfigured: true,
  getSupabase: () => client,
};
