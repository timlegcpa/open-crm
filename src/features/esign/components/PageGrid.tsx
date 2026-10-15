import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { getDocuments, getPages, reorderPages } from '../api';
import type { PageRow, ReorderOp } from '../contract';
import { esignKeys } from '../keys';
import { reorderOperations } from '../lib/pageOrder';
import { openPdf } from '../lib/pdfRender';
import { useWorkingUrls } from './useWorkingUrls';

const THUMB_WIDTH = 140;

function PageThumbnail({ page, position, url, onDelete }: { page: PageRow; position: number; url: string | undefined; onDelete: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!url || !canvas) return;
    setState('loading');
    const pdf = openPdf({ url });
    let cancelled = false;
    pdf
      .renderPage(page.source_page_index, THUMB_WIDTH, canvas)
      .then(() => !cancelled && setState('ready'))
      // A JBIG2 or JPX page needs the decoders @/lib/pdfjs points at; a wedged decoder is
      // destroyed by the watchdog, which rejects here, so a tile never spins forever.
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
      pdf.destroy();
    };
  }, [url, page.source_page_index]);

  return (
    <li ref={setNodeRef} style={style} className="group relative list-none">
      <div
        className="cursor-grab overflow-hidden rounded-md border border-border bg-card active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={`Page ${position + 1}. Drag to reorder.`}
      >
        <div className="flex items-center justify-center bg-muted" style={{ width: THUMB_WIDTH, minHeight: THUMB_WIDTH * 1.3 }}>
          {state === 'loading' && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />}
          {state === 'error' && <span className="px-2 text-center text-xs text-destructive">Could not show this page</span>}
          <canvas ref={canvasRef} className={state === 'ready' ? 'block' : 'hidden'} />
        </div>
        <div className="border-t border-border px-2 py-1 text-center text-[11px] text-muted-foreground">Page {position + 1}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label={`Remove page ${position + 1}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(page.id);
        }}
        // Keeps dnd-kit from taking the press as the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute -right-2 -top-2 rounded-full bg-card opacity-0 shadow focus:opacity-100 group-hover:opacity-100"
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * The envelope's pages as thumbnails: drag to reorder, remove one. Both go through the
 * reorder function, which also remaps every field's page index; the field list is
 * refetched afterwards, because a placer holding the old indexes would write them back on
 * its next save and stamp signatures on the wrong page. Optimistic, rolled back on failure.
 */
export function PageGrid({ envelopeId }: { envelopeId: string }) {
  const queryClient = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const pages = useQuery({ queryKey: esignKeys.pages(envelopeId), queryFn: () => getPages(envelopeId) });
  const documents = useQuery({ queryKey: esignKeys.documents(envelopeId), queryFn: () => getDocuments(envelopeId) });
  const urls = useWorkingUrls(envelopeId, documents.data ?? []);

  const all = useMemo(() => pages.data ?? [], [pages.data]);
  const visible = useMemo(() => all.filter((p) => !p.deleted).sort((a, b) => a.order - b.order), [all]);

  async function apply(operations: ReorderOp[], optimistic: PageRow[]) {
    const key = esignKeys.pages(envelopeId);
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData<PageRow[]>(key);
    queryClient.setQueryData(key, optimistic);
    try {
      await reorderPages(envelopeId, operations);
    } catch (err) {
      if (previous) queryClient.setQueryData(key, previous);
      toast.error(getErrorMessage(err, 'The pages were not updated. Try again.'));
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: esignKeys.fields(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.documents(envelopeId) });
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = visible.findIndex((p) => p.id === active.id);
    const to = visible.findIndex((p) => p.id === over.id);
    if (from === -1 || to === -1) return;
    const moved = arrayMove(visible, from, to);
    const operations = reorderOperations(moved);
    void apply(operations, [...moved.map((p, idx) => ({ ...p, order: idx })), ...all.filter((p) => p.deleted)]);
  }

  function handleDelete(pageId: string) {
    const target = all.find((p) => p.id === pageId);
    const remaining = visible.filter((p) => p.id !== pageId);
    void apply(
      [{ page_id: pageId, deleted: true }],
      [...remaining.map((p, idx) => ({ ...p, order: idx })), ...all.filter((p) => p.deleted), ...(target ? [{ ...target, deleted: true }] : [])],
    );
  }

  if (pages.isPending || documents.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading pages" />
      </div>
    );
  }
  if (pages.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the pages: {getErrorMessage(pages.error)}
      </p>
    );
  }
  if (visible.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No pages yet. Upload a PDF to start.</p>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={visible.map((p) => p.id)} strategy={rectSortingStrategy}>
        <ul className="flex flex-wrap gap-4" aria-label="Pages">
          {visible.map((page, index) => (
            <PageThumbnail key={page.id} page={page} position={index} url={urls[page.source_document_id]} onDelete={handleDelete} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
