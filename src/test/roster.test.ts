import assert from 'node:assert';
import {
  previewOf, buildRosterRow, filterRosterIndices, patchRosterEntry, chunkRoster,
} from '../shared/roster';
import type { RosterRow } from '../shared/roster';
import type { SectionRow } from '../types';

const FMT = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
function row(over: { line: number; fields?: Partial<Record<string, string>> }): SectionRow {
  return {
    kind: 'dialogue', line: over.line, ok: true, format: FMT,
    fields: {
      Layer: '0', Start: '0:00:01.00', End: '0:00:02.00', Style: 'Default',
      Name: '', MarginL: '0', MarginR: '0', MarginV: '0', Effect: '', Text: 'Hello',
      ...over.fields,
    },
  } as SectionRow;
}
const R = (line: number, style: string, preview: string): RosterRow =>
  ({ line, Start: '', End: '', Style: style, preview });

describe('previewOf', () => {
  it('strips override tags and \\N/\\n breaks and collapses whitespace', () => {
    assert.strictEqual(previewOf('{\\fad(200,200)}Hello\\Nworld'), 'Hello world');
  });
  it('truncates to 80 chars', () => {
    assert.strictEqual(previewOf('x'.repeat(200)).length, 80);
  });
  it('returns empty string for tag-only / empty text', () => {
    assert.strictEqual(previewOf('{\\pos(1,2)}'), '');
    assert.strictEqual(previewOf(''), '');
  });
});

describe('buildRosterRow', () => {
  it('maps Start/End/Style + a clean preview from a SectionRow', () => {
    const r = buildRosterRow(row({ line: 42, fields: { Text: '{\\b1}Go!', Style: 'Title' } }));
    assert.strictEqual(r.line, 42);
    assert.strictEqual(r.Start, '0:00:01.00');
    assert.strictEqual(r.Style, 'Title');
    assert.strictEqual(r.preview, 'Go!');
  });
});

describe('filterRosterIndices', () => {
  const roster = [R(1, 'Default', 'Hello world'), R(2, 'Title', 'Goodbye'), R(3, 'Default', 'world peace')];
  it('returns all indices for an empty/whitespace query', () => {
    assert.deepStrictEqual(filterRosterIndices(roster, ''), [0, 1, 2]);
    assert.deepStrictEqual(filterRosterIndices(roster, '   '), [0, 1, 2]);
  });
  it('matches preview case-insensitively', () => {
    assert.deepStrictEqual(filterRosterIndices(roster, 'WORLD'), [0, 2]);
  });
  it('matches style', () => {
    assert.deepStrictEqual(filterRosterIndices(roster, 'title'), [1]);
  });
  it('returns empty for no matches', () => {
    assert.deepStrictEqual(filterRosterIndices(roster, 'zzz'), []);
  });
});

describe('patchRosterEntry', () => {
  it('replaces the entry matching line and returns true', () => {
    const roster = [R(1, 'Default', 'a'), R(2, 'Default', 'b')];
    const ok = patchRosterEntry(roster, 2, R(2, 'Sign', 'b2'));
    assert.strictEqual(ok, true);
    assert.strictEqual(roster[1].Style, 'Sign');
    assert.strictEqual(roster[1].preview, 'b2');
  });
  it('returns false when the line is absent', () => {
    assert.strictEqual(patchRosterEntry([R(1, 'Default', 'a')], 99, R(99, '', '')), false);
  });
});

describe('chunkRoster', () => {
  it('splits into pages of the given size, last page may be short', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => R(n, '', String(n)));
    const chunks = chunkRoster(rows, 2);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].length, 2);
    assert.strictEqual(chunks[2].length, 1);
  });
  it('returns one empty-less layout for exact multiples', () => {
    const rows = [1, 2, 3, 4].map((n) => R(n, '', String(n)));
    const chunks = chunkRoster(rows, 2);
    assert.strictEqual(chunks.length, 2);
  });
});
