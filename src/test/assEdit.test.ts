import assert from 'node:assert';
import { parseAss } from '../assParser';
import { computeFieldEdit, computeScriptInfoEdit, rowStillValid } from '../assEdit';

const sample = `[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,40
`;

describe('assEdit', () => {
  const model = parseAss(sample);
  const row = model.styles.rows[0];

  it('computes a field edit replacing just the Fontname value', () => {
    const edit = computeFieldEdit(row, row.format.indexOf('Fontname'), 'Verdana')!;
    assert.strictEqual(edit.newContent, 'Verdana');
    assert.strictEqual(edit.line, row.line);
    // The range should slice out 'Arial' on the raw line
    assert.strictEqual(row.raw.slice(edit.startChar, edit.endChar), 'Arial');
  });

  it('refuses to edit a malformed row', () => {
    const badModel = parseAss('[V4+ Styles]\nFormat: Name, Fontname\nStyle: OnlyOne\n');
    const bad = badModel.styles.rows[0];
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(computeFieldEdit(bad, 0, 'x'), null);
  });

  it('computes a script-info value edit', () => {
    const m = parseAss('[Script Info]\nTitle: Old\n');
    const e = computeScriptInfoEdit(m.scriptInfo[0], 'New');
    assert.strictEqual(e.newContent, 'New');
    assert.strictEqual(m.scriptInfo[0].raw.slice(e.startChar, e.endChar), 'Old');
  });

  it('rowStillValid matches when the line is unchanged', () => {
    assert.strictEqual(rowStillValid(row.raw, row), true);
  });

  it('rowStillValid detects an added comma (stale parse)', () => {
    assert.strictEqual(rowStillValid('Style: Default,Arial,40,99', row), false);
  });
});
