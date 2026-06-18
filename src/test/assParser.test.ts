import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { parseAss, reemitAss } from '../assParser';

const FIX = path.join(__dirname, 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('assParser', () => {
  it('parses script info with value ranges', () => {
    const model = parseAss(read('sample.ass'));
    const title = model.scriptInfo.find((e) => e.key === 'Title')!;
    assert.strictEqual(title.value, 'Sample');
    // Line index of "Title: Sample": 0=[Script Info], 1=;comment, 2=Title.
    assert.strictEqual(title.line, 2);
    assert.strictEqual('Sample', 'Sample'); // value sanity
  });

  it('parses styles with named fields and correct offsets', () => {
    const model = parseAss(read('sample.ass'));
    const def = model.styles.rows.find((r) => r.fields.Name === 'Default')!;
    assert.strictEqual(def.ok, true);
    assert.strictEqual(def.fields.Fontname, 'LTFinnegan Medium');
    assert.strictEqual(def.fields.PrimaryColour, '&H00F1F4F9');
    assert.strictEqual(def.fields.Alignment, '2');
    // Name field char range should slice back to "Default"
    const rng = def.fieldRanges[def.format.indexOf('Name')];
    assert.strictEqual(def.raw.slice(rng.startChar, rng.endChar), 'Default');
  });

  it('keeps the greedy Text field intact (commas inside tags/text)', () => {
    const model = parseAss(read('sample.ass'));
    const dialogue = model.events.rows.find((r) => r.fields.Text.includes('OP, TEXT'))!;
    assert.strictEqual(
      dialogue.fields.Text,
      '{\\pos(320,400)\\fad(200,200)}OP, TEXT',
    );
  });

  it('flags malformed style rows ok=false but keeps them', () => {
    const model = parseAss(read('malformed.ass'));
    const bad = model.styles.rows[0];
    assert.strictEqual(bad.ok, false); // 'Default,Arial' has 2 fields, format has 3
    const good = model.styles.rows[1];
    assert.strictEqual(good.ok, true);
  });

  it('round-trips sample.ass byte-for-byte', () => {
    const text = read('sample.ass');
    assert.strictEqual(reemitAss(parseAss(text)), text);
  });

  it('round-trips malformed.ass byte-for-byte (lenient: nothing dropped)', () => {
    const text = read('malformed.ass');
    assert.strictEqual(reemitAss(parseAss(text)), text);
  });

  it('detects and round-trips a BOM', () => {
    const bomText = '﻿' + read('sample.ass');
    const model = parseAss(bomText);
    assert.strictEqual(model.bom, true);
    assert.strictEqual(reemitAss(model), bomText);
  });
});

describe('assParser round-trip (all fixtures)', () => {
  for (const name of readdirSync(FIX).filter((f) => f.endsWith('.ass'))) {
    it(`round-trips ${name} byte-for-byte`, () => {
      const text = read(name);
      assert.strictEqual(reemitAss(parseAss(text)), text);
    });
  }
});
