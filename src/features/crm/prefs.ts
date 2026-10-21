import { safeStorage, storageKey } from '@/lib/storage';
import { isCrmTabKey, type CrmTabKey } from './lib/sections';

/**
 * Per-browser convenience of the contacts page: the last tab chosen. It holds a name,
 * never contact data, and its read is shape-checked:
 * `JSON.parse('null')` and `JSON.parse('3')` succeed and would crash the first lookup.
 */
export const CRM_TAB_KEY = storageKey('contacts', 'tab');

/**
 * The remembered tab, or null. Read on every render, never captured once: the page stays
 * mounted while a record is open, and a value captured at load would send the owner back
 * to the tab they started from rather than the one they left.
 */
export function storedCrmTab(): CrmTabKey | null {
  return safeStorage.getJson(CRM_TAB_KEY, isCrmTabKey);
}

export function rememberCrmTab(tab: CrmTabKey): void {
  safeStorage.setJson(CRM_TAB_KEY, tab);
}
