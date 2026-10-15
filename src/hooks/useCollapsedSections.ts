import { useCallback, useState } from 'react';
import { safeStorage } from '@/lib/storage';

function isFlagMap(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'boolean')
  );
}

/**
 * Which collapsible sections are shut, remembered in this browser under `key` (a
 * storageKey(...) name). A collapsible section starts collapsed (`?? true`), and a corrupt
 * entry falls back to the same state rather than blanking the pane: `JSON.parse('3')`
 * succeeds and would crash the first lookup, so the stored value is shape-checked.
 */
export function useCollapsedSections(key: string) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => safeStorage.getJson(key, isFlagMap) ?? {});
  const toggle = useCallback(
    (section: string) => {
      setCollapsed((prev) => {
        const next = { ...prev, [section]: !(prev[section] ?? true) };
        safeStorage.setJson(key, next);
        return next;
      });
    },
    [key],
  );
  return { collapsed, toggle };
}
