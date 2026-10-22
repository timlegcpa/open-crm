# Features

What the owner and clients can do, one section per feature domain. Each domain is a folder
under `src/features/` (see [architecture.md](architecture.md)); its tables are in the migration
named in its section.

## Contacts and pipeline (`crm`, `0002_contacts`, `0013_crm`)

**Owner.** Contacts is the home page: a list and a pipeline board of every contact by stage
(new, active, hot, warm, cold, client, one-time client, former client, lost), in each stage's
colour. The workspace's tab strip holds Pipeline (the default), Tiers and Table beside the
board, requests, messages, e-sign and marketing; the client panel on the left lists everyone
(All) or every client, one-time clients included (Clients), as one A to Z list by last name
with each contact's status as the colour of its row's mark, and remembers the choice in the
browser. The tab is part of the address, and the last one chosen is
remembered. A search in the panel looks through everyone and also narrows the board, the
tiers and the table. Add a contact by hand, or let one arrive through lead intake.

Each pipeline card shows the contact's newest note, text only, in up to three lines; the full log stays on the record, and the board re-reads notes whenever it is shown, because the AI connector writes notes too. Pills above the board narrow it to the leads with a proposed quote for one service; a lead with nothing quoted shows under All only, and the pills list only services someone on the board is quoted for. New opens a quick add for a lead: name, email, phone, source, stage, the services they asked about (each saved as a proposed quote with no price) and one note. If a quote or the note fails to save after the contact is created, the screen says so without undoing the contact, so a retry never adds the person twice. The full Add contact page stays for everything else.

**Tiers.** The owner ranks clients by hand, S at the top, then A, B, C, D and E; a contact
starts not ranked. The Tiers tab shows one row per tier, in tier-list colours, with the active
(recurring) clients in their rows; drag a client to another row to change their tier. A tier is
also set on the record's Overview and in its side bar, and shows as a small letter badge in the
record's header. Nothing computes a tier, and a client never sees it.

**Archive.** Archiving takes a contact off every working list (the index, the board, the table,
the tiers, contact pickers and group email), and keeps the record whole: quotes, documents,
notes and history stay. Archive from a list row, a board card or its bar, the bulk bar or the
record's menu; the Archived button lists everyone archived, searchable, with Restore. Archiving
leaves the stage alone, so Restore brings a contact back at the stage they left, and a contact
the e-signature flow created to sign stays exactly that. The database records when, and a
group email already queued skips a contact archived since. Scheduled request reminders skip an
archived contact; a request you send or remind by hand still goes. Archiving does not revoke portal
access: turn that off separately in the record's portal access panel.

**The record.** Overview holds the contact's details and a Billing card with the services
editor, so a price is entered right there; the Billing tab keeps the upsells and organization
editing. The side bar edits status, tier, email, phone and source in place, copies the rest,
and carries the services editor on the tabs that do not. A status change and a quote save for
one contact wait for each other.

A contact record holds emails (primary and a spouse or partner's), phone, mailing address, lead source, the businesses the contact owns,
notes, relationships to other contacts, service quotes and upsells (further work to pitch: open, pitched, won or passed). A quote is
one service per business with an amount and a cadence (monthly, annual or one-time), proposed
or accepted. Accepted monthly quotes make up monthly recurring revenue, and with accepted annual
quotes, annual recurring revenue. A contact delete is
claimed first, so a delete cannot race a portal sign-in, and takes everything recorded on the
contact with it.

**Notes.** A note can be corrected in place (its text and its type) or deleted behind a
confirm. Who wrote it (the owner, the AI connector or lead intake) never changes: the database
lets no one rewrite that.

**Emails.** An address a portal account signs in with is marked Portal sign-in. Editing it
changes the sign-in and the contact's address together (the `change-portal-email` function:
the sign-in moves first, so a refusal there changes nothing); a change built on an address
that changed meanwhile (in the record or in the sign-in itself) is refused. If the sign-in
moved but the record could not, or the sign-in change got no clear answer, the screen says so;
reopening the record and editing from the address it shows finishes it. The old address gets
an email saying the sign-in was changed (it does not name the new one). Devices already signed in
stay signed in: the change does not end open sessions.
Until the panel knows which addresses sign in, and whenever it cannot find out, addresses
cannot be edited, so a sign-in is never changed as a plain address.

The record's tabs come from the other domains: Billing (quotes), Requests, Documents, Messages,
E-sign, Portal and Activity.

## Client portal (`portal`, `0002_contacts`, `0012_portal`)

**Owner.** Invite a contact to the portal from the record's Portal panel; when the email cannot
be sent, the panel shows the link to copy. Resend or revoke an invitation, suspend or remove
access, and see the client's portal activity. **View as client** opens the portal exactly as
that client sees it, read-only.

**Client.** Accept the invitation and choose a password, then a Home page with cards from each
domain (requests waiting, signatures needed, documents), a Profile page (password, email,
two-factor sign-in), and a daily email digest of what is waiting. Signed out after 30 minutes
without activity.

## Documents (`documents`, `0003_documents`)

**Owner.** Every client's documents in folders, in two sections per contact (shared by the
owner, uploaded by the client). Upload, preview (PDF, images, Office documents), annotate,
rename, move, and mark as reviewed; unreviewed client uploads show as a count in the nav and on
the contact.

**Client.** See what the owner shared and upload files. Every upload has its bytes checked
against its type and is encrypted before it is stored.

## Secure messages (`messages`, `0004_messages`)

**Owner.** One conversation per contact, with unread counts and live updates. Set the
encryption password and recovery key on the first visit (Settings, Secure messages).

**Client.** Send and read messages in the portal. A client's message is encrypted in the
browser to the owner's key; the owner's replies are stored as plain text. Messages are deleted
7 days after they are read.

## Requests (`requests`, `0005_requests`, `0014_requests`)

**Owner.** Build a request for a client: documents to upload, questions to answer (optionally
sensitive, stored encrypted and revealed on purpose), tasks to tick off and notes to read, each
with a category and tag. Save reusable templates, send, remind by hand or on a schedule
(Settings, Requests), and accept answers. A client with no portal account gets an emailed start
link that creates their sign-in.

Every request sits in one list grouped by whose move it is: Waiting on you (handed back, or an
answer to accept), Waiting on client, Drafts, and Archived, which stays folded until asked. New
request asks who it is for, then opens the builder. A request closes itself once every answer is
accepted; one that asks the client to confirm their details waits until they submit it (Close
by hand stays, for a request the client will not finish). Open lists refresh
every 30 seconds while in view and as soon as you come back to the tab. On Documents, a picked
contact's requests sit above their folders, with New request for that contact. You hear about
uploads to a request at most once a day per request, plus once when the client submits.

**Client.** Answer in the portal: upload, type answers, tick tasks, then submit.

## E-signature (`esign`, `0006_esign`)

**Owner.** Compose an envelope from PDFs: reorder and remove pages, add signers in order, and
place signature and date fields per signer. Choose Standard (emailed link) or High (plus a text
message code) verification. Send, resend, void, and follow each signer's progress. Save
templates of field placements. When everyone has signed, the executed PDF (the document, the
stamped signatures and an audit trail page) is filed into each signer's documents and emailed
to every party.

**Signer.** Open the emailed link (or sign from the portal), consent, review, and sign with a
typed or drawn signature, or decline. **Anyone** holding an executed copy can check it at
`/esign/verify`.

## Work board (`board`, `0008_board`)

**Owner.** A Kanban board of work items (to do, waiting, in progress, done; lanes and types are
data in the database, not code), each with a type, priority, optional due date and optional contact. Moving a card
asks for a reason and records it; notes and moves make up the card's history. Done cards
archive after 14 days and can be restored.

## Group email (`email`, `0010_email`)

**Owner.** Write an email, choose the contacts to send it to, review who will be skipped and why (a stage that is never emailed, an unsubscribed address), and send.
See each campaign's recipients and delivery state, and on each contact the group emails it was
sent.

**Recipient.** Every message carries an unsubscribe link (and one-click unsubscribe headers);
the address is then never sent group email again.

## Marketing (`marketing`, `0009_marketing`)

**Owner.** Leads and won clients by month and by source, monthly targets, ad spend with cost
per lead and cost per acquisition, and recurring revenue from accepted quotes.

## AI connector (`mcp`, `0007_mcp`, `0015_mcp`, `0017_crm_full_access`)

**Owner.** Connect an AI assistant (any MCP client) through OAuth: the assistant asks, and the
owner approves on a consent screen with a second-factor session. The assistant can then search
and read contacts (by name, email, phone or business; archived contacts are left out) and read
a whole record (spouse, mailing address, source, tier, every address and the portal accounts,
never a sign-in id), create them from an email or a phone number with a stage and lead source,
update any detail but the email (which has its own correction tool), move them along the
pipeline, add businesses, log, correct and delete notes, manage quotes, and accept a proposed
quote (the contact's stage follows, as in the CRM; a lost, cold or former client stays where
they are). It reads a contact's request answers (sensitive answers decrypted on the server),
lists a contact's documents and reads a stored plain-text or CSV document; it cannot open a
PDF, an image or a spreadsheet. What a client wrote (answers, document text, lead-intake
notes) comes back marked as untrusted client content, so the assistant treats it as data and
never as instructions. It cannot change the email a client signs in with: only the owner
does that, from the record. It works the board (list,
create, edit, move with a reason, and note cards), and handles requests end to end: create,
send and remind them, see every open request by whose move it is (the same sections as the
requests screen), accept answers (accepting the last one closes the request, as in the CRM),
close a request, and pause its reminders. Every call is audited. When the consent screen gains a
power, connections approved on the older screen stop working until the owner approves again, and
an approval given on the older screen can never become a connection. Settings, AI connector lists the
connections and revokes them. The full tool list is in the README.

## Settings (`settings`, `0011_control_center`)

**Owner.** Identity (names, postal address, the public contact email shown on the e-signature consent and error pages, brand colour, logo), Lists (pipeline stages,
lead sources, services and organization types: labels, colours, order, and which are active), Lead intake (the key another system
posts new leads with), Security (password, sign-in email, sessions, two-factor and backup codes), Appearance,
and the sections other domains add: Requests (reminders, request categories and tags), Secure
messages, AI connector and E-sign.

Lead intake: a form tool, lead seller or script posts JSON to the `lead-intake` function with
the key; the contact is created and the owner is emailed. See the README.

## System pages (`ops`, `0001_core`)

**Owner.** The audit log, the background jobs (with retry for a failed one) and the dev outbox:
every email and text message written there instead of being sent while no provider is set up.
