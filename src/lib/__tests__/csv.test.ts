import { describe, expect, it } from 'vitest';
import { csvBlob, csvCell, parseCsv, toCsv } from '@/lib/csv';

describe('csvCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1555', "'+1555"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\t=1', "'\t=1"],
    ['=HYPERLINK("http://example.test")', `"'=HYPERLINK(""http://example.test"")"`],
  ])('neutralises a formula lead in text: %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('neutralises a leading carriage return, and quotes it', () => {
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('leaves numbers alone, negatives included, so totals still add up', () => {
    expect(csvCell(-42.5)).toBe('-42.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(true)).toBe('true');
  });

  it('leaves ordinary text alone', () => {
    expect(csvCell('Ada Example')).toBe('Ada Example');
    expect(csvCell('a-b')).toBe('a-b');
  });

  it('quotes commas, quotes and line breaks, doubling embedded quotes', () => {
    expect(csvCell('Example, Studio')).toBe('"Example, Studio"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes null and undefined as empty cells', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('toCsv and csvBlob', () => {
  it('joins rows with CRLF', () => {
    expect(toCsv([['Name', 'Amount'], ['Ada', -5], ['=bad', null]])).toBe("Name,Amount\r\nAda,-5\r\n'=bad,");
  });

  it('starts the file with a UTF-8 byte-order mark', async () => {
    const bytes = new Uint8Array(await csvBlob([['é']]).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('parseCsv', () => {
  it('reads back what toCsv writes, the guard apostrophe kept as text', () => {
    const rows = [
      ['Name', 'Note'],
      ['Example, Studio', 'said "yes"\nthen left'],
      ['=1+1', ''],
    ];
    expect(parseCsv(toCsv(rows))).toEqual([rows[0], rows[1], ["'=1+1", '']]);
  });

  it('drops a byte-order mark and empty rows, and accepts LF and lone CR', () => {
    expect(parseCsv('﻿a,b\n\n1,2\r3,4\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});
