import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/sonner';
import { annotationKeys, deleteAnnotation, listAnnotations, saveAnnotation } from '../api';
import type { AnnotationData, AnnotationKind, DocumentAnnotation } from '../lib/annotations';

/**
 * Annotation list + optimistic mutations for one document, plus the session
 * creation-undo stack (Ctrl+Z deletes the most recently created annotation , 
 * no redo, v1 scope).
 *
 * Optimistic pattern:
 * write the cache immediately, fire the mutation, and on error toast +
 * invalidate so the cache resyncs with the server.
 */
export function useAnnotations(documentId: string) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => annotationKeys.forDocument(documentId), [documentId]);

  const { data: annotations = [], isLoading } = useQuery({
    queryKey,
    // Read-only queryFn (repo rule): all writes go through the mutations below.
    queryFn: () => listAnnotations(documentId),
  });

  const byPage = useMemo(() => {
    const map = new Map<number, DocumentAnnotation[]>();
    for (const a of annotations) {
      const list = map.get(a.page_index);
      if (list) list.push(a);
      else map.set(a.page_index, [a]);
    }
    return map;
  }, [annotations]);

  // Ids created this session, in creation order (undo stack). Reset per
  // document: the workstation keeps this hook mounted across ↑/↓ switches, and
  // a carried-over stack would make Ctrl+Z delete the PREVIOUS document's
  // annotation with no error.
  const undoStackRef = useRef<string[]>([]);
  useEffect(() => {
    undoStackRef.current = [];
  }, [documentId]);

  // Documents whose list needs a server resync once every in-flight write has
  // landed. Invalidating immediately from inside a failed chain would start a
  // refetch while a sibling write (the same id queued behind it, or another
  // id entirely) is still in flight: that refetch resolves with pre-write
  // server state and overwrites the sibling's already-applied optimistic
  // update. A Set (not a per-document boolean) because `writeChainsRef`
  // survives a document switch: if id A's write fails, the user switches to
  // document B, and B's own writes drain last, only A's resync may fire early.
  const resyncDocsRef = useRef<Set<string>>(new Set());
  const onMutationError = useCallback(
    (title: string) => {
      toast.error(title);
      resyncDocsRef.current.add(documentId);
    },
    [documentId],
  );

  // Per-id write chains: every
  // server write for an annotation id queues behind the previous one, so HTTP
  // reordering can't land a DELETE before its INSERT (resurrected row) or a
  // stale upsert after a newer one. Errors toast + mark the document for
  // resync but keep the chain alive; the map entry is dropped once its chain
  // settles and is still the latest. The resync itself fires only once EVERY
  // chain (any id) has drained, so it can never race a still-in-flight write.
  const writeChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const enqueueWrite = useCallback(
    (id: string, op: () => Promise<unknown>, errorTitle: string) => {
      const prev = writeChainsRef.current.get(id) ?? Promise.resolve();
      const next = prev
        .then(() => op())
        .then(
          () => undefined,
          () => onMutationError(errorTitle),
        );
      writeChainsRef.current.set(id, next);
      void next.finally(() => {
        if (writeChainsRef.current.get(id) === next) writeChainsRef.current.delete(id);
        if (writeChainsRef.current.size > 0) return;
        for (const docId of resyncDocsRef.current) {
          void queryClient.invalidateQueries({ queryKey: annotationKeys.forDocument(docId) });
        }
        resyncDocsRef.current.clear();
      });
    },
    [onMutationError, queryClient],
  );

  const addAnnotation = useCallback(
    (pageIndex: number, kind: AnnotationKind, data: AnnotationData): string => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const row: DocumentAnnotation = {
        id,
        document_id: documentId,
        page_index: pageIndex,
        kind,
        data,
        created_at: now,
        updated_at: now,
      };
      queryClient.setQueryData<DocumentAnnotation[]>(queryKey, (old) => [...(old ?? []), row]);
      undoStackRef.current.push(id);
      enqueueWrite(
        id,
        () => saveAnnotation({ id, document_id: documentId, page_index: pageIndex, kind, data }),
        'The annotation could not be saved.',
      );
      return id;
    },
    [documentId, queryClient, queryKey, enqueueWrite],
  );

  const updateAnnotation = useCallback(
    (id: string, data: AnnotationData) => {
      const existing = (queryClient.getQueryData<DocumentAnnotation[]>(queryKey) ?? []).find((a) => a.id === id);
      if (!existing) return;
      const now = new Date().toISOString();
      queryClient.setQueryData<DocumentAnnotation[]>(
        queryKey,
        (old) => old?.map((a) => (a.id === id ? { ...a, data, updated_at: now } : a)) ?? [],
      );
      enqueueWrite(
        id,
        () =>
          saveAnnotation({
            id,
            document_id: documentId,
            page_index: existing.page_index,
            kind: existing.kind,
            data,
          }),
        'The annotation could not be saved.',
      );
    },
    [documentId, queryClient, queryKey, enqueueWrite],
  );

  const deleteById = useCallback(
    (id: string) => {
      queryClient.setQueryData<DocumentAnnotation[]>(queryKey, (old) => old?.filter((a) => a.id !== id) ?? []);
      enqueueWrite(id, () => deleteAnnotation(id), 'The annotation could not be deleted.');
    },
    [queryClient, queryKey, enqueueWrite],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      // Keep the undo stack honest: a manually deleted id must not resurface
      // as a no-op undo step.
      undoStackRef.current = undoStackRef.current.filter((x) => x !== id);
      deleteById(id);
    },
    [deleteById],
  );

  /** Pops the session creation stack and deletes that annotation. Returns the id, or null when empty. */
  const undo = useCallback((): string | null => {
    const id = undoStackRef.current.pop();
    if (!id) return null;
    deleteById(id);
    return id;
  }, [deleteById]);

  return { annotations, byPage, isLoading, addAnnotation, updateAnnotation, removeAnnotation, undo };
}
