/**
 * The toolbar renders at the contact root, where New folder and Upload ask
 * which section a new item lands in. Returning null there would leave the root
 * with no way to add anything: these two are the only actions that need a
 * section chosen.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ExplorerToolbar from '../explorer/ExplorerToolbar';

beforeAll(() => {
  // Radix menus call the pointer-capture API on the way open; jsdom has none of it.
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

/** Radix DropdownMenu opens on pointerdown, not click. */
const open = (name: string) =>
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false, pointerType: 'mouse' });

describe('ExplorerToolbar at the contact root', () => {
  it('New folder asks which section, and passes the pick', async () => {
    const onNewFolder = vi.fn();
    render(<ExplorerToolbar activeSection={null} onNewFolder={onNewFolder} onUploadClick={vi.fn()} />);

    open('New folder');
    expect(await screen.findByRole('menuitem', { name: 'Shared documents' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uploaded documents' }));
    expect(onNewFolder).toHaveBeenCalledWith('client');
  });

  it('Upload asks which section, and passes the pick', async () => {
    const onUploadClick = vi.fn();
    render(<ExplorerToolbar activeSection={null} onNewFolder={vi.fn()} onUploadClick={onUploadClick} />);

    open('Upload');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Shared documents' }));
    expect(onUploadClick).toHaveBeenCalledWith('owner');
  });

  it('inside a section the buttons act on that section without asking', () => {
    const onNewFolder = vi.fn();
    const onUploadClick = vi.fn();
    render(<ExplorerToolbar activeSection="client" onNewFolder={onNewFolder} onUploadClick={onUploadClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(onNewFolder).toHaveBeenCalledWith('client');
    expect(onUploadClick).toHaveBeenCalledWith('client');
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});
