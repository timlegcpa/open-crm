import { useQuery } from '@tanstack/react-query';
import { signWorkingUrls } from '../api';
import type { DocumentRow } from '../contract';
import { esignKeys } from '../keys';

/**
 * Signed links to a draft's working PDFs, by document id, for pdf.js to fetch. The links
 * live thirty minutes; the cache refreshes them well before that, and only when the set of
 * documents changes otherwise, so moving between pages never re-signs them.
 */
export function useWorkingUrls(envelopeId: string, documents: readonly DocumentRow[]): Record<string, string> {
  const paths = documents.map((d) => d.storage_path).sort();
  const signed = useQuery({
    queryKey: esignKeys.workingUrls(envelopeId, paths.join('|')),
    queryFn: () => signWorkingUrls(paths),
    enabled: paths.length > 0,
    staleTime: 20 * 60_000,
    refetchInterval: 20 * 60_000,
  });
  const byPath = signed.data ?? {};
  const out: Record<string, string> = {};
  for (const doc of documents) {
    const url = byPath[doc.storage_path];
    if (url) out[doc.id] = url;
  }
  return out;
}
