/* =========================================================================
   ASS Subtitle Editor — panel view layer (Studio redesign)
   ---------------------------------------------------------------------------
   This file renders the webview. It NEVER talks to the document directly:
   every change is a postMessage to the host (src/assPanel.ts), and the host
   replies with a fresh model that triggers a full re-render. Therefore:
     • Commit on `change` (not `input`) so one edit = one WorkspaceEdit,
       keeping the undo stack clean (mirrors original "Important #4").
     • Pure-view state (active tab, collapsed styles, open events, scroll)
       is persisted in module vars so it survives those full re-renders.
   The message shapes (edit / addRow / duplicateRow / deleteRow) and the
   color decode/encode are unchanged from the original panel.
   ========================================================================= */

import { createVirtualList } from './virtualList.js';
import { filterRosterIndices, patchRosterEntry } from '../../src/shared/roster.ts';

// Standalone-safe: in the real webview acquireVsCodeApi() exists; in the
// preview harness it is shimmed so this same file runs unmodified.
const vscode = (typeof acquireVsCodeApi === 'function')
  ? acquireVsCodeApi()
  : { postMessage: (m) => console.debug('[preview] postMessage', m) };

const root = document.getElementById('root');

/* ---------- view state (survives full re-renders) --------------------- */
let model = null;
let tab = 'styles';
const collapsedStyles = new Set(); // keyed by style LINE (not name) so two
                                    // styles sharing a name — e.g. a freshly
                                    // added copy — collapse independently
const openEvents = new Set();       // keyed by event line (stable: events
                                    // can't be added/deleted from the panel)
let eventsFilter = '';

/* ---------- events virtualization state -------------------------------- */
const roster = [];                      // RosterRow[] (filled from host chunks)
let rosterReady = false;                // all chunks received
let rosterTotal = 0;                    // expected length while streaming
const detailCache = new Map();          // line -> { fields, tags }
const pendingDetail = new Set();        // lines already requested (coalesce)
let filteredIndices = null;             // number[] into roster; null = all
let virtualList = null;                 // createVirtualList() handle
let scrollEl = null;                    // the events scroll container

let focusStyleIndex = null;         // set on add/duplicate so the new card is
                                    // scrolled into view + name focused after
                                    // the host re-sends the model

/* ---------- field groupings ------------------------------------------- */
const STYLE_COLOR_FIELDS = ['PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour'];
const STYLE_BOOL_FIELDS = [ // [field, short kbd, label]
  ['Bold', 'B', 'Bold'],
  ['Italic', 'I', 'Italic'],
  ['Underline', 'U', 'Underline'],
  ['StrikeOut', 'S', 'Strike'],
];
const COLOR_PRETTY = { PrimaryColour: 'Primary', SecondaryColour: 'Secondary', OutlineColour: 'Outline', BackColour: 'Background' };
const SI_DISPLAY = new Set(['PlayResX', 'PlayResY', 'WrapStyle', 'ScaledBorderAndShadow', 'Collisions', 'PlayDepth', 'Timer', 'YCbCr Matrix']);

/* ---------- host protocol --------------------------------------------- */
function post(type, extra = {}) { vscode.postMessage({ type, ...extra }); }
function postEdit(section, line, fieldIndex, value) {
  vscode.postMessage({ type: 'edit', section, line, fieldIndex, value });
}
function fieldIndexByName(row, name) { return row.format.indexOf(name); }

/* ---------- hyperscript helper (tiny, CSP-safe glue) ------------------ */
function h(tag, attrs, ...kids) {
  const n = (tag === 'svg')
    ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in n) { try { n[k] = v; } catch { n.setAttribute(k, v); } }
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return n;
}

/* ---------- icons (inline SVG, currentColor, no external font) -------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>',
  warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  unfold: '<path d="m7 9 5-5 5 5M7 15l5 5 5-5"/>',
  fold: '<path d="m7 4 5 5 5-5M7 20l5-5 5 5"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/* ---------- top-level render ------------------------------------------ */
window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'model':
      model = { bom: msg.bom, scriptInfo: msg.scriptInfo, styles: msg.styles, events: msg.events };
      // Optimization: if we are already on the events tab with a mounted,
      // fully-received roster, a model re-send (e.g. after an edit) should NOT
      // rebuild the whole shell — the eventPatched handler already re-rendered
      // the affected row. render() otherwise always does a full rebuild. NOTE:
      // this only fires for plain model re-sends; a fresh file/roster load is
      // driven by eventsRosterBegin/End, whose setCount path handles the count
      // change without needing render().
      if (tab === 'events' && virtualList && rosterReady) {
        updateEventsMeta();
      } else {
        render();
      }
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
      if (virtualList) virtualList.rerender(); // fill the expanded body
      break;
    case 'eventPatched': {
      patchRosterEntry(roster, msg.line, msg.roster);
      // The host omits `tags` when a non-Text field was patched (they can't
      // have changed) — preserve the previously-cached chips in that case.
      const prevDetail = detailCache.get(msg.line);
      const merged = (msg.detail.tags != null)
        ? msg.detail
        : { ...msg.detail, tags: prevDetail?.tags ?? [] };
      detailCache.set(msg.line, merged);
      if (eventsFilter.trim()) {
        // A patch can change a row's filter membership (e.g. editing Text to
        // match/stop-matching the query) → recompute the index window and have
        // the virtualizer re-derive its count. rerender() alone would keep the
        // stale count and the row could vanish/appear out of window.
        filteredIndices = filterRosterIndices(roster, eventsFilter);
        if (virtualList) virtualList.setCount();
      } else if (virtualList) {
        // No filter: count is unchanged, just refresh the patched row's DOM.
        virtualList.rerender();
      }
      updateEventsMeta();
      break;
    }
  }
});

// Clear the pending add/duplicate focus intent on the first real user
// interaction so the auto-focus never fights an in-progress edit. (Programmatic
// .focus() does not fire these, so the intent survives the host's renders.)
root.addEventListener('pointerdown', () => { focusStyleIndex = null; }, true);
root.addEventListener('keydown', () => { focusStyleIndex = null; }, true);

function render() {
  if (!model) { root.replaceChildren(loadingState()); return; }
  const prev = document.querySelector('.ae-scroll');
  const top = prev ? prev.scrollTop : 0; // preserve scroll across re-render
  root.replaceChildren(appShell());
  const next = document.querySelector('.ae-scroll');
  if (next) next.scrollTop = top;
  // A just-added/duplicated style should surface itself, not land out of view.
  // Re-apply on every render while the intent is set (the host can fire the
  // model more than once per edit); the intent is cleared by the first real
  // user interaction, so it never fights an in-progress edit.
  if (tab === 'styles' && focusStyleIndex != null) focusStyleCard(focusStyleIndex);
}

// Bring the Nth style card into view, force it open, and focus+select its name
// so the user can rename immediately. Manual scrollTop math (not
// scrollIntoView) to avoid disturbing the scroll container.
function focusStyleCard(index) {
  const card = document.querySelectorAll('.ae-scroll .ae-card')[index];
  if (!card) return;
  const line = Number(card.getAttribute('data-line'));
  collapsedStyles.delete(line);                  // ensure the new card is open
  card.setAttribute('data-collapsed', 'false');  // (line-keyed: won't affect others)
  const title = card.querySelector('.ae-card-title');
  const scroller = document.querySelector('.ae-scroll');
  if (scroller) {
    const cTop = card.getBoundingClientRect().top;
    const sTop = scroller.getBoundingClientRect().top;
    scroller.scrollTop += (cTop - sTop) - 12; // card ~12px below the toolbar
  }
  if (title) { title.focus(); title.select(); }
}

function appShell() {
  return h('div', { class: 'ae-app' },
    header(),
    toolbar(),
    h('div', { class: 'ae-scroll' }, h('div', { class: 'ae-stack' }, content())),
  );
}

function header() {
  return h('div', { class: 'ae-header' },
    h('div', { class: 'ae-brand' }, 'ASS Editor'),
    h('div', { class: 'ae-tabs', role: 'tablist' },
      tabButton('scriptInfo', 'Script Info'),
      tabButton('styles', 'Styles'),
      tabButton('events', 'Events'),
    ),
  );
}
function tabButton(t, label) {
  const count = tabCount(t);
  return h('button', {
    class: 'ae-tab', role: 'tab',
    'aria-selected': String(t === tab),
    onclick: () => { tab = t; render(); },
  }, label, count != null ? h('span', { class: 'ae-tab-count' }, String(count)) : null);
}
function tabCount(t) {
  if (!model) return null;
  if (t === 'styles') return model.styles.rows.length;
  if (t === 'events') return model.events.count;
  if (t === 'scriptInfo') return model.scriptInfo.length;
  return null;
}

/* ---------- per-tab toolbar ------------------------------------------- */
function toolbar() {
  if (tab === 'styles') {
    const rows = model.styles.rows;
    const n = rows.length;
    return h('div', { class: 'ae-toolbar' },
      h('button', { class: 'ae-btn ae-btn--accent',
        onclick: () => { focusStyleIndex = rows.length; post('addRow', { section: 'styles' }); } },
        icon('plus'), 'New style'),
      h('div', { class: 'ae-spacer' }),
      h('button', { class: 'ae-icon-btn', title: 'Expand all styles',
        onclick: () => { collapsedStyles.clear(); render(); } }, icon('unfold')),
      h('button', { class: 'ae-icon-btn', title: 'Collapse all styles',
        onclick: () => { rows.forEach(r => collapsedStyles.add(r.line)); render(); } },
        icon('fold')),
      h('span', { class: 'ae-toolbar-meta' }, `${n} style${n === 1 ? '' : 's'}`),
    );
  }
  if (tab === 'events') {
    const input = h('input', { class: 'ae-input', type: 'text', placeholder: 'Filter by text or style…', value: eventsFilter });
    input.addEventListener('input', () => setEventsFilter(input.value));
    return h('div', { class: 'ae-toolbar' },
      h('div', { class: 'ae-search' }, icon('search'), input),
      h('button', { class: 'ae-icon-btn', title: 'Expand all', onclick: () => { roster.forEach(r => openEvents.add(r.line)); if (virtualList) virtualList.repaint(); } }, icon('unfold')),
      h('button', { class: 'ae-icon-btn', title: 'Collapse all', onclick: () => { openEvents.clear(); if (virtualList) virtualList.repaint(); } }, icon('fold')),
      h('div', { class: 'ae-spacer' }),
      h('span', { class: 'ae-toolbar-meta', id: 'ae-events-meta' }, eventsMetaText()),
    );
  }
  return h('div', { class: 'ae-toolbar' },
    h('div', { class: 'ae-spacer' }),
    model.bom ? h('span', { class: 'ae-badge' }, icon('warning'), 'UTF-8 BOM') : null,
    h('span', { class: 'ae-toolbar-meta' }, `${model.scriptInfo.length} keys`),
  );
}

/* ---------- per-tab content ------------------------------------------- */
function content() {
  if (tab === 'styles') return stylesContent();
  if (tab === 'events') return eventsContent();
  return scriptInfoContent();
}

/* ---------- Styles tab ------------------------------------------------ */
function stylesContent() {
  const stack = h('div', { class: 'ae-stack' });
  if (!model.styles.rows.length) {
    stack.appendChild(emptyState('No styles yet', 'Create a style to define fonts, colors, and layout for a group of subtitles.'));
    stack.appendChild(h('div', { class: 'ae-center' },
      h('button', { class: 'ae-btn ae-btn--accent', onclick: () => post('addRow', { section: 'styles' }) }, icon('plus'), 'Create style')));
  } else {
    model.styles.rows.forEach(r => stack.appendChild(styleCard(r)));
  }
  return stack;
}

function styleCard(row) {
  const name = row.fields.Name || '(unnamed)';
  const collapsed = collapsedStyles.has(row.line);
  const card = h('div', { class: 'ae-card' + (row.ok ? '' : ' ae-card--bad'), 'data-collapsed': String(collapsed), 'data-line': String(row.line) });

  // Header: identity swatch (PrimaryColour) + editable name + actions.
  const dot = h('span', { class: 'ae-card-dot' });
  const dotColor = decodeOnWeb(row.fields.PrimaryColour || '');
  if (dotColor) dot.style.background = dotColor.hex; // dynamic value via CSSOM (CSP-safe)

  const title = h('input', { class: 'ae-card-title', type: 'text', value: name, title: 'Style name',
    onchange: () => postEdit('styles', row.line, fieldIndexByName(row, 'Name'), title.value) });

  const head = h('div', { class: 'ae-card-head' },
    dot, title,
    h('span', { class: 'ae-card-actions' },
      iconBtn('copy', 'Duplicate style', () => {
        focusStyleIndex = model.styles.rows.indexOf(row) + 1; // new copy lands right after
        post('duplicateRow', { section: 'styles', line: row.line });
      }),
      iconBtn('trash', 'Delete style', () => post('deleteRow', { section: 'styles', line: row.line }), true)),
    h('button', { class: 'ae-icon-btn ae-card-chevron', title: collapsed ? 'Expand' : 'Collapse',
      onclick: () => toggleStyle(row.line, card) }, icon('chevron')),
  );
  card.appendChild(head);

  if (!row.ok) {
    card.appendChild(h('div', { class: 'ae-card-body' },
      h('div', { class: 'ae-warn-line' }, icon('warning'),
        h('span', null, 'Field count doesn’t match Format — not editable. Fix the source line to edit it here.'))));
    return card;
  }

  const body = h('div', { class: 'ae-card-body' });
  body.appendChild(section('Colors', colorsBlock(row)));
  body.appendChild(section('Typography', typographyBlock(row)));
  body.appendChild(positionBlock(row));
  body.appendChild(section('Effects', effectsBlock(row)));
  card.appendChild(body);
  return card;
}

function toggleStyle(line, card) {
  if (collapsedStyles.has(line)) collapsedStyles.delete(line);
  else collapsedStyles.add(line);
  card.setAttribute('data-collapsed', String(collapsedStyles.has(line)));
}

function colorsBlock(row) {
  const grid = h('div', { class: 'ae-colors' });
  STYLE_COLOR_FIELDS.forEach(c => grid.appendChild(colorControl(row, c)));
  return grid;
}

// Redesigned color unit: swatch (click → OS picker) · hex · alpha slider ·
// editable raw &HAABBGGRR. All commits fire on `change` (one edit per gesture).
function colorControl(row, name) {
  const idx = fieldIndexByName(row, name);
  const raw = row.fields[name] || '';
  const dec = decodeOnWeb(raw);
  const hex = dec ? dec.hex : '#000000';
  const aPct = dec ? dec.aPct : 100;

  const fill = h('span', { class: 'ae-color-fill' });
  fill.style.background = dec ? dec.hex : 'transparent';

  const picker = h('input', { type: 'color', value: hex });
  const swatch = h('label', { class: 'ae-swatch', title: 'Pick color' }, fill, picker);
  const hexLabel = h('span', { class: 'ae-color-hex' }, dec ? hex.toUpperCase() : '—');
  const alphaVal = h('span', { class: 'ae-color-alpha-val' }, aPct + '%');
  const alpha = h('input', { type: 'range', min: '0', max: '100', value: String(aPct), 'aria-label': 'Opacity' });
  const rawInput = h('input', { class: 'ae-color-raw', type: 'text', value: raw, title: 'Raw &HAABBGGRR (editable)', spellcheck: 'false' });

  function commit(code) { postEdit('styles', row.line, idx, code); }
  picker.addEventListener('change', () => {
    const c = encFromWeb(picker.value, Number(alpha.value) / 100);
    rawInput.value = c; hexLabel.textContent = picker.value.toUpperCase();
    fill.style.background = picker.value;
    commit(c);
  });
  alpha.addEventListener('input', () => { alphaVal.textContent = alpha.value + '%'; }); // live label only
  alpha.addEventListener('change', () => {
    const c = encFromWeb(picker.value, Number(alpha.value) / 100);
    rawInput.value = c; commit(c);
  });
  rawInput.addEventListener('change', () => commit(rawInput.value.trim()));

  return h('div', { class: 'ae-color' },
    h('div', { class: 'ae-color-top' }, swatch,
      h('span', { class: 'ae-color-name' }, COLOR_PRETTY[name] || name), hexLabel),
    h('div', { class: 'ae-color-alpha' }, h('span', { class: 'ae-color-alpha-lbl' }, 'α'), alpha, alphaVal),
    rawInput,
  );
}

function typographyBlock(row) {
  return [
    h('div', { class: 'ae-grid ae-grid-2' },
      textField('Font', row, 'Fontname'),
      numberField('Size', row, 'Fontsize')),
    h('div', { class: 'ae-toggles' },
      STYLE_BOOL_FIELDS.map(([f, kbd, label]) => boolToggle(row, f, kbd, label))),
  ];
}

function boolToggle(row, field, kbd, label) {
  const on = row.fields[field] === '-1';
  return h('button', {
    class: 'ae-toggle', 'aria-pressed': String(on),
    onclick: () => postEdit('styles', row.line, fieldIndexByName(row, field), on ? '0' : '-1'),
  }, h('span', { class: 'ae-kbd' }, kbd), label);
}

function positionBlock(row) {
  const margins = h('div', { class: 'ae-grid ae-grid-3' },
    numberField('Margin L', row, 'MarginL'),
    numberField('Margin R', row, 'MarginR'),
    numberField('Margin V', row, 'MarginV'));
  return section('Position',
    h('div', { class: 'ae-row-wrap' },
      h('div', { class: 'ae-field' }, h('label', null, 'Alignment'), alignGrid(row)),
      h('div', { class: 'ae-grow' }, margins)));
}

function alignGrid(row) {
  const current = Number(row.fields.Alignment || '2');
  const grid = h('div', { class: 'ae-align' });
  [7, 8, 9, 4, 5, 6, 1, 2, 3].forEach(n => { // numpad layout
    grid.appendChild(h('button', {
      class: 'ae-align-btn', 'aria-pressed': String(n === current), title: `Alignment ${n}`,
      onclick: () => postEdit('styles', row.line, fieldIndexByName(row, 'Alignment'), String(n)),
    }, String(n)));
  });
  return grid;
}

function effectsBlock(row) {
  return [
    h('div', { class: 'ae-grid ae-grid-3' },
      selectField('Border style', row, 'BorderStyle', [['1', 'Outline + Shadow'], ['3', 'Opaque box']]),
      numberField('Outline', row, 'Outline'),
      numberField('Shadow', row, 'Shadow')),
    h('div', { class: 'ae-grid ae-grid-3' },
      numberField('Scale X %', row, 'ScaleX'),
      numberField('Scale Y %', row, 'ScaleY'),
      numberField('Spacing', row, 'Spacing')),
    h('div', { class: 'ae-grid ae-grid-2' },
      numberField('Angle°', row, 'Angle'),
      numberField('Encoding', row, 'Encoding')),
  ];
}

/* ---------- field primitives ------------------------------------------ */
function textField(label, row, name) {
  return fieldWith(label, h('input', { class: 'ae-input', type: 'text',
    value: row.fields[name] != null ? row.fields[name] : '',
    onchange: function () { postEdit('styles', row.line, fieldIndexByName(row, name), this.value); } }));
}
function numberField(label, row, name) {
  return fieldWith(label, h('input', { class: 'ae-input', type: 'number', step: 'any',
    value: row.fields[name] != null ? row.fields[name] : '',
    onchange: function () { postEdit('styles', row.line, fieldIndexByName(row, name), String(this.value)); } }));
}
function selectField(label, row, name, options) {
  const sel = h('select', { class: 'ae-select',
    onchange: function () { postEdit('styles', row.line, fieldIndexByName(row, name), this.value); } });
  options.forEach(([v, l]) => sel.appendChild(h('option', { value: v }, l)));
  sel.value = row.fields[name] || options[0][0];
  return fieldWith(label, sel);
}
function fieldWith(label, control) {
  return h('div', { class: 'ae-field' }, h('label', null, label), control);
}

/* ---------- Events tab (virtualized) ---------------------------------- */
function eventsContent() {
  // The events wrapper is a bounded flex column (`.ae-stack--events`); the
  // virtualizer's `.ae-events-scroll` is its only flex child that grows
  // (flex:1; min-height:0; overflow-y:auto — see panel.css). No JS sizing:
  // the layout is pure CSS, so it stays correct on toolbar wrap / resize.
  const wrap = h('div', { class: 'ae-stack ae-stack--events' });
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
  scrollEl.replaceChildren();
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
  else { virtualList.setCount(); updateEventsMeta(); }
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
    if (effectiveCount() === 0) {
      if (virtualList) { virtualList.destroy(); virtualList = null; }
      scrollEl.replaceChildren(emptyState('No matching lines', 'Try a different filter or clear the search.'));
      updateEventsMeta();
      return;
    }
    if (!virtualList) mountEventsList();
    else virtualList.setCount();
    updateEventsMeta();
  }, 120);
}

function eventCard(r) {
  const open = openEvents.has(r.line);
  const detail = detailCache.get(r.line);
  const card = h('div', { class: 'ae-event', 'data-open': String(open), 'data-line': String(r.line) });

  const head = h('div', { class: 'ae-event-head', role: 'button', tabindex: '0',
    onclick: () => { toggleEvent(r.line); if (virtualList) virtualList.rerender(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEvent(r.line); if (virtualList) virtualList.rerender(); } },
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
    onchange: function () { postEdit('events', line, eventFieldIndex('Text'), this.value); } });
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
  inp.addEventListener('change', () => postEdit('events', line, eventFieldIndex(name), inp.value));
  return inp;
}
function eventStyleSelect(detail) {
  const sel = h('select', { class: 'ae-select' });
  model.styles.rows.forEach(s => sel.appendChild(h('option', { value: s.fields.Name }, s.fields.Name || '(unnamed)')));
  sel.value = detail.fields.Style || '';
  sel.addEventListener('change', () => {
    const line = lineOfSelect(sel);
    if (line == null) return; // card not found — never edit row 0 by accident
    postEdit('events', line, eventFieldIndex('Style'), sel.value);
  });
  return sel;
}
function lineOfSelect(sel) {
  const card = sel.closest('.ae-event');
  if (!card || !card.hasAttribute('data-line')) return null;
  return Number(card.getAttribute('data-line'));
}

// All events share model.events.format; eventFieldIndex looks it up by name.
function eventFieldIndex(name) { return model.events.format.indexOf(name); }

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

/* ---------- Script Info tab ------------------------------------------- */
function scriptInfoContent() {
  const wrap = h('div', { class: 'ae-stack' });
  if (!model.scriptInfo.length) {
    wrap.appendChild(emptyState('No Script Info', 'This file has no [Script Info] section.'));
    return wrap;
  }
  const display = model.scriptInfo.filter(e => SI_DISPLAY.has(e.key));
  const meta = model.scriptInfo.filter(e => !SI_DISPLAY.has(e.key));
  if (meta.length) { wrap.appendChild(h('div', { class: 'ae-si-group-title' }, 'Metadata')); meta.forEach(e => wrap.appendChild(siRow(e))); }
  if (display.length) { wrap.appendChild(h('div', { class: 'ae-si-group-title' }, 'Display & Resolution')); display.forEach(e => wrap.appendChild(siRow(e))); }
  return wrap;
}
function siRow(e) {
  const inp = h('input', { class: 'ae-input', type: 'text', value: e.value || '' });
  inp.addEventListener('change', () => post('edit', { section: 'scriptInfo', line: e.line, fieldIndex: -1, value: inp.value }));
  return h('div', { class: 'ae-si-row' }, h('span', { class: 'ae-si-key', title: e.key }, e.key), inp);
}

/* ---------- shared bits ----------------------------------------------- */
function section(title, ...kids) {
  return h('div', { class: 'ae-section' }, h('div', { class: 'ae-section-title' }, title), ...kids);
}
function iconBtn(name, title, handler, danger = false) {
  return h('button', { class: 'ae-icon-btn' + (danger ? ' ae-icon-btn--danger' : ''), title, onclick: handler }, icon(name));
}
function emptyState(title, hint) {
  return h('div', { class: 'ae-empty' },
    h('div', { class: 'ae-empty-title' }, title),
    h('div', { class: 'ae-empty-hint' }, hint));
}
function loadingState() {
  return h('div', { class: 'ae-loading' }, h('span', { class: 'ae-spinner' }), 'Loading…');
}

/* ---------- Web-side ASS color decode/encode (mirrors src/assColor.ts) */
function decodeOnWeb(code) {
  const m = /^&H([0-9A-Fa-f]+)&?$/.exec((code || '').trim()); if (!m) return null;
  // Parity with host parseAssColor: reject malformed/overlong codes before padding.
  if (m[1].length > 8 || m[1].length < 3) return null;
  const h = m[1].toUpperCase().padStart(8, '0');
  const aa = parseInt(h.slice(0, 2), 16), bb = parseInt(h.slice(2, 4), 16),
    gg = parseInt(h.slice(4, 6), 16), rr = parseInt(h.slice(6, 8), 16);
  const hex = '#' + [rr, gg, bb].map(n => n.toString(16).padStart(2, '0')).join('');
  return { hex, aPct: Math.round((255 - aa) / 255 * 100) };
}
function encFromWeb(hex, opacity) {
  const rr = hex.slice(1, 3), gg = hex.slice(3, 5), bb = hex.slice(5, 7);
  const aa = Math.round(255 - opacity * 255).toString(16).padStart(2, '0');
  return '&H' + (aa + bb + gg + rr).toUpperCase();
}

// First paint (the host posts a model shortly after load).
render();
