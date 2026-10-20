-- 0014_requests: requests close themselves, and the upload notice waits a day.
--
-- Runs once on top of 0001 to 0012. 0005_requests may already be applied on a project, so
-- nothing there is edited: this file replaces one function, adds one more with its two
-- triggers, and closes the lists that were already finished before it ran.
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
--          required item is (submit is refused while one is, so that is belt and braces).
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
BEGIN
  IF TG_TABLE_NAME = 'needs_lists' THEN
    v_list := NEW.id;
  ELSE
    v_list := NEW.list_id;
  END IF;

  -- The lock first (see the header): every reconcile of one list runs one at a time, and
  -- each statement below reads the items as the one before it committed them.
  SELECT l.status INTO v_status FROM public.needs_lists l WHERE l.id = v_list FOR UPDATE;
  IF NOT FOUND OR v_status NOT IN ('sent', 'submitted') THEN
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
   AND EXISTS (SELECT 1 FROM public.needs_items i WHERE i.list_id = l.id AND i.kind <> 'info')
   AND NOT EXISTS (
     SELECT 1 FROM public.needs_items i
      WHERE i.list_id = l.id
        AND i.kind <> 'info'
        AND (i.status = 'fulfilled'
             OR (i.status = 'pending' AND (l.status = 'sent' OR i.required))));
