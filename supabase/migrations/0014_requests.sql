-- 0014_requests: requests close themselves, and the upload notice waits a day.
--
-- Runs once on top of 0001 to 0012. 0005_requests may already be applied on a project, so
-- nothing there is edited: this file replaces one function, adds one more with its two
-- triggers, closes the lists that were already finished before it ran, and adds the
-- guarded write a client's contact confirmation goes through.
--
-- 1. The upload notice (needs_claim_upload_notice): the owner hears about uploads to a
--    request at most once per list per 24 hours, no longer once per 30 minutes. A client
--    who uploads in bursts over an hour sent one email per burst; the Submit email still
--    marks the end. (0005's comments on upload_notified_at still say 30 minutes; this
--    function is the rule.) The edge function keeps a claim when delivery is unknown and
--    gives it back only when the provider refused the message.
--
-- 2. A request closes on its own once there is nothing left to do on it, so the owner
--    never has to close a finished list by hand. Close by hand stays, for a list the
--    client will not finish. The rule, in needs_autoclose_list():
--      a sent or submitted list with at least one actionable item (kind <> 'info', the
--      rule of isActionable in src/features/requests/lib/requests.ts) closes when
--        * no answered item waits to be accepted (status 'fulfilled'), and
--        * the client owes nothing: on a sent list no item is pending; once submitted, no
--          required item is (submit is refused while one is, so that is belt and braces), and
--        * a sent list does not still ask the client to confirm their details. Nothing
--          records that a client confirmed (confirming without a change never reaches the
--          server), so a sent list with the confirmation switched on waits for the client to
--          submit: handing the list back is what says they are done with it, confirmation
--          included. Without this, accepting the last answer would close the list under a
--          client who was still on the confirmation step.
--    It runs when an item becomes accepted ('reviewed'), whichever path accepted it (the
--    owner's Accept or Accept all, the AI connector, the server), and when a list becomes
--    submitted (a client handing back a list whose required answers were all accepted
--    already, with optional items left blank). One trigger per table, so no path is missed.
--
--    It LOCKS THE LIST ROW FIRST. Two accepts at once on one list would otherwise each read
--    the other's item as still answered before it committed, and neither would close the
--    list. With the lock, the second waits for the first, then reads every item afresh.
--
--    Why it never reopens a list, and never runs on an item becoming answered: every client
--    write (needs_client_set_answer, _mark_todo, _link_document) takes a share lock on the
--    list and refuses anything but 'sent', so an item cannot become answered on a list that
--    is closing or closed, and a close that waits for that lock then sees the new answer
--    and leaves the list open. Running this on an answer as well would make two uploads to
--    one list at once each hold the share lock and wait for the other's update lock.
--
--    Lock order, written out because PGlite runs one connection and cannot test it: an
--    accept holds its item row, then takes the list here; a client write holds the list
--    (shared), then takes its item. An owner accepting an item at the same instant the
--    client writes to that same item can therefore deadlock; Postgres aborts one of the two
--    and it reports a failure to retry, which beats a wrong status that reports success.
--
--    SECURITY INVOKER: everyone who can accept an item (the owner under RLS, the server)
--    can already update the list, and the row lock needs exactly that privilege. An owner
--    could move an accepted item back to answered through the API (the screens never do);
--    nothing here reopens the list for it.
--
-- 3. Lists already finished when this runs are closed once, by the same rule, so an
--    upgraded project does not keep old finished lists open forever. Closing one expires
--    its start links, as a close by hand does (0005, trg_needs_lists_expire_start_links_close).
--
-- 4. A client confirming their details (needs-save save_contact) goes through one function,
--    needs_client_save_contact, which takes the same share lock on the list as every other
--    client write and checks the list is sent and asks for the confirmation, in the same
--    transaction as the contact update. Before, the edge function read the list, then
--    updated the contact in a second call, so a close landing in between let the save write
--    to a request that was already closed.

-- ---------------------------------------------------------------------------
-- 1. The upload notice: at most once per list per 24 hours
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.needs_claim_upload_notice(p_list_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_stamp timestamptz;
BEGIN
  UPDATE public.needs_lists l
     SET upload_notified_at = clock_timestamp()
   WHERE l.id = p_list_id
     AND (l.upload_notified_at IS NULL OR l.upload_notified_at < clock_timestamp() - interval '24 hours')
  RETURNING l.upload_notified_at INTO v_stamp;
  RETURN v_stamp;
END;
$$;

-- CREATE OR REPLACE keeps 0005's privileges; restated so this file reads alone.
REVOKE ALL ON FUNCTION public.needs_claim_upload_notice(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.needs_claim_upload_notice(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. A request closes itself once nothing is left to do
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.needs_autoclose_list()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_list uuid;
  v_status text;
  v_confirm boolean;
BEGIN
  IF TG_TABLE_NAME = 'needs_lists' THEN
    v_list := NEW.id;
  ELSE
    v_list := NEW.list_id;
  END IF;

  -- The lock first (see the header): every reconcile of one list runs one at a time, and
  -- each statement below reads the items as the one before it committed them.
  SELECT l.status, l.include_contact_confirm INTO v_status, v_confirm
    FROM public.needs_lists l WHERE l.id = v_list FOR UPDATE;
  IF NOT FOUND OR v_status NOT IN ('sent', 'submitted') THEN
    RETURN NULL;
  END IF;
  -- Still asking the client to confirm their details: wait for the submit (see the header).
  IF v_status = 'sent' AND v_confirm THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.needs_items i WHERE i.list_id = v_list AND i.kind <> 'info')
     AND NOT EXISTS (
       SELECT 1 FROM public.needs_items i
        WHERE i.list_id = v_list
          AND i.kind <> 'info'
          AND (i.status = 'fulfilled'
               OR (i.status = 'pending' AND (v_status = 'sent' OR i.required)))) THEN
    UPDATE public.needs_lists l SET status = 'closed', closed_at = now() WHERE l.id = v_list;
  END IF;
  RETURN NULL;
END;
$$;

-- A trigger function: nobody calls it.
REVOKE ALL ON FUNCTION public.needs_autoclose_list() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_needs_items_autoclose
  AFTER UPDATE OF status ON public.needs_items
  FOR EACH ROW
  WHEN (NEW.status = 'reviewed' AND OLD.status IS DISTINCT FROM 'reviewed')
  EXECUTE FUNCTION public.needs_autoclose_list();

CREATE TRIGGER trg_needs_lists_autoclose
  AFTER UPDATE OF status ON public.needs_lists
  FOR EACH ROW
  WHEN (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted')
  EXECUTE FUNCTION public.needs_autoclose_list();

-- ---------------------------------------------------------------------------
-- 3. Close the lists that were already finished
-- ---------------------------------------------------------------------------

UPDATE public.needs_lists l
   SET status = 'closed', closed_at = now()
 WHERE l.status IN ('sent', 'submitted')
   AND NOT (l.status = 'sent' AND l.include_contact_confirm)
   AND EXISTS (SELECT 1 FROM public.needs_items i WHERE i.list_id = l.id AND i.kind <> 'info')
   AND NOT EXISTS (
     SELECT 1 FROM public.needs_items i
      WHERE i.list_id = l.id
        AND i.kind <> 'info'
        AND (i.status = 'fulfilled'
             OR (i.status = 'pending' AND (l.status = 'sent' OR i.required))));

-- ---------------------------------------------------------------------------
-- 4. A client's contact confirmation, guarded and locked like every other client write
-- ---------------------------------------------------------------------------

-- Write the fields a request asks the client to confirm, only while the list is the
-- contact's own, sent, and asks for the confirmation. The share lock on the list holds off
-- a close until this commits, and a close that won the race is seen here and refused.
-- The edge function validates and trims the values first; this takes only the keys it
-- knows and refuses any other. Returns saved, not_found or not_open.
CREATE FUNCTION public.needs_client_save_contact(p_contact_id uuid, p_list_id uuid, p_fields jsonb)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_confirm boolean;
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_fields) k
                 WHERE k NOT IN ('first_name', 'last_name', 'phone', 'business_name', 'spouse_first_name', 'spouse_last_name')) THEN
    RAISE EXCEPTION 'needs_client_save_contact: unknown field' USING ERRCODE = '22023';
  END IF;
  SELECT l.status, l.include_contact_confirm INTO v_status, v_confirm
    FROM public.needs_lists l
   WHERE l.id = p_list_id AND l.contact_id = p_contact_id
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_status <> 'sent' OR NOT v_confirm THEN
    RETURN 'not_open';
  END IF;
  UPDATE public.contacts c
     SET first_name = CASE WHEN p_fields ? 'first_name' THEN p_fields ->> 'first_name' ELSE c.first_name END,
         last_name = CASE WHEN p_fields ? 'last_name' THEN p_fields ->> 'last_name' ELSE c.last_name END,
         phone = CASE WHEN p_fields ? 'phone' THEN p_fields ->> 'phone' ELSE c.phone END,
         business_name = CASE WHEN p_fields ? 'business_name' THEN p_fields ->> 'business_name' ELSE c.business_name END,
         spouse_first_name = CASE WHEN p_fields ? 'spouse_first_name' THEN p_fields ->> 'spouse_first_name' ELSE c.spouse_first_name END,
         spouse_last_name = CASE WHEN p_fields ? 'spouse_last_name' THEN p_fields ->> 'spouse_last_name' ELSE c.spouse_last_name END
   WHERE c.id = p_contact_id;
  RETURN 'saved';
END;
$$;

REVOKE ALL ON FUNCTION public.needs_client_save_contact(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.needs_client_save_contact(uuid, uuid, jsonb) TO service_role;
