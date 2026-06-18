import assert from 'node:assert';

describe('sanity', () => {
  it('runs TypeScript through tsx', () => {
    const x: number = 1 + 1;
    assert.strictEqual(x, 2);
  });
});
