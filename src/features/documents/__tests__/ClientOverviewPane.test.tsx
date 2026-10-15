/**
 * The contact-root overview carries the same row verbs as the folder view.
 *
 * A read-only overview is a tempting shortcut on the theory that every action
 * resolves against the ACTIVE section, and the root has none. Each row builds
 * its own dialog target from its `section` and `contactId`, so the theory is
 * wrong for every verb but New folder and Upload. This pins the verbs on the
 * overview so a read-only version cannot quietly come back.
 *
 * Rendered with the two section roots passed in as props: `useSectionRoot`
 * is the explorer's, so no query client is needed here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ClientOverviewPane from '../explorer/ClientOverviewPane';
import type { ClientDocument, ClientFolder } from '../types';

beforeAll(() => {
  // Radix menus call the pointer-capture API on the way open; jsdom has none of it.
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

const folder = (over: Partial<ClientFolder>): ClientFolder => ({
  id: 'folder',
  contact_id: 'c1',
  parent_path: '/',
  name: 'Folder',
  created_at: '2026-01-01T00:00:00Z',
  held_by: 'owner',
  reviewed_at: null,
  reviewed_by: null,
  ...over,
});

const doc = (over: Partial<ClientDocument>): ClientDocument => ({
  id: 'doc',
  contact_id: 'c1',
  uploaded_by: 'u1',
  filename: 'file.pdf',
  original_filename: 'file.pdf',
  storage_path: 'c1/file.pdf',
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
  ...over,
});

const SHARED_FOLDER = folder({ id: 'ff', name: 'Shared folder' });
const SHARED_DOC = doc({ id: 'fd', original_filename: 'agreement.pdf', storage_path: 'c1/agreement.pdf' });
const CLIENT_FOLDER = folder({ id: 'cf', name: 'Client folder', held_by: 'client' });
const CLIENT_DOC = doc({ id: 'cd', original_filename: 'client.pdf', held_by: 'client' });

function renderPane(overrides: Partial<Parameters<typeof ClientOverviewPane>[0]> = {}) {
  const props = {
    clientId: 'c1',
    shared: { folders: [SHARED_FOLDER], files: [SHARED_DOC], isLoading: false },
    client: { folders: [CLIENT_FOLDER], files: [CLIENT_DOC], isLoading: false },
    onEnterSection: vi.fn(),
    onPreviewFile: vi.fn(),
    onDownload: vi.fn(),
    onSetRenameTarget: vi.fn(),
    onSetMoveTarget: vi.fn(),
    onSetMoveToSharedTarget: vi.fn(),
    onSetDeleteTarget: vi.fn(),
    onRequestShare: vi.fn(),
    onToggleReview: vi.fn(),
    selectedItems: new Set<string>(),
    onToggleSelectItem: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    ...overrides,
  };
  render(<ClientOverviewPane {...props} />);
  return props;
}

const rowOf = (name: string) => screen.getByTitle(name).closest('tr')!;

describe('ClientOverviewPane row verbs', () => {
  it('every row carries Delete; only the uploaded rows carry the review check', () => {
    const props = renderPane();

    expect(screen.getAllByTitle('Delete')).toHaveLength(4);
    expect(screen.getAllByTitle('Mark as reviewed')).toHaveLength(2);
    expect(rowOf('Shared folder').querySelector('[title="Mark as reviewed"]')).toBeNull();

    fireEvent.click(rowOf('agreement').querySelector('[title="Delete"]')!);
    expect(props.onSetDeleteTarget).toHaveBeenCalledWith({
      id: 'fd',
      name: 'agreement.pdf',
      type: 'file',
      contactId: 'c1',
    });

    fireEvent.click(rowOf('client').querySelector('[title="Mark as reviewed"]')!);
    expect(props.onToggleReview).toHaveBeenCalledWith('cd', false, 'file');
  });

  it('right-click opens the same menu the folder view has', async () => {
    const props = renderPane();

    fireEvent.contextMenu(rowOf('Client folder'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    expect(props.onSetRenameTarget).toHaveBeenCalledWith({
      id: 'cf',
      name: 'Client folder',
      type: 'folder',
      contactId: 'c1',
    });
  });

  it('selection spans both sections: the header box selects every id, a row box its own', () => {
    const props = renderPane();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(props.onSelectAll).toHaveBeenCalledWith(['ff', 'fd', 'cf', 'cd']);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(5);
    fireEvent.click(boxes[1]);
    expect(props.onToggleSelectItem).toHaveBeenCalledWith('ff');
  });

  it('a folder click enters its section at that path; a file click previews in its section', () => {
    const props = renderPane();

    fireEvent.click(screen.getByTitle('Shared folder'));
    expect(props.onEnterSection).toHaveBeenCalledWith('owner', '/Shared folder/');

    fireEvent.click(screen.getByTitle('client'));
    expect(props.onPreviewFile).toHaveBeenCalledWith('client', expect.objectContaining({ id: 'cd' }));
  });

  it('double-click and Enter enter the section too; the folder view’s open verbs never fire here', () => {
    // The explorer hands every surface one bundle, `onPreview` and
    // `onOpenFullScreen` included. Forwarded as-is, a double-click at the root
    // opened the workstation without entering the section, so a shared file
    // landed with the rail scoped to the uploads. The type said otherwise.
    const onPreview = vi.fn();
    const onOpenFullScreen = vi.fn();
    const props = renderPane({ onPreview, onOpenFullScreen });

    fireEvent.doubleClick(rowOf('agreement'));
    expect(props.onPreviewFile).toHaveBeenCalledWith('owner', expect.objectContaining({ id: 'fd' }));

    fireEvent.keyDown(rowOf('client'), { key: 'Enter' });
    expect(props.onPreviewFile).toHaveBeenCalledWith('client', expect.objectContaining({ id: 'cd' }));

    expect(onPreview).not.toHaveBeenCalled();
    expect(onOpenFullScreen).not.toHaveBeenCalled();
  });

  it("the Review column says where each uploaded row stands, and clicking a file's status toggles it", () => {
    const props = renderPane({
      client: {
        folders: [CLIENT_FOLDER],
        files: [
          CLIENT_DOC,
          doc({ id: 'cr', original_filename: 'done.pdf', held_by: 'client', reviewed_at: '2026-09-29T12:00:00Z' }),
        ],
        isLoading: false,
      },
    });

    expect(rowOf('client').textContent).toContain('Needs review');
    expect(rowOf('Client folder').textContent).toContain('Needs review');
    expect(rowOf('done').textContent).toContain('Reviewed Sep 29');
    expect(rowOf('done').textContent).not.toContain('Needs review');
    // Shared rows are never reviewed, so they carry no review status at all.
    expect(rowOf('agreement').textContent).not.toMatch(/review/i);
    expect(rowOf('Shared folder').textContent).not.toMatch(/review/i);

    fireEvent.click(rowOf('client').querySelector('button[title^="Needs review"]')!);
    expect(props.onToggleReview).toHaveBeenCalledWith('cd', false, 'file');
    // The status click must not also open the preview.
    expect(props.onPreviewFile).not.toHaveBeenCalled();

    fireEvent.click(rowOf('done').querySelector('button[title^="Reviewed"]')!);
    expect(props.onToggleReview).toHaveBeenCalledWith('cr', true, 'file');
  });

  it('draws no selection column when no selection is wired', () => {
    renderPane({ selectedItems: undefined, onToggleSelectItem: undefined });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getAllByTitle('Delete')).toHaveLength(4);
  });
});
