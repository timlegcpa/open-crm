-- 0004_messages: secure messages between the owner and a client.
--
-- Belongs here: client_messages (encrypted to the organization's key, with a key_id on
-- every message so a later multi-staff key model need not break the schema), the
-- organization's key table (organization_keys) and get_org_public_key(),
-- admin_list_conversations(), and client_messages in the supabase_realtime publication.
--
-- Depends on: 0001_core, 0002_contacts.
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
-- The encryption model. A client's message is encrypted in the client's browser to the
-- organization's public key (RSA-OAEP 4096 wraps a fresh AES-256-GCM key, which encrypts
-- the body) and stored as ciphertext only; the server never sees its text. The owner's
-- private key is stored here wrapped (AES-GCM) under a key derived from the owner's
-- encryption password (PBKDF2-SHA-256, 600,000 rounds), and is unwrapped in the owner's
-- browser for one page session. The owner's replies are NOT end-to-end encrypted: clients
-- hold no keypair, so a reply is stored as plain text, readable by the server like any
-- other row. Neither side's browser ever writes plaintext back: a client cannot reread its
-- own earlier messages once it leaves the page.
--
-- Retention: a message is deleted for good 7 days after it is read, in either direction
-- (cleanup_read_client_messages(), run by the server on a schedule set up outside the
-- migrations). Unread messages are kept.

-- ---------------------------------------------------------------------------
-- organization_keys: the owner's message key. Its id is the key_id on every client
-- message. One row per owner; the public key never changes once written (a password
-- change or a recovery re-wraps the same private key), so a client's cached public key
-- can never go stale.
--
-- No DELETE for anyone but the server, and owner_user_id is RESTRICT: a key removed
-- before the messages encrypted to it would make them unreadable for good.
-- ---------------------------------------------------------------------------

CREATE TABLE public.organization_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE RESTRICT,
  -- The RSA-OAEP public key as a JWK, JSON text.
  public_key text NOT NULL CHECK (char_length(public_key) BETWEEN 100 AND 4000),
  -- The pkcs8 private key, AES-GCM wrapped, base64.
  encrypted_private_key text NOT NULL CHECK (char_length(encrypted_private_key) BETWEEN 100 AND 8000),
  -- 16 random bytes and a 12-byte IV, base64.
  key_salt text NOT NULL CHECK (char_length(key_salt) = 24),
  key_iv text NOT NULL CHECK (char_length(key_iv) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_organization_keys_updated_at
  BEFORE UPDATE ON public.organization_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Every key write is audited here, so a skipped browser call cannot skip the record. Only
-- the key id is recorded, never key material. The caller's own rights: the owner may
-- insert audit rows for itself, and the server writes as the system actor.
CREATE FUNCTION public.audit_organization_key_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (
    public.audit_actor(),
    CASE TG_OP WHEN 'INSERT' THEN 'messages_key_created' ELSE 'messages_key_rewrapped' END,
    jsonb_build_object('key_id', NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_organization_keys_audit_insert
  AFTER INSERT ON public.organization_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_organization_key_write();
CREATE TRIGGER trg_organization_keys_audit_rewrap
  AFTER UPDATE OF encrypted_private_key, key_salt, key_iv ON public.organization_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_organization_key_write();

-- ---------------------------------------------------------------------------
-- client_messages: one conversation per contact.
--
-- A client's row is ciphertext only, encrypted to a key_id; an owner's row is plain text
-- only (the shape CHECK). sender_id is SET NULL on delete: the server removes a contact's
-- sign-in users before its rows, and a delete that fails between the two must not take
-- the messages the client sent with it. A contact's delete removes its messages.
--
-- The length bounds follow the browser's limits: a body is at most 10,000 UTF-16 units,
-- so at most 30,000 UTF-8 bytes; with the 16-byte GCM tag that is 40,024 base64
-- characters (24 for a 1-byte body). RSA-OAEP output is the modulus length, 512 bytes for
-- RSA-4096, so 684 characters. A 12-byte IV is 16.
-- ---------------------------------------------------------------------------

CREATE TABLE public.client_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  sender_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  sender_role text NOT NULL CHECK (sender_role IN ('owner', 'client')),
  body text CHECK (body IS NULL OR (char_length(body) <= 10000 AND btrim(body) <> '')),
  is_encrypted boolean NOT NULL DEFAULT false,
  encrypted_body text CHECK (encrypted_body IS NULL OR char_length(encrypted_body) BETWEEN 24 AND 40024),
  encrypted_key text CHECK (encrypted_key IS NULL OR char_length(encrypted_key) = 684),
  encryption_iv text CHECK (encryption_iv IS NULL OR char_length(encryption_iv) = 16),
  key_id uuid REFERENCES public.organization_keys (id) ON DELETE RESTRICT,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_messages_shape CHECK (
    (sender_role = 'client' AND is_encrypted AND body IS NULL AND encrypted_body IS NOT NULL
       AND encrypted_key IS NOT NULL AND encryption_iv IS NOT NULL AND key_id IS NOT NULL)
    OR
    (sender_role = 'owner' AND NOT is_encrypted AND body IS NOT NULL AND encrypted_body IS NULL
       AND encrypted_key IS NULL AND encryption_iv IS NULL AND key_id IS NULL)
  )
);

CREATE INDEX idx_client_messages_contact_created ON public.client_messages (contact_id, created_at, id);
CREATE INDEX idx_client_messages_read_at ON public.client_messages (read_at) WHERE read_at IS NOT NULL;
CREATE INDEX idx_client_messages_sender ON public.client_messages (sender_id);
CREATE INDEX idx_client_messages_key ON public.client_messages (key_id);

-- The organization's current message key, for any signed-in principal: the owner's key,
-- bound to org_profile.owner_user_id (never to a role claim), the oldest if there were
-- ever two, so a second row can never redirect a client's messages to a key the owner
-- does not hold. A definer because clients have no access to the key table at all: the
-- wrapped private key and its salt would let anyone guess the encryption password
-- offline. Null when no key exists yet, or for a caller who is neither owner nor client.
CREATE FUNCTION public.get_org_public_key()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('key_id', k.id, 'public_key', k.public_key)
  FROM public.organization_keys k
  JOIN public.org_profile o ON o.owner_user_id = k.owner_user_id
  WHERE public.is_owner() OR public.get_client_contact_id() IS NOT NULL
  ORDER BY k.created_at, k.id
  LIMIT 1;
$$;

-- A client's message carries no caller-chosen time or read state, and is encrypted to the
-- organization's current key: the foreign key only proves a key exists. The owner and the
-- server write as they choose.
CREATE FUNCTION public.stamp_client_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF public.is_owner_or_server() THEN
    RETURN NEW;
  END IF;

  IF NEW.key_id IS DISTINCT FROM (public.get_org_public_key() ->> 'key_id')::uuid THEN
    RAISE EXCEPTION 'A message must be encrypted to the current key'
      USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
  NEW.read_at := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_messages_stamp
  BEFORE INSERT ON public.client_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_client_message_insert();

-- read_at is the server's clock, never the caller's: the retention sweep deletes a message
-- 7 days after it, so a chosen time would delete a message early (backdated) or keep it
-- forever (far future, or reset to unread). For anyone but the server, marking read
-- stamps now(), and a message once read stays read at its first time. This holds for the
-- owner too.
CREATE FUNCTION public.stamp_client_message_read()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF COALESCE((SELECT r.rolsuper OR r.rolbypassrls
                 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
  NEW.read_at := COALESCE(OLD.read_at, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_messages_read_stamp
  BEFORE UPDATE OF read_at ON public.client_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_client_message_read();

-- Only read_at moves for a client. id is listed too: without it a client could renumber
-- its own rows. A trigger, never a self-referencing WITH CHECK (that recursed).
CREATE TRIGGER trg_client_messages_column_guard
  BEFORE UPDATE ON public.client_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_column_guard(
    'id', 'contact_id', 'sender_id', 'sender_role', 'body', 'is_encrypted',
    'encrypted_body', 'encrypted_key', 'encryption_iv', 'key_id', 'created_at');

-- View as client reads the conversation but writes nothing here.
CREATE TRIGGER trg_impersonation_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.client_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();

-- The owner's inbox: one entry per contact with messages, newest activity first, as one
-- JSON array (a set-returning RPC would be cut at PostgREST's row cap without a word).
-- An aggregate on the server: a list built from the latest N messages drops whole
-- conversations. The caller's own rights, so RLS applies as well as the owner check.
-- Ties on time fall to the higher id, so the same data always gives the same answer.
CREATE FUNCTION public.admin_list_conversations()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH stats AS (
      SELECT cm.contact_id,
             count(*)::int AS message_count,
             (count(*) FILTER (WHERE cm.sender_role = 'client' AND cm.read_at IS NULL))::int AS unread_count
      FROM public.client_messages cm
      GROUP BY cm.contact_id
    ), last_msg AS (
      SELECT DISTINCT ON (cm.contact_id)
             cm.contact_id, cm.id, cm.body, cm.created_at, cm.sender_role
      FROM public.client_messages cm
      ORDER BY cm.contact_id, cm.created_at DESC, cm.id DESC
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'contact_id', s.contact_id,
             'full_name', c.full_name,
             'business_name', c.business_name,
             'email', c.email,
             'last_message_id', m.id,
             'last_message_body', m.body,
             'last_message_at', m.created_at,
             'last_message_sender_role', m.sender_role,
             'unread_count', s.unread_count,
             'message_count', s.message_count)
           ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb)
    FROM stats s
    JOIN last_msg m ON m.contact_id = s.contact_id
    LEFT JOIN public.contacts c ON c.id = s.contact_id
  );
END;
$$;

-- Server only: delete every message read more than 7 days ago, in either direction.
-- Returns how many went. The caller's own rights: the server holds DELETE.
CREATE FUNCTION public.cleanup_read_client_messages()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.client_messages
   WHERE read_at IS NOT NULL
     AND read_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.organization_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_messages ENABLE ROW LEVEL SECURITY;

-- The key: the owner's own row only. No client policy at all (clients read the public
-- half through get_org_public_key()), and no DELETE policy.
CREATE POLICY organization_keys_owner_select ON public.organization_keys
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) AND owner_user_id = (SELECT auth.uid()));
CREATE POLICY organization_keys_owner_insert ON public.organization_keys
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_owner()) AND owner_user_id = (SELECT auth.uid()));
CREATE POLICY organization_keys_owner_update ON public.organization_keys
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()) AND owner_user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT public.is_owner()) AND owner_user_id = (SELECT auth.uid()));

-- Messages. Each side writes only as itself: the owner as the owner, a client as itself
-- on its own contact. Each side marks only the OTHER side's messages read, and only the
-- owner deletes.
CREATE POLICY client_messages_select ON public.client_messages
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
CREATE POLICY client_messages_insert ON public.client_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    ((SELECT public.is_owner()) AND sender_role = 'owner' AND sender_id = (SELECT auth.uid()))
    OR (contact_id = (SELECT public.get_client_contact_id()) AND sender_role = 'client'
        AND sender_id = (SELECT auth.uid()))
  );
CREATE POLICY client_messages_update ON public.client_messages
  FOR UPDATE TO authenticated
  USING (((SELECT public.is_owner()) AND sender_role = 'client')
         OR (contact_id = (SELECT public.get_client_contact_id()) AND sender_role = 'owner'))
  WITH CHECK (((SELECT public.is_owner()) AND sender_role = 'client')
              OR (contact_id = (SELECT public.get_client_contact_id()) AND sender_role = 'owner'));
CREATE POLICY client_messages_owner_delete ON public.client_messages
  FOR DELETE TO authenticated
  USING ((SELECT public.is_owner()));

CREATE POLICY organization_keys_mfa_gate ON public.organization_keys
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY client_messages_mfa_gate ON public.client_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- Live updates: without this the browsers' subscriptions to new messages never fire.
-- Subscribers only refetch; RLS decides what each reads.
ALTER PUBLICATION supabase_realtime ADD TABLE public.client_messages;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.organization_keys, public.client_messages
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_keys, public.client_messages TO service_role;

-- Signed-in sessions, by column: a key's public half and owner never change after it is
-- written, and only the wrap moves; a message is written whole once, and only read_at
-- moves after that.
GRANT SELECT ON public.organization_keys TO authenticated;
GRANT INSERT (owner_user_id, public_key, encrypted_private_key, key_salt, key_iv)
  ON public.organization_keys TO authenticated;
GRANT UPDATE (encrypted_private_key, key_salt, key_iv) ON public.organization_keys TO authenticated;

GRANT SELECT, DELETE ON public.client_messages TO authenticated;
GRANT INSERT (contact_id, sender_id, sender_role, body, is_encrypted, encrypted_body,
              encrypted_key, encryption_iv, key_id)
  ON public.client_messages TO authenticated;
GRANT UPDATE (read_at) ON public.client_messages TO authenticated;

-- Functions created in this file only (a sweep of the schema would strip the grants
-- 0001 and 0002 made). Trigger functions need no EXECUTE grant: Postgres checks it when
-- the trigger is created, not when it fires.
REVOKE ALL ON FUNCTION
  public.audit_organization_key_write(),
  public.get_org_public_key(),
  public.stamp_client_message_insert(),
  public.stamp_client_message_read(),
  public.admin_list_conversations(),
  public.cleanup_read_client_messages()
FROM PUBLIC, anon, authenticated, service_role;

-- Signed-in sessions: the public key (owner and client; the stamp trigger asks it too)
-- and the owner's inbox (which refuses anyone else).
GRANT EXECUTE ON FUNCTION public.get_org_public_key(), public.admin_list_conversations() TO authenticated;
-- The server: the retention sweep (a schedule outside the migrations calls it).
GRANT EXECUTE ON FUNCTION public.cleanup_read_client_messages() TO service_role;
