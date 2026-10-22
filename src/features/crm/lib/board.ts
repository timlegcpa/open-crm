import type { Contact } from '@/api/contacts';
import { matchesContactSearch } from '@/lib/contactSearch';
import { isClientLike, isLeadLike, type PipelineStatus } from '@/lib/contactStatus';
import { formatCurrencyShort } from '@/lib/format';
import { addedAt, inStoredOrder, type StatusOrder } from './sections';

/**
 * The pipeline board's logic: money BY PERSON, three cadences never blended.
 *
 * Monthly, annual and one-time are three figures. A card shows MRR and ARR (ARR = monthly x
 * 12 + annual) with one-time money beside them, never inside them. `rankValue` exists to
 * ORDER rows and is never rendered.
 */

/** The slim organization row the board reads. */
export interface BoardOrganization {
  id: string;
  contact_id: string;
  name: string;
  organization_type: string;
}

/** The quote fields the board reads. */
type QuoteRow = Contact['contact_services'][number];

// ── Search ────────────────────────────────────────────────────────

function norm(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * The fields the shared contact search does not reach: the spouse, the contact's
 * organizations by name and type, and a phone by digits (the roster carries no tax ID, so
 * search never reaches one). A WIDENER, ORed onto
 * `matchesContactSearch` by `matchesCrmSearch`, never a replacement.
 *
 * An empty query returns false: callers treat empty as "no filter" and never call it.
 * Digits are compared with punctuation stripped from both sides, with a four-digit floor so
 * a one-character query does not match every number.
 */
export function contactMatches(c: Contact, organizations: readonly BoardOrganization[], rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return false;
  const fields = [
    c.full_name,
    c.first_name,
    c.last_name,
    c.email,
    c.phone,
    c.spouse_name,
    c.spouse_first_name,
    c.spouse_last_name,
    c.spouse_email,
    c.spouse_phone,
    c.business_name,
  ];
  if (fields.some((f) => norm(f).includes(q))) return true;
  if (organizations.some((o) => norm(o.name).includes(q) || norm(o.organization_type).includes(q))) return true;

  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4) {
    for (const p of [c.phone, c.spouse_phone]) {
      if (p && p.replace(/\D/g, '').includes(digits)) return true;
    }
  }
  return false;
}

/** THE CRM search: the shared contact rule, widened. An empty query matches everyone. */
export function matchesCrmSearch(c: Contact, organizations: readonly BoardOrganization[], query: string): boolean {
  if (query.trim() === '') return true;
  return matchesContactSearch(c, query) || contactMatches(c, organizations, query);
}

// ── Money ─────────────────────────────────────────────────────────

/**
 * The price on a line, or null when there is none. PostgREST returns numeric as a string,
 * so this parses. "No price agreed" has two spellings, NULL and 0, and both are unpriced;
 * a negative is nonsense and gets the same treatment rather than being subtracted.
 */
export function toAmount(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Money at one cadence. Never summed across the three. */
export interface CadenceTotals {
  monthly: number;
  annual: number;
  oneTime: number;
}

/** For RANKING ONLY, never for display. */
export function rankValue(t: CadenceTotals): number {
  return t.monthly * 12 + t.annual + t.oneTime;
}

/** Three figures with their units, never a sum. Blank when nothing is priced. */
export function cadenceText(t: CadenceTotals): string {
  return [
    t.monthly > 0 && `${formatCurrencyShort(t.monthly)}/mo`,
    t.annual > 0 && `${formatCurrencyShort(t.annual)}/yr`,
    t.oneTime > 0 && `${formatCurrencyShort(t.oneTime)} once`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** ARR: monthly x 12 plus annual. One-time money is never in it. */
export function yearlyTotal(t: Pick<CadenceTotals, 'monthly' | 'annual'>): number {
  return t.monthly * 12 + t.annual;
}

/**
 * A card's MRR and ARR. MRR is left out when there is no monthly money, so an annual-only
 * lead reads "$1,700 ARR", not "$0 MRR". Blank when nothing recurring is priced.
 */
export function mrrArrText(t: Pick<CadenceTotals, 'monthly' | 'annual'>): string {
  const arr = yearlyTotal(t);
  if (!(arr > 0)) return '';
  const parts = [`${formatCurrencyShort(arr)} ARR`];
  if (t.monthly > 0) parts.unshift(`${formatCurrencyShort(t.monthly)} MRR`);
  return parts.join(' · ');
}

/** One priced line's year, or null for one-time money and unpriced lines. */
export function yearlyOfLine(cadence: string, amount: number | string | null | undefined): number | null {
  const n = toAmount(amount);
  if (n == null) return null;
  if (cadence === 'monthly') return n * 12;
  if (cadence === 'annual') return n;
  return null;
}

// ── Lines ─────────────────────────────────────────────────────────

export interface BoardLine {
  id: string;
  serviceType: string;
  serviceLabel: string;
  cadence: string;
  /** null when the quote carries no price. Never coerced to 0. */
  amount: number | null;
  /** The organization the line was quoted for, or null for the person. */
  organizationName: string | null;
}

function lineRank(l: BoardLine): number {
  if (l.amount == null) return -1;
  return l.cadence === 'monthly' ? l.amount * 12 : l.amount;
}

function lineOf(r: QuoteRow, labels: ReadonlyMap<string, string>, orgNames: ReadonlyMap<string, string>): BoardLine {
  return {
    id: r.id,
    serviceType: r.service_type,
    // An unknown key renders as itself rather than a blank: a row is never lost.
    serviceLabel: labels.get(r.service_type) ?? r.service_type,
    cadence: r.cadence,
    amount: toAmount(r.amount),
    organizationName: r.organization_id ? (orgNames.get(r.organization_id) ?? null) : null,
  };
}

type Placement = 'counted' | 'unpriced' | 'unplaceable';

function addLine(into: CadenceTotals, line: BoardLine): Placement {
  if (line.amount == null) return 'unpriced';
  if (line.cadence === 'monthly') into.monthly += line.amount;
  else if (line.cadence === 'annual') into.annual += line.amount;
  else if (line.cadence === 'one_time') into.oneTime += line.amount;
  // A cadence outside the three is counted apart from "unpriced": it has a price.
  else return 'unplaceable';
  return 'counted';
}

function rowName(c: Contact): string {
  return c.full_name.trim() || (c.business_name ?? '').trim() || (c.email ?? '').trim() || 'Unnamed contact';
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

// ── Unsigned work (the pipeline figures) ──────────────────────────

export type SegmentKey = 'unsigned_clients' | 'unsigned_leads' | 'unsigned_parked';

export const SEGMENTS: ReadonlyArray<{ key: SegmentKey; label: string; describe: string }> = [
  { key: 'unsigned_clients', label: 'Clients', describe: 'Already a client; quoted work not yet accepted.' },
  { key: 'unsigned_leads', label: 'Open leads', describe: 'Quoted, still in conversation.' },
  { key: 'unsigned_parked', label: 'Cold', describe: 'Quoted, then put on the back burner.' },
];

/** Which group a contact's unsigned work belongs to; null (lost, former, signer) is not shown. */
export function segmentFor(status: string): SegmentKey | null {
  if (isClientLike(status)) return 'unsigned_clients';
  if (isLeadLike(status)) return 'unsigned_leads';
  if (status === 'cold') return 'unsigned_parked';
  return null;
}

export interface UnsignedRow extends CadenceTotals {
  contactId: string;
  name: string;
  status: string;
  lines: BoardLine[];
  unpriced: number;
  unplaceable: number;
}

export interface UnsignedSegment extends CadenceTotals {
  key: SegmentKey;
  label: string;
  describe: string;
  rows: UnsignedRow[];
  unpriced: number;
  unplaceable: number;
}

interface LabelSources {
  serviceLabels: ReadonlyMap<string, string>;
  organizations: readonly BoardOrganization[];
  /** The database's status order; the columns follow it. */
  statusOrder?: StatusOrder;
}

/** Every contact with proposed (unsigned) work, grouped. An empty segment is still returned. */
export function unsignedWork(contacts: readonly Contact[], { serviceLabels, organizations }: LabelSources): UnsignedSegment[] {
  const orgNames = new Map(organizations.map((o) => [o.id, o.name]));
  const bySegment = new Map<SegmentKey, UnsignedRow[]>(SEGMENTS.map((s) => [s.key, []]));
  for (const c of contacts) {
    const segment = segmentFor(c.status);
    if (!segment) continue;
    const proposed = c.contact_services.filter((r) => r.state === 'proposed');
    if (proposed.length === 0) continue;
    const row: UnsignedRow = { contactId: c.id, name: rowName(c), status: c.status, lines: [], monthly: 0, annual: 0, oneTime: 0, unpriced: 0, unplaceable: 0 };
    for (const r of proposed) {
      const line = lineOf(r, serviceLabels, orgNames);
      row.lines.push(line);
      const placed = addLine(row, line);
      if (placed === 'unpriced') row.unpriced += 1;
      else if (placed === 'unplaceable') row.unplaceable += 1;
    }
    row.lines.sort((a, b) => lineRank(b) - lineRank(a));
    bySegment.get(segment)!.push(row);
  }
  return SEGMENTS.map((def) => {
    const rows = bySegment.get(def.key)!;
    rows.sort((a, b) => rankValue(b) - rankValue(a) || a.name.localeCompare(b.name));
    const out: UnsignedSegment = { ...def, rows, monthly: 0, annual: 0, oneTime: 0, unpriced: 0, unplaceable: 0 };
    for (const r of rows) {
      out.monthly += r.monthly;
      out.annual += r.annual;
      out.oneTime += r.oneTime;
      out.unpriced += r.unpriced;
      out.unplaceable += r.unplaceable;
    }
    return out;
  });
}

export interface PipelineFigure extends CadenceTotals {
  key: SegmentKey;
  label: string;
  people: number;
  unpriced: number;
}

const PIPELINE_SEGMENTS: ReadonlyArray<{ key: SegmentKey; label: string }> = [
  { key: 'unsigned_leads', label: 'Leads quoted' },
  { key: 'unsigned_parked', label: 'Cold' },
];

/**
 * The top bar's two figures: quotes out to open leads, and quotes left with cold contacts.
 * Clients' unsigned quotes are not pipeline. A segment nobody is in is left out.
 */
export function pipelineFigures(segments: readonly UnsignedSegment[]): PipelineFigure[] {
  return PIPELINE_SEGMENTS.flatMap(({ key, label }) => {
    const s = segments.find((seg) => seg.key === key);
    if (!s || s.rows.length === 0) return [];
    return [{ key, label, people: s.rows.length, unpriced: s.unpriced, monthly: s.monthly, annual: s.annual, oneTime: s.oneTime }];
  });
}

// ── The leads pipeline (the board's columns) ──────────────────────

export type LeadGroupKey = 'leads_new' | 'leads_active' | 'leads_hot' | 'leads_warm' | 'leads_cold';

export interface LeadGroupDef {
  key: LeadGroupKey;
  /** Typed off the taxonomy, so renaming a status is a compile error here. */
  status: PipelineStatus;
}

/** One column per open stage, coldest last. Set-equal to PIPELINE_STATUSES (board.test.ts). */
export const LEAD_GROUPS: readonly LeadGroupDef[] = [
  { key: 'leads_new', status: 'new_lead' },
  { key: 'leads_active', status: 'active_lead' },
  { key: 'leads_hot', status: 'hot' },
  { key: 'leads_warm', status: 'warm' },
  { key: 'leads_cold', status: 'cold' },
];

export interface LeadRow extends CadenceTotals {
  contactId: string;
  name: string;
  status: string;
  /** The organization or business shown under the name, if any. */
  businessName: string | null;
  /** Proposed lines; empty is common. */
  lines: BoardLine[];
  unpriced: number;
  unplaceable: number;
  /** Has an email or a phone (whitespace does not count). */
  reachable: boolean;
  /** The card's note line: the newest logged note, text only (never its date). */
  note: string | null;
  /** Sort key ONLY, never rendered: no age or day count appears anywhere. */
  addedAt: string;
}

export interface LeadGroup extends CadenceTotals, LeadGroupDef {
  rows: LeadRow[];
  unpriced: number;
  unplaceable: number;
}

/**
 * Each contact's newest note, from rows read newest first: the first row seen for a contact
 * wins. A blank body is skipped, so an empty newest note never hides the one before it.
 */
export function latestNotes(rows: ReadonlyArray<{ contact_id: string; body: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!out.has(r.contact_id) && hasText(r.body)) out.set(r.contact_id, r.body.trim());
  }
  return out;
}

/** The board's service filter: 'all', or one service type key. */
export type ServiceFilter = 'all' | (string & {});

/**
 * Does this contact carry a PROPOSED line for the chosen service? 'all' matches everyone.
 * The filter says what is quoted, never what a lead might want, so a lead with no quoted
 * service shows under All only.
 */
export function matchesServiceFilter(contact: Pick<Contact, 'contact_services'>, filter: ServiceFilter): boolean {
  if (filter === 'all') return true;
  return contact.contact_services.some((s) => s.state === 'proposed' && s.service_type === filter);
}

/** The service types quoted (proposed) to anyone in these contacts, for the filter's pills. */
export function quotedServiceTypes(contacts: readonly Pick<Contact, 'contact_services'>[]): Set<string> {
  const out = new Set<string>();
  for (const c of contacts) for (const s of c.contact_services) if (s.state === 'proposed') out.add(s.service_type);
  return out;
}

/**
 * Every pipeline contact, grouped by stage, NEWEST FIRST (never by money). An empty group
 * still renders: "no new leads" is information. `notes` is each person's newest note
 * (latestNotes).
 */
export function leadPipeline(
  contacts: readonly Contact[],
  { serviceLabels, organizations, statusOrder }: LabelSources,
  notes: ReadonlyMap<string, string> = new Map(),
): LeadGroup[] {
  const orgNames = new Map(organizations.map((o) => [o.id, o.name]));
  const firstOrg = new Map<string, string>();
  for (const o of organizations) if (!firstOrg.has(o.contact_id)) firstOrg.set(o.contact_id, o.name);
  const byGroup = new Map<LeadGroupKey, LeadRow[]>(LEAD_GROUPS.map((g) => [g.key, []]));

  for (const c of contacts) {
    const group = LEAD_GROUPS.find((g) => g.status === c.status)?.key;
    if (!group) continue;
    const row: LeadRow = {
      contactId: c.id,
      name: rowName(c),
      status: c.status,
      businessName: firstOrg.get(c.id) ?? (hasText(c.business_name) ? c.business_name!.trim() : null),
      lines: [],
      monthly: 0,
      annual: 0,
      oneTime: 0,
      unpriced: 0,
      unplaceable: 0,
      reachable: hasText(c.email) || hasText(c.phone),
      note: notes.get(c.id) ?? null,
      addedAt: addedAt(c),
    };
    for (const r of c.contact_services.filter((s) => s.state === 'proposed')) {
      const line = lineOf(r, serviceLabels, orgNames);
      row.lines.push(line);
      const placed = addLine(row, line);
      if (placed === 'unpriced') row.unpriced += 1;
      else if (placed === 'unplaceable') row.unplaceable += 1;
    }
    row.lines.sort((a, b) => lineRank(b) - lineRank(a));
    byGroup.get(group)!.push(row);
  }

  return inStoredOrder(LEAD_GROUPS, (g) => g.status, statusOrder).map((def) => {
    const rows = byGroup.get(def.key)!;
    rows.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId)));
    const out: LeadGroup = { ...def, rows, monthly: 0, annual: 0, oneTime: 0, unpriced: 0, unplaceable: 0 };
    for (const r of rows) {
      out.monthly += r.monthly;
      out.annual += r.annual;
      out.oneTime += r.oneTime;
      out.unpriced += r.unpriced;
      out.unplaceable += r.unplaceable;
    }
    return out;
  });
}

// ── The one view resolver ─────────────────────────────────────────

/**
 * The contacts a `?view=` selects, or null for "no filter". An unknown view returns null,
 * never an empty set: a stale link or a typo shows the whole roster.
 */
export function contactIdsForView(view: string | null | undefined, contacts: readonly Contact[], sources: LabelSources): Set<string> | null {
  if (!view) return null;
  const group = LEAD_GROUPS.find((g) => g.key === view);
  if (group) return new Set(contacts.filter((c) => c.status === group.status).map((c) => c.id));
  if (SEGMENTS.some((s) => s.key === view)) {
    const segment = unsignedWork(contacts, sources).find((s) => s.key === view);
    return segment ? new Set(segment.rows.map((r) => r.contactId)) : null;
  }
  return null;
}

/** What the active-view banner calls a view, or null for an unknown one. */
export function viewLabel(view: string | null | undefined, statusLabel: (status: string) => string): string | null {
  if (!view) return null;
  const group = LEAD_GROUPS.find((g) => g.key === view);
  if (group) return statusLabel(group.status);
  const figure = PIPELINE_SEGMENTS.find((s) => s.key === view);
  if (figure) return figure.label;
  const segment = SEGMENTS.find((s) => s.key === view);
  return segment ? `${segment.label} with unsigned work` : null;
}
