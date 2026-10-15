import { describe, it, expect } from 'vitest';
import { childPath, parentOf } from '../lib/folderPath';

describe('folderPath', () => {
  describe('childPath', () => {
    it('root is "/"', () => {
      expect(childPath('/', 'Name')).toBe('/Name/');
    });

    it('a child of root is "/Name/"', () => {
      expect(childPath('/', 'Docs')).toBe('/Docs/');
    });

    it('a nested child is "/A/B/"', () => {
      expect(childPath('/A/', 'B')).toBe('/A/B/');
    });
  });

  describe('parentOf', () => {
    it('root has no parent: parentOf("/") is "/"', () => {
      expect(parentOf('/')).toBe('/');
    });

    it('the parent of a root child is root', () => {
      expect(parentOf('/Name/')).toBe('/');
    });

    it('the parent of a nested child is one level up', () => {
      expect(parentOf('/A/B/')).toBe('/A/');
    });

    it('round-trips with childPath', () => {
      expect(parentOf(childPath('/A/', 'B'))).toBe('/A/');
      expect(parentOf(childPath('/', 'A'))).toBe('/');
    });
  });
});
