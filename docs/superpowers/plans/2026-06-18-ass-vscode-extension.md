# ASS Subtitle Viewer/Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that gives `.ass` (Advanced SubStation Alpha) files full-file syntax highlighting plus a decoded, editable panel for Script Info, Styles, and Events (two-way synced to the document).

**Architecture:** Command-triggered Webview panel beside a normal text document (Approach 1). A pure, position-aware parser (ours) is the single source of truth for structure, surgical edits, and byte-exact round-trip. `ass-compiler` (library) is used only to decode dialogue override tags for display — the one genuinely hard part we don't reinvent. Edits are applied as surgical `WorkspaceEdit`s (line + char range) so the document stays dirty until Ctrl+S and undo works naturally.

**Tech Stack:** TypeScript (strict), VS Code Extension API, esbuild (bundler — **required**, because `ass-compiler` is ESM-only and must be bundled into the CJS host), Mocha + tsx (unit tests for pure modules), `ass-compiler` (override-tag parsing). Vanilla-JS webview styled with VS Code theme CSS variables.

## Global Constraints

(Copied from the approved spec — every task inherits these.)

- **UTF-8 only** in v1. **Preserve BOM** on read and write. Never silently mangle other encodings.
- **Round-trip invariant:** parsing a file and re-emitting every parsed line unchanged must reproduce the original bytes. This is the primary correctness test.
- **Lenient parser:** a `Style:`/`Dialogue:`/`Comment:` row whose field count ≠ its `Format:` line is flagged `ok: false`, shown as "⚠ unparsed", and never edited. Unknown/extra lines are kept verbatim.
- **Surgical writes:** an edit replaces a single field's char range on one line; nothing else moves. Apply via `vscode.WorkspaceEdit`. Document becomes dirty; user saves with Ctrl+S.
- **Stale-parse guard:** before applying a panel edit, re-read the target line from the live document and verify the field count still matches; abort + re-sync on mismatch.
- **Don't reinvent:** use `ass-compiler` for override-tag parsing. Write only the thin position-aware glue that no library provides (ASS has no library that gives both structured parse + source positions + byte-exact re-emit).
- **`engines.vscode`: `^1.85.0`.** Node ≥ 18 for dev tooling.
- `ass-compiler` is ESM-only → the host is **always bundled with esbuild** to CJS (`--format=cjs --external:vscode`). Never `require()` it unbundled.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `package.json` | Manifest: deps, scripts, VS Code `contributes` (language, grammar, command, menus), `engines`, `main`. |
| `tsconfig.json` | Strict TS, `moduleResolution: bundler`, `noEmit` (typecheck only; esbuild emits). |
| `esbuild.mjs` | Bundles `src/extension.ts` → `dist/extension.js` (cjs, external vscode). Watch + production modes. |
| `.mocharc.json` | Mocha: tsx loader, spec glob `src/test/**/*.test.ts`. |
| `.vscode/launch.json` | F5 "Run Extension" config + "Extension Tests" config. |
| `.gitignore` | `node_modules`, `dist`, `*.vsix`. |
| `src/assColor.ts` | `&HAABBGGRR` ↔ RGBA/hex. Pure. |
| `src/assParser.ts` | Position-aware line scan → `AssModel`. Pure. (single source of truth) |
| `src/assTags.ts` | Decode dialogue override tags via `ass-compiler`. Pure. |
| `src/assEdit.ts` | Compute surgical field edits + stale guard. Pure. |
| `src/assDocument.ts` | One per open `.ass`: parse, debounced re-parse on text change, expose model. (VS Code glue) |
| `src/assPanel.ts` | WebviewPanel lifecycle, message protocol, apply edits as `WorkspaceEdit`. (VS Code glue) |
| `src/extension.ts` | Activation, register command/language/grammar, wire document ↔ panel. (VS Code glue) |
| `src/types.ts` | Shared pure interfaces (`FieldRange`, `AssModel`, `SectionRow`, `ScriptInfoEntry`, messages). |
| `syntaxes/ass.tmLanguage.json` | TextMate grammar for highlighting. |
| `media/panel.js`, `media/panel.css` | Webview UI (HTML generated inline by `assPanel.ts`). |
| `src/test/*.test.ts` | Mocha unit tests for pure modules. |
| `src/test/fixtures/*.ass` | Real-sample fixtures for parser/round-trip tests. |

---

## Task 1: Scaffold & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.mocharc.json`, `.gitignore`, `.vscode/launch.json`, `src/extension.ts`, `src/test/sanity.test.ts`

**Interfaces:**
- Produces: a buildable, testable, F5-launchable empty extension. `src/extension.ts` exports `activate()`/`deactivate()` (no-op stubs) — Tasks 7-11 fill them in.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ass-style-editor",
  "displayName": "ASS Subtitle Editor",
  "description": "Decode and edit Advanced SubStation Alpha (.ass) subtitle files.",
  "version": "0.0.1",
  "publisher": "local",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": ["onLanguage:ass"],
  "contributes": {
    "languages": [
      { "id": "ass", "aliases": ["Advanced SubStation Alpha", "ass"], "extensions": [".ass"] }
    ],
    "grammars": [
      { "language": "ass", "scopeName": "source.ass", "path": "./syntaxes/ass.tmLanguage.json" }
    ],
    "commands": [
      { "command": "ass.openStyleEditor", "title": "ASS: Open Style Editor", "category": "ASS" }
    ],
    "menus": {
      "commandPalette": [
        { "command": "ass.openStyleEditor", "when": "resourceLangId == ass" }
      ],
      "editor/title": [
        { "command": "ass.openStyleEditor", "when": "resourceLangId == ass", "group": "navigation" }
      ]
    }
  },
  "scripts": {
    "check-types": "tsc --noEmit",
    "compile": "npm run check-types && node esbuild.mjs --production",
    "watch": "node esbuild.mjs --watch",
    "test": "mocha",
    "package": "vsce package --no-dependencies"
  },
  "dependencies": { "ass-compiler": "^0.1.16" },
  "devDependencies": {
    "@types/mocha": "^10.0.6",
    "@types/node": "^20.11.0",
    "@types/vscode": "^1.85.0",
    "esbuild": "^0.20.0",
    "mocha": "^10.2.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (typecheck only; esbuild emits)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "sourceMap": true,
    "outDir": "dist"
  },
  "include": ["src", "media"],
  "exclude": ["node_modules", "dist", "src/test"]
}
```

- [ ] **Step 3: Create `esbuild.mjs`** (bundles the ESM-only `ass-compiler` into CJS)

```js
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild watching…');
} else {
  await esbuild.build(options);
}
```

- [ ] **Step 4: Create `.mocharc.json`** (tsx loads TS + the ESM `ass-compiler`)

```json
{
  "import": "tsx",
  "spec": ["src/test/**/*.test.ts"]
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.vsix
.vscode-test/
```

- [ ] **Step 6: Create `.vscode/launch.json` and `.vscode/tasks.json`** (one-button F5 — the watch task builds via esbuild before the host launches)

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: watch"
    }
  ]
}
```

`.vscode/tasks.json` (background watch task; `beginsPattern`/`endsPattern` match the `esbuild watching…` line printed by `esbuild.mjs`, so launch waits for the first build):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "watch",
      "isBackground": true,
      "label": "npm: watch",
      "problemMatcher": {
        "owner": "esbuild",
        "pattern": { "regexp": "^$" },
        "background": {
          "activeOnStart": true,
          "beginsPattern": "esbuild",
          "endsPattern": "esbuild watching"
        }
      }
    }
  ]
}
```

- [ ] **Step 7: Create minimal `src/extension.ts`**

```ts
import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // Wired up in later tasks.
}

export function deactivate(): void {
  /* no-op */
}
```

- [ ] **Step 8: Create `syntaxes/ass.tmLanguage.json` placeholder** (real grammar added in Task 6; an empty-but-valid file keeps `contributes.grammars` resolvable now)

```json
{ "scopeName": "source.ass", "patterns": [{ "include": "#main" }], "repository": { "main": { "match": ".", "name": "meta.ass" } } }
```

- [ ] **Step 9: Write a sanity test `src/test/sanity.test.ts`** (proves the toolchain runs)

```ts
import assert from 'node:assert';

describe('sanity', () => {
  it('runs TypeScript through tsx', () => {
    const x: number = 1 + 1;
    assert.strictEqual(x, 2);
  });
});
```

- [ ] **Step 10: Install, build, test**

Run: `npm install`
Expected: installs cleanly; `ass-compiler` resolves.

Run: `npm run compile`
Expected: `dist/extension.js` is produced; `tsc --noEmit` passes; no errors.

Run: `npm test`
Expected: `1 passing`.

- [ ] **Step 11: F5 smoke check**

Press F5 → an Extension Development Host opens. Confirm it launches without error in the console. Close it.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold VS Code extension with esbuild, mocha, ass-compiler"
```

---

## Task 2: Color codec (`assColor.ts`)

**Files:**
- Create: `src/assColor.ts`, `src/test/assColor.test.ts`

**Interfaces:**
- Produces:
  - `export interface RgbaColor { r: number; g: number; b: number; a: number }` — r/g/b 0–255, **a = opacity 0..1** (1 = fully opaque, matching ASS `&H00……`).
  - `export function parseAssColor(code: string): RgbaColor | null` — accepts `&HAABBGGRR`, with or without a trailing `&`; tolerates 3–8 hex digits; returns `null` if unparseable.
  - `export function toAssColor(c: RgbaColor): string` — returns canonical `&HAABBGGRR` (8 uppercase hex, `&H` prefix, no trailing `&`).
  - `export function toHex(c: RgbaColor): string` — `#RRGGBB`.
  - `export function fromHex(hex: string, a?: number): RgbaColor | null`.

- [ ] **Step 1: Write the failing test `src/test/assColor.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL (`assColor` module not found / functions undefined).

- [ ] **Step 3: Implement `src/assColor.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `assColor` suite — all passing.

- [ ] **Step 5: Commit**

```bash
git add src/assColor.ts src/test/assColor.test.ts
git commit -m "feat(color): &HAABBGGRR <-> RGBA codec"
```

---

## Task 3: Position-aware parser (`types.ts` + `assParser.ts`)

**Files:**
- Create: `src/types.ts`, `src/assParser.ts`, `src/test/assParser.test.ts`, `src/test/fixtures/sample.ass`, `src/test/fixtures/malformed.ass`, `src/test/fixtures/with-bom.ass`

**Interfaces:**
- Consumes: nothing (pure; zero `vscode` import).
- Produces (in `src/types.ts`):

```ts
export interface FieldRange {
  line: number;      // 0-based document line
  startChar: number; // 0-based column within that line
  endChar: number;   // exclusive
}

export interface ScriptInfoEntry {
  key: string;
  value: string;
  line: number;
  raw: string;             // full original line
  valueRange: FieldRange;  // range of `value` within the line
}

export interface SectionRow {
  kind: 'style' | 'dialogue' | 'comment';
  format: string[];                  // column names from the section's Format: line
  fields: Record<string, string>;    // name -> raw value
  fieldRanges: FieldRange[];         // parallel to format; range of each value
  line: number;
  raw: string;                       // full original line
  ok: boolean;                       // false if field count != format length
}

export interface AssModel {
  bom: boolean;
  scriptInfo: ScriptInfoEntry[];
  styles: { format: string[]; rows: SectionRow[] };
  events: { format: string[]; rows: SectionRow[] };
  verbatim: { line: number; text: string }[]; // headers, Format: lines, blanks, unknown
}
```

- Produces (in `src/assParser.ts`):
  - `export function parseAss(text: string): AssModel`
  - `export function reemitAss(model: AssModel): string` — reconstruct the document from the model (used by the round-trip test).

**Parsing rules (bake these into the implementation):**
- Detect BOM (`﻿`); strip before parsing, set `model.bom`.
- Split into lines preserving `\n`. Track the original line index of each.
- Section header `[V4+ Styles]` / `[V4+ Style]` / `[V4 Styles]` enters the styles section; `[Events]` enters events; `[Script Info]` enters script info. Other `[...]` headers and everything before the first header → verbatim.
- `Format: ...` inside a section sets that section's `format` (split on `,`, trimmed) and is itself verbatim.
- `Style: ` / `Dialogue: ` / `Comment: ` rows: strip the `Prefix: ` then split into `format.length` parts **where the last part is greedy** (so the Events `Text` field may contain commas). Compute each value's char range relative to the line. `ok = (split count === format.length)`.
- `Script Info` lines `Key: Value`: store key, value, and the value's char range (everything after `Key: `). Lines starting with `;` (comments) or blanks → verbatim.
- Every physical line maps to exactly one model entry (scriptInfo row, section row, or verbatim). This is what makes `reemitAss` exact.

- [ ] **Step 1: Create fixture `src/test/fixtures/sample.ass`**

```text
[Script Info]
; generated for tests
Title: Sample
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,LTFinnegan Medium,78,&H00F1F4F9,&H000000FF,&H000A162D,&HBE000000,0,0,0,0,100,100,0,0,1,3.75,1.5,2,135,135,53,1
Style: OP,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,8,40,40,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:04.00,0:00:06.00,OP,Sign,0,0,0,,{\pos(320,400)\fad(200,200)}OP, TEXT
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,this is a comment
```

- [ ] **Step 2: Create fixture `src/test/fixtures/malformed.ass`** (wrong field count → `ok:false`)

```text
[Script Info]
Title: Malformed
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial
Style: Good,Times,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hi
```

- [ ] **Step 3: Create fixture `src/test/fixtures/with-bom.ass`** — identical to `sample.ass` but prefixed with a BOM (`﻿`). Generate it in the test from `sample.ass` content (see test) rather than hand-authoring, to avoid editor BOM stripping.

- [ ] **Step 4: Write the failing test `src/test/assParser.test.ts`**

```ts
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseAss, reemitAss } from '../assParser';

const FIX = path.join(__dirname, 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('assParser', () => {
  it('parses script info with value ranges', () => {
    const model = parseAss(read('sample.ass'));
    const title = model.scriptInfo.find((e) => e.key === 'Title')!;
    assert.strictEqual(title.value, 'Sample');
    assert.strictEqual(title.line, 1);
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL (`assParser` module not found).

- [ ] **Step 6: Implement `src/assParser.ts`**

```ts
import type { AssModel, FieldRange, ScriptInfoEntry, SectionRow } from './types';

const BOM = '﻿';

type Section = 'scriptInfo' | 'styles' | 'events' | null;

interface ParsedLine {
  line: number;
  text: string;
}

function splitFields(valuePart: string, prefixLen: number, format: string[]): {
  fields: string[];
  ranges: FieldRange[];
  line: number; // placeholder, set by caller
} {
  // Split into format.length parts, last part greedy (may contain commas).
  const parts: string[] = [];
  const starts: number[] = [];
  let i = 0;
  for (let k = 0; k < format.length - 1; k++) {
    starts.push(i);
    const comma = valuePart.indexOf(',', i);
    if (comma === -1) {
      // Not enough commas: field count mismatch. Capture the remainder as-is.
      parts.push(valuePart.slice(i));
      i = valuePart.length;
      // remaining format slots get nothing
      for (let r = k + 1; r < format.length; r++) { starts.push(i); parts.push(''); }
      return finalize(parts, starts, prefixLen);
    }
    parts.push(valuePart.slice(i, comma));
    i = comma + 1;
  }
  // last (greedy) field
  starts.push(i);
  parts.push(valuePart.slice(i));
  return finalize(parts, starts, prefixLen);
}

function finalize(parts: string[], starts: number[], prefixLen: number): {
  fields: string[]; ranges: FieldRange[];
} {
  const ranges: FieldRange[] = parts.map((p, idx) => {
    const startChar = prefixLen + starts[idx];
    return { line: 0, startChar, endChar: startChar + p.length };
  });
  return { fields: parts, ranges };
}

export function parseAss(raw: string): AssModel {
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(BOM.length) : raw;
  const lines = text.split('\n');

  const model: AssModel = {
    bom,
    scriptInfo: [],
    styles: { format: [], rows: [] },
    events: { format: [], rows: [] },
    verbatim: [],
  };

  let section: Section = null;

  lines.forEach((lineText, line) => {
    const trimmed = lineText.trim();
    const headerMatch = /^\[(.+)\]$/.exec(trimmed);
    if (headerMatch) {
      const name = headerMatch[1].toLowerCase();
      if (name.includes('script info')) section = 'scriptInfo';
      else if (name.includes('v4') && name.includes('style')) section = 'styles';
      else if (name === 'events') section = 'events';
      else section = null;
      model.verbatim.push({ line, text: lineText });
      return;
    }

    if (section === 'scriptInfo') {
      const kv = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(lineText);
      if (kv) {
        const valueStart = lineText.indexOf(kv[2]);
        const entry: ScriptInfoEntry = {
          key: kv[1],
          value: kv[2],
          line,
          raw: lineText,
          valueRange: { line, startChar: valueStart, endChar: valueStart + kv[2].length },
        };
        model.scriptInfo.push(entry);
        return;
      }
    }

    if (section === 'styles' || section === 'events') {
      const fmt = /^Format:\s?(.*)$/i.exec(lineText);
      if (fmt) {
        const format = fmt[1].split(',').map((s) => s.trim());
        if (section === 'styles') model.styles.format = format;
        else model.events.format = format;
        model.verbatim.push({ line, text: lineText });
        return;
      }
      const row = /^Style:\s?(.*)$/i.exec(lineText)
        ?? (/^Dialogue:\s?(.*)$/i.exec(lineText))
        ?? (/^Comment:\s?(.*)$/i.exec(lineText));
      if (row) {
        const kind = /^Style:/i.test(lineText)
          ? 'style'
          : /^Dialogue:/i.test(lineText)
            ? 'dialogue'
            : 'comment';
        const prefixLen = lineText.indexOf(row[1]);
        const format = section === 'styles' ? model.styles.format : model.events.format;
        const { fields, ranges } = splitFields(row[1], prefixLen, format);
        const fieldMap: Record<string, string> = {};
        format.forEach((name, idx) => { fieldMap[name] = fields[idx] ?? ''; });
        const sectionRow: SectionRow = {
          kind,
          format,
          fields: fieldMap,
          fieldRanges: ranges.map((r) => ({ ...r, line })),
          line,
          raw: lineText,
          ok: fields.length === format.length && row[1].length > 0
            ? countCommas(row[1]) >= format.length - 1
            : fields.length === format.length,
        };
        if (section === 'styles') model.styles.rows.push(sectionRow);
        else model.events.rows.push(sectionRow);
        return;
      }
    }

    model.verbatim.push({ line, text: lineText });
  });

  return model;
}

function countCommas(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === ',') n++;
  return n;
}

export function reemitAss(model: AssModel): string {
  const entries: { line: number; text: string }[] = [];
  for (const e of model.scriptInfo) entries.push({ line: e.line, text: e.raw });
  for (const r of model.styles.rows) entries.push({ line: r.line, text: r.raw });
  for (const r of model.events.rows) entries.push({ line: r.line, text: r.raw });
  for (const v of model.verbatim) entries.push({ line: v.line, text: v.text });
  entries.sort((a, b) => a.line - b.line);
  const text = entries.map((e) => e.text).join('\n');
  return (model.bom ? BOM : '') + text;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: `assParser` suite — all passing, including all three round-trip cases.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/assParser.ts src/test/assParser.test.ts src/test/fixtures/
git commit -m "feat(parser): position-aware ASS parser with byte-exact round-trip"
```

---

## Task 4: Override-tag decoding (`assTags.ts`)

**Files:**
- Create: `src/assTags.ts`, `src/test/assTags.test.ts`

**Interfaces:**
- Consumes: `ass-compiler` (`parse`).
- Produces:
  - `export interface DecodedTag { name: string; raw: string; value: string }`
  - `export function decodeDialogueTags(text: string): DecodedTag[]` — returns the override tags parsed from a dialogue line's `Text` field. Returns `[]` on any error (graceful degradation).

- [ ] **Step 1: Write the failing test `src/test/assTags.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL (`assTags` module not found).

- [ ] **Step 3: Implement `src/assTags.ts`** (uses `ass-compiler` to parse one synthetic dialogue line; reads its parsed tag segments)

```ts
import { parse } from 'ass-compiler';

export interface DecodedTag {
  name: string;
  raw: string;
  value: string;
}

// ass-compiler parses a whole file; we wrap a single Text value in a minimal
// Events section so it parses just the override tags for us.
export function decodeDialogueTags(text: string): DecodedTag[] {
  if (!text) return [];
  try {
    const wrapped =
      '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      `Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,${text}`;
    const parsed = parse(wrapped);
    const dialogue = parsed.events.dialogue[0].Text as Array<Record<string, unknown>>;
    const tags: DecodedTag[] = [];
    for (const seg of dialogue) {
      if (seg && typeof seg === 'object' && 'tag' in seg) {
        const name = String(seg.tag);
        tags.push({ name, raw: name, value: tagValue(seg) });
      }
    }
    return tags;
  } catch {
    return [];
  }
}

function tagValue(seg: Record<string, unknown>): string {
  // ass-compiler stores parsed params under keys like 'x','y','t','start','end', etc.
  const known = ['x', 'y', 'start', 'end', 'a1', 'a2', 'a3', 'a4', 'c', 't', 'style', 'fn', 'fs'];
  const parts: string[] = [];
  for (const k of known) {
    if (k in seg) parts.push(String(seg[k]));
  }
  return parts.join(',');
}
```

> Note: `ass-compiler`'s exact per-tag property names vary by tag. The implementer should run the test and, if `value` looks sparse, inspect `parsed.events.dialogue[0].Text` for the real keys (a one-time adjustment). The `name` extraction is the stable part the UI depends on.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `assTags` suite — all passing. If the `value` assertions are sparse, adjust `tagValue` to read the actual keys and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/assTags.ts src/test/assTags.test.ts
git commit -m "feat(tags): decode dialogue override tags via ass-compiler"
```

---

## Task 5: Surgical edits + stale guard (`assEdit.ts`)

**Files:**
- Create: `src/assEdit.ts`, `src/test/assEdit.test.ts`

**Interfaces:**
- Consumes: `AssModel`, `SectionRow`, `ScriptInfoEntry`, `FieldRange` from `./types`.
- Produces:
  - `export interface FieldEdit { line: number; startChar: number; endChar: number; newContent: string }`
  - `export function computeFieldEdit(row: SectionRow, fieldIndex: number, newValue: string): FieldEdit | null` — range comes from `row.fieldRanges[fieldIndex]`; returns `null` if the row is `!ok` or the index is invalid.
  - `export function computeScriptInfoEdit(entry: ScriptInfoEntry, newValue: string): FieldEdit`
  - `export function rowStillValid(currentLineText: string, row: SectionRow): boolean` — re-derives the field count from the live line text and compares to `row.format.length`. Used as the stale-parse guard.

- [ ] **Step 1: Write the failing test `src/test/assEdit.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL (`assEdit` module not found).

- [ ] **Step 3: Implement `src/assEdit.ts`**

```ts
import type { ScriptInfoEntry, SectionRow } from './types';

export interface FieldEdit {
  line: number;
  startChar: number;
  endChar: number;
  newContent: string;
}

export function computeFieldEdit(row: SectionRow, fieldIndex: number, newValue: string): FieldEdit | null {
  if (!row.ok) return null;
  const range = row.fieldRanges[fieldIndex];
  if (!range) return null;
  return { line: row.line, startChar: range.startChar, endChar: range.endChar, newContent: newValue };
}

export function computeScriptInfoEdit(entry: ScriptInfoEntry, newValue: string): FieldEdit {
  return {
    line: entry.line,
    startChar: entry.valueRange.startChar,
    endChar: entry.valueRange.endChar,
    newContent: newValue,
  };
}

// Re-derive the comma count from the live line; if it no longer matches the
// parsed format length, the parse is stale and the edit must be aborted.
export function rowStillValid(currentLineText: string, row: SectionRow): boolean {
  const colonIdx = currentLineText.indexOf(':');
  if (colonIdx === -1) return false;
  const valuePart = currentLineText.slice(colonIdx + 1).replace(/^\s+/, '');
  const commas = countCommas(valuePart);
  // Greedy last field means commas >= format.length - 1 is acceptable.
  return commas >= row.format.length - 1;
}

function countCommas(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === ',') n++;
  return n;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `assEdit` suite — all passing.

- [ ] **Step 5: Commit**

```bash
git add src/assEdit.ts src/test/assEdit.test.ts
git commit -m "feat(edit): surgical field edits + stale-parse guard"
```

---

## Task 6: TextMate grammar (syntax highlighting)

**Files:**
- Create: `syntaxes/ass.tmLanguage.json`

**Interfaces:**
- Produces: a grammar registered (via `package.json` from Task 1) under scope `source.ass` for language `ass`. Covers section headers, keys, `Format:`/`Style:`/`Dialogue:`/`Comment:` prefixes, override tags `{\\…}`, timestamps `H:MM:SS.cc`, `&H…&` colors, and `;` line comments.

- [ ] **Step 1: Replace `syntaxes/ass.tmLanguage.json` with the full grammar**

```json
{
  "scopeName": "source.ass",
  "name": "Advanced SubStation Alpha",
  "patterns": [{ "include": "#main" }],
  "repository": {
    "main": {
      "patterns": [
        { "include": "#comment" },
        { "include": "#section" },
        { "include": "#format-line" },
        { "include": "#row-line" },
        { "include": "#scriptinfo" }
      ]
    },
    "comment": { "match": "^;.*$", "name": "comment.line.ass" },
    "section": { "match": "^\\[[^\\]]+\\]", "name": "entity.name.section.ass" },
    "format-line": {
      "match": "^Format:\\s*(.*)$",
      "captures": {
        "0": { "name": "keyword.control.format.ass" },
        "1": { "name": "string.unquoted.ass" }
      }
    },
    "row-line": {
      "match": "^(Style|Dialogue|Comment):\\s*(.*)$",
      "captures": {
        "1": { "name": "keyword.control.row.ass" },
        "2": { "patterns": [{ "include": "#row-fields" }] }
      }
    },
    "row-fields": {
      "patterns": [
        { "include": "#timestamp" },
        { "include": "#color" },
        { "include": "#override" }
      ]
    },
    "scriptinfo": {
      "match": "^([A-Za-z0-9_]+):\\s?(.*)$",
      "captures": {
        "1": { "name": "support.type.property-name.ass" },
        "2": { "name": "string.unquoted.ass" }
      }
    },
    "timestamp": {
      "match": "\\d+:\\d{2}:\\d{2}\\.\\d{2}",
      "name": "constant.numeric.timestamp.ass"
    },
    "color": {
      "match": "&H[0-9A-Fa-f]+&?",
      "name": "constant.language.color.ass"
    },
    "override": {
      "match": "\\{[^}]*\\}",
      "name": "meta.override.ass"
    }
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run compile`
Expected: succeeds (grammar is JSON, validated by load).

- [ ] **Step 3: F5 visual verification**

Press F5 → in the host, open any `.ass` (use `src/test/fixtures/sample.ass`).
Expected: section headers, `Format:`/`Style:`/`Dialogue:` keywords, timestamps, `&H…` colors, and `{…}` override tags are each distinctly colored. `;` lines are commented.

- [ ] **Step 4: Commit**

```bash
git add syntaxes/ass.tmLanguage.json
git commit -m "feat(grammar): TextMate grammar for ASS highlighting"
```

---

## Task 7: Document model (`assDocument.ts`)

**Files:**
- Create: `src/assDocument.ts`
- Modify: `src/extension.ts` (register an `AssDocument` per active `.ass` editor)

**Interfaces:**
- Consumes: `parseAss` from `./assParser`; `vscode`.
- Produces:
  - `export class AssDocument` with:
    - `constructor(doc: vscode.TextDocument)`
    - `get model(): AssModel` (latest parse)
    - `refresh(): void` (re-parse from current text)
    - `dispose(): void`
    - Emits updates via a callback `onModelChange: (m: AssModel) => void` set by the panel.

- [ ] **Step 1: Implement `src/assDocument.ts`**

```ts
import * as vscode from 'vscode';
import { parseAss } from './assParser';
import type { AssModel } from './types';

export class AssDocument {
  readonly doc: vscode.TextDocument;
  private _model: AssModel;
  private _disposables: vscode.Disposable[] = [];
  private _timer: NodeJS.Timeout | undefined;
  onModelChange: (m: AssModel) => void = () => {};

  constructor(doc: vscode.TextDocument) {
    this.doc = doc;
    this._model = parseAss(doc.getText());
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.doc) this.schedule();
    });
    this._disposables.push(sub);
  }

  get model(): AssModel {
    return this._model;
  }

  refresh(): void {
    this._model = parseAss(this.doc.getText());
    this.onModelChange(this._model);
  }

  private schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 200);
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer);
    this._disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 2: F5 verification**

This class is wired into `extension.ts` in Task 10; here just confirm `npm run compile` succeeds (no type errors) and commit the unit.

Run: `npm run compile`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/assDocument.ts
git commit -m "feat(document): per-file ASS model with debounced re-parse"
```

---

## Task 8: Webview panel — Styles tab (`assPanel.ts` + `media/*`)

**Files:**
- Create: `src/assPanel.ts`, `media/panel.js`, `media/panel.css`
- Modify: `src/extension.ts` (register `ass.openStyleEditor`)

**Interfaces:**
- Consumes: `AssDocument`, `computeFieldEdit` from `./assEdit`, `parseAssColor`/`toAssColor`/`toHex`/`fromHex` from `./assColor`, `vscode`.
- Produces: a panel that renders Styles, lets the user edit any field (color picker + hex + alpha + raw code + numeric/text inputs), and posts `{type:'edit', section:'styles'|'events'|'scriptInfo', line, fieldIndex, value}` messages. The host applies each as a `WorkspaceEdit`.

**Message protocol (shared contract):**
```ts
// webview -> host
type OutMessage =
  | { type: 'edit'; section: 'styles' | 'events' | 'scriptInfo'; line: number; fieldIndex: number; value: string }
  | { type: 'ready' };
// host -> webview
type InMessage = { type: 'model'; model: AssModel };
```

- [ ] **Step 1: Implement `src/assPanel.ts`** (panel lifecycle, HTML generation with nonce/CSP, message handling → `WorkspaceEdit`)

```ts
import * as vscode from 'vscode';
import { AssDocument } from './assDocument';
import { computeFieldEdit, rowStillValid } from './assEdit';
import type { AssModel, SectionRow } from './types';

export class AssPanel {
  private panel: vscode.WebviewPanel;
  private doc: AssDocument;
  private rowsByLine = new Map<number, SectionRow>();

  constructor(doc: AssDocument, context: vscode.ExtensionContext) {
    this.doc = doc;
    this.panel = vscode.window.createWebviewPanel(
      'assStyleEditor',
      `ASS Editor — ${vscode.workspace.asRelativePath(doc.doc.uri)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview, context);
    this.doc.onModelChange = (m) => this.send(m);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => { this.doc.onModelChange = () => {}; });
    this.send(doc.model);
  }

  private send(model: AssModel): void {
    this.reindex(model);
    this.panel.webview.postMessage({ type: 'model', model });
  }

  private reindex(model: AssModel): void {
    this.rowsByLine.clear();
    for (const r of [...model.styles.rows, ...model.events.rows]) this.rowsByLine.set(r.line, r);
  }

  private async onMessage(msg: { type: string; section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.type === 'edit') await this.onEdit(msg);
    // addRow / duplicateRow / deleteRow dispatch added in Task 10.
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo' || msg.line == null || msg.fieldIndex == null) return; // scriptInfo handled in Task 9
    const row = this.rowsByLine.get(msg.line);
    if (!row) return;
    // Stale-parse guard: confirm the live line still matches.
    const liveLine = this.doc.doc.lineAt(msg.line).text;
    if (!rowStillValid(liveLine, row)) { this.doc.refresh(); return; }
    const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
    if (!edit) return;
    const ws = new vscode.WorkspaceEdit();
    ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
    await vscode.workspace.applyEdit(ws);
  }

  private html(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css'));
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${css}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
```

- [ ] **Step 2: Implement `media/panel.css`** (VS Code theme variables, no framework)

```css
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 12px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; margin-bottom: 10px; }
.card h3 { margin: 0 0 8px; color: var(--vscode-foreground); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
label { color: var(--vscode-descriptionForeground); font-size: 12px; }
input[type=text], input[type=number], select {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); padding: 2px 4px;
}
.swatch { width: 20px; height: 20px; border: 1px solid var(--vscode-panel-border); display: inline-block; }
.muted { color: var(--vscode-descriptionForeground); }
.warn { color: var(--vscode-editorWarning-foreground); }
```

- [ ] **Step 3: Implement `media/panel.js`** (renders Styles; color controls; posts edits). Full file:

```js
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
let model = null;

const STYLE_NUM_FIELDS = ['Fontsize','Bold','Italic','Underline','StrikeOut','ScaleX','ScaleY','Spacing','Angle','BorderStyle','Outline','Shadow','Alignment','MarginL','MarginR','MarginV','Encoding'];
const STYLE_BOOL_FIELDS = ['Bold','Italic','Underline','StrikeOut'];
const STYLE_COLOR_FIELDS = ['PrimaryColour','SecondaryColour','OutlineColour','BackColour'];

window.addEventListener('message', (e) => { model = e.data.model; render(); });

function postEdit(section, line, fieldIndex, value) {
  vscode.postMessage({ type: 'edit', section, line, fieldIndex, value });
}

function fieldIndexByName(row, name) { return row.format.indexOf(name); }

function render() {
  if (!model) return;
  root.innerHTML = '';
  for (const row of model.styles.rows) {
    root.appendChild(styleCard(row));
  }
  const add = document.createElement('button');
  add.textContent = '+ add style (TODO in Task 10)';
  root.appendChild(add);
}

function styleCard(row) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h3');
  title.textContent = row.fields.Name || '(unnamed)';
  if (!row.ok) { title.textContent += ' ⚠ unparsed'; title.className = 'warn'; }
  card.appendChild(title);
  if (!row.ok) { card.appendChild(muted('Field count does not match Format — not editable.')); return card; }

  for (const c of STYLE_COLOR_FIELDS) card.appendChild(colorControl(row, c));
  card.appendChild(textInput(row, 'Fontname'));
  card.appendChild(numInput(row, 'Fontsize'));
  for (const b of STYLE_BOOL_FIELDS) card.appendChild(boolInput(row, b));
  for (const n of STYLE_NUM_FIELDS) {
    if (STYLE_BOOL_FIELDS.includes(n) || n === 'Fontsize' || n === 'Alignment') continue;
    card.appendChild(numInput(row, n));
  }
  card.appendChild(alignControl(row));
  return card;
}

function colorControl(row, name) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  const idx = fieldIndexByName(row, name);
  const raw = row.fields[name] || '';
  wrap.appendChild(label(name));
  const swatch = document.createElement('span'); swatch.className = 'swatch';
  const picker = document.createElement('input'); picker.type = 'color';
  const hex = document.createElement('input'); hex.type = 'text'; hex.size = 7;
  const alpha = document.createElement('input'); alpha.type = 'range'; alpha.min = 0; alpha.max = 100;
  const code = document.createElement('input'); code.type = 'text'; code.size = 12; code.value = raw; code.title = 'raw &HAABBGGRR';
  // initial decode
  const dec = decodeOnWeb(raw); // {hex, aPct} or null
  if (dec) { picker.value = dec.hex; hex.value = dec.hex.toUpperCase(); swatch.style.background = dec.hex; alpha.value = dec.aPct; }
  else { swatch.style.background = 'transparent'; alpha.value = 100; }
  function commit(newCode) { postEdit('styles', row.line, idx, newCode); }
  picker.oninput = () => { const c = encFromWeb(picker.value, Number(alpha.value)/100); code.value = c; commit(c); };
  alpha.oninput = () => { const c = encFromWeb(picker.value, Number(alpha.value)/100); code.value = c; commit(c); };
  code.onchange = () => { commit(code.value.trim()); };
  wrap.append(swatch, picker, hex, alpha, code);
  return wrap;
}

// Web-side ASS color decode/encode mirrors src/assColor.ts.
function decodeOnWeb(code) {
  const m = /^&H([0-9A-Fa-f]+)&?$/.exec((code || '').trim()); if (!m) return null;
  let h = m[1].toUpperCase().padStart(8, '0');
  const aa = parseInt(h.slice(0,2),16), bb = parseInt(h.slice(2,4),16), gg = parseInt(h.slice(4,6),16), rr = parseInt(h.slice(6,8),16);
  const hex = '#' + [rr,gg,bb].map(n=>n.toString(16).padStart(2,'0')).join('');
  return { hex, aPct: Math.round((255-aa)/255*100) };
}
function encFromWeb(hex, opacity) {
  const rr = hex.slice(1,3), gg = hex.slice(3,5), bb = hex.slice(5,7);
  const aa = Math.round(255 - opacity*255).toString(16).padStart(2,'0');
  return '&H' + (aa + bb + gg + rr).toUpperCase();
}

function textInput(row, name) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  wrap.appendChild(label(name));
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = row.fields[name] || '';
  inp.onchange = () => postEdit('styles', row.line, fieldIndexByName(row, name), inp.value);
  wrap.appendChild(inp); return wrap;
}
function numInput(row, name) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  wrap.appendChild(label(name));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = row.fields[name] || '0';
  inp.onchange = () => postEdit('styles', row.line, fieldIndexByName(row, name), String(inp.value));
  wrap.appendChild(inp); return wrap;
}
function boolInput(row, name) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = row.fields[name] === '-1';
  const lbl = label(name); lbl.prepend(cb); wrap.appendChild(lbl);
  cb.onchange = () => postEdit('styles', row.line, fieldIndexByName(row, name), cb.checked ? '-1' : '0');
  return wrap;
}
function alignControl(row) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  wrap.appendChild(label('Alignment'));
  const grid = document.createElement('div');
  grid.style.display = 'grid'; grid.style.gridTemplateColumns = 'repeat(3, 1.6em)'; grid.style.gap = '2px';
  const current = Number(row.fields.Alignment || '2');
  [7, 8, 9, 4, 5, 6, 1, 2, 3].forEach((n) => { // numpad layout
    const b = document.createElement('button'); b.textContent = String(n); b.style.padding = '0 4px';
    if (n === current) b.style.fontWeight = 'bold';
    b.onclick = () => postEdit('styles', row.line, fieldIndexByName(row, 'Alignment'), String(n));
    grid.appendChild(b);
  });
  wrap.appendChild(grid); return wrap;
}
function label(t) { const l = document.createElement('label'); l.textContent = t + ' '; return l; }
function muted(t) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = t; return d; }
```

- [ ] **Step 4: Wire the command in `src/extension.ts`**

```ts
import * as vscode from 'vscode';
import { AssDocument } from './assDocument';
import { AssPanel } from './assPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openEditor = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'ass') {
      vscode.window.showWarningMessage('Open an .ass file first.');
      return;
    }
    const model = new AssDocument(doc);
    context.subscriptions.push(model);
    new AssPanel(model, context);
  };
  context.subscriptions.push(vscode.commands.registerCommand('ass.openStyleEditor', openEditor));
}

export function deactivate(): void {}
```

- [ ] **Step 5: Build**

Run: `npm run compile`
Expected: succeeds.

- [ ] **Step 6: F5 verification — Styles editing**

Press F5 → host opens → open `src/test/fixtures/sample.ass` → run **ASS: Open Style Editor** from the palette.
Expected:
1. Panel opens beside the editor showing two style cards (Default, OP) with decoded color swatches (`#F9F4F1`, etc.), hex, alpha sliders, and the raw `&H…` code.
2. Change the Default PrimaryColour via the color picker → the `&H…` value on the `Style: Default,…` line in the document updates and the document tab shows a dot (dirty). Ctrl+Z undoes it. Save (Ctrl+S) persists.
3. Editing the raw `&H` code field updates the swatch and the document.
4. The malformed fixture shows `⚠ unparsed` and is not editable.

- [ ] **Step 7: Commit**

```bash
git add src/assPanel.ts src/extension.ts media/
git commit -m "feat(panel): Styles tab with decoded, editable color controls"
```

---

## Task 9: Script Info + Events tabs

**Files:**
- Modify: `media/panel.js`, `src/assPanel.ts`

**Interfaces:**
- Consumes: same as Task 8; adds Script Info value edits and Events (Start/End/Style/Text) edits, plus decoded-tag display via `assTags` data computed host-side and included in the model message.

- [ ] **Step 1: Add decoded tags to the model message in `assPanel.ts`**

Add the import at the top:

```ts
import { decodeDialogueTags } from './assTags';
```

Replace the body of `send(model)` so it reindexes, builds a serializable view that adds a decoded `tags` array to each events row, and posts the view:

```ts
  private send(model: AssModel): void {
    this.reindex(model);
    const view = {
      bom: model.bom,
      scriptInfo: model.scriptInfo.map((e) => ({ key: e.key, value: e.value, line: e.line })),
      styles: { format: model.styles.format, rows: model.styles.rows.map(stripRow) },
      events: {
        format: model.events.format,
        rows: model.events.rows.map((r) => ({ ...stripRow(r), tags: decodeDialogueTags(r.fields.Text ?? '') })),
      },
    };
    this.panel.webview.postMessage({ type: 'model', model: view });
  }
```

Add `stripRow` as a module-level helper (keeps only what the UI needs):

```ts
function stripRow(r: SectionRow) {
  return { kind: r.kind, line: r.line, ok: r.ok, format: r.format, fields: r.fields };
}
```

- [ ] **Step 2: Handle `scriptInfo` edits in `onEdit`** — add the import, then turn the first guard line into a scriptInfo branch:

```ts
import { computeScriptInfoEdit } from './assEdit';
```

In `onEdit`, replace this guard line (from Task 8):

```ts
    if (msg.section === 'scriptInfo' || msg.line == null || msg.fieldIndex == null) return; // scriptInfo handled in Task 9
```

with:

```ts
    if (msg.section === 'scriptInfo') {
      if (msg.line == null) return;
      const entry = this.doc.model.scriptInfo.find((e) => e.line === msg.line);
      if (!entry) return;
      const e = computeScriptInfoEdit(entry, msg.value ?? '');
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newContent);
      await vscode.workspace.applyEdit(ws);
      return;
    }
    if (msg.line == null || msg.fieldIndex == null) return;
```

- [ ] **Step 3: Extend `media/panel.js`** with tabs and the Script Info / Events renderers:

```js
// Add at top, after model decl:
let tab = 'styles';
function setTab(t) { tab = t; render(); }

// Replace render() body:
function render() {
  if (!model) return;
  root.innerHTML = '';
  const tabs = document.createElement('div'); tabs.className = 'row';
  for (const [t,label] of [['scriptInfo','Script Info'],['styles','Styles'],['events','Events']]) {
    const b = document.createElement('button'); b.textContent = label;
    if (t === tab) b.style.fontWeight = 'bold';
    b.onclick = () => setTab(t);
    tabs.appendChild(b);
  }
  root.appendChild(tabs);
  if (tab === 'styles') model.styles.rows.forEach((r) => root.appendChild(styleCard(r)));
  if (tab === 'scriptInfo') model.scriptInfo.forEach((e) => root.appendChild(scriptInfoRow(e)));
  if (tab === 'events') root.appendChild(eventsList(model.events));
}

function scriptInfoRow(e) {
  const wrap = document.createElement('div'); wrap.className = 'row';
  const k = document.createElement('label'); k.textContent = e.key + ' '; k.style.minWidth = '160px';
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = e.value || '';
  inp.onchange = () => vscode.postMessage({ type: 'edit', section: 'scriptInfo', line: e.line, fieldIndex: -1, value: inp.value });
  wrap.append(k, inp); return wrap;
}

function eventsList(events) {
  const wrap = document.createElement('div');
  const search = document.createElement('input'); search.type = 'text'; search.placeholder = 'filter…';
  const list = document.createElement('div');
  function draw() {
    list.innerHTML = '';
    const q = search.value.toLowerCase();
    events.rows.filter((r) => !q || (r.fields.Text || '').toLowerCase().includes(q)).forEach((r) => list.appendChild(eventRow(events, r)));
  }
  search.oninput = draw; draw();
  wrap.append(search, list); return wrap;
}

function eventRow(events, r) {
  const card = document.createElement('div'); card.className = 'card';
  const head = document.createElement('div'); head.className = 'row';
  const start = textIn(r, 'Start'); const end = textIn(r, 'End');
  const styleSel = document.createElement('select');
  model.styles.rows.forEach((s) => { const o = document.createElement('option'); o.value = o.textContent = s.fields.Name; styleSel.appendChild(o); });
  styleSel.value = r.fields.Style || '';
  styleSel.onchange = () => postEdit('events', r.line, fieldIndexByName(r, 'Style'), styleSel.value);
  head.append(start, end, styleSel);
  const text = document.createElement('textarea'); text.rows = 2; text.value = r.fields.Text || '';
  text.onchange = () => postEdit('events', r.line, fieldIndexByName(r, 'Text'), text.value);
  card.append(head, text);
  if (r.tags && r.tags.length) {
    const chips = document.createElement('div'); chips.className = 'muted';
    chips.textContent = 'tags: ' + r.tags.map((t) => '\\' + t.name + (t.value ? '(' + t.value + ')' : '')).join(' ');
    card.appendChild(chips);
  }
  return card;
}
function textIn(row, name) {
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = row.fields[name] || ''; inp.size = 10;
  inp.onchange = () => postEdit('events', row.line, fieldIndexByName(row, name), inp.value);
  return inp;
}
```

- [ ] **Step 4: Build**

Run: `npm run compile`
Expected: succeeds.

- [ ] **Step 5: F5 verification — Script Info + Events**

Press F5 → open sample.ass → open editor.
Expected:
1. **Script Info** tab lists `Title`, `PlayResX/Y`, `WrapStyle`, etc. Editing `Title` updates the document line live; Ctrl+Z reverts.
2. **Events** tab lists the two Dialogue lines and the Comment, each with Start/End/Style/Text editable, a filter box, and a decoded-tag line under the one with `{\pos…}` (e.g. `tags: \pos(320,400) \fad(200,200)`).
3. Editing the Style dropdown on a Dialogue updates that line's `Style` field.

- [ ] **Step 6: Commit**

```bash
git add media/panel.js src/assPanel.ts
git commit -m "feat(panel): Script Info and Events tabs with decoded tag display"
```

---

## Task 10: Two-way sync, add/duplicate/delete styles

**Files:**
- Modify: `media/panel.js` (add/dup/delete UI), `src/assPanel.ts` (handle `addRow`/`deleteRow`/`duplicateRow` messages)

**Interfaces:**
- Extends the message protocol:
  - `{ type:'addRow', section:'styles' }` — insert a new `Style:` line after the last style row, prefilled from the section's first row (or a default) so it parses as `ok`.
  - `{ type:'duplicateRow', section:'styles', line }` — insert a copy right after `line`.
  - `{ type:'deleteRow', section:'styles', line }` — delete that whole line.

- [ ] **Step 1: Add handlers in `assPanel.ts`**

Inside `onMessage`, add these dispatch branches alongside the existing `if (msg.type === 'edit')` branch:

```ts
    if (msg.type === 'addRow' && msg.section === 'styles') return this.insertStyle(msg.line);
    if (msg.type === 'duplicateRow' && msg.section === 'styles' && msg.line != null) return this.duplicateStyle(msg.line);
    if (msg.type === 'deleteRow' && msg.section === 'styles' && msg.line != null) return this.deleteStyle(msg.line);
```

```ts
private async insertStyle(afterLine?: number): Promise<void> {
  const rows = this.doc.model.styles.rows;
  const template = rows[rows.length - 1];
  const lineNo = afterLine ?? template?.line ?? this.doc.doc.lineCount - 1;
  const text = template
    ? template.raw
    : 'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1';
  await this.insertLine(lineNo + 1, text);
}
private async duplicateStyle(line: number): Promise<void> {
  const row = this.rowsByLine.get(line);
  if (row) await this.insertLine(line + 1, row.raw);
}
private async deleteStyle(line: number): Promise<void> {
  const ws = new vscode.WorkspaceEdit();
  ws.delete(this.doc.doc.uri, this.doc.doc.lineAt(line).rangeIncludingLineBreak);
  await vscode.workspace.applyEdit(ws);
}
private async insertLine(line: number, text: string): Promise<void> {
  const ws = new vscode.WorkspaceEdit();
  ws.insert(this.doc.doc.uri, new vscode.Position(line, 0), text + '\n');
  await vscode.workspace.applyEdit(ws);
}
```

- [ ] **Step 2: Add the buttons in `media/panel.js`** — per-card `[dup][del]` and a global `+ add style`:

```js
// In styleCard, add to the title row:
const dup = document.createElement('button'); dup.textContent = 'dup'; dup.onclick = () => vscode.postMessage({ type:'duplicateRow', section:'styles', line: row.line });
const del = document.createElement('button'); del.textContent = 'del'; del.onclick = () => vscode.postMessage({ type:'deleteRow', section:'styles', line: row.line });
card.appendChild(dup); card.appendChild(del);

// Replace the stub "add style" button in render() with:
const add = document.createElement('button'); add.textContent = '+ add style';
add.onclick = () => vscode.postMessage({ type:'addRow', section:'styles' });
root.appendChild(add);
```

- [ ] **Step 3: Build**

Run: `npm run compile`
Expected: succeeds.

- [ ] **Step 4: F5 verification — two-way sync + CRUD**

Press F5 → open sample.ass → open editor.
Expected:
1. **Doc → panel:** type a change in the raw `Style:` line in the text editor → the panel's swatch/fields update without reopening (debounced re-parse).
2. **Add:** click `+ add style` → a new `Style:` line appears in both the document and panel; it is editable and `ok`.
3. **Duplicate / Delete:** per-card buttons duplicate or remove the line in both views.
4. **Undo** steps through each panel-originated edit correctly.

- [ ] **Step 5: Commit**

```bash
git add media/panel.js src/assPanel.ts
git commit -m "feat(panel): two-way sync + add/duplicate/delete styles"
```

---

## Task 11: Round-trip + manual verification pass + README

**Files:**
- Create: `README.md`; collect 2–3 more real `.ass` samples into `src/test/fixtures/` (e.g. user's Major 2nd file, stripped to a representative excerpt) as `real-1.ass`, `real-2.ass`.
- Modify: `src/test/assParser.test.ts` (add parameterized round-trip over all fixtures).

- [ ] **Step 1: Add a round-trip test over every fixture**

Append to `src/test/assParser.test.ts`:

```ts
import { readdirSync } from 'node:fs';
describe('assParser round-trip (all fixtures)', () => {
  for (const name of readdirSync(FIX).filter((f) => f.endsWith('.ass'))) {
    it(`round-trips ${name} byte-for-byte`, () => {
      const text = read(name);
      assert.strictEqual(reemitAss(parseAss(text)), text);
    });
  }
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: every fixture (sample, malformed, with-bom generated in-memory, real-1, real-2) round-trips exactly; all prior suites still pass.

- [ ] **Step 3: Write `README.md`**

```markdown
# ASS Subtitle Editor (VS Code)

Decode and edit Advanced SubStation Alpha (`.ass`) subtitle files.

## Features
- Syntax highlighting for the whole file (sections, Style/Dialogue/Format lines, override tags, timestamps, `&H` colors).
- **ASS: Open Style Editor** command opens a decoded, editable panel:
  - **Styles** — every field editable; colors via picker + hex + alpha slider with the raw `&HAABBGGRR` code always visible; numpad alignment; add/duplicate/delete.
  - **Script Info** — editable key/value rows.
  - **Events** — searchable list; edit Start/End/Style/Text; override tags shown decoded.
- Two-way sync: edits in the panel write back to the document (save with Ctrl+S); edits in the text editor refresh the panel.
- Lenient parsing: malformed rows are flagged, never corrupted. Byte-exact round-trip for valid files.

## Develop
- `npm install`
- `npm run compile` — typecheck + bundle (esbuild).
- `npm test` — unit tests (pure parser/color/edit logic).
- Press **F5** to launch an Extension Development Host for manual testing.

## Limits (v1)
UTF-8 only (BOM preserved). No structured override-tag editor, karaoke editor, or video preview.
```

- [ ] **Step 4: Final manual pass**

Press F5 → for each fixture and the real Major 2nd file: open, open editor, edit one field per section, confirm the document diff and undo, save, reopen to confirm persistence. Confirm a BOM file keeps its BOM after edits (check with a hex/binary view or `file`).

- [ ] **Step 5: Commit**

```bash
git add README.md src/test/assParser.test.ts src/test/fixtures/
git commit -m "test: round-trip all fixtures; docs: README"
```

---

## Done criteria

- `npm test` green; every fixture round-trips byte-for-byte.
- F5: highlighting + all three tabs editable + two-way sync + add/dup/delete + undo all work.
- BOM preserved; malformed rows flagged not corrupted.
