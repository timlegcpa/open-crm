// The contact tools mcp-crm offers, and what each does. Every read and write goes through
// one mcp_* function in 0007_mcp.sql, which writes its audit row inside the same
// transaction: a write either commits with its record or not at all, so a retry is safe.
//
// Writes are deliberately narrow:
//   * A quote is written PROPOSED only. Accepting one is the owner's act in the CRM, and it
//     is what moves the revenue figures; an accepted quote is never changed or deleted here.
//   * A note is appended; no tool edits or deletes one.
//   * An address changes only through correct_contact_email, which refuses any contact with
//     a portal account, demands the address the caller read (a compare-and-swap) and, like
//     delete_quote, the user's explicit go-ahead (confirmed_with_user).
//   * add_business adds a registry entry and nothing else.
//   * No tool sets a contact's status.
//
// The request tools (create, update, list, send, remind and delete a request) arrive with
// the requests domain. Two outward ones will email a client, so the per-request `budget`
// is already threaded through every call: one send per HTTP request, spent on the attempt.
//
// Tool results are text a model reads; refusals are tool errors (isError) with a fixed
// message. A database error is never echoed: sentinels are matched, anything else throws
// and becomes a generic -32603 with a redacted log line.
//
// Kept as one static array and one `if (name === '<tool>')` block per tool on purpose: the
// destructive-tool contract test parses this file and checks those shapes.

import { isUuid } from '../_shared/http.ts';
import {
  CONTACT_CREATABLE,
  CONTACT_UPDATABLE,
  EMAIL_MAX_LEN,
  KEY_RE,
  NOTE_KINDS,
  QUOTE_CADENCES,
  normalizeEmail,
  optionalId,
  pickFrom,
  validateAmount,
  validateContactPatch,
} from './validation.ts';

/** The slice of a Supabase service client the tools call. supabase-js satisfies it. */
export interface ToolDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** The active pick-list keys, read once per request when a tool needs them. */
export interface Vocabulary {
  statuses: string[];
  organization_types: string[];
  service_types: string[];
}

export interface ToolContext {
  db: ToolDb;
  /** The owner who approved this connection: the actor on every audit row. */
  actor: string;
  ip: string | null;
  userAgent: string | null;
  vocabulary(): Promise<Vocabulary>;
  /** Outward sends spent in this HTTP request (the request tools use it). */
  budget: { sends: number };
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

const toolText = (payload: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const toolError = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** The search query bound: a name, an address or a business name fragment fits. */
export const MAX_QUERY_LENGTH = 200;
export const MAX_NOTE_LENGTH = 10_000;
export const MAX_BUSINESS_NAME_LENGTH = 200;

export const TOOLS = [
  {
    name: 'search_contacts',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      'Search CRM contacts by name, email or business name. Returns a compact list with id, name, email, phone, business name and status, newest first. Use it to find a contact id before calling get_contact or update_contact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name, email or business name fragment. Leave it out to list the newest contacts.' },
        status: { type: 'string', description: 'Optional status filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows, 1 to 100. Default 25.' },
      },
    },
  },
  {
    name: 'get_contact',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Fetch one contact: name, email, phone, business name and status, their businesses, their quotes (service, state, cadence, amount and which business each sits on), and their 20 newest notes.",
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string', description: 'Contact id.' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'create_contact',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Create a new contact as a lead. Email is required, and the call is refused when a contact already has that address. Use log_call_note to record anything about the conversation. It does not create businesses, quotes or a portal account.',
    inputSchema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        business_name: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_contact',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Update an existing contact's first name, last name, phone or business name. Email addresses cannot be changed here, because an address routes portal invitations and sign-in. To correct the contact's address use correct_contact_email, which refuses any contact holding a portal account; a spouse's address changes in the CRM. Notes go through log_call_note. Spouse details, quotes and status are not writable here.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        business_name: { type: 'string' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'correct_contact_email',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Correct the email address on a contact. Read the contact with get_contact first: pass its current address as expected_current_email, or null if it has none, and the call is refused unless that matches what is stored, so a correction is never built on a stale read. Refused outright for any contact with a portal account, because that address is a live sign-in route and is changed by the owner in the CRM. The previous address is not destroyed; it stays on the contact's email list. Use this to fix a wrong or outdated address, not to add a second person. Read the change back to your user (the contact, the current address and the new one) and get their go-ahead first.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        email: { type: 'string', description: 'The corrected address.' },
        expected_current_email: {
          type: ['string', 'null'],
          description: 'The address currently on the contact, or null if it has none.',
        },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard the contact, the current address and the new one, and told you to make the change.',
        },
      },
      required: ['contact_id', 'email', 'expected_current_email', 'confirmed_with_user'],
    },
  },
  {
    name: 'add_business',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Add a business to a contact's record, as a registry entry. Use it so a business exists to quote work against.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        name: { type: 'string', description: 'The business name, up to 200 characters.' },
        organization_type: { type: 'string', description: 'The kind of business.' },
      },
      required: ['contact_id', 'name', 'organization_type'],
    },
  },
  {
    name: 'log_call_note',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Add a note to a contact's record, typically a summary of a phone call. Notes are append-only: this adds to the record and can never overwrite or delete an existing note. Use it after a call to capture what was discussed and agreed.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        body: { type: 'string', description: 'The note text, up to 10000 characters. Write it as you would for your own file.' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: "Defaults to 'call'." },
      },
      required: ['contact_id', 'body'],
    },
  },
  {
    name: 'upsert_quote',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Record what you are quoting a contact for a service, as a PROPOSED quote, on the contact or on one of their businesses when organization_id is given. It cannot accept a quote: accepting is done by the owner in the CRM, and it is what moves the revenue figures. Quoting the same service on the same business again updates that proposed quote. An accepted quote is never changed here.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        service_type: { type: 'string', description: 'The service quoted.' },
        cadence: { type: 'string', enum: [...QUOTE_CADENCES] },
        amount: { type: 'number', description: 'The fee, 0 or more, at most two decimals.' },
        organization_id: { type: 'string', description: 'The business this quote is for. Leave it out for a quote on the contact itself.' },
      },
      required: ['contact_id', 'service_type', 'cadence', 'amount'],
    },
  },
  {
    name: 'delete_quote',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Permanently delete a PROPOSED quote from a contact, for example one a new quote supersedes. Only a proposed quote can be deleted here: an accepted one is live work whose revenue depends on it, and removing it is done by the owner in the CRM. Read the quote back to your user first (the service, the amount, the cadence and whether it sits on the contact or one of their businesses), get their go-ahead, then call this. It cannot be undone.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        quote_id: { type: 'string', description: 'The quote id, from get_contact.' },
        service_type: {
          type: 'string',
          description: 'The service the quote is for, as get_contact reported it. Proves you are deleting the quote you read.',
        },
        organization_id: {
          type: 'string',
          description: 'The business the quote sits on, as get_contact reported it. Leave it out for a quote on the contact itself. Checked against the stored quote.',
        },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard which quote this is and told you to delete it.',
        },
      },
      required: ['contact_id', 'quote_id', 'service_type', 'confirmed_with_user'],
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/**
 * The catalog as tools/list returns it: the pick-list enums filled in from the database at
 * request time, so a key the owner adds or deactivates shows up without a deploy.
 * delete_quote's service_type gets no enum on purpose: a quote on a service deactivated
 * since must stay deletable.
 */
export function toolCatalog(vocab: Vocabulary): unknown[] {
  const catalog = structuredClone(TOOLS) as unknown as Array<{ name: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }>;
  const set = (tool: string, prop: string, values: string[]) => {
    const schema = catalog.find((t) => t.name === tool)!.inputSchema.properties[prop];
    schema.enum = [...values];
  };
  set('search_contacts', 'status', vocab.statuses);
  set('add_business', 'organization_type', vocab.organization_types);
  set('upsert_quote', 'service_type', vocab.service_types);
  return catalog;
}

/** True when a raised error is the named sentinel from an mcp_* function. Matched, never echoed. */
function sentinel(error: unknown, code: string): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes(code);
}

const NO_CONTACT = 'No contact with that id.';

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const audit = { p_actor: ctx.actor, p_ip: ctx.ip, p_user_agent: ctx.userAgent };
  const rpc = (fn: string, params: Record<string, unknown>) => ctx.db.rpc(fn, { ...params, ...audit });

  if (name === 'search_contacts') {
    if (args.query !== undefined && args.query !== null && typeof args.query !== 'string') return toolError('query must be text.');
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length > MAX_QUERY_LENGTH) return toolError(`query must be ${MAX_QUERY_LENGTH} characters or fewer.`);
    let status: string | null = null;
    if (args.status !== undefined && args.status !== null) {
      const { statuses } = await ctx.vocabulary();
      if (typeof args.status !== 'string' || !statuses.includes(args.status)) {
        return toolError(`status must be one of: ${statuses.join(', ')}.`);
      }
      status = args.status;
    }
    // Checked here, not left to the function's clamp: a huge number (1e100) would overflow
    // the integer parameter and come back as a server fault instead of the caller's mistake.
    if (args.limit !== undefined && args.limit !== null && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 100)) {
      return toolError('limit must be a whole number from 1 to 100.');
    }
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    const { data, error } = await rpc('mcp_search_contacts', { p_query: query, p_status: status, p_limit: limit });
    if (error) throw error;
    return toolText(data);
  }

  if (name === 'get_contact') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const { data, error } = await rpc('mcp_get_contact', { p_contact_id: args.contact_id });
    if (error) throw error;
    if (!data) return toolError(NO_CONTACT);
    return toolText(data);
  }

  if (name === 'create_contact') {
    const patch = pickFrom(CONTACT_CREATABLE, args);
    if (patch.email === undefined) return toolError('email is required.');
    // Normalize BEFORE validating: the pattern check runs on the trimmed address, so a
    // padded but otherwise valid address is accepted rather than refused.
    const norm = normalizeEmail(patch.email);
    if ('error' in norm) return toolError(norm.error);
    patch.email = norm.email;
    const bad = validateContactPatch(patch);
    if (bad) return toolError(`${bad}.`);

    // The duplicate check is inside the function, under a lock, and fails closed: an error
    // there throws, and nothing is inserted on an unverified check.
    const { data, error } = await rpc('mcp_create_contact', { p_patch: patch });
    if (error) throw error;
    const result = data as { outcome?: string; id?: string } | null;
    if (result?.outcome === 'duplicate') return toolError(`A contact with that email already exists (id ${result.id}).`);
    if (result?.outcome !== 'created') throw new Error(`mcp_create_contact returned an unknown outcome: ${String(result?.outcome)}`);
    const { outcome: _outcome, ...created } = result;
    return toolText({ created });
  }

  if (name === 'update_contact') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    // Checked before the patch is built, so it refuses the WHOLE call: applying the other
    // fields and silently dropping the address would report a success the caller did not get.
    if (args.email !== undefined || args.spouse_email !== undefined) {
      return toolError(
        "Email addresses cannot be changed here, because an address routes portal invitations and sign-in. Use correct_contact_email for the contact's address; a spouse's address changes in the CRM. Nothing was updated; send the call again without the email field to apply the other changes.",
      );
    }
    const patch = pickFrom(CONTACT_UPDATABLE, args);
    if (Object.keys(patch).length === 0) return toolError('No updatable fields supplied.');
    const bad = validateContactPatch(patch);
    if (bad) return toolError(`${bad}.`);
    const { data, error } = await rpc('mcp_update_contact', { p_contact_id: args.contact_id, p_patch: patch });
    if (error) throw error;
    if (!data) return toolError(NO_CONTACT);
    return toolText({ updated: data });
  }

  if (name === 'correct_contact_email') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const parsed = normalizeEmail(args.email);
    if ('error' in parsed) return toolError(parsed.error);
    // Required, so ABSENT and explicit null differ, and only null is acceptable: an omitted
    // field must not quietly mean "it had none" for exactly the contacts where no
    // compare-and-swap evidence exists. null is how a caller says "I read it; there was none".
    const expected = args.expected_current_email;
    if (expected === undefined) {
      return toolError('expected_current_email is required. Read the contact with get_contact first, then pass its current address, or null if it has none.');
    }
    if (expected !== null && typeof expected !== 'string') return toolError('expected_current_email must be a string or null.');
    if (typeof expected === 'string' && expected.length > EMAIL_MAX_LEN) {
      return toolError(`expected_current_email must be ${EMAIL_MAX_LEN} characters or fewer.`);
    }
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Not changed. Read the change back to your user (the contact, the current address and the new one), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // Deliberately NOT trimmed or lowercased here: the function canonicalizes BOTH sides of
    // the compare with one expression. Two canonicalizers once disagreed about which
    // characters are whitespace and made a tab-padded address impossible to correct.
    const { data, error } = await rpc('mcp_correct_contact_email', {
      p_contact_id: args.contact_id,
      p_email: parsed.email,
      p_expected_current_email: expected,
    });
    if (error) throw error;
    const result = data as { outcome?: string } | null;
    switch (result?.outcome) {
      case 'updated': {
        const { outcome: _outcome, ...updated } = result as Record<string, unknown>;
        return toolText({ updated });
      }
      case 'not_found':
        return toolError(NO_CONTACT);
      case 'has_portal_account':
        return toolError(
          'That contact has a portal account, so the address cannot be changed here. This refuses a portal account of any status, not only an active one: an invited account has an invitation in flight, and a deactivated one can be reactivated onto whatever address the contact then holds. The owner changes it in the CRM.',
        );
      case 'stale':
        // Never quotes the stored address back: an address is personal data, and
        // get_contact is the tool that returns it.
        return toolError(
          'expected_current_email did not match what is stored, so nothing was changed. Read the contact again with get_contact and send its current address.',
        );
      default:
        // The function and this handler have drifted: fail loudly, never report a success.
        throw new Error(`mcp_correct_contact_email returned an unknown outcome: ${String(result?.outcome)}`);
    }
  }

  if (name === 'add_business') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const businessName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!businessName) return toolError('name is required.');
    if (businessName.length > MAX_BUSINESS_NAME_LENGTH) return toolError(`name must be ${MAX_BUSINESS_NAME_LENGTH} characters or fewer.`);
    const { organization_types } = await ctx.vocabulary();
    if (typeof args.organization_type !== 'string' || !organization_types.includes(args.organization_type)) {
      return toolError(`organization_type must be one of: ${organization_types.join(', ')}.`);
    }
    const { data, error } = await rpc('mcp_add_business', {
      p_contact_id: args.contact_id,
      p_name: businessName,
      p_organization_type: args.organization_type,
    });
    if (error) {
      if (sentinel(error, 'mcp_add_business: not_found')) return toolError(NO_CONTACT);
      if (sentinel(error, 'mcp_add_business: inactive_type')) return toolError('That business type is not in use any more. List the tools again for the current types.');
      throw error;
    }
    return toolText({ created: data });
  }

  if (name === 'log_call_note') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!body) return toolError('body is required.');
    if (body.length > MAX_NOTE_LENGTH) return toolError(`body is too long (at most ${MAX_NOTE_LENGTH} characters).`);
    if (args.kind !== undefined && args.kind !== null && !(NOTE_KINDS as readonly unknown[]).includes(args.kind)) {
      return toolError(`kind must be one of: ${NOTE_KINDS.join(', ')}.`);
    }
    const kind = typeof args.kind === 'string' ? args.kind : 'call';
    const { data, error } = await rpc('mcp_log_call_note', { p_contact_id: args.contact_id, p_body: body, p_kind: kind });
    if (error) {
      if (sentinel(error, 'mcp_log_call_note: not_found')) return toolError(NO_CONTACT);
      throw error;
    }
    return toolText({ logged: data });
  }

  if (name === 'upsert_quote') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const { service_types } = await ctx.vocabulary();
    if (typeof args.service_type !== 'string' || !service_types.includes(args.service_type)) {
      return toolError(`service_type must be one of: ${service_types.join(', ')}.`);
    }
    if (typeof args.cadence !== 'string' || !(QUOTE_CADENCES as readonly string[]).includes(args.cadence)) {
      return toolError(`cadence must be one of: ${QUOTE_CADENCES.join(', ')}.`);
    }
    const amount = validateAmount(args.amount);
    if ('error' in amount) return toolError(`${amount.error}.`);
    const organization = optionalId(args.organization_id, isUuid);
    if ('error' in organization) {
      return toolError('organization_id must be a valid id, or left out entirely for a quote on the contact itself. An empty value is not the same as leaving it out.');
    }
    const { data, error } = await rpc('mcp_upsert_quote', {
      p_contact_id: args.contact_id,
      p_organization_id: organization.id,
      p_service_type: args.service_type,
      p_cadence: args.cadence,
      p_amount: amount.amount,
    });
    if (error) {
      if (sentinel(error, 'mcp_upsert_quote: accepted_quote')) {
        return toolError(
          `That service is already an ACCEPTED quote for this ${organization.id ? 'business' : 'contact'}. Changing accepted work moves the revenue figures, so the owner does it in the CRM, not here.`,
        );
      }
      if (sentinel(error, 'mcp_upsert_quote: not_found')) return toolError(NO_CONTACT);
      if (sentinel(error, 'mcp_upsert_quote: organization_not_found')) return toolError('That business does not belong to that contact.');
      if (sentinel(error, 'mcp_upsert_quote: inactive_service')) return toolError('That service is not in use any more. List the tools again for the current services.');
      throw error;
    }
    return toolText({ quote: data, note: 'Saved as a PROPOSED quote. The owner accepts it in the CRM.' });
  }

  if (name === 'delete_quote') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (!isUuid(args.quote_id)) return toolError('quote_id must be a valid id. Get it from get_contact.');
    // Any existing key, active or not: a quote on a service deactivated since must stay
    // deletable. The function binds it to the stored row.
    if (typeof args.service_type !== 'string' || !KEY_RE.test(args.service_type)) {
      return toolError('service_type must be the service get_contact reported for this quote.');
    }
    const organization = optionalId(args.organization_id, isUuid);
    if ('error' in organization) {
      return toolError('organization_id must be a valid id, or left out entirely for a quote on the contact itself. An empty value is not the same as leaving it out.');
    }
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Not deleted. Read the quote back to your user (the service, the amount, the cadence and whether it sits on the contact or one of their businesses), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // The service and business are a content binding, not a convenience: the function
    // refuses when either disagrees with the locked row, so a quote edited between the
    // read-back and this call is not deleted as though it were the one the user approved.
    const { data, error } = await rpc('mcp_delete_quote', {
      p_contact_id: args.contact_id,
      p_quote_id: args.quote_id,
      p_organization_id: organization.id,
      p_service_type: args.service_type,
    });
    if (error) {
      if (sentinel(error, 'mcp_delete_quote: accepted_quote')) {
        return toolError(
          'That quote is ACCEPTED, not proposed. It is live work, so deleting it changes the revenue figures; the owner does that in the CRM, not here.',
        );
      }
      if (sentinel(error, 'mcp_delete_quote: not_found')) {
        return toolError(
          'No proposed quote on that contact matches that id, service and business. Read the contact again with get_contact and use the id, service and business it reports.',
        );
      }
      throw error;
    }
    return toolText({
      deleted: data,
      note: 'The proposed quote is deleted, and it no longer counts toward the proposed pipeline figures in the CRM. Do not state by how much those figures move: they depend on cadence and on which contacts the totals include.',
    });
  }

  return toolError(`Unknown tool: ${name}`);
}
