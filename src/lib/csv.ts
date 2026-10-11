/**
 * CSV in both directions. Every CSV this app WRITES goes through `toCsv` (or `csvCell`), so
 * quoting and the formula guard are defined exactly once; `parseCsv` is the one reader.
 */

/**
 * Leading characters Excel, LibreOffice and Google Sheets read as the start of a formula.
 * Tab and carriage return count because both are stripped before the parse, exposing the
 * character behind them.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One cell, safe by default, because every file this writes is opened by a person in a
 * spreadsheet. Text that a contact or a lead form supplied (a name like
 * `=HYPERLINK("http://...")`) would otherwise run as a formula the moment the export is
 * opened; a leading `'` makes the cell plain text, and spreadsheets do not display it.
 *
 * Numbers are never prefixed: a negative amount leads with `-`, and turning it into text
 * would break every total in the sheet. Only text can carry an injected formula.
 *
 * A cell is quoted when it holds a comma, a quote or a line break, with embedded quotes
 * doubled: the same rules `parseCsv` reads.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Rows to CSV text. Rows are joined with CRLF: a lone LF makes Excel read the file as one
 * long row on some Windows locales.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * CSV text as a downloadable Blob. The byte-order mark makes Excel read the file as UTF-8,
 * so accented names survive; other spreadsheets ignore it.
 */
export function csvBlob(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): Blob {
  return new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
}

/**
 * RFC 4180 reader: quoted fields, doubled quotes, commas and line breaks inside quotes,
 * CRLF / LF / lone-CR row breaks. Drops a leading byte-order mark and fully empty rows.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
