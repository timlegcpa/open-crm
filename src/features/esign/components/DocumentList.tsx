import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { TABLE_TH, TABLE_TR } from '@/components/layout/page';
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
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getErrorMessage } from '@/lib/errors';
import { formatFileSize } from '@/lib/format';
import { deleteEnvelopeDocument, getDocuments } from '../api';
import type { DocumentRow } from '../contract';
import { esignKeys } from '../keys';

// Its own module, apart from DocumentsStep: the sent envelope's detail page shows this list,
// and DocumentsStep's page grid brings pdf.js, which that page does not need.

/** The envelope's source PDFs. Deleting one is a draft-only edit; `canDelete` hides it otherwise. */
export function DocumentList({ envelopeId, canDelete = true }: { envelopeId: string; canDelete?: boolean }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<DocumentRow | null>(null);
  const documents = useQuery({ queryKey: esignKeys.documents(envelopeId), queryFn: () => getDocuments(envelopeId) });

  const remove = useMutation({
    mutationFn: (doc: DocumentRow) => deleteEnvelopeDocument(envelopeId, doc),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.documents(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.pages(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.fields(envelopeId) });
      toast.success('The document was removed.');
      setTarget(null);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The document was not removed. Try again.')),
  });

  if (documents.isPending) {
    return (
      <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading documents...
      </p>
    );
  }
  if (documents.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the documents: {getErrorMessage(documents.error)}
      </p>
    );
  }
  if (documents.data.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">No documents yet.</p>;
  }

  return (
    <>
      <div className="rounded-md border border-border">
        <ScrollArea horizontal>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={TABLE_TH}>File</TableHead>
                <TableHead className={`${TABLE_TH} w-20 text-right`}>Pages</TableHead>
                <TableHead className={`${TABLE_TH} w-24 text-right`}>Size</TableHead>
                {canDelete && (
                  <TableHead className={`${TABLE_TH} w-12`}>
                    <span className="sr-only">Remove</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.data.map((doc) => (
                <TableRow key={doc.id} className={TABLE_TR}>
                  <TableCell className="max-w-[360px] truncate text-[13px]">{doc.file_name}</TableCell>
                  <TableCell className="text-right text-[13px] tabular-nums">{doc.page_count}</TableCell>
                  <TableCell className="text-right text-[13px] tabular-nums">{formatFileSize(Number(doc.byte_size))}</TableCell>
                  {canDelete && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" onClick={() => setTarget(doc)} aria-label={`Remove ${doc.file_name}`}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && !remove.isPending && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? `${target.file_name} and its ${target.page_count} page${target.page_count === 1 ? '' : 's'} leave the envelope, with any fields placed on them.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (target) remove.mutate(target);
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {remove.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
