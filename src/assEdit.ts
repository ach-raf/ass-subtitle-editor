import type { ScriptInfoEntry, SectionRow } from './types';

export interface FieldEdit {
  line: number;
  startChar: number;
  endChar: number;
  newContent: string;
}

export function computeFieldEdit(row: SectionRow, fieldIndex: number, newValue: string): FieldEdit | null {
  if (!row.ok) return null;
  const range = row.fieldRanges[fieldIndex];
  if (!range) return null;
  return { line: row.line, startChar: range.startChar, endChar: range.endChar, newContent: newValue };
}

export function computeScriptInfoEdit(entry: ScriptInfoEntry, newValue: string): FieldEdit {
  return {
    line: entry.line,
    startChar: entry.valueRange.startChar,
    endChar: entry.valueRange.endChar,
    newContent: newValue,
  };
}

// Re-derive the comma count from the live line; if it no longer matches the
// parsed format length, the parse is stale and the edit must be aborted.
export function rowStillValid(currentLineText: string, row: SectionRow): boolean {
  const colonIdx = currentLineText.indexOf(':');
  if (colonIdx === -1) return false;
  const valuePart = currentLineText.slice(colonIdx + 1).replace(/^\s+/, '');
  const commas = countCommas(valuePart);
  // A line is structurally still a valid row if it has at least
  // `format.length - 1` commas. The greedy trailing field (e.g. the Events
  // `Text` field) legitimately absorbs any extra commas contained in its
  // content (e.g. `Dialogue: ...,Default,,0,0,0,,Hello, world`). Fewer than
  // `format.length - 1` commas means a field was lost, so the stored ranges
  // are stale and the edit must be aborted.
  return commas >= row.format.length - 1;
}

function countCommas(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === ',') n++;
  return n;
}
