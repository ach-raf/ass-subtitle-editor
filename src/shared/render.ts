/**
 * Render-run model shared between host (src/assRender.ts) and webview
 * (media/src/panel.js). The host turns an event's Text + its base Style into
 * RenderRun[]; the webview turns each run into a styled <span> via styleToCss.
 *
 * "Minimal" fidelity: styled glyphs only — no \pos / alignment / layout, no
 * simulated video frame. Numeric sizes (fontSize / bord / shad / blur) are in
 * ASS script pixels; the webview multiplies them by `baseFontPx / baseFontSize`
 * so a 48px subtitle and its 4px outline both shrink to fit a list row.
 */

/** Fully-resolved, CSS-mappable style for one run of subtitle text. Every field
 *  is the EFFECTIVE value after merging the base style with the override tags
 *  that precede this run. `undefined` ⇒ not applicable / default. Serializable
 *  (posted to the webview), so keep it plain data. */
export interface RenderStyle {
  color?: string;          // #RRGGBB (primary, \c / \1c)
  opacity?: number;        // 0..1 (from \1a / style alpha)
  fontFamily?: string;     // raw font name (\fn); webview adds a generic fallback
  fontSize?: number;       // ASS px (resolved; defaults to the style's Fontsize)
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  underline?: boolean;
  strikeout?: boolean;
  bord?: number;           // outline width, ASS px (\bord)
  bordColor?: string;      // #RRGGBB (\3c)
  bordOpacity?: number;    // 0..1 (\3a)
  shad?: [number, number]; // [x, y] offset, ASS px (\shad, \xshad, \yshad)
  shadColor?: string;      // #RRGGBB (\4c)
  shadOpacity?: number;    // 0..1 (\4a)
  scaleX?: number;         // 1 = 100% (\fscx)
  scaleY?: number;         // 1 = 100% (\fscy)
  rotate?: number;         // degrees (\frz)
  blur?: number;           // \blur / \be
}

export interface RenderRun {
  /** Visible text. \N / \n are normalized to '\n' (the webview inserts <br>);
   *  \h to a non-breaking space. May be '' for a tag-only fragment. */
  text: string;
  style: RenderStyle;
  /** True for \p drawing fragments — the webview skips rendering them. */
  isDrawing?: boolean;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return null;
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex: string | undefined, opacity: number | undefined): string {
  const rgb = hexToRgb(hex || '');
  if (!rgb) return hex || 'currentColor';
  const a = opacity == null ? 1 : opacity;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** ASS px → preview px, 2 decimals (matches the rest of the panel's sub-px math). */
function px(n: number, scale: number): string {
  return (n * scale).toFixed(2) + 'px';
}

/** Map a resolved RenderStyle to a CSSOM-style props object (camelCase keys),
 *  applied to a <span> via Object.assign(el.style, …). `scale` = baseFontPx /
 *  baseFontSize, converting every ASS-px quantity to preview px uniformly. */
export function styleToCss(style: RenderStyle, scale: number): Record<string, string> {
  const css: Record<string, string> = {};
  if (style.color) css.color = style.color;
  if (style.opacity != null && style.opacity < 1) css.opacity = String(style.opacity);
  if (style.fontFamily) css.fontFamily = `"${style.fontFamily}", var(--ae-font)`;
  if (style.fontSize != null && style.fontSize > 0) css.fontSize = px(style.fontSize, scale);
  if (style.fontWeight) css.fontWeight = style.fontWeight;
  if (style.fontStyle) css.fontStyle = style.fontStyle;
  const deco = [style.underline ? 'underline' : '', style.strikeout ? 'line-through' : '']
    .filter(Boolean).join(' ');
  if (deco) css.textDecoration = deco;

  if (style.bord && style.bord > 0 && style.bordColor) {
    // paint-order keeps the fill on top of the stroke so outlines don't eat glyphs.
    css.webkitTextStroke = `${px(style.bord, scale)} ${rgba(style.bordColor, style.bordOpacity)}`;
    css.paintOrder = 'stroke fill';
  }
  if (style.shad && (style.shad[0] || style.shad[1]) && style.shadColor) {
    css.textShadow = `${px(style.shad[0], scale)} ${px(style.shad[1], scale)} ${rgba(style.shadColor, style.shadOpacity)}`;
  }

  const tf: string[] = [];
  if ((style.scaleX != null && style.scaleX !== 1) || (style.scaleY != null && style.scaleY !== 1)) {
    tf.push(`scale(${style.scaleX ?? 1}, ${style.scaleY ?? 1})`);
  }
  if (style.rotate) tf.push(`rotate(${style.rotate}deg)`);
  if (tf.length) { css.transform = tf.join(' '); css.display = 'inline-block'; }

  // filter needs a box to act on; transform already forced inline-block above.
  if (style.blur && style.blur > 0) {
    css.filter = `blur(${px(style.blur, scale)})`;
    if (!css.display) css.display = 'inline-block';
  }
  return css;
}
