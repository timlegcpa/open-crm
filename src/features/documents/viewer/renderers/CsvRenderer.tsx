import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { parseCsv } from '@/lib/csv';
import { readPreviewText } from '../../lib/previewSource';

interface CsvRendererProps {
  url: string;
  /** In-memory bytes when the preview was decrypted client-side. Production
   * CSP blocks fetching a blob: URL; see ../../lib/previewSource. */
  blob?: Blob;
}

export default function CsvRenderer({ url, blob }: CsvRendererProps) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text = await readPreviewText(url, blob);
        if (!cancelled) setRows(parseCsv(text));
      } catch {
        if (!cancelled) setError('This file could not be shown as a table.');
      }
    })();
    return () => { cancelled = true; };
  }, [url, blob]);

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (!rows) return <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="flex-1 overflow-auto h-full">
      {/* A bare <table>, not the ui Table: that one wraps itself in its own overflow box,
          and the sticky first row must stick to THIS div, the one that scrolls. */}
      <table className="w-full border-collapse text-xs">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri === 0 ? 'sticky top-0 bg-muted font-medium' : 'border-b border-border'}>
              {row.map((cell, ci) => (
                <td key={ci} className="whitespace-nowrap border-r border-border px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
