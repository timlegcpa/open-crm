// The job kinds the job-runner knows, and where each one goes. A kind is the jobs row's
// `provider:action`. Dependency-free, so the owner's Jobs page can name the same list
// (src/features/ops/labels.ts holds the labels; a test pins the two together).
//
// Each kind declares the payload it takes (PayloadSchema: field name to type). The runner
// refuses a job whose payload has any other field, or a field of another type: the job
// fails and the callee is never called. Every current kind takes an empty payload. A
// callee still treats the payload as untrusted input: it arrives with the cron secret,
// but a jobs row is data, and its checks are the callee's own.
//
// A kind that routes to an edge function POSTs the job's payload to it with the cron
// secret. Every such function (the callee) must:
//   1. accept auth { cron: { secret }, owner }, POST, body optional_json (scheduled kinds
//      carry an empty payload);
//   2. be safe to run twice: execution is at least once, because a claim's lease (300 s)
//      outlives the edge wall clock, so a tick killed mid-job reruns that job later;
//   3. answer 2xx with JSON of counts and ids only: it is stored in jobs.result, kept for
//      30 days and shown to the owner;
//   4. treat "nothing to do" as success, and tally an expected per-item refusal inside a
//      fan-out as skipped, not as a failure of the whole job.
// A function that does not exist yet answers 404, so its job fails and retries like any
// other failure; the runner itself never breaks over it.
//
// A kind that routes to SQL calls server-only retention functions through the service
// client, in order, and stores what each returned.

/** The fields a kind's payload may carry, each optional, by type. */
export type PayloadSchema = Readonly<Record<string, 'uuid' | 'code' | 'integer' | 'boolean'>>;

export type JobRoute =
  | { kind: 'function'; name: string; payload: PayloadSchema }
  | { kind: 'sql'; functions: readonly string[]; payload: PayloadSchema };

export const JOB_ROUTES = {
  'esign:expire_envelopes': { kind: 'function', name: 'esign-expire-envelopes', payload: {} },
  'needs:reminder_dispatch': { kind: 'function', name: 'needs-reminder-dispatcher', payload: {} },
  'portal:daily_digest': { kind: 'function', name: 'send-portal-digest', payload: {} },
  'ops:maintenance': {
    kind: 'sql',
    functions: ['cleanup_core_operational_rows', 'cleanup_aged_audit_logs', 'cleanup_aged_client_activity', 'cleanup_read_client_messages', 'auto_archive_done_work_items', 'cleanup_stale_start_links'],
    payload: {},
  },
} as const satisfies Record<string, JobRoute>;

const PAYLOAD_TYPES: Record<PayloadSchema[string], (v: unknown) => boolean> = {
  uuid: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  code: (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(v),
  integer: (v) => Number.isSafeInteger(v),
  boolean: (v) => typeof v === 'boolean',
};

/** True when `payload` (null counts as empty) carries only the schema's fields, each of its type. */
export function payloadMatches(schema: PayloadSchema, payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.entries(payload).every(([key, value]) => Object.hasOwn(schema, key) && PAYLOAD_TYPES[schema[key]](value));
}

export type JobKind = keyof typeof JOB_ROUTES;

export const JOB_KINDS = Object.keys(JOB_ROUTES) as JobKind[];

/** The route for `provider:action`, or null for a kind this runner does not know. */
export function routeFor(kind: string): JobRoute | null {
  return Object.hasOwn(JOB_ROUTES, kind) ? JOB_ROUTES[kind as JobKind] : null;
}
