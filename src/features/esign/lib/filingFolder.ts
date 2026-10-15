import { FILING_FOLDER_MAX } from '../contract';

/** A folder name the documents explorer can show: no slashes, no control characters. */
const BAD_FOLDER = /[/\\\u0000-\u001f\u007f]/;

export function filingFolderProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Enter a folder name.';
  if (v.length > FILING_FOLDER_MAX) return `Keep it to ${FILING_FOLDER_MAX} characters.`;
  if (BAD_FOLDER.test(v)) return 'A folder name cannot contain a slash or a control character.';
  return null;
}
