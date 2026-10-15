import { useCallback, useState } from 'react';
import { safeStorage, storageKey } from '@/lib/storage';
import { isCrmListKey, type CrmListKey } from './lib/sections';
import { isCrmLayout, type CrmLayout } from './lib/table';

/**
 * Per-browser conveniences of the contacts page: the list switch, the List / Table layout
 * and the collapsed sections (CRM_COLLAPSED_KEY, read by the shared useCollapsedSections in
 * src/hooks). Each holds a name or a flag, never contact data, and each read is
 * shape-checked: `JSON.parse('null')` and `JSON.parse('3')` succeed and would crash the
 * first lookup.
 */
export const CRM_LIST_KEY = storageKey('contacts', 'list');
export const CRM_LAYOUT_KEY = storageKey('contacts', 'layout');
export const CRM_COLLAPSED_KEY = storageKey('contacts', 'collapsed');

function usePref<T>(key: string, guard: (value: unknown) => value is T, fallback: T) {
  const [value, setValue] = useState<T>(() => safeStorage.getJson(key, guard) ?? fallback);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      safeStorage.setJson(key, next);
    },
    [key],
  );
  return [value, set] as const;
}

export const useCrmList = () => usePref<CrmListKey>(CRM_LIST_KEY, isCrmListKey, 'all');
export const useCrmLayout = () => usePref<CrmLayout>(CRM_LAYOUT_KEY, isCrmLayout, 'list');
