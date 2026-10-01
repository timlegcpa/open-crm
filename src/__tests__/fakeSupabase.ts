/**
 * An in-memory stand-in for the Supabase browser client, for API and screen tests.
 *
 * It keeps one array of rows per table, applies the filters the app uses (eq, gt, in,
 * or), and records every executed request as a `Call` so a test can assert the exact
 * payload a write sent. Errors are injected per `table:op`, per RPC, or per function.
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
  type: 'eq' | 'gt' | 'in' | 'or';
  column?: string;
  value?: unknown;
}

export interface Call {
  table: string;
  op: Op;
  payload?: unknown;
  columns?: string;
  filters: Filter[];
}

type Result = { data: unknown; error: unknown };

export interface FakeSession {
  user: { id: string; email: string; factors?: Array<{ id: string; status: string }> };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `ffffffff-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.type === 'eq') return row[f.column!] === f.value;
    if (f.type === 'gt') return String(row[f.column!]) > String(f.value);
    if (f.type === 'in') return (f.value as unknown[]).includes(row[f.column!]);
    // or: "a.eq.X,b.eq.Y" — the only shape the app sends.
    return String(f.value)
      .split(',')
      .some((clause) => {
        const [column, op, ...rest] = clause.split('.');
        return op === 'eq' && row[column] === rest.join('.');
      });
  });
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
  private shape: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly table: string) {}

  select(columns: string) {
    if (this.op === null) this.op = 'select';
    else this.returning = true;
    this.columns = columns;
    return this;
  }
  insert(payload: unknown) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: unknown) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push({ type: 'eq', column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ type: 'gt', column, value }); return this; }
  in(column: string, value: unknown[]) { this.filters.push({ type: 'in', column, value }); return this; }
  or(value: string) { this.filters.push({ type: 'or', value }); return this; }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
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
      // PostgREST's max_rows (supabase/config.toml): a select never returns more, asked or not.
      out = out.slice(0, Math.min(this.max ?? MAX_ROWS, MAX_ROWS));
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
    const copies = out.map((r) => ({ ...r }));
    if (this.shape === 'many') return { data: copies, error: null };
    if (this.shape === 'maybeSingle') return { data: copies[0] ?? null, error: null };
    return copies.length === 1
      ? { data: copies[0], error: null }
      : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
  }
}

const client = {
  from: (table: string) => new Query(table),
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
