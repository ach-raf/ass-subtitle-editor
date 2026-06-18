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
