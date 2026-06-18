# ASS Subtitle Viewer/Editor — VS Code Extension Design

**Date:** 2026-06-18
**Status:** Approved (brainstormed)
**Working directory:** `d:\PycharmProjects\ass_sibtitle_vscode_extension`

## 1. Purpose

VS Code extension for `.ass` (Advanced SubStation Alpha) subtitle files, aimed at
fansub/typesetting workflows. Delivers three goals stated by the user:

1. **View `.ass` files better** — syntax highlighting across the whole file.
2. **Understand the style table** — a decoded panel showing what every field means
   (colors as swatches, alignment on a numpad, font, margins, etc.).
3. **Change what to make what I want** — in-panel editing of Script Info, Styles, and
   Events, written back to the file.

## 2. Decisions (from brainstorming)

- **Scope tier:** Full toolkit (syntax highlighting + decoded/editable panel).
- **Sections parsed & editable in the panel:** Styles, Events, **and** Script Info.
  (Syntax highlighting covers the whole file regardless.)
- **Color editing:** Visual color picker + hex input + alpha/opacity slider, with the
  raw `&HAABBGGRR` code always visible and live-synced. The user never hand-translates
  the confusing `&HAABBGGRR` format.
- **Architecture:** **Approach 1** — command-triggered Webview panel alongside a normal
  text document, with two-way sync. Chosen over Custom Editor (Approach 2) and read-only
  preview (Approach 3) because it is the only option that delivers full in-panel editing
  while keeping the raw text fully accessible (typesetters hand-edit constantly), and it
  makes undo/save behave naturally via `WorkspaceEdit`.
- **Mockups:** text/ASCII during design (visual companion declined for now).

## 3. ASS format primer (requirements context)

- An `.ass` file is INI-like with sections: `[Script Info]`, `[V4+ Styles]`, `[Events]`
  (and occasionally `[Fonts]`, `[Pictures]`).
- In `[V4+ Styles]` a `Format:` line defines the column order; each `Style:` line is
  comma-separated values in that order. The same `Format:` mechanism applies to
  `[Events]` (`Layer, Start, End, Style, Name, ...`).
- Colors are `&HAABBGGRR` — Alpha, Blue, Green, Red. Alpha is inverted: `00` = fully
  opaque, `FF` = fully transparent. RGB byte order is reversed from normal hex.
- Alignment is numpad-style: `1`–`3` bottom, `4`–`6` middle, `7`–`9` top.
- Events text contains override tags in braces, e.g. `{\pos(320,400)\c&HFF&\fad(200,200)}text`.
- Files are usually UTF-8 (sometimes with BOM). v1 targets UTF-8 only.

## 4. Architecture & components

Stack: TypeScript host bundled with `esbuild`; vanilla-JS webview (no UI framework);
TextMate grammar for highlighting; Mocha test runner.

Each module has one responsibility and is independently unit-testable in Node.

| Module | Responsibility |
| --- | --- |
| `src/assColor.ts` | `&HAABBGGRR` ↔ `{r,g,b,a}` / hex `#RRGGBB`, both directions. Pure functions. |
| `src/assParser.ts` | Parse document text → `AssModel` (ScriptInfo, Style[], Event[]). Records line number + char range for every parsed field so edits map back exactly. |
| `src/assEdit.ts` | Given (target line, field index, new value) produce the replacement string + precise `Range` to swap. Surgical line edits; never a full-file rewrite. |
| `src/assDocument.ts` | One instance per open `.ass`: caches the model, listens to `workspace.onDidChangeTextDocument`, debounces a re-parse, exposes current model to the panel. |
| `src/assPanel.ts` | WebviewPanel lifecycle. Serializes model → JSON → webview. Receives edit messages → builds `WorkspaceEdit` → applies to the document. |
| `src/extension.ts` | Activation (on `.ass`), registers `ass.openStyleEditor` command, language id, grammar, file association. |
| `syntaxes/ass.tmLanguage.json` | TextMate grammar: sections, keys, `Format:`/`Style:`/`Dialogue:` lines, override tags, timestamps, `&H` colors. |
| `media/panel.html`, `media/panel.js`, `media/panel.css` | Renders Script Info / Styles / Events; posts edits live. |

### Data model

The parser is **pure** — no import of the `vscode` module — so it is unit-testable in
plain Node. Ranges are plain serializable structs; the host (`assPanel`/`assEdit`) adapts
them to `vscode.Range` at the boundary.

```ts
interface FieldRange { line: number; startChar: number; endChar: number; }

interface AssModel {
  bom: boolean;                 // preserve BOM on write
  scriptInfo: { key: string; value: string; line: number; valueRange: FieldRange }[];
  styles: { format: string[]; rows: StyleRow[] };   // format = column order from Format: line
  events:  { format: string[]; rows: EventRow[] };  // rows = Dialogue + Comment
  // Any line the parser could not classify is kept here verbatim and re-emitted untouched.
  verbatim: { line: number; text: string }[];
}
interface StyleRow {
  name: string; fields: Record<string, string>; line: number; fieldRanges: FieldRange[]; ok: boolean;
}
interface EventRow {
  type: 'Dialogue' | 'Comment';
  fields: Record<string, string>; line: number; fieldRanges: FieldRange[]; ok: boolean;
}
```

## 5. Data flow (two-way sync)

1. Open `.ass` → grammar colors it.
2. Run **ASS: Open Style Editor** → host parses the active document → posts `AssModel`
   JSON to the webview → webview renders.
3. Edit a field in the panel → webview posts `{section, index, field, value}` → host
   re-reads that exact line and **verifies the field count still matches** the parsed
   `format` (guards against a stale parse) → builds a `WorkspaceEdit` replacing only that
   field's `Range` → applies → document is dirty → user saves with Ctrl+S; undo works.
4. Edit raw text in the editor → debounced re-parse → panel refreshes. Colors round-trip
   via `assColor`: picker value → encode to `&HAABBGGRR` → write → decode on next render.

## 6. Panel layout (v1)

Tabs: **Script Info**, **Styles**, **Events**. A header shows file name + a manual
re-sync button (auto-sync is the default).

- **Script Info:** editable key/value rows for `PlayResX/Y`, `WrapStyle`, `ScaledBorderAndShadow`, `YCbCr Matrix`, etc. Free-form keys preserved.
- **Styles:** one card per style. Color inputs for Primary/Secondary/Outline/Back each
  show: swatch, `<input type=color>`, hex field, alpha slider, and the read-only raw
  `&H` code — all synced. Plus font name/size, Bold/Italic/Underline/StrikeOut toggles,
  ScaleX/Y, Spacing, Angle, BorderStyle (outline vs opaque box), Outline, Shadow,
  Alignment (visual 3×3 numpad picker), Margins L/R/V, Encoding. Per-card duplicate / delete / add.
- **Events:** searchable list. Each row: `Start → End · Style · text` (override tags
  shown decoded as chips). Editable in v1: Start, End, Style (dropdown of style names),
  and text. **Text is edited as a raw string** — override tags may be typed as plain text
  (e.g. `{\pos(320,400)}`), but there is no structured per-tag editor UI in v1. Deep
  override-tag *editing* is out of scope; only decoded *display* is provided.

ASCII sketch:

```text
┌─ ASS Editor — Major 2nd - 01.ass ───────────────────────────┐
│ [Script Info]  [Styles (6)]  [Events (412)]        ⟳ re-sync│
│─────────────────────────────────────────────────────────────│
│ STYLES                                                       │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Default     [██] #F9F4F1  &H00F1F4F9  α▬▬▬░░░░░ 0%       │ │
│ │   Font: LTFinnegan Medium 78   Bold □ Ital □            │ │
│ │   Outline 3.75  Shadow 1.5  Border: ●outline  Align: ▼2 │ │
│ │   Margin L135 R135 V53   Encode 1           [del] [dup] │ │
│ └─────────────────────────────────────────────────────────┘ │
│  + add style                                                 │
└──────────────────────────────────────────────────────────────┘
```

## 7. Robustness — the round-trip invariant

**Parsing a file and writing every parsed line back unchanged must reproduce the
original file byte-for-byte.** This is the primary correctness test and drives the design:

- **Lenient parser:** unknown/extra sections and lines are kept verbatim and re-emitted
  untouched. A `Style:`/`Dialogue:` row whose field count does not match its `Format:`
  line is flagged `ok:false`, shown with a "⚠ unparsed" marker, and never edited.
- **Surgical writes:** edits replace a single field's `Range`; nothing else moves.
- **Stale-parse guard:** before applying an edit, the host re-reads the current line and
  confirms the field count still matches. On mismatch it aborts that edit and re-syncs.
- **BOM preserved** on write. **UTF-8 only** in v1 (Shift-JIS / other legacy encodings
  are a documented limitation — never silently mangled).

## 8. Testing

Unit tests (Node/Mocha):

- `assColor`: both directions; alpha inversion; short forms; malformed inputs.
- `assParser`: fixture `.ass` files → expected `AssModel`.
- `assEdit`: targeted line replacement produces correct string + range.
- **Round-trip:** for several real `.ass` samples (including ones with BOM, unknown
  sections, and a malformed style row), parse then re-emit must equal the input bytes.

Manual (F5 launch): open a sample `.ass`; edit fields in the panel; confirm the document
diff, Ctrl+S, and undo behave correctly; confirm raw-text edits refresh the panel.

## 9. v1 scope

**In:** full-file syntax highlighting; editable Script Info; editable Styles (all fields
+ color picker + alpha + add/duplicate/delete); Events list with timing/style/text editing
and decoded override-tag display; two-way sync; round-trip safety.

**Out (v1):** deep override-tag editing UI; karaoke editor; non-UTF-8 encodings;
Aegisub-style video preview; language-server features (completion/hover/validation) —
these may follow in later versions.
