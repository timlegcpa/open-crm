/**
 * THE contact-status taxonomy: which keys exist and what each group of them means. Labels,
 * colours and order are the owner's, read from `contact_statuses` (useContactStatuses);
 * the keys are fixed by 0002_contacts.sql, so code may branch on them here and only here.
 *
 * Never re-inline a status list in a feature: import a set or a predicate. A hand-copied
 * list drifts, and a drifted list silently refuses or hides a real status.
 *
 * The sets are NOT interchangeable, and src/lib/__tests__/contactStatus.test.ts asserts the
 * relations between them, not equality: STORED holds a value SELECTABLE must never offer
 * (the owner must not hand-set `esign_signer` from a dropdown). Do not add a second,
 * parallel status column to express a distinction: put it here.
 */

/** Every key in `contact_statuses`, in the seed's display order. */
export const STORED_STATUSES = [
  'new_lead',
  'active_lead',
  'hot',
  'warm',
  'cold',
  'client',
  'one_time',
  'former_client',
  'lost',
  'esign_signer',
] as const;

export type ContactStatusKey = (typeof STORED_STATUSES)[number];

/**
 * Written only by code: the e-signature flow gives `esign_signer` to a contact created only
 * to sign. Left out of every status dropdown, but still searched and still rendered, so such
 * a contact is never invisible.
 */
export const SYSTEM_STATUSES = ['esign_signer'] as const;

/** Offered in the owner's status dropdowns: every stored status except the system ones. */
export const SELECTABLE_STATUSES = [
  'new_lead',
  'active_lead',
  'hot',
  'warm',
  'cold',
  'client',
  'one_time',
  'former_client',
  'lost',
] as const;

/**
 * Prospects being actively worked: a lead arrives (`new_lead`), the owner reaches out and
 * books a call (`active_lead`, one stage for both), and after the call it is hot or warm.
 * `cold` is not here: it is the back burner, so it stays out of every active rollup. The
 * pipeline board shows it anyway (PIPELINE_STATUSES).
 */
export const LEAD_LIKE_STATUSES = ['new_lead', 'active_lead', 'hot', 'warm'] as const;
export type LeadLikeStatus = (typeof LEAD_LIKE_STATUSES)[number];

/** The pipeline board's columns, in order: every open stage plus `cold`. */
export const PIPELINE_STATUSES = [...LEAD_LIKE_STATUSES, 'cold'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/** Paying, in any shape. `one_time` earns no recurring revenue but is still a client. */
export const CLIENT_LIKE_STATUSES = ['client', 'one_time'] as const;

/**
 * Counts toward "active pipeline" rollups. An inclusion set on purpose: a parked lead
 * (`cold`), a client who left, a lost lead and a signer-only contact are not live work, and
 * an exclusion list would silently count any status added later.
 */
export const ACTIVE_PIPELINE_STATUSES = [...LEAD_LIKE_STATUSES, 'client', 'one_time'] as const;

/**
 * May receive a group email, BEFORE per-address suppression. `lost` is closed out and never
 * mailed; system statuses are not marketing contacts. A client who left keeps the
 * relationship, so `former_client` stays. This is not an opt-in record: suppression is a
 * second gate applied per address at send time.
 */
export const EMAILABLE_STATUSES = [...PIPELINE_STATUSES, 'client', 'one_time', 'former_client'] as const;

/**
 * A decision to stop pursuing the work. A side effect (accepting a quote, say) must never
 * silently promote one of these back to `client`: `lost` never signed, `cold` is the same
 * decision with the door left open, and `former_client` left.
 */
export const TERMINAL_STATUSES = ['lost', 'cold', 'former_client'] as const;

const has = (set: readonly string[], status: string) => set.includes(status);

export const isSystemStatus = (s: string) => has(SYSTEM_STATUSES, s);
export const isTerminalStatus = (s: string) => has(TERMINAL_STATUSES, s);
export const isLeadLike = (s: string) => has(LEAD_LIKE_STATUSES, s);
export const isPipelineStatus = (s: string) => has(PIPELINE_STATUSES, s);
export const isClientLike = (s: string) => has(CLIENT_LIKE_STATUSES, s);
export const isActivePipelineStatus = (s: string) => has(ACTIVE_PIPELINE_STATUSES, s);
export const isEmailableStatus = (s: string) => has(EMAILABLE_STATUSES, s);
