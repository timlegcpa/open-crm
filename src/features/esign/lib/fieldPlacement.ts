import type { FieldRow, FieldType, PageRow } from '../contract';
import type { CanvasRect } from './coords';

/**
 * The field placer's pure parts: the geometry of placing, moving and resizing a box on the
 * rendered page, and the merge of the server's fields into the local layout.
 */

export const DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 280, h: 34 },
  date: { w: 160, h: 34 },
};
export const MIN_W = 40;
export const MIN_H = 16;

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface CanvasSize {
  width: number;
  height: number;
}

/** A new box of `type`, centred on the click and kept inside the page. */
export function placeAt(type: FieldType, clickX: number, clickY: number, canvas: CanvasSize): CanvasRect {
  const { w, h } = DEFAULT_SIZE[type];
  return {
    x: Math.max(0, Math.min(canvas.width - w, clickX - w / 2)),
    y: Math.max(0, Math.min(canvas.height - h, clickY - h / 2)),
    w,
    h,
  };
}

/** `origin` moved by (dx, dy), never past an edge of the page. */
export function moveRect(origin: CanvasRect, dx: number, dy: number, canvas: CanvasSize): CanvasRect {
  return {
    x: Math.max(0, Math.min(canvas.width - origin.w, origin.x + dx)),
    y: Math.max(0, Math.min(canvas.height - origin.h, origin.y + dy)),
    w: origin.w,
    h: origin.h,
  };
}

/** `origin` resized from `handle` by (dx, dy): never below the minimum, never off the page. */
export function resizeRect(origin: CanvasRect, handle: Handle, dx: number, dy: number, canvas: CanvasSize): CanvasRect {
  let { x, y, w, h } = origin;
  if (handle.includes('e')) w = Math.max(MIN_W, origin.w + dx);
  if (handle.includes('s')) h = Math.max(MIN_H, origin.h + dy);
  if (handle.includes('w')) {
    const next = Math.max(MIN_W, origin.w - dx);
    x = origin.x + (origin.w - next);
    w = next;
  }
  if (handle.includes('n')) {
    const next = Math.max(MIN_H, origin.h - dy);
    y = origin.y + (origin.h - next);
    h = next;
  }
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > canvas.width) w = canvas.width - x;
  if (y + h > canvas.height) h = canvas.height - y;
  return { x, y, w, h };
}

/**
 * The duplicate test: signer, page, type and the corner rounded to whole PDF points. Every
 * save replaces a signer's fields, so ids rotate; a layout that once doubled up collapses
 * back to one box per slot on the next merge. PostgREST may send numerics as strings.
 */
export function fieldContentKey(f: { signer_id: string; page_index: number; field_type: string; x: number | string; y: number | string }): string {
  return `${f.signer_id}|${f.page_index}|${f.field_type}|${Math.round(Number(f.x))}|${Math.round(Number(f.y))}`;
}

/** One box in the placer, with its PDF rect as the source of truth. */
export interface PlacedField {
  localId: string;
  /** The server id once saved (it rotates on every save). */
  remoteId?: string;
  signerId: string;
  pageId: string;
  pageIndex: number;
  fieldType: FieldType;
  pdf: { x: number; y: number; width: number; height: number };
}

/**
 * The server fields not already in `local`: unknown by id AND by content slot. Never
 * replaces what is there, so an edit made while a save is in flight survives the refetch
 * that save triggers. A field whose page index is past the visible pages is left out.
 */
export function newServerFields(server: readonly FieldRow[], local: readonly PlacedField[], visiblePages: readonly PageRow[]): PlacedField[] {
  const knownIds = new Set<string>();
  const knownContent = new Set<string>();
  for (const f of local) {
    if (f.remoteId) knownIds.add(f.remoteId);
    knownContent.add(fieldContentKey({ signer_id: f.signerId, page_index: f.pageIndex, field_type: f.fieldType, x: f.pdf.x, y: f.pdf.y }));
  }
  const out: PlacedField[] = [];
  for (const f of server) {
    if (knownIds.has(f.id)) continue;
    const key = fieldContentKey(f);
    if (knownContent.has(key)) continue;
    knownContent.add(key);
    const page = visiblePages[f.page_index];
    if (!page) continue;
    out.push({
      localId: `srv-${f.id}`,
      remoteId: f.id,
      signerId: f.signer_id,
      pageId: page.id,
      pageIndex: f.page_index,
      fieldType: f.field_type === 'date' ? 'date' : 'signature',
      pdf: { x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) },
    });
  }
  return out;
}
