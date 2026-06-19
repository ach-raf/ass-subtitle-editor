import { parse } from 'ass-compiler';

export interface DecodedTag {
  name: string;
  raw: string;
  value: string;
}

/** One parsed fragment of a Dialogue Text value: the override tags in a single
 *  {\…} block, plus the text that follows it (until the next block). ass-compiler
 *  parses a whole file, so we wrap a lone Text value in a minimal Events section.
 *  Shared by decodeDialogueTags (tag chips) and renderRuns (styled preview). */
export interface DialogueFragment {
  tags: Record<string, unknown>[]; // each tag is a single-key object, e.g. { pos: [320,400] }
  text: string;
  drawing: unknown[];            // non-empty when \p drawing mode produced vector data
}

export function parseDialogueFragments(text: string): DialogueFragment[] {
  if (!text) return [];
  try {
    const wrapped =
      '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      `Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,${text}`;
    const parsed = parse(wrapped);
    return parsed.events.dialogue[0].Text.parsed as unknown as DialogueFragment[];
  } catch {
    return [];
  }
}

/** Flatten every override tag across all fragments into {name, value} chips. */
export function decodeDialogueTags(text: string): DecodedTag[] {
  const tags: DecodedTag[] = [];
  for (const fragment of parseDialogueFragments(text)) {
    for (const tag of fragment.tags) {
      const decoded = decodeTag(tag);
      if (decoded) tags.push(decoded);
    }
  }
  return tags;
}

// Each parsed tag is a single-key object: { [name]: value }. Extract the name
// (the key) and serialize the value (arrays join with ',', everything else
// stringifies). Skip control pseudo-tags that ass-compiler may emit (none
// currently, but guard against multi/zero-key objects defensively).
function decodeTag(tag: Record<string, unknown>): DecodedTag | undefined {
  const keys = Object.keys(tag);
  if (keys.length === 0) return undefined;
  const name = keys[0];
  const raw = name;
  const value = serializeValue(tag[name]);
  return { name, raw, value };
}

function serializeValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(',');
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
