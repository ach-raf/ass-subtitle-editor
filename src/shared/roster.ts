import type { SectionRow } from '../types';

/** Lightweight per-event row used to drive the virtualized list and search.
 *  No decoded tags, no full Text — those arrive on demand via eventDetail. */
export interface RosterRow {
  line: number;
  Start: string;
  End: string;
  Style: string;
  preview: string; // override tags stripped, line breaks flattened, truncated
}

const PREVIEW_MAX = 80;

/** Strip ASS override tags {\...}, flatten \N/\n breaks, collapse whitespace,
 *  truncate to PREVIEW_MAX. Mirrors the webview's prior stripTagsForPreview. */
export function previewOf(text: string): string {
  const clean = (text || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > PREVIEW_MAX ? clean.slice(0, PREVIEW_MAX) : clean;
}

export function buildRosterRow(row: SectionRow): RosterRow {
  const f = row.fields;
  return {
    line: row.line,
    Start: f.Start ?? '',
    End: f.End ?? '',
    Style: f.Style ?? '',
    preview: previewOf(f.Text ?? ''),
  };
}

/** Indices into `roster` whose Style or preview contains `query`
 *  (case-insensitive). Empty/whitespace query → all indices. */
export function filterRosterIndices(roster: RosterRow[], query: string): number[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    const all = new Array<number>(roster.length);
    for (let i = 0; i < roster.length; i++) all[i] = i;
    return all;
  }
  const out: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    const r = roster[i];
    if (r.Style.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/** Replace the roster entry whose line matches, in place. Returns true if found. */
export function patchRosterEntry(roster: RosterRow[], line: number, patch: RosterRow): boolean {
  for (let i = 0; i < roster.length; i++) {
    if (roster[i].line === line) { roster[i] = patch; return true; }
  }
  return false;
}

/** Split `rows` into pages of `size` for chunked transfer. */
export function chunkRoster(rows: RosterRow[], size: number): RosterRow[][] {
  const out: RosterRow[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
