import type { AssModel, FieldRange, ScriptInfoEntry, SectionRow } from './types';

const BOM = '﻿';

type Section = 'scriptInfo' | 'styles' | 'events' | null;

/**
 * Split the value part of a `Style:`/`Dialogue:`/`Comment:` row into exactly
 * `format.length` fields, where the LAST field is greedy and may itself contain
 * commas (the Events `Text` field). We stop splitting after `format.length - 1`
 * commas so any further commas belong to the final field.
 *
 * Returns the field values plus, for each, the char range of that value's slice
 * within the full original line (offset by `prefixLen`, the index in the line
 * where `valuePart` begins).
 */
function splitFields(valuePart: string, prefixLen: number, format: string[]): {
  fields: string[];
  ranges: FieldRange[];
} {
  const parts: string[] = [];
  const starts: number[] = [];
  let i = 0;
  for (let k = 0; k < format.length - 1; k++) {
    starts.push(i);
    const comma = valuePart.indexOf(',', i);
    if (comma === -1) {
      // Not enough commas: field count mismatch. Capture the remainder as the
      // last field we can fill; remaining format slots get empty strings so the
      // returned arrays stay parallel to `format`.
      parts.push(valuePart.slice(i));
      i = valuePart.length;
      for (let r = k + 1; r < format.length; r++) {
        starts.push(i);
        parts.push('');
      }
      return finalize(parts, starts, prefixLen);
    }
    parts.push(valuePart.slice(i, comma));
    i = comma + 1;
  }
  // Last (greedy) field — everything from the current position to end of string.
  starts.push(i);
  parts.push(valuePart.slice(i));
  return finalize(parts, starts, prefixLen);
}

function finalize(parts: string[], starts: number[], prefixLen: number): {
  fields: string[];
  ranges: FieldRange[];
} {
  const ranges: FieldRange[] = parts.map((p, idx) => {
    const startChar = prefixLen + starts[idx];
    return { line: 0, startChar, endChar: startChar + p.length };
  });
  return { fields: parts, ranges };
}

function countCommas(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === ',') n++;
  return n;
}

export function parseAss(raw: string): AssModel {
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(BOM.length) : raw;
  // Normalize CRLF (and lone CR) to LF before splitting: the per-line row
  // regexes anchor on `$`, and in JS `.` does not match `\r`, so a trailing
  // `\r` (Windows/Aegisub-authored files use CRLF) made every Script Info /
  // Format / Style / Dialogue line fail to match — yielding an empty model.
  // The original EOL is remembered so reemitAss can reproduce it byte-for-byte.
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n|\r/g, '\n').split('\n');

  const model: AssModel = {
    bom,
    crlf,
    scriptInfo: [],
    styles: { format: [], rows: [] },
    events: { format: [], rows: [] },
    verbatim: [],
  };

  let section: Section = null;

  lines.forEach((lineText, line) => {
    const trimmed = lineText.trim();
    const headerMatch = /^\[(.+)\]$/.exec(trimmed);
    if (headerMatch) {
      const name = headerMatch[1].toLowerCase();
      if (name.includes('script info')) section = 'scriptInfo';
      else if (name.includes('v4') && name.includes('style')) section = 'styles';
      else if (name === 'events') section = 'events';
      else section = null;
      model.verbatim.push({ line, text: lineText });
      return;
    }

    if (section === 'scriptInfo') {
      const kv = /^([A-Za-z0-9_]+):( ?)(.*)$/.exec(lineText);
      if (kv) {
        // Compute valueStart from the match offsets rather than
        // `lineText.indexOf(value)`, which for `Title: Title` would find the
        // value substring at the KEY position (offset 0) and cause value edits
        // to overwrite the key. `kv[1]` is the key, `kv[2]` the leading spaces
        // after the colon, `kv[3]` the value.
        const leadingSpaces = kv[2];
        const valueStart = (kv.index ?? 0) + kv[1].length + 1 + leadingSpaces.length;
        const entry: ScriptInfoEntry = {
          key: kv[1],
          value: kv[3],
          line,
          raw: lineText,
          valueRange: { line, startChar: valueStart, endChar: valueStart + kv[3].length },
        };
        model.scriptInfo.push(entry);
        return;
      }
    }

    if (section === 'styles' || section === 'events') {
      const fmt = /^Format:\s?(.*)$/i.exec(lineText);
      if (fmt) {
        const format = fmt[1].split(',').map((s) => s.trim());
        if (section === 'styles') model.styles.format = format;
        else model.events.format = format;
        model.verbatim.push({ line, text: lineText });
        return;
      }
      const row = /^Style:\s?(.*)$/i.exec(lineText)
        ?? (/^Dialogue:\s?(.*)$/i.exec(lineText))
        ?? (/^Comment:\s?(.*)$/i.exec(lineText));
      if (row) {
        const kind = /^Style:/i.test(lineText)
          ? 'style'
          : /^Dialogue:/i.test(lineText)
            ? 'dialogue'
            : 'comment';
        const prefixLen = lineText.indexOf(row[1]);
        const format = section === 'styles' ? model.styles.format : model.events.format;
        const { fields, ranges } = splitFields(row[1], prefixLen, format);
        const fieldMap: Record<string, string> = {};
        format.forEach((name, idx) => { fieldMap[name] = fields[idx] ?? ''; });
        // `ok` is true iff the value part has at least `format.length - 1`
        // commas — i.e. enough to populate every format column. With fewer, the
        // row is malformed and is kept verbatim (lenient: never dropped).
        const ok = format.length === 0
          ? row[1].length === 0
          : countCommas(row[1]) >= format.length - 1;
        const sectionRow: SectionRow = {
          kind,
          format,
          fields: fieldMap,
          fieldRanges: ranges.map((r) => ({ ...r, line })),
          line,
          raw: lineText,
          ok,
        };
        if (section === 'styles') model.styles.rows.push(sectionRow);
        else model.events.rows.push(sectionRow);
        return;
      }
    }

    model.verbatim.push({ line, text: lineText });
  });

  return model;
}

export function reemitAss(model: AssModel): string {
  const entries: { line: number; text: string }[] = [];
  for (const e of model.scriptInfo) entries.push({ line: e.line, text: e.raw });
  for (const r of model.styles.rows) entries.push({ line: r.line, text: r.raw });
  for (const r of model.events.rows) entries.push({ line: r.line, text: r.raw });
  for (const v of model.verbatim) entries.push({ line: v.line, text: v.text });
  entries.sort((a, b) => a.line - b.line);
  const eol = model.crlf ? '\r\n' : '\n';
  const text = entries.map((e) => e.text).join(eol);
  return (model.bom ? BOM : '') + text;
}
