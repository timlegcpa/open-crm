import { useEffect, useState } from 'react';
import { fetchPublicBranding, NO_BRANDING, type PublicBranding } from '@/lib/publicEdge';

/**
 * The organization's public identity on a PUBLIC page (no session, no supabase-js): display
 * and legal names, logo path, contact address. Each is null until known and stay null if the lookup fails: branding is
 * decoration, and a public page must work without it.
 */
export function usePublicBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>(NO_BRANDING);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPublicBranding(controller.signal).then((value) => {
      if (!controller.signal.aborted) setBranding(value);
    });
    return () => controller.abort();
  }, []);

  return branding;
}
