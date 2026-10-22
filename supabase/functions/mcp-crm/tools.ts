// The contact tools mcp-crm offers, and what each does. Every read and write goes through
// one mcp_* function in 0007_mcp.sql or 0015_mcp.sql, which writes its audit row inside the
// same transaction: a write either commits with its record or not at all, so a retry is safe.
//
// The owner chose near full access for the connector: it reads and writes the whole contact
// record. What stays bounded, and why:
//   * A quote is written PROPOSED (upsert_quote). accept_quote is the one way to accepted,
//     on the user's explicit go-ahead (confirmed_with_user), and it moves the contact's
//     stage the way the CRM's own accept does, in the same transaction. An accepted quote
//     is never changed or deleted here: that is live work.
//   * A note can be logged, corrected (update_note) and deleted (delete_note, on the
//     go-ahead). Its source is never writable, so a note this connector wrote can never be
//     relabelled as the owner's.
//   * The contact's own address changes only through correct_contact_email, which refuses
//     any contact with a portal account, or change_portal_email, which moves a portal
//     account's sign-in. Each demands the address the caller read (a compare-and-swap) and
//     the go-ahead. change_portal_email changes Auth first, through ctx.privileged, so a
//     refusal there changes nothing. A spouse's address is an ordinary field unless a portal
//     account signs in with it.
//   * The reads of what a client sent (read_request_answers, list_documents,
//     read_document_text) are audited inside the read's own transaction before anything
//     returns. A sensitive answer leaves the database encrypted and is opened here, never
//     stored opened; only plain text and CSV documents are read, never a PDF, an image or a
//     spreadsheet.
//   * add_business adds a registry entry and nothing else.
//   * A stage changes only through set_contact_status, compare-and-swapped on the stage the
//     caller read, and never into or out of the system status (a contact created only to
//     sign, whose address is unproven): promoting one is the owner's call. The status
//     trigger writes the history and the client-since date, as for the owner's own change.
//     An archived contact is not searched, moved, or given new board work.
//
// The board tools work the owner's work board (0008): a move needs a reason and the lane
// the caller read, an archived card is not moved, edited or noted, and a note is
// append-only. Board history
// is owner-only, so nothing here reaches a client.
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
//   * close_request and accept_request mirror the owner's Close and Accept all. Each changes
//     what the client sees, so each needs the user's explicit go-ahead; neither emails
//     anyone or deletes anything, and a draft is never closed (the client never saw it).
//   * set_request_reminders pauses or resumes one request's automatic reminders and sends
//     nothing. list_open_requests is the roster of every open request; it returns no
//     answer and no token. It and list_requests sort requests by whose move it is through
//     _shared/request-roster.ts, the rule the browser's roster uses, never one of their own.
//     Accepting the last answer can close a request (0014); accept_request reports the
//     status as stored afterwards.
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
import { answersToAccept, requestRosterSections } from '../_shared/request-roster.ts';
import { REVIEW_TOKEN_RE, canonicalRequest, type ReviewItem, type ReviewList, type ReviewRecipient, type ReviewSigner } from './review-token.ts';
import {
  CARD_PRIORITIES,
  CONTACT_CLEARABLE,
  CONTACT_CREATABLE,
  CONTACT_TIERS,
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
  parseBoardDate,
  parseBoardNote,
  parseCardTitle,
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

/** A key and the label the owner gave it. */
export interface Labelled {
  key: string;
  label: string;
}

/** The active pick-list keys, read once per request when a tool needs them. */
export interface Vocabulary {
  /** Every stored status: a search filter, and what a caller may say it read. */
  statuses: string[];
  /** The stages a model may set: every status but the system one. */
  selectable_statuses: Labelled[];
  lead_sources: string[];
  organization_types: string[];
  service_types: string[];
  request_categories: string[];
  request_tags: string[];
  /** The board's lanes, in order. The owner relabels them, so a model is given both. */
  board_stages: Labelled[];
  work_item_types: string[];
}

/**
 * What a tool needs beyond the database: the answer key, Storage and Auth. index.ts wires
 * each over the server's own clients and keys; tests pass fakes. Nothing here audits: the
 * database function a tool calls first does.
 */
export interface PrivilegedOps {
  /** Opens a sensitive answer's ciphertext (bytea as text) with the answer key. Throws when it cannot. */
  openAnswer(ciphertext: string): Promise<string>;
  /** A stored document's plaintext: downloaded, then opened when it is encrypted. Throws on any failure. */
  readDocument(doc: { storage_path: string; encryption_status: string; encryption_iv: string | null }): Promise<Uint8Array>;
  /**
   * Moves a sign-in user's address in Auth, confirmed. 'refused' when Auth answers with a
   * refusal (most often an address another sign-in holds): then nothing changed. Throws when
   * the outcome is unknown.
   */
  setSignInEmail(userId: string, email: string): Promise<'changed' | 'refused'>;
}

export interface ToolContext {
  db: ToolDb;
  privileged: PrivilegedOps;
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
/** Rows list_open_requests returns; it says so when there are more. */
export const LIST_OPEN_REQUESTS_LIMIT = 500;
/** Cards list_board returns; it says so when there are more. */
export const BOARD_LIST_LIMIT = 200;
/** Documents list_documents returns by default, and at most. */
export const DOCUMENT_LIST_DEFAULT = 100;
export const DOCUMENT_LIST_MAX = 500;
/** Characters read_document_text returns; it says when a file is longer. */
export const DOCUMENT_TEXT_LIMIT = 20_000;

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
      'Search CRM contacts by name, email, phone or business name. Returns a compact list with id, name, email, phone, business name and status, newest first. Archived contacts are left out, as they are off the working list. Use it to find a contact id before calling get_contact or update_contact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A name, email, phone or business name fragment. Phone numbers are stored as typed, so search a short run of digits such as the last four. Leave it out to list the newest contacts.',
        },
        status: { type: 'string', description: 'Optional status filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows, 1 to 100. Default 25.' },
      },
    },
  },
  {
    name: 'get_contact',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Fetch one contact's whole record: name, email, phone, business name, stage, spouse, mailing address, lead source, tier, client-since date and whether it is archived; every address on their email list; their portal accounts (status and sign-in address); their businesses; their quotes (service, state, cadence, amount and which business each sits on); and their 20 newest notes, each with its id.",
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
      'Create a new contact, for example a lead who just called or emailed. It needs an email OR a phone number (at least one). Search with search_contacts first so you do not create a duplicate; an address already on file is refused. It lands in the first stage of the pipeline unless you pass status. Ask your user how the lead found them and pass it as source; when you do not know, leave it out and it records as other. Use log_call_note to record anything about the conversation. It does not create businesses, quotes or a portal account.',
    inputSchema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        business_name: { type: 'string' },
        status: { type: 'string', description: 'The pipeline stage. Defaults to new_lead.' },
        source: { type: 'string', description: 'How the lead found your user. Defaults to other.' },
      },
    },
  },
  {
    name: 'update_contact',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Update an existing contact's details: names, phone, business name, the spouse's name, address and phone, the mailing address, the lead source and the tier. Send only what changes; an empty value (or null) clears a field. The contact's own email cannot be changed here, because it routes portal invitations and sign-in: use correct_contact_email for a contact with no portal account, or change_portal_email to move a portal account's sign-in. A spouse's address that a portal account signs in with is refused here too. Notes go through log_call_note and update_note; the stage through set_contact_status; quotes through upsert_quote and accept_quote.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        business_name: { type: 'string' },
        spouse_first_name: { type: 'string' },
        spouse_last_name: { type: 'string' },
        spouse_email: { type: 'string' },
        spouse_phone: { type: 'string' },
        mailing_street: { type: 'string' },
        mailing_city: { type: 'string' },
        mailing_state: { type: 'string' },
        mailing_zip: { type: 'string' },
        source: { type: 'string', description: 'How the contact found your user.' },
        tier: { type: ['string', 'null'], enum: [...CONTACT_TIERS, null], description: 'The client tier, S (best) to E. null clears it.' },
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
    name: 'change_portal_email',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Change the email address a portal account signs in with. It moves the sign-in itself and the contact's matching address together, so the client's next sign-in and every future invitation use the new address. Use it only when the client asked for the change. Read the contact with get_contact first and pass the account's current address (portal_accounts[].invited_email) as expected_current_email: the call is refused unless that still matches. Read the account, the current address and the new one back to your user and get their go-ahead first. An account with no sign-in yet (an invitation not accepted) cannot be changed here.",
    inputSchema: {
      type: 'object',
      properties: {
        portal_account_id: { type: 'string', description: 'The account id, from get_contact portal_accounts.' },
        new_email: { type: 'string' },
        expected_current_email: {
          type: ['string', 'null'],
          description: 'The address the account signs in with now, as get_contact reported it; null only if it has none.',
        },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard the account, the current address and the new one, and told you to make the change.',
        },
      },
      required: ['portal_account_id', 'new_email', 'expected_current_email', 'confirmed_with_user'],
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
      "Add a note to a contact's record, typically a summary of a phone call. This only adds a note; it never overwrites one (update_note corrects a note, delete_note removes one). Use it after a call to capture what was discussed and agreed.",
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
    name: 'update_note',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Correct an existing note on a contact's record: its text, its kind, or both. Send only what changes. Each note is one row, so this edits that note and nothing else. Read the note back to your user first: a note can hold what was agreed on a call, and rewriting it replaces that record. Who wrote the note never changes.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        note_id: { type: 'string', description: 'The note id, from get_contact recent_notes.' },
        body: { type: 'string', description: 'The corrected text, up to 10000 characters.' },
        kind: { type: 'string', enum: [...NOTE_KINDS] },
      },
      required: ['contact_id', 'note_id'],
    },
  },
  {
    name: 'delete_note',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Permanently delete one note from a contact's record, for example a note logged against the wrong person or a duplicate. Read the note back to your user first and get their go-ahead. It cannot be undone.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        note_id: { type: 'string', description: 'The note id, from get_contact recent_notes.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard which note this is and told you to delete it.',
        },
      },
      required: ['contact_id', 'note_id', 'confirmed_with_user'],
    },
  },
  {
    name: 'upsert_quote',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Record what you are quoting a contact for a service, as a PROPOSED quote, on the contact or on one of their businesses when organization_id is given. This writes a proposal only: accept_quote turns it into accepted work. Quoting the same service on the same business again updates that proposed quote. An accepted quote is never changed here.',
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
    name: 'accept_quote',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Accept a PROPOSED quote: it becomes accepted work, it counts toward the revenue figures, and the contact moves to client (or one-time client, for one-time work alone) unless their stage is lost, cold or former client, which a quote never changes. Read the quote back to your user first (the service, the amount, the cadence and whether it sits on the contact or one of their businesses) and get their go-ahead. Send the quote's service and business exactly as get_contact reported them: with the id they prove you are accepting the quote you read, and a quote moved since is refused. A contact created only to sign, or an archived one, is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        quote_id: { type: 'string', description: 'The quote id, from get_contact.' },
        service_type: {
          type: 'string',
          description: 'The service the quote is for, as get_contact reported it. Proves you are accepting the quote you read.',
        },
        organization_id: {
          type: 'string',
          description: 'The business the quote sits on, as get_contact reported it. Leave it out for a quote on the contact itself.',
        },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard which quote this is and told you to accept it.',
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
      "List a contact's requests, newest first, with everything the contact sees: the recipient's name and address, and for each request its id, title, intro message, status, and every item's label, description, kind, whether it is required, whether it is sensitive, whether it has been answered and whether that answer has been accepted. Each request also says whose move it is (section: waiting_on_you when the contact submitted it or an answer waits to be accepted, waiting_on_client, drafts or archived, the same sections as the CRM's requests screen) and how many answers wait to be accepted. The contact's ANSWERS are never returned. At most 25 requests come back; when there are more, truncated is true and you must not call the list complete. Each draft and each sent request carries a review_token, which update_request, send_request, remind_request and delete_request require. Any change to the request, its items, its answers or the recipient makes the token stale, so read it again after a change.",
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'read_request_answers',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Read what a contact answered on their requests: every item's typed answer (a sensitive answer is opened for you), and the files uploaded to each item (name, folder, size, type and when). Drafts are left out, since a contact never saw one. The 25 newest requests, or one when list_id is given. This reads client data, and every call is recorded in the audit log; use it when the task needs the answers, never just to summarise a contact.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        list_id: { type: 'string', description: 'Optional: one request, from list_requests. Leave it out for every request.' },
      },
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
  {
    name: 'list_open_requests',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Every contact's open requests in one list, grouped by whose move it is, the same sections as the CRM's requests screen: waiting_on_you (the contact submitted it, or a sent request has an answer to accept), waiting_on_client (sent, nothing to accept) and drafts. Closed requests are left out. Each row names the contact, the request id and its title, so you can follow up with list_requests for that contact. At most 500 rows come back; when there are more, truncated is true and you must not call the list complete. Read only: no answers and no review tokens come back here.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Close a request that has been SENT, whether or not the contact finished it, the same as the owner's Close in the CRM. Closing ends it: the contact can change nothing more on it and its reminder emails stop. Nothing the contact answered or uploaded is deleted. A draft cannot be closed (the contact never saw it; use delete_request). Tell your user which request this is (the contact and the title, from list_requests or list_open_requests) and get their go-ahead first. Closing a request that is already closed is not an error.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The request id, from list_requests or list_open_requests.' },
        contact_id: { type: 'string', description: 'The contact the request belongs to. Must match.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has heard which request this is and told you to close it.',
        },
      },
      required: ['list_id', 'contact_id', 'confirmed_with_user'],
    },
  },
  {
    name: 'accept_request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Accept every answer the contact has given on a request, the same as the owner's Accept all in the CRM: an accepted answer is locked, and the contact can no longer change it. Only answered items are accepted; anything still unanswered stays open, and the result says how many. When that leaves nothing to do on the request, it closes itself (request_status says closed), as in the CRM; a request still asking the contact to confirm their details stays open until they submit. Otherwise call close_request after it if your user wants it closed too. Tell your user which request this is and get their go-ahead first.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The request id, from list_requests or list_open_requests.' },
        contact_id: { type: 'string', description: 'The contact the request belongs to. Must match.' },
        confirmed_with_user: {
          type: 'boolean',
          description: 'Must be true. Set it only after your user has told you to accept the answers on this request.',
        },
      },
      required: ['list_id', 'contact_id', 'confirmed_with_user'],
    },
  },
  {
    name: 'set_request_reminders',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Pause or resume the automatic reminder emails for one request. Pausing stops the automatic reminders about it; resuming lets them continue on their normal schedule. It changes nothing else, sends nothing itself, and leaves any review_token you hold valid.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The request id, from list_requests or list_open_requests.' },
        contact_id: { type: 'string', description: 'The contact the request belongs to. Must match.' },
        paused: { type: 'boolean', description: 'true pauses the reminders, false resumes them.' },
      },
      required: ['list_id', 'contact_id', 'paused'],
    },
  },
  {
    name: 'set_contact_status',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Move a contact to another stage of the CRM pipeline. Pass the status you last read (search_contacts or get_contact) as expected_status; the move is refused if it has changed since, so read it again and confirm with your user. Moving someone to a client stage records their client-since date the first time. A contact created only to sign a document (status esign_signer) cannot be moved here, nor can an archived contact: the owner does both in the CRM. This changes the stage only: it accepts no quote.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        status: { type: 'string', description: 'The stage to move them to.' },
        expected_status: { type: 'string', description: 'The status the contact has now, as you read it.' },
      },
      required: ['contact_id', 'status', 'expected_status'],
    },
  },
  {
    name: 'list_board',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List the cards on the work board: your user's own to-dos, each optionally tied to a contact. Cards are private to your user; a contact never sees them. Archived cards are left out, as they are on the board. The answer gives each lane's stored key and the label your user sees; use the key in every other board tool. At most 200 cards come back; when there are more, truncated is true and you must not call the list complete.",
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'Only this lane.' },
        contact_id: { type: 'string', description: 'Only the cards tied to this contact.' },
      },
    },
  },
  {
    name: 'create_work_item',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Add a card to the work board: a to-do for your user, optionally tied to a contact. Cards are private to your user. It lands in the todo lane unless you pass stage.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the work is, 200 characters at most.' },
        contact_id: { type: 'string', description: 'Optional. The contact this work is for.' },
        stage: { type: 'string', description: 'The lane, by its key. Defaults to todo.' },
        work_item_type: { type: 'string', description: 'The kind of work. Defaults to task.' },
        priority: { type: 'string', enum: [...CARD_PRIORITIES], description: 'Defaults to normal.' },
        due_date: { type: 'string', description: 'Optional, YYYY-MM-DD.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_work_item',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Edit a card on the work board: its title, contact, kind of work, priority or due date. Send only the fields you are changing; pass null for contact_id or due_date to clear it. To move it to another lane use move_work_item, which needs a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'string' },
        title: { type: 'string' },
        contact_id: { type: ['string', 'null'] },
        work_item_type: { type: 'string' },
        priority: { type: 'string', enum: [...CARD_PRIORITIES] },
        due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear it.' },
      },
      required: ['work_item_id'],
    },
  },
  {
    name: 'move_work_item',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Move a card to another lane of the work board. A move needs a short reason, the same as dragging a card on the board; it is kept in the card's history. Pass the lane you last read (list_board) as expected_stage; the move is refused if the card has moved since. An archived card is not moved.",
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'string' },
        to_stage: { type: 'string', description: 'The lane it is going to, by its key.' },
        expected_stage: { type: 'string', description: 'The lane it is in now, as you read it.' },
        reason: { type: 'string', description: 'Why it is moving, in a sentence. 2000 characters at most.' },
      },
      required: ['work_item_id', 'to_stage', 'expected_stage', 'reason'],
    },
  },
  {
    name: 'add_work_item_note',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Add a note to a card's history without moving it. Notes are private to your user and append-only: this can never change or delete an earlier note.",
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'string' },
        note: { type: 'string', description: 'The note, 2000 characters at most.' },
      },
      required: ['work_item_id', 'note'],
    },
  },
  {
    name: 'list_documents',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List the documents on a contact's record, newest first: id, name, folder, category, size, type, who holds it (the owner's section or the contact's) and whether it has been reviewed. Metadata only; read_document_text returns the contents of a plain text or CSV file. Every call is recorded in the audit log.",
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: DOCUMENT_LIST_MAX, description: `Max documents, 1 to ${DOCUMENT_LIST_MAX}. Default ${DOCUMENT_LIST_DEFAULT}.` },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'read_document_text',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      `Read the text of a plain text or CSV document, opened on the server; the first ${DOCUMENT_TEXT_LIMIT.toLocaleString('en-US')} characters, and it says when the file is longer. A PDF, an image or a spreadsheet is refused: those are opened in the CRM's document viewer. Every call is recorded in the audit log.`,
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'The document id, from list_documents or read_request_answers.' },
      },
      required: ['document_id'],
    },
  },
];


export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/**
 * The catalog as tools/list returns it: the pick-list enums filled in from the database at
 * request time, so a key the owner adds or deactivates shows up without a deploy, and the
 * stage and lane labels appended to the descriptions that need them. delete_quote's service_type gets no enum on purpose: a quote on a service deactivated
 * since must stay deletable.
 */
export function toolCatalog(vocab: Vocabulary): unknown[] {
  type Props = Record<string, Record<string, unknown>>;
  const catalog = structuredClone(TOOLS) as unknown as Array<{ name: string; description: string; inputSchema: { properties: Props } }>;
  const props = (tool: string) => catalog.find((t) => t.name === tool)!.inputSchema.properties;
  const set = (tool: string, prop: string, values: string[]) => {
    props(tool)[prop].enum = [...values];
  };
  const stages = vocab.selectable_statuses.map((s) => s.key);
  const lanes = vocab.board_stages.map((s) => s.key);
  set('search_contacts', 'status', vocab.statuses);
  set('create_contact', 'status', stages);
  set('create_contact', 'source', vocab.lead_sources);
  set('set_contact_status', 'status', stages);
  set('set_contact_status', 'expected_status', vocab.statuses);
  for (const [tool, prop] of [['list_board', 'stage'], ['create_work_item', 'stage'], ['move_work_item', 'to_stage'], ['move_work_item', 'expected_stage']]) {
    set(tool, prop, lanes);
  }
  set('create_work_item', 'work_item_type', vocab.work_item_types);
  set('update_work_item', 'work_item_type', vocab.work_item_types);
  // The owner names the stages and lanes, and a stored key need not read like its label
  // ('doing' may show as 'In progress'): a model told only one of the two moves things to
  // the wrong place. So each description carries both, as the owner has them now.
  const guide = (label: string, list: Labelled[]) => ` ${label}, stored key = what your user sees: ${list.map((s) => `${s.key} = ${s.label}`).join(', ')}.`;
  const describe = (tool: string, text: string) => {
    catalog.find((t) => t.name === tool)!.description += text;
  };
  for (const tool of ['create_contact', 'set_contact_status']) describe(tool, guide('Pipeline stages', vocab.selectable_statuses));
  for (const tool of ['list_board', 'create_work_item', 'move_work_item']) describe(tool, guide('Lanes', vocab.board_stages));
  set('add_business', 'organization_type', vocab.organization_types);
  set('upsert_quote', 'service_type', vocab.service_types);
  set('update_contact', 'source', vocab.lead_sources);
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
const NO_NOTE = 'No note with that id on that contact. Read the contact again with get_contact.';
const NO_CARD = 'No card with that id. Read the board again with list_board.';
/** An archived card is off the board: nothing here changes it. */
const ARCHIVED_CARD = (what: 'edited' | 'moved' | 'noted') =>
  `That card is archived, so it is not on the board. Nothing was ${what}. The owner restores it from Archived on the board first.`;
const INACTIVE_TYPE = 'That kind of work is not in use any more. List the tools again for the current ones.';

/**
 * The roster's section keys as this server names them. Which section a request is in, and
 * the order, are decided only by _shared/request-roster.ts (the browser's roster too); this
 * renames two keys so a model reads whose move it is. Any other key passes through.
 */
const SECTION_NAMES: Record<string, string> = { yours: 'waiting_on_you', client: 'waiting_on_client' };
const sectionName = (key: string) => SECTION_NAMES[key] ?? key;

/** A card's contact refused by mcp_work_item_contact_ok, as a message; null for any other error. */
function boardContactRefusal(error: unknown, fn: string): string | null {
  if (sentinel(error, `${fn}: contact_not_found`)) return NO_CONTACT;
  if (sentinel(error, `${fn}: contact_archived`)) return 'That contact is archived, so no new work is tied to it. The owner restores it in the CRM first. Nothing was saved.';
  return null;
}

const SENT_NOT_REWRITTEN ="That request has been sent, so it cannot be rewritten: its items hold the contact's answers. Create a new request instead.";

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

/** mcp_request_snapshot's answer: the shape the review tokens are minted over, plus each item's stored status. */
interface RequestSnapshot {
  contact: ReviewRecipient;
  lists: Array<Omit<ReviewList, 'items'> & { items: Array<ReviewItem & { status: string }> }>;
  truncated: boolean;
}

/** One row of mcp_list_open_requests: a request with each item's kind and status, never an answer. */
interface OpenRequestRow {
  list_id: string;
  contact_id: string;
  client: string | null;
  title: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  submitted_at: string | null;
  reminders_paused: boolean;
  reminder_count: number;
  items: Array<{ kind: string; status: string }>;
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
    // A blank address or phone is an absent one, so a lead who phoned in is not refused for
    // carrying email: "".
    for (const k of ['email', 'phone'] as const) {
      if (typeof patch[k] === 'string' && !(patch[k] as string).trim()) delete patch[k];
    }
    if (patch.email === undefined && patch.phone === undefined) return toolError('An email or a phone number is required.');
    if (patch.email !== undefined) {
      // Normalize BEFORE validating: the pattern check runs on the trimmed address, so a
      // padded but otherwise valid address is accepted rather than refused.
      const norm = normalizeEmail(patch.email);
      if ('error' in norm) return toolError(norm.error);
      patch.email = norm.email;
    }
    const bad = validateContactPatch(patch);
    if (bad) return toolError(`${bad}.`);
    if (typeof patch.phone === 'string') patch.phone = patch.phone.trim();
    if (args.status !== undefined && args.status !== null) {
      const stages = (await ctx.vocabulary()).selectable_statuses.map((s) => s.key);
      if (typeof args.status !== 'string' || !stages.includes(args.status)) return toolError(`status must be one of: ${stages.join(', ')}.`);
      patch.status = args.status;
    }
    if (args.source !== undefined && args.source !== null) {
      const { lead_sources } = await ctx.vocabulary();
      if (typeof args.source !== 'string' || !lead_sources.includes(args.source)) return toolError(`source must be one of: ${lead_sources.join(', ')}.`);
      patch.source = args.source;
    }

    // The duplicate check is inside the function, under a lock, and fails closed: an error
    // there throws, and nothing is inserted on an unverified check.
    const { data, error } = await rpc('mcp_create_contact', { p_patch: patch });
    if (error) {
      if (sentinel(error, 'mcp_create_contact: inactive_source')) return toolError('That lead source is not in use any more. List the tools again for the current ones.');
      throw error;
    }
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
    if (args.email !== undefined) {
      return toolError(
        "The contact's own email cannot be changed here, because it routes portal invitations and sign-in. Use correct_contact_email for a contact with no portal account, or change_portal_email for a portal account's sign-in. Nothing was updated; send the call again without the email field to apply the other changes.",
      );
    }
    const patch = pickFrom(CONTACT_UPDATABLE, args);
    // pickFrom drops nulls; on an update an explicit null is a clear, sent as '' (the
    // function stores '' as NULL, and a name as '').
    for (const k of CONTACT_CLEARABLE) if (args[k] === null) patch[k] = '';
    if (args.source === null) return toolError('source cannot be cleared; every contact has one.');
    if (Object.keys(patch).length === 0) return toolError('No updatable fields supplied.');
    // Normalized before validating, as on create: a padded valid address is accepted, trimmed.
    if (typeof patch.spouse_email === 'string' && patch.spouse_email.trim()) {
      const norm = normalizeEmail(patch.spouse_email);
      if ('error' in norm) return toolError(`spouse_${norm.error}`);
      patch.spouse_email = norm.email;
    }
    const bad = validateContactPatch(patch);
    if (bad) return toolError(`${bad}.`);
    if (patch.source !== undefined) {
      const { lead_sources } = await ctx.vocabulary();
      if (!lead_sources.includes(patch.source as string)) return toolError(`source must be one of: ${lead_sources.join(', ')}.`);
    }
    const { data, error } = await rpc('mcp_update_contact', { p_contact_id: args.contact_id, p_patch: patch });
    if (error) {
      if (sentinel(error, 'mcp_update_contact: inactive_source')) return toolError('That lead source is not in use any more. List the tools again for the current ones.');
      if (sentinel(error, 'mcp_update_contact: spouse_address_signs_in')) {
        return toolError(
          "A portal account signs in with the spouse's current address, so it cannot be changed here. Move that account's sign-in with change_portal_email instead. Nothing was updated.",
        );
      }
      throw error;
    }
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
    return toolText({ quote: data, note: 'Saved as a PROPOSED quote. accept_quote accepts it, after your user approves.' });
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
    // Whose move each request is, by the one roster rule the browser uses.
    const sectionOf = new Map<string, { section: string; label: string }>();
    for (const s of requestRosterSections(snap.lists.map((l) => ({ ...l, contact_id: snap.contact.id })), () => '')) {
      for (const l of s.rows) sectionOf.set(l.id, { section: sectionName(s.key), label: s.label });
    }
    const requests = [];
    for (const list of snap.lists) {
      const placed = sectionOf.get(list.id);
      requests.push({
        list_id: list.id,
        title: list.title,
        status: list.status,
        section: placed?.section,
        section_label: placed?.label,
        answers_to_accept: answersToAccept(list),
        intro_message: list.intro_message,
        asks_contact_to_confirm_details: list.include_contact_confirm,
        created_at: list.created_at,
        sent_at: list.sent_at,
        item_count: list.items.length,
        items: list.items.map((it) => ({
          label: it.label, kind: it.kind, description: it.description, required: it.required, sensitive: it.sensitive,
          category: it.category, tag: it.tag, answered: it.fulfilled, accepted: it.status === 'reviewed',
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

  if (name === 'list_open_requests') {
    const read = await auditedRpc(ctx, 'mcp_list_open_requests', { p_limit: LIST_OPEN_REQUESTS_LIMIT }, {});
    if ('failed' in read) return toolError(read.failed);
    const { data, error } = read;
    if (error) throw error;
    const roster = data as { rows: OpenRequestRow[]; truncated: boolean };
    // Grouped and ordered by the one roster rule the browser uses; the item statuses it
    // reads stay here, and each row says only how many items there are and how many wait.
    const names = new Map(roster.rows.map((r) => [r.contact_id, r.client ?? '']));
    const grouped = requestRosterSections(roster.rows.map((r) => ({ ...r, id: r.list_id })), (id) => names.get(id) ?? '');
    const sections = grouped.map((s) => ({
      section: sectionName(s.key),
      label: s.label,
      count: s.rows.length,
      rows: s.rows.map(({ id: _id, created_at: _created, items, ...row }) => ({ ...row, items: items.length, answers_to_accept: answersToAccept({ items }) })),
    }));
    return toolText({
      total: roster.rows.length,
      truncated: roster.truncated,
      ...(roster.truncated
        ? { truncation_note: `There are more than ${LIST_OPEN_REQUESTS_LIMIT} open requests and only the first ${LIST_OPEN_REQUESTS_LIMIT} are listed. Do not tell your user this is all of them; the rest are in the CRM.` }
        : {}),
      sections,
    });
  }

  if (name === 'close_request') {
    if (!isUuid(args.list_id)) return toolError('list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Not closed. Tell your user which request this is (the contact and the title), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // One transaction: the list locked, a draft refused, the close and its audit row.
    const closed = await auditedRpc(ctx, 'mcp_close_request', { p_list_id: args.list_id, p_contact_id: args.contact_id }, auditIds(args));
    if ('failed' in closed) return toolError(closed.failed);
    const { data, error } = closed;
    if (error) throw error;
    const result = data as { applied?: boolean; reason?: string; from_status?: string } | null;
    if (result?.applied === true) {
      return toolText({
        closed: { list_id: args.list_id, previous_status: result.from_status ?? null },
        note: 'Closed. The contact can change nothing more on it and its reminders have stopped. Nothing they answered or uploaded was deleted.',
      });
    }
    switch (result?.reason) {
      case 'already_closed':
        return toolText({ closed: { list_id: args.list_id }, note: 'It was already closed. Nothing changed.' });
      case 'draft':
        return toolError('That request is still a draft and the contact never saw it, so there is nothing to close. Use delete_request if it should not go out.');
      case 'not_found':
        return toolError(NO_REQUEST);
      default:
        throw new Error(`mcp_close_request returned an unknown outcome: ${String(result?.reason)}`);
    }
  }

  if (name === 'accept_request') {
    if (!isUuid(args.list_id)) return toolError('list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Nothing accepted. Tell your user which request this is (the contact and the title), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // Only answered items move, under a lock on the list, with the audit row.
    const accepted = await auditedRpc(ctx, 'mcp_accept_request', { p_list_id: args.list_id, p_contact_id: args.contact_id }, auditIds(args));
    if ('failed' in accepted) return toolError(accepted.failed);
    const { data, error } = accepted;
    if (error) throw error;
    if (!data) return toolError(NO_REQUEST);
    const result = data as { accepted: number; still_open: number; list_status: string };
    const open = result.still_open;
    // The status is the one stored after the items moved: accepting the last answer closes
    // the request on its own (0014), so the note never claims it is still open.
    const after =
      result.list_status === 'closed'
        ? ' Nothing was left to do on it, so the request closed itself; the contact can change nothing more on it.'
        : ' The request is still open; use close_request if your user wants it closed.';
    return toolText({
      accepted: result.accepted,
      still_unanswered: open,
      request_status: result.list_status,
      note:
        result.accepted === 0
          ? 'There were no answered items waiting to be accepted. Nothing changed.'
          : `Accepted ${result.accepted} answered ${result.accepted === 1 ? 'item' : 'items'}.` +
            (open > 0 ? ` ${open} still ${open === 1 ? 'has' : 'have'} no answer.` : '') +
            after,
    });
  }

  if (name === 'set_request_reminders') {
    if (!isUuid(args.list_id)) return toolError('list_id must be a valid id.');
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (typeof args.paused !== 'boolean') return toolError('paused must be true or false.');
    const set = await auditedRpc(ctx, 'mcp_set_request_reminders', {
      p_list_id: args.list_id, p_contact_id: args.contact_id, p_paused: args.paused,
    }, auditIds(args));
    if ('failed' in set) return toolError(set.failed);
    const { data, error } = set;
    if (error) throw error;
    if (!data) return toolError(NO_REQUEST);
    return toolText({
      request: data,
      note: args.paused
        ? 'Automatic reminders for this request are paused. Nothing was sent.'
        : 'Automatic reminders for this request will continue on their normal schedule. Nothing was sent.',
    });
  }

  if (name === 'set_contact_status') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const vocab = await ctx.vocabulary();
    const stages = vocab.selectable_statuses.map((s) => s.key);
    if (typeof args.status !== 'string' || !stages.includes(args.status)) return toolError(`status must be one of: ${stages.join(', ')}.`);
    // A stored status, never free text: it reaches SQL and a refusal names it. The stored
    // set, so a caller that read the system status gets that refusal, not a validation error.
    if (typeof args.expected_status !== 'string' || !vocab.statuses.includes(args.expected_status)) {
      return toolError(`expected_status is required and must be the status the contact has now, one of: ${vocab.statuses.join(', ')}. Read the contact first.`);
    }
    // Lock, compare-and-swap, the write and its audit row: one transaction in the function.
    const { data, error } = await rpc('mcp_set_contact_status', {
      p_contact_id: args.contact_id, p_status: args.status, p_expected_status: args.expected_status,
    });
    if (error) throw error;
    const result = data as { outcome?: string; current_status?: string } & Record<string, unknown>;
    switch (result?.outcome) {
      case 'updated': {
        const { outcome: _outcome, ...updated } = result;
        return toolText({ updated });
      }
      case 'unchanged':
        return toolText({ unchanged: { contact_id: args.contact_id, status: result.status }, note: 'The contact was already in that stage. Nothing was written.' });
      case 'not_found':
        return toolError(NO_CONTACT);
      case 'system_status':
        return toolError('That contact was created only to sign a document, and its address is unproven. The owner promotes it in the CRM, not here. Nothing was changed.');
      case 'archived':
        return toolError('That contact is archived. The owner restores it in the CRM first. Nothing was changed.');
      case 'stale':
        return toolError(
          `The contact's status is now ${String(result.current_status)}, not ${args.expected_status}, so nothing was changed. Confirm the move with your user against the current stage, then send it again with expected_status set to it.`,
        );
      default:
        throw new Error(`mcp_set_contact_status returned an unknown outcome: ${String(result?.outcome)}`);
    }
  }

  if (name === 'list_board') {
    let stage: string | null = null;
    if (args.stage !== undefined && args.stage !== null) {
      const lanes = (await ctx.vocabulary()).board_stages.map((s) => s.key);
      if (typeof args.stage !== 'string' || !lanes.includes(args.stage)) return toolError(`stage must be one of: ${lanes.join(', ')}.`);
      stage = args.stage;
    }
    const contact = optionalId(args.contact_id, isUuid);
    if ('error' in contact) return toolError('contact_id must be a valid id, or left out.');
    const { data, error } = await rpc('mcp_list_board', { p_stage: stage, p_contact_id: contact.id, p_limit: BOARD_LIST_LIMIT });
    if (error) throw error;
    const board = data as { truncated: boolean } & Record<string, unknown>;
    return toolText({
      ...board,
      ...(board.truncated
        ? { truncation_note: `The board has more than ${BOARD_LIST_LIMIT} cards here and only the first ${BOARD_LIST_LIMIT} are listed. Do not tell your user this is all of them.` }
        : {}),
    });
  }

  if (name === 'create_work_item') {
    const title = parseCardTitle(args.title);
    if ('error' in title) return toolError(title.error);
    const vocab = await ctx.vocabulary();
    const lanes = vocab.board_stages.map((s) => s.key);
    if (args.stage !== undefined && args.stage !== null && (typeof args.stage !== 'string' || !lanes.includes(args.stage))) {
      return toolError(`stage must be one of: ${lanes.join(', ')}.`);
    }
    if (args.work_item_type !== undefined && args.work_item_type !== null
      && (typeof args.work_item_type !== 'string' || !vocab.work_item_types.includes(args.work_item_type))) {
      return toolError(`work_item_type must be one of: ${vocab.work_item_types.join(', ')}.`);
    }
    if (args.priority !== undefined && args.priority !== null && !(CARD_PRIORITIES as readonly unknown[]).includes(args.priority)) {
      return toolError(`priority must be one of: ${CARD_PRIORITIES.join(', ')}.`);
    }
    let dueDate: string | null = null;
    if (args.due_date !== undefined && args.due_date !== null) {
      const d = parseBoardDate(args.due_date);
      if ('error' in d) return toolError(d.error);
      dueDate = d.date;
    }
    const contact = optionalId(args.contact_id, isUuid);
    if ('error' in contact) return toolError('contact_id must be a valid id, or left out.');
    // NULL takes the column defaults: the todo lane, the task type, normal priority.
    const { data, error } = await rpc('mcp_create_work_item', {
      p_title: title.title,
      p_contact_id: contact.id,
      p_work_item_type: typeof args.work_item_type === 'string' ? args.work_item_type : null,
      p_stage: typeof args.stage === 'string' ? args.stage : null,
      p_priority: typeof args.priority === 'string' ? args.priority : null,
      p_due_date: dueDate,
    });
    if (error) {
      const refusal = boardContactRefusal(error, 'mcp_create_work_item');
      if (refusal) return toolError(refusal);
      if (sentinel(error, 'mcp_create_work_item: inactive_type')) return toolError(INACTIVE_TYPE);
      throw error;
    }
    return toolText({ created: data });
  }

  if (name === 'update_work_item') {
    if (!isUuid(args.work_item_id)) return toolError('work_item_id must be a valid id.');
    if (args.stage !== undefined) return toolError('The lane cannot be changed here. Use move_work_item, which needs a reason. Nothing was updated.');
    // PRESENCE decides what is written: an absent key leaves the field alone, an explicit
    // null clears the contact or the due date.
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const title = parseCardTitle(args.title);
      if ('error' in title) return toolError(title.error);
      patch.title = title.title;
    }
    if (args.work_item_type !== undefined) {
      const { work_item_types } = await ctx.vocabulary();
      if (typeof args.work_item_type !== 'string' || !work_item_types.includes(args.work_item_type)) {
        return toolError(`work_item_type must be one of: ${work_item_types.join(', ')}.`);
      }
      patch.work_item_type = args.work_item_type;
    }
    if (args.priority !== undefined) {
      if (!(CARD_PRIORITIES as readonly unknown[]).includes(args.priority)) return toolError(`priority must be one of: ${CARD_PRIORITIES.join(', ')}.`);
      patch.priority = args.priority;
    }
    if (args.due_date !== undefined) {
      const d = parseBoardDate(args.due_date);
      if ('error' in d) return toolError(d.error);
      patch.due_date = d.date;
    }
    if (args.contact_id !== undefined) {
      const contact = optionalId(args.contact_id, isUuid);
      if ('error' in contact) return toolError('contact_id must be a valid id, or null to clear it.');
      patch.contact_id = contact.id;
    }
    if (Object.keys(patch).length === 0) return toolError('No updatable fields supplied.');
    const { data, error } = await rpc('mcp_update_work_item', { p_id: args.work_item_id, p_patch: patch });
    if (error) {
      const refusal = boardContactRefusal(error, 'mcp_update_work_item');
      if (refusal) return toolError(refusal);
      if (sentinel(error, 'mcp_update_work_item: inactive_type')) return toolError(INACTIVE_TYPE);
      throw error;
    }
    const result = data as { outcome?: string; card?: unknown } | null;
    switch (result?.outcome) {
      case 'updated':
        return toolText({ updated: result.card });
      case 'not_found':
        return toolError(NO_CARD);
      case 'not_on_board':
        return toolError(ARCHIVED_CARD('edited'));
      default:
        throw new Error(`mcp_update_work_item returned an unknown outcome: ${String(result?.outcome)}`);
    }
  }

  if (name === 'move_work_item') {
    if (!isUuid(args.work_item_id)) return toolError('work_item_id must be a valid id.');
    const lanes = (await ctx.vocabulary()).board_stages;
    const keys = lanes.map((s) => s.key);
    if (typeof args.to_stage !== 'string' || !keys.includes(args.to_stage) || typeof args.expected_stage !== 'string' || !keys.includes(args.expected_stage)) {
      return toolError(`to_stage and expected_stage must each be one of: ${keys.join(', ')}.`);
    }
    const reason = parseBoardNote(args.reason, 'reason');
    if ('error' in reason) return toolError(reason.error);
    const { data, error } = await rpc('mcp_move_work_item', {
      p_id: args.work_item_id, p_stage: args.to_stage, p_expected_stage: args.expected_stage, p_note: reason.note,
    });
    if (error) throw error;
    const result = data as { outcome?: string; current_stage?: string } | null;
    const lane = (key: unknown) => {
      const found = lanes.find((s) => s.key === key);
      return found ? `${found.label} (${found.key})` : String(key);
    };
    switch (result?.outcome) {
      case 'moved':
        return toolText({ moved: { work_item_id: args.work_item_id, from: lane(args.expected_stage), to: lane(args.to_stage) } });
      case 'unchanged':
        return toolText({ unchanged: { work_item_id: args.work_item_id, stage: args.to_stage }, note: 'The card was already in that lane. Nothing was written.' });
      case 'not_found':
        return toolError(NO_CARD);
      case 'not_on_board':
        return toolError(ARCHIVED_CARD('moved'));
      case 'stale':
        return toolError(
          `The card is now in ${lane(result.current_stage)}, not ${lane(args.expected_stage)}, so nothing was moved. Read it again with list_board and confirm the move against its current lane.`,
        );
      default:
        throw new Error(`mcp_move_work_item returned an unknown outcome: ${String(result?.outcome)}`);
    }
  }

  if (name === 'add_work_item_note') {
    if (!isUuid(args.work_item_id)) return toolError('work_item_id must be a valid id.');
    const note = parseBoardNote(args.note);
    if ('error' in note) return toolError(note.error);
    const { data, error } = await rpc('mcp_add_work_item_note', { p_id: args.work_item_id, p_note: note.note });
    if (error) throw error;
    switch ((data as { outcome?: string } | null)?.outcome) {
      case 'noted':
        return toolText({ logged: { work_item_id: args.work_item_id } });
      case 'not_found':
        return toolError(NO_CARD);
      case 'not_on_board':
        return toolError(ARCHIVED_CARD('noted'));
      default:
        throw new Error(`mcp_add_work_item_note returned an unknown outcome: ${String((data as { outcome?: string } | null)?.outcome)}`);
    }
  }

  if (name === 'update_note') {
    if (!isUuid(args.contact_id) || !isUuid(args.note_id)) return toolError('contact_id and note_id must be valid ids.');
    let body: string | null = null;
    if (args.body !== undefined && args.body !== null) {
      if (typeof args.body !== 'string') return toolError('body must be text.');
      body = args.body.trim();
      if (!body) return toolError('body cannot be empty. Use delete_note to remove a note.');
      if (body.length > MAX_NOTE_LENGTH) return toolError(`body is too long (at most ${MAX_NOTE_LENGTH} characters).`);
    }
    let kind: string | null = null;
    if (args.kind !== undefined && args.kind !== null) {
      if (!(NOTE_KINDS as readonly unknown[]).includes(args.kind)) return toolError(`kind must be one of: ${NOTE_KINDS.join(', ')}.`);
      kind = args.kind as string;
    }
    if (body === null && kind === null) return toolError('Nothing to change: send body, kind or both.');
    // The function writes body and kind only: the note's source is not writable by any role.
    const { data, error } = await rpc('mcp_update_note', { p_note_id: args.note_id, p_contact_id: args.contact_id, p_body: body, p_kind: kind });
    if (error) throw error;
    const result = data as { outcome?: string } | null;
    if (result?.outcome === 'not_found') return toolError(NO_NOTE);
    if (result?.outcome !== 'updated') throw new Error(`mcp_update_note returned an unknown outcome: ${String(result?.outcome)}`);
    const { outcome: _outcome, ...updated } = result;
    return toolText({ updated });
  }

  if (name === 'delete_note') {
    if (!isUuid(args.contact_id) || !isUuid(args.note_id)) return toolError('contact_id and note_id must be valid ids.');
    if (args.confirmed_with_user !== true) {
      return toolError('Not deleted. Read the note back to your user, get their go-ahead, then call again with confirmed_with_user: true.');
    }
    const { data, error } = await rpc('mcp_delete_note', { p_note_id: args.note_id, p_contact_id: args.contact_id });
    if (error) throw error;
    const result = data as { outcome?: string; id?: string } | null;
    if (result?.outcome === 'not_found') return toolError(NO_NOTE);
    if (result?.outcome !== 'deleted') throw new Error(`mcp_delete_note returned an unknown outcome: ${String(result?.outcome)}`);
    return toolText({ deleted: { id: result.id } });
  }

  if (name === 'accept_quote') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (!isUuid(args.quote_id)) return toolError('quote_id must be a valid id. Get it from get_contact.');
    // Any existing key, active or not: a quote on a service deactivated since is still the
    // quote that was read. The function binds it to the stored row.
    if (typeof args.service_type !== 'string' || !KEY_RE.test(args.service_type)) {
      return toolError('service_type must be the service get_contact reported for this quote.');
    }
    const organization = optionalId(args.organization_id, isUuid);
    if ('error' in organization) {
      return toolError('organization_id must be a valid id, or left out entirely for a quote on the contact itself. An empty value is not the same as leaving it out.');
    }
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Not accepted. Read the quote back to your user (the service, the amount, the cadence and whether it sits on the contact or one of their businesses), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }
    // The service and business bind the accept to the quote that was read back, as for delete_quote.
    const { data, error } = await rpc('mcp_accept_quote', {
      p_contact_id: args.contact_id,
      p_quote_id: args.quote_id,
      p_organization_id: organization.id,
      p_service_type: args.service_type,
    });
    if (error) {
      if (sentinel(error, 'mcp_accept_quote: already_accepted')) return toolError('That quote is already accepted. Nothing was changed.');
      if (sentinel(error, 'mcp_accept_quote: system_status')) {
        return toolError('That contact was created only to sign a document, so a quote is not accepted for them here. The owner promotes them in the CRM first. Nothing was changed.');
      }
      if (sentinel(error, 'mcp_accept_quote: archived')) {
        return toolError('That contact is archived. The owner restores them in the CRM first. Nothing was changed.');
      }
      if (sentinel(error, 'mcp_accept_quote: not_found')) {
        return toolError(
          'No proposed quote on that contact matches that id, service and business. Read the contact again with get_contact and use the id, service and business it reports.',
        );
      }
      throw error;
    }
    const accepted = data as { contact_status?: string; previous_status?: string } | null;
    return toolText({
      accepted: data,
      note:
        accepted?.contact_status && accepted.contact_status !== accepted.previous_status
          ? `Accepted. The contact moved from ${accepted.previous_status} to ${accepted.contact_status}.`
          : 'Accepted. The contact stays at the stage it was in.',
    });
  }

  if (name === 'change_portal_email') {
    const refuse = (reason: string, message: string) => refused(ctx, 'mcp_change_portal_email', reason, args, message);
    if (!isUuid(args.portal_account_id)) return toolError('portal_account_id must be a valid id. Get it from get_contact portal_accounts.');
    const parsed = normalizeEmail(args.new_email);
    if ('error' in parsed) return toolError(`new_${parsed.error}`);
    const expected = args.expected_current_email;
    if (expected === undefined) {
      return toolError("expected_current_email is required. Read the contact with get_contact and pass the account's current invited_email, or null if it has none.");
    }
    if (expected !== null && typeof expected !== 'string') return toolError('expected_current_email must be a string or null.');
    if (typeof expected === 'string' && expected.length > EMAIL_MAX_LEN) {
      return toolError(`expected_current_email must be ${EMAIL_MAX_LEN} characters or fewer.`);
    }
    if (args.confirmed_with_user !== true) {
      return toolError(
        'Not changed. Read the change back to your user (the account, its current address and the new one), get their go-ahead, then call again with confirmed_with_user: true.',
      );
    }

    // The check writes nothing; the database half below repeats it under locks.
    const check = await ctx.db.rpc('portal_login_for_change', { p_account_id: args.portal_account_id, p_email: parsed.email, p_expected_email: expected });
    if (check.error) throw check.error;
    const ready = check.data as { outcome?: string; user_id?: string } | null;
    switch (ready?.outcome) {
      case 'ok':
        break;
      case 'not_found':
        return toolError('No portal account with that id. Read the contact again with get_contact.');
      case 'no_sign_in':
        return refuse('no_sign_in', 'That account has no sign-in yet (its invitation was not accepted, or it was turned off), so there is no sign-in to move. Nothing was changed.');
      case 'stale':
        return refuse('stale', "expected_current_email did not match the account's address, so nothing was changed. Read the contact again with get_contact and send the account's current address.");
      case 'unchanged':
        return toolError('The account already signs in with that address. Nothing was changed.');
      case 'address_in_use':
        return refuse('address_in_use', 'Another portal account already uses that address. Nothing was changed.');
      default:
        throw new Error(`portal_login_for_change returned an unknown outcome: ${String(ready?.outcome)}`);
    }

    // Auth FIRST: it is the half that can refuse for a reason outside this database, and a
    // refusal there leaves everything as it was, so a retry is safe.
    const auth = await ctx.privileged.setSignInEmail(ready.user_id as string, parsed.email);
    if (auth === 'refused') {
      return refuse('auth_refused', 'The sign-in address could not be changed (most often because another sign-in already uses that address). Nothing was changed.');
    }

    const { data, error } = await rpc('mcp_change_portal_email', {
      p_account_id: args.portal_account_id,
      p_email: parsed.email,
      p_expected_email: expected,
    });
    const outcome = error ? 'error' : ((data as { outcome?: string } | null)?.outcome ?? 'none');
    if (outcome !== 'updated') {
      // The sign-in moved and the record did not: the one state that needs a person. Said
      // as it is, never as a clean refusal.
      if (error) ctx.log.error('portal email database half failed after the sign-in moved', error);
      const trail = await auditDelegated(ctx, 'mcp_change_portal_email_partial', { account_id: args.portal_account_id as string, outcome });
      return toolError(
        `The SIGN-IN address was changed, but the contact record was not (${outcome}). Send the same call again to finish it; until then invitations still go to the old address.${trail ? ` ${trail}` : ''}`,
      );
    }
    const { outcome: _outcome, ...changed } = data as Record<string, unknown>;
    return toolText({ changed, note: 'The account now signs in with the new address, and the contact record matches.' });
  }

  if (name === 'read_request_answers') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    const list = optionalId(args.list_id, isUuid);
    if ('error' in list) return toolError('list_id must be a valid id, or left out for every request.');
    // Audited inside the function before it returns: the record of the read exists before
    // any answer is opened here.
    const { data, error } = await rpc('mcp_read_request_answers', { p_contact_id: args.contact_id, p_list_id: list.id });
    if (error) throw error;
    if (!data) return toolError(NO_CONTACT);
    type Item = Record<string, unknown> & { answer_ciphertext?: string | null };
    const read = data as { lists: Array<Record<string, unknown> & { items: Item[] }>; truncated: boolean; contact_id: string };
    const lists = [];
    for (const l of read.lists) {
      const items = [];
      for (const { answer_ciphertext, ...item } of l.items) {
        if (typeof answer_ciphertext !== 'string') {
          items.push(item);
          continue;
        }
        try {
          items.push({ ...item, answer: await ctx.privileged.openAnswer(answer_ciphertext) });
        } catch (err) {
          ctx.log.error('a sensitive answer could not be opened', err);
          items.push({ ...item, answer: null, answer_error: 'This answer could not be opened. The owner can reveal it in the CRM.' });
        }
      }
      lists.push({ ...l, items });
    }
    return toolText({ contact_id: read.contact_id, count: lists.length, truncated: read.truncated, lists });
  }

  if (name === 'list_documents') {
    if (!isUuid(args.contact_id)) return toolError('contact_id must be a valid id.');
    if (args.limit !== undefined && args.limit !== null && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > DOCUMENT_LIST_MAX)) {
      return toolError(`limit must be a whole number from 1 to ${DOCUMENT_LIST_MAX}.`);
    }
    const limit = typeof args.limit === 'number' ? args.limit : DOCUMENT_LIST_DEFAULT;
    const { data, error } = await rpc('mcp_list_documents', { p_contact_id: args.contact_id, p_limit: limit });
    if (error) throw error;
    if (!data) return toolError(NO_CONTACT);
    return toolText({
      ...(data as Record<string, unknown>),
      note: 'Metadata only. read_document_text returns the text of a plain text or CSV file; anything else opens in the CRM.',
    });
  }

  if (name === 'read_document_text') {
    if (!isUuid(args.document_id)) return toolError('document_id must be a valid id. Get it from list_documents.');
    const { data, error } = await rpc('mcp_read_document', { p_document_id: args.document_id });
    if (error) throw error;
    const doc = data as {
      outcome?: string; document_id: string; filename: string; mime_type: string;
      storage_path: string; encryption_status: string; encryption_iv: string | null;
    } | null;
    if (doc?.outcome === 'not_found') return toolError('No document with that id. List them again with list_documents.');
    if (doc?.outcome === 'not_text') {
      return toolError(`That file is ${doc.mime_type}, so its contents are not returned here; only plain text and CSV are. It opens in the CRM's document viewer.`);
    }
    if (doc?.outcome !== 'ok') throw new Error(`mcp_read_document returned an unknown outcome: ${String(doc?.outcome)}`);
    const text = new TextDecoder().decode(await ctx.privileged.readDocument(doc));
    return toolText({
      document_id: doc.document_id,
      filename: doc.filename,
      mime_type: doc.mime_type,
      truncated: text.length > DOCUMENT_TEXT_LIMIT,
      text: text.slice(0, DOCUMENT_TEXT_LIMIT),
    });
  }

  return toolError(`Unknown tool: ${name}`);
}
