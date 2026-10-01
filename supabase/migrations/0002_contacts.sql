-- 0002_contacts: the people and businesses the owner works with, and their portal access.
--
-- Depends on 0001_core: org_profile, is_owner(), mfa_session_ok(), set_updated_at(),
-- enforce_client_column_guard().
--
-- Principals, as everywhere in this schema:
--   owner   is_owner(): the org_profile owner, at aal2 when MFA is enrolled.
--   client  get_client_contact_id(): the contact an active portal account belongs to.
--   server  service_role (edge functions). It bypasses RLS but not triggers.
-- A role claim in a token grants nothing. anon has no access to anything in this file.

-- ---------------------------------------------------------------------------
-- Pick-lists. Labels, colours and order are the owner's to edit; keys never change.
-- System rows are ones the code depends on: they can be relabelled, not deleted.
-- ---------------------------------------------------------------------------

-- The pipeline. Code branches on these keys, so the set is fixed; only the labels move.
CREATE TABLE public.contact_statuses (
  key text PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO public.contact_statuses (key, label, sort_order) VALUES
  ('new_lead', 'New lead', 10),
  ('active_lead', 'Active lead', 20),
  ('nurture', 'Nurture', 30),
  ('follow_up_later', 'Follow up later', 40),
  ('client', 'Client', 50),
  ('one_time', 'One-time client', 60),
  ('lost', 'Lost', 70),
  ('esign_signer', 'Signer only', 80);

CREATE TABLE public.lead_sources (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

INSERT INTO public.lead_sources (key, label, sort_order, is_system) VALUES
  ('referral', 'Referral', 10, false),
  ('website', 'Website', 20, false),
  ('search', 'Search', 30, false),
  ('social_media', 'Social media', 40, false),
  ('advertising', 'Advertising', 50, false),
  ('event', 'Event', 60, false),
  ('lead_intake', 'Lead intake API', 80, true),
  ('esign', 'E-signature', 90, true),
  ('other', 'Other', 100, true);

CREATE TABLE public.organization_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

INSERT INTO public.organization_types (key, label, sort_order, is_system) VALUES
  ('sole_proprietorship', 'Sole proprietorship', 10, false),
  ('llc', 'LLC', 20, false),
  ('partnership', 'Partnership', 30, false),
  ('corporation', 'Corporation', 40, false),
  ('nonprofit', 'Nonprofit', 50, false),
  ('other', 'Other', 100, true);

-- revenue_family is what the marketing revenue math reads: recurring services count
-- toward monthly recurring revenue, one-time services do not.
CREATE TABLE public.service_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  colour text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  revenue_family text NOT NULL CHECK (revenue_family IN ('recurring', 'one_time')),
  default_cadence text NOT NULL CHECK (default_cadence IN ('monthly', 'annual', 'one_time'))
);

INSERT INTO public.service_types (key, label, sort_order, is_system, revenue_family, default_cadence) VALUES
  ('retainer', 'Monthly retainer', 10, false, 'recurring', 'monthly'),
  ('annual_plan', 'Annual plan', 20, false, 'recurring', 'annual'),
  ('project', 'Project', 30, false, 'one_time', 'one_time'),
  ('consultation', 'Consultation', 40, false, 'one_time', 'one_time'),
  ('other', 'Other', 100, true, 'one_time', 'one_time');

-- The rules above hold for every role, the server included: keys never change, system
-- rows stay exactly what the code expects (only label, colour and order move), and
-- the pipeline is the fixed set seeded here.
CREATE FUNCTION public.guard_pick_list()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  fixed boolean := TG_TABLE_NAME = 'contact_statuses';
  o jsonb;
  n jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF fixed OR (to_jsonb(NEW) ->> 'is_system')::boolean THEN
      RAISE EXCEPTION '%: rows the code depends on are created only by migrations', TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF fixed OR (to_jsonb(OLD) ->> 'is_system')::boolean THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '%: % is a built-in row and cannot be deleted', TG_TABLE_NAME, OLD.key
        USING ERRCODE = '42501';
    END IF;
    o := to_jsonb(OLD) - ARRAY['label', 'colour', 'sort_order'];
    n := to_jsonb(NEW) - ARRAY['label', 'colour', 'sort_order'];
    IF o IS DISTINCT FROM n THEN
      RAISE EXCEPTION '%: only the label, colour and order of % can change', TG_TABLE_NAME, OLD.key
        USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (NEW.key IS DISTINCT FROM OLD.key OR NEW.is_system) THEN
    RAISE EXCEPTION '%: a key never changes, and a row cannot become built-in', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contact_statuses_guard BEFORE INSERT OR UPDATE OR DELETE ON public.contact_statuses
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();
CREATE TRIGGER trg_lead_sources_guard BEFORE INSERT OR UPDATE OR DELETE ON public.lead_sources
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();
CREATE TRIGGER trg_organization_types_guard BEFORE INSERT OR UPDATE OR DELETE ON public.organization_types
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();
CREATE TRIGGER trg_service_types_guard BEFORE INSERT OR UPDATE OR DELETE ON public.service_types
  FOR EACH ROW EXECUTE FUNCTION public.guard_pick_list();

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------

CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- When the lead actually arrived, if earlier than the row (a backdated intake).
  submitted_at timestamptz,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  full_name text GENERATED ALWAYS AS (
    CASE WHEN last_name = '' THEN first_name ELSE first_name || ' ' || last_name END
  ) STORED,
  -- Mirrors of the default rows in contact_emails, kept in step by triggers below.
  email text CHECK (email IS NULL OR char_length(btrim(email)) BETWEEN 3 AND 254),
  phone text,
  -- What the lead called their business, before any organization row exists. The
  -- organizations table is the registry; this is a display field.
  business_name text,
  spouse_first_name text,
  spouse_last_name text,
  spouse_name text GENERATED ALWAYS AS (
    CASE
      WHEN spouse_first_name IS NULL THEN NULL
      WHEN spouse_last_name IS NULL OR spouse_last_name = '' THEN spouse_first_name
      ELSE spouse_first_name || ' ' || spouse_last_name
    END
  ) STORED,
  spouse_email text CHECK (spouse_email IS NULL OR char_length(btrim(spouse_email)) BETWEEN 3 AND 254),
  spouse_phone text,
  date_of_birth date,
  spouse_date_of_birth date,
  mailing_street text,
  mailing_city text,
  mailing_state text,
  mailing_zip text,
  source text NOT NULL DEFAULT 'other' REFERENCES public.lead_sources (key),
  status text NOT NULL DEFAULT 'new_lead' REFERENCES public.contact_statuses (key),
  -- Written only by the trigger below: one entry per status change.
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_since date,
  portal_sidebar_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The contact-delete claim (see admin_contact_delete_begin).
  delete_claim uuid,
  delete_claimed_at timestamptz
);

CREATE INDEX idx_contacts_status ON public.contacts (status);
CREATE INDEX idx_contacts_source ON public.contacts (source);
CREATE INDEX idx_contacts_email ON public.contacts (lower(email));
CREATE INDEX idx_contacts_submitted_at ON public.contacts (submitted_at DESC NULLS LAST);
CREATE INDEX idx_contacts_client_since ON public.contacts (client_since DESC NULLS LAST);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- History comes from OLD, never NEW: a caller's own write to status_history is dropped
-- on INSERT and on UPDATE alike.
CREATE FUNCTION public.contacts_record_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_history := jsonb_build_array(jsonb_build_object(
      'status', NEW.status, 'timestamp', now(), 'changed_by', public.audit_actor()));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_history := OLD.status_history || jsonb_build_array(jsonb_build_object(
      'status', NEW.status, 'timestamp', now(), 'changed_by', public.audit_actor()));
  ELSE
    NEW.status_history := OLD.status_history;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contacts_record_status
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_record_status();

-- ---------------------------------------------------------------------------
-- Organizations: the businesses a contact owns. A registry, nothing more.
-- ---------------------------------------------------------------------------

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  organization_type text NOT NULL DEFAULT 'other' REFERENCES public.organization_types (key),
  tax_id text CHECK (tax_id IS NULL OR char_length(tax_id) <= 40),
  status text NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect', 'active', 'paused', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target of contact_services' composite key: a quote can only name a business its
  -- own contact owns.
  UNIQUE (id, contact_id)
);

CREATE INDEX idx_organizations_contact ON public.organizations (contact_id);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Contact detail tables (owner only)
-- ---------------------------------------------------------------------------

CREATE TABLE public.contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('primary', 'spouse')),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  label text NOT NULL DEFAULT 'other' CHECK (label IN ('business', 'personal', 'other')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_emails_contact ON public.contact_emails (contact_id);
-- One default per (contact, kind); one row per address per kind. The email sync
-- trigger's ON CONFLICT names this exact expression.
CREATE UNIQUE INDEX contact_emails_one_default_per_kind
  ON public.contact_emails (contact_id, kind) WHERE is_default;
CREATE UNIQUE INDEX contact_emails_unique_per_kind
  ON public.contact_emails (contact_id, kind, lower(email));

CREATE TRIGGER trg_contact_emails_updated_at
  BEFORE UPDATE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Append-only: notes are a record. No role is granted UPDATE or DELETE; they go only
-- when their contact is deleted.
CREATE TABLE public.contact_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'call', 'email', 'meeting')),
  source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'mcp', 'lead_intake')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_notes_contact_created ON public.contact_notes (contact_id, created_at DESC);

CREATE TABLE public.contact_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  related_contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  relationship text NOT NULL
    CHECK (relationship IN ('spouse', 'partner', 'dependent', 'business_partner', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contact_id <> related_contact_id),
  UNIQUE (contact_id, related_contact_id, relationship)
);

CREATE INDEX idx_contact_relationships_related ON public.contact_relationships (related_contact_id);

-- At most one open follow-up per contact.
CREATE TABLE public.contact_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts (id) ON DELETE CASCADE,
  next_followup_date date,
  reason text CHECK (char_length(COALESCE(reason, '')) <= 2000),
  private_note text CHECK (char_length(COALESCE(private_note, '')) <= 5000),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_followups_due
  ON public.contact_followups (next_followup_date) WHERE next_followup_date IS NOT NULL;

CREATE TRIGGER trg_contact_followups_updated_at
  BEFORE UPDATE ON public.contact_followups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Quotes: one row per (contact, business or none, service).
CREATE TABLE public.contact_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  organization_id uuid,
  service_type text NOT NULL REFERENCES public.service_types (key),
  state text NOT NULL CHECK (state IN ('proposed', 'accepted')),
  cadence text NOT NULL CHECK (cadence IN ('monthly', 'annual', 'one_time')),
  amount numeric(15, 2) CHECK (amount IS NULL OR amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (contact_id, organization_id, service_type),
  -- NO ACTION, not RESTRICT: deleting the contact removes its businesses and its
  -- quotes in one statement, which a RESTRICT check would refuse mid-cascade.
  -- Deleting a business that still has quotes is refused.
  FOREIGN KEY (organization_id, contact_id) REFERENCES public.organizations (id, contact_id)
);

CREATE INDEX idx_contact_services_contact ON public.contact_services (contact_id);
CREATE INDEX idx_contact_services_organization ON public.contact_services (organization_id);

CREATE TRIGGER trg_contact_services_updated_at
  BEFORE UPDATE ON public.contact_services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.contact_upsells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  service_type text REFERENCES public.service_types (key),
  est_amount numeric(15, 2) CHECK (est_amount IS NULL OR est_amount >= 0),
  cadence text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly', 'annual', 'one_time')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pitched', 'won', 'passed')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_upsells_contact ON public.contact_upsells (contact_id);

CREATE TRIGGER trg_contact_upsells_updated_at
  BEFORE UPDATE ON public.contact_upsells
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Portal access
-- ---------------------------------------------------------------------------

CREATE TABLE public.client_portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES auth.users (id) ON DELETE SET NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'secondary')),
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'deactivated')),
  invited_email text,
  invited_at timestamptz NOT NULL DEFAULT now(),
  invited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  activated_at timestamptz,
  last_login_at timestamptz,
  login_count integer NOT NULL DEFAULT 0,
  mfa_verified_at timestamptz,
  -- The contact-delete claim, and the status to restore if that delete is abandoned.
  delete_claim uuid,
  delete_claimed_at timestamptz,
  status_before_claim text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_portal_accounts_contact ON public.client_portal_accounts (contact_id);
CREATE INDEX idx_portal_accounts_invited_by ON public.client_portal_accounts (invited_by);
CREATE UNIQUE INDEX idx_portal_accounts_open_invite
  ON public.client_portal_accounts (contact_id, lower(invited_email))
  WHERE status IN ('invited', 'active');

CREATE TRIGGER trg_client_portal_accounts_updated_at
  BEFORE UPDATE ON public.client_portal_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.portal_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text UNIQUE,
  email text NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  invited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_portal_invitations_contact ON public.portal_invitations (contact_id);
CREATE INDEX idx_portal_invitations_invited_by ON public.portal_invitations (invited_by);
CREATE INDEX idx_portal_invitations_status ON public.portal_invitations (status);

-- What happened in the portal, per contact. Written by edge functions (service role),
-- and directly by a client only for the few actions listed in its INSERT policy.
CREATE TABLE public.client_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'login', 'logout', 'session_start', 'session_expired',
    'invitation_accepted', 'start_link_consumed',
    'profile_update', 'password_change', 'password_reset_sent',
    'document_upload', 'document_download', 'document_delete',
    'message_sent', 'message_read', 'esign_signed', 'email_sent',
    'account_suspended', 'account_reactivated', 'account_deleted'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(details) <= 8192),
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_log_contact_created ON public.client_activity_log (contact_id, created_at DESC);
CREATE INDEX idx_activity_log_user ON public.client_activity_log (user_id);

CREATE TABLE public.client_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text,
  type text NOT NULL DEFAULT 'action_item'
    CHECK (type IN ('document_request', 'action_item', 'esign')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'dismissed')),
  -- An in-app path. Rendered as a link in the portal, so it must stay on this site.
  -- A leading "//" or "/\" is protocol-relative in a browser, so neither is allowed.
  -- Browsers also strip tabs and newlines from a URL before parsing it, so no
  -- whitespace or control character anywhere.
  link text CHECK (link IS NULL OR link ~ '^/([^/\\[:space:][:cntrl:]][^[:space:][:cntrl:]]*)?$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_client_tasks_contact_status ON public.client_tasks (contact_id, status);

-- The owner's "view as client" sessions. Written only by the impersonation functions.
CREATE TABLE public.impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  target_contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  target_email text NOT NULL,
  target_name text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ip_address inet,
  user_agent text
);

CREATE INDEX idx_impersonation_sessions_active
  ON public.impersonation_sessions (owner_user_id) WHERE ended_at IS NULL;
CREATE INDEX idx_impersonation_sessions_started
  ON public.impersonation_sessions (owner_user_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- The client principal
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.get_client_contact_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.contact_id
  FROM public.client_portal_accounts a
  WHERE a.user_id = auth.uid()
    AND a.status = 'active'
    AND public.mfa_session_ok()
  LIMIT 1;
$$;

-- The portal's only view of the contacts table: the client's own row, these columns.
CREATE FUNCTION public.get_my_contact()
RETURNS TABLE (
  id uuid, first_name text, last_name text, full_name text, email text, phone text,
  business_name text, spouse_first_name text, spouse_last_name text, spouse_name text,
  spouse_email text, client_since date, portal_sidebar_config jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.first_name, c.last_name, c.full_name, c.email, c.phone,
         c.business_name, c.spouse_first_name, c.spouse_last_name, c.spouse_name,
         c.spouse_email, c.client_since, c.portal_sidebar_config
  FROM public.contacts c
  WHERE c.id = (SELECT public.get_client_contact_id());
$$;

-- The portal's view of its activity history: what happened and when, never another
-- person's network address or what the server recorded about it.
CREATE FUNCTION public.get_my_activity(p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, action text, created_at timestamptz, by_me boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.id, l.action, l.created_at, l.user_id IS NOT DISTINCT FROM auth.uid()
  FROM public.client_activity_log l
  WHERE l.contact_id = (SELECT public.get_client_contact_id())
  ORDER BY l.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

-- ---------------------------------------------------------------------------
-- Email mirror: contacts.email / spouse_email always equal the default row of that
-- kind in contact_emails, or NULL when there is none. Both directions, including
-- clearing, so a removed address can never stay deliverable.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.sync_contact_to_contact_emails()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  k text;
  v text;
  changed boolean;
BEGIN
  FOREACH k IN ARRAY ARRAY['primary', 'spouse'] LOOP
    IF k = 'primary' THEN
      v := NULLIF(btrim(NEW.email), '');
      changed := TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email;
    ELSE
      v := NULLIF(btrim(NEW.spouse_email), '');
      changed := TG_OP = 'INSERT' OR NEW.spouse_email IS DISTINCT FROM OLD.spouse_email;
    END IF;
    CONTINUE WHEN NOT changed;

    UPDATE public.contact_emails
       SET is_default = false
     WHERE contact_id = NEW.id AND kind = k AND is_default
       AND (v IS NULL OR lower(email) <> lower(v));

    IF v IS NOT NULL THEN
      INSERT INTO public.contact_emails (contact_id, kind, email, is_default)
      VALUES (NEW.id, k, v, true)
      ON CONFLICT (contact_id, kind, lower(email))
        DO UPDATE SET is_default = true, email = EXCLUDED.email;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_contacts_sync_to_emails
  AFTER INSERT OR UPDATE OF email, spouse_email ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.sync_contact_to_contact_emails();

CREATE FUNCTION public.sync_contact_email_to_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  targets jsonb := '[]'::jsonb;
  t jsonb;
  v text;
BEGIN
  -- Every (contact, kind) this write touched: the row's new place and, when an update
  -- moved it to another contact or kind, its old place too.
  IF TG_OP <> 'DELETE' THEN
    targets := targets || jsonb_build_array(jsonb_build_object('c', NEW.contact_id, 'k', NEW.kind));
  END IF;
  IF TG_OP = 'DELETE'
     OR OLD.contact_id IS DISTINCT FROM NEW.contact_id OR OLD.kind IS DISTINCT FROM NEW.kind THEN
    targets := targets || jsonb_build_array(jsonb_build_object('c', OLD.contact_id, 'k', OLD.kind));
  END IF;

  FOR t IN SELECT * FROM jsonb_array_elements(targets) LOOP
    -- The contact's address for that kind is its default row, or NULL when none is.
    SELECT e.email INTO v
    FROM public.contact_emails e
    WHERE e.contact_id = (t ->> 'c')::uuid AND e.kind = t ->> 'k' AND e.is_default;

    IF t ->> 'k' = 'primary' THEN
      UPDATE public.contacts SET email = v
       WHERE id = (t ->> 'c')::uuid AND email IS DISTINCT FROM v;
    ELSE
      UPDATE public.contacts SET spouse_email = v
       WHERE id = (t ->> 'c')::uuid AND spouse_email IS DISTINCT FROM v;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_contact_emails_sync_to_contact
  AFTER INSERT OR UPDATE OR DELETE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.sync_contact_email_to_contact();

-- Make one address the default for its kind. Owner only; a wrong id raises, and the
-- demote rolls back with it, so a contact never ends up with no default by mistake.
CREATE FUNCTION public.contact_emails_set_default(p_id uuid, p_contact_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_promoted integer;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.contact_emails
     SET is_default = false
   WHERE contact_id = p_contact_id AND kind = p_kind AND is_default AND id <> p_id;

  UPDATE public.contact_emails
     SET is_default = true
   WHERE id = p_id AND contact_id = p_contact_id AND kind = p_kind;

  GET DIAGNOSTICS v_promoted = ROW_COUNT;
  IF v_promoted = 0 THEN
    RAISE EXCEPTION 'contact_emails_set_default: no matching row for id %', p_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Portal task and activity guards
-- ---------------------------------------------------------------------------

-- Structural task columns are the owner's and the server's (the shared column guard).
CREATE TRIGGER trg_client_tasks_column_guard
  BEFORE UPDATE ON public.client_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_column_guard(
    'id', 'contact_id', 'title', 'description', 'type', 'link', 'metadata',
    'created_by', 'created_at');

-- A client may move a pending task to completed or dismissed, and nothing else;
-- completed_at is stamped here, never taken from the client.
CREATE FUNCTION public.client_tasks_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF public.is_owner_or_server() THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.completed_at := CASE WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_at, now()) END;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('completed', 'dismissed') THEN
      RAISE EXCEPTION 'task status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
    NEW.completed_at := CASE WHEN NEW.status = 'completed' THEN now() END;
  ELSE
    NEW.completed_at := OLD.completed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_tasks_status_transition
  BEFORE UPDATE ON public.client_tasks
  FOR EACH ROW EXECUTE FUNCTION public.client_tasks_status_transition();

-- A client-written activity row carries no caller-chosen time, address or role.
CREATE FUNCTION public.stamp_client_activity_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF public.is_owner_or_server() THEN
    RETURN NEW;
  END IF;

  NEW.created_at := now();
  NEW.ip_address := NULL;
  NEW.user_agent := NULL;
  NEW.details := (COALESCE(NEW.details, '{}'::jsonb) - 'actor_email')
                 || jsonb_build_object('actor_role', 'client');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_activity_log_stamp
  BEFORE INSERT ON public.client_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.stamp_client_activity_insert();

-- Server only: count an invitation attempt, refusing past the cap.
CREATE FUNCTION public.increment_invitation_attempt(invitation_id uuid, max_attempts integer DEFAULT 5)
RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.portal_invitations
     SET attempt_count = attempt_count + 1
   WHERE id = invitation_id AND attempt_count < max_attempts
  RETURNING attempt_count;
$$;

-- ---------------------------------------------------------------------------
-- Contact delete: a claim protocol, because deleting a contact also destroys its
-- portal logins (in auth, outside this transaction). The server calls begin, deletes
-- the logins, then either admin_delete_contact (success) or release (failure).
-- While a claim is live (five minutes), nothing may attach, move or re-activate a
-- portal account on that contact.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.contact_delete_claim_live(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE id = p_contact_id
      AND delete_claim IS NOT NULL
      AND delete_claimed_at > now() - interval '5 minutes'
  );
$$;

CREATE FUNCTION public.admin_contact_delete_begin(p_contact_id uuid)
RETURNS TABLE (exists_now boolean, blocking_code text, user_ids uuid[], prior jsonb, claim uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim uuid := gen_random_uuid();
BEGIN
  exists_now := false; blocking_code := NULL; user_ids := ARRAY[]::uuid[];
  prior := '{}'::jsonb; claim := NULL;

  PERFORM 1 FROM public.contacts WHERE id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  exists_now := true;

  -- begin stamps the contact before any account, so a live claim is always visible
  -- on the contact row.
  IF public.contact_delete_claim_live(p_contact_id) THEN
    blocking_code := 'delete_in_progress';
    RETURN NEXT; RETURN;
  END IF;

  -- Every account's status to restore on release. An account still suspended under an
  -- expired claim (a delete that died before release) keeps the status it had before
  -- that claim, not the suspension the dead delete left behind.
  UPDATE public.client_portal_accounts
     SET status_before_claim = CASE
           WHEN delete_claim IS NOT NULL AND status = 'suspended'
             THEN COALESCE(status_before_claim, status)
           ELSE status
         END
   WHERE contact_id = p_contact_id;

  SELECT COALESCE(jsonb_object_agg(id::text, status_before_claim), '{}'::jsonb)
    INTO prior
  FROM public.client_portal_accounts
  WHERE contact_id = p_contact_id;

  -- The contact first: from here on the account trigger refuses every attach.
  UPDATE public.contacts
     SET delete_claim = v_claim, delete_claimed_at = now()
   WHERE id = p_contact_id;

  UPDATE public.client_portal_accounts
     SET status = 'suspended', delete_claim = v_claim, delete_claimed_at = now()
   WHERE contact_id = p_contact_id;

  SELECT COALESCE(array_agg(user_id) FILTER (WHERE user_id IS NOT NULL), ARRAY[]::uuid[])
    INTO user_ids
  FROM public.client_portal_accounts WHERE contact_id = p_contact_id;

  claim := v_claim;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.admin_contact_delete_release(
  p_contact_id uuid, p_prior jsonb, p_claim uuid, p_destroyed uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_claim IS NULL THEN RETURN; END IF;

  -- Transaction-local signal to the account trigger's release arm.
  PERFORM set_config('app.contact_delete_release', 'on', true);

  UPDATE public.client_portal_accounts a
     SET status = CASE
           -- The login is gone and the account had been usable: it cannot come back.
           WHEN a.user_id IS NULL AND COALESCE(p_prior ->> a.id::text, '') = 'active'
             THEN 'deactivated'
           WHEN a.user_id IS NOT NULL AND a.user_id = ANY (p_destroyed)
             THEN 'deactivated'
           ELSE COALESCE(p_prior ->> a.id::text, a.status)
         END,
         user_id = CASE WHEN a.user_id = ANY (p_destroyed) THEN NULL ELSE a.user_id END,
         delete_claim = NULL,
         delete_claimed_at = NULL,
         status_before_claim = NULL
   WHERE a.contact_id = p_contact_id AND a.delete_claim = p_claim;

  UPDATE public.contacts
     SET delete_claim = NULL, delete_claimed_at = NULL
   WHERE id = p_contact_id AND delete_claim = p_claim;

  PERFORM set_config('app.contact_delete_release', 'off', true);
END;
$$;

CREATE FUNCTION public.admin_delete_contact(p_contact_id uuid, p_claim uuid DEFAULT NULL)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
  v_claim uuid;
BEGIN
  SELECT delete_claim INTO v_claim
  FROM public.contacts WHERE id = p_contact_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN ARRAY[]::uuid[];  -- already gone: a retry is not a failure
  END IF;
  IF p_claim IS NULL OR v_claim IS NULL THEN
    RAISE EXCEPTION 'contact_delete_claim_missing';
  END IF;
  IF v_claim <> p_claim THEN
    RAISE EXCEPTION 'contact_delete_claim_mismatch';
  END IF;
  IF NOT public.contact_delete_claim_live(p_contact_id) THEN
    RAISE EXCEPTION 'contact_delete_claim_expired';
  END IF;

  PERFORM 1 FROM public.client_portal_accounts WHERE contact_id = p_contact_id FOR UPDATE;

  SELECT COALESCE(array_agg(user_id) FILTER (WHERE user_id IS NOT NULL), ARRAY[]::uuid[])
    INTO v_user_ids
  FROM public.client_portal_accounts WHERE contact_id = p_contact_id;

  DELETE FROM public.client_portal_accounts WHERE contact_id = p_contact_id;
  DELETE FROM public.contacts WHERE id = p_contact_id;

  RETURN v_user_ids;
END;
$$;

CREATE FUNCTION public.refuse_portal_account_under_delete_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The release path, first: release rewrites the account while the contact's claim is
  -- still live, into exactly the shape the arms below refuse. Gated on the flag
  -- admin_contact_delete_release sets for its own transaction, never on row shape.
  IF TG_OP = 'UPDATE'
     AND OLD.delete_claim IS NOT NULL
     AND NEW.delete_claim IS NULL
     AND COALESCE(current_setting('app.contact_delete_release', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Clearing a login (it had one) on the same contact is always allowed.
  IF TG_OP = 'UPDATE'
     AND OLD.user_id IS NOT NULL
     AND NEW.user_id IS NULL
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;

  -- Re-activating during a live claim would hand back an account the delete is removing.
  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'active'
     AND public.contact_delete_claim_live(NEW.contact_id) THEN
    RAISE EXCEPTION 'contact_delete_in_progress';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;

  -- Deleting a contact destroys its accounts' sign-ins, so an account must never point
  -- at the owner's or the system actor's own: one delete would lock the firm out.
  IF NEW.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.org_profile
    WHERE NEW.user_id IN (owner_user_id, system_user_id)
  ) THEN
    RAISE EXCEPTION 'portal_account_staff_user';
  END IF;

  PERFORM 1 FROM public.contacts WHERE id = NEW.contact_id FOR SHARE;
  IF public.contact_delete_claim_live(NEW.contact_id) THEN
    RAISE EXCEPTION 'contact_delete_in_progress';
  END IF;

  -- Moving an account off a claimed contact would smuggle it out of the delete's set.
  IF TG_OP = 'UPDATE'
     AND OLD.contact_id IS DISTINCT FROM NEW.contact_id
     AND public.contact_delete_claim_live(OLD.contact_id) THEN
    RAISE EXCEPTION 'contact_delete_in_progress';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_refuse_portal_account_under_delete_claim
  BEFORE INSERT OR UPDATE OF user_id, contact_id, status ON public.client_portal_accounts
  FOR EACH ROW EXECUTE FUNCTION public.refuse_portal_account_under_delete_claim();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.contact_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_upsells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- Pick-lists: the owner reads and edits them (which columns, the grants decide); a
-- client reads organization types, to label its own businesses. System rows stay.
CREATE POLICY contact_statuses_owner_select ON public.contact_statuses
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY contact_statuses_owner_update ON public.contact_statuses
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY lead_sources_owner_select ON public.lead_sources
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY lead_sources_owner_insert ON public.lead_sources
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY lead_sources_owner_update ON public.lead_sources
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY lead_sources_owner_delete ON public.lead_sources
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

CREATE POLICY organization_types_select ON public.organization_types
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) OR (SELECT public.get_client_contact_id()) IS NOT NULL);
CREATE POLICY organization_types_owner_insert ON public.organization_types
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY organization_types_owner_update ON public.organization_types
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY organization_types_owner_delete ON public.organization_types
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

CREATE POLICY service_types_owner_select ON public.service_types
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY service_types_owner_insert ON public.service_types
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()) AND NOT is_system);
CREATE POLICY service_types_owner_update ON public.service_types
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY service_types_owner_delete ON public.service_types
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()) AND NOT is_system);

-- Owner-only tables. A client reads its own contact through get_my_contact() only.
CREATE POLICY contacts_owner_all ON public.contacts
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_emails_owner_all ON public.contact_emails
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_relationships_owner_all ON public.contact_relationships
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_followups_owner_all ON public.contact_followups
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_services_owner_all ON public.contact_services
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY contact_upsells_owner_all ON public.contact_upsells
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY portal_invitations_owner_all ON public.portal_invitations
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY contact_notes_owner_select ON public.contact_notes
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY contact_notes_owner_insert ON public.contact_notes
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY impersonation_sessions_owner_select ON public.impersonation_sessions
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

-- Tables an owner and a client both reach: one policy per command, the two principals
-- ORed inside it, so neither side can be edited without the other in view.

-- Organizations: the owner manages them; a client reads its own.
CREATE POLICY organizations_select ON public.organizations
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
CREATE POLICY organizations_owner_insert ON public.organizations
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY organizations_owner_update ON public.organizations
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY organizations_owner_delete ON public.organizations
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()));

-- Portal accounts: the owner manages them; a client reads its own active row.
CREATE POLICY client_portal_accounts_select ON public.client_portal_accounts
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_owner())
    OR (user_id = (SELECT auth.uid()) AND status = 'active' AND (SELECT public.mfa_session_ok()))
  );
CREATE POLICY client_portal_accounts_owner_insert ON public.client_portal_accounts
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY client_portal_accounts_owner_update ON public.client_portal_accounts
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

-- Activity: the owner reads everything. A client records only actions it performs
-- itself (lifecycle events come from the server) and reads its history through
-- get_my_activity(), which leaves out other people's addresses and the server's details.
CREATE POLICY client_activity_log_owner_select ON public.client_activity_log
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY client_activity_log_insert ON public.client_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.is_owner())
    OR (
      contact_id = (SELECT public.get_client_contact_id())
      AND user_id = (SELECT auth.uid())
      AND action IN ('document_delete', 'message_read')
    )
  );

-- Tasks: the owner manages them; a client reads its own and completes or dismisses
-- them (the two triggers above bound what an update may change).
CREATE POLICY client_tasks_select ON public.client_tasks
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
CREATE POLICY client_tasks_update ON public.client_tasks
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()))
  WITH CHECK ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
CREATE POLICY client_tasks_owner_insert ON public.client_tasks
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY client_tasks_owner_delete ON public.client_tasks
  FOR DELETE TO authenticated USING ((SELECT public.is_owner()));

-- A second, independent MFA gate on every table: whatever a permissive policy above
-- says, a session that fails mfa_session_ok() (enrolled but at aal1, or holding a
-- token issued before an MFA recovery) reads and writes nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contact_statuses', 'lead_sources', 'organization_types', 'service_types',
    'contacts', 'organizations', 'contact_emails', 'contact_notes', 'contact_relationships',
    'contact_followups', 'contact_services', 'contact_upsells', 'client_portal_accounts',
    'portal_invitations', 'client_activity_log', 'client_tasks', 'impersonation_sessions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()))',
      t || '_mfa_gate', t);
  END LOOP;
END;
$$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.client_tasks;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Nothing inherited from Supabase's default privileges, for any role.
REVOKE ALL ON
  public.contact_statuses, public.lead_sources, public.organization_types, public.service_types,
  public.contacts, public.organizations, public.contact_emails, public.contact_notes,
  public.contact_relationships, public.contact_followups, public.contact_services,
  public.contact_upsells, public.client_portal_accounts, public.portal_invitations,
  public.client_activity_log, public.client_tasks, public.impersonation_sessions
FROM PUBLIC, anon, authenticated, service_role;

-- The server: row access only. No TRUNCATE, which skips RLS and row triggers, and no
-- UPDATE or DELETE on notes, which are a record.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.contact_statuses, public.lead_sources, public.organization_types, public.service_types,
  public.contacts, public.organizations, public.contact_emails,
  public.contact_relationships, public.contact_followups, public.contact_services,
  public.contact_upsells, public.client_portal_accounts, public.portal_invitations,
  public.client_activity_log, public.client_tasks, public.impersonation_sessions
TO service_role;
GRANT SELECT, INSERT ON public.contact_notes TO service_role;

-- Signed-in sessions: what a policy above can use, by column where a column must not
-- move. Pick-list keys and system flags never change; the fixed pipeline cannot be
-- added to or deleted from; the delete-claim columns belong to the server's delete
-- functions; an address stays with its contact and kind.
GRANT SELECT, UPDATE (label, colour, sort_order) ON public.contact_statuses TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.lead_sources, public.organization_types, public.service_types
  TO authenticated;
GRANT UPDATE (label, colour, sort_order, is_active) ON public.lead_sources, public.organization_types
  TO authenticated;
GRANT UPDATE (label, colour, sort_order, is_active, revenue_family, default_cadence)
  ON public.service_types TO authenticated;

-- No DELETE on contacts or portal accounts for a signed-in session: a contact's portal
-- accounts hold Auth sign-in users that only the server can destroy, so every delete goes
-- through the delete-contact edge function and the claim protocol below. A direct delete
-- would cascade the accounts away and leave their sign-ins alive.
GRANT SELECT ON public.contacts TO authenticated;
GRANT
  INSERT (submitted_at, first_name, last_name, email, phone, business_name, spouse_first_name,
          spouse_last_name, spouse_email, spouse_phone, date_of_birth, spouse_date_of_birth,
          mailing_street, mailing_city, mailing_state, mailing_zip, source, status, client_since,
          portal_sidebar_config),
  UPDATE (submitted_at, first_name, last_name, email, phone, business_name, spouse_first_name,
          spouse_last_name, spouse_email, spouse_phone, date_of_birth, spouse_date_of_birth,
          mailing_street, mailing_city, mailing_state, mailing_zip, source, status, client_since,
          portal_sidebar_config)
ON public.contacts TO authenticated;

GRANT SELECT ON public.client_portal_accounts TO authenticated;
GRANT
  INSERT (contact_id, user_id, role, status, invited_email, invited_at, invited_by, activated_at),
  UPDATE (user_id, role, status, invited_email, invited_at, invited_by, activated_at)
ON public.client_portal_accounts TO authenticated;

GRANT SELECT, INSERT, DELETE, UPDATE (email, label, is_default) ON public.contact_emails TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.organizations, public.contact_relationships, public.contact_followups,
  public.contact_services, public.contact_upsells, public.portal_invitations, public.client_tasks
TO authenticated;
GRANT SELECT, INSERT ON public.contact_notes, public.client_activity_log TO authenticated;
GRANT SELECT ON public.impersonation_sessions TO authenticated;

-- Functions created in this file only (never a sweep of the schema: that would strip
-- the grants 0001_core made). Trigger functions need no EXECUTE grant: Postgres checks
-- it when the trigger is created, not when it fires.
REVOKE ALL ON FUNCTION
  public.contacts_record_status(),
  public.get_client_contact_id(),
  public.get_my_contact(),
  public.get_my_activity(integer),
  public.guard_pick_list(),
  public.sync_contact_to_contact_emails(),
  public.sync_contact_email_to_contact(),
  public.contact_emails_set_default(uuid, uuid, text),
  public.client_tasks_status_transition(),
  public.stamp_client_activity_insert(),
  public.increment_invitation_attempt(uuid, integer),
  public.contact_delete_claim_live(uuid),
  public.admin_contact_delete_begin(uuid),
  public.admin_contact_delete_release(uuid, jsonb, uuid, uuid[]),
  public.admin_delete_contact(uuid, uuid),
  public.refuse_portal_account_under_delete_claim()
FROM PUBLIC, anon, authenticated, service_role;

-- The server's RPCs.
GRANT EXECUTE ON FUNCTION
  public.get_client_contact_id(),
  public.increment_invitation_attempt(uuid, integer),
  public.contact_delete_claim_live(uuid),
  public.admin_contact_delete_begin(uuid),
  public.admin_contact_delete_release(uuid, jsonb, uuid, uuid[]),
  public.admin_delete_contact(uuid, uuid)
TO service_role;

-- Signed-in sessions: the client principal (policies call it), the portal's own-contact
-- and own-activity reads, and the owner's default-address switch.
GRANT EXECUTE ON FUNCTION
  public.get_client_contact_id(),
  public.get_my_contact(),
  public.get_my_activity(integer),
  public.contact_emails_set_default(uuid, uuid, text)
TO authenticated;
