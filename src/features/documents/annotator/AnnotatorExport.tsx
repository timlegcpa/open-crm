import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FileDown, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { downloadBlob } from '@/lib/download';
import { getErrorMessage } from '@/lib/errors';
import { MAX_UPLOAD_BYTES, verifyMagicBytes } from '../../../../supabase/functions/_shared/magic-bytes';
import { documentKeys, ensureFolderChain, folderKeys, uploadDocument } from '../api';
import { flattenAnnotatedPdf } from '../lib/flattenAnnotations';
import type { DocumentAnnotation } from '../lib/annotations';
import type { AnnotatorDoc } from './types';

export default function AnnotatorExport({
  doc,
  getBytes,
  hasBytes,
  annotations,
}: {
  doc: AnnotatorDoc;
  getBytes: () => Uint8Array | null;
  hasBytes: boolean;
  annotations: DocumentAnnotation[];
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const noAnnotations = annotations.length === 0;
  // hasBytes, not getBytes(): the accessor copies the PDF defensively.
  const disabled = noAnnotations || !hasBytes || busy;
  const annotatedName = `${doc.name.replace(/\.[^.]+$/, '')} (annotated).pdf`;

  /** Flatten the original bytes; toasts and returns null on failure. */
  const flatten = async (): Promise<Uint8Array | null> => {
    const original = getBytes();
    if (!original) return null;
    try {
      return await flattenAnnotatedPdf(original, annotations);
    } catch (err) {
      if ((err as { message?: unknown } | null)?.message === 'encrypted-pdf') {
        toast.error('This PDF is password protected, so its marks cannot be flattened.');
      } else {
        toast.error('The export failed', { description: 'Could not flatten the annotated PDF.' });
      }
      return null;
    }
  };

  const handleDownload = async () => {
    setBusy(true);
    try {
      const bytes = await flatten();
      if (bytes) {
        downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), annotatedName);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveConfirm = async () => {
    setSaving(true);
    try {
      const bytes = await flatten();
      if (!bytes) return; // flatten already toasted
      if (bytes.length > MAX_UPLOAD_BYTES) {
        toast.error('The file is too large', {
          description: `The flattened copy is over the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`,
        });
        return;
      }
      // Every upload point checks the bytes, even one fed by pdf-lib, so a later change
      // that lets other bytes reach this path fails closed. The server checks again.
      if (!verifyMagicBytes('application/pdf', bytes)) {
        toast.error('The copy was not saved', { description: 'The flattened copy is not a valid PDF.' });
        return;
      }
      const file = new File([bytes as BlobPart], annotatedName, { type: 'application/pdf' });
      // The copy goes to the shared section at the same path; the database refuses a
      // document whose folder does not exist there, so the chain is made first.
      await ensureFolderChain(doc.contactId, doc.folderPath, 'owner');
      await uploadDocument({ file, contactId: doc.contactId, folderPath: doc.folderPath, heldBy: 'owner' });
      // Prefix invalidation: the listing, the rail and the folder counts all hang off these.
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
      void queryClient.invalidateQueries({ queryKey: folderKeys.all });
      toast.success('Saved to shared documents.');
    } catch (err) {
      toast.error('The copy was not saved', { description: getErrorMessage(err, 'Could not save the copy to documents.') });
    } finally {
      setSaving(false);
      // Every path (success, early return, throw) already toasted; closing
      // here stops the dialog sitting open on top of its own error.
      setSaveOpen(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={-1}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    className="h-8 gap-1.5 border-border text-foreground [&_svg]:size-3.5"
                  >
                    {busy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <FileDown className="w-3.5 h-3.5" />
                    )}
                    Export
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            {noAnnotations && <TooltipContent>No annotations yet</TooltipContent>}
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void handleDownload()}>
            <FileDown className="w-4 h-4 mr-2 text-muted-foreground" />
            Download annotated copy
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
            <Save className="w-4 h-4 mr-2 text-muted-foreground" />
            Save copy to documents…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={saveOpen} onOpenChange={(open) => !saving && setSaveOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save a copy to documents?</AlertDialogTitle>
            <AlertDialogDescription>
              Saves a flattened copy to this contact&apos;s shared documents at the same folder
              path. <span className="font-semibold text-foreground">The contact can see it in
              their portal.</span> Your marks on the original stay private.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                void handleSaveConfirm();
              }}
            >
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
