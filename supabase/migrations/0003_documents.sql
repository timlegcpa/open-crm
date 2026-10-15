-- 0003_documents: client documents and their folders.
--
-- Belongs here: the documents and folders tables, the metadata of server-side
-- encryption, document annotations, the private documents storage bucket with its
-- per-bucket policies, and the documents RPCs (get_contact_ids_with_documents,
-- move_client_folder, admin_client_folder_remove, portal_folder_purge,
-- mark_client_folder_reviewed, and the rename and move functions). Uploads are checked
-- on the server (type by content, size). An object in the documents bucket is never
-- deleted automatically.
--
-- Depends on: 0001_core, 0002_contacts (contacts, get_client_contact_id(),
-- client_activity_log, enforce_impersonation_read_only()).
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
-- The documents model, and the rules this file adds:
--   * Every contact has one file store in two sections, by held_by:
--       'owner'   what the owner shares with the contact ("Shared documents"). The
--                 contact reads and downloads it, nothing else.
--       'client'  what the contact uploaded ("Uploaded documents"). The contact may
--                 rename, move and delete it; the owner reviews it.
--   * Folders nest by path: a folder's full path is parent_path || name || '/', and a
--     document's folder_path is '/' or the full path of a folder of the SAME contact and
--     section. The same path can exist in both sections, so every path operation filters
--     contact_id AND held_by. Paths are compared by prefix with left(), never LIKE, so a
--     folder name holding % or _ matches only itself.
--   * Path integrity lives in the tables, not in the RPCs: the placement triggers refuse
--     a document or folder whose folder does not exist (and a folder moved into its own
--     subtree), and the cascade trigger rewrites a renamed or moved folder's children and
--     documents. So a bare UPDATE from any caller, client or owner, can never orphan a
--     subtree. The RPCs are SECURITY INVOKER: they validate, give friendly errors, and
--     leave authorization to RLS (a definer would pass the column guard as the owner).
--   * A client may change only original_filename and folder_path of its own uploads, and
--     only name and parent_path of its own upload folders: the column guards hold every
--     other column. A client never inserts a document: uploads arrive through the
--     encrypt-document function (service role), which checks the bytes and encrypts them.
--   * shared_with_contact_id is the ONLY thing that lets a second contact read a document.
--     It is set per document by the owner, never inferred from a relationship, and gives
--     read access only (the UPDATE and DELETE policies do not name it). A copy never
--     carries it.
--   * One storage object can back more than one row (a copy into the shared section,
--     an e-signed PDF filed to every signer), so nothing here or in the app deletes an
--     object when a row goes: deleting a contact or a row strands the object, and the
--     orphan report lists it. portal_folder_purge returns nothing for that reason.
--   * The bucket takes no browser writes at all. Its writers are server functions
--     (encrypt-document, e-sign filing, the portal-account purge). Should a write policy
--     for signed-in sessions ever be added, it must exclude e-signed objects:
--     name NOT LIKE '%/esign/%'.
--   * document_annotations is the owner's alone and must never join the realtime
--     publication: an annotation can quote what a document says.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.client_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- The object's leaf name in Storage (<uuid>.<ext>.enc for an encrypted upload).
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  -- The name people see. Renames keep it a single path segment. No Unicode format
  -- character (category Cf, Unicode 16): a right-to-left override (U+202E) can make
  -- "invoice<RLO>fdp.exe" read as "invoiceexe.pdf". The same class guards folder names,
  -- displayName() in encrypt-document and validateName() in the browser.
  original_filename text NOT NULL
    CHECK (char_length(original_filename) BETWEEN 1 AND 255
           AND original_filename !~ '[/\\[:cntrl:]]'
           AND original_filename !~ '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'),
  -- Not unique: a copy and an e-signed PDF's per-signer rows share one object.
  storage_path text NOT NULL CHECK (char_length(storage_path) BETWEEN 1 AND 1024),
  -- The plaintext size; an unencrypted object may be up to the bucket's limit
  -- (MAX_UPLOAD_BYTES plus the 16-byte GCM tag the bucket limit allows for).
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 26214416),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 255),
  -- Free text, not a fixed list: requests pass their owner-editable category keys through.
  category text NOT NULL DEFAULT 'general' CHECK (char_length(category) BETWEEN 1 AND 100),
  -- Set by the uploader through encrypt-document; never a marker anything relies on.
  description text CHECK (char_length(description) <= 500),
  folder_path text NOT NULL DEFAULT '/'
    CHECK (char_length(folder_path) <= 200
           AND folder_path ~ '^/([^/\\[:cntrl:]]+/)*$'
           AND folder_path !~ '/\.{1,2}/'),
  held_by text NOT NULL DEFAULT 'client' CHECK (held_by IN ('owner', 'client')),
  -- 'encrypted': AES-GCM under DOCUMENT_ENCRYPTION_KEY with this row's IV (base64, 12
  -- bytes). 'none': a plaintext object (an e-signed PDF), served by a short signed URL.
  encryption_iv text,
  encryption_status text NOT NULL DEFAULT 'none' CHECK (encryption_status IN ('none', 'encrypted')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Losing a share must never delete the file: SET NULL.
  shared_with_contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_documents_iv_matches_status
    CHECK ((encryption_status = 'encrypted') = (encryption_iv IS NOT NULL)),
  CONSTRAINT client_documents_not_shared_with_self
    CHECK (shared_with_contact_id <> contact_id)
);

COMMENT ON COLUMN public.client_documents.shared_with_contact_id IS
  'The second contact who may read this document. Set per document by the owner, never inferred from a relationship.';

CREATE INDEX idx_client_documents_contact ON public.client_documents (contact_id);
CREATE INDEX idx_client_documents_folder ON public.client_documents (contact_id, folder_path);
CREATE INDEX idx_client_documents_held_by ON public.client_documents (contact_id, held_by);
CREATE INDEX idx_client_documents_reviewed_by ON public.client_documents (reviewed_by);
CREATE INDEX idx_client_documents_uploaded_by ON public.client_documents (uploaded_by);
CREATE INDEX idx_client_documents_shared_with ON public.client_documents (shared_with_contact_id)
  WHERE shared_with_contact_id IS NOT NULL;
CREATE INDEX idx_client_documents_unreviewed ON public.client_documents (held_by, reviewed_at)
  WHERE held_by = 'client' AND reviewed_at IS NULL;

CREATE TABLE public.client_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  parent_path text NOT NULL DEFAULT '/'
    CHECK (parent_path ~ '^/([^/\\[:cntrl:]]+/)*$' AND parent_path !~ '/\.{1,2}/'),
  name text NOT NULL
    CHECK (char_length(name) BETWEEN 1 AND 100
           AND name !~ '[/\\[:cntrl:]]'
           -- Unicode format characters (Cf), as for original_filename.
           AND name !~ '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'
           AND name NOT IN ('.', '..')
           AND name = btrim(name)),
  held_by text NOT NULL DEFAULT 'client' CHECK (held_by IN ('owner', 'client')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The full path must fit a document's folder_path.
  CONSTRAINT client_folders_path_length CHECK (char_length(parent_path) + char_length(name) + 1 <= 200),
  CONSTRAINT client_folders_unique_name UNIQUE (contact_id, parent_path, name, held_by)
);

CREATE INDEX idx_client_folders_contact_path ON public.client_folders (contact_id, parent_path);
CREATE INDEX idx_client_folders_held_by ON public.client_folders (contact_id, held_by);
CREATE INDEX idx_client_folders_parent ON public.client_folders (contact_id, held_by, parent_path);
CREATE INDEX idx_client_folders_reviewed_by ON public.client_folders (reviewed_by);
CREATE INDEX idx_client_folders_unreviewed ON public.client_folders (held_by, reviewed_at)
  WHERE held_by = 'client' AND reviewed_at IS NULL;

CREATE TABLE public.document_annotations (
  -- The browser makes the id (crypto.randomUUID()), so an annotation can be saved
  -- before its insert returns; the default serves any other writer.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.client_documents (id) ON DELETE CASCADE,
  page_index integer NOT NULL CHECK (page_index BETWEEN 0 AND 4999),
  kind text NOT NULL CHECK (kind IN ('ink', 'highlight', 'text', 'stamp', 'review_stamp')),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_annotations_document ON public.document_annotations (document_id);

-- ---------------------------------------------------------------------------
-- Path integrity
-- ---------------------------------------------------------------------------

-- A document sits at '/' or in an existing folder of its own contact and section.
-- Runs as the caller: a client sees its own folders, the owner all, the server bypasses RLS.
CREATE FUNCTION public.client_documents_check_placement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.folder_path <> '/' AND NOT EXISTS (
    SELECT 1 FROM public.client_folders f
     WHERE f.contact_id = NEW.contact_id
       AND f.held_by = NEW.held_by
       AND f.parent_path = substring(NEW.folder_path FROM '^(.*/)[^/]+/$')
       AND f.name = substring(NEW.folder_path FROM '([^/]+)/$')
  ) THEN
    RAISE EXCEPTION 'Destination folder not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

-- A folder's parent exists in its own contact and section; a folder never moves into
-- its own subtree; and a folder stays with its contact and section (moving a section
-- would strand its documents in the other one).
CREATE FUNCTION public.client_folders_check_placement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contact_id <> OLD.contact_id OR NEW.held_by <> OLD.held_by THEN
      RAISE EXCEPTION 'A folder stays with its contact and section' USING ERRCODE = '22023';
    END IF;
    IF left(NEW.parent_path, char_length(OLD.parent_path || OLD.name || '/')) = OLD.parent_path || OLD.name || '/' THEN
      RAISE EXCEPTION 'A folder cannot move into itself' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.parent_path <> '/' AND NOT EXISTS (
    SELECT 1 FROM public.client_folders f
     WHERE f.contact_id = NEW.contact_id
       AND f.held_by = NEW.held_by
       AND f.parent_path = substring(NEW.parent_path FROM '^(.*/)[^/]+/$')
       AND f.name = substring(NEW.parent_path FROM '([^/]+)/$')
  ) THEN
    RAISE EXCEPTION 'Parent folder not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

-- When a folder's full path changes (rename or move), its direct children follow, and
-- each child's own update carries the change one level further down. Exact path
-- matches only, so no pattern escaping is involved. Runs as the caller, inside RLS: a
-- client's subtree is all its own (same contact, same section), so the rewrite is too.
CREATE FUNCTION public.client_folders_cascade_path()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  old_full text := OLD.parent_path || OLD.name || '/';
  new_full text := NEW.parent_path || NEW.name || '/';
BEGIN
  IF old_full = new_full THEN
    RETURN NULL;
  END IF;
  UPDATE public.client_folders
     SET parent_path = new_full
   WHERE contact_id = OLD.contact_id AND held_by = OLD.held_by AND parent_path = old_full;
  UPDATE public.client_documents
     SET folder_path = new_full
   WHERE contact_id = OLD.contact_id AND held_by = OLD.held_by AND folder_path = old_full;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_client_documents_updated_at
  BEFORE UPDATE ON public.client_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A client deletes only an EMPTY folder: a direct DELETE of a folder that still holds
-- folders or documents would strand them under a path with no folder. (A policy cannot
-- say this: a policy on client_folders that reads client_folders is refused as
-- recursive.) portal_folder_purge empties a subtree deepest first, one statement per
-- depth, so it passes one level at a time. The owner and the server are not held to it:
-- admin_client_folder_remove moves the documents out first, and deleting a contact
-- cascades over every folder at once.
CREATE FUNCTION public.client_folders_delete_empty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_path text := OLD.parent_path || OLD.name || '/';
BEGIN
  IF public.is_owner_or_server() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_folders c
              WHERE c.contact_id = OLD.contact_id AND c.held_by = OLD.held_by AND c.parent_path = v_path)
     OR EXISTS (SELECT 1 FROM public.client_documents d
                 WHERE d.contact_id = OLD.contact_id AND d.held_by = OLD.held_by AND d.folder_path = v_path) THEN
    RAISE EXCEPTION 'A folder that is not empty cannot be deleted' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;

-- original_filename and folder_path are left out on purpose: a client renames and moves
-- its own uploads (the CHECKs and the placement trigger keep both valid for everyone).
CREATE TRIGGER trg_client_documents_column_guard
  BEFORE UPDATE ON public.client_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_column_guard(
    'id', 'contact_id', 'uploaded_by', 'filename', 'storage_path', 'file_size', 'mime_type',
    'category', 'description', 'encryption_iv', 'encryption_status', 'held_by',
    'reviewed_at', 'reviewed_by', 'created_at', 'shared_with_contact_id');

CREATE TRIGGER trg_client_documents_placement
  BEFORE INSERT OR UPDATE OF folder_path, held_by, contact_id ON public.client_documents
  FOR EACH ROW EXECUTE FUNCTION public.client_documents_check_placement();

CREATE TRIGGER trg_impersonation_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.client_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();

-- name and parent_path are left out on purpose: a client renames its own upload folders,
-- and the cascade trigger keeps the subtree under them in step.
CREATE TRIGGER trg_client_folders_column_guard
  BEFORE UPDATE ON public.client_folders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_column_guard(
    'id', 'contact_id', 'held_by', 'created_at', 'reviewed_at', 'reviewed_by');

CREATE TRIGGER trg_client_folders_placement
  BEFORE INSERT OR UPDATE OF parent_path, name, held_by, contact_id ON public.client_folders
  FOR EACH ROW EXECUTE FUNCTION public.client_folders_check_placement();

CREATE TRIGGER trg_client_folders_delete_empty
  BEFORE DELETE ON public.client_folders
  FOR EACH ROW EXECUTE FUNCTION public.client_folders_delete_empty();

CREATE TRIGGER trg_client_folders_cascade_path
  AFTER UPDATE OF parent_path, name ON public.client_folders
  FOR EACH ROW EXECUTE FUNCTION public.client_folders_cascade_path();

CREATE TRIGGER trg_impersonation_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.client_folders
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();

CREATE TRIGGER trg_document_annotations_updated_at
  BEFORE UPDATE ON public.document_annotations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RPCs. All SECURITY INVOKER: RLS decides whose rows they touch.
-- ---------------------------------------------------------------------------

-- Rename one document. The owner renames any; a client its own uploads (RLS).
CREATE FUNCTION public.client_document_rename(p_document_id uuid, p_new_name text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(p_new_name);
BEGIN
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 255 OR v_name ~ '[/\\[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid file name' USING ERRCODE = '22023';
  END IF;
  UPDATE public.client_documents SET original_filename = v_name WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- Move one document to '/' or another folder of its own section. The placement
-- trigger refuses a destination that does not exist.
CREATE FUNCTION public.client_document_move(p_document_id uuid, p_new_folder_path text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_new_folder_path IS NULL OR left(p_new_folder_path, 1) <> '/' OR right(p_new_folder_path, 1) <> '/' THEN
    RAISE EXCEPTION 'Invalid destination path' USING ERRCODE = '22023';
  END IF;
  UPDATE public.client_documents SET folder_path = p_new_folder_path WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- Rename one folder; the cascade trigger rewrites everything under it.
CREATE FUNCTION public.rename_client_folder(p_folder_id uuid, p_new_name text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(p_new_name);
  v_folder record;
BEGIN
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 100 OR v_name ~ '[/\\[:cntrl:]]' OR v_name IN ('.', '..') THEN
    RAISE EXCEPTION 'Invalid folder name' USING ERRCODE = '22023';
  END IF;
  -- FOR UPDATE applies the UPDATE policy too, so a client never locks a folder it cannot change.
  SELECT f.contact_id, f.held_by, f.parent_path, f.name INTO v_folder
    FROM public.client_folders f WHERE f.id = p_folder_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_folder.name = v_name THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.client_folders f
     WHERE f.contact_id = v_folder.contact_id AND f.held_by = v_folder.held_by
       AND f.parent_path = v_folder.parent_path AND f.name = v_name AND f.id <> p_folder_id
  ) THEN
    RAISE EXCEPTION 'A folder with that name already exists here' USING ERRCODE = '23505';
  END IF;
  UPDATE public.client_folders SET name = v_name WHERE id = p_folder_id;
END;
$$;

-- Move one folder under another of its section, or to '/'. Owner only: the portal has
-- no folder move.
CREATE FUNCTION public.move_client_folder(p_folder_id uuid, p_new_parent_path text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_folder record;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;
  IF p_new_parent_path IS NULL OR left(p_new_parent_path, 1) <> '/' OR right(p_new_parent_path, 1) <> '/' THEN
    RAISE EXCEPTION 'Invalid destination path' USING ERRCODE = '22023';
  END IF;
  SELECT f.contact_id, f.held_by, f.parent_path, f.name INTO v_folder
    FROM public.client_folders f WHERE f.id = p_folder_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_folder.parent_path = p_new_parent_path THEN
    RETURN;
  END IF;
  IF left(p_new_parent_path, char_length(v_folder.parent_path || v_folder.name || '/'))
     = v_folder.parent_path || v_folder.name || '/' THEN
    RAISE EXCEPTION 'A folder cannot move into itself' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.client_folders f
     WHERE f.contact_id = v_folder.contact_id AND f.held_by = v_folder.held_by
       AND f.parent_path = p_new_parent_path AND f.name = v_folder.name AND f.id <> p_folder_id
  ) THEN
    RAISE EXCEPTION 'A folder with that name already exists there' USING ERRCODE = '23505';
  END IF;
  UPDATE public.client_folders SET parent_path = p_new_parent_path WHERE id = p_folder_id;
END;
$$;

-- The owner's folder delete: the folder and every folder under it go; the documents in
-- them move to the section's root '/'. Never deletes a document or an object.
CREATE FUNCTION public.admin_client_folder_remove(p_folder_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_folder record;
  v_prefix text;
  v_moved integer;
  v_folders integer;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;
  SELECT f.contact_id, f.held_by, f.parent_path, f.name INTO v_folder
    FROM public.client_folders f WHERE f.id = p_folder_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  v_prefix := v_folder.parent_path || v_folder.name || '/';

  UPDATE public.client_documents
     SET folder_path = '/'
   WHERE contact_id = v_folder.contact_id AND held_by = v_folder.held_by
     AND left(folder_path, char_length(v_prefix)) = v_prefix;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.client_folders
   WHERE contact_id = v_folder.contact_id AND held_by = v_folder.held_by
     AND (id = p_folder_id OR left(parent_path, char_length(v_prefix)) = v_prefix);
  GET DIAGNOSTICS v_folders = ROW_COUNT;

  RETURN jsonb_build_object('folders_deleted', v_folders, 'documents_moved', v_moved);
END;
$$;

-- The portal's folder delete: the folder, every folder under it and the document ROWS
-- in them go. The storage objects stay (see the header). A client's purge records one
-- document_delete activity row per document, within the keys its INSERT policy allows.
CREATE FUNCTION public.portal_folder_purge(p_folder_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_folder record;
  v_prefix text;
  v_root integer;
  v_depth integer;
BEGIN
  SELECT f.contact_id, f.held_by, f.parent_path, f.name INTO v_folder
    FROM public.client_folders f WHERE f.id = p_folder_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  v_prefix := v_folder.parent_path || v_folder.name || '/';

  WITH gone AS (
    DELETE FROM public.client_documents d
     WHERE d.contact_id = v_folder.contact_id AND d.held_by = v_folder.held_by
       AND left(d.folder_path, char_length(v_prefix)) = v_prefix
    RETURNING d.id, d.original_filename
  )
  INSERT INTO public.client_activity_log (contact_id, user_id, action, details)
  SELECT v_folder.contact_id, auth.uid(), 'document_delete',
         jsonb_build_object('document_id', gone.id, 'filename', gone.original_filename)
    FROM gone
   WHERE NOT public.is_owner() AND public.get_client_contact_id() = v_folder.contact_id;

  -- Deepest first, one statement per depth: a client may delete only an EMPTY folder
  -- (trg_client_folders_delete_empty), and each statement sees the deletes of the ones
  -- before it, so every folder is empty by the time its turn comes.
  FOR v_depth IN
    SELECT DISTINCT char_length(f.parent_path) - char_length(replace(f.parent_path, '/', ''))
      FROM public.client_folders f
     WHERE f.contact_id = v_folder.contact_id AND f.held_by = v_folder.held_by
       AND left(f.parent_path, char_length(v_prefix)) = v_prefix
     ORDER BY 1 DESC
  LOOP
    DELETE FROM public.client_folders f
     WHERE f.contact_id = v_folder.contact_id AND f.held_by = v_folder.held_by
       AND left(f.parent_path, char_length(v_prefix)) = v_prefix
       AND char_length(f.parent_path) - char_length(replace(f.parent_path, '/', '')) = v_depth;
  END LOOP;
  DELETE FROM public.client_folders WHERE id = p_folder_id;
  GET DIAGNOSTICS v_root = ROW_COUNT;
  IF v_root = 0 THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- Mark a folder, every folder under it and every document in them reviewed, in one
-- statement set. Only what is not yet reviewed is stamped, so earlier review times
-- stand; un-reviewing never cascades (an accidental click must not wipe a subtree).
CREATE FUNCTION public.mark_client_folder_reviewed(p_folder_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_folder record;
  v_prefix text;
  v_folders integer;
  v_documents uuid[];
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '42501';
  END IF;
  SELECT f.contact_id, f.held_by, f.parent_path, f.name INTO v_folder
    FROM public.client_folders f WHERE f.id = p_folder_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  v_prefix := v_folder.parent_path || v_folder.name || '/';

  UPDATE public.client_folders
     SET reviewed_at = now(), reviewed_by = auth.uid()
   WHERE contact_id = v_folder.contact_id AND held_by = v_folder.held_by AND reviewed_at IS NULL
     AND (id = p_folder_id OR left(parent_path, char_length(v_prefix)) = v_prefix);
  GET DIAGNOSTICS v_folders = ROW_COUNT;

  WITH marked AS (
    UPDATE public.client_documents
       SET reviewed_at = now(), reviewed_by = auth.uid()
     WHERE contact_id = v_folder.contact_id AND held_by = v_folder.held_by AND reviewed_at IS NULL
       AND left(folder_path, char_length(v_prefix)) = v_prefix
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_documents FROM marked;

  RETURN jsonb_build_object('folders_marked', v_folders, 'document_ids', to_jsonb(v_documents));
END;
$$;

-- Every contact holding a document or a folder, either section. SECURITY INVOKER, so
-- RLS scopes it: the owner sees all; a client sees itself and, through a document shared
-- with it, the contact id of each sharer (an id only, which the shared row already shows).
CREATE FUNCTION public.get_contact_ids_with_documents()
RETURNS TABLE (contact_id uuid)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.contact_id FROM public.client_documents d
  UNION
  SELECT f.contact_id FROM public.client_folders f;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_documents_mfa_gate ON public.client_documents AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY client_folders_mfa_gate ON public.client_folders AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
CREATE POLICY document_annotations_mfa_gate ON public.document_annotations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));

-- Documents: the owner reads everything; a client its own rows in both sections, plus
-- any single document shared with it. Only the owner inserts (client uploads come
-- through encrypt-document as the server). A client changes and deletes only its own
-- uploads; a share never extends to writing. A share recipient reads the whole row,
-- storage_path and encryption_iv included: RLS cannot hide columns per row, and neither
-- value opens anything (the bucket is readable by the owner alone and the key never
-- leaves decrypt-document).
CREATE POLICY client_documents_select ON public.client_documents
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_owner())
    OR contact_id = (SELECT public.get_client_contact_id())
    OR shared_with_contact_id = (SELECT public.get_client_contact_id())
  );
CREATE POLICY client_documents_owner_insert ON public.client_documents
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_owner()));
CREATE POLICY client_documents_update ON public.client_documents
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'))
  WITH CHECK ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'));
CREATE POLICY client_documents_delete ON public.client_documents
  FOR DELETE TO authenticated
  USING ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'));

-- Folders: no share arm. A client reads both of its sections and writes its upload folders.
CREATE POLICY client_folders_select ON public.client_folders
  FOR SELECT TO authenticated
  USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
-- A client's new folder starts unreviewed and dated now: the column guard covers UPDATE
-- only, so without this a client could insert a folder already "reviewed" by the owner.
CREATE POLICY client_folders_insert ON public.client_folders
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.is_owner())
    OR (contact_id = (SELECT public.get_client_contact_id())
        AND held_by = 'client'
        AND reviewed_at IS NULL
        AND reviewed_by IS NULL
        AND created_at = now())
  );
CREATE POLICY client_folders_update ON public.client_folders
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'))
  WITH CHECK ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'));
CREATE POLICY client_folders_delete ON public.client_folders
  FOR DELETE TO authenticated
  USING ((SELECT public.is_owner()) OR (contact_id = (SELECT public.get_client_contact_id()) AND held_by = 'client'));

-- Annotations: the owner's alone.
CREATE POLICY document_annotations_owner_all ON public.document_annotations
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner())) WITH CHECK ((SELECT public.is_owner()));

-- ---------------------------------------------------------------------------
-- Storage: the private documents bucket
-- ---------------------------------------------------------------------------

-- The upload types of supabase/functions/_shared/magic-bytes.ts, plus octet-stream, which
-- every encrypted object is stored as. The size limit leaves room for the 16-byte GCM tag
-- on a file of exactly MAX_UPLOAD_BYTES. documents.test.ts holds the list to the module.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-documents', 'client-documents', false, 26214416,
  ARRAY[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', 'application/vnd.ms-excel', 'text/csv', 'text/plain',
    'application/octet-stream'
  ]
);

-- The owner reads objects directly (a short signed URL for an e-signed PDF). Clients
-- read only through decrypt-document; nobody signed in writes or deletes an object.
CREATE POLICY client_documents_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'client-documents' AND (SELECT public.is_owner()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.client_documents, public.client_folders, public.document_annotations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.client_documents, public.client_folders, public.document_annotations
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.client_documents_check_placement(),
  public.client_folders_check_placement(),
  public.client_folders_cascade_path(),
  public.client_folders_delete_empty(),
  public.client_document_rename(uuid, text),
  public.client_document_move(uuid, text),
  public.rename_client_folder(uuid, text),
  public.move_client_folder(uuid, text),
  public.admin_client_folder_remove(uuid),
  public.portal_folder_purge(uuid),
  public.mark_client_folder_reviewed(uuid),
  public.get_contact_ids_with_documents()
  FROM PUBLIC, anon, authenticated, service_role;

-- Owner-only RPCs are granted too: each refuses everyone but the owner inside.
GRANT EXECUTE ON FUNCTION
  public.client_document_rename(uuid, text),
  public.client_document_move(uuid, text),
  public.rename_client_folder(uuid, text),
  public.move_client_folder(uuid, text),
  public.admin_client_folder_remove(uuid),
  public.portal_folder_purge(uuid),
  public.mark_client_folder_reviewed(uuid),
  public.get_contact_ids_with_documents()
  TO authenticated;
