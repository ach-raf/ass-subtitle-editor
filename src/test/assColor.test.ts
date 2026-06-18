import assert from 'node:assert';
import { parseAssColor, toAssColor, toHex, fromHex } from '../assColor';

describe('assColor', () => {
  it('parses &HAABBGGRR (opaque warm white)', () => {
    // AA=00 opaque, BB=F1 GG=F4 RR=F9 -> #F9F4F1
    const c = parseAssColor('&H00F1F4F9')!;
    assert.strictEqual(c.r, 0xf9);
    assert.strictEqual(c.g, 0xf4);
    assert.strictEqual(c.b, 0xf1);
    assert.strictEqual(c.a, 1); // 00 alpha = fully opaque
  });

  it('parses translucent black (BackColour)', () => {
    const c = parseAssColor('&HBE000000')!;
    assert.deepStrictEqual({ r: c.r, g: c.g, b: c.b }, { r: 0, g: 0, b: 0 });
    assert.ok(Math.abs(c.a - ((255 - 0xbe) / 255)) < 1e-6); // ~0.252 opacity
  });

  it('tolerates a trailing &', () => {
    assert.deepStrictEqual(parseAssColor('&H00FFFFFF&'), parseAssColor('&H00FFFFFF'));
  });

  it('round-trips opaque colors', () => {
    assert.strictEqual(toAssColor(parseAssColor('&H00F1F4F9')!), '&H00F1F4F9');
  });

  it('round-trips translucency', () => {
    assert.strictEqual(toAssColor(parseAssColor('&HBE000000')!), '&HBE000000');
  });

  it('converts to #RRGGBB', () => {
    assert.strictEqual(toHex(parseAssColor('&H00F1F4F9')!), '#F9F4F1');
  });

  it('parses hex back to rgba', () => {
    const c = fromHex('#F9F4F1')!;
    assert.deepStrictEqual({ r: c.r, g: c.g, b: c.b }, { r: 0xf9, g: 0xf4, b: 0xf1 });
    assert.strictEqual(c.a, 1);
  });

  it('returns null for garbage', () => {
    assert.strictEqual(parseAssColor('not a color'), null);
    assert.strictEqual(parseAssColor('&HZZ'), null);
  });
});
