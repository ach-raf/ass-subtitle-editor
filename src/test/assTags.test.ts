import assert from 'node:assert';
import { decodeDialogueTags } from '../assTags';

describe('assTags', () => {
  it('decodes a pos + fad tag set', () => {
    const tags = decodeDialogueTags('{\\pos(320,400)\\fad(200,200)}hello');
    const names = tags.map((t) => t.name);
    assert.ok(names.includes('pos'));
    assert.ok(names.includes('fad'));
    const pos = tags.find((t) => t.name === 'pos')!;
    assert.strictEqual(pos.value, '320,400');
  });

  it('returns [] for plain text with no tags', () => {
    assert.deepStrictEqual(decodeDialogueTags('Hello world'), []);
  });

  it('degrades gracefully on bad input', () => {
    assert.deepStrictEqual(decodeDialogueTags(''), []);
  });
});
