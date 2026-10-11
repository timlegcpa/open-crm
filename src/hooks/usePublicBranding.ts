import { useEffect, useState } from 'react';
import { fetchPublicBranding, type PublicBranding } from '@/lib/publicEdge';

/**
 * The organization's display name and logo path on a PUBLIC page (no session, no
 * supabase-js). Both are null until known and stay null if the lookup fails: branding is
 * decoration, and a public page must work without it.
 */
export function usePublicBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>({ displayName: null, logoPath: null });

  useEffect(() => {
    const controller = new AbortController();
    void fetchPublicBranding(controller.signal).then((value) => {
      if (!controller.signal.aborted) setBranding(value);
    });
    return () => controller.abort();
  }, []);

  return branding;
}
