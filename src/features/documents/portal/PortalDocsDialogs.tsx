import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ClickRegion } from '@/components/ui/click-region';
import { Folder, Home, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildFolderPaths } from '../lib/documentNames';
import type { FolderPathRow } from '../types';

const stripSlashes = (value: string) => value.replace(/[/\\]/g, '');

/* New folder */

interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (val: string) => void;
  onSubmit: () => void;
  isCreating: boolean;
}

export function NewFolderDialog({ open, onOpenChange, name, onNameChange, onSubmit, isCreating }: NewFolderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>The folder is created in the folder you have open.</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => onNameChange(stripSlashes(e.target.value))}
          placeholder="Folder name"
          aria-label="Folder name"
          autoFocus
          maxLength={100}
          onKeyDown={(e) => {
            // Guarded on the in-flight state: Enter key repeat would otherwise submit twice.
            if (e.key === 'Enter' && !isCreating && name.trim()) onSubmit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>Cancel</Button>
          <Button onClick={onSubmit} disabled={!name.trim() || isCreating}>
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Rename */

export interface RenameTarget {
  id: string;
  name: string;
  type: 'file' | 'folder';
}

interface RenameDialogProps {
  target: RenameTarget | null;
  value: string;
  onValueChange: (val: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  isSubmitting: boolean;
}

export function RenameDialog({ target, value, onValueChange, onSubmit, onClose, isSubmitting }: RenameDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename {target?.type === 'folder' ? 'folder' : 'file'}</DialogTitle>
          <DialogDescription>
            {target?.type === 'file' ? 'The file keeps its extension.' : 'Everything inside the folder stays inside it.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => onValueChange(stripSlashes(e.target.value))}
          placeholder="New name"
          aria-label="New name"
          autoFocus
          maxLength={target?.type === 'folder' ? 100 : 255}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isSubmitting && value.trim()) onSubmit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button onClick={onSubmit} disabled={!value.trim() || isSubmitting}>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Folder picker shared by the two move dialogs */

function FolderPicker({
  folders, currentPath, disabled, onPick,
}: { folders: FolderPathRow[]; currentPath: string; disabled: boolean; onPick: (path: string) => void }) {
  const options = buildFolderPaths(folders.map((f) => ({ ...f })));
  return (
    <ScrollArea className="h-64 rounded-md border border-border" fitWidth>
      <ul className="p-1">
        {options.map(({ label, path }) => {
          const here = path === currentPath;
          return (
            <li key={path}>
              <ClickRegion
                onClick={() => onPick(path)}
                disabled={here || disabled}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted',
                  here ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {path === '/'
                  ? <Home className="h-4 w-4 shrink-0" aria-hidden="true" />
                  : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <span className="truncate whitespace-pre">{label}</span>
                {here && <span className="ml-auto shrink-0 text-xs">Here now</span>}
              </ClickRegion>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

/* Move one file */

interface MoveDialogProps {
  target: { id: string; name: string } | null;
  allFolders: FolderPathRow[];
  currentPath: string;
  moving: boolean;
  onSubmit: (destPath: string) => void;
  onClose: () => void;
}

export function MoveDialog({ target, allFolders, currentPath, moving, onSubmit, onClose }: MoveDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move file</DialogTitle>
          <DialogDescription className="break-words">Choose where &ldquo;{target?.name}&rdquo; goes.</DialogDescription>
        </DialogHeader>
        <FolderPicker folders={allFolders} currentPath={currentPath} disabled={moving} onPick={onSubmit} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={moving}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Move several files */

interface BulkMoveDialogProps {
  open: boolean;
  fileCount: number;
  allFolders: FolderPathRow[];
  currentPath: string;
  moving: boolean;
  onSubmit: (destPath: string) => void;
  onClose: () => void;
}

export function BulkMoveDialog({ open, fileCount, allFolders, currentPath, moving, onSubmit, onClose }: BulkMoveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {fileCount} file{fileCount !== 1 ? 's' : ''}</DialogTitle>
          <DialogDescription>Choose a folder. Selected folders stay where they are.</DialogDescription>
        </DialogHeader>
        <FolderPicker folders={allFolders} currentPath={currentPath} disabled={moving} onPick={onSubmit} />
        {moving && <p className="text-center text-sm text-muted-foreground">Moving files...</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={moving}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Confirmations */

function ConfirmDelete({
  open, title, description, confirmLabel, busy, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // The dialog closes itself when the work is done, not on the click.
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? 'Deleting...' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteFileDialog({
  target, busy, onConfirm, onClose,
}: { target: { name: string } | null; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDelete
      open={!!target}
      title="Delete file"
      description={`Delete “${target?.name ?? ''}”? It is removed from your documents.`}
      confirmLabel="Delete"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function DeleteFolderDialog({
  target, busy, onConfirm, onClose,
}: { target: { name: string } | null; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDelete
      open={!!target}
      title="Delete folder"
      description={`Delete “${target?.name ?? ''}” and everything in it? Its files and folders are removed from your documents.`}
      confirmLabel="Delete"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function BulkDeleteDialog({
  open, count, busy, onConfirm, onClose,
}: { open: boolean; count: number; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const items = `${count} item${count !== 1 ? 's' : ''}`;
  return (
    <ConfirmDelete
      open={open}
      title={`Delete ${items}`}
      description={`Delete the ${items} you selected? A selected folder goes with everything in it.`}
      confirmLabel="Delete all"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
