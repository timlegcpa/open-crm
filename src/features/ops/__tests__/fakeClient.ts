/**
 * A recording stand-in for the Supabase browser client, for the System pages' tests. Each
 * `from(table)` chain records every method called on it with its arguments and resolves to
 * the answer set for that table (rows, an error, a count). The shared fakeSupabase has no
 * range, lt, gte or not, which these lists need.
 *
 *   vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
 */

type Answer = { data?: unknown; error?: unknown; count?: number | null };

export interface Chain {
  table: string;
  calls: Array<[method: string, ...args: unknown[]]>;
}

const state = {
  answers: {} as Record<string, Answer | ((chain: Chain) => Answer)>,
  rpc: {} as Record<string, Answer>,
  chains: [] as Chain[],
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
};

function builder(table: string) {
  const chain: Chain = { table, calls: [] };
  state.chains.push(chain);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          const set = state.answers[table];
          const answer = typeof set === 'function' ? set(chain) : (set ?? { data: [] });
          const result = { data: answer.data ?? null, error: answer.error ?? null, count: answer.count ?? null };
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          chain.calls.push([prop, ...args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

export const client = {
  from: (table: string) => builder(table),
  rpc: async (name: string, args?: unknown) => {
    state.rpcCalls.push({ name, args });
    const a = state.rpc[name] ?? {};
    return { data: a.data ?? null, error: a.error ?? null };
  },
};

export const fakeClient = {
  state,
  reset() {
    state.answers = {};
    state.rpc = {};
    state.chains = [];
    state.rpcCalls = [];
  },
  /** Every chain run against `table`. */
  chains: (table: string) => state.chains.filter((c) => c.table === table),
  /** The arguments of each call of `method` in a chain. */
  argsOf: (chain: Chain, method: string) => chain.calls.filter(([m]) => m === method).map(([, ...args]) => args),
};

export const supabaseModule = {
  supabaseConfigured: true,
  getSupabase: () => client,
};
