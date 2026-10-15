-- 0010_email: group email.
--
-- Belongs here: campaigns, their recipients and delivery state, suppressions (the
-- per-address do-not-send list, checked at send time) and unsubscribe tokens. Sending
-- goes through the outbound adapter: the provider when keyed, otherwise dev_outbox.
--
-- Depends on: 0001_core (is_owner, mfa_session_ok, dev_outbox, audit_logs, the rate-limit
-- buckets), 0002_contacts (contacts, whose email column mirrors the default primary
-- address in contact_emails, and the statuses that may be emailed).
--
-- Who touches what:
--   crm-send-group-email   the owner composes ONE message; the function resolves each
--                          recipient from a contact id (the browser never supplies an
--                          address), writes the campaign through group_email_begin, and
--                          sends each recipient its own copy through _shared/outbound.ts.
--   email-unsubscribe      public; a token from the email suppresses its own address.
--   the owner's browser    SELECT only, on campaigns, recipients and suppressions. Never
--                          a write: an opt-out a signed-in session could erase from the
--                          browser is not an opt-out, and the send log is evidence.
--   tokens                 no session reads them at all: a token is a capability.
--
-- Suppression is ADDRESS-level by design. A contact can hold several addresses, so a
-- contact-level flag would suppress every address when one unsubscribes and leave the
-- same address mailable under another contact. The known gap: a person who unsubscribed
-- and whose address later changes can be mailed at the new one.
--
-- Rules, as for every migration in this schema. src/__tests__/db/invariants.test.ts reads
-- the migrated catalog and fails the build when a table or function here breaks one:
--   * RLS on every table, and a RESTRICTIVE policy named <table>_mfa_gate, FOR ALL TO
--     authenticated, USING ((SELECT public.mfa_session_ok())) and WITH CHECK the same.
--   * Privileges stated, never inherited: REVOKE ALL ON <table> FROM PUBLIC, anon,
--     authenticated, service_role; then GRANT per role. Row access only (SELECT, INSERT,
--     UPDATE, DELETE, by column where a column must not move); anon gets nothing.
--     Supabase grants everything in public by default, so a missing REVOKE is an open
--     table.
--   * Functions likewise: REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated,
--     service_role; then GRANT EXECUTE per role. Every function pins SET search_path = ''
--     and schema-qualifies what it touches; SECURITY DEFINER only where it must be.
--   * A FOR ALL policy states both USING and WITH CHECK.
--   * The principals are public.is_owner(), public.get_client_contact_id() and the
--     service role; a role claim in a token grants nothing.
--   * Columns a client must not change: a BEFORE UPDATE trigger running
--     public.enforce_client_column_guard('id', ...the columns...).
--   * Every table a client session can write (a write policy that names
--     get_client_contact_id() or auth.uid(), or does not require is_owner()) carries
--       CREATE TRIGGER trg_impersonation_read_only
--         BEFORE INSERT OR UPDATE OR DELETE ON public.<table>
--         FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();
--   * Storage: each bucket gets its own policies on storage.objects, and every clause of
--     each requires bucket_id = '<that bucket>' at its top level (AND, never OR).
--     storage.objects already carries the MFA gate (0001) and refuses every write from
--     View as client (0002), for all buckets: never add another gate or change those.
--   * A pick-list is a table guarded by public.guard_pick_list(), with the columns key,
--     label, colour, sort_order, is_active and is_system. A list the code depends on in
--     full (stages) passes it the argument 'fixed': guard_pick_list('fixed').
--   * A view is created WITH (security_invoker = true).
--   * No cron schedules in a migration: scheduled work is a row in public.jobs run by the
--     job-runner, or a schedule the adopter sets up outside the migrations.
--

-- ---------------------------------------------------------------------------
-- Address normalization: a database invariant, not a convention
-- ---------------------------------------------------------------------------

-- Every address column here is trimmed (any whitespace, not just spaces) and lower-cased
-- on the way in, the service role included (triggers bind it). One row stored with a
-- capital letter would be unique, invisible to the suppression check and would mail
-- someone who had opted out; with this, an exact-match lookup is a complete one.
CREATE FUNCTION public.normalize_email_address()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.address := lower(regexp_replace(NEW.address, '^\s+|\s+$', '', 'g'));
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Campaigns: one composed message and what became of it
-- ---------------------------------------------------------------------------

CREATE TABLE public.crm_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 50000),
  -- The From actually used, as a record. Built from org_profile and EMAIL_FROM, never
  -- accepted from the caller.
  from_identity text NOT NULL CHECK (char_length(from_identity) BETWEEN 1 AND 400),
  audience_description text CHECK (audience_description IS NULL OR char_length(audience_description) <= 300),
  -- 'sent' means the run COMPLETED (or was closed by replay recovery), not that everything
  -- landed. Only a run that provably delivered nothing is 'failed'.
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  -- THE COUNTERS ARE THE AUTHORITY on what left, not the recipient rows: a row goes with
  -- its contact (D-E3), a counter never does. They move as the run moves, never only at
  -- the end, so a run that dies mid-loop still shows what it handed the provider:
  -- claimed_count rises at each claim (the last step before a provider call), and
  -- sent/failed/unknown at each recorded outcome. A claim with no recorded outcome is a
  -- message in flight, or lost in flight: replay recovery counts it as unknown.
  claimed_count integer NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  unknown_count integer NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- The caller's request identity, one per composition and resent unchanged on every
  -- retry. Its unique index is what stops a double-click or a timeout retry from
  -- creating a second campaign, and so a second delivery. Released (set NULL) only when
  -- a campaign provably delivered nothing and nothing is still running.
  idempotency_key uuid
);

CREATE UNIQUE INDEX uq_crm_email_campaigns_idempotency_key ON public.crm_email_campaigns (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_crm_email_campaigns_created ON public.crm_email_campaigns (created_at DESC, id);

-- ---------------------------------------------------------------------------
-- Recipients: one row per address per campaign, the per-message delivery state
-- ---------------------------------------------------------------------------

CREATE TABLE public.crm_email_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.crm_email_campaigns (id) ON DELETE CASCADE,
  -- Deleted with the contact (decision D-E3): a contact delete must not leave its
  -- address behind on the send log. The campaign's counters keep the totals, and an
  -- opt-out survives because email_suppressions is keyed by address, not by contact.
  -- A send still running when its contact is deleted finds the row gone at its claim
  -- and moves on.
  contact_id uuid REFERENCES public.contacts (id) ON DELETE CASCADE,
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 254),
  -- queued -> sending (the atomic claim) -> sent | failed | skipped | unknown.
  -- 'sending' must be here or every claim fails and nothing ever sends. 'unknown' is
  -- delivery that could not be determined (a worker interrupted after its claim, or a
  -- provider call with no answer): it may have been delivered, so it is never retried
  -- and it keeps the campaign's idempotency key reserved.
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The dedupe boundary: one row per address per campaign. A skip row may therefore never
-- reuse an address already queued.
CREATE UNIQUE INDEX uq_crm_email_recipients_campaign_address ON public.crm_email_recipients (campaign_id, lower(address));
CREATE INDEX idx_crm_email_recipients_contact ON public.crm_email_recipients (contact_id, created_at DESC);

CREATE TRIGGER trg_crm_email_recipients_normalize
  BEFORE INSERT OR UPDATE OF address ON public.crm_email_recipients
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_address();

-- ---------------------------------------------------------------------------
-- Suppressions: addresses that must never receive a group email
-- ---------------------------------------------------------------------------

CREATE TABLE public.email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL UNIQUE CHECK (char_length(address) BETWEEN 3 AND 254 AND address = lower(address)),
  reason text NOT NULL DEFAULT 'unsubscribed' CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
  source text NOT NULL DEFAULT 'unsubscribe_link' CHECK (char_length(source) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_email_suppressions_normalize
  BEFORE INSERT OR UPDATE OF address ON public.email_suppressions
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_address();

-- ---------------------------------------------------------------------------
-- Unsubscribe tokens: the capability in each email's unsubscribe link
-- ---------------------------------------------------------------------------

CREATE TABLE public.email_unsubscribe_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 (hex) of 32 random bytes. The token itself is never stored or logged.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 254),
  campaign_id uuid REFERENCES public.crm_email_campaigns (id) ON DELETE SET NULL,
  -- A retention marker for a future cleanup, NEVER an access check: a delivered email
  -- must not lose its unsubscribe link on a date while it is still in an inbox, and a
  -- token can only ever suppress its own address, so age adds no risk to bound.
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_unsubscribe_tokens_campaign ON public.email_unsubscribe_tokens (campaign_id);

CREATE TRIGGER trg_email_unsubscribe_tokens_normalize
  BEFORE INSERT OR UPDATE OF address ON public.email_unsubscribe_tokens
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_address();

-- ---------------------------------------------------------------------------
-- The send, as server RPCs (crm-send-group-email). SECURITY INVOKER: they run as the
-- service role with its grants below, and no session may call them.
-- ---------------------------------------------------------------------------

-- Writes a whole campaign in ONE transaction: the campaign row, a queued row per
-- recipient, the skip rows and one unsubscribe token per recipient. All or nothing, so
-- no campaign can exist with a reserved key and no recipients, and no recipient can be
-- queued without a working unsubscribe link (a bulk email without one does not go out).
-- Returns NULL when the idempotency key is already taken: the caller replays it.
CREATE FUNCTION public.group_email_begin(
  p_idempotency_key uuid,
  p_created_by uuid,
  p_subject text,
  p_body text,
  p_from_identity text,
  p_audience_description text,
  p_recipients jsonb,
  p_skips jsonb,
  p_tokens jsonb,
  p_skipped_count integer)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'group_email_begin: an idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' OR jsonb_array_length(p_recipients) = 0
     OR jsonb_typeof(p_tokens) IS DISTINCT FROM 'array'
     OR jsonb_typeof(COALESCE(p_skips, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'group_email_begin: recipients, tokens and skips must be arrays' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.crm_email_campaigns (
    subject, body, from_identity, audience_description, status, recipient_count, skipped_count,
    created_by, idempotency_key)
  VALUES (
    p_subject, p_body, p_from_identity, p_audience_description, 'sending', jsonb_array_length(p_recipients),
    GREATEST(COALESCE(p_skipped_count, 0), 0), p_created_by, p_idempotency_key)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.crm_email_recipients (campaign_id, contact_id, address, status)
  SELECT v_id, (r ->> 'contact_id')::uuid, r ->> 'address', 'queued'
  FROM jsonb_array_elements(p_recipients) AS r;

  INSERT INTO public.crm_email_recipients (campaign_id, contact_id, address, status, error)
  SELECT v_id, (s ->> 'contact_id')::uuid, s ->> 'address', 'skipped', left(s ->> 'reason', 500)
  FROM jsonb_array_elements(COALESCE(p_skips, '[]'::jsonb)) AS s;

  INSERT INTO public.email_unsubscribe_tokens (token_hash, address, campaign_id, expires_at)
  SELECT t ->> 'token_hash', t ->> 'address', v_id, now() + interval '90 days'
  FROM jsonb_array_elements(p_tokens) AS t;

  IF EXISTS (
    SELECT 1 FROM public.crm_email_recipients r
    WHERE r.campaign_id = v_id AND r.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM public.email_unsubscribe_tokens t
        WHERE t.campaign_id = v_id AND t.address = r.address)
  ) THEN
    RAISE EXCEPTION 'group_email_begin: every recipient needs an unsubscribe token' USING ERRCODE = '22023';
  END IF;

  RETURN v_id;
END;
$$;

-- The answer to a repeated idempotency key. Decided in one transaction, under a lock on
-- the campaign row. The send function asks this FIRST, before its rate limit and before
-- it re-reads the audience, so a retry always gets its original report.
--   * A campaign whose worker cannot still be running (it failed, or it is older than 15
--     minutes, well past the platform's wall clock) and never finished is CLOSED here:
--     every 'sending' row is restated as 'unknown', never 'failed' ('failed' would release
--     the key and let a message the provider had already accepted go out a second time),
--     every claim with no recorded outcome is counted as unknown, and the campaign gets
--     its final status and sent_at, so the pages show true totals and the unknown warning.
--     Never resumed automatically: after a partial delivery a person decides.
--   * The key is released ('released') only when the worker cannot still be running AND
--     the COUNTERS show nothing sent, nothing unknown and no claim without a failure. The
--     recipient rows are not enough: deleting a contact deletes its rows, and a released
--     key would let the retry mail the same address again (another contact sharing it).
--     Without the age arm a genuine double-click, whose first request is alive and has
--     not claimed anyone yet, would look dead and be sent twice.
--   * Otherwise the report ('duplicate'): the larger of each counter and its row count.
CREATE FUNCTION public.group_email_replay(p_idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_campaign public.crm_email_campaigns%ROWTYPE;
  v_dead boolean;
  v_live integer;
BEGIN
  SELECT * INTO v_campaign FROM public.crm_email_campaigns
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;

  v_dead := v_campaign.status = 'failed' OR v_campaign.created_at < now() - interval '15 minutes';

  IF v_dead THEN
    UPDATE public.crm_email_recipients
    SET status = 'unknown', error = 'interrupted; delivery unknown'
    WHERE campaign_id = v_campaign.id AND status = 'sending';

    IF v_campaign.status = 'sending' THEN
      UPDATE public.crm_email_campaigns c
      SET unknown_count = GREATEST(c.unknown_count, c.claimed_count - c.sent_count - c.failed_count),
          skipped_count = GREATEST(c.skipped_count,
            (SELECT count(*) FROM public.crm_email_recipients r WHERE r.campaign_id = c.id AND r.status = 'skipped')::integer),
          sent_at = COALESCE(c.sent_at, now())
      WHERE c.id = v_campaign.id
      RETURNING * INTO v_campaign;
      UPDATE public.crm_email_campaigns c
      SET status = CASE WHEN c.sent_count = 0 AND c.unknown_count = 0 THEN 'failed' ELSE 'sent' END
      WHERE c.id = v_campaign.id
      RETURNING * INTO v_campaign;
    END IF;
  END IF;

  SELECT count(*) INTO v_live FROM public.crm_email_recipients
  WHERE campaign_id = v_campaign.id AND status IN ('sent', 'sending', 'unknown');

  IF v_dead AND v_live = 0 AND v_campaign.sent_count = 0 AND v_campaign.unknown_count = 0
     AND v_campaign.claimed_count <= v_campaign.failed_count THEN
    UPDATE public.crm_email_campaigns SET idempotency_key = NULL WHERE id = v_campaign.id;
    RETURN jsonb_build_object('outcome', 'released');
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'outcome', 'duplicate',
      'campaign_id', v_campaign.id,
      'sent', GREATEST(count(*) FILTER (WHERE r.status = 'sent'), v_campaign.sent_count),
      'failed', GREATEST(count(*) FILTER (WHERE r.status = 'failed'), v_campaign.failed_count),
      'skipped', GREATEST(count(*) FILTER (WHERE r.status = 'skipped'), v_campaign.skipped_count),
      'unknown', GREATEST(count(*) FILTER (WHERE r.status = 'unknown'), v_campaign.unknown_count),
      'unsent', count(*) FILTER (WHERE r.status IN ('queued', 'sending')),
      'still_running', NOT v_dead)
    FROM public.crm_email_recipients r
    WHERE r.campaign_id = v_campaign.id);
END;
$$;

-- The per-message claim, and the LAST database call before the provider. Flips one row
-- queued -> sending (only the worker that wins the flip may send; a concurrent request,
-- or a row deleted with its contact, finds nothing and moves on: 'gone'), then checks
-- again, as of now, everything that decides whether this person may be mailed:
--   * the contact's status, against p_emailable (the send function passes its
--     EMAILABLE_STATUSES, pinned to src/lib/contactStatus.ts by a parity test), so a
--     contact marked lost mid-run is not mailed: 'ineligible', the row skipped;
--   * the suppression list, so an unsubscribe that lands mid-run is honoured:
--     'suppressed', the row skipped.
-- Only then does the claim count ('claimed_count'). The residual window is the one
-- provider call; no provider offers a two-phase commit.
CREATE FUNCTION public.group_email_claim(p_campaign_id uuid, p_address text, p_emailable text[])
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_address text := lower(regexp_replace(COALESCE(p_address, ''), '^\s+|\s+$', '', 'g'));
  v_id uuid;
  v_contact uuid;
  v_status text;
BEGIN
  UPDATE public.crm_email_recipients
  SET status = 'sending'
  WHERE campaign_id = p_campaign_id AND lower(address) = v_address AND status = 'queued'
  RETURNING id, contact_id INTO v_id, v_contact;
  IF v_id IS NULL THEN
    RETURN 'gone';
  END IF;

  SELECT c.status INTO v_status FROM public.contacts c WHERE c.id = v_contact;
  IF v_status IS NULL OR p_emailable IS NULL OR NOT (v_status = ANY (p_emailable)) THEN
    UPDATE public.crm_email_recipients
    SET status = 'skipped', error = left(COALESCE('status ' || v_status, 'contact deleted'), 500)
    WHERE id = v_id;
    RETURN 'ineligible';
  END IF;

  IF EXISTS (SELECT 1 FROM public.email_suppressions s WHERE s.address = v_address) THEN
    UPDATE public.crm_email_recipients SET status = 'skipped', error = 'unsubscribed' WHERE id = v_id;
    RETURN 'suppressed';
  END IF;

  UPDATE public.crm_email_campaigns SET claimed_count = claimed_count + 1 WHERE id = p_campaign_id;
  RETURN 'claimed';
END;
$$;

-- One message's outcome. sent, failed and unknown only follow a claim ('sending'); a
-- skip may also close a row that was never claimed. A provider outcome moves its campaign
-- counter in the same statement, also when the row has gone with its contact since the
-- claim (the message still left); an outcome already recorded never counts twice.
CREATE FUNCTION public.group_email_record(
  p_campaign_id uuid, p_address text, p_status text, p_provider_message_id text, p_error text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_address text := lower(regexp_replace(COALESCE(p_address, ''), '^\s+|\s+$', '', 'g'));
  v_updated integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent', 'failed', 'unknown', 'skipped') THEN
    RAISE EXCEPTION 'group_email_record: not an outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE public.crm_email_recipients
  SET status = p_status,
      provider_message_id = CASE WHEN p_status = 'sent' THEN left(p_provider_message_id, 200) END,
      sent_at = CASE WHEN p_status = 'sent' THEN now() END,
      error = left(p_error, 500)
  WHERE campaign_id = p_campaign_id
    AND lower(address) = v_address
    AND status = ANY (CASE WHEN p_status = 'skipped' THEN ARRAY['queued', 'sending'] ELSE ARRAY['sending'] END);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF p_status <> 'skipped' AND (v_updated > 0 OR NOT EXISTS (
       SELECT 1 FROM public.crm_email_recipients
       WHERE campaign_id = p_campaign_id AND lower(address) = v_address)) THEN
    UPDATE public.crm_email_campaigns
    SET sent_count = sent_count + (p_status = 'sent')::integer,
        failed_count = failed_count + (p_status = 'failed')::integer,
        unknown_count = unknown_count + (p_status = 'unknown')::integer
    WHERE id = p_campaign_id;
  END IF;
END;
$$;

-- The end of a run: the campaign's status, and the counters, which never go down (they
-- already moved with each claim and outcome; the run's own tally covers an outcome whose
-- record failed).
CREATE FUNCTION public.group_email_finish(
  p_campaign_id uuid, p_sent integer, p_failed integer, p_unknown integer, p_skipped integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.crm_email_campaigns
  SET sent_count = GREATEST(sent_count, p_sent, 0),
      failed_count = GREATEST(failed_count, p_failed, 0),
      unknown_count = GREATEST(unknown_count, p_unknown, 0),
      skipped_count = GREATEST(skipped_count, p_skipped, 0),
      status = CASE WHEN GREATEST(failed_count, p_failed) > 0 AND GREATEST(sent_count, p_sent) = 0
                     AND GREATEST(unknown_count, p_unknown) = 0 THEN 'failed' ELSE 'sent' END,
      sent_at = now()
  WHERE id = p_campaign_id AND status = 'sending';
END;
$$;

-- ---------------------------------------------------------------------------
-- The opt-out, as server RPCs (email-unsubscribe). The token's hash is the only input.
-- Malformed and unknown read the same ('invalid'); a repeat reads 'unsubscribed'.
-- ---------------------------------------------------------------------------

-- GET: asks, never acts. Link scanners and mail clients prefetch every URL in a message.
CREATE FUNCTION public.email_unsubscribe_lookup(p_token_hash text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN t.used_at IS NULL THEN 'confirm' ELSE 'unsubscribed' END
     FROM public.email_unsubscribe_tokens t WHERE t.token_hash = p_token_hash),
    'invalid');
$$;

-- POST: suppresses the token's address (a repeat is a no-op that still succeeds), then
-- stamps the token, last.
CREATE FUNCTION public.email_unsubscribe_confirm(p_token_hash text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_token public.email_unsubscribe_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.email_unsubscribe_tokens WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;
  INSERT INTO public.email_suppressions (address, reason, source)
  VALUES (v_token.address, 'unsubscribed', 'unsubscribe_link')
  ON CONFLICT (address) DO NOTHING;
  UPDATE public.email_unsubscribe_tokens SET used_at = now() WHERE id = v_token.id AND used_at IS NULL;
  RETURN 'unsubscribed';
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.crm_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_email_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;

-- The owner reads the send log and the suppression list. No write policy on any of them,
-- and none at all on the tokens.
CREATE POLICY crm_email_campaigns_owner_select ON public.crm_email_campaigns
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY crm_email_recipients_owner_select ON public.crm_email_recipients
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));
CREATE POLICY email_suppressions_owner_select ON public.email_suppressions
  FOR SELECT TO authenticated USING ((SELECT public.is_owner()));

CREATE POLICY crm_email_campaigns_mfa_gate ON public.crm_email_campaigns AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY crm_email_recipients_mfa_gate ON public.crm_email_recipients AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY email_suppressions_mfa_gate ON public.email_suppressions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY email_unsubscribe_tokens_mfa_gate ON public.email_unsubscribe_tokens AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON
  public.crm_email_campaigns, public.crm_email_recipients, public.email_suppressions,
  public.email_unsubscribe_tokens
FROM PUBLIC, anon, authenticated, service_role;

-- The server: what the RPCs above and the two functions use. No UPDATE or DELETE on
-- suppressions for anyone: an opt-out is removed only by hand, by the database owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_email_campaigns, public.crm_email_recipients,
  public.email_unsubscribe_tokens TO service_role;
GRANT SELECT, INSERT ON public.email_suppressions TO service_role;

-- A signed-in session: reads only, and the policies above admit the owner alone.
GRANT SELECT ON public.crm_email_campaigns, public.crm_email_recipients, public.email_suppressions TO authenticated;

REVOKE ALL ON FUNCTION
  public.normalize_email_address(),
  public.group_email_begin(uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer),
  public.group_email_replay(uuid),
  public.group_email_claim(uuid, text, text[]),
  public.group_email_record(uuid, text, text, text, text),
  public.group_email_finish(uuid, integer, integer, integer, integer),
  public.email_unsubscribe_lookup(text),
  public.email_unsubscribe_confirm(text)
FROM PUBLIC, anon, authenticated, service_role;

-- The trigger function needs no grant: a trigger runs whoever fires it.
GRANT EXECUTE ON FUNCTION
  public.group_email_begin(uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer),
  public.group_email_replay(uuid),
  public.group_email_claim(uuid, text, text[]),
  public.group_email_record(uuid, text, text, text, text),
  public.group_email_finish(uuid, integer, integer, integer, integer),
  public.email_unsubscribe_lookup(text),
  public.email_unsubscribe_confirm(text)
TO service_role;
