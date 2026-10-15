import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { Panel, TABLE_TH, TABLE_TR } from '@/components/layout/page';
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
import { cn } from '@/lib/utils';
import { deleteEnvelopeDocument, getDocuments, uploadDocument } from '../api';
import { MAX_PDF_BYTES, type DocumentRow } from '../contract';
import { esignKeys } from '../keys';
import { looksLikePdf } from '../lib/pdfMagic';
import { PageGrid } from './PageGrid';

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

interface UploadEntry {
  id: string;
  file: File;
  status: UploadStatus;
  error?: string;
}

const MAX_MB = Math.round(MAX_PDF_BYTES / (1024 * 1024));

/** The composer's first step: upload PDFs, see them, and arrange their pages. */
export function DocumentsStep({ envelopeId }: { envelopeId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <DocumentUpload envelopeId={envelopeId} />
      <DocumentList envelopeId={envelopeId} />
      <Panel title="Pages" bodyClassName="p-3">
        <PageGrid envelopeId={envelopeId} />
      </Panel>
    </div>
  );
}

let uploadSeq = 0;

function DocumentUpload({ envelopeId }: { envelopeId: string }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [entries, setEntries] = useState<UploadEntry[]>([]);

  const setStatus = (id: string, status: UploadStatus, error?: string) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status, error } : e)));

  const uploadOne = useCallback(
    async (entry: UploadEntry) => {
      setStatus(entry.id, 'uploading');
      try {
        if (!(await looksLikePdf(entry.file))) throw new Error('The file is not a PDF.');
        await uploadDocument(envelopeId, entry.file);
        setStatus(entry.id, 'done');
        // Documents only: the pages list grows with every upload, so it is refreshed once
        // after the whole batch rather than per file.
        void queryClient.invalidateQueries({ queryKey: esignKeys.documents(envelopeId) });
      } catch (err) {
        const message = getErrorMessage(err, 'The upload failed.');
        setStatus(entry.id, 'error', message);
        toast.error(`${entry.file.name}: ${message}`);
      }
    },
    [envelopeId, queryClient],
  );

  const handleFiles = useCallback(
    (files: File[]) => {
      const accepted: UploadEntry[] = [];
      for (const file of files) {
        if (file.type && file.type !== 'application/pdf') {
          toast.error(`${file.name} is not a PDF.`);
          continue;
        }
        // The server's cap, checked here so an oversized file is refused before it is sent.
        if (file.size > MAX_PDF_BYTES) {
          toast.error(`${file.name} is ${formatFileSize(file.size)}, over the ${MAX_MB} MB limit.`);
          continue;
        }
        uploadSeq += 1;
        accepted.push({ id: `upload-${uploadSeq}`, file, status: 'queued' });
      }
      if (accepted.length === 0) return;
      setEntries((prev) => [...prev, ...accepted]);
      // One after another within a batch, so document order follows pick order. Not a
      // global guarantee (a second drop runs its own loop); the server orders documents
      // under a lock, which is what makes concurrent batches correct.
      void (async () => {
        for (const entry of accepted) await uploadOne(entry);
        void queryClient.invalidateQueries({ queryKey: esignKeys.pages(envelopeId) });
      })();
    },
    [envelopeId, queryClient, uploadOne],
  );

  const onDrag = (e: DragEvent, delta: number) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current + delta);
    setDragging(dragDepth.current > 0);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length > 0) handleFiles(picked);
    // Reset so the same file can be picked again.
    e.target.value = '';
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragEnter={(e) => onDrag(e, 1)}
        onDragLeave={(e) => onDrag(e, -1)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length > 0) handleFiles(dropped);
        }}
        className={cn(
          'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          dragging ? 'border-link bg-accent' : 'border-border bg-muted/30',
        )}
      >
        <input ref={inputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={onPick} aria-label="Choose PDFs" />
        <Upload className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium">Drop PDFs here</p>
        <p className="text-xs text-muted-foreground">PDF only, up to {MAX_MB} MB and 200 pages each.</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => inputRef.current?.click()}>
          Choose PDFs
        </Button>
      </div>

      {entries.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Uploads">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{entry.file.name}</div>
                {entry.status === 'error' && entry.error && <div className="text-xs text-destructive">{entry.error}</div>}
              </div>
              <span className="flex items-center gap-1.5 text-xs">
                {entry.status === 'queued' && <span className="text-muted-foreground">Queued</span>}
                {entry.status === 'uploading' && (
                  <>
                    <Loader2 className="size-3.5 animate-spin text-link" aria-hidden="true" />
                    <span className="text-link">Uploading</span>
                  </>
                )}
                {entry.status === 'done' && (
                  <>
                    <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
                    <span className="text-success-dark">Done</span>
                  </>
                )}
                {entry.status === 'error' && (
                  <>
                    <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
                    <span className="text-destructive">Failed</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
