import { parseAssColor, toHex } from './assColor';
import { parseDialogueFragments } from './assTags';
import type { RenderRun, RenderStyle } from './shared/render';
import type { AssModel, SectionRow } from './types';

export type { RenderRun, RenderStyle } from './shared/render';

/** A resolved base style doubles as the seed each override tag mutates while we
 *  walk the fragments. */
export type ResolvedStyle = RenderStyle;

const NUM = (s: string | undefined, def = 0): number => {
  const n = parseFloat((s || '').trim());
  return Number.isFinite(n) ? n : def;
};

/** Resolve a [V4+ Styles] row into a RenderStyle seed. Style colors are full
 *  &HAABBGGRR& (via parseAssColor); bools use the -1 / 0 convention. */
export function resolveBaseStyle(row: SectionRow | undefined): ResolvedStyle {
  const f = row?.fields ?? {};
  const primary = parseAssColor(f.PrimaryColour || '');
  const outline = parseAssColor(f.OutlineColour || '');
  const back = parseAssColor(f.BackColour || '');
  const fs = NUM(f.Fontsize, 48);
  const shad = NUM(f.Shadow, 0);
  return {
    color: primary ? toHex(primary) : undefined,
    opacity: primary ? primary.a : 1,
    fontFamily: f.Fontname || undefined,
    fontSize: fs,
    fontWeight: f.Bold === '-1' ? 'bold' : 'normal',
    fontStyle: f.Italic === '-1' ? 'italic' : 'normal',
    underline: f.Underline === '-1',
    strikeout: f.StrikeOut === '-1',
    bord: NUM(f.Outline, 0),
    bordColor: outline ? toHex(outline) : undefined,
    bordOpacity: outline ? outline.a : 1,
    shad: [shad, shad],
    shadColor: back ? toHex(back) : undefined,
    shadOpacity: back ? back.a : 1,
    scaleX: NUM(f.ScaleX, 100) / 100,
    scaleY: NUM(f.ScaleY, 100) / 100,
    rotate: NUM(f.Angle, 0),
    blur: 0,
  };
}

/** Used when the file defines no styles at all — a sane white-on-black default. */
const DEFAULT_STYLE_ROW: SectionRow = {
  kind: 'style', line: -1, ok: true, format: [], fieldRanges: [], raw: '',
  fields: {
    Name: 'Default', Fontname: 'Arial', Fontsize: '48',
    PrimaryColour: '&H00FFFFFF&', OutlineColour: '&H00000000&', BackColour: '&H80000000&',
    Bold: '0', Italic: '0', Underline: '0', StrikeOut: '0',
    ScaleX: '100', ScaleY: '100', Angle: '0', Outline: '2', Shadow: '2',
  },
};

/** Find a style row by Name; fall back to the first style, then to the default. */
export function resolveStyleRow(model: AssModel, name: string | undefined): SectionRow {
  const rows = model.styles.rows;
  if (name) {
    const hit = rows.find((r) => r.fields.Name === name);
    if (hit) return hit;
  }
  return rows[0] ?? DEFAULT_STYLE_ROW;
}

/** ASS override colors are 6-hex BBGGRR (ass-compiler strips the &H/& wrappers).
 *  → #RRGGBB for CSS. */
function bgrToHex(v: unknown): string | undefined {
  const h = String(v ?? '').trim().toUpperCase().padStart(6, '0');
  return /^[0-9A-F]{6}$/.test(h) ? '#' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2) : undefined;
}

/** ASS override alpha is 2-hex (00 opaque … FF transparent). → opacity 0..1. */
function alphaToOpacity(v: unknown): number | undefined {
  const h = String(v ?? '').trim().toUpperCase().padStart(2, '0');
  if (!/^[0-9A-F]{2}$/.test(h)) return undefined;
  return (255 - parseInt(h, 16)) / 255;
}

function snapshot(st: ResolvedStyle): RenderStyle {
  // Clone shad so run snapshots can't be aliased to the accumulator's array.
  return { ...st, shad: st.shad ? [st.shad[0], st.shad[1]] : undefined };
}

/** Mutate `st` in place to apply a single override tag. `base` is the pristine
 *  seed, used by \r to reset. Unknown / v1-ignored tags (pos, fad, t, clip, …)
 *  fall through to `default`. */
function applyTag(st: ResolvedStyle, tag: Record<string, unknown>, base: ResolvedStyle): void {
  for (const name of Object.keys(tag)) {
    const v = tag[name];
    switch (name) {
      case 'c1': { const c = bgrToHex(v); if (c) st.color = c; break; }
      case 'c3': { const c = bgrToHex(v); if (c) st.bordColor = c; break; }
      case 'c4': { const c = bgrToHex(v); if (c) st.shadColor = c; break; }
      case 'c2': break;                       // secondary (karaoke) — not rendered
      case 'a1': { const o = alphaToOpacity(v); if (o != null) st.opacity = o; break; }
      case 'a3': { const o = alphaToOpacity(v); if (o != null) st.bordOpacity = o; break; }
      case 'a4': { const o = alphaToOpacity(v); if (o != null) st.shadOpacity = o; break; }
      case 'a2': break;
      case 'alpha': { const o = alphaToOpacity(v); if (o != null) { st.opacity = o; st.bordOpacity = o; st.shadOpacity = o; } break; }
      case 'fn': st.fontFamily = String(v); break;
      case 'fs': { const n = parseFloat(String(v)); if (Number.isFinite(n) && n > 0) st.fontSize = n; break; }
      case 'b': st.fontWeight = v === 1 ? 'bold' : 'normal'; break;
      case 'i': st.fontStyle = v === 1 ? 'italic' : 'normal'; break;
      case 'u': st.underline = v === 1; break;
      case 's': st.strikeout = v === 1; break;
      case 'bord': case 'xbord': case 'ybord': st.bord = Math.max(0, Number(v) || 0); break;
      case 'shad': { const n = Math.max(0, Number(v) || 0); st.shad = [n, n]; break; }
      case 'xshad': st.shad = [Math.max(0, Number(v) || 0), st.shad?.[1] ?? 0]; break;
      case 'yshad': st.shad = [st.shad?.[0] ?? 0, Math.max(0, Number(v) || 0)]; break;
      case 'fscx': st.scaleX = (Number(v) || 100) / 100; break;
      case 'fscy': st.scaleY = (Number(v) || 100) / 100; break;
      case 'frz': st.rotate = Number(v) || 0; break;
      case 'blur': case 'be': st.blur = Math.max(0, Number(v) || 0); break;
      case 'r':
        Object.assign(st, base);
        if (st.shad) st.shad = [st.shad[0], st.shad[1]];
        break;
      // Ignored in v1 (no layout / animation / karaoke): pos, move, org, fad,
      // fade, t, clip, iclip, frx, fry, fax, fay, an, a, k/K/kf/ko/kt, fe, fsp,
      // q, pbo, p (drawing mode is handled in renderRuns).
      default: break;
    }
  }
}

/** Walk the parsed fragments, mutating a running style from `base`, emitting
 *  one RenderRun per text fragment. Drawing fragments become empty isDrawing
 *  runs so the webview knows to skip them. */
export function renderRuns(text: string, base: ResolvedStyle): RenderRun[] {
  const fragments = parseDialogueFragments(text);
  if (!fragments.length) {
    // No override blocks (or parse failed): plain text, one base-styled run.
    const norm = (text || '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, '\u00A0');
    return norm ? [{ text: norm, style: { ...base, shad: base.shad ? [base.shad[0], base.shad[1]] : undefined } }] : [];
  }
  const st: ResolvedStyle = { ...base, shad: base.shad ? [base.shad[0], base.shad[1]] : undefined };
  let drawing = false;
  const runs: RenderRun[] = [];

  for (const frag of fragments) {
    for (const tag of frag.tags) {
      applyTag(st, tag, base);
      if (tag.p != null) drawing = (tag.p as number) > 0;
    }
    if (drawing || (frag.drawing && frag.drawing.length)) {
      // Vector data — no glyphs to render; carry the (possibly toggled) state.
      continue;
    }
    const norm = (frag.text || '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, '\u00A0');
    if (norm) runs.push({ text: norm, style: snapshot(st) });
  }
  return runs;
}
