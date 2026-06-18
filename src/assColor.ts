export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number; // opacity 0..1 (1 = fully opaque)
}

// ASS colors are &HAABBGGRR (Alpha inverted: 00 = opaque, FF = transparent).
export function parseAssColor(code: string): RgbaColor | null {
  const m = /^&H([0-9A-Fa-f]+)&?$/.exec(code.trim());
  if (!m) return null;
  let hex = m[1].toUpperCase();
  if (hex.length > 8 || hex.length < 3) return null;
  hex = hex.padStart(8, '0'); // left-pad to AABBGGRR
  const aa = parseInt(hex.slice(0, 2), 16);
  const bb = parseInt(hex.slice(2, 4), 16);
  const gg = parseInt(hex.slice(4, 6), 16);
  const rr = parseInt(hex.slice(6, 8), 16);
  if ([aa, bb, gg, rr].some((n) => Number.isNaN(n))) return null;
  return { r: rr, g: gg, b: bb, a: (255 - aa) / 255 };
}

const HEX = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

export function toAssColor(c: RgbaColor): string {
  const aa = Math.round(255 - c.a * 255);
  return `&H${HEX(aa)}${HEX(c.b)}${HEX(c.g)}${HEX(c.r)}`;
}

export function toHex(c: RgbaColor): string {
  return `#${HEX(c.r)}${HEX(c.g)}${HEX(c.b)}`;
}

export function fromHex(hex: string, a = 1): RgbaColor | null {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a,
  };
}
