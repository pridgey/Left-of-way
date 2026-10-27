// Road Drafter: draft street redesigns on aerial imagery and export them to Figma as SVG.
import { M2FT, ppmAt, n, offsetLL, llToMeters, localToLL, bearingVec, vecBearing, dist, pathD } from './geo.js';
import { TYPES, GROUPS, ICONS, migrateElement, newParams } from './types/index.js';
import { makeLegs } from './types/points.js';
import { LANE_TYPES, PRESETS, roadWidth, crossSectionSvg } from './types/paths.js';
import { SOURCES, createImagery } from './imagery.js';
import { setupSearch } from './search.js';

const STORE_KEY = 'road-drafter-v2';
const OLD_STORE_KEY = 'road-drafter-v1';
const SNAP_PX = 22;
const SQFT = 10.7639;
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const esc = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const icon = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ACT_ICONS = {
  dup: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  front: icon('<rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M4 16V4h12"/>'),
  back: icon('<rect x="4" y="4" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M20 8v12H8"/>'),
  del: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
};

// ---------- project state ----------
// Placeholder unit prices, stored per m² (trees per tree). Users edit them in the panel.
const DEFAULT_COSTS = { asphalt: 8 * SQFT, concrete: 20 * SQFT, green: 12 * SQFT, paint: 6 * SQFT, deck: 60 * SQFT, trees: 800 };

function blankProject() {
  return {
    version: 2, units: 'ft', view: null,
    imagery: { source: 'naip', esriKey: '', customUrl: '', customMax: 19 },
    backdrop: null, exportAerial: true, costs: { ...DEFAULT_COSTS },
    current: 0, variants: [{ id: uid(), name: 'Option A', elements: [] }],
  };
}

function normalizeProject(p) {
  const base = blankProject();
  const out = { ...base, ...p, imagery: { ...base.imagery, ...p.imagery }, costs: { ...base.costs, ...p.costs } };
  if (!Array.isArray(out.variants) || !out.variants.length) out.variants = base.variants;
  out.variants.forEach((v) => { v.elements = (v.elements || []).map(migrateElement).filter(Boolean); });
  out.current = clamp(out.current || 0, 0, out.variants.length - 1);
  return out;
}

function loadProject() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeProject(JSON.parse(raw));
    const old = JSON.parse(localStorage.getItem(OLD_STORE_KEY) || 'null');
    if (old) {
      const p = blankProject();
      p.units = old.units || 'ft';
      p.view = old.view || null;
      p.variants[0].elements = old.elements || [];
      return normalizeProject(p);
    }
  } catch { /* corrupt or unavailable storage */ }
  return blankProject();
}

let project = loadProject();
const els = () => project.variants[project.current].elements;
const getEl = (id) => els().find((e) => e.id === id);

const ui = {
  tool: 'select', selectedId: null, draft: null, cursor: null, drag: null,
  hidden: false, opacity: 1, compare: false, swipe: 0.5,
  adjustBackdrop: false, calibrate: null, lastLanes: null, cursorPx: null, hoverId: null,
};
const undoStack = [], redoStack = [];
const linkDirs = new Map(); // element id -> {start, end} forced road directions at connected ends

let saveTimer = null, storageWarned = false;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function saveNow() {
  const c = map.getCenter();
  project.view = [c.lat, c.lng, map.getZoom()];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(project));
    storageWarned = false;
  } catch {
    if (!storageWarned) toast('Browser storage is full (large screenshot?). Use Save to keep a project file.');
    storageWarned = true;
  }
}
function checkpoint() {
  undoStack.push(JSON.stringify(els()));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  $('undoBtn').disabled = false;
  $('redoBtn').disabled = true;
}
function restore(from, to) {
  $('toast').hidden = true;
  if (!from.length) return;
  to.push(JSON.stringify(els()));
  project.variants[project.current].elements = JSON.parse(from.pop());
  if (!getEl(ui.selectedId)) ui.selectedId = null;
  refresh();
}
const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);
function updateUndoButtons() {
  // the top undo entry may be a no-op snapshot (e.g. a click that didn't drag), so compare
  const cur = JSON.stringify(els());
  while (undoStack.length && undoStack[undoStack.length - 1] === cur) undoStack.pop();
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

// ---------- units ----------
const fmt = (m) => (project.units === 'ft' ? `${Math.round(m * M2FT)} ft` : `${+m.toFixed(1)} m`);
const toDisp = (m) => (project.units === 'ft' ? +(m * M2FT).toFixed(1) : +m.toFixed(2));
const fromDisp = (v) => (project.units === 'ft' ? v / M2FT : v);
const unitLabel = () => (project.units === 'ft' ? 'ft' : 'm');

// ---------- map ----------
const map = L.map('map', { minZoom: 4, maxZoom: 22, zoomControl: true });
if (project.view) map.setView([project.view[0], project.view[1]], project.view[2]);
else map.setView([39.5, -98.35], 4);
let statusTimer = null;
const imagery = createImagery(map, (state) => {
  const el = $('imgStatus');
  clearTimeout(statusTimer);
  el.classList.toggle('error', state === 'error');
  if (state === 'ready') { el.hidden = true; return; }
  if (state === 'error') {
    el.textContent = 'Aerial photo didn\'t load here. Try another source under Imagery.';
    el.hidden = false;
    return;
  }
  // only mention loading if it's slow
  statusTimer = setTimeout(() => { el.textContent = 'Loading aerial photo…'; el.hidden = false; }, 600);
});
let imageryNote = imagery.apply(project.imagery);
L.control.scale({ position: 'bottomleft' }).addTo(map);

const ppm = (lat) => ppmAt(lat, map.getZoom());
const toPx = (lat, lng) => { const p = map.latLngToContainerPoint([lat, lng]); return [p.x, p.y]; };
const fromPx = (x, y) => { const ll = map.containerPointToLatLng([x, y]); return [ll.lat, ll.lng]; };
const elLat = (el) => (el.pts ? el.pts[0][0] : el.lat);

// ---------- ports and connections ----------
function portsOf(el) {
  const t = TYPES[el.type];
  if (!t.ports) return [];
  if (t.kind === 'point') {
    return t.ports(el.p).map((pp) => ({
      id: el.id, key: pp.key, ll: localToLL(el, pp.x, pp.y), bearing: (el.rot + pp.angle) % 360, width: pp.width,
    }));
  }
  return t.ports(el).map((pp) => ({ id: el.id, ...pp }));
}

function nearestPort(px, excludeId) {
  let best = null, bestD = SNAP_PX;
  for (const el of els()) {
    if (el.id === excludeId) continue;
    for (const port of portsOf(el)) {
      const d = dist(px, toPx(port.ll[0], port.ll[1]));
      if (d < bestD) { best = port; bestD = d; }
    }
  }
  return best;
}

// Keep connected road ends glued to their ports; roundabout legs take the road's width.
function resolveLinks() {
  linkDirs.clear();
  for (let pass = 0; pass < 2; pass++) {
    for (const el of els()) {
      if (el.type !== 'segment' || !el.p.links) continue;
      const dirs = {};
      for (const end of ['start', 'end']) {
        const link = el.p.links[end];
        if (!link) continue;
        const target = getEl(link.id);
        const port = target && portsOf(target).find((p) => p.key === link.key);
        if (!port) { delete el.p.links[end]; continue; }
        const idx = end === 'start' ? 0 : el.pts.length - 1;
        el.pts[idx] = [port.ll[0], port.ll[1]];
        const v = bearingVec(port.bearing);
        dirs[end] = end === 'start' ? v : [-v[0], -v[1]];
        if (TYPES[target.type].legs && link.key.startsWith('leg')) {
          const w = roadWidth(el.p.lanes, end === 'start' ? 0 : 1);
          const leg = target.p.legs[+link.key.slice(3)];
          if (leg && w > 0.5) leg.approach = w;
        }
      }
      linkDirs.set(el.id, dirs);
    }
  }
}
const legLinked = (el, i) => els().some((s) => s.type === 'segment' && s.p.links
  && ['start', 'end'].some((e) => s.p.links[e]?.id === el.id && s.p.links[e]?.key === `leg${i}`));

// ---------- rendering ----------
const overlay = $('overlay');
const bdLayer = $('bd'), elsLayer = $('els'), draftLayer = $('draft'), selLayer = $('sel');
const stripHits = (s) => s.replace(/<(rect|path|line)[^>]*data-hit="1"[^>]*\/>/g, '');
const nameOf = (el) => { const t = TYPES[el.type]; return t.name(t.kind === 'point' ? el.p : el, fmt); };

function ctxFor(el, dirs) {
  return { s: ppm(elLat(el)), toPx, f: fmt, dirs: dirs || linkDirs.get(el.id) || {} };
}

function markup(el, { interactive = true, layerName = '', dirs = null } = {}) {
  const t = TYPES[el.type];
  const ctx = ctxFor(el, dirs);
  let body, transform = '';
  if (t.kind === 'point') {
    const [x, y] = toPx(el.lat, el.lng);
    body = t.svg(el.p, ctx.s, ctx);
    transform = ` transform="translate(${n(x)} ${n(y)}) rotate(${n(el.rot)})"`;
  } else {
    body = t.draw(el, ctx);
  }
  if (!interactive) body = stripHits(body);
  const attr = interactive ? `data-id="${el.id}"` : `id="${esc(layerName)}"`;
  return `<g ${attr}${transform}>${body}</g>`;
}

function backdropMarkup(interactive) {
  const b = project.backdrop;
  if (!b || !b.visible) return '';
  const [cx, cy] = toPx(b.lat, b.lng);
  const s = ppm(b.lat);
  const w = b.w * b.mpp * s, h = b.h * b.mpp * s;
  const attr = interactive ? 'data-bd="1"' : 'id="Map screenshot"';
  return `<image ${attr} x="${n(cx - w / 2)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${n(h)}" opacity="${b.opacity}"
    preserveAspectRatio="none" href="${b.url}" xlink:href="${b.url}"/>`;
}

function selectionMarkup() {
  const el = getEl(ui.selectedId);
  if (!el) return '';
  const t = TYPES[el.type];
  const s = ppm(elLat(el));
  if (t.kind === 'point') {
    const [x, y] = toPx(el.lat, el.lng);
    const [x0, y0, x1, y1] = t.bbox(el.p, s).map((v) => v * s);
    const pad = 4, hy = y0 - pad - 26;
    let out = `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(el.rot)})">
      <rect x="${n(x0 - pad)}" y="${n(y0 - pad)}" width="${n(x1 - x0 + 2 * pad)}" height="${n(y1 - y0 + 2 * pad)}"
        fill="none" stroke="#2f9bff" stroke-width="1.5" stroke-dasharray="6 4"/>
      ${t.noRotate ? '' : `<line x1="0" y1="${n(y0 - pad)}" x2="0" y2="${n(hy)}" stroke="#2f9bff" stroke-width="1.5"/>
      <circle class="handle rot" cx="0" cy="${n(hy)}" r="7" fill="#2f9bff" stroke="#fff" stroke-width="2"><title>Drag to rotate (Shift snaps to 15°)</title></circle>`}</g>`;
    if (t.legs) {
      portsOf(el).forEach((p, i) => {
        const [px, py] = toPx(p.ll[0], p.ll[1]);
        out += `<rect class="handle leg" data-leg="${i}" x="${n(px - 6)}" y="${n(py - 6)}" width="12" height="12"
          fill="#ff9f1c" stroke="#fff" stroke-width="2"><title>Drag to aim leg ${i + 1}</title></rect>`;
      });
    }
    return out;
  }
  const px = el.pts.map((p) => toPx(p[0], p[1]));
  let out = `<path d="${pathD(px, t.closed)}" fill="none" stroke="#2f9bff" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  if (!t.maxPts) {
    const segs = px.length - (t.closed ? 0 : 1);
    for (let i = 0; i < segs; i++) {
      const a = px[i], b = px[(i + 1) % px.length];
      out += `<circle class="handle mid" data-mid="${i}" cx="${n((a[0] + b[0]) / 2)}" cy="${n((a[1] + b[1]) / 2)}" r="5"
        fill="#2f9bff" fill-opacity="0.55" stroke="#fff" stroke-width="1.5"><title>Drag to add a point</title></circle>`;
    }
  }
  px.forEach((p, i) => {
    const linked = el.type === 'segment' && ((i === 0 && el.p.links?.start) || (i === px.length - 1 && el.p.links?.end));
    out += `<circle class="handle vtx" data-vtx="${i}" cx="${n(p[0])}" cy="${n(p[1])}" r="7"
      fill="${linked ? '#ff9f1c' : '#2f9bff'}" stroke="#fff" stroke-width="2"><title>Drag to move. Alt+click to delete.</title></circle>`;
  });
  if (el.type === 'segment' && px.length >= 2) {
    // arrow showing which way is "forward" for the lane list
    const i = Math.floor((px.length - 1) / 2);
    const a = px[i], b = px[i + 1];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    out += `<g transform="translate(${n(mx)} ${n(my)}) rotate(${n(ang)})"><path d="M -8 -8 L 6 0 L -8 8" fill="none" stroke="#2f9bff" stroke-width="3"/></g>`;
  }
  return out;
}

// Outline the element under the pointer in the item list.
function hoverMarkup() {
  const el = ui.hoverId !== ui.selectedId && getEl(ui.hoverId);
  if (!el) return '';
  const t = TYPES[el.type];
  const style = 'fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="5 4"';
  if (t.kind === 'point') {
    const s = ppm(el.lat), [x, y] = toPx(el.lat, el.lng);
    const [x0, y0, x1, y1] = t.bbox(el.p, s).map((v) => v * s);
    return `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(el.rot)})"><rect x="${n(x0 - 6)}" y="${n(y0 - 6)}"
      width="${n(x1 - x0 + 12)}" height="${n(y1 - y0 + 12)}" rx="4" ${style}/></g>`;
  }
  return `<path d="${pathD(el.pts.map((q) => toPx(q[0], q[1])), t.closed)}" stroke-opacity="0.9" ${style}/>`;
}

function portsMarkup() {
  const showing = ui.tool === 'segment' || (ui.drag?.mode === 'vertex' && ui.drag.el.type === 'segment');
  if (!showing) return '';
  const skip = ui.drag?.el?.id;
  let out = '';
  // ring the dot the next click (or drop) would connect to
  const near = ui.drag?.mode === 'vertex' ? ui.drag.port : ui.cursorPx && nearestPort(ui.cursorPx, null);
  if (near) {
    const [x, y] = toPx(near.ll[0], near.ll[1]);
    out += `<circle class="port" cx="${n(x)}" cy="${n(y)}" r="13" fill="none" stroke="#fff" stroke-width="2.5"/>`;
  }
  for (const el of els()) {
    if (el.id === skip) continue;
    for (const p of portsOf(el)) {
      const [x, y] = toPx(p.ll[0], p.ll[1]);
      out += `<circle class="port" cx="${n(x)}" cy="${n(y)}" r="7" fill="#ff9f1c" fill-opacity="0.35" stroke="#ff9f1c" stroke-width="2"/>`;
    }
  }
  return out;
}

// Translucent preview of a click-to-place element under the cursor.
const ghostParams = {};
function ghostMarkup() {
  const t = TYPES[ui.tool];
  if (!t || t.kind !== 'point' || !ui.cursor || ui.calibrate) return '';
  ghostParams[ui.tool] = ghostParams[ui.tool] || newParams(ui.tool);
  const temp = { id: 'ghost', type: ui.tool, lat: ui.cursor[0], lng: ui.cursor[1], rot: 0, p: ghostParams[ui.tool] };
  return `<g opacity="0.55">${markup(temp, { interactive: false })}</g>`;
}

function draftMarkup() {
  const d = ui.draft;
  if (!d) return ghostMarkup();
  const t = TYPES[d.type];
  const pts = ui.cursor ? [...d.pts, ui.cursor] : d.pts;
  let out = '';
  if (pts.length >= Math.min(2, t.minPts)) {
    const temp = { id: 'draft', type: d.type, pts, p: { ...d.p, links: {} } };
    let dirs = {};
    if (d.links.start) {
      const target = getEl(d.links.start.id);
      const port = target && portsOf(target).find((p) => p.key === d.links.start.key);
      if (port) dirs = { start: bearingVec(port.bearing) };
    }
    if (pts.length >= t.minPts || d.type === 'segment') out += `<g opacity="0.75">${markup(temp, { interactive: false, dirs })}</g>`;
    else out += `<path d="${pathD(pts.map((p) => toPx(p[0], p[1])))}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="5 4"/>`;
  }
  d.pts.forEach((p) => {
    const [x, y] = toPx(p[0], p[1]);
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="4" fill="#fff" stroke="#2f9bff" stroke-width="2"/>`;
  });
  return out;
}

function compareMarkup(W, H) {
  if (!ui.compare) return '';
  const x = ui.swipe * W;
  return `<line x1="${n(x)}" y1="0" x2="${n(x)}" y2="${H}" stroke="#fff" stroke-width="2"/>
    <g data-swipe="1" class="handle" transform="translate(${n(x)} ${n(H / 2)})">
      <circle r="16" fill="#2f9bff" stroke="#fff" stroke-width="2"/>
      <path d="M -6 -5 L -11 0 L -6 5 M 6 -5 L 11 0 L 6 5" fill="none" stroke="#fff" stroke-width="2"/></g>
    <g font-size="13" font-weight="600" font-family="system-ui, sans-serif">
      <rect x="${n(x - 92)}" y="${n(H / 2 + 28)}" width="80" height="24" rx="12" fill="#2f9bff"/>
      <text x="${n(x - 52)}" y="${n(H / 2 + 45)}" text-anchor="middle" fill="#fff">Proposal</text>
      <rect x="${n(x + 12)}" y="${n(H / 2 + 28)}" width="80" height="24" rx="12" fill="rgba(20,22,25,.85)"/>
      <text x="${n(x + 52)}" y="${n(H / 2 + 45)}" text-anchor="middle" fill="#fff">Existing</text></g>`;
}

function render() {
  resolveLinks();
  const W = overlay.clientWidth, H = overlay.clientHeight;
  bdLayer.innerHTML = backdropMarkup(true);
  elsLayer.innerHTML = els().map((el) => markup(el)).join('');
  elsLayer.style.opacity = ui.hidden ? 0 : ui.opacity;
  if (ui.compare) {
    $('swipeRect').setAttribute('width', ui.swipe * W);
    elsLayer.setAttribute('clip-path', 'url(#swipeClip)');
  } else elsLayer.removeAttribute('clip-path');
  draftLayer.innerHTML = draftMarkup();
  selLayer.innerHTML = hoverMarkup() + selectionMarkup() + portsMarkup() + compareMarkup(W, H);
}

let qtyTimer = null;
function refresh() {
  render();
  renderProps();
  updateWelcome();
  updateUndoButtons();
  clearTimeout(qtyTimer);
  qtyTimer = setTimeout(renderQuantities, 150);
  save();
}

map.on('move', render);
map.on('zoomstart', () => overlay.classList.add('hidden'));
map.on('zoomend', () => { overlay.classList.remove('hidden'); render(); save(); updateWelcome(); updateHint(); });
function updateWelcome() {
  $('welcome').hidden = map.getZoom() >= 14 || project.variants.some((v) => v.elements.length) || !!project.backdrop;
}
map.on('moveend', save);
window.addEventListener('resize', render);

// ---------- toasts / hints ----------
const hint = $('hint');
let toastTimer = null;
function toast(msg, { undoable = false } = {}) {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  $('toastUndo').hidden = !undoable;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undoable ? 7000 : 4500);
}
$('toastUndo').onclick = () => undo();

// A small in-page replacement for prompt(). Resolves to the text, or null if cancelled.
function ask(label, value = '', type = 'text') {
  const dlg = $('ask'), input = $('askInput');
  $('askLabel').textContent = label;
  input.type = type;
  input.step = 'any';
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value : null), { once: true });
  });
}
function updateHint() {
  if (ui.calibrate) {
    hint.textContent = ui.calibrate.pts.length ? 'Click the second point' : 'Click the first of two points a known distance apart on the screenshot';
  } else if (ui.adjustBackdrop) {
    hint.textContent = 'Drag the screenshot to line it up with the aerial photo. Press Esc when done.';
  } else if (ui.tool === 'select') {
    hint.textContent = '';
  } else {
    const t = TYPES[ui.tool];
    hint.textContent = t.hint && t.kind === 'path' ? t.hint : `Click the map to place a ${t.label.toLowerCase()}.`;
    hint.textContent += ' Esc cancels.';
    if (map.getZoom() < 17) hint.textContent += ' Zoom in closer for accurate placement.';
  }
}

// ---------- tools ----------
function buildToolbar() {
  let html = `<button data-tool="select" title="Select / move (V)">${ICONS.select}<span>Select</span><kbd class="key">V</kbd></button>`;
  for (const g of GROUPS) {
    const items = Object.entries(TYPES).filter(([, t]) => t.group === g);
    html += `<div class="tool-group">${g}</div>`;
    html += items.map(([k, t]) => `<button data-tool="${k}" title="${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}">${ICONS[k] || ''}<span>${t.label}</span>${t.key ? `<kbd class="key">${t.key.toUpperCase()}</kbd>` : ''}</button>`).join('');
  }
  $('tools').innerHTML = html;
  // blur so a later Enter (finish drawing) doesn't re-press the button
  $('tools').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setTool(b.dataset.tool); b.blur(); }));
}

function setTool(name) {
  if (ui.draft && ui.draft.type !== name) ui.draft = null;
  ui.calibrate = null;
  ui.tool = name;
  $('tools').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  overlay.classList.toggle('placing', name !== 'select');
  map.getContainer().style.cursor = name === 'select' ? '' : 'crosshair';
  const drawing = name !== 'select' && TYPES[name].kind === 'path';
  if (drawing) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  if (name !== 'select') ui.selectedId = null;
  if (name === 'select') { ui.cursor = null; ui.cursorPx = null; }
  updateHint();
  render();
  renderProps();
}

function addPointElement(type, ll) {
  checkpoint();
  const el = { id: uid(), type, lat: ll[0], lng: ll[1], rot: 0, p: newParams(type) };
  els().push(el);
  ui.selectedId = el.id;
  setTool('select');
  refresh();
}

function draftParams(type) {
  const p = newParams(type);
  if (type === 'segment' && ui.lastLanes) p.lanes = structuredClone(ui.lastLanes);
  return p;
}

function addDraftPoint(ll, px) {
  const t = TYPES[ui.tool];
  if (!ui.draft) ui.draft = { type: ui.tool, pts: [], links: {}, p: draftParams(ui.tool) };
  const d = ui.draft;
  let pt = ll, snapped = null;
  if (d.type === 'segment') {
    const port = nearestPort(px, null);
    if (port) { pt = port.ll; snapped = port; }
  }
  const last = d.pts[d.pts.length - 1];
  if (last && dist(toPx(last[0], last[1]), toPx(pt[0], pt[1])) < 4) return; // double-click repeat
  d.pts.push([pt[0], pt[1]]);
  if (snapped) d.links[d.pts.length === 1 ? 'start' : 'end'] = { id: snapped.id, key: snapped.key };
  if ((snapped && d.pts.length > 1) || (t.maxPts && d.pts.length >= t.maxPts)) finishDraft();
  else render();
}

function finishDraft() {
  const d = ui.draft;
  ui.draft = null;
  if (!d) return;
  const t = TYPES[d.type];
  if (d.pts.length < t.minPts) { render(); return; }
  checkpoint();
  const el = { id: uid(), type: d.type, pts: d.pts, p: d.p };
  if (d.type === 'segment') {
    el.p.links = d.links;
    ui.lastLanes = structuredClone(el.p.lanes);
  }
  els().push(el);
  ui.selectedId = el.id;
  setTool('select');
  refresh();
}

map.on('click', (e) => {
  const ll = [e.latlng.lat, e.latlng.lng];
  const px = [e.containerPoint.x, e.containerPoint.y];
  if (ui.calibrate) { calibrateClick(ll); return; }
  if (ui.tool === 'select') {
    if (ui.selectedId) { ui.selectedId = null; render(); renderProps(); }
    return;
  }
  if (TYPES[ui.tool].kind === 'point') addPointElement(ui.tool, ll);
  else addDraftPoint(ll, px);
});
map.on('dblclick', () => { if (ui.draft) finishDraft(); });
map.on('mousemove', (e) => {
  if (ui.tool === 'select' && !ui.draft) return;
  ui.cursorPx = [e.containerPoint.x, e.containerPoint.y];
  ui.cursor = [e.latlng.lat, e.latlng.lng];
  // preview the road snapping to the dot it would connect to
  if (ui.tool === 'segment') {
    const port = nearestPort(ui.cursorPx, null);
    if (port) ui.cursor = [port.ll[0], port.ll[1]];
  }
  render();
});
map.on('mouseout', () => { ui.cursor = null; ui.cursorPx = null; render(); });

// ---------- dragging ----------
const localPoint = (e) => { const r = overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const tgt = e.target;
  const start = localPoint(e);
  if (tgt.closest('[data-swipe]')) { e.preventDefault(); ui.drag = { mode: 'swipe' }; return; }
  if (tgt.closest('[data-bd]') && ui.adjustBackdrop) {
    e.preventDefault();
    ui.drag = { mode: 'backdrop', start, origin: toPx(project.backdrop.lat, project.backdrop.lng) };
    return;
  }
  const el = getEl(ui.selectedId);
  const vtx = tgt.closest('[data-vtx]'), mid = tgt.closest('[data-mid]'), leg = tgt.closest('[data-leg]'), rot = tgt.closest('.rot');
  if (el && (vtx || mid || leg || rot)) {
    e.preventDefault();
    checkpoint();
    if (rot) ui.drag = { mode: 'rotate', el, origin: toPx(el.lat, el.lng) };
    else if (leg) ui.drag = { mode: 'leg', el, i: +leg.dataset.leg, origin: toPx(el.lat, el.lng) };
    else if (vtx) {
      const i = +vtx.dataset.vtx;
      if (e.altKey) { deleteVertex(el, i); return; }
      ui.drag = { mode: 'vertex', el, i };
    } else {
      const i = +mid.dataset.mid;
      const a = el.pts[i], b = el.pts[(i + 1) % el.pts.length];
      el.pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      ui.drag = { mode: 'vertex', el, i: i + 1, inserted: true };
    }
    ui.drag.moved = false;
    render();
    return;
  }
  const g = tgt.closest('[data-id]');
  if (!g) return;
  e.preventDefault();
  ui.selectedId = g.dataset.id;
  const sel = getEl(ui.selectedId);
  checkpoint();
  ui.drag = {
    mode: 'move', el: sel, start, moved: false,
    origin: sel.pts ? sel.pts.map((p) => toPx(p[0], p[1])) : toPx(sel.lat, sel.lng),
  };
  renderProps();
  render();
});

// Let the scroll wheel zoom the map even when the pointer is over a drawing.
overlay.addEventListener('wheel', (e) => {
  e.preventDefault();
  map.getContainer().dispatchEvent(new WheelEvent('wheel', e));
}, { passive: false });

window.addEventListener('pointermove', (e) => {
  const d = ui.drag;
  if (!d) return;
  const p = localPoint(e);
  d.moved = true;
  if (d.mode === 'swipe') {
    ui.swipe = clamp(p[0] / overlay.clientWidth, 0.02, 0.98);
  } else if (d.mode === 'backdrop') {
    const ll = fromPx(d.origin[0] + p[0] - d.start[0], d.origin[1] + p[1] - d.start[1]);
    project.backdrop.lat = ll[0];
    project.backdrop.lng = ll[1];
  } else if (d.mode === 'move') {
    const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (d.el.pts) {
      d.el.pts = d.origin.map((q) => fromPx(q[0] + dx, q[1] + dy));
      if (d.el.p.links) d.el.p.links = {};
    } else {
      const ll = fromPx(d.origin[0] + dx, d.origin[1] + dy);
      d.el.lat = ll[0];
      d.el.lng = ll[1];
    }
  } else if (d.mode === 'rotate') {
    let deg = vecBearing(p[0] - d.origin[0], p[1] - d.origin[1]);
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    d.el.rot = deg % 360;
    syncRotation(d.el);
  } else if (d.mode === 'leg') {
    let deg = (vecBearing(p[0] - d.origin[0], p[1] - d.origin[1]) - d.el.rot + 360) % 360;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    d.el.p.legs[d.i].angle = deg;
    const input = $('props').querySelector(`[data-leg-i="${d.i}"][data-lf="angle"]`);
    if (input) input.value = Math.round(deg);
  } else if (d.mode === 'vertex') {
    let ll = fromPx(p[0], p[1]);
    if (d.el.type === 'segment' && (d.i === 0 || d.i === d.el.pts.length - 1)) {
      const end = d.i === 0 ? 'start' : 'end';
      const port = nearestPort(p, d.el.id);
      d.el.p.links = d.el.p.links || {};
      d.port = port;
      if (port) { ll = port.ll; d.el.p.links[end] = { id: port.id, key: port.key }; } else delete d.el.p.links[end];
    }
    d.el.pts[d.i] = [ll[0], ll[1]];
  }
  render();
});

window.addEventListener('pointerup', () => {
  const d = ui.drag;
  if (!d) return;
  ui.drag = null;
  const undoable = ['move', 'rotate', 'leg', 'vertex'].includes(d.mode);
  if (undoable && !d.moved && !d.inserted) undoStack.pop();
  if (d.mode === 'backdrop' || d.mode === 'swipe') { render(); save(); renderImagery(); return; }
  refresh();
});

function deleteVertex(el, i) {
  if (el.pts.length <= TYPES[el.type].minPts) { undoStack.pop(); toast('This shape needs at least that many points.'); return; }
  el.pts.splice(i, 1);
  if (el.p.links) {
    if (i === 0) delete el.p.links.start;
    if (i === el.pts.length) delete el.p.links.end;
  }
  refresh();
}

// ---------- properties panel ----------
const props = $('props');

function paramHtml(d, v) {
  if (d.type === 'bool') return `<label class="check"><input type="checkbox" data-k="${d.k}" ${v ? 'checked' : ''}> ${d.label}</label>`;
  if (d.type === 'select') {
    return `<label>${d.label}<select data-k="${d.k}">${d.options.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  }
  if (d.type === 'text') return `<label>${d.label}<input type="text" data-k="${d.k}" value="${esc(v)}"></label>`;
  if (d.type === 'int' || d.type === 'num') {
    return `<label>${d.label}<input type="number" data-k="${d.k}" min="${d.min}" max="${d.max}" step="1" value="${v}"></label>`;
  }
  const step = project.units === 'ft' ? 1 : 0.1;
  return `<label>${d.label} (${unitLabel()})<span class="field">
    <input type="range" data-k="${d.k}" min="${toDisp(d.min)}" max="${toDisp(d.max)}" step="${step}" value="${toDisp(v)}">
    <input type="number" data-k="${d.k}" min="${toDisp(d.min)}" max="${toDisp(d.max)}" step="${step}" value="${toDisp(v)}"></span></label>`;
}

function legsHtml(el) {
  const rows = el.p.legs.map((leg, i) => {
    const linked = legLinked(el, i);
    return `<div class="legrow">
      <strong>Leg ${i + 1}</strong>
      <label>Angle°<input type="number" data-leg-i="${i}" data-lf="angle" step="1" value="${Math.round(leg.angle)}"></label>
      <label>Width (${unitLabel()})<input type="number" data-leg-i="${i}" data-lf="approach" step="${project.units === 'ft' ? 1 : 0.1}"
        value="${toDisp(leg.approach)}" ${linked ? 'disabled title="Set by the connected road"' : ''}></label>
      <label class="check"><input type="checkbox" data-leg-i="${i}" data-lf="crosswalk" ${leg.crosswalk ? 'checked' : ''}> Crosswalk</label>
    </div>`;
  }).join('');
  return `<h3>Legs</h3>
    <label>Number of legs<input type="number" data-legcount min="3" max="6" step="1" value="${el.p.legs.length}"></label>
    <div class="row"><button data-allxw="1">All crosswalks on</button><button data-allxw="0">All off</button></div>
    ${rows}`;
}

function lanesHtml(el) {
  const unit = unitLabel(), step = project.units === 'ft' ? 1 : 0.1;
  const rows = el.p.lanes.map((lane, i) => {
    const T = LANE_TYPES[lane.type];
    return `<div class="lanerow" data-lane="${i}">
      <div class="lanetop">
        <span class="swatch" style="background:${T.fill}"></span>
        <select data-lf="type" aria-label="Lane type">${Object.entries(LANE_TYPES).map(([k, t]) => `<option value="${k}" ${k === lane.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        ${T.dir ? `<button class="dir" data-lact="dir" title="Direction of travel, relative to the blue arrow on the road. Click to flip.">${lane.dir === 'back' ? '↓ Toward' : '↑ Away'}</button>` : ''}
        <span class="gap"></span>
        <button data-lact="up" title="Move left" ${i === 0 ? 'disabled' : ''}>▲</button><button data-lact="down" title="Move right" ${i === el.p.lanes.length - 1 ? 'disabled' : ''}>▼</button><button data-lact="del" title="Remove lane">×</button>
      </div>
      <div class="lanew"><span>Width</span><input type="number" data-lf="w" step="${step}" min="0" value="${toDisp(lane.w)}" aria-label="Width"> ${unit}
        <span class="sep">·</span><span title="Leave blank to keep the same width. Set it to taper the lane along the road.">Tapers to</span>
        <input type="number" data-lf="w2" step="${step}" min="0" placeholder="–" value="${lane.w2 === null ? '' : toDisp(lane.w2)}" aria-label="Width at the end of the road"> ${unit}</div>
    </div>`;
  }).join('');
  return `<h3>Lanes <span class="muted small">left to right, facing the arrow</span></h3>
    <select data-preset><option value="">Apply a preset…</option>${Object.keys(PRESETS).map((k) => `<option>${esc(k)}</option>`).join('')}</select>
    ${rows}
    <div class="row"><button data-addlane>+ Add lane</button><button data-flip>Flip direction</button></div>
    <p class="muted small">"Tapers to" sets a lane's width at the far end, e.g. a turn lane from 10 to 0 ft while a median grows from 0 to 10 ft.</p>
    <h3>Cross-section</h3><div id="xs"></div>
    ${el.p.lanes.some((l) => l.w2 !== null && l.w2 !== l.w)
      ? '<div class="row"><button data-xsdl="0">Download start (SVG)</button><button data-xsdl="1">Download end (SVG)</button></div>'
      : '<div class="row"><button data-xsdl="0">Download cross-section (SVG)</button></div>'}`;
}

function renderCrossSection(el) {
  const box = $('xs');
  if (!box) return;
  const lanes = el.p.lanes;
  const total = (t) => lanes.reduce((sum, l) => sum + Math.max(0, l.w + ((l.w2 ?? l.w) - l.w) * t), 0);
  const tapers = lanes.some((l) => l.w2 !== null && l.w2 !== l.w);
  const one = (t, title) => crossSectionSvg(lanes, t, fmt, { pxPerM: Math.min(22, 260 / Math.max(1, total(t))), title }).svg;
  box.innerHTML = tapers ? one(0, 'Start of road') + one(1, 'End of road') : one(0, '');
}

function linksHtml(el) {
  if (el.type !== 'segment') return '';
  const parts = ['start', 'end'].map((end) => {
    const l = el.p.links?.[end];
    const target = l && getEl(l.id);
    if (!target) return '';
    const where = l.key.startsWith('leg') ? `${TYPES[target.type].label}, leg ${+l.key.slice(3) + 1}` : TYPES[target.type].label;
    return `<div class="linkrow">${end === 'start' ? 'Start' : 'End'} connected to ${esc(where)} <button data-unlink="${end}">Disconnect</button></div>`;
  }).join('');
  return parts ? `<h3>Connections</h3>${parts}` : '';
}

function warningsOf(el) {
  const t = TYPES[el.type];
  if (!t.warnings) return [];
  return t.kind === 'point' ? t.warnings(el.p, fmt) : t.warnings(el, fmt);
}
const warningsHtml = (el) => {
  const w = warningsOf(el);
  return w.length ? `<div class="warn"><strong>Design guide check</strong><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <span class="muted small">Typical ranges from FHWA, NACTO and MUTCD guidance, not an engineering review.</span></div>` : '';
};

function renderProps() {
  const el = getEl(ui.selectedId);
  if (!el) {
    const list = els();
    const name = project.variants[project.current].name;
    props.innerHTML = list.length
      ? `<h2>${esc(name)} · ${list.length} item${list.length === 1 ? '' : 's'}</h2>
        <p class="muted small props-help">Click something on the map or in this list to edit it.</p>
        <ul class="ellist">${list.map((e, i) => ({ e, i })).reverse().map(({ e }) => `<li><button data-pick="${e.id}">${ICONS[e.type] || ''}<span>${esc(nameOf(e))}</span></button></li>`).join('')}</ul>
        <button id="clear" class="danger">Clear all</button>`
      : `<h2>Properties</h2><p class="muted">Pick a tool on the left and click the map. Click anything you've drawn to edit it.</p>`;
    props.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => { ui.selectedId = b.dataset.pick; ui.hoverId = null; render(); renderProps(); });
      b.addEventListener('pointerenter', () => { ui.hoverId = b.dataset.pick; render(); });
      b.addEventListener('pointerleave', () => { ui.hoverId = null; render(); });
    });
    const clear = $('clear');
    if (clear) clear.onclick = () => {
      checkpoint();
      project.variants[project.current].elements = [];
      refresh();
      toast(`Cleared ${name}.`, { undoable: true });
    };
    return;
  }
  const t = TYPES[el.type];
  const help = t.help ?? (t.kind === 'point' ? t.hint : '');
  let h = `<div class="props-head"><h2>${t.label}</h2>
      <button data-act="dup" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${ACT_ICONS.dup}</button>
      <button data-act="front" title="Bring to front" aria-label="Bring to front">${ACT_ICONS.front}</button>
      <button data-act="back" title="Send to back" aria-label="Send to back">${ACT_ICONS.back}</button>
      <button data-act="del" class="danger" title="Delete (Del)" aria-label="Delete">${ACT_ICONS.del}</button></div>
    ${help ? `<p class="muted small props-help">${help}</p>` : ''}`;
  if (t.kind === 'point' && !t.noRotate) {
    h += `<label>Rotation (°)<span class="field">
      <input type="range" data-k="rot" min="0" max="359" step="1" value="${Math.round(el.rot)}">
      <input type="number" data-k="rot" min="0" max="359" step="1" value="${Math.round(el.rot)}"></span></label>`;
  }
  h += t.params.filter((d) => !d.when || d.when(el.p)).map((d) => paramHtml(d, el.p[d.k])).join('');
  if (t.legs) h += legsHtml(el);
  if (t.lanes) h += lanesHtml(el);
  h += linksHtml(el);
  h += `<div id="warns">${warningsHtml(el)}</div>`;
  h += '<div class="row"><button data-act="deselect">Done</button></div>';
  props.innerHTML = h;
  if (t.lanes) renderCrossSection(el);
  wireProps(el);
}

function liveUpdate(el) {
  render();
  save();
  const w = $('warns');
  if (w) w.innerHTML = warningsHtml(el);
  if (TYPES[el.type].lanes) renderCrossSection(el);
  clearTimeout(qtyTimer);
  qtyTimer = setTimeout(renderQuantities, 300);
}

function wireProps(el) {
  const t = TYPES[el.type];
  props.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('focus', checkpoint, { once: true });
    input.addEventListener('pointerdown', checkpoint, { once: true });
  });

  props.querySelectorAll('[data-k]').forEach((input) => {
    const handler = () => {
      const k = input.dataset.k;
      const d = t.params.find((x) => x.k === k);
      let v;
      if (input.type === 'checkbox') v = input.checked;
      else if (input.tagName === 'SELECT' || input.type === 'text') v = input.value;
      else { v = parseFloat(input.value); if (Number.isNaN(v)) return; }
      if (k === 'rot') el.rot = ((v % 360) + 360) % 360;
      else if (d.type === 'len') el.p[k] = clamp(fromDisp(v), d.min, d.max);
      else if (d.type === 'int' || d.type === 'num') el.p[k] = clamp(v, d.min, d.max);
      else el.p[k] = v;
      props.querySelectorAll(`[data-k="${k}"]`).forEach((o) => { if (o !== input && o.type !== 'checkbox') o.value = input.value; });
      liveUpdate(el);
      // show or hide the fields that depend on this one
      if (t.params.some((x) => x.when) && (input.type === 'checkbox' || input.tagName === 'SELECT')) renderProps();
    };
    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', handler);
  });

  // roundabout legs
  const count = props.querySelector('[data-legcount]');
  if (count) {
    count.addEventListener('change', () => {
      const c = clamp(Math.round(+count.value), 3, 6);
      el.p.legs = makeLegs(c, el.p.legs[0]?.approach || 10, el.p.legs);
      refresh();
    });
  }
  props.querySelectorAll('[data-leg-i]').forEach((input) => {
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      const leg = el.p.legs[+input.dataset.legI], f = input.dataset.lf;
      if (f === 'crosswalk') leg.crosswalk = input.checked;
      else {
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return;
        leg[f] = f === 'angle' ? ((v % 360) + 360) % 360 : clamp(fromDisp(v), 4, 30);
      }
      liveUpdate(el);
    });
  });
  props.querySelectorAll('[data-allxw]').forEach((b) => b.addEventListener('click', () => {
    checkpoint();
    el.p.legs.forEach((l) => { l.crosswalk = b.dataset.allxw === '1'; });
    refresh();
  }));

  // road lanes
  const preset = props.querySelector('[data-preset]');
  if (preset) {
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      checkpoint();
      el.p.lanes = structuredClone(PRESETS[preset.value]);
      ui.lastLanes = structuredClone(el.p.lanes);
      refresh();
    });
  }
  props.querySelectorAll('.lanerow').forEach((row) => {
    const i = +row.dataset.lane, lane = el.p.lanes[i];
    row.querySelectorAll('[data-lf]').forEach((input) => {
      const f = input.dataset.lf;
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
        if (f === 'type') {
          const T = LANE_TYPES[input.value];
          Object.assign(lane, { type: input.value, w: T.def, w2: null, dir: T.dir ? lane.dir || 'fwd' : null });
          ui.lastLanes = structuredClone(el.p.lanes);
          refresh();
          return;
        }
        if (f === 'w2' && input.value.trim() === '') lane.w2 = null;
        else {
          const v = parseFloat(input.value);
          if (Number.isNaN(v)) return;
          lane[f] = clamp(fromDisp(v), 0, 30);
        }
        ui.lastLanes = structuredClone(el.p.lanes);
        liveUpdate(el);
      });
    });
    row.querySelectorAll('[data-lact]').forEach((b) => b.addEventListener('click', () => {
      checkpoint();
      const a = b.dataset.lact, L = el.p.lanes;
      if (a === 'dir') lane.dir = lane.dir === 'back' ? 'fwd' : 'back';
      if (a === 'del') L.splice(i, 1);
      if (a === 'up' && i > 0) [L[i - 1], L[i]] = [L[i], L[i - 1]];
      if (a === 'down' && i < L.length - 1) [L[i + 1], L[i]] = [L[i], L[i + 1]];
      ui.lastLanes = structuredClone(L);
      refresh();
    }));
  });
  const add = props.querySelector('[data-addlane]');
  if (add) add.onclick = () => {
    checkpoint();
    const L = el.p.lanes;
    L.splice(Math.ceil(L.length / 2), 0, { type: 'travel', w: LANE_TYPES.travel.def, w2: null, dir: 'fwd' });
    refresh();
  };
  const flip = props.querySelector('[data-flip]');
  if (flip) flip.onclick = () => {
    checkpoint();
    el.pts.reverse();
    const links = el.p.links || {};
    el.p.links = { start: links.end, end: links.start };
    if (!el.p.links.start) delete el.p.links.start;
    if (!el.p.links.end) delete el.p.links.end;
    el.p.lanes = el.p.lanes.reverse().map((l) => ({
      ...l, w: l.w2 ?? l.w, w2: l.w2 === null ? null : l.w, dir: l.dir === 'fwd' ? 'back' : l.dir === 'back' ? 'fwd' : l.dir,
    }));
    const xs = el.p.xwStart; el.p.xwStart = el.p.xwEnd; el.p.xwEnd = xs;
    refresh();
  };
  props.querySelectorAll('[data-xsdl]').forEach((b) => b.addEventListener('click', () => {
    const t0 = +b.dataset.xsdl;
    const { svg } = crossSectionSvg(el.p.lanes, t0, fmt, { pxPerM: 30, title: t0 ? 'End of road' : 'Start of road' });
    download(svg, `cross-section-${t0 ? 'end' : 'start'}.svg`, 'image/svg+xml');
  }));
  props.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', () => {
    checkpoint();
    delete el.p.links[b.dataset.unlink];
    refresh();
  }));

  props.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'dup') duplicate();
    if (a === 'del') removeSelected();
    if (a === 'deselect') { ui.selectedId = null; render(); renderProps(); }
    if (a === 'front' || a === 'back') {
      checkpoint();
      const list = els(), i = list.indexOf(el);
      list.splice(i, 1);
      if (a === 'front') list.push(el); else list.unshift(el);
      refresh();
    }
  }));
}

function syncRotation(el) {
  props.querySelectorAll('[data-k="rot"]').forEach((o) => { o.value = Math.round(el.rot); });
}

function duplicate() {
  const el = getEl(ui.selectedId);
  if (!el) return;
  checkpoint();
  const copy = structuredClone(el);
  copy.id = uid();
  if (copy.pts) {
    copy.pts = copy.pts.map((p) => { const [x, y] = toPx(p[0], p[1]); return fromPx(x + 30, y + 30); });
    copy.p.links = {};
  } else {
    const [x, y] = toPx(el.lat, el.lng);
    [copy.lat, copy.lng] = fromPx(x + 30, y + 30);
  }
  els().push(copy);
  ui.selectedId = copy.id;
  refresh();
}

function removeSelected() {
  const el = getEl(ui.selectedId);
  if (!el) return;
  toast(`Deleted ${TYPES[el.type].label.toLowerCase()}.`, { undoable: true });
  checkpoint();
  project.variants[project.current].elements = els().filter((e) => e.id !== ui.selectedId);
  ui.selectedId = null;
  refresh();
}

// ---------- view / compare ----------
function wireView() {
  $('showProposal').addEventListener('change', (e) => { ui.hidden = !e.target.checked; render(); });
  $('proposalOpacity').addEventListener('input', (e) => { ui.opacity = +e.target.value; render(); });
  $('compare').addEventListener('change', (e) => { ui.compare = e.target.checked; render(); });
}

// ---------- imagery and pasted screenshot ----------
function renderImagery() {
  const cfg = project.imagery;
  const b = project.backdrop;
  let html = `<label>Aerial imagery<select id="imgSource">${Object.entries(SOURCES).map(([k, s]) => `<option value="${k}" ${k === cfg.source ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>`;
  if (cfg.source === 'esri') {
    html += `<label>ArcGIS API key<input type="password" id="esriKey" value="${esc(cfg.esriKey)}" placeholder="Paste your key"></label>
      <p class="muted small">Free with an ArcGIS Location Platform account. The key is kept in this browser and in saved project files.</p>`;
  }
  if (cfg.source === 'custom') {
    html += `<label>Tile URL<input type="text" id="customUrl" value="${esc(cfg.customUrl)}" placeholder="https://…/{z}/{y}/{x}"></label>
      <label>Max zoom<input type="number" id="customMax" min="10" max="23" value="${cfg.customMax}"></label>
      <p class="muted small">Many cities and counties publish sharp aerial photos as ArcGIS "MapServer/tile/{z}/{y}/{x}" URLs.</p>`;
  }
  if (imageryNote) html += `<p class="warn small">${esc(imageryNote)}</p>`;

  html += '<h3>Map screenshot</h3>';
  if (!b) {
    html += `<p class="muted small">Paste (Ctrl+V) or drop a Google Maps screenshot, or choose a file. Keep Google's logo
      and attribution visible in the screenshot.</p><button id="bdPick">Choose image…</button>`;
  } else {
    html += `<label class="check"><input type="checkbox" id="bdVisible" ${b.visible ? 'checked' : ''}> Show screenshot</label>
      <label>Opacity<input type="range" id="bdOpacity" min="0.1" max="1" step="0.05" value="${b.opacity}"></label>
      <label>Scale (${unitLabel()} per screenshot pixel)<input type="number" id="bdScale" step="0.001" value="${+(toDisp(b.mpp)).toFixed(4)}"></label>
      <div class="row"><button id="bdAdjust" class="${ui.adjustBackdrop ? 'on' : ''}">${ui.adjustBackdrop ? 'Done moving' : 'Move'}</button>
        <button id="bdCal">Calibrate scale</button></div>
      <div class="row"><button id="bdPick">Replace</button><button id="bdRemove" class="danger">Remove</button></div>
      <p class="muted small">Line it up by lowering the opacity and dragging. To set the scale, use Calibrate and click
      both ends of the screenshot's scale bar, or two points a known distance apart.</p>`;
  }
  $('imgSec').innerHTML = html;

  $('imgSource').onchange = (e) => { project.imagery.source = e.target.value; applyImagery(); };
  if ($('esriKey')) $('esriKey').onchange = (e) => { project.imagery.esriKey = e.target.value.trim(); applyImagery(); };
  if ($('customUrl')) $('customUrl').onchange = (e) => { project.imagery.customUrl = e.target.value.trim(); applyImagery(); };
  if ($('customMax')) $('customMax').onchange = (e) => { project.imagery.customMax = clamp(+e.target.value || 19, 10, 23); applyImagery(); };
  $('bdPick').onclick = () => $('bdFile').click();
  if (!b) return;
  $('bdVisible').onchange = (e) => { b.visible = e.target.checked; render(); save(); };
  $('bdOpacity').oninput = (e) => { b.opacity = +e.target.value; render(); save(); };
  $('bdScale').onchange = (e) => { const v = parseFloat(e.target.value); if (v > 0) { b.mpp = fromDisp(v); render(); save(); } };
  $('bdAdjust').onclick = () => {
    ui.adjustBackdrop = !ui.adjustBackdrop;
    overlay.classList.toggle('adjusting', ui.adjustBackdrop);
    if (ui.adjustBackdrop) setTool('select');
    updateHint();
    renderImagery();
  };
  $('bdCal').onclick = () => {
    setTool('select');
    ui.calibrate = { pts: [] };
    overlay.classList.add('placing');
    map.getContainer().style.cursor = 'crosshair';
    updateHint();
  };
  $('bdRemove').onclick = () => {
    if (!confirm('Remove the screenshot?')) return;
    project.backdrop = null;
    ui.adjustBackdrop = false;
    overlay.classList.remove('adjusting');
    render(); save(); renderImagery(); updateHint();
  };
}

function applyImagery() {
  imageryNote = imagery.apply(project.imagery);
  save();
  renderImagery();
}

async function calibrateClick(ll) {
  const c = ui.calibrate;
  c.pts.push(ll);
  if (c.pts.length < 2) { updateHint(); return; }
  ui.calibrate = null;
  overlay.classList.remove('placing');
  map.getContainer().style.cursor = '';
  updateHint();
  const [a, b] = c.pts;
  const [mx, my] = llToMeters(a[0], a[1], b[0], b[1]);
  const measured = Math.hypot(mx, my);
  const answer = await ask(`How far apart are those two points in real life (${unitLabel()})?`, '', 'number');
  const real = fromDisp(parseFloat(answer));
  if (!(real > 0) || !(measured > 0)) return;
  const bd = project.backdrop, ratio = real / measured;
  // scale around the first point so it stays where it is
  const [cx, cy] = llToMeters(a[0], a[1], bd.lat, bd.lng);
  [bd.lat, bd.lng] = offsetLL(a[0], a[1], cx * ratio, -cy * ratio);
  bd.mpp *= ratio;
  render(); save(); renderImagery();
  toast(`Scale set. Now use Move to line the screenshot up with the aerial photo.`);
}

async function loadBackdrop(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  // shrink very large images so the project still fits in browser storage
  const k = Math.min(1, 2400 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  const c = map.getCenter();
  project.backdrop = {
    url: canvas.toDataURL('image/jpeg', 0.88), w: canvas.width, h: canvas.height,
    lat: c.lat, lng: c.lng, mpp: 1 / ppm(c.lat) / k, opacity: 0.85, visible: true,
  };
  ui.adjustBackdrop = true;
  overlay.classList.add('adjusting');
  ui.selectedId = null;
  setTool('select');
  render(); save(); renderImagery(); updateHint();
  // bring its controls into view
  const sec = document.querySelector('details[data-sec="imagery"]');
  sec.open = true;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Screenshot added. Use Calibrate scale if its size looks off.');
}

document.addEventListener('paste', (e) => {
  if (e.target.matches('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); loadBackdrop(item.getAsFile()); }
});
$('stage').addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
$('stage').addEventListener('drop', (e) => {
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); loadBackdrop(file); }
});
$('bdFile').addEventListener('change', (e) => { loadBackdrop(e.target.files[0]); e.target.value = ''; });

// ---------- quantities ----------
const QTY_ROWS = [
  ['asphalt', 'New asphalt'], ['concrete', 'Concrete (sidewalks, islands, curb extensions)'],
  ['green', 'Landscaping'], ['paint', 'Paint and markings'], ['deck', 'Parklet deck'],
];
function quantities() {
  const q = { asphalt: 0, concrete: 0, green: 0, paint: 0, deck: 0, trees: 0 };
  for (const el of els()) {
    const t = TYPES[el.type];
    if (!t.qty) continue;
    const r = t.kind === 'point' ? t.qty(el.p) : t.qty(el);
    for (const k in r) q[k] = (q[k] || 0) + (r[k] || 0);
  }
  return q;
}
const areaNum = (m2) => Math.round(project.units === 'ft' ? m2 * SQFT : m2).toLocaleString();
function renderQuantities() {
  const q = quantities();
  const perUnit = project.units === 'ft' ? 1 / SQFT : 1; // stored per m²
  const costLabel = project.units === 'ft' ? '$/sq ft' : '$/m²';
  let total = 0;
  let rows = QTY_ROWS.filter(([k]) => q[k] > 0.01).map(([k, label]) => {
    const cost = q[k] * project.costs[k];
    total += cost;
    return `<tr><td>${label}</td><td>${areaNum(q[k])}</td>
      <td><input type="number" data-cost="${k}" min="0" step="0.5" value="${+(project.costs[k] * perUnit).toFixed(2)}" title="${costLabel}"></td>
      <td>$${Math.round(cost).toLocaleString()}</td></tr>`;
  }).join('');
  if (q.trees) {
    const cost = q.trees * project.costs.trees;
    total += cost;
    rows += `<tr><td>Trees</td><td>${q.trees}</td><td><input type="number" data-cost="trees" min="0" step="50" value="${project.costs.trees}" title="$ each"></td>
      <td>$${Math.round(cost).toLocaleString()}</td></tr>`;
  }
  $('qtySec').innerHTML = rows
    ? `<table class="qty"><tr><th></th><th>${project.units === 'ft' ? 'sq ft' : 'm²'}</th><th>${costLabel}</th><th>Cost</th></tr>${rows}
        <tr class="total"><td colspan="3">Rough total</td><td>$${Math.round(total).toLocaleString()}</td></tr></table>
       <p class="muted small">Placeholder prices for a first-pass estimate; edit them for your area. Excludes drainage, utilities, signals and design fees.</p>`
    : '<p class="muted small">Quantities appear here as you draw.</p>';
  $('qtySec').querySelectorAll('[data-cost]').forEach((input) => input.addEventListener('change', () => {
    const k = input.dataset.cost, v = parseFloat(input.value);
    if (!(v >= 0)) return;
    project.costs[k] = k === 'trees' ? v : v / perUnit;
    save();
    renderQuantities();
  }));
}

// ---------- design options ----------
function renderVariants() {
  $('variant').innerHTML = project.variants.map((v, i) => `<option value="${i}" ${i === project.current ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}
function switchVariant(i) {
  project.current = i;
  ui.selectedId = null;
  ui.draft = null;
  undoStack.length = 0;
  redoStack.length = 0;
  renderVariants();
  refresh();
}
function wireVariants() {
  $('variant').onchange = (e) => switchVariant(+e.target.value);
  $('varNew').onclick = () => {
    const letter = String.fromCharCode(65 + project.variants.length);
    project.variants.push({ id: uid(), name: `Option ${letter}`, elements: [] });
    switchVariant(project.variants.length - 1);
  };
  $('varDup').onclick = () => {
    const cur = project.variants[project.current];
    const copy = structuredClone(cur);
    copy.id = uid();
    copy.name = `${cur.name} copy`;
    // keep connections working inside the copy by giving every element a new id
    const ids = new Map(copy.elements.map((e) => [e.id, uid()]));
    copy.elements.forEach((e) => {
      e.id = ids.get(e.id);
      if (e.p.links) for (const end of ['start', 'end']) if (e.p.links[end]) e.p.links[end].id = ids.get(e.p.links[end].id);
    });
    project.variants.push(copy);
    switchVariant(project.variants.length - 1);
  };
  $('varRename').onclick = async () => {
    const v = project.variants[project.current];
    const name = await ask('Name this design option', v.name);
    if (name && name.trim()) { v.name = name.trim(); renderVariants(); refresh(); }
  };
  // close the ⋯ menu after picking an item or clicking elsewhere
  const menu = $('varMenu');
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { menu.open = false; }));
  document.addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  $('varDel').onclick = () => {
    if (project.variants.length === 1) { toast('This is the only design option.'); return; }
    if (!confirm(`Delete "${project.variants[project.current].name}"?`)) return;
    project.variants.splice(project.current, 1);
    switchVariant(Math.max(0, project.current - 1));
  };
}

// ---------- project files ----------
function download(text, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function wireFiles() {
  $('saveFile').onclick = () => {
    saveNow();
    download(JSON.stringify(project), `road-draft-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  };
  $('openFile').onclick = () => $('projFile').click();
  $('projFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = normalizeProject(JSON.parse(await file.text()));
      project = p;
      ui.selectedId = null; ui.draft = null; undoStack.length = 0; redoStack.length = 0;
      if (p.view) map.setView([p.view[0], p.view[1]], p.view[2]);
      imageryNote = imagery.apply(p.imagery);
      $('units').value = p.units;
      renderVariants(); renderImagery(); refresh();
      toast(`Opened ${file.name}`);
    } catch {
      toast("That file isn't a Road Drafter project.");
    }
  });
}

// ---------- export ----------
function scaleBar(W, H) {
  const lat = map.getCenter().lat;
  const pxPerUnit = ppm(lat) / (project.units === 'ft' ? M2FT : 1);
  const options = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const len = options.filter((v) => v * pxPerUnit <= 160).pop() || options[0];
  const px = len * pxPerUnit, x = 16, y = H - 20;
  return `<g id="Scale bar">
    <rect x="${x - 6}" y="${y - 20}" width="${n(px + 12)}" height="30" rx="3" fill="#000" fill-opacity="0.55"/>
    <line x1="${x}" y1="${y}" x2="${n(x + px)}" y2="${y}" stroke="#fff" stroke-width="2"/>
    <line x1="${x}" y1="${y - 5}" x2="${x}" y2="${y + 5}" stroke="#fff" stroke-width="2"/>
    <line x1="${n(x + px)}" y1="${y - 5}" x2="${n(x + px)}" y2="${y + 5}" stroke="#fff" stroke-width="2"/>
    <text x="${n(x + px / 2)}" y="${y - 6}" fill="#fff" font-family="Inter, sans-serif" font-size="12" text-anchor="middle">${len} ${unitLabel()}</text>
  </g>`;
}

async function buildSvg() {
  const size = map.getSize(), W = size.x, H = size.y;
  let bg = '', credit = '';
  if (project.exportAerial) {
    const url = await imagery.exportBackground(+$('res').value);
    bg = `<image id="Aerial photo" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" xlink:href="${url}"/>`;
    credit = imagery.attribution();
  }
  resolveLinks();
  const counts = new Map();
  const body = els().map((el) => {
    let name = nameOf(el);
    const c = (counts.get(name) || 0) + 1;
    counts.set(name, c);
    if (c > 1) name += ` (${c})`;
    return markup(el, { interactive: false, layerName: name });
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${bg}
${backdropMarkup(false)}
<g id="${esc(project.variants[project.current].name)}">
${body}
</g>
${scaleBar(W, H)}
${credit ? `<text id="Attribution" x="${W - 8}" y="${H - 8}" fill="#fff" fill-opacity="0.85" font-family="Inter, sans-serif" font-size="11" text-anchor="end">${esc(credit)}</text>` : ''}
</svg>`;
}

async function runExport(action) {
  const status = $('status');
  if (map.getZoom() < 15) { status.textContent = 'Zoom in further before exporting (street level).'; return; }
  status.textContent = project.exportAerial ? 'Fetching aerial photo…' : 'Building SVG…';
  const buttons = [$('copy'), $('download')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const svg = await buildSvg();
    const mb = (svg.length / 1e6).toFixed(1);
    if (action === 'copy') {
      await navigator.clipboard.writeText(svg);
      status.textContent = `Copied (${mb} MB). Paste into Figma with Ctrl+V.`;
    } else {
      download(svg, `road-draft-${new Date().toISOString().slice(0, 10)}.svg`, 'image/svg+xml');
      status.textContent = `Downloaded (${mb} MB). Drag the file into Figma.`;
    }
  } catch (err) {
    status.textContent = action === 'copy' && err.name === 'NotAllowedError'
      ? 'Clipboard blocked by the browser. Use Download instead.'
      : `Export failed: ${err.message}`;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  // checkboxes and sliders shouldn't swallow shortcuts; text boxes and dropdowns should
  if (e.target.matches('input:not([type=checkbox]):not([type=range]), select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && k === 's') { e.preventDefault(); $('saveFile').click(); return; }
  if (mod) return;
  if (ui.draft) {
    if (e.key === 'Enter') { e.preventDefault(); finishDraft(); return; }
    if (e.key === 'Escape') { ui.draft = null; render(); return; }
    if (e.key === 'Backspace') { ui.draft.pts.pop(); if (!ui.draft.pts.length) ui.draft = null; render(); return; }
  }
  if (e.key === 'Escape') {
    ui.calibrate = null;
    if (ui.adjustBackdrop) { ui.adjustBackdrop = false; overlay.classList.remove('adjusting'); renderImagery(); }
    setTool('select');
    return;
  }
  if (k === 'v') { setTool('select'); return; }
  if (k === 'h') { ui.hidden = !ui.hidden; $('showProposal').checked = !ui.hidden; render(); return; }
  const tool = Object.entries(TYPES).find(([, t]) => t.key === k);
  if (tool) { setTool(tool[0]); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); return; }
  if (e.key === '[' || e.key === ']') {
    const el = getEl(ui.selectedId);
    if (!el || el.pts) return;
    checkpoint();
    el.rot = (el.rot + (e.shiftKey ? 15 : 5) * (e.key === '[' ? -1 : 1) + 360) % 360;
    refresh();
  }
});

// ---------- collapsible panel sections (remembered per browser) ----------
function wireSections() {
  let open = {};
  try { open = JSON.parse(localStorage.getItem('road-drafter-sections') || '{}'); } catch { /* storage unavailable */ }
  document.querySelectorAll('details.sec').forEach((d) => {
    if (d.dataset.sec in open) d.open = open[d.dataset.sec];
    d.addEventListener('toggle', () => {
      open[d.dataset.sec] = d.open;
      try { localStorage.setItem('road-drafter-sections', JSON.stringify(open)); } catch { /* ignore */ }
    });
  });
}

// ---------- start ----------
$('units').value = project.units;
$('units').addEventListener('change', (e) => { project.units = e.target.value; refresh(); renderImagery(); });
$('exportAerial').checked = project.exportAerial;
$('exportAerial').addEventListener('change', (e) => { project.exportAerial = e.target.checked; save(); });
$('copy').onclick = () => runExport('copy');
$('undoBtn').onclick = () => undo();
$('redoBtn').onclick = () => redo();
$('download').onclick = () => runExport('download');
setupSearch(map, $('search'), $('q'), $('results'));
buildToolbar();
wireSections();
$('welcomeSearch').onclick = () => $('q').focus();
updateWelcome();
wireView();
wireVariants();
wireFiles();
renderVariants();
renderImagery();
setTool('select');
refresh();

// for debugging and automated tests
window.app = { map, get project() { return project; }, els, ui, render, refresh, setTool, buildSvg, portsOf };
