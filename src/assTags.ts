import { parse } from 'ass-compiler';

export interface DecodedTag {
  name: string;
  raw: string;
  value: string;
}

// ass-compiler parses a whole file; we wrap a single Text value in a minimal
// Events section so it parses just the override tags for us. The real parsed
// shape (observed from ass-compiler 0.1.16) is:
//   Text = { raw, combined, parsed: Array<{ tags: ParsedTag[]; text; drawing }> }
// where each ParsedTag is a single-key object whose key is the tag name
// (e.g. `{ pos: [320, 400] }`, `{ fad: [200, 200] }`, `{ b: 1 }`).
export function decodeDialogueTags(text: string): DecodedTag[] {
  if (!text) return [];
  try {
    const wrapped =
      '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      `Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,${text}`;
    const parsed = parse(wrapped);
    const dialogueText = parsed.events.dialogue[0].Text;
    const fragments = dialogueText.parsed;
    const tags: DecodedTag[] = [];
    for (const fragment of fragments) {
      for (const tag of fragment.tags) {
        const decoded = decodeTag(tag);
        if (decoded) tags.push(decoded);
      }
    }
    return tags;
  } catch {
    return [];
  }
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
