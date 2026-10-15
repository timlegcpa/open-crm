import { useState, type ChangeEvent } from 'react';
import { FileText, Loader2, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { formatDateTime, NO_VALUE_TEXT } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { invokePublicEdge } from '@/lib/publicEdge';
import { cn } from '@/lib/utils';
import { FN, verifyDocumentAnswer, type VerifyDocumentAnswer } from '../contract';
import { looksLikePdf, sha256Hex } from '../lib/pdfMagic';

/** Hashing reads the whole file into memory; past this a phone tab may not survive it. */
const MAX_VERIFY_BYTES = 200 * 1024 * 1024;

type Result = { kind: 'answer'; answer: VerifyDocumentAnswer } | { kind: 'error'; message: string };

/** Hash in the browser, send ONLY the digest: the file never leaves the device. */
export async function verifyFile(file: File): Promise<Result> {
  if (file.size > MAX_VERIFY_BYTES) return { kind: 'error', message: 'That file is too large to check here.' };
  if (!(await looksLikePdf(file))) return { kind: 'error', message: 'That file is not a PDF.' };
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const answer = await invokePublicEdge(FN.verifyDocument, { sha256 }, { parse: (d) => verifyDocumentAnswer.parse(d) });
  return { kind: 'answer', answer };
}

/** /esign/verify: anyone holding a signed PDF can check it is the copy on record, unchanged. */
export function VerifyPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setResult(null);
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await verifyFile(file));
    } catch (err) {
      setResult({ kind: 'error', message: getErrorMessage(err, 'The check could not be run. Try again.') });
    } finally {
      setBusy(false);
    }
  };

  const answer = result?.kind === 'answer' ? result.answer : null;

  return (
    <PublicPage title="Verify a signed document">
      <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
        Choose a signed PDF. Its fingerprint is worked out here in your browser and compared with the record of the signed copy.
        The file itself is never uploaded.
      </p>
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:p-6">
        <label
          htmlFor="esign-verify-file"
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center',
            busy ? 'cursor-not-allowed border-border opacity-60' : 'cursor-pointer border-border hover:border-link hover:bg-accent',
          )}
        >
          <Upload className="size-7 text-muted-foreground" aria-hidden="true" />
          {file ? (
            <span className="flex max-w-full items-center gap-1.5 text-sm font-medium">
              <FileText className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{file.name}</span>
            </span>
          ) : (
            <span className="text-sm font-medium">Choose a PDF</span>
          )}
          <input id="esign-verify-file" type="file" accept="application/pdf,.pdf" onChange={onPick} disabled={busy} className="sr-only" />
        </label>

        <Button onClick={() => void run()} disabled={!file || busy} size="lg">
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy ? 'Checking...' : 'Verify document'}
        </Button>

        {answer?.verified === true && (
          <div role="status" className="rounded-md border border-success bg-success-light p-4 text-sm text-success-dark">
            <p className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="size-5 shrink-0" aria-hidden="true" />
              Document verified
            </p>
            <p className="mt-1">This file is the signed copy on record, unchanged since it was signed.</p>
            <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
              <dt>Title</dt>
              <dd className="break-words font-medium">{answer.title}</dd>
              <dt>Completed</dt>
              <dd>{answer.completed_at ? formatDateTime(answer.completed_at) : NO_VALUE_TEXT}</dd>
              <dt>Signers</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {answer.signers.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="break-words">
                      {s.name}
                      {s.signed_at ? `, signed ${formatDateTime(s.signed_at)}` : ''}
                    </li>
                  ))}
                </ul>
              </dd>
              <dt>SHA-256</dt>
              <dd className="break-all font-mono text-[11px]">{answer.sha256}</dd>
            </dl>
          </div>
        )}

        {answer?.verified === false && (
          <div role="status" className="rounded-md border border-destructive bg-destructive-light p-4 text-sm text-destructive-dark">
            <p className="flex items-center gap-2 text-base font-semibold">
              <ShieldAlert className="size-5 shrink-0" aria-hidden="true" />
              Not verified
            </p>
            <p className="mt-1">{answer.reason || 'No signed copy on record matches this file. It may have been changed after signing.'}</p>
            {answer.sha256 && <p className="mt-2 break-all font-mono text-[11px]">SHA-256: {answer.sha256}</p>}
          </div>
        )}

        {result?.kind === 'error' && (
          <p role="alert" className="rounded-md border border-destructive bg-destructive-light p-3 text-sm text-destructive-dark">
            {result.message}
          </p>
        )}
      </div>
    </PublicPage>
  );
}
