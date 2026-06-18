const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
let model = null;
let tab = 'styles';
function setTab(t) { tab = t; render(); }

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
  const tabs = document.createElement('div'); tabs.className = 'row';
  for (const [t,label] of [['scriptInfo','Script Info'],['styles','Styles'],['events','Events']]) {
    const b = document.createElement('button'); b.textContent = label;
    if (t === tab) b.style.fontWeight = 'bold';
    b.onclick = () => setTab(t);
    tabs.appendChild(b);
  }
  root.appendChild(tabs);
  if (tab === 'styles') {
    model.styles.rows.forEach((r) => root.appendChild(styleCard(r)));
    const add = document.createElement('button'); add.textContent = '+ add style';
    add.onclick = () => vscode.postMessage({ type: 'addRow', section: 'styles' });
    root.appendChild(add);
  }
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

function styleCard(row) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h3');
  title.textContent = row.fields.Name || '(unnamed)';
  if (!row.ok) { title.textContent += ' ⚠ unparsed'; title.className = 'warn'; }
  card.appendChild(title);
  const dup = document.createElement('button'); dup.textContent = 'dup';
  dup.onclick = () => vscode.postMessage({ type: 'duplicateRow', section: 'styles', line: row.line });
  const del = document.createElement('button'); del.textContent = 'del';
  del.onclick = () => vscode.postMessage({ type: 'deleteRow', section: 'styles', line: row.line });
  card.appendChild(dup); card.appendChild(del);
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
  // Important #4: use onchange (commit ONE edit on release) instead of oninput
  // (one WorkspaceEdit per pointer-move) to avoid flooding the undo stack.
  picker.onchange = () => { const c = encFromWeb(picker.value, Number(alpha.value)/100); code.value = c; hex.value = picker.value.toUpperCase(); commit(c); };
  alpha.onchange = () => { const c = encFromWeb(picker.value, Number(alpha.value)/100); code.value = c; commit(c); };
  // The hex box mirrors the picker's RRGGBB; keep it display-only so it never
  // looks editable-but-inert. (The full &HAABBGGRR code is editable below.)
  hex.readOnly = true;
  code.onchange = () => { commit(code.value.trim()); };
  wrap.append(swatch, picker, hex, alpha, code);
  return wrap;
}

// Web-side ASS color decode/encode mirrors src/assColor.ts.
function decodeOnWeb(code) {
  const m = /^&H([0-9A-Fa-f]+)&?$/.exec((code || '').trim()); if (!m) return null;
  // Important #3: parity with host parseAssColor — reject malformed/overlong
  // codes before padding so the swatch doesn't render garbage.
  if (m[1].length > 8 || m[1].length < 3) return null;
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
