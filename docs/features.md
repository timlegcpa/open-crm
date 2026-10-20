# Features

What the owner and clients can do, one section per feature domain. Each domain is a folder
under `src/features/` (see [architecture.md](architecture.md)); its tables are in the migration
named in its section.

## Contacts and pipeline (`crm`, `0002_contacts`)

**Owner.** Contacts is the home page: a list and a pipeline board of every contact by stage
(new, active, hot, warm, cold, client, one-time client, former client, lost). Add a contact by
hand, or let one arrive through lead intake. A contact record holds emails (primary and a
spouse or partner's), phone, mailing address, lead source, the businesses the contact owns,
notes (append-only), relationships to other contacts, service quotes and upsells (further work to pitch: open, pitched, won or passed). A quote is
one service per business with an amount and a cadence (monthly, annual or one-time), proposed
or accepted. Accepted monthly quotes make up monthly recurring revenue, and with accepted annual
quotes, annual recurring revenue. A contact delete is
claimed first, so a delete cannot race a portal sign-in, and takes everything recorded on the
contact with it.

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

## AI connector (`mcp`, `0007_mcp`)

**Owner.** Connect an AI assistant (any MCP client) through OAuth: the assistant asks, and the
owner approves on a consent screen with a second-factor session. The assistant can then search
and read contacts, create and update them, add businesses, log call notes, manage quotes, and
create, send and remind requests. Every call is audited. Settings, AI connector lists the
connections and revokes them.

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
