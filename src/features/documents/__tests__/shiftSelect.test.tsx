/**
 * Shift-click and Ctrl-click selection in the Documents listing, as other
 * lists select. Rendered through the real FileGrid rows and the explorer's own
 * selection state, so the click → state → checkbox path is what is tested.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FileGrid from '../explorer/FileGrid';
import ClientOverviewPane from '../explorer/ClientOverviewPane';
import { useExplorerState } from '../explorer/useExplorerState';
import { selectRange } from '../explorer/selectRange';
import type { ClientDocument } from '../types';

beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

const doc = (id: string): ClientDocument => ({
  id,
  contact_id: 'c1',
  uploaded_by: 'u1',
  filename: `${id}.pdf`,
  original_filename: `${id}.pdf`,
  storage_path: `c1/${id}.pdf`,
  file_size: 1024,
  mime_type: 'application/pdf',
  category: 'general',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  folder_path: '/',
  held_by: 'owner',
  reviewed_at: null,
  reviewed_by: null,
  encryption_iv: null,
  encryption_status: 'encrypted',
  shared_with_contact_id: null,
});

const FILES = ['a', 'b', 'c', 'd', 'e'].map(doc);

function Harness({ onPreview, onOpenFullScreen }: { onPreview: () => void; onOpenFullScreen?: () => void }) {
  const state = useExplorerState();
  return (
    <FileGrid
      folders={[]}
      files={FILES}
      activeSection="owner"
      currentPath="/"
      selectedClientId="c1"
      onNavigateUp={() => {}}
      onNavigateToFolder={() => {}}
      onPreview={onPreview}
      onOpenFullScreen={onOpenFullScreen}
      selectedItems={state.selectedItems}
      onToggleSelectItem={state.toggleSelectItem}
      onSelectAll={state.selectAll}
      onClearSelection={state.clearSelection}
    />
  );
}

const box = (id: string) => screen.getByRole('checkbox', { name: `Select ${id}` });
const checked = () =>
  ['a', 'b', 'c', 'd', 'e'].filter((id) => box(id).getAttribute('aria-checked') === 'true');

describe('Documents selection', () => {
  it('shift-click on a checkbox selects every row between it and the last click', () => {
    render(<Harness onPreview={vi.fn()} />);
    fireEvent.click(box('b'));
    fireEvent.click(box('d'), { shiftKey: true });
    expect(checked()).toEqual(['b', 'c', 'd']);
  });

  it('works upward too, and a plain click still toggles one', () => {
    render(<Harness onPreview={vi.fn()} />);
    fireEvent.click(box('e'));
    fireEvent.click(box('c'), { shiftKey: true });
    expect(checked()).toEqual(['c', 'd', 'e']);
    fireEvent.click(box('d'));
    expect(checked()).toEqual(['c', 'e']);
  });

  it('shift- and Ctrl-click on a row select instead of opening the file', () => {
    vi.useFakeTimers();
    const onPreview = vi.fn();
    render(<Harness onPreview={onPreview} />);
    fireEvent.click(screen.getByText('a'), { ctrlKey: true });
    fireEvent.click(screen.getByText('c'), { shiftKey: true });
    fireEvent.click(screen.getByText('e'), { ctrlKey: true });
    vi.runAllTimers();
    vi.useRealTimers();
    expect(checked()).toEqual(['a', 'b', 'c', 'e']);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('a modified double-click selects and never opens the viewer', () => {
    const onOpen = vi.fn();
    render(<Harness onPreview={vi.fn()} onOpenFullScreen={onOpen} />);
    fireEvent.doubleClick(screen.getByText('b'), { ctrlKey: true });
    fireEvent.doubleClick(screen.getByText('c'), { shiftKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});

function OverviewHarness() {
  const state = useExplorerState();
  const shared = { folders: [], files: [doc('f1'), doc('f2')], isLoading: false };
  const client = { folders: [], files: [doc('p1'), doc('p2')].map((d) => ({ ...d, held_by: 'client' as const })), isLoading: false };
  return (
    <ClientOverviewPane
      clientId="c1"
      shared={shared}
      client={client}
      onEnterSection={() => {}}
      onPreviewFile={() => {}}
      selectedItems={state.selectedItems}
      onToggleSelectItem={state.toggleSelectItem}
      onSelectAll={state.selectAll}
      onClearSelection={state.clearSelection}
    />
  );
}

describe('Documents selection at the contact root', () => {
  it('a shift range runs across both sections', () => {
    render(<OverviewHarness />);
    fireEvent.click(box('f2'));
    fireEvent.click(box('p2'), { shiftKey: true });
    const on = ['f1', 'f2', 'p1', 'p2'].filter((id) => box(id).getAttribute('aria-checked') === 'true');
    expect(on).toEqual(['f2', 'p1', 'p2']);
  });
});

describe('selectRange', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('adds the span and keeps what was already selected', () => {
    expect([...selectRange(new Set(['d']), 'a', 'b', order)].sort()).toEqual(['a', 'b', 'd']);
  });
  it('with no anchor in this listing, toggles just the clicked row', () => {
    expect([...selectRange(new Set(), 'zz', 'c', order)]).toEqual(['c']);
    expect([...selectRange(new Set(['c']), null, 'c', order)]).toEqual([]);
  });
});
