import { useEffect } from 'react';

const PORTAL_META = [
  { name: 'robots', content: 'noindex, nofollow' },
  { name: 'referrer', content: 'no-referrer' },
] as const;

/**
 * While the portal is open: search engines are told not to index it, and no page address
 * leaves in a Referer. An existing tag is reused and its old content put back on the way
 * out; a tag this hook added is removed.
 */
export function usePortalMeta(): void {
  useEffect(() => {
    const restore: Array<() => void> = [];
    for (const { name, content } of PORTAL_META) {
      const existing = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (existing) {
        const previous = existing.getAttribute('content');
        existing.setAttribute('content', content);
        restore.push(() => {
          if (previous === null) existing.removeAttribute('content');
          else existing.setAttribute('content', previous);
        });
      } else {
        const tag = document.createElement('meta');
        tag.setAttribute('name', name);
        tag.setAttribute('content', content);
        document.head.appendChild(tag);
        restore.push(() => tag.remove());
      }
    }
    return () => restore.forEach((undo) => undo());
  }, []);
}
