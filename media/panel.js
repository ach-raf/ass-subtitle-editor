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
