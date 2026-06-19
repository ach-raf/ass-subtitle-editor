# Virtualized Events List — Design

**Date:** 2026-06-19
**Status:** Approved (brainstormed)
**Working directory:** `d:\PycharmProjects\ass_sibtitle_vscode_extension`

## 1. Purpose

An `.ass` file with **71,000+ events** will not open the editor tab today — the
webview freezes before it can paint. The goal is a **perfect experience for
loading, scrolling, and searching** lists of that size, while keeping the Events
tab **visually and interactionally identical** to today (same Depth-styled cards,
same inline expand-to-edit).

The fix is standard virtualization ("windowing"): only the rows the user can see
are rendered into the DOM. No new interaction model is introduced.

## 2. Root cause (current architecture)

The freeze is not a single bottleneck — it compounds across four layers, so
fixing only the DOM is insufficient:

1. **Host serializes everything.** `AssPanel.send`
   ([src/assPanel.ts:47-58](src/assPanel.ts#L47-L58)) builds a full view object
   for every event *and* runs `decodeDialogueTags` on each one, then ships the
   whole blob (≈100 MB for 71k events) through a single `postMessage`.
2. **Webview parses** that ≈100 MB JSON synchronously on the renderer thread.
3. **DOM explosion.** `drawEventsList`
   ([media/panel.js:418](media/panel.js#L418)) calls
   `eventsListNode.replaceChildren(...rows.map(r => eventCard(r)))`, building a
   full card (header + body + textarea + select + tag chips) per event — well
   over a million DOM nodes. This is what finally tips the tab over.
4. **Edit loop.** Every single field edit triggers a full re-parse, a full
   re-serialize of all events, and a full re-render
   ([src/assDocument.ts:25-28](src/assDocument.ts#L25-L28)).

The key enabler: the host already holds the fully parsed `AssModel` in memory
and the source of truth is the live `vscode.TextDocument`
([src/assDocument.ts:6,14](src/assDocument.ts#L6)). The webview therefore never
needs all 71k rows at once.

## 3. Decisions (from brainstorming)

- **Interaction model: unchanged.** Inline expand-to-edit stays exactly as today.
  The user explicitly rejected master-detail / modal alternatives — same view,
  just virtualized. Expanded rows are taller, so the virtualizer must support
  **dynamic row heights**.
- **Virtualizer: `@tanstack/virtual-core`** (the framework-agnostic core of
  TanStack Virtual, ≈5 KB). Chosen over hand-rolling because dynamic-height
  windowing has subtle failure modes (scroll jumps on expand, resize, scroll
  restoration) that the library already solves. This is the "don't reinvent"
  choice; reusing an established library is a standing preference.
- **Roster transfer:** the webview receives a **lightweight roster** of every
  event (so client-side search stays instant) plus **on-demand full detail** for
  expanded rows only. Tag decoding becomes lazy.
- **Edit loop:** single-row patches instead of full re-sends.
- **Scope:** only the Events tab changes. Styles tab, Script Info tab, host
  parsing, host edit logic, and the Depth CSS are untouched.

## 4. Architecture

### 4.1 Three payload tiers replace one giant `model` message

| Tier | When sent | Contents | Approx. size @71k |
|------|-----------|----------|--------------------|
| **Small model** | load + structural change | `scriptInfo`, `styles`, `events.format`, `events.count` | KB |
| **Roster** | load + structural change, **chunked** | `[{line, Start, End, Style, preview}]` per event | ≈6 MB total, in 5k-row pages |
| **Detail** | on demand (row expanded) | `{line, fields, tags}` for one event | KB per row, cached |

The roster is computed host-side with a cheap regex tag-strip + truncation for
`preview` (mirrors the existing `stripTagsForPreview` in
[media/panel.js:504](media/panel.js#L504)). Collapsed cards render entirely from
the roster; `decodeDialogueTags` runs **only** for rows that get expanded.

Roster is sent in chunks (e.g. 5,000 rows per message) so the UI paints
progressively and shows a loading progress bar — never blocking on one giant
parse. Detail is requested per expanded row, batched/throttled, and cached in a
`Map<line, detail>` keyed by line number.

### 4.2 Virtualized rendering

The events list becomes a windowed scroller:

- A tall spacer div gives the full scroll height (`count × measuredRowHeight`).
- Only the visible window plus an overscan buffer (~30–60 cards) exist in the
  DOM at any time.
- `@tanstack/virtual-core`'s `measureElement` handles dynamic heights so
  expanded rows (taller) measure correctly and neighbors reflow.
- Collapsed-card markup, classes, and styling are **unchanged** — `eventCard`
  is reused, just rendered for fewer rows.
- Scroll position and the `openEvents` set (keyed by line) are preserved across
  re-renders exactly as today.

### 4.3 Search stays client-side and instant

`eventsFilter` runs over the in-webview roster (O(n), ≈10 ms at 71k), debounced
≈120 ms, producing a filtered index array. The virtualizer's row count becomes
`filtered.length`; it does **not** rebuild the DOM. Matching stays
Text + Style (lowercased `includes`), and the "X of Y lines" counter is updated
in place — both as today.

### 4.4 Edit loop sends single-row patches

On a field edit:

1. Webview posts the existing `edit` message (unchanged protocol shape).
2. Host applies the `WorkspaceEdit` and re-parses (cheap — line splitting only).
3. Instead of re-sending all events, host sends one **patch**:
   `{ type: 'eventPatched', line, fields, tags, rosterDelta }` where
   `rosterDelta` updates whichever of Start/End/Style/preview changed.
4. Webview updates the roster entry, the detail cache (if that row is expanded),
   and re-renders only that one card. Scroll and open-state are untouched.

External bulk edits (e.g. the user edits the raw `.ass` in the text editor) still
trigger a roster re-send (chunked, with progress) via the existing 200 ms debounce.

## 5. Message protocol (new)

**Host → Webview**
- `{ type: 'model', scriptInfo, styles, events: { format, count } }` — small.
- `{ type: 'eventsRosterChunk', startIndex, rows: [...], totalCount }` — roster
  page; webview assembles into one array and updates progress.
- `{ type: 'eventsRosterEnd', totalCount }` — roster complete; hide progress bar.
- `{ type: 'eventDetail', line, fields, tags }` — response to a detail request.
- `{ type: 'eventPatched', line, fields, tags, rosterDelta }` — post-edit patch.

**Webview → Host**
- `{ type: 'getEventDetail', lines: number[] }` — request detail for a batch of
  newly expanded rows (throttled/coalesced).
- `{ type: 'edit', section, line, fieldIndex, value }` — unchanged.

The existing `addRow` / `duplicateRow` / `deleteRow` style messages and all
Script Info handling are unchanged. Styles rows are still sent in full on the
`model` message (they number in the tens — no scaling concern).

## 6. Build changes

- **Add dependency:** `@tanstack/virtual-core` to `package.json`.
- **Bundle the webview.** Today `media/panel.js` is served raw and unbundled. To
  `import` the virtualizer, add a second esbuild entry in
  [esbuild.mjs](esbuild.mjs): `media/src/panel.js` → `dist/panel.js`, with
  `platform: 'browser'`, `format: 'iife'` (CSP nonce is already wired in the HTML
  template). Both host and webview build under the existing `watch`/`compile`
  scripts. The webview HTML in [src/assPanel.ts:153](src/assPanel.ts#L153) is
  repointed at the bundled `dist/panel.js`.
- `.vscodeignore` is updated so `dist/panel.js` ships but `media/src` does not.

## 7. What is unchanged (non-goals)

- Styles tab, Script Info tab, host parsing, host edit/`WorkspaceEdit` logic.
- The Depth Design System styling of event cards.
- Inline expand-to-edit interaction.
- Matching semantics of search (Text + Style).

Explicit **YAGNI** for now (easy to add later): sorting, bulk/batch editing,
column reflow into a true grid, and a host-side-search fallback for files beyond
~1 M rows. The chunked roster + client-side search comfortably handles the
expected scale (low hundreds of thousands of rows).

## 8. Testing

- **Existing tests preserved:** the 30/30 host-side parser/edit/color/tag tests
  are unaffected (no host logic changes to the parser or edit math).
- **New webview-layer tests:** roster assembly from chunks, filtered-index
  computation, and patch application are pure functions — unit-testable in the
  existing mocha setup (the panel view layer is already structured to be
  preview-harness testable per its header comment).
- **Scale fixture:** add a synthetic large `.ass` fixture (or generate one at
  test time) to exercise the chunked roster path without committing a multi-MB
  file.
- **Manual verification (F5):** open a 71k-event file, confirm instant open,
  smooth scroll, instant search, and that expand/edit/scroll-survive-edit all
  work. This closes the long-standing "F5 interactive verification pending" item.

## 9. Risks & mitigations

- **Dynamic-height scroll jumps:** mitigated by using `measureElement` from a
  battle-tested library rather than hand-rolling.
- **Detail fetch latency on expand:** show a lightweight shimmer in the card
  body until `eventDetail` arrives (one round trip).
- **Stale line keys after external edits:** the roster re-send resets indices;
  `openEvents`/detail cache are keyed by line and gracefully drop entries that
  no longer exist.
- **CSP / bundling:** the webview already runs under a strict nonce CSP; the
  bundled IIFE is served through the same nonce-protected `<script>` tag, so no
  policy change is needed.
