import { useEffect, useState } from 'react';

/** Tailwind's `lg`: from here the contacts page has room for the index beside a board. */
export const WIDE_QUERY = '(min-width: 1024px)';

/**
 * Whether the window is at least `lg` wide. Below it the contacts page is the index alone
 * (or the record alone), so the board and the table are not mounted at all: no drag
 * sensors and no second copy of every name at phone width.
 */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}
