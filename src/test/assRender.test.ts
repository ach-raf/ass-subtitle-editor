import assert from 'node:assert';
import { renderRuns, resolveBaseStyle, resolveStyleRow } from '../assRender';
import type { AssModel, SectionRow } from '../types';

const STYLE_FMT = ['Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour', 'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding'];
function styleRow(over: Partial<Record<string, string>> = {}): SectionRow {
  return {
    kind: 'style', line: 0, ok: true, format: STYLE_FMT, fieldRanges: [], raw: '',
    fields: {
      Name: 'Default', Fontname: 'Arial', Fontsize: '48',
      PrimaryColour: '&H00FFFFFF&', SecondaryColour: '&H000000FF&', OutlineColour: '&H00000000&', BackColour: '&H80000000&',
      Bold: '0', Italic: '0', Underline: '0', StrikeOut: '0',
      ScaleX: '100', ScaleY: '100', Spacing: '0', Angle: '0', BorderStyle: '1', Outline: '2', Shadow: '2',
      Alignment: '2', MarginL: '10', MarginR: '10', MarginV: '20', Encoding: '1',
      ...over,
    },
  } as SectionRow;
}

describe('resolveBaseStyle', () => {
  it('reads font, size, colors, bools, bord/shad/scale/angle', () => {
    const b = resolveBaseStyle(styleRow());
    assert.strictEqual(b.fontFamily, 'Arial');
    assert.strictEqual(b.fontSize, 48);
    assert.strictEqual(b.color, '#FFFFFF');
    assert.strictEqual(b.opacity, 1);
    assert.strictEqual(b.fontWeight, 'normal');
    assert.strictEqual(b.bord, 2);
    assert.strictEqual(b.bordColor, '#000000');
    assert.deepStrictEqual(b.shad, [2, 2]);
    assert.strictEqual(b.scaleX, 1);
    assert.strictEqual(b.rotate, 0);
  });
  it('parses -1 as bold / italic / underline / strikeout', () => {
    const b = resolveBaseStyle(styleRow({ Bold: '-1', Italic: '-1', Underline: '-1', StrikeOut: '-1' }));
    assert.strictEqual(b.fontWeight, 'bold');
    assert.strictEqual(b.fontStyle, 'italic');
    assert.strictEqual(b.underline, true);
    assert.strictEqual(b.strikeout, true);
  });
  it('handles a missing row with sane defaults', () => {
    const b = resolveBaseStyle(undefined);
    assert.strictEqual(b.fontSize, 48);
    assert.strictEqual(b.opacity, 1);
  });
});

describe('resolveStyleRow', () => {
  const model = {
    styles: { format: STYLE_FMT, rows: [styleRow({ Name: 'Default' }), styleRow({ Name: 'OP' })] },
  } as unknown as AssModel;
  it('finds by name', () => {
    assert.strictEqual(resolveStyleRow(model, 'OP').fields.Name, 'OP');
  });
  it('falls back to the first style when the name is absent', () => {
    assert.strictEqual(resolveStyleRow(model, 'Missing').fields.Name, 'Default');
  });
  it('falls back to the built-in default when there are no styles', () => {
    const empty = { styles: { format: [], rows: [] } } as unknown as AssModel;
    assert.strictEqual(resolveStyleRow(empty, 'X').fields.Fontname, 'Arial');
  });
});

describe('renderRuns', () => {
  const base = resolveBaseStyle(styleRow());

  it('plain text → one run with the base style', () => {
    const r = renderRuns('Hello world', base);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text, 'Hello world');
    assert.strictEqual(r[0].style.color, '#FFFFFF');
  });

  it('applies a single override block', () => {
    const r = renderRuns('{\\b1\\c&H0000FF&\\fs12}Hatred', base);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text, 'Hatred');
    assert.strictEqual(r[0].style.fontWeight, 'bold');
    assert.strictEqual(r[0].style.color, '#FF0000'); // BBGGRR 0000FF → red
    assert.strictEqual(r[0].style.fontSize, 12);
  });

  it('carries the cumulative style across runs', () => {
    const r = renderRuns('{\\b1}A{\\i1}B', base);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].text, 'A');
    assert.strictEqual(r[0].style.fontWeight, 'bold');
    assert.strictEqual(r[0].style.fontStyle, 'normal');
    assert.strictEqual(r[1].text, 'B');
    assert.strictEqual(r[1].style.fontWeight, 'bold'); // carried forward
    assert.strictEqual(r[1].style.fontStyle, 'italic');
  });

  it('resets to the base style on \\r', () => {
    const r = renderRuns('{\\b1\\c&H0000FF&}A{\\r}B', base);
    assert.strictEqual(r[1].text, 'B');
    assert.strictEqual(r[1].style.fontWeight, 'normal');
    assert.strictEqual(r[1].style.color, '#FFFFFF');
  });

  it('normalizes \\N to a newline and \\h to a non-breaking space', () => {
    assert.strictEqual(renderRuns('a\\Nb\\hc', base)[0].text, 'a\nb\u00A0c');
  });

  it('maps \\1a to opacity', () => {
    const r = renderRuns('{\\1a&H80&}x', base);
    assert.strictEqual(Math.round((r[0].style.opacity ?? 1) * 100), 50);
  });

  it('maps border / shadow / blur / scale / rotate', () => {
    const s = renderRuns('{\\bord4\\3c&HFF0000&\\shad3\\4c&H00FF00&\\blur2\\fscx200\\frz5}x', base)[0].style;
    assert.strictEqual(s.bord, 4);
    assert.strictEqual(s.bordColor, '#0000FF');   // FF0000 BBGGRR → blue
    assert.deepStrictEqual(s.shad, [3, 3]);
    assert.strictEqual(s.shadColor, '#00FF00');   // 00FF00 BBGGRR → green
    assert.strictEqual(s.blur, 2);
    assert.strictEqual(s.scaleX, 2);
    assert.strictEqual(s.rotate, 5);
  });

  it('skips \\p drawing fragments', () => {
    const r = renderRuns('{\\p1}m 0 0 l 50 50{\\p0}end', base);
    assert.deepStrictEqual(r.map((x) => x.text), ['end']);
  });

  it('ignores \\pos without crashing or affecting style', () => {
    const r = renderRuns('{\\pos(1497.06,569.68)}x', base);
    assert.strictEqual(r[0].text, 'x');
    assert.strictEqual(r[0].style.color, '#FFFFFF');
  });

  it('returns [] for empty text', () => {
    assert.deepStrictEqual(renderRuns('', base), []);
  });
});
