import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage, storageKey } from '@/lib/storage';

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeStorage', () => {
  it('namespaces keys', () => {
    expect(storageKey('board', 'filters')).toBe('open-crm:board:filters');
  });

  it('reads and writes strings and JSON', () => {
    expect(safeStorage.set('k', 'v')).toBe(true);
    expect(safeStorage.get('k')).toBe('v');
    expect(safeStorage.setJson('list', ['a', 'b'])).toBe(true);
    expect(safeStorage.getJson('list', isStringList)).toEqual(['a', 'b']);
    safeStorage.remove('k');
    expect(safeStorage.get('k')).toBeNull();
  });

  it('refuses stored JSON of the wrong shape, or not JSON at all', () => {
    localStorage.setItem('list', '{"a":1}');
    expect(safeStorage.getJson('list', isStringList)).toBeNull();
    localStorage.setItem('list', '{not json');
    expect(safeStorage.getJson('list', isStringList)).toBeNull();
  });

  it('never throws when the browser refuses storage outright', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(safeStorage.get('k')).toBeNull();
      expect(safeStorage.set('k', 'v')).toBe(false);
      expect(() => safeStorage.remove('k')).not.toThrow();
      expect(safeStorage.getJson('k', isStringList)).toBeNull();
      expect(safeStorage.setJson('k', ['v'])).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor!);
    }
  });

  it('reports a write the quota refused', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(safeStorage.set('k', 'v')).toBe(false);
    expect(safeStorage.setJson('k', { a: 1 })).toBe(false);
  });

  it('cannot store a value JSON cannot represent', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(safeStorage.setJson('k', loop)).toBe(false);
  });
});
