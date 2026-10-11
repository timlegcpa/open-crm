import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy text and remember, briefly, which value was copied, so the control that copied it can
 * show a check. `copy` resolves to whether the text really reached the clipboard: the API is
 * missing on an insecure origin and can be refused by the browser. On failure `copiedKey`
 * stays null, so no success mark is ever shown for a copy that did not happen.
 */
export function useCopyToClipboard(resetMs = 1500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (text: string, key: string = text): Promise<boolean> => {
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopiedKey(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedKey(null), resetMs);
      return true;
    },
    [resetMs],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { copy, copiedKey };
}
