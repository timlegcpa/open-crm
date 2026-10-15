/**
 * An in-memory stand-in for the Supabase browser client, for API and screen tests.
 *
 * It keeps one array of rows per table, applies the filters the app uses (eq, gt, lt, in,
 * is, not, or), ordering, limit and range, answers a `{ count: 'exact', head: true }`
 * select with a count and no rows, and records every executed request as a `Call` so a
 * test can assert the exact payload a write sent. Realtime channels are recorded in
 * `state.channels` (removed ones flagged). Errors are injected per `table:op`, per RPC, or
 * per function.
 *
 * Use it from a test file with:
 *   vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);
 *   import { fake } from '@/__tests__/fakeSupabase';
 * and call `fake.reset()` in beforeEach.
 */

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';

const MAX_ROWS = 1000;

interface Filter {
  type: 'eq' | 'gt' | 'lt' | 'in' | 'is' | 'not' | 'or';
  column?: string;
  value?: unknown;
  /** For `not`: the negated operator ('eq', 'is' or 'in'). */
  op?: string;
}

export interface Call {
  table: string;
  op: Op;
  payload?: unknown;
  columns?: string;
  filters: Filter[];
}

type Result = { data: unknown; error: unknown; count?: number | null };

export interface FakeSession {
  user: { id: string; email: string; factors?: Array<{ id: string; status: string }> };
}

export interface FakeChannelEntry {
  name: string;
  config: Record<string, unknown>;
  handler: (payload: unknown) => void;
  removed: boolean;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `ffffffff-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

/** `not(column, 'in', '(a,b)')` takes PostgREST's list text; `in(column, [...])` takes an array. */
function inList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return String(value).replace(/^\(|\)$/g, '').split(',').map((v) => v.trim());
}

function matchesOne(row: Row, f: Filter): boolean {
  const cell = row[f.column!];
  if (f.type === 'eq') return cell === f.value;
  if (f.type === 'gt') return String(cell) > String(f.value);
  if (f.type === 'lt') return String(cell) < String(f.value);
  if (f.type === 'in') return inList(f.value).includes(cell);
  // is: null or a boolean; a column the row does not carry reads as null.
  if (f.type === 'is') return (cell ?? null) === f.value;
  if (f.type === 'not') {
    if (f.op !== 'eq' && f.op !== 'is' && f.op !== 'in') throw new Error(`fakeSupabase: not(${f.op}) is not supported`);
    return !matchesOne(row, { type: f.op, column: f.column, value: f.value });
  }
  // or: "a.eq.X,b.eq.Y", the only shape the app sends.
  return String(f.value)
    .split(',')
    .some((clause) => {
      const [column, op, ...rest] = clause.split('.');
      return op === 'eq' && row[column] === rest.join('.');
    });
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => matchesOne(row, f));
}

function withGenerated(table: string, row: Row): Row {
  const out: Row = { id: nextId(), created_at: new Date().toISOString(), ...row };
  if (table === 'contacts') {
    const first = String(out.first_name ?? '');
    const last = String(out.last_name ?? '');
    out.full_name = last === '' ? first : `${first} ${last}`;
  }
  return out;
}

function createState() {
  return {
    tables: {} as Record<string, Row[]>,
    calls: [] as Call[],
    /** Keyed `table:op`, e.g. `contacts:update`. */
    errors: {} as Record<string, unknown>,
    /** Keyed `table:op`: the request waits for this promise, to test edits made while it is in flight. */
    holds: {} as Record<string, Promise<void>>,
    rpcCalls: [] as Array<{ name: string; args: unknown }>,
    rpcErrors: {} as Record<string, unknown>,
    invokeCalls: [] as Array<{ name: string; body: unknown }>,
    /** Per contact_id answer for `delete-contact`; default is `{ deleted: true }`. */
    invokeResults: {} as Record<string, Result>,
    session: null as FakeSession | null,
    isOwner: { data: true as unknown, error: null as unknown },
    listeners: [] as Array<(event: string, s: FakeSession | null) => void>,
    /** Every realtime channel opened, with its last `on` config; `removed` once removeChannel ran. */
    channels: [] as FakeChannelEntry[],
  };
}

const state = createState();

class Query implements PromiseLike<Result> {
  private op: Op | null = null;
  private payload: unknown;
  private columns: string | undefined;
  private returning = false;
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private max: number | null = null;
  private window: { from: number; to: number } | null = null;
  private countMode: string | null = null;
  private head = false;
  private shape: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly table: string) {}

  select(columns: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    if (this.op === null) this.op = 'select';
    else this.returning = true;
    this.columns = columns;
    this.countMode = options?.count ?? null;
    this.head = options?.head ?? false;
    return this;
  }
  insert(payload: unknown) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: unknown) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push({ type: 'eq', column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ type: 'gt', column, value }); return this; }
  lt(column: string, value: unknown) { this.filters.push({ type: 'lt', column, value }); return this; }
  is(column: string, value: null | boolean) { this.filters.push({ type: 'is', column, value }); return this; }
  not(column: string, op: string, value: unknown) { this.filters.push({ type: 'not', column, op, value }); return this; }
  in(column: string, value: unknown[]) { this.filters.push({ type: 'in', column, value }); return this; }
  or(value: string) { this.filters.push({ type: 'or', value }); return this; }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(n: number) { this.max = n; return this; }
  /** Rows `from` to `to`, both inclusive and zero-based, as PostgREST's Range header. */
  range(from: number, to: number) { this.window = { from, to }; return this; }
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
    state.calls.push({ table: this.table, op, payload: this.payload, columns: this.columns, filters: this.filters });
    const injected = state.errors[`${this.table}:${op}`];
    if (injected) return { data: null, error: injected };

    const rows = (state.tables[this.table] ??= []);
    let out: Row[] = [];
    if (op === 'select') {
      out = rows.filter((r) => matches(r, this.filters));
      for (const { column, ascending } of [...this.orders].reverse()) {
        out.sort((a, b) => {
          const x = String(a[column] ?? '');
          const y = String(b[column] ?? '');
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      const total = out.length;
      if (this.window) out = out.slice(this.window.from, this.window.to + 1);
      // PostgREST's max_rows (supabase/config.toml): a select never returns more, asked or not.
      out = out.slice(0, Math.min(this.max ?? MAX_ROWS, MAX_ROWS));
      if (this.head) return { data: null, error: null, count: this.countMode ? total : null };
      if (this.countMode) return this.shaped(out, total);
    } else if (op === 'insert') {
      const list = Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row];
      out = list.map((r) => withGenerated(this.table, r));
      rows.push(...out);
    } else if (op === 'update') {
      out = rows.filter((r) => matches(r, this.filters));
      out.forEach((r) => Object.assign(r, this.payload as Row));
    } else {
      out = rows.filter((r) => matches(r, this.filters));
      state.tables[this.table] = rows.filter((r) => !out.includes(r));
    }

    if (op !== 'select' && !this.returning) return { data: null, error: null };
    return this.shaped(out);
  }

  private shaped(out: Row[], count?: number): Result {
    const withCount = (r: Result): Result => (count === undefined ? r : { ...r, count });
    const copies = out.map((r) => ({ ...r }));
    if (this.shape === 'many') return withCount({ data: copies, error: null });
    if (this.shape === 'maybeSingle') return withCount({ data: copies[0] ?? null, error: null });
    return copies.length === 1
      ? withCount({ data: copies[0], error: null })
      : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
  }
}

interface FakeChannel {
  entry: FakeChannelEntry;
  on(type: string, config: Record<string, unknown>, handler: (payload: unknown) => void): FakeChannel;
  subscribe(callback?: (status: string) => void): FakeChannel;
}

const client = {
  from: (table: string) => new Query(table),
  channel: (name: string): FakeChannel => {
    const entry: FakeChannelEntry = { name, config: {}, handler: () => {}, removed: false };
    state.channels.push(entry);
    const channel: FakeChannel = {
      entry,
      on(_type, config, handler) {
        entry.config = config;
        entry.handler = handler;
        return channel;
      },
      subscribe(callback) {
        callback?.('SUBSCRIBED');
        return channel;
      },
    };
    return channel;
  },
  removeChannel: async (channel: FakeChannel) => {
    channel.entry.removed = true;
    return 'ok' as const;
  },
  rpc: async (name: string, args?: unknown): Promise<Result> => {
    state.rpcCalls.push({ name, args });
    if (name === 'get_org_branding') return { data: { display_name: 'Example Org' }, error: null };
    if (name === 'is_owner') return state.isOwner as Result;
    if (state.rpcErrors[name]) return { data: null, error: state.rpcErrors[name] };
    return { data: null, error: null };
  },
  functions: {
    invoke: async (name: string, options: { body: { contact_id: string } }): Promise<Result> => {
      state.invokeCalls.push({ name, body: options.body });
      return state.invokeResults[options.body.contact_id] ?? { data: { deleted: true }, error: null };
    },
  },
  auth: {
    getSession: async () => ({ data: { session: state.session } }),
    onAuthStateChange: (cb: (event: string, s: FakeSession | null) => void) => {
      state.listeners.push(cb);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    signOut: async () => {
      state.session = null;
      state.listeners.forEach((cb) => cb('SIGNED_OUT', null));
      return { error: null };
    },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' }, error: null }),
    },
  },
};

/** A non-2xx edge-function answer, shaped like supabase-js's FunctionsHttpError. */
export function functionsHttpError(status: number, body: unknown) {
  return {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  };
}

export const fake = {
  state,
  client,
  reset() {
    Object.assign(state, createState());
  },
  /** Executed requests against one table and op. */
  calls(table: string, op?: Op): Call[] {
    return state.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
  },
};

export const supabaseModule = {
  supabaseConfigured: true,
  getSupabase: () => client,
};
