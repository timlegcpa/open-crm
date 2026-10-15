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
// The request tools work on drafts and never publish one themselves:
//   * create_request and update_request write a DRAFT, which the client cannot see.
//     update_request is a full replacement, bound by the review token to the draft as it
//     was read, so it never overwrites an edit made since. Neither takes a status.
//   * list_requests returns each request's client-visible content, never an answer, and a
//     review token for each draft and sent request (review-token.ts).
//   * send_request and remind_request email a client. Each needs the token, the user's
//     explicit go-ahead and a matching contact, and spends the one outward send an HTTP
//     request allows, on the attempt. They run send-needs-list's own send and reminder in
//     process (outward.ts), and report the client email and the owner's copy as they
//     happened, never as assumed.
//   * delete_request deletes a DRAFT only, at the content the token was verified over.
//
// Tool results are text a model reads; refusals are tool errors (isError) with a fixed
// message. A database error is never echoed: sentinels are matched, anything else throws
// and becomes a generic -32603 with a redacted log line.
//
// Kept as one static array and one `if (name === '<tool>')` block per tool on purpose: the
// destructive-tool contract test parses this file and checks those shapes.

import { isUuid } from '../_shared/http.ts';
import type { Logger } from '../_shared/log.ts';
import type { OutwardRemind, OutwardSend, OwnerCopy, RequestOutward } from './outward.ts';
import { REVIEW_TOKEN_RE, canonicalRequest, type ReviewList, type ReviewRecipient, type ReviewSigner } from './review-token.ts';
import {
  CONTACT_CREATABLE,
  CONTACT_UPDATABLE,
  EMAIL_MAX_LEN,
  KEY_RE,
  MAX_REQUEST_ITEMS,
  MCP_SENDABLE_KINDS,
  NOTE_KINDS,
  QUOTE_CADENCES,
  REQUEST_ITEM_KINDS,
  normalizeEmail,
  optionalId,
  parseRequestItems,
  parseRequestText,
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
  request_categories: string[];
  request_tags: string[];
}

export interface ToolContext {
  db: ToolDb;
  /** The owner who approved this connection: the actor on every audit row. */
  actor: string;
  ip: string | null;
  userAgent: string | null;
  vocabulary(): Promise<Vocabulary>;
  /** Outward sends spent in this HTTP request (send_request and remind_request share it). */
  budget: { sends: number };
  review: ReviewSigner;
  outward: RequestOutward;
  log: Logger;
  /** The wait between audit attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
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
/** One email to a client per HTTP request, whichever tool sends it. */
export const MAX_SENDS_PER_REQUEST = 1;
/** Requests list_requests returns; it says so when a contact has more. */
export const LIST_REQUESTS_LIMIT = 25;

const REQUEST_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'What is being asked for.' },
    kind: {
      type: 'string',
      enum: [...REQUEST_ITEM_KINDS],
      description: "document: upload a file. question: type an answer. todo: tick it off. info: read only. Defaults to 'document'.",
    },
    description: { type: 'string', description: 'Optional detail or instructions.' },
    required: { type: 'boolean', description: 'Defaults to true.' },
    category: { type: 'string', description: "Defaults to 'general'." },
    tag: { type: 'string', description: "Defaults to 'general'." },
    sensitive: {
      type: 'boolean',
      description:
        "Only with kind 'question'. When true the contact's typed answer is stored encrypted. Use it for identity or account numbers. Defaults to false. An uploaded file is encrypted already and does not need it.",
    },
  },
  required: ['label'],
};

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
  {
    name: 'create_request',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Draft a request to a contact for documents, answers or to-dos. It is saved as a DRAFT the contact cannot see. Read the finished draft back to your user (the title, the intro message and every item), then call list_requests for its review_token and use update_request for changes, or send_request once they approve. Sending is what emails the contact, and it cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        title: { type: 'string', description: 'A short title, up to 200 characters, e.g. "Documents for the project".' },
        intro_message: { type: 'string', description: 'Optional note shown above the items.' },
        items: { type: 'array', minItems: 1, maxItems: MAX_REQUEST_ITEMS, description: 'What you need from them, one entry per item.', items: REQUEST_ITEM_SCHEMA },
      },
      required: ['contact_id', 'title', 'items'],
    },
  },
  {
    name: 'update_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Rewrite a DRAFT request that has not been sent, after your user hears it read back and asks for changes. This is a FULL REPLACEMENT, not a patch: send the complete item list the request should end up with, including the items that stay the same; anything left out is removed, and an omitted intro_message removes the intro. Only a draft can be rewritten, and only as you last read it: pass its review_token from list_requests, and if anyone changed the draft since, nothing is rewritten. The token stops working once the draft changes, so call list_requests again before sending or changing it again.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The draft, from list_requests or create_request.' },
        contact_id: { type: 'string', description: 'The contact the draft belongs to. Must match.' },
        review_token: { type: 'string', description: 'The review_token for this draft, verbatim from list_requests. It binds the rewrite to the draft as you read it.' },
        title: { type: 'string', description: 'The title the request should end up with.' },
        intro_message: { type: 'string', description: 'The intro the request should end up with. Leave it out for none.' },
        items: { type: 'array', minItems: 1, maxItems: MAX_REQUEST_ITEMS, description: 'The COMPLETE final item list, in the order the contact should see it.', items: REQUEST_ITEM_SCHEMA },
      },
      required: ['list_id', 'contact_id', 'review_token', 'title', 'items'],
    },
  },
  {
    name: 'list_requests',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List a contact's requests, newest first, with everything the contact sees: the recipient's name and address, and for each request its id, title, intro message, status, and every item's label, description, kind, whether it is required, whether it is sensitive and whether it has been answered. The contact's ANSWERS are never returned. At most 25 requests come back; when there are more, truncated is true and you must not call the list complete. Each draft and each sent request carries a review_token, which update_request, send_request, remind_request and delete_request require. Any change to the request, its items, its answers or the recipient makes the token stale, so read it again after a change.",
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'send_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      'Send a DRAFT request to its contact. This emails them and shows the request in their portal, and it CANNOT be recalled. Never call it speculatively: first call list_requests, read the recipient, the title, the intro message and EVERY item (with descriptions) back to your user, and get their explicit go-ahead. It sends only what is saved; it cannot change the content or the recipient. One email to a contact per call to this server. The owner is sent a copy of what went out.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The draft, from list_requests.' },
        contact_id: { type: 'string', description: 'The contact the draft belongs to, from list_requests. Must match.' },
        review_token: { type: 'string', description: 'The review_token for this draft, verbatim from list_requests. It cannot be made by hand.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard the recipient, the title, the intro message and every item, and told you to send it.',
        },
      },
      required: ['list_id', 'contact_id', 'review_token', 'confirmed_with_user'],
    },
  },
  {
    name: 'remind_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Email a contact a reminder about a request already SENT that still has open items. Use it when send_request reported that the email did not go out, or when your user asks you to chase a request. It emails the contact and cannot be recalled, so read back who it goes to, the title and how many items are open, and get your user's go-ahead first. At most one reminder a day per request from here. It changes nothing about the request. The owner is sent a copy.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The sent request, from list_requests.' },
        contact_id: { type: 'string', description: 'The contact the request belongs to, from list_requests. Must match.' },
        review_token: { type: 'string', description: 'The review_token for this request, verbatim from list_requests.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard who the reminder goes to and what it is about, and told you to send it.',
        },
      },
      required: ['list_id', 'contact_id', 'review_token', 'confirmed_with_user'],
    },
  },
  {
    name: 'delete_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Permanently delete a DRAFT request that was never sent, when your user decides it should not go out. Only a draft can be deleted here: a sent request holds the contact's answers and files, and removing one is done by the owner in the CRM, where what would be lost is visible. Read the draft back to your user (the title and every item), get their go-ahead, then call this with its review_token. It cannot be undone.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The draft, from list_requests.' },
        contact_id: { type: 'string', description: 'The contact the draft belongs to. Must match.' },
        review_token: { type: 'string', description: 'The review_token for this draft, verbatim from list_requests. Proves you read what is being deleted.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard which draft this is and told you to delete it.',
        },
      },
      required: ['list_id', 'contact_id', 'review_token', 'confirmed_with_user'],
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
  type Props = Record<string, Record<string, unknown>>;
  const catalog = structuredClone(TOOLS) as unknown as Array<{ name: string; inputSchema: { properties: Props } }>;
  const props = (tool: string) => catalog.find((t) => t.name === tool)!.inputSchema.properties;
  const set = (tool: string, prop: string, values: string[]) => {
    props(tool)[prop].enum = [...values];
  };
  set('search_contacts', 'status', vocab.statuses);
  set('add_business', 'organization_type', vocab.organization_types);
  set('upsert_quote', 'service_type', vocab.service_types);
  for (const tool of ['create_request', 'update_request']) {
    const item = (props(tool).items.items as { properties: Props }).properties;
    item.category.enum = [...vocab.request_categories];
    item.tag.enum = [...vocab.request_tags];
  }
  return catalog;
}

/** True when a raised error is the named sentinel from an mcp_* function. Matched, never echoed. */
function sentinel(error: unknown, code: string): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes(code);
}

const NO_CONTACT = 'No contact with that id.';
const NO_REQUEST = 'No request with that id for that contact. Read the requests again with list_requests.';
const STALE_TOKEN =
  'That review_token does not match the request as it stands now (its content, its answers or its recipient changed, or the token belongs to another request). Nothing was done. Read it again with list_requests, read it back to your user, and confirm again.';
const INACTIVE_KEY = 'An item names a category or tag that is not in use any more. List the tools again for the current ones.';
const SENT_NOT_REWRITTEN = "That request has been sent, so it cannot be rewritten: its items hold the contact's answers. Create a new request instead.";

/** Why a send that reached the publish step sent nothing, by outcome. */
const SEND_REFUSALS: Record<Exclude<OutwardSend['status'], 'sent' | 'already_sent'>, string> = {
  changed: 'The request or its recipient changed since you read it. Read it again with list_requests and confirm with your user.',
  gone: 'That request was deleted.',
  no_items: 'That draft has no items.',
  no_email: 'That contact has no usable email address. The owner adds one in the CRM.',
  not_draft: 'That request was closed or submitted while sending.',
};

const REMIND_REFUSALS: Record<Exclude<OutwardRemind['status'], 'reminded'>, string> = {
  changed: 'The request or its recipient changed since you read it. Nothing was sent. Read it again with list_requests and confirm with your user.',
  gone: 'That request was deleted. Nothing was sent.',
  not_sent: 'That request is no longer a sent request. Nothing was sent.',
  nothing_open: 'Every item on that request is already answered, so there is nothing to remind about. Nothing was sent.',
  no_email: 'That contact has no usable email address. Nothing was sent; the owner adds one in the CRM.',
  email_failed: 'The mail provider refused the reminder, so it was not sent. Tell your user; a retry from the CRM is safe.',
  in_progress: 'Another reminder for this request is being sent right now. Nothing was sent from here.',
};

/** mcp_request_snapshot's answer: the shape the review tokens are minted over. */
interface RequestSnapshot {
  contact: ReviewRecipient;
  lists: ReviewList[];
  truncated: boolean;
}

/** One request of one contact, read through the one snapshot function the tokens are minted from. */
async function readRequest(ctx: ToolContext, contactId: string, listId: string): Promise<{ contact: ReviewRecipient; list: ReviewList } | null> {
  const { data, error } = await ctx.db.rpc('mcp_request_snapshot', { p_contact_id: contactId, p_list_id: listId, p_limit: 1 });
  if (error) throw error;
  const snap = data as RequestSnapshot | null;
  const list = snap?.lists[0];
  return snap && list ? { contact: snap.contact, list } : null;
}

/** The presented review token, format-checked before it reaches any crypto. */
function reviewToken(v: unknown): { token: string } | { error: string } {
  const token = typeof v === 'string' ? v.trim() : '';
  if (!token) return { error: 'review_token is required. Get it from list_requests.' };
  if (!REVIEW_TOKEN_RE.test(token)) return { error: 'That review_token is not a valid token. Use the value from list_requests verbatim.' };
  return { token };
}

/** The draft functions of 0005 raise a bare code (stale_content, has_answers, ...): matched exactly, never echoed. */
function exactSentinel(error: unknown, code: string): boolean {
  return (error as { message?: unknown } | null)?.message === code;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The audit row for an outward act that has already happened. A client email cannot be
 * recalled, so failing the tool here would only invite a retry that emails twice. Three
 * attempts; if all fail, the owner is emailed the record out of band, and the caller is
 * told the trail is incomplete. Details are ids, codes and flags only.
 */
async function auditDelegated(ctx: ToolContext, action: string, details: Record<string, string | number | boolean>): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await ctx.db.rpc('mcp_audit_row', {
        p_actor: ctx.actor, p_action: action, p_details: details, p_ip: ctx.ip, p_user_agent: ctx.userAgent,
      });
      if (!error) return null;
    } catch {
      // Retried below like a returned error.
    }
    if (attempt < 3) await (ctx.sleep ?? wait)(attempt * 250);
  }
  ctx.log.warn('outward act completed without an audit row', { action });
  let alerted = false;
  try {
    alerted = await ctx.outward.alert(
      `Audit record missing: ${action}`,
      [
        'Your AI assistant completed an action, but its audit record could not be written after three attempts. This email is the record.',
        `Action: ${action}`,
        ...Object.entries(details).map(([k, v]) => `${k}: ${String(v)}`),
        `When: ${new Date().toISOString()}`,
      ],
      `mcp-audit-alert:${action}:${String(details.list_id ?? '')}:${Date.now()}`,
    );
  } catch (err) {
    ctx.log.error('audit alert failed', err);
  }
  return alerted
    ? 'This action completed, but its audit record could not be written. The owner has been emailed the details.'
    : 'This action completed, but its audit record could not be written and the owner could not be emailed. Tell the owner.';
}

/** mcp_claim_reminder's answer: the day stamp it wrote and the one it replaced, both as text. */
interface ReminderClaim {
  claimed: boolean;
  stamp?: string;
  previous?: string | null;
}

const NO_AUDIT =
  'Nothing was sent: the audit trail could not be written, and this connector sends nothing it cannot record. Try again in a moment; if it keeps happening, tell the owner.';

/** The ids a refusal row may carry: only values that are ids, never the caller's other text. */
function auditIds(args: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  if (isUuid(args.contact_id)) ids.contact_id = args.contact_id;
  if (isUuid(args.list_id)) ids.list_id = args.list_id;
  return ids;
}

/**
 * A refused send, reminder or delete, recorded with its reason code and ids only. Nothing
 * happened, so a row that cannot be written is logged, never retried or alerted on, and
 * the refusal stands either way.
 */
async function refused(ctx: ToolContext, action: string, reason: string, args: Record<string, unknown>, message: string): Promise<ToolResult> {
  try {
    const { error } = await ctx.db.rpc('mcp_audit_row', {
      p_actor: ctx.actor, p_action: action, p_details: { ...auditIds(args), outcome: 'refused', reason }, p_ip: ctx.ip, p_user_agent: ctx.userAgent,
    });
    if (error) ctx.log.warn('refusal not audited', { action, reason });
  } catch {
    ctx.log.warn('refusal not audited', { action, reason });
  }
  return toolError(message);
}

/** The row written before an outward act. false when it could not be written: then nothing goes out. */
async function attemptRow(ctx: ToolContext, action: string, details: Record<string, string | number>): Promise<boolean> {
  try {
    const { error } = await ctx.db.rpc('mcp_audit_row', {
      p_actor: ctx.actor, p_action: action, p_details: details, p_ip: ctx.ip, p_user_agent: ctx.userAgent,
    });
    return !error;
  } catch {
    return false;
  }
}

/** Hand back a reminder claim whose reminder did not go out. A failure only leaves the day held. */
async function releaseClaim(ctx: ToolContext, listId: string, claim: ReminderClaim): Promise<void> {
  try {
    const { data, error } = await ctx.db.rpc('mcp_release_reminder', { p_list_id: listId, p_stamp: claim.stamp, p_previous: claim.previous ?? null });
    if (error) ctx.log.error('reminder claim not released', error);
    else if (data !== true) ctx.log.warn('reminder claim had nothing to hand back', { listId });
  } catch (err) {
    ctx.log.error('reminder claim not released', err);
  }
}

/** The owner's copy of a client email, as the provider answered; 'unknown' when the attempt broke partway. */
async function ownerReceipt(
  ctx: ToolContext,
  r: { action: 'sent' | 'reminded'; list: ReviewList; contact: ReviewRecipient; clientEmail: boolean | null; key: string },
): Promise<OwnerCopy> {
  try {
    return await ctx.outward.receipt({
      action: r.action,
      listId: r.list.id,
      contactId: r.contact.id,
      recipientName: `${r.contact.first_name ?? ''} ${r.contact.last_name ?? ''}`.trim(),
      recipientEmail: r.contact.email ?? '',
      title: r.list.title,
      intro: r.list.intro_message,
      items: r.list.items.map((it) => ({ label: it.label, kind: it.kind, required: it.required })),
      clientEmail: r.clientEmail,
      key: r.key,
    });
  } catch (err) {
    ctx.log.error('owner copy failed', err);
    return 'unknown';
  }
}

/** The owner's copy in a tool result: never "did not go out" when it may have. */
function receiptFields(copy: OwnerCopy, what: 'email' | 'reminder'): Record<string, unknown> {
  return {
    receipt_to_owner_sent: copy === 'sent' ? true : copy === 'failed' ? false : 'unknown',
    ...(copy === 'failed'
      ? { receipt_warning: `The owner's copy of this ${what} did not go out. The contact's ${what} is unaffected. Tell your user.` }
      : copy === 'unknown'
        ? { receipt_warning: `Whether the owner's copy of this ${what} went out is unknown (the mail provider did not answer). The contact's ${what} is unaffected. Tell your user.` }
        : {}),
  };
}

/**
 * One request-tool function whose audit row is written inside it. A failed audit insert
 * rolls the act back and raises 'mcp_request_audit: failed', so the whole call is retried
 * (it did not happen); after three attempts the owner is emailed, and the caller gets a
 * clear error. Every other answer, sentinel or not, is returned as it came.
 */
async function auditedRpc(
  ctx: ToolContext,
  fn: string,
  params: Record<string, unknown>,
  ids: Record<string, string>,
): Promise<{ data: unknown; error: unknown } | { failed: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await ctx.db.rpc(fn, { ...params, p_actor: ctx.actor, p_ip: ctx.ip, p_user_agent: ctx.userAgent });
    if (!sentinel(result.error, 'mcp_request_audit: failed')) return result;
    if (attempt < 3) await (ctx.sleep ?? wait)(attempt * 250);
  }
  ctx.log.warn('request tool refused: audit row could not be written', { fn });
  let alerted = false;
  try {
    alerted = await ctx.outward.alert(
      `Audit trail unavailable: ${fn}`,
      [
        'Your AI assistant tried an action, but its audit record could not be written after three attempts, so the action was NOT done. This email is the record of the attempt.',
        `Action: ${fn}`,
        ...Object.entries(ids).map(([k, v]) => `${k}: ${v}`),
        `When: ${new Date().toISOString()}`,
      ],
      `mcp-audit-unavailable:${fn}:${ids.list_id ?? ids.contact_id ?? ''}:${Date.now()}`,
    );
  } catch (err) {
    ctx.log.error('audit alert failed', err);
  }
  return {
    failed: `Nothing was done: the audit record could not be written, and this connector does nothing it cannot record. ${
      alerted ? 'The owner has been emailed.' : 'The owner could not be emailed; tell them.'
    } Try again later.`,
  };
}

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

  if (name === 'create_request') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const text = parseRequestText(args.title, args.intro_message);
    if ('error' in text) return toolError(text.error);
    const { request_categories, request_tags } = await ctx.vocabulary();
    const parsed = parseRequestItems(args.items, { categories: request_categories, tags: request_tags });
    if ('error' in parsed) return toolError(parsed.error);
    // Always a draft: the function writes status 'draft' and takes no status or sent_at.
    // A draft is invisible to the client, so nothing composed here reaches a client
    // before someone reads it back and sends it.
    const created = await auditedRpc(ctx, 'mcp_create_request', {
      p_contact_id: args.contact_id,
      p_title: text.title,
      p_intro: text.intro,
      p_items: parsed.items,
    }, { contact_id: args.contact_id });
    if ('failed' in created) return toolError(created.failed);
    const { data, error } = created;
    if (error) {
      if (sentinel(error, 'mcp_create_request: not_found')) return toolError(NO_CONTACT);
      if (sentinel(error, 'mcp_create_request: inactive_key')) return toolError(INACTIVE_KEY);
      throw error;
    }
    return toolText({
      created: data,
      note: 'Saved as a DRAFT. The contact cannot see it. Read it back to your user (the title, the intro message and every item), then call list_requests for its review_token and use update_request for changes, or send_request once they approve.',
    });
  }

  if (name === 'update_request') {
    if (!isUuid(args.list_id)) return toolError('list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const token = reviewToken(args.review_token);
    if ('error' in token) return toolError(token.error);
    // A full replacement: an omitted intro means none. Keeping the old one would keep text
    // the caller did not include in the version it read back for approval.
    const text = parseRequestText(args.title, args.intro_message);
    if ('error' in text) return toolError(text.error);
    const { request_categories, request_tags } = await ctx.vocabulary();
    const parsed = parseRequestItems(args.items, { categories: request_categories, tags: request_tags });
    if ('error' in parsed) return toolError(parsed.error);
    // The token binds the rewrite to the draft the caller read: an owner's edit since then
    // makes it stale here, and one landing after this check makes the function refuse.
    const found = await readRequest(ctx, args.contact_id, args.list_id);
    if (!found) return toolError(NO_REQUEST);
    const { contact, list } = found;
    if (list.status !== 'draft') return toolError(SENT_NOT_REWRITTEN);
    if (!(await ctx.review.verify(token.token, list.id, canonicalRequest(list, contact)))) return toolError(STALE_TOKEN);
    // One transaction in the database: the list is locked before its status and version
    // are checked, so a send or an edit landing mid-call makes this refuse instead of
    // rewriting a sent request or overwriting the edit.
    const updated = await auditedRpc(ctx, 'mcp_update_request', {
      p_list_id: list.id,
      p_contact_id: contact.id,
      p_expected_version: list.content_version,
      p_title: text.title,
      p_intro: text.intro,
      p_items: parsed.items,
    }, { contact_id: contact.id, list_id: list.id });
    if ('failed' in updated) return toolError(updated.failed);
    const { data, error } = updated;
    if (error) {
      if (sentinel(error, 'needs_replace_draft: not_found')) return toolError(NO_REQUEST);
      if (sentinel(error, 'needs_replace_draft: not_draft')) return toolError(SENT_NOT_REWRITTEN);
      if (sentinel(error, 'mcp_update_request: changed')) {
        return toolError('The draft changed since you read it (someone else edited it). Nothing was rewritten. Read it again with list_requests and check with your user before changing it.');
      }
      if (sentinel(error, 'mcp_update_request: inactive_key')) return toolError(INACTIVE_KEY);
      throw error;
    }
    return toolText({
      updated: { list_id: list.id, title: text.title, item_count: data },
      note: 'The draft now reads exactly as sent and the contact still cannot see it. Its review_token is now stale: call list_requests for a fresh one before sending or changing it again.',
    });
  }

  if (name === 'list_requests') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    // Read and audited in one transaction; the answer columns never leave the database.
    const read = await auditedRpc(ctx, 'mcp_list_requests', { p_contact_id: args.contact_id, p_limit: LIST_REQUESTS_LIMIT }, { contact_id: args.contact_id });
    if ('failed' in read) return toolError(read.failed);
    const { data, error } = read;
    if (error) throw error;
    const snap = data as RequestSnapshot | null;
    if (!snap) return toolError(NO_CONTACT);
    const requests = [];
    for (const list of snap.lists) {
      requests.push({
        list_id: list.id,
        title: list.title,
        status: list.status,
        intro_message: list.intro_message,
        asks_contact_to_confirm_details: list.include_contact_confirm,
        created_at: list.created_at,
        sent_at: list.sent_at,
        item_count: list.items.length,
        items: list.items.map((it) => ({
          label: it.label, kind: it.kind, description: it.description, required: it.required, sensitive: it.sensitive,
          category: it.category, tag: it.tag, answered: it.fulfilled,
        })),
        // A draft is a send target and a sent request a reminder target, so both get a
        // token. A submitted or closed one is neither.
        ...(list.status === 'draft' || list.status === 'sent'
          ? { review_token: await ctx.review.mint(list.id, canonicalRequest(list, snap.contact)) }
          : {}),
      });
    }
    const { id, first_name, last_name, email } = snap.contact;
    return toolText({
      contact: { contact_id: id, name: `${first_name ?? ''} ${last_name ?? ''}`.trim(), email },
      count: requests.length,
      truncated: snap.truncated,
      ...(snap.truncated
        ? { truncation_note: `This contact has more than ${LIST_REQUESTS_LIMIT} requests and only the ${LIST_REQUESTS_LIMIT} newest are listed. Do not tell your user this is all of them; the rest are in the CRM.` }
        : {}),
      requests,
    });
  }

  if (name === 'send_request') {
    const refuse = (reason: string, message: string) => refused(ctx, 'mcp_send_request', reason, args, message);
    // The budget first: one email to a client per HTTP request, whichever tool sends it.
    if (ctx.budget.sends >= MAX_SENDS_PER_REQUEST) {
      return refuse('budget', 'Only one email to a contact can go out per call. Send this one in a separate step, after reporting the last.');
    }
    if (!isUuid(args.list_id)) return refuse('invalid_id', 'list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return refuse('invalid_id', 'contact_id must be a valid id.');
    const token = reviewToken(args.review_token);
    if ('error' in token) return refuse('invalid_token', token.error);
    if (args.confirmed_with_user !== true) {
      return refuse(
        'unconfirmed',
        'Not sent. Read the recipient, the title, the intro message and every item back to your user, get their explicit go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // The named contact is bound to the stored request (a wrong-recipient send is the one
    // mistake no content review would catch), and the token is checked against what is
    // stored now.
    const found = await readRequest(ctx, args.contact_id, args.list_id);
    if (!found) return refuse('not_found', NO_REQUEST);
    const { contact, list } = found;
    if (list.status !== 'draft') return refuse('not_draft', `That request is ${list.status}, not a draft, so it cannot be sent again.`);
    if (!(await ctx.review.verify(token.token, list.id, canonicalRequest(list, contact)))) return refuse('stale_token', STALE_TOKEN);
    if (list.items.some((it) => !MCP_SENDABLE_KINDS.includes(it.kind))) {
      return refuse('unsendable_item', 'That request holds an item this connector cannot describe, so it cannot be sent from here. The owner sends it from the CRM.');
    }

    // Spent on the ATTEMPT, not on success: a failed send must not leave room for another
    // client email in the same HTTP request.
    ctx.budget.sends++;
    const record = { contact_id: contact.id, list_id: list.id };
    // Recorded before anything goes out, so a runtime killed between the publish and the
    // result row still leaves a trace. Nothing is sent that could not be recorded.
    if (!(await attemptRow(ctx, 'mcp_send_request', { ...record, outcome: 'attempt', content_version: list.content_version }))) {
      return refuse('audit_unavailable', NO_AUDIT);
    }
    let sent: OutwardSend;
    try {
      // The publish compares the version the token was verified over, and the send
      // re-checks the address that was read back: an edit landing after the check above
      // publishes nothing.
      sent = await ctx.outward.send({ listId: list.id, actor: ctx.actor, version: list.content_version, email: contact.email ?? '' }, ctx.log);
    } catch (err) {
      // A failure partway (the publish answered nothing, say) may or may not have
      // published: say so, and never "nothing was sent".
      ctx.log.error('request send failed', err);
      const warning = await auditDelegated(ctx, 'mcp_send_request', { ...record, outcome: 'unknown' });
      return toolError(`The send failed partway, so whether the request was published is unknown. Do not retry it; ask your user to check the request in the CRM.${warning ? ` ${warning}` : ''}`);
    }
    if (sent.status !== 'sent') {
      const warning = await auditDelegated(ctx, 'mcp_send_request', { ...record, outcome: sent.status });
      if (sent.status === 'already_sent') {
        // Another call published it first, so nothing went out twice. Whether ITS email
        // reached the contact is not knowable here.
        return toolText({
          sent: { list_id: list.id, title: list.title },
          email_sent: 'unknown',
          note: 'Another call had already sent this request, so nothing went out twice and the contact can see it in their portal. Whether the notification email was delivered is not knowable from here; remind_request sends a fresh one if your user needs certainty.',
          ...(warning ? { warning } : {}),
        });
      }
      return toolError(`${SEND_REFUSALS[sent.status]} Nothing was sent.${warning ? ` ${warning}` : ''}`);
    }

    const receiptCopy = await ownerReceipt(ctx, {
      action: 'sent', list, contact, clientEmail: sent.email, key: `mcp-receipt:send:${list.id}`,
    });
    const emailSent = sent.email === null ? 'unknown' : sent.email;
    const warning = await auditDelegated(ctx, 'mcp_send_request', {
      ...record, outcome: 'sent', email_status: sent.email === true ? 'sent' : sent.email === false ? 'failed' : 'unknown', receipt_status: receiptCopy,
    });
    return toolText({
      sent: { list_id: list.id, title: list.title },
      // The publish and the email are different facts: the request is visible either way,
      // and a delivery that did not happen is never reported as one.
      email_sent: emailSent,
      note: sent.email === true
        ? 'Sent. The contact can see this request in their portal and a notification email went out.'
        : sent.email === false
          ? 'The request is visible to the contact in their portal, but the notification email DID NOT go out. Tell your user, and offer remind_request.'
          : 'The request is visible to the contact in their portal. Whether the notification email was delivered is unknown (the mail provider did not answer). Tell your user.',
      ...receiptFields(receiptCopy, 'email'),
      ...(warning ? { warning } : {}),
    });
  }

  if (name === 'remind_request') {
    const refuse = (reason: string, message: string) => refused(ctx, 'mcp_remind_request', reason, args, message);
    // The same budget as send_request: both put an email in a client's inbox.
    if (ctx.budget.sends >= MAX_SENDS_PER_REQUEST) {
      return refuse('budget', 'Only one email to a contact can go out per call. Send this reminder in a separate step, after reporting the last.');
    }
    if (!isUuid(args.list_id)) return refuse('invalid_id', 'list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return refuse('invalid_id', 'contact_id must be a valid id.');
    const token = reviewToken(args.review_token);
    if ('error' in token) return refuse('invalid_token', token.error);
    if (args.confirmed_with_user !== true) {
      return refuse(
        'unconfirmed',
        'Not sent. Tell your user who this reminder goes to and what it is about, get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    const found = await readRequest(ctx, args.contact_id, args.list_id);
    if (!found) return refuse('not_found', NO_REQUEST);
    const { contact, list } = found;
    if (list.status !== 'sent') {
      return refuse(
        'not_sent',
        list.status === 'draft'
          ? 'That request is still a draft and has never been sent, so there is nothing to remind about. Use send_request.'
          : `That request is ${list.status}, so a reminder would not make sense.`,
      );
    }
    if (!(await ctx.review.verify(token.token, list.id, canonicalRequest(list, contact)))) return refuse('stale_token', STALE_TOKEN);

    ctx.budget.sends++;
    const record = { contact_id: contact.id, list_id: list.id };
    // One reminder a day per request from here, claimed in one guarded write: a token
    // binds content, not a count, and would otherwise license a reminder on every call.
    const { data: claimData, error: claimError } = await ctx.db.rpc('mcp_claim_reminder', { p_list_id: list.id, p_contact_id: contact.id });
    if (claimError) {
      ctx.log.error('reminder claim failed', claimError);
      return refuse('claim_error', 'The reminder could not be scheduled, so nothing was sent. Try again later, or the owner reminds them from the CRM.');
    }
    const claim = claimData as ReminderClaim | null;
    if (claim?.claimed !== true) {
      return refuse('reminder_claimed', 'That contact was sent a reminder about this request less than a day ago. Nothing was sent; wait, or the owner reminds them from the CRM.');
    }
    // The claim moved the column the automatic reminders schedule from: any outcome but a
    // reminder that went out hands it back, so a failure here never delays the automatic one.
    if (!(await attemptRow(ctx, 'mcp_remind_request', { ...record, outcome: 'attempt', content_version: list.content_version }))) {
      await releaseClaim(ctx, list.id, claim);
      return refuse('audit_unavailable', NO_AUDIT);
    }
    let reminded: OutwardRemind & { reminderCount?: number };
    try {
      // The reminder compares the version the token was verified over and the address
      // that was read back, and re-verifies the token over the request as it stands after
      // reading the open count, answers included: an edit or an answer landing after the
      // check above sends nothing.
      const recheck = async () => {
        const again = await readRequest(ctx, contact.id, list.id);
        return again !== null && again.list.status === 'sent' &&
          (await ctx.review.verify(token.token, list.id, canonicalRequest(again.list, again.contact)));
      };
      reminded = await ctx.outward.remind({ listId: list.id, actor: ctx.actor, version: list.content_version, email: contact.email ?? '', recheck }, ctx.log);
    } catch (err) {
      ctx.log.error('request reminder failed', err);
      await releaseClaim(ctx, list.id, claim);
      const warning = await auditDelegated(ctx, 'mcp_remind_request', { ...record, outcome: 'unknown' });
      return toolError(`The reminder failed partway, so whether it was emailed is unknown. Do not retry it; ask your user to check the request in the CRM.${warning ? ` ${warning}` : ''}`);
    }
    if (reminded.status !== 'reminded') {
      await releaseClaim(ctx, list.id, claim);
      const warning = await auditDelegated(ctx, 'mcp_remind_request', { ...record, outcome: reminded.status });
      return toolError(`${REMIND_REFUSALS[reminded.status]}${warning ? ` ${warning}` : ''}`);
    }
    // A reminder fails closed on a refused email (a reminder is the email), so reaching
    // here means it was accepted, or its answer was lost.
    const receiptCopy = await ownerReceipt(ctx, {
      action: 'reminded', list, contact, clientEmail: reminded.email === 'sent' ? true : null,
      key: `mcp-receipt:remind:${list.id}:${reminded.reminderCount ?? 0}`,
    });
    const warning = await auditDelegated(ctx, 'mcp_remind_request', {
      ...record, outcome: 'reminded', email_status: reminded.email, remaining: reminded.remaining, receipt_status: receiptCopy,
    });
    return toolText({
      reminded: { list_id: list.id, title: list.title, items_open: reminded.remaining },
      email_sent: reminded.email === 'sent' ? true : 'unknown',
      note: reminded.email === 'sent'
        ? 'Reminder emailed to the contact.'
        : 'The reminder was handed to the mail provider, but its answer was lost, so delivery is unknown. Tell your user.',
      ...receiptFields(receiptCopy, 'reminder'),
      ...(warning ? { warning } : {}),
    });
  }

  if (name === 'delete_request') {
    const refuse = (reason: string, message: string) => refused(ctx, 'mcp_delete_request', reason, args, message);
    if (!isUuid(args.list_id)) return refuse('invalid_id', 'list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return refuse('invalid_id', 'contact_id must be a valid id.');
    const token = reviewToken(args.review_token);
    if ('error' in token) return refuse('invalid_token', token.error);
    if (args.confirmed_with_user !== true) {
      return refuse(
        'unconfirmed',
        'Not deleted. Read the draft back to your user (the title and every item), get their explicit go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    const found = await readRequest(ctx, args.contact_id, args.list_id);
    if (!found) return refuse('not_found', NO_REQUEST);
    const { contact, list } = found;
    if (list.status !== 'draft') {
      return refuse('not_draft', `That request is ${list.status}, not a draft. A sent request holds the contact's answers and files; the owner deletes one in the CRM, where what would be lost is visible.`);
    }
    if (!(await ctx.review.verify(token.token, list.id, canonicalRequest(list, contact)))) return refuse('stale_token', STALE_TOKEN);
    // One transaction: the list locked, deleted only at the version the token was verified
    // over and only with no client data on it, audited with it.
    const deleted = await auditedRpc(ctx, 'mcp_delete_request', {
      p_list_id: list.id,
      p_contact_id: contact.id,
      p_expected_version: list.content_version,
    }, { contact_id: contact.id, list_id: list.id });
    if ('failed' in deleted) return refuse('audit_unavailable', deleted.failed);
    const { data, error } = deleted;
    if (error) {
      if (exactSentinel(error, 'not_found')) return refuse('not_found', NO_REQUEST);
      if (exactSentinel(error, 'not_draft')) {
        return refuse('not_draft', "That request was sent while you were working, so its items may hold the contact's answers. Nothing was deleted.");
      }
      if (exactSentinel(error, 'stale_content')) {
        return refuse('stale_content', 'The draft changed since you read it. Nothing was deleted. Read it again with list_requests and confirm with your user.');
      }
      if (exactSentinel(error, 'has_answers') || exactSentinel(error, 'has_documents')) {
        return refuse('has_client_data', 'That draft has contact data attached, which this tool never destroys. Nothing was deleted; the owner handles it in the CRM.');
      }
      throw error;
    }
    return toolText({
      deleted: { list_id: list.id, title: list.title, item_count: (data as { item_count?: number } | null)?.item_count ?? list.items.length },
      note: 'Draft deleted. The contact never saw it. This cannot be undone.',
    });
  }

  return toolError(`Unknown tool: ${name}`);
}
