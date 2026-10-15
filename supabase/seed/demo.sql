-- Open CRM demo data: a fictional business's contacts, quotes, board, messages, requests and
-- one draft e-signature envelope, so a new install has something to click through.
--
-- Every name, address and number here is invented: addresses are on example.test (a domain
-- reserved for testing) and phone numbers are in the 555-01xx range kept for fiction.
--
-- Load it with `npm run demo:seed` (it runs this file through `npx supabase db query
-- --linked`), or paste the whole file into the Supabase SQL editor and run it.
--
-- Rules:
--   * Run it after `npx supabase db push` and `npm run dev:bootstrap`: it needs the owner
--     the bootstrap records, and creates no sign-in accounts of its own.
--   * It never touches secrets, storage objects or Auth.
--   * Idempotent: every row has a fixed id and every insert is ON CONFLICT DO NOTHING, so
--     running it again changes nothing. Rows whose insert has side effects on other rows
--     (an e-sign signer bumps its envelope's draft revision) are inserted only when absent.
--   * It refuses to run on a project that already holds contacts of its own, so it cannot
--     be mixed into real data by accident. To load it anyway, run this line first, in the
--     same session (`npm run demo:seed -- --force` does that for you):
--       SELECT set_config('open_crm.demo_seed_force', 'on', false);
--   * Seed ids start with dd0000NN-, one NN per table; contacts are dd000001-.
--   * It runs as the database owner (postgres), which writes past row-level security the
--     way the server does: a sent request is published by the server, never by a session.
--
-- To remove it, delete the twelve contacts (Contacts, each record's delete) or run:
--   DELETE FROM public.esign_envelopes WHERE id::text LIKE 'dd00000a-%';
--   DELETE FROM public.work_items WHERE id::text LIKE 'dd000005-%';
--   DELETE FROM public.contacts WHERE id::text LIKE 'dd000001-%';
--   DELETE FROM public.monthly_goals WHERE id::text LIKE 'dd00000c-%';
-- The pick-list values it adds (lead sources podcast and partner, work item type review,
-- request category onboarding) stay behind.
--
-- Not a `supabase db reset` seed: supabase/config.toml's [db.seed] names ./seed.sql, so
-- this file only runs when someone loads it on purpose.

BEGIN;

DO $guard$
DECLARE
  v_own integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.org_profile WHERE owner_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'demo seed: this project has no owner yet. Run npm run dev:bootstrap first.';
  END IF;
  SELECT count(*) INTO v_own FROM public.contacts WHERE id::text NOT LIKE 'dd000001-%';
  IF v_own > 0 AND COALESCE(current_setting('open_crm.demo_seed_force', true), '') <> 'on' THEN
    RAISE EXCEPTION 'demo seed: this project already has % contact(s) of its own, so the demo data was not loaded. Use npm run demo:seed -- --force to load it anyway.', v_own;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Pick-list values (each owner-editable, none built in)
-- ---------------------------------------------------------------------------

INSERT INTO public.lead_sources (key, label, sort_order) VALUES
  ('podcast', 'Podcast', 70),
  ('partner', 'Partner', 75)
ON CONFLICT DO NOTHING;

INSERT INTO public.work_item_types (key, label, sort_order) VALUES
  ('review', 'Review', 60)
ON CONFLICT DO NOTHING;

INSERT INTO public.request_categories (key, label, sort_order) VALUES
  ('onboarding', 'Onboarding', 70)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Contacts. The email column fills contact_emails through its trigger; full_name and
-- status_history are the database's to write.
-- ---------------------------------------------------------------------------

INSERT INTO public.contacts
  (id, first_name, last_name, email, phone, business_name, source, status, client_since, created_at, submitted_at)
VALUES
  ('dd000001-0000-4000-8000-000000000001', 'Avery', 'Stone', 'avery.stone@example.test', '555-0101', 'Stone Ceramics', 'website', 'client', (current_date - 150), now() - interval '170 days', now() - interval '170 days'),
  ('dd000001-0000-4000-8000-000000000002', 'Jordan', 'Pike', 'jordan.pike@example.test', '555-0102', 'Pike Bicycle Works', 'referral', 'client', (current_date - 95), now() - interval '120 days', now() - interval '120 days'),
  ('dd000001-0000-4000-8000-000000000003', 'Riley', 'Quinn', 'riley.quinn@example.test', '555-0103', 'Quinn Landscaping', 'search', 'one_time', (current_date - 60), now() - interval '75 days', now() - interval '75 days'),
  ('dd000001-0000-4000-8000-000000000004', 'Morgan', 'Hale', 'morgan.hale@example.test', '555-0104', 'Hale Design Studio', 'podcast', 'hot', NULL, now() - interval '20 days', now() - interval '20 days'),
  ('dd000001-0000-4000-8000-000000000005', 'Casey', 'Rowe', 'casey.rowe@example.test', '555-0105', 'Rowe Catering', 'social_media', 'warm', NULL, now() - interval '40 days', now() - interval '40 days'),
  ('dd000001-0000-4000-8000-000000000006', 'Taylor', 'Brook', 'taylor.brook@example.test', '555-0106', NULL, 'advertising', 'new_lead', NULL, now() - interval '2 days', now() - interval '2 days'),
  ('dd000001-0000-4000-8000-000000000007', 'Jamie', 'Frost', 'jamie.frost@example.test', '555-0107', 'Frost Print Shop', 'event', 'active_lead', NULL, now() - interval '9 days', now() - interval '9 days'),
  ('dd000001-0000-4000-8000-000000000008', 'Drew', 'Marsh', 'drew.marsh@example.test', '555-0108', 'Marsh Photography', 'website', 'cold', NULL, now() - interval '100 days', now() - interval '100 days'),
  ('dd000001-0000-4000-8000-000000000009', 'Sam', 'Ellery', 'sam.ellery@example.test', '555-0109', 'Ellery Bakery', 'referral', 'former_client', (current_date - 400), now() - interval '420 days', now() - interval '420 days'),
  ('dd000001-0000-4000-8000-00000000000a', 'Robin', 'Vale', 'robin.vale@example.test', '555-0110', 'Vale Yoga', 'search', 'lost', NULL, now() - interval '55 days', now() - interval '55 days'),
  ('dd000001-0000-4000-8000-00000000000b', 'Alex', 'Moreno', 'alex.moreno@example.test', '555-0111', 'Moreno Tile and Stone', 'partner', 'client', (current_date - 30), now() - interval '45 days', now() - interval '45 days'),
  ('dd000001-0000-4000-8000-00000000000c', 'Quinn', 'Harper', 'quinn.harper@example.test', '555-0112', NULL, 'website', 'new_lead', NULL, now() - interval '1 day', now() - interval '1 day')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- The businesses they own
-- ---------------------------------------------------------------------------

INSERT INTO public.organizations (id, contact_id, name, organization_type, status) VALUES
  ('dd000002-0000-4000-8000-000000000001', 'dd000001-0000-4000-8000-000000000001', 'Stone Ceramics LLC', 'llc', 'active'),
  ('dd000002-0000-4000-8000-000000000002', 'dd000001-0000-4000-8000-000000000002', 'Pike Bicycle Works', 'sole_proprietorship', 'active'),
  ('dd000002-0000-4000-8000-000000000003', 'dd000001-0000-4000-8000-000000000003', 'Quinn Landscaping LLC', 'llc', 'closed'),
  ('dd000002-0000-4000-8000-000000000004', 'dd000001-0000-4000-8000-000000000004', 'Hale Design Studio', 'partnership', 'prospect'),
  ('dd000002-0000-4000-8000-000000000005', 'dd000001-0000-4000-8000-000000000005', 'Rowe Catering Co', 'corporation', 'prospect'),
  ('dd000002-0000-4000-8000-000000000006', 'dd000001-0000-4000-8000-000000000007', 'Frost Print Shop', 'llc', 'prospect'),
  ('dd000002-0000-4000-8000-000000000007', 'dd000001-0000-4000-8000-000000000009', 'Ellery Bakery', 'llc', 'closed'),
  ('dd000002-0000-4000-8000-000000000008', 'dd000001-0000-4000-8000-00000000000b', 'Moreno Tile and Stone', 'corporation', 'active'),
  ('dd000002-0000-4000-8000-000000000009', 'dd000001-0000-4000-8000-00000000000b', 'Moreno Rentals', 'llc', 'active')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Quotes: accepted for clients, proposed for open leads
-- ---------------------------------------------------------------------------

INSERT INTO public.contact_services (id, contact_id, organization_id, service_type, state, cadence, amount) VALUES
  ('dd000003-0000-4000-8000-000000000001', 'dd000001-0000-4000-8000-000000000001', 'dd000002-0000-4000-8000-000000000001', 'retainer', 'accepted', 'monthly', 450),
  ('dd000003-0000-4000-8000-000000000002', 'dd000001-0000-4000-8000-000000000002', 'dd000002-0000-4000-8000-000000000002', 'retainer', 'accepted', 'monthly', 300),
  ('dd000003-0000-4000-8000-000000000003', 'dd000001-0000-4000-8000-000000000002', NULL, 'annual_plan', 'accepted', 'annual', 1200),
  ('dd000003-0000-4000-8000-000000000004', 'dd000001-0000-4000-8000-000000000003', 'dd000002-0000-4000-8000-000000000003', 'project', 'accepted', 'one_time', 2500),
  ('dd000003-0000-4000-8000-000000000005', 'dd000001-0000-4000-8000-000000000004', 'dd000002-0000-4000-8000-000000000004', 'retainer', 'proposed', 'monthly', 600),
  ('dd000003-0000-4000-8000-000000000006', 'dd000001-0000-4000-8000-000000000005', 'dd000002-0000-4000-8000-000000000005', 'project', 'proposed', 'one_time', 1800),
  ('dd000003-0000-4000-8000-000000000007', 'dd000001-0000-4000-8000-000000000007', 'dd000002-0000-4000-8000-000000000006', 'consultation', 'proposed', 'one_time', 250),
  ('dd000003-0000-4000-8000-000000000008', 'dd000001-0000-4000-8000-00000000000a', NULL, 'retainer', 'proposed', 'monthly', 350),
  ('dd000003-0000-4000-8000-000000000009', 'dd000001-0000-4000-8000-00000000000b', 'dd000002-0000-4000-8000-000000000008', 'retainer', 'accepted', 'monthly', 800),
  ('dd000003-0000-4000-8000-00000000000a', 'dd000001-0000-4000-8000-00000000000b', 'dd000002-0000-4000-8000-000000000009', 'annual_plan', 'proposed', 'annual', 900)
ON CONFLICT DO NOTHING;

INSERT INTO public.contact_upsells (id, contact_id, title, service_type, est_amount, cadence, status) VALUES
  ('dd00000d-0000-4000-8000-000000000001', 'dd000001-0000-4000-8000-000000000001', 'Add a second studio location', 'project', 1500, 'one_time', 'open'),
  ('dd00000d-0000-4000-8000-000000000002', 'dd000001-0000-4000-8000-000000000002', 'Move to the annual plan', 'annual_plan', 1200, 'annual', 'won'),
  ('dd00000d-0000-4000-8000-000000000003', 'dd000001-0000-4000-8000-00000000000b', 'Quarterly planning sessions', 'consultation', 400, 'one_time', 'pitched')
ON CONFLICT DO NOTHING;

INSERT INTO public.contact_notes (id, contact_id, body, kind, created_at) VALUES
  ('dd000004-0000-4000-8000-000000000001', 'dd000001-0000-4000-8000-000000000004', 'Intro call went well. Wants a proposal by the end of the month.', 'call', now() - interval '18 days'),
  ('dd000004-0000-4000-8000-000000000002', 'dd000001-0000-4000-8000-000000000005', 'Busy season until spring. Check back then.', 'email', now() - interval '35 days'),
  ('dd000004-0000-4000-8000-000000000003', 'dd000001-0000-4000-8000-000000000001', 'Prefers email over phone. Mornings are best.', 'note', now() - interval '160 days'),
  ('dd000004-0000-4000-8000-000000000004', 'dd000001-0000-4000-8000-00000000000a', 'Went with someone closer to home.', 'note', now() - interval '50 days'),
  ('dd000004-0000-4000-8000-000000000005', 'dd000001-0000-4000-8000-000000000007', 'Met at the spring trade fair. Booked a call for next week.', 'meeting', now() - interval '9 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Work board. A card the app makes always has a 'created' event, so each one here does too.
-- ---------------------------------------------------------------------------

INSERT INTO public.work_items (id, contact_id, title, work_item_type, stage, priority, due_date) VALUES
  ('dd000005-0000-4000-8000-000000000001', 'dd000001-0000-4000-8000-000000000004', 'Send the proposal', 'task', 'todo', 'urgent', current_date + 3),
  ('dd000005-0000-4000-8000-000000000002', 'dd000001-0000-4000-8000-000000000006', 'First call with the new lead', 'call', 'todo', 'normal', current_date + 1),
  ('dd000005-0000-4000-8000-000000000003', 'dd000001-0000-4000-8000-000000000001', 'Collect the signed agreement', 'paperwork', 'waiting', 'normal', current_date + 7),
  ('dd000005-0000-4000-8000-000000000004', 'dd000001-0000-4000-8000-00000000000b', 'Set up the rentals account', 'task', 'doing', 'normal', NULL),
  ('dd000005-0000-4000-8000-000000000005', 'dd000001-0000-4000-8000-000000000002', 'Quarterly review', 'review', 'doing', 'low', current_date + 14),
  ('dd000005-0000-4000-8000-000000000006', 'dd000001-0000-4000-8000-000000000003', 'Wrap up the project', 'task', 'done', 'normal', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO public.work_item_events (id, work_item_id, event_type, from_value, to_value, actor_user_id)
SELECT e.id, e.work_item_id, 'created', NULL, e.stage, o.owner_user_id
FROM (VALUES
  ('dd000006-0000-4000-8000-000000000001'::uuid, 'dd000005-0000-4000-8000-000000000001'::uuid, 'todo'),
  ('dd000006-0000-4000-8000-000000000002'::uuid, 'dd000005-0000-4000-8000-000000000002'::uuid, 'todo'),
  ('dd000006-0000-4000-8000-000000000003'::uuid, 'dd000005-0000-4000-8000-000000000003'::uuid, 'waiting'),
  ('dd000006-0000-4000-8000-000000000004'::uuid, 'dd000005-0000-4000-8000-000000000004'::uuid, 'doing'),
  ('dd000006-0000-4000-8000-000000000005'::uuid, 'dd000005-0000-4000-8000-000000000005'::uuid, 'doing'),
  ('dd000006-0000-4000-8000-000000000006'::uuid, 'dd000005-0000-4000-8000-000000000006'::uuid, 'done')
) AS e (id, work_item_id, stage)
CROSS JOIN public.org_profile o
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Messages. The owner's own messages only: a client's message is ciphertext encrypted in
-- the client's browser to the owner's key, which no file can make up.
-- ---------------------------------------------------------------------------

INSERT INTO public.client_messages (id, contact_id, sender_id, sender_role, body, is_encrypted, created_at)
SELECT m.id, m.contact_id, o.owner_user_id, 'owner', m.body, false, now() - m.age
FROM (VALUES
  ('dd000007-0000-4000-8000-000000000001'::uuid, 'dd000001-0000-4000-8000-000000000001'::uuid, 'Welcome aboard. Your portal is ready whenever you are.', interval '150 days'),
  ('dd000007-0000-4000-8000-000000000002'::uuid, 'dd000001-0000-4000-8000-000000000001'::uuid, 'I have sent a short check-in request. It takes five minutes.', interval '2 days'),
  ('dd000007-0000-4000-8000-000000000003'::uuid, 'dd000001-0000-4000-8000-000000000002'::uuid, 'Thanks for the referral last month. Much appreciated.', interval '6 days')
) AS m (id, contact_id, body, age)
CROSS JOIN public.org_profile o
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Requests: one draft, one sent (no start link: a reminder from the request page makes one)
-- ---------------------------------------------------------------------------

INSERT INTO public.needs_lists (id, contact_id, title, status, intro_message, created_by, created_at, sent_at)
SELECT l.id, l.contact_id, l.title, l.status, l.intro, o.owner_user_id, now() - l.age, l.sent_at
FROM (VALUES
  ('dd000008-0000-4000-8000-000000000001'::uuid, 'dd000001-0000-4000-8000-000000000004'::uuid, 'Getting started', 'draft',
   'A few things to get us going.', interval '1 day', NULL::timestamptz),
  ('dd000008-0000-4000-8000-000000000002'::uuid, 'dd000001-0000-4000-8000-000000000001'::uuid, 'Quarterly check-in', 'sent',
   'Please send these when you have a moment.', interval '3 days', now() - interval '2 days')
) AS l (id, contact_id, title, status, intro, age, sent_at)
CROSS JOIN public.org_profile o
ON CONFLICT DO NOTHING;

INSERT INTO public.needs_items (id, list_id, kind, label, description, sort_order, required, category) VALUES
  ('dd000009-0000-4000-8000-000000000001', 'dd000008-0000-4000-8000-000000000001', 'document', 'Signed engagement letter', NULL, 10, true, 'contract'),
  ('dd000009-0000-4000-8000-000000000002', 'dd000008-0000-4000-8000-000000000001', 'question', 'What would make the first month a success?', NULL, 20, true, 'onboarding'),
  ('dd000009-0000-4000-8000-000000000003', 'dd000008-0000-4000-8000-000000000001', 'info', 'We reply within one business day.', NULL, 30, false, 'general'),
  ('dd000009-0000-4000-8000-000000000004', 'dd000008-0000-4000-8000-000000000002', 'document', 'Latest supplier invoice', 'A photo or PDF is fine.', 10, true, 'invoice'),
  ('dd000009-0000-4000-8000-000000000005', 'dd000008-0000-4000-8000-000000000002', 'question', 'Anything new we should plan for this quarter?', NULL, 20, false, 'general'),
  ('dd000009-0000-4000-8000-000000000006', 'dd000008-0000-4000-8000-000000000002', 'todo', 'Confirm your mailing address is current', NULL, 30, true, 'general')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- E-signature: one draft envelope with a signer and no documents (no storage objects).
-- The signer insert bumps the envelope's draft revision, so it runs only when absent.
-- ---------------------------------------------------------------------------

INSERT INTO public.esign_envelopes (id, created_by, primary_contact_id, title, status)
SELECT 'dd00000a-0000-4000-8000-000000000001', o.owner_user_id, 'dd000001-0000-4000-8000-000000000004',
       'Service agreement', 'draft'
FROM public.org_profile o
ON CONFLICT DO NOTHING;

INSERT INTO public.esign_envelope_signers (id, envelope_id, contact_id, "order", role, email)
SELECT 'dd00000b-0000-4000-8000-000000000001', 'dd00000a-0000-4000-8000-000000000001',
       'dd000001-0000-4000-8000-000000000004', 0, 'primary', 'morgan.hale@example.test'
WHERE NOT EXISTS (SELECT 1 FROM public.esign_envelope_signers WHERE id = 'dd00000b-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Marketing: this month's and last month's targets and ad spend
-- ---------------------------------------------------------------------------

INSERT INTO public.monthly_goals (id, month, new_leads_target, closed_clients_target, ad_spend) VALUES
  ('dd00000c-0000-4000-8000-000000000001', to_char(now() - interval '1 month', 'YYYY-MM'), 8, 2, 300),
  ('dd00000c-0000-4000-8000-000000000002', to_char(now(), 'YYYY-MM'), 10, 3, 350)
ON CONFLICT DO NOTHING;

COMMIT;
