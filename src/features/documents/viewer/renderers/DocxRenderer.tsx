import { useState, useEffect } from 'react';
// @ts-expect-error: mammoth browser bundle is UMD, no TS types
import mammoth from 'mammoth/mammoth.browser';
import DOMPurify from 'dompurify';
import { Loader2 } from 'lucide-react';
import { readPreviewBytes } from '../../lib/previewSource';

interface DocxRendererProps {
  url: string;
  /** In-memory bytes when the preview was decrypted client-side. Production
   * CSP blocks fetching a blob: URL; see ../../lib/previewSource. */
  blob?: Blob;
}

export default function DocxRenderer({ url, blob }: DocxRendererProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const arrayBuffer = await readPreviewBytes(url, blob);
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) setHtml(DOMPurify.sanitize(result.value));
      } catch (e) {
        // The error only: a document's content never reaches the console.
        console.error('DocxRenderer error:', e instanceof Error ? e.name : 'unknown');
        if (!cancelled) setError('Failed to render document');
      }
    })();
    return () => { cancelled = true; };
  }, [url, blob]);

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (!html) return <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="h-full overflow-auto p-6 text-sm leading-relaxed text-foreground [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-3 [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
