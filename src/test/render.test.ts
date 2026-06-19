import assert from 'node:assert';
import { styleToCss } from '../shared/render';

describe('styleToCss', () => {
  it('maps color and opacity', () => {
    const c = styleToCss({ color: '#070D12', opacity: 0.5 }, 1);
    assert.strictEqual(c.color, '#070D12');
    assert.strictEqual(c.opacity, '0.5');
  });
  it('omits opacity when fully opaque', () => {
    const c = styleToCss({ color: '#ffffff', opacity: 1 }, 1);
    assert.ok(!('opacity' in c));
  });
  it('maps bold / italic / underline / strikeout', () => {
    const c = styleToCss({ fontWeight: 'bold', fontStyle: 'italic', underline: true, strikeout: true }, 1);
    assert.strictEqual(c.fontWeight, 'bold');
    assert.strictEqual(c.fontStyle, 'italic');
    assert.strictEqual(c.textDecoration, 'underline line-through');
  });
  it('scales font size by the preview scale', () => {
    assert.strictEqual(styleToCss({ fontSize: 48 }, 0.5).fontSize, '24.00px');
  });
  it('maps border to -webkit-text-stroke (scaled, with paint-order)', () => {
    const c = styleToCss({ bord: 4, bordColor: '#000000', bordOpacity: 1 }, 0.25);
    assert.strictEqual(c.webkitTextStroke, '1.00px rgba(0, 0, 0, 1)');
    assert.strictEqual(c.paintOrder, 'stroke fill');
  });
  it('maps shadow to text-shadow', () => {
    const c = styleToCss({ shad: [2, 3], shadColor: '#ff0000', shadOpacity: 0.5 }, 1);
    assert.strictEqual(c.textShadow, '2.00px 3.00px rgba(255, 0, 0, 0.5)');
  });
  it('maps scale + rotate to transform and forces inline-block', () => {
    const c = styleToCss({ scaleX: 2, rotate: 5 }, 1);
    assert.strictEqual(c.transform, 'scale(2, 1) rotate(5deg)');
    assert.strictEqual(c.display, 'inline-block');
  });
  it('maps blur to filter and forces inline-block', () => {
    const c = styleToCss({ blur: 2 }, 1);
    assert.strictEqual(c.filter, 'blur(2.00px)');
    assert.strictEqual(c.display, 'inline-block');
  });
  it('quotes the font family and adds the panel fallback', () => {
    const c = styleToCss({ fontFamily: 'buckeyessk' }, 1);
    assert.strictEqual(c.fontFamily, '"buckeyessk", var(--ae-font)');
  });
});
