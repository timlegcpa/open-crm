/**
 * Whether a key press belongs to what the user is typing into (or to an open overlay), so a
 * page shortcut must yield. Inputs, textareas, selects, a focused Radix Select trigger
 * (`role="combobox"`, whose typeahead would also act on the key) and contentEditable all
 * count, and so does any open dialog or menu.
 */
export function isTypingContext(
  target: { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null,
  overlayOpen: boolean,
): boolean {
  if (overlayOpen) return true;
  if (!target) return false;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.getAttribute?.('role') === 'combobox') return true;
  return target.isContentEditable === true;
}

/** An open Radix dialog, alert dialog, popover or menu in the document. */
export function overlayIsOpen(doc: Document): boolean {
  return doc.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]') !== null;
}

/**
 * Where a board card dropped: a move to the column's status, or null when it landed nowhere,
 * on its own column, or on something that is not a column.
 */
export function moveForDrop(
  activeId: string,
  overId: string | null | undefined,
  statusOf: (contactId: string) => string | undefined,
  columns: readonly string[],
): { contactId: string; status: string } | null {
  if (!overId || !columns.includes(overId)) return null;
  const current = statusOf(activeId);
  if (current === undefined || current === overId) return null;
  return { contactId: activeId, status: overId };
}
