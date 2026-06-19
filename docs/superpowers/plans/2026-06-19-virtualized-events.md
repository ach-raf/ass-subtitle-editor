# Virtualized Events List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Events tab open instantly, scroll at 60fps, and filter instantly for `.ass` files with 71,000+ events — with the Events tab visually and interactionally identical to today (Depth-styled cards, inline expand-to-edit).

**Architecture:** Replace the single "send the entire model" `postMessage` with a tiered protocol: a small model (Script Info + Styles + events count), a chunked lightweight roster (one `{line, Start, End, Style, preview}` per event), and on-demand full detail (decoded tags) fetched only for expanded rows. The webview renders the roster through a windowed/virtual scroller (`@tanstack/virtual-core`) so only ~30–60 cards live in the DOM at once. Edits send a single-row patch instead of resending 71k rows. Tag decoding becomes lazy. Styles + Script Info tabs are untouched.

**Tech Stack:** TypeScript + esbuild (host, existing) + a new browser/IIFE esbuild entry for the webview; `@tanstack/virtual-core` (framework-agnostic virtualizer); mocha + tsx + `node:assert` (existing test stack); vanilla JS webview (bundled).

## Global Constraints

- **Platform:** VS Code `^1.85.0`; webview runs under a strict nonce CSP (`script-src 'nonce-<nonce>'`) — the bundled webview JS is served through the existing nonce-protected `<script>` tag, so no CSP change is allowed.
- **No AI attribution:** commit messages must never include `Co-Authored-By: Claude` or any AI/Anthropic trailer (project-wide rule).
- **Commit on `change`, not `input`,** for events editing — preserves the clean one-edit-per-`WorkspaceEdit` undo stack (existing invariant, keep it).
- **Existing 30 host-side tests must stay green** — no changes to `assParser.ts`, `assEdit.ts`, `assColor.ts`, `assTags.ts`, or their tests.
- **Depth Design System styling is unchanged** — event-card markup, classes, and CSS are reused verbatim; only how many cards are mounted changes.
- **Version pin:** install `@tanstack/virtual-core@^3.13.0` (3.x). The vanilla driver in Task 4 isolates all library-specific calls into one file; pinning avoids the private-API drift discussed in [TanStack/virtual#455](https://github.com/TanStack/virtual/discussions/455).

## File Structure

**Created:**
- `src/shared/roster.ts` — pure roster logic (preview strip, build row, filter indices, patch entry, chunk). Imported by both host and the bundled webview (DRY). No Node deps.
- `src/shared/messages.ts` — TypeScript types for the host↔webview message protocol (host type-safety; types erased in the webview bundle).
- `media/src/virtualList.js` — thin driver around `@tanstack/virtual-core` for vanilla use. Single file that contains all virtualizer-specific calls.
- `src/test/roster.test.ts` — unit tests for `src/shared/roster.ts`.

**Moved:**
- `media/panel.js` → `media/src/panel.js` (now an ES module that `import`s the virtualizer driver + shared roster logic; bundled to `dist/panel.js`).

**Modified:**
- `esbuild.mjs` — add a second, browser/IIFE entry for the webview.
- `src/assDocument.ts` — rename `onModelChange(model)` → `onChanged()` (notification only; panel decides what to refresh/send).
- `src/assPanel.ts` — new tiered protocol: `sendModel`, `sendRoster` (chunked), `sendDetails` (on demand), `sendEventPatch`; version-guarded external-change handling.
- `media/src/panel.js` (the moved file) — events tab rewritten to consume the new protocol and render through the virtual list; `eventCard` signature changes to `(rosterRow, detailOrNull)`.
- `package.json` — add `@tanstack/virtual-core` dependency.
- `.vscodeignore` — ship `dist/panel.js`, exclude `media/src/**`.
- `_temp/ass-preview.html` — repoint at bundled output (Task 1), then updated to the new protocol + a 71k generator button (Task 4).

---

## Task 1: Bundle the webview (no behavior change)

**Why first:** establishes the bundling pipeline and lands the dependency before any logic depends on it. After this task the panel is functionally identical, just served from a bundle.

**Files:**
- Modify: `package.json`
- Modify: `esbuild.mjs`
- Move: `media/panel.js` → `media/src/panel.js`
- Modify: `src/assPanel.ts:151-167` (HTML template) and `:29` (localResourceRoots)
- Modify: `.vscodeignore`
- Modify: `_temp/ass-preview.html:82,94` (repoint at bundled JS)

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install @tanstack/virtual-core@^3.13.0
```
Expected: package added to `dependencies` in `package.json` and `node_modules/@tanstack/virtual-core` exists.

- [ ] **Step 2: Move the webview source into a `src` folder**

Move `media/panel.js` to `media/src/panel.js` (create `media/src/`). No content change yet — it is still plain JS with no imports.

```bash
git mv media/panel.js media/src/panel.js
```

- [ ] **Step 3: Add the webview bundling entry to esbuild**

Replace the entirety of `esbuild.mjs` with:

```javascript
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Host: Node CJS bundle (external vscode). */
const hostOptions = {
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

/** Webview: browser IIFE bundle served to the webview under the CSP nonce. */
const webviewOptions = {
  entryPoints: ['media/src/panel.js'],
  bundle: true,
  outfile: 'dist/panel.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'], // VS Code's bundled Chromium
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const hostCtx = await esbuild.context(hostOptions);
  const webCtx = await esbuild.context(webviewOptions);
  await Promise.all([hostCtx.watch(), webCtx.watch()]);
  console.log('esbuild watching (host + webview)…');
} else {
  await esbuild.build(hostOptions);
  await esbuild.build(webviewOptions);
}
```

- [ ] **Step 4: Repoint the webview HTML at the bundled output**

In `src/assPanel.ts`, change the script URI and the local resource roots. Replace lines 29 and 153:

Find:
```typescript
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
```
Replace:
```typescript
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
        ],
```

Find (inside `html()`):
```typescript
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js'));
```
Replace:
```typescript
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'panel.js'));
```

(The CSS link stays `media/panel.css`.)

- [ ] **Step 5: Keep the preview harness working**

In `_temp/ass-preview.html`, the harness loads the webview script and CSS by relative path. CSS stays `../media/panel.css`. The script must now point at the bundle. Find line 94:

```html
<script src="../media/panel.js"></script>
```
Replace:
```html
<script src="../dist/panel.js"></script>
```

(No other harness change in this task — it still posts the old `{model}` shape, which the still-unchanged panel accepts.)

- [ ] **Step 6: Update .vscodeignore**

The shipped VSIX must include `dist/panel.js` (the webview bundle) and `media/panel.css`, but not the webview source. In `.vscodeignore`, the `dist/` folder is already shipped (not excluded). Add the webview source to the excluded block. After the `src/**` line, add `media/src/**`. The block currently:

```
src/**
test/**
```
becomes:
```
src/**
media/src/**
test/**
```

- [ ] **Step 7: Build, type-check, and run the test suite**

Run:
```bash
npm run compile
```
Expected: both bundles print to `dist/extension.js` and `dist/panel.js`; no errors. Then:

```bash
npm test
```
Expected: all existing tests pass (30 passing).

- [ ] **Step 8: Verify the panel still renders in the preview harness**

Open `_temp/ass-preview.html` directly in a browser (file://). Expected: the panel renders identically to before — Styles/Events/Script Info tabs all work, theme + width toggles work, edits round-trip through the simulated host. (This confirms the bundle is wired correctly with zero behavior change.)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json esbuild.mjs src/assPanel.ts .vscodeignore _temp/ass-preview.html media/src/panel.js
git rm media/panel.js
git commit -m "build: bundle the webview with esbuild; add @tanstack/virtual-core"
```

---

## Task 2: Shared roster pure logic + unit tests (TDD)

**Files:**
- Create: `src/shared/messages.ts`
- Create: `src/shared/roster.ts`
- Create: `src/test/roster.test.ts`

**Interfaces:**
- Produces: `RosterRow` (type), `previewOf`, `buildRosterRow`, `filterRosterIndices`, `patchRosterEntry`, `chunkRoster` (in `src/shared/roster.ts`). Consumed by Task 3 (host) and Task 4 (webview).

- [ ] **Step 1: Write the protocol type module**

Create `src/shared/messages.ts`:

```typescript
import type { DecodedTag } from '../assTags';
import type { RosterRow } from './roster';

export interface ScriptInfoView { key: string; value: string; line: number; }
export interface StyleRowView {
  kind: 'style'; line: number; ok: boolean;
  format: string[]; fields: Record<string, string>;
}
export interface EventDetailView {
  line: number;
  fields: Record<string, string>;
  tags: DecodedTag[];
}

/** Host → Webview. */
export type HostToWebview =
  | { type: 'model'; bom: boolean; scriptInfo: ScriptInfoView[]; styles: { format: string[]; rows: StyleRowView[] }; events: { format: string[]; count: number } }
  | { type: 'eventsRosterBegin'; totalCount: number }
  | { type: 'eventsRosterChunk'; startIndex: number; rows: RosterRow[]; totalCount: number }
  | { type: 'eventsRosterEnd'; totalCount: number }
  | { type: 'eventDetail'; detail: EventDetailView }
  | { type: 'eventPatched'; line: number; roster: RosterRow; detail: EventDetailView };

/** Webview → Host. */
export type WebviewToHost =
  | { type: 'getEventDetail'; lines: number[] }
  | { type: 'edit'; section: string; line: number; fieldIndex: number; value: string }
  | { type: 'addRow' | 'duplicateRow' | 'deleteRow'; section: string; line?: number };
```

- [ ] **Step 2: Write the failing tests**

Create `src/test/roster.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
npm test
```
Expected: FAIL — `Cannot find module '../shared/roster'`.

- [ ] **Step 4: Implement the roster module**

Create `src/shared/roster.ts`:

```typescript
import type { SectionRow } from '../types';

/** Lightweight per-event row used to drive the virtualized list and search.
 *  No decoded tags, no full Text — those arrive on demand via eventDetail. */
export interface RosterRow {
  line: number;
  Start: string;
  End: string;
  Style: string;
  preview: string; // override tags stripped, line breaks flattened, truncated
}

const PREVIEW_MAX = 80;

/** Strip ASS override tags {\...}, flatten \N/\n breaks, collapse whitespace,
 *  truncate to PREVIEW_MAX. Mirrors the webview's prior stripTagsForPreview. */
export function previewOf(text: string): string {
  const clean = (text || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > PREVIEW_MAX ? clean.slice(0, PREVIEW_MAX) : clean;
}

export function buildRosterRow(row: SectionRow): RosterRow {
  const f = row.fields;
  return {
    line: row.line,
    Start: f.Start ?? '',
    End: f.End ?? '',
    Style: f.Style ?? '',
    preview: previewOf(f.Text ?? ''),
  };
}

/** Indices into `roster` whose Style or preview contains `query`
 *  (case-insensitive). Empty/whitespace query → all indices. */
export function filterRosterIndices(roster: RosterRow[], query: string): number[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    const all = new Array<number>(roster.length);
    for (let i = 0; i < roster.length; i++) all[i] = i;
    return all;
  }
  const out: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    const r = roster[i];
    if (r.Style.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/** Replace the roster entry whose line matches, in place. Returns true if found. */
export function patchRosterEntry(roster: RosterRow[], line: number, patch: RosterRow): boolean {
  for (let i = 0; i < roster.length; i++) {
    if (roster[i].line === line) { roster[i] = patch; return true; }
  }
  return false;
}

/** Split `rows` into pages of `size` for chunked transfer. */
export function chunkRoster(rows: RosterRow[], size: number): RosterRow[][] {
  const out: RosterRow[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npm test
```
Expected: PASS — all roster tests green, plus the pre-existing 30 tests still green.

- [ ] **Step 6: Type-check**

Run:
```bash
npm run check-types
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/messages.ts src/shared/roster.ts src/test/roster.test.ts
git commit -m "feat(shared): roster pure logic + protocol types with tests"
```

---

## Task 3: Host — tiered message protocol

**Note:** This task and Task 4 form one atomic contract change. After Task 3 the build and all tests stay green, but the panel will not render at runtime until Task 4 lands the matching webview. That intermediate state is expected.

**Files:**
- Modify: `src/assDocument.ts`
- Modify: `src/assPanel.ts`

**Interfaces:**
- Consumes: `buildRosterRow`, `chunkRoster` (Task 2); `decodeDialogueTags` (existing).
- Produces: `AssDocument.onChanged(): void` and the host half of `HostToWebview` / `WebviewToHost` (Task 1 `messages.ts`).

- [ ] **Step 1: Change `AssDocument` to notify without re-sending the model**

Replace the entirety of `src/assDocument.ts` with:

```typescript
import * as vscode from 'vscode';
import { parseAss } from './assParser';
import type { AssModel } from './types';

export class AssDocument {
  readonly doc: vscode.TextDocument;
  private _model: AssModel;
  private _disposables: vscode.Disposable[] = [];
  private _timer: NodeJS.Timeout | undefined;
  /** Fires (debounced) when the underlying text document changes. The panel
   *  decides whether to treat it as its own edit (already synced) or external. */
  onChanged: () => void = () => {};

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

  /** Re-parse the file from the live TextDocument. Silent — does not notify.
   *  Callers (the panel) decide what to send to the webview afterwards. */
  refresh(): AssModel {
    this._model = parseAss(this.doc.getText());
    return this._model;
  }

  private schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.onChanged(), 200);
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer);
    this._disposables.forEach((d) => d.dispose());
  }
}
```

The only behavior change: the callback no longer carries the model and no longer auto-refreshes. `onModelChange` is renamed `onChanged`.

- [ ] **Step 2: Rewrite `AssPanel` for the tiered protocol**

Replace the entirety of `src/assPanel.ts` with:

```typescript
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AssDocument } from './assDocument';
import { computeFieldEdit, computeScriptInfoEdit, rowStillValid } from './assEdit';
import { decodeDialogueTags } from './assTags';
import { buildRosterRow, chunkRoster } from './shared/roster';
import type { AssModel, SectionRow } from './types';

const ROSTER_CHUNK_SIZE = 2000;

function stripStyleRow(r: SectionRow) {
  return { kind: r.kind, line: r.line, ok: r.ok, format: r.format, fields: r.fields };
}

export class AssPanel {
  private panel: vscode.WebviewPanel;
  private doc: AssDocument;
  private rowsByLine = new Map<number, SectionRow>();
  /** document.version captured after the panel last synced its own edit. Used to
   *  tell our own WorkspaceEdit apart from an external text-editor change. */
  private lastSyncedVersion = 0;
  private _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;

  constructor(doc: AssDocument, context: vscode.ExtensionContext) {
    this.doc = doc;
    this.panel = vscode.window.createWebviewPanel(
      'assStyleEditor',
      `ASS Editor — ${vscode.workspace.asRelativePath(doc.doc.uri)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
        ],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview, context);
    this.doc.onChanged = () => this.onExternalChange();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      this.doc.onChanged = () => {};
      this._onDidDispose.fire();
    });
    this.initialSend();
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
  }

  /** First paint: small model + full roster (chunked). */
  private initialSend(): void {
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  /** External (non-panel) text change: version differs → full resync. */
  private onExternalChange(): void {
    if (this.doc.doc.version === this.lastSyncedVersion) return; // our own edit
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  private reindex(model: AssModel): void {
    this.rowsByLine.clear();
    for (const r of [...model.styles.rows, ...model.events.rows]) this.rowsByLine.set(r.line, r);
  }

  /** Small model: Script Info + full Styles + the Events header (format + count). */
  private sendModel(): void {
    const m = this.doc.model;
    this.panel.webview.postMessage({
      type: 'model',
      bom: m.bom,
      scriptInfo: m.scriptInfo.map((e) => ({ key: e.key, value: e.value, line: e.line })),
      styles: { format: m.styles.format, rows: m.styles.rows.map(stripStyleRow) },
      events: { format: m.events.format, count: m.events.rows.length },
    });
  }

  /** Full events roster, sent in pages so the webview paints progressively. */
  private sendRoster(model: AssModel): void {
    const roster = model.events.rows.map(buildRosterRow);
    const total = roster.length;
    this.panel.webview.postMessage({ type: 'eventsRosterBegin', totalCount: total });
    for (const page of chunkRoster(roster, ROSTER_CHUNK_SIZE)) {
      this.panel.webview.postMessage({
        type: 'eventsRosterChunk',
        startIndex: 0, // webview appends in order; index unused but kept for protocol clarity
        rows: page,
        totalCount: total,
      });
    }
    this.panel.webview.postMessage({ type: 'eventsRosterEnd', totalCount: total });
  }

  /** Respond to expanded-row detail requests (decoded tags included). */
  private sendDetails(lines: number[]): void {
    for (const line of lines) {
      const row = this.rowsByLine.get(line);
      if (!row) continue;
      this.panel.webview.postMessage({
        type: 'eventDetail',
        detail: {
          line,
          fields: { ...row.fields },
          tags: decodeDialogueTags(row.fields.Text ?? ''),
        },
      });
    }
  }

  /** After a panel-initiated event edit: patch one row, not the whole roster. */
  private sendEventPatch(line: number): void {
    const row = this.rowsByLine.get(line);
    if (!row) return;
    this.panel.webview.postMessage({
      type: 'eventPatched',
      line,
      roster: buildRosterRow(row),
      detail: {
        line,
        fields: { ...row.fields },
        tags: decodeDialogueTags(row.fields.Text ?? ''),
      },
    });
  }

  private async onMessage(msg: { type: string; section?: string; line?: number; fieldIndex?: number; value?: string; lines?: number[] }): Promise<void> {
    try {
      if (msg.type === 'edit') return await this.onEdit(msg);
      if (msg.type === 'getEventDetail' && Array.isArray(msg.lines)) return this.sendDetails(msg.lines);
      if (msg.type === 'addRow' && msg.section === 'styles') return this.insertStyle(msg.line);
      if (msg.type === 'duplicateRow' && msg.section === 'styles' && msg.line != null) return this.duplicateStyle(this.clampLine(msg.line));
      if (msg.type === 'deleteRow' && msg.section === 'styles' && msg.line != null) return this.deleteStyle(this.clampLine(msg.line));
    } catch (err) {
      console.warn('AssPanel onMessage error:', err);
      this.onExternalChange(); // recover by full resync
    }
  }

  private clampLine(line: number): number {
    if (!Number.isFinite(line) || line < 0) return 0;
    return Math.min(line, this.doc.doc.lineCount - 1);
  }

  private async insertStyle(afterLine?: number): Promise<void> {
    const rows = this.doc.model.styles.rows;
    const template = rows[rows.length - 1];
    const lineNo = afterLine != null ? this.clampLine(afterLine) : (template?.line ?? this.doc.doc.lineCount - 1);
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
    this.afterStructuralChange();
  }
  private async insertLine(line: number, text: string): Promise<void> {
    const ws = new vscode.WorkspaceEdit();
    ws.insert(this.doc.doc.uri, new vscode.Position(line, 0), text + '\n');
    await vscode.workspace.applyEdit(ws);
    this.afterStructuralChange();
  }

  /** Style add/dup/delete shifts event line numbers → resync model + roster. */
  private afterStructuralChange(): void {
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo') {
      if (msg.line == null) return;
      const entry = this.doc.model.scriptInfo.find((e) => e.line === msg.line);
      if (!entry) return;
      const ln = this.clampLine(msg.line);
      const live = this.doc.doc.lineAt(ln).text;
      if (live.slice(entry.valueRange.startChar, entry.valueRange.endChar) !== entry.value) {
        this.onExternalChange();
        return;
      }
      const e = computeScriptInfoEdit(entry, msg.value ?? '');
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newContent);
      await vscode.workspace.applyEdit(ws);
      this.afterFieldEdit();
      return;
    }
    if (msg.section === 'styles') {
      if (msg.line == null || msg.fieldIndex == null) return;
      const ln = this.clampLine(msg.line);
      const row = this.rowsByLine.get(msg.line);
      if (!row) return;
      const liveLine = this.doc.doc.lineAt(ln).text;
      if (!rowStillValid(liveLine, row)) { this.onExternalChange(); return; }
      const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
      if (!edit) return;
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
      await vscode.workspace.applyEdit(ws);
      this.afterFieldEdit(); // style field edits don't shift event lines
      return;
    }
    // events
    if (msg.line == null || msg.fieldIndex == null) return;
    const ln = this.clampLine(msg.line);
    const row = this.rowsByLine.get(msg.line);
    if (!row) return;
    const liveLine = this.doc.doc.lineAt(ln).text;
    if (!rowStillValid(liveLine, row)) { this.onExternalChange(); return; }
    const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
    if (!edit) return;
    const ws = new vscode.WorkspaceEdit();
    ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
    await vscode.workspace.applyEdit(ws);
    // Event field edits never change line count → sync this one row only.
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendEventPatch(msg.line);
  }

  /** Script Info / Style field edit: model changed, line numbers did not. */
  private afterFieldEdit(): void {
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
  }

  private html(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'panel.js'));
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
  return randomBytes(16).toString('hex');
}
```

- [ ] **Step 3: Type-check**

Run:
```bash
npm run check-types
```
Expected: no errors.

- [ ] **Step 4: Run the test suite**

Run:
```bash
npm test
```
Expected: all tests green (roster tests from Task 2 + the original 30 — none touch `AssPanel`/`AssDocument`).

- [ ] **Step 5: Commit**

```bash
git add src/assDocument.ts src/assPanel.ts
git commit -m "feat(panel): tiered host protocol (small model, chunked roster, on-demand detail, patches)"
```

---

## Task 4: Webview — virtualized events list + new protocol

**Files:**
- Create: `media/src/virtualList.js`
- Modify: `media/src/panel.js`
- Modify: `_temp/ass-preview.html` (new protocol + 71k generator)

**Interfaces:**
- Consumes: `HostToWebview`/`WebviewToHost` (Task 1), `filterRosterIndices`/`patchRosterEntry` (Task 2), `@tanstack/virtual-core`.

- [ ] **Step 1: Create the virtualizer driver module**

Create `media/src/virtualList.js`:

```javascript
// Thin vanilla driver around @tanstack/virtual-core. This is the ONLY file that
// touches the virtualizer API, so any library drift is contained here. See
// TanStack/virtual#455: in non-framework use you must supply the exported
// observeElementRect / observeElementOffset and kick the first computation.
import { Virtualizer, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.scrollEl  scroll container (overflow:auto; position:relative)
 * @param {() => number} opts.getCount  current item count
 * @param {(index: number) => string|number} opts.getKey  stable key for item index
 * @param {(index: number) => HTMLElement} opts.renderRow  build the DOM node for an index
 * @param {() => number} [opts.estimateSize]  estimated row height (default 56)
 * @param {number} [opts.overscan]  default 6
 */
export function createVirtualList(opts) {
  const { scrollEl, getCount, getKey, renderRow, estimateSize = () => 56, overscan = 6 } = opts;
  const inner = document.createElement('div');
  inner.style.position = 'relative';
  inner.style.width = '100%';
  scrollEl.appendChild(inner);

  const mounted = new Map(); // key -> HTMLElement

  const virtualizer = new Virtualizer({
    count: getCount(),
    getScrollElement: () => scrollEl,
    estimateSize,
    overscan,
    getItemKey: getKey,
    observeElementRect,
    observeElementOffset,
    onChange: () => repaint(),
  });
  // Vanilla kickoff (maintainer-confirmed recipe). Guarded so a future rename
  // is a no-op rather than a crash; the observer-driven onChange is the backup.
  if (typeof virtualizer._willUpdate === 'function') virtualizer._willUpdate();

  function repaint() {
    const items = virtualizer.getVirtualItems();
    inner.style.height = virtualizer.getTotalSize() + 'px';
    const seen = new Set();
    for (const it of items) {
      const key = getKey(it.index);
      seen.add(key);
      let el = mounted.get(key);
      if (!el) {
        el = renderRow(it.index);
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.width = '100%';
        el.setAttribute('data-index', String(it.index));
        mounted.set(key, el);
        inner.appendChild(el);
      }
      el.style.transform = `translateY(${it.start}px)`;
      virtualizer.measureElement(el); // dynamic height (expanded rows are taller)
    }
    for (const [key, el] of mounted) {
      if (!seen.has(key)) { el.remove(); mounted.delete(key); }
    }
  }

  /** Count changed (filter / roster reset): recreate the instance cleanly to
   *  avoid mutating the readonly options object. Preserves scroll offset. */
  function setCount() {
    const offset = scrollEl.scrollTop;
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    virtualizer.options.count = getCount();
    if (typeof virtualizer._willUpdate === 'function') virtualizer._willUpdate();
    scrollEl.scrollTop = offset;
    repaint();
  }

  function scrollToIndex(index) { virtualizer.scrollToIndex(index); }

  function destroy() {
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    inner.remove();
  }

  repaint();
  return { repaint, setCount, scrollToIndex, destroy };
}
```

- [ ] **Step 2: Add the events-tab state and protocol handling to the webview**

In `media/src/panel.js`, replace the existing view-state block (the `let model = null; … let eventsListNode = null; …` region near lines 23–35) — keep everything except add the new events state. Insert these declarations alongside the existing view-state vars (after `let eventsFilter = '';`):

```javascript
/* ---------- events virtualization state -------------------------------- */
const roster = [];                      // RosterRow[] (filled from host chunks)
let rosterReady = false;                // all chunks received
let rosterTotal = 0;                    // expected length while streaming
const detailCache = new Map();          // line -> { fields, tags }
const pendingDetail = new Set();        // lines already requested (coalesce)
let filteredIndices = null;             // number[] into roster; null = all
let virtualList = null;                 // createVirtualList() handle
let scrollEl = null;                    // the events scroll container
```

Replace the top-level message listener (currently `window.addEventListener('message', (e) => { model = e.data.model; render(); });`) with a router:

```javascript
window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'model':
      model = { bom: msg.bom, scriptInfo: msg.scriptInfo, styles: msg.styles, events: msg.events };
      render();
      break;
    case 'eventsRosterBegin':
      roster.length = 0;
      rosterTotal = msg.totalCount;
      rosterReady = false;
      detailCache.clear();
      pendingDetail.clear();
      filteredIndices = null;
      showEventsProgress(0);
      break;
    case 'eventsRosterChunk':
      for (const r of msg.rows) roster.push(r);
      showEventsProgress(roster.length / Math.max(1, rosterTotal));
      break;
    case 'eventsRosterEnd':
      rosterReady = true;
      rosterTotal = roster.length;
      filteredIndices = filterRosterIndices(roster, eventsFilter);
      mountOrRepaintEvents();
      showEventsProgress(1);
      break;
    case 'eventDetail':
      detailCache.set(msg.detail.line, msg.detail);
      pendingDetail.delete(msg.detail.line);
      if (virtualList) virtualList.repaint(); // fill the expanded body
      break;
    case 'eventPatched':
      patchRosterEntry(roster, msg.line, msg.roster);
      detailCache.set(msg.line, msg.detail);
      if (eventsFilter.trim()) filteredIndices = filterRosterIndices(roster, eventsFilter);
      if (virtualList) virtualList.repaint();
      updateEventsMeta();
      break;
  }
});
```

Add the imports at the very top of the file (after the header comment block, before `const vscode = …`):

```javascript
import { createVirtualList } from './virtualList.js';
import { filterRosterIndices, patchRosterEntry } from '../../../src/shared/roster.ts';
```

(Yes, the webview imports the host's shared TS — esbuild transpiles it; the `import type` inside it is erased, so no Node code reaches the bundle.)

- [ ] **Step 3: Replace the events rendering with a virtualized list**

In `media/src/panel.js`, replace the entire `eventsContent`, `drawEventsList`, `filteredEvents`, and `eventsMetaText` functions with:

```javascript
/* ---------- Events tab (virtualized) ---------------------------------- */
function eventsContent() {
  const wrap = h('div', { class: 'ae-stack' });
  const scroller = h('div', { class: 'ae-events-scroll' });
  scrollEl = scroller;
  const progress = h('div', { class: 'ae-events-progress', id: 'ae-events-progress' }, 'Loading events…');
  wrap.appendChild(progress);
  wrap.appendChild(scroller);
  // The virtual list mounts once the roster is fully received (eventsRosterEnd).
  if (rosterReady && model) {
    filteredIndices = filterRosterIndices(roster, eventsFilter);
    mountEventsList();
  }
  return wrap;
}

function effectiveCount() {
  return filteredIndices ? filteredIndices.length : roster.length;
}
function rosterAt(i) {
  return roster[filteredIndices ? filteredIndices[i] : i];
}

function mountEventsList() {
  if (!scrollEl) return;
  if (virtualList) { virtualList.destroy(); virtualList = null; }
  if (effectiveCount() === 0) {
    scrollEl.replaceChildren(emptyState('No matching lines', 'Try a different filter or clear the search.'));
    updateEventsMeta();
    return;
  }
  virtualList = createVirtualList({
    scrollEl,
    getCount: effectiveCount,
    getKey: (i) => rosterAt(i).line,
    renderRow: (i) => eventCard(rosterAt(i)),
    estimateSize: () => 56,
    overscan: 8,
  });
  updateEventsMeta();
}

function mountOrRepaintEvents() {
  if (!scrollEl) return;
  if (!virtualList) mountEventsList();
  else virtualList.setCount();
}

function updateEventsMeta() {
  const meta = document.getElementById('ae-events-meta');
  if (meta) meta.textContent = eventsMetaText();
}
function eventsMetaText() {
  const total = roster.length;
  const shown = effectiveCount();
  return shown === total ? `${total} lines` : `${shown} of ${total} lines`;
}

function showEventsProgress(frac) {
  const bar = document.getElementById('ae-events-progress');
  if (!bar) return;
  if (frac >= 1 && rosterReady) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.textContent = `Loading events… ${Math.round(frac * 100)}%`;
}

// Debounced filter: operate on the lightweight roster, no DOM rebuild.
let filterTimer = null;
function setEventsFilter(q) {
  eventsFilter = q;
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filteredIndices = filterRosterIndices(roster, eventsFilter);
    if (scrollEl && virtualList) virtualList.setCount();
    else mountEventsList();
    updateEventsMeta();
  }, 120);
}
```

Wire the search input to `setEventsFilter`. Find the existing search-input handler (the `input.addEventListener('input', () => { eventsFilter = input.value; drawEventsList(); })` near line 198) and replace its callback body with:

```javascript
input.addEventListener('input', () => setEventsFilter(input.value));
```

- [ ] **Step 4: Adapt `eventCard` to roster rows + on-demand detail**

In `media/src/panel.js`, replace the `eventCard`, `toggleEvent`, `tagChips`, and `stripTagsForPreview` functions with:

```javascript
function eventCard(r) {
  const open = openEvents.has(r.line);
  const detail = detailCache.get(r.line);
  const card = h('div', { class: 'ae-event', 'data-open': String(open), 'data-line': String(r.line) });

  const head = h('div', { class: 'ae-event-head', role: 'button', tabindex: '0',
    onclick: () => { toggleEvent(r.line); if (virtualList) virtualList.repaint(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEvent(r.line); if (virtualList) virtualList.repaint(); } },
  },
    h('span', { class: 'ae-event-chevron' }, icon(open ? 'chevron' : 'chevronRight')),
    h('span', { class: 'ae-event-times' },
      h('span', { class: 'ae-t' }, r.Start || ''),
      h('span', { class: 'ae-event-arrow' }, '→'),
      h('span', { class: 'ae-t' }, r.End || '')),
    h('span', { class: 'ae-event-style-tag' }, r.Style || '—'),
    h('span', { class: 'ae-event-preview' }, r.preview || '(empty)'),
  );
  card.appendChild(head);

  if (!open) return card; // collapsed rows render from the roster only

  // Expanded: body needs full detail (Text + decoded tags). Fetch on demand.
  if (!detail) {
    requestDetail(r.line);
    card.appendChild(h('div', { class: 'ae-event-body' }, h('div', { class: 'ae-empty' }, h('span', { class: 'ae-spinner' }), 'Loading…')));
    return card;
  }
  card.appendChild(eventBody(r.line, detail));
  return card;
}

function eventBody(line, detail) {
  const styleSel = eventStyleSelect(detail);
  const textArea = h('textarea', { class: 'ae-textarea', rows: '2',
    onchange: function () { postEdit('events', line, fieldIndexByName('Text'), this.value); } });
  textArea.value = detail.fields.Text || '';
  return h('div', { class: 'ae-event-body' },
    h('div', { class: 'ae-event-times-row' },
      fieldWith('Start', eventTimeInput(line, detail, 'Start')),
      fieldWith('End', eventTimeInput(line, detail, 'End')),
      fieldWith('Style', styleSel)),
    fieldWith('Text', textArea),
    tagChips(detail.tags),
  );
}

function toggleEvent(line) {
  if (openEvents.has(line)) openEvents.delete(line);
  else { openEvents.add(line); requestDetail(line); }
}

function eventTimeInput(line, detail, name) {
  const inp = h('input', { class: 'ae-input ae-mono', type: 'text', value: detail.fields[name] || '' });
  inp.addEventListener('change', () => postEdit('events', line, fieldIndexByName(name), inp.value));
  return inp;
}
function eventStyleSelect(detail) {
  const sel = h('select', { class: 'ae-select' });
  model.styles.rows.forEach(s => sel.appendChild(h('option', { value: s.fields.Name }, s.fields.Name || '(unnamed)')));
  sel.value = detail.fields.Style || '';
  sel.addEventListener('change', () => postEdit('events', lineOfSelect(sel), fieldIndexByName('Style'), sel.value));
  return sel;
}
function lineOfSelect(sel) {
  const card = sel.closest('.ae-event');
  return card ? Number(card.getAttribute('data-line')) : 0;
}

// All events share model.events.format; fieldIndexByName no longer needs a row.
function fieldIndexByName(name) { return model.events.format.indexOf(name); }

function requestDetail(line) {
  if (pendingDetail.has(line)) return;
  pendingDetail.add(line);
  post('getEventDetail', { lines: [line] });
}

function tagChips(tags) {
  if (!tags || !tags.length) return null;
  const wrap = h('div', { class: 'ae-tags' });
  tags.forEach(t => wrap.appendChild(tagChip(t)));
  return wrap;
}
function tagChip(t) {
  const chip = h('span', { class: 'ae-chip' });
  const isColor = /^([1234]?c|alpha|1a|2a|3a|4a)$/.test(t.name);
  if (isColor && t.value) {
    const dec = decodeOnWeb(t.value);
    if (dec) { const sw = h('span', { class: 'ae-chip-swatch' }); sw.style.background = dec.hex; chip.appendChild(sw); }
  }
  chip.appendChild(h('span', { class: 'ae-chip-name' }, '\\' + t.name));
  if (t.value) chip.appendChild(h('span', null, t.value));
  return chip;
}
```

(Remove the now-unused standalone `stripTagsForPreview` — the roster's `preview` field replaces it.)

- [ ] **Step 5: Keep scroll + tab state working across re-renders**

The existing `render()` already preserves `.ae-scroll` scrollTop and `tab`. But the events scroller is now `.ae-events-scroll` and is rebuilt on every `render()`, dropping the mounted virtual list. To avoid tearing down the list on every model message, short-circuit the events-tab rebuild when only event data changed. Replace the `render()` function with:

```javascript
function render() {
  if (!model) { root.replaceChildren(loadingState()); return; }
  const prev = document.querySelector('.ae-events-scroll');
  const top = prev ? prev.scrollTop : 0;
  // If we are staying on the events tab and the list is already mounted, a
  // model re-send (e.g. after an edit) should NOT rebuild the whole shell —
  // the eventPatched handler already repainted the affected row.
  const alreadyOnEvents = tab === 'events' && document.querySelector('.ae-tabbar');
  if (alreadyOnEvents && rosterReady) {
    // Refresh non-events parts (styles select options etc.) cheaply by repainting.
    if (virtualList) virtualList.repaint();
    updateEventsMeta();
    return;
  }
  root.replaceChildren(appShell());
  const next = document.querySelector('.ae-events-scroll');
  if (next) next.scrollTop = top;
  if (tab === 'styles' && focusStyleIndex != null) focusStyleCard(focusStyleIndex);
}
```

(If `appShell` builds the tab content lazily per-tab, ensure the events tab calls `eventsContent()`. Confirm against the existing `appShell`/tab-switching code — the existing code already routes the events tab to `eventsContent()`; that function now mounts the virtual list when `rosterReady`.)

- [ ] **Step 6: Update the preview harness to the new protocol + a 71k generator**

In `_temp/ass-preview.html`, replace the mock-posting `<script>` block (the one defining `mockModel` and `window.__applyHostMessage`) with a version that emits the new message stream. Replace lines ~95–204 (from `const STYLE_FMT =` through the end of `window.__applyHostMessage`) with:

```html
<script>
  const STYLE_FMT = ['Name','Fontname','Fontsize','PrimaryColour','SecondaryColour','OutlineColour','BackColour','Bold','Italic','Underline','StrikeOut','ScaleX','ScaleY','Spacing','Angle','BorderStyle','Outline','Shadow','Alignment','MarginL','MarginR','MarginV','Encoding'];
  const EVENT_FMT = ['Layer','Start','End','Style','Name','MarginL','MarginR','MarginV','Effect','Text'];

  const smallModel = {
    bom: false,
    scriptInfo: [
      { key:'Title', value:'Scale test', line:1 },
      { key:'PlayResX', value:'1920', line:5 },
      { key:'PlayResY', value:'1080', line:6 },
      { key:'WrapStyle', value:'0', line:8 },
    ],
    styles: { format: STYLE_FMT, rows: [
      { kind:'style', line:13, ok:true, format:STYLE_FMT, fields:{ Name:'Default', Fontname:'Arial', Fontsize:'54', PrimaryColour:'&H00FFFFFF&', SecondaryColour:'&H000000FF&', OutlineColour:'&H00000000&', BackColour:'&H80000000&', Bold:'0', Italic:'0', Underline:'0', StrikeOut:'0', ScaleX:'100', ScaleY:'100', Spacing:'0', Angle:'0', BorderStyle:'1', Outline:'2', Shadow:'2', Alignment:'2', MarginL:'48', MarginR:'48', MarginV:'40', Encoding:'1' } },
      { kind:'style', line:14, ok:true, format:STYLE_FMT, fields:{ Name:'Title', Fontname:'Impact', Fontsize:'92', PrimaryColour:'&H00F0F0F0&', SecondaryColour:'&H0000A5FF&', OutlineColour:'&H00101010&', BackColour:'&H00000000&', Bold:'-1', Italic:'0', Underline:'0', StrikeOut:'0', ScaleX:'100', ScaleY:'100', Spacing:'0', Angle:'0', BorderStyle:'1', Outline:'4', Shadow:'3', Alignment:'8', MarginL:'0', MarginR:'0', MarginV:'0', Encoding:'1' } },
    ]},
    events: { format: EVENT_FMT, count: 0 },
  };

  function post(msg) { window.dispatchEvent(new MessageEvent('message', { data: msg })); }
  function sendRoster(rows) {
    post({ type:'eventsRosterBegin', totalCount: rows.length });
    const size = 2000;
    for (let i = 0; i < rows.length; i += size) post({ type:'eventsRosterChunk', startIndex: 0, rows: rows.slice(i, i + size), totalCount: rows.length });
    post({ type:'eventsRosterEnd', totalCount: rows.length });
  }
  function buildRoster(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = i / 10;
      out.push({ line: 100 + i, Start: `0:00:${String(Math.floor(s)).padStart(2,'0')}.${String(Math.round((s%1)*100)).padStart(2,'0')}`, End: `0:00:${String(Math.floor(s+2)).padStart(2,'0')}.00`, Style: i % 7 === 0 ? 'Title' : 'Default', preview: `Line ${i} — the quick brown fox jumps over the lazy dog ${i}` });
    }
    return out;
  }

  function loadEvents(n) {
    smallModel.events.count = n;
    post({ type:'model', ...smallModel });
    sendRoster(buildRoster(n));
  }

  // Initial small load.
  loadEvents(20);

  // On-demand detail + patches (mirrors src/assPanel.ts).
  window.__applyHostMessage = (msg) => {
    try {
      if (msg.type === 'getEventDetail') {
        for (const line of msg.lines) {
          post({ type:'eventDetail', detail: { line, fields:{ Layer:'0', Start:'0:00:01.00', End:'0:00:03.00', Style:'Default', Name:'', MarginL:'0', MarginR:'0', MarginV:'0', Effect:'', Text:`{\\fad(200,200)}Detail for line ${line}` }, tags:[{ name:'fad', value:'(200,200)' }] } });
        }
      } else if (msg.type === 'eventPatched' || msg.type === 'edit') {
        // no-op for preview; the real host round-trips
      }
    } catch (err) { console.error('[preview] host sim error', err); }
  };

  // Scale-test buttons injected into the floating control.
  window.__addScaleButtons = function (ctl, btn) {
    const s10k = btn('10k', () => loadEvents(10000));
    const s71k = btn('71k', () => loadEvents(71234));
    const sep = document.createElement('span'); sep.textContent = '│';
    ctl.append(sep, s10k, s71k);
  };
</script>
```

Then, in the floating-control setup at the bottom of the file (after `ctl.append(dark, light, sep, w480, w640, wFull);`), add:

```javascript
  if (window.__addScaleButtons) window.__addScaleButtons(ctl, btn);
```

- [ ] **Step 7: Build and verify in the preview harness**

Run:
```bash
npm run compile
```
Expected: both bundles build; no errors. Then open `_temp/ass-preview.html` in a browser and verify:
- The events list renders 20 rows, scrolls smoothly.
- Clicking the **71k** button loads 71,234 rows: the progress bar fills, then the list mounts and scrolls at 60fps. Inspect the DOM: only ~15–30 `.ae-event` nodes exist (not 71k).
- Typing in the search box filters instantly (debounced), the "X of Y lines" counter updates, and the DOM node count stays small.
- Expanding a row shows a brief "Loading…" then the editor body (Start/End/Style/Text + tag chips) once `eventDetail` arrives.
- Theme + width toggles still work; the Styles and Script Info tabs render from `smallModel`.

- [ ] **Step 8: Commit**

```bash
git add media/src/virtualList.js media/src/panel.js _temp/ass-preview.html
git commit -m "feat(panel): virtualized events list with roster/detail protocol"
```

---

## Task 5: Large-file fixture + final F5 verification + docs

**Files:**
- Create: `src/test/fixtures/gen-large-events.mjs` (generator, not a committed multi-MB file)
- Modify: `README.md` (note large-file support)
- Update: `C:\Users\USER\.claude\projects\d--PycharmProjects-ass-sibtitle-vscode-extension\memory\ass-extension-state.md`

- [ ] **Step 1: Add a large-.ass generator script**

Create `src/test/fixtures/gen-large-events.mjs`:

```javascript
// Generate a synthetic .ass with N dialogue events for manual scale testing.
// Usage: node src/test/fixtures/gen-large-events.mjs 71234 > _temp/large.ass
import { writeFileSync } from 'node:fs';

const n = Number(process.argv[2] ?? 71234);
const out = process.argv[3] ?? '_temp/large.ass';

const header =
`[Script Info]
Title: Scale test (${n} events)
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,2,2,2,48,48,40,1
Style: Title,Impact,92,&H00F0F0F0&,&H0000A5FF&,&H00101010&,&H00000000&,-1,0,0,0,100,100,0,0,1,4,3,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const lines = [header];
for (let i = 0; i < n; i++) {
  const t = i * 0.1;
  const start = fmt(t);
  const end = fmt(t + 2);
  const style = i % 7 === 0 ? 'Title' : 'Default';
  lines.push(`Dialogue: 0,${start},${end},${style},,0,0,0,,{\\fad(200,200)}Line ${i} — the quick brown fox jumps over the lazy dog.`);
}
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${n} events to ${out}`);

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `0:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Generate the large fixture and verify in the real extension**

Run:
```bash
node src/test/fixtures/gen-large-events.mjs 71234
```
Expected: prints `Wrote 71234 events to _temp/large.ass`.

Then in VS Code (F5 → Extension Development Host):
- Open `_temp/large.ass`.
- Run **ASS: Open Style Editor**.
- Verify: the Events tab opens within ~1–2s, scrolls smoothly, search filters instantly, expanding a row loads its detail and edits round-trip to the file (check the text editor reflects the change), and scroll position survives an edit.
- Verify the Styles and Script Info tabs still work.

- [ ] **Step 3: Run the full test + type-check suite**

Run:
```bash
npm run check-types && npm test
```
Expected: no type errors; all tests pass (roster + original 30).

- [ ] **Step 4: Document large-file support**

In `README.md`, add a one-line note in the features section, e.g.:

```markdown
- **Handles huge files** — events are virtualized, so files with tens of thousands of dialogue lines open instantly and scroll/search at 60fps.
```

- [ ] **Step 5: Update project memory**

Update `C:\Users\USER\.claude\projects\d--PycharmProjects-ass-sibtitle-vscode-extension\memory\ass-extension-state.md` to record: events list is now virtualized (`@tanstack/virtual-core`, tiered roster/detail protocol), webview is bundled to `dist/panel.js`, and F5 verification on a 71k-event file is complete. Append a one-line pointer to `MEMORY.md` if a new memory file is warranted.

- [ ] **Step 6: Commit**

```bash
git add src/test/fixtures/gen-large-events.mjs README.md
git commit -m "test+docs: large-file fixture generator; document virtualized events"
```

(The memory file lives outside the repo and is updated directly, not committed.)

---

## Self-Review (run after writing, before handoff)

**1. Spec coverage:** Every spec section maps to a task — §4.1 tiered payloads → Task 3 (host) + Task 4 (webview); §4.2 virtualization → Task 4 Step 1–3; §4.3 search → Task 4 Step 3 (`setEventsFilter`); §4.4 edit loop → Task 3 `sendEventPatch` / `afterFieldEdit` + Task 4 `eventPatched` handler; §5 protocol → Task 2 (`messages.ts`) + Tasks 3/4; §6 build → Task 1; §8 testing → Task 2 unit tests + Task 5 fixture/F5; §9 risks → contained in `virtualList.js` driver (Task 4 Step 1). ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling". Each code step has complete code. ✓

**3. Type consistency:** `RosterRow` shape (`{line, Start, End, Style, preview}`) is identical in `roster.ts`, `messages.ts`, host `buildRosterRow`, and webview usage. `fieldIndexByName` changed from `(row, name)` to `(name)` consistently in Task 4 Step 4 and its callers. `onChanged()` (no args) matches in `assDocument.ts` and the `assPanel.ts` assignment `this.doc.onChanged = () => this.onExternalChange()`. ✓

**4. Known coupling:** Tasks 3 and 4 land one atomic contract; the panel is non-functional at runtime between them (build/tests stay green). Stated explicitly in Task 3's note. ✓
