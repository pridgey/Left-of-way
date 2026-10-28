// Left Of Way: draft street redesigns on aerial imagery and export them to Figma as SVG.
import {
  M2FT, ppmAt, n, offsetLL, llToMeters, localToLL, bearingVec, vecBearing, dist, pathD, samplePath, nearestOnSamples, frameAt,
  distToSegment,
} from './geo.js';
import { TYPES, GROUPS, ICONS, migrateElement, newParams } from './types/index.js';
import { makeLegs } from './types/points.js';
import {
  LANE_TYPES, LANE_SHORT, PRESETS, roadWidth, laneLayout, crossSectionSvg, roadHit, laneOutline, sidePort, lanesAtJoint,
} from './types/paths.js';
import { SOURCES, createImagery } from './imagery.js';
import { setupSearch } from './search.js';

// Storage keys keep the app's old name so existing saved work still loads.
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
  split: icon('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
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
  splitting: false, splitHover: null, extend: null, snap: null, laneSel: null, laneHover: null,
  laneEnd: 0, taperEdit: false, laneClip: null, mirror: true, ctrlHeld: false,
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
  if (ui.extend) endExtendMode();
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
}, () => project.variants.flatMap((v) => v.elements.flatMap((e) => (e.pts ? e.pts : [[e.lat, e.lng]]))));
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

// The port a link points at: a fixed port, or a spot on the side of a road.
function portFor(target, link) {
  if (!target) return null;
  if (link.key === 'side') {
    if (target.type !== 'segment') return null;
    const sp = sidePort(target, link.s, link.side, linkDirs.get(target.id) || {});
    return sp && { id: target.id, key: 'side', s: link.s, side: link.side, ...sp };
  }
  return portsOf(target).find((p) => p.key === link.key) || null;
}
const linkOf = (port) => (port.key === 'side' ? { id: port.id, key: 'side', s: port.s, side: port.side } : { id: port.id, key: port.key });

// A spot on the side of a road near px (on its curb, sidewalk or roadway), to start a T there.
function nearestSide(px, excludeId) {
  let best = null, bestD = Infinity;
  for (const el of els()) {
    if (el.type !== 'segment' || el.id === excludeId || el.pts.length < 2) continue;
    const ctx = ctxFor(el);
    const hit = roadHit(el, ctx, px);
    if (!hit || hit.pastEnd || hit.frac < 0.01 || hit.frac > 0.99) continue;
    const b = hit.layout.bounds, slack = SNAP_PX / ctx.s;
    if (hit.lateral < b[0] - slack || hit.lateral > b[b.length - 1] + slack) continue;
    const side = hit.lateral >= 0 ? 1 : -1;
    const d = Math.abs(Math.abs(hit.lateral) - hit.layout.road / 2);
    if (d < bestD) {
      const port = portFor(el, { key: 'side', s: hit.frac, side });
      if (port) { best = port; bestD = d; }
    }
  }
  return best;
}

// What a road end at px would connect to: another road's end (or a leg) first, else a road's side.
const snapTarget = (px, excludeId) => nearestPort(px, excludeId) || nearestSide(px, excludeId);

// Roads that meet the side of another road draw on top of it so their corners show.
function orderSideRoads() {
  const list = els();
  for (const el of [...list]) {
    for (const end of ['start', 'end']) {
      const l = el.p.links?.[end];
      if (l?.key !== 'side') continue;
      const i = list.indexOf(el), j = list.findIndex((o) => o.id === l.id);
      if (j > i) { list.splice(i, 1); list.splice(j, 0, el); }
    }
  }
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
        const port = portFor(target, link);
        if (!port) { if (pass) delete el.p.links[end]; continue; }
        const idx = end === 'start' ? 0 : el.pts.length - 1;
        el.pts[idx] = [port.ll[0], port.ll[1]];
        // a road meeting another's side keeps its own angle and is trimmed along that curb
        if (link.key === 'side') { dirs[`${end}Side`] = { c: port.tangent }; continue; }
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
  if (!el || ui.extend) return '';
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
  if (!t.maxPts && ui.ctrlHeld) {
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
    // warn on ends whose lanes don't line up with the road they continue
    for (const end of ['start', 'end']) {
      if (!jointMismatch(el, end)) continue;
      const [x, y] = end === 'start' ? px[0] : px[px.length - 1];
      out += `<g transform="translate(${n(x + 14)} ${n(y - 14)})"><circle r="10" fill="#f0b429" stroke="#1d1f22" stroke-width="2"/>
        <text y="4.5" text-anchor="middle" font-size="13" font-weight="700" font-family="system-ui, sans-serif" fill="#1d1f22">!</text>
        <title>Lanes don't line up with the connected road at the ${end}</title></g>`;
    }
    // "+" handles past each free end: click to keep drawing, drag to add a point
    for (const end of ['start', 'end']) {
      if (el.p.links?.[end]) continue;
      const [a, b] = end === 'end' ? [px[px.length - 1], px[px.length - 2]] : [px[0], px[1]];
      const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const hx = a[0] + ((a[0] - b[0]) / L) * 30, hy = a[1] + ((a[1] - b[1]) / L) * 30;
      // with Ctrl held the + starts a new connected road instead (orange, with a joint mark)
      const col = ui.ctrlHeld ? '#ff9f1c' : '#2f9bff';
      out += `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(hx)}" y2="${n(hy)}" stroke="${col}" stroke-width="1.5" stroke-dasharray="3 3"/>
        <g class="handle ext" data-ext="${end}" transform="translate(${n(hx)} ${n(hy)})"><circle r="9" fill="${col}" stroke="#fff" stroke-width="2"/>
        <path d="M -4 0 H 4 M 0 -4 V 4" stroke="#fff" stroke-width="2"/>
        <title>${ui.ctrlHeld ? 'New road: click to draw a new road from this end, or drag one out' : 'Extend: click to keep drawing from this end, or drag to add a point. Hold Ctrl (⌘) to start a new road here instead.'}</title></g>`;
    }
  }
  return laneHighlight(el) + out;
}

// Outline the lane picked in the lane editor (solid) or hovered there (dashed).
function laneHighlight(el) {
  if (el.type !== 'segment') return '';
  const ctx = ctxFor(el);
  let out = '';
  const sel = ui.laneSel?.id === el.id ? ui.laneSel.i : null;
  if (sel !== null) out += `<path d="${laneOutline(el, ctx, sel)}" fill="#2f9bff" fill-opacity="0.18" stroke="#2f9bff" stroke-width="2"/>`;
  if (ui.laneHover !== null && ui.laneHover !== sel) out += `<path d="${laneOutline(el, ctx, ui.laneHover)}" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  return out;
}

// ---------- drawing aids ----------
// The last fixed point of the road being drawn or extended, and the direction it's heading.
function drawAnchor() {
  if (ui.extend) {
    const el = getEl(ui.extend.id);
    if (!el) return null;
    const px = el.pts.map((p) => toPx(p[0], p[1]));
    const [a, b] = ui.extend.end === 'end' ? [px[px.length - 1], px[px.length - 2]] : [px[0], px[1]];
    return { px: a, ref: [a[0] - b[0], a[1] - b[1]] };
  }
  const d = ui.draft;
  if (!d?.pts.length) return null;
  const px = d.pts.map((p) => toPx(p[0], p[1]));
  const a = px[px.length - 1];
  if (px.length > 1) { const b = px[px.length - 2]; return { px: a, ref: [a[0] - b[0], a[1] - b[1]] }; }
  const port = d.links.start && portFor(getEl(d.links.start.id), d.links.start);
  return { px: a, ref: port ? bearingVec(port.bearing) : [1, 0] };
}

// Where the next point goes: snapped to a road end or side, or (Shift) to 15° steps.
function aimAt(px, shift) {
  const roads = ui.extend || ui.tool === 'segment';
  const snap = roads ? snapTarget(px, ui.extend?.id ?? null) : null;
  if (snap) return { ll: [snap.ll[0], snap.ll[1]], snap };
  const a = shift && drawAnchor();
  if (a) {
    const v = [px[0] - a.px[0], px[1] - a.px[1]], len = Math.hypot(v[0], v[1]);
    const base = Math.atan2(a.ref[1], a.ref[0]), step = Math.PI / 12;
    const ang = base + Math.round((Math.atan2(v[1], v[0]) - base) / step) * step;
    return { ll: fromPx(a.px[0] + Math.cos(ang) * len, a.px[1] + Math.sin(ang) * len), snap: null };
  }
  return { ll: fromPx(px[0], px[1]), snap: null };
}

// Length of the piece being drawn, next to the cursor.
function lengthMarkup() {
  const a = (ui.draft || ui.extend) && ui.cursor && drawAnchor();
  if (!a) return '';
  const ll = fromPx(a.px[0], a.px[1]);
  const len = map.distance(ll, ui.cursor);
  if (len < 0.5) return '';
  const [x, y] = toPx(ui.cursor[0], ui.cursor[1]);
  const text = fmt(len), w = text.length * 7 + 12;
  return `<g transform="translate(${n(x + 14)} ${n(y - 30)})" font-size="12" font-family="system-ui, sans-serif">
    <rect width="${w}" height="20" rx="10" fill="rgba(20,22,25,.85)"/><text x="${w / 2}" y="14" text-anchor="middle" fill="#fff">${text}</text></g>`;
}

// ---------- extending a road from one end ----------
// A new road starting at one end of `el`, with the same lanes and options, carrying on from it.
function newConnectedRoad(el, end, morePts) {
  const p = { ...newParams('segment'), smooth: el.p.smooth, centerline: el.p.centerline };
  p.lanes = lanesAtJoint(el, end, 'start');
  p.links = { start: { id: el.id, key: end } };
  const from = end === 'end' ? el.pts[el.pts.length - 1] : el.pts[0];
  return { id: uid(), type: 'segment', pts: [[from[0], from[1]], ...morePts], p };
}

// Ctrl+click on a road's +: start drawing a new road from that end.
function startBranch(el, end) {
  setTool('segment');
  const road = newConnectedRoad(el, end, []);
  ui.draft = { type: 'segment', pts: road.pts, links: road.p.links, p: road.p };
  render();
}
function startExtend(el, end) {
  checkpoint();
  ui.extend = { id: el.id, end, added: 0 };
  map.doubleClickZoom.disable();
  overlay.classList.add('placing');
  updateHint();
  render();
}
function endExtendMode() {
  ui.extend = null;
  ui.snap = null;
  map.doubleClickZoom.enable();
  overlay.classList.remove('placing');
  updateHint();
}
function finishExtend() {
  const x = ui.extend;
  if (!x) return;
  endExtendMode();
  if (!x.added) undoStack.pop();
  refresh();
}
function extendClick(aim) {
  const el = getEl(ui.extend.id);
  if (!el) { finishExtend(); return; }
  const end = ui.extend.end;
  const last = end === 'end' ? el.pts[el.pts.length - 1] : el.pts[0];
  if (dist(toPx(last[0], last[1]), toPx(aim.ll[0], aim.ll[1])) < 4) return; // double-click repeat
  if (end === 'end') el.pts.push(aim.ll); else el.pts.unshift(aim.ll);
  ui.extend.added++;
  if (aim.snap) {
    el.p.links = el.p.links || {};
    el.p.links[end] = linkOf(aim.snap);
    finishExtend();
    return;
  }
  render();
  save();
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
  const showing = ui.tool === 'segment' || ui.extend || (ui.drag?.mode === 'vertex' && ui.drag.el.type === 'segment');
  if (!showing) return '';
  const skip = ui.drag?.el?.id;
  let out = '';
  // ring the dot the next click (or drop) would connect to
  const near = ui.drag?.mode === 'vertex' ? ui.drag.port : ui.snap;
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
      const port = portFor(getEl(d.links.start.id), d.links.start);
      if (port?.key === 'side') dirs = { startSide: { c: port.tangent } };
      else if (port) dirs = { start: bearingVec(port.bearing) };
    }
    // preview the end meeting whatever the cursor snapped to
    if (ui.snap && ui.cursor && d.pts.length) {
      if (ui.snap.key === 'side') dirs = { ...dirs, endSide: { c: ui.snap.tangent } };
      else { const v = bearingVec(ui.snap.bearing); dirs = { ...dirs, end: [-v[0], -v[1]] }; }
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
  // while extending a road, show it reaching to the cursor
  const ext = ui.extend && ui.cursor && getEl(ui.extend.id);
  if (ext) { if (ui.extend.end === 'end') ext.pts.push(ui.cursor); else ext.pts.unshift(ui.cursor); }
  elsLayer.innerHTML = els().map((el) => markup(el)).join('');
  if (ext) { if (ui.extend.end === 'end') ext.pts.pop(); else ext.pts.shift(); }
  elsLayer.style.opacity = ui.hidden ? 0 : ui.opacity;
  if (ui.compare) {
    $('swipeRect').setAttribute('width', ui.swipe * W);
    elsLayer.setAttribute('clip-path', 'url(#swipeClip)');
  } else elsLayer.removeAttribute('clip-path');
  draftLayer.innerHTML = draftMarkup() + lengthMarkup();
  selLayer.innerHTML = hoverMarkup() + selectionMarkup() + portsMarkup() + splitMarkup() + compareMarkup(W, H);
}

let qtyTimer = null;
function refresh() {
  orderSideRoads();
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
  } else if (ui.extend) {
    hint.textContent = 'Click to add points. Click an orange dot or the side of a road to connect. Shift snaps angles. Enter or double-click to finish.';
  } else if (ui.splitting) {
    hint.textContent = 'Click a road where you want to cut it. Each piece then gets its own lanes. Esc when done.';
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
  if (ui.splitting) setSplitting(false);
  if (ui.extend) finishExtend();
  ui.calibrate = null;
  ui.tool = name;
  $('tools').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === name);
    b.setAttribute('aria-pressed', b.dataset.tool === name);
  });
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

function addDraftPoint(pt, snapped) {
  const t = TYPES[ui.tool];
  if (!ui.draft) ui.draft = { type: ui.tool, pts: [], links: {}, p: draftParams(ui.tool) };
  const d = ui.draft;
  const last = d.pts[d.pts.length - 1];
  if (last && dist(toPx(last[0], last[1]), toPx(pt[0], pt[1])) < 4) return; // double-click repeat
  d.pts.push([pt[0], pt[1]]);
  if (snapped) {
    const end = d.pts.length === 1 ? 'start' : 'end';
    d.links[end] = linkOf(snapped);
    // continuing another road: take its lanes so the two line up
    const other = getEl(snapped.id);
    if (other?.type === 'segment' && snapped.key !== 'side' && (end === 'start' || !d.links.start)) {
      d.p.lanes = lanesAtJoint(other, snapped.key, end);
    }
  }
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
  if (ui.extend) { extendClick(aimAt(px, e.originalEvent.shiftKey)); return; }
  if (ui.tool === 'select') {
    if (ui.selectedId) { ui.selectedId = null; render(); renderProps(); }
    return;
  }
  if (TYPES[ui.tool].kind === 'point') addPointElement(ui.tool, ll);
  else { const aim = aimAt(px, e.originalEvent.shiftKey); addDraftPoint(aim.ll, aim.snap); }
});
map.on('dblclick', () => { if (ui.draft) finishDraft(); if (ui.extend) finishExtend(); });
map.on('mousemove', (e) => {
  if (ui.tool === 'select' && !ui.draft && !ui.extend) return;
  ui.cursorPx = [e.containerPoint.x, e.containerPoint.y];
  ui.cursor = [e.latlng.lat, e.latlng.lng];
  ui.snap = null;
  // preview snapping to a road end or side, or to the Shift angle steps
  if (ui.extend || TYPES[ui.tool]?.kind === 'path') {
    const aim = aimAt(ui.cursorPx, e.originalEvent.shiftKey);
    ui.cursor = aim.ll;
    ui.snap = aim.snap;
  }
  render();
});
map.on('mouseout', () => { ui.cursor = null; ui.cursorPx = null; ui.snap = null; render(); });

// ---------- dragging ----------
const localPoint = (e) => { const r = overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const tgt = e.target;
  const start = localPoint(e);
  if (tgt.closest('[data-swipe]')) { e.preventDefault(); ui.drag = { mode: 'swipe' }; return; }
  if (ui.splitting) {
    const hit = getEl(tgt.closest('[data-id]')?.dataset.id);
    if (hit?.type === 'segment') { e.preventDefault(); splitRoad(hit, start); }
    return;
  }
  if (tgt.closest('[data-bd]') && ui.adjustBackdrop) {
    e.preventDefault();
    ui.drag = { mode: 'backdrop', start, origin: toPx(project.backdrop.lat, project.backdrop.lng) };
    return;
  }
  const el = getEl(ui.selectedId);
  const vtx = tgt.closest('[data-vtx]'), mid = tgt.closest('[data-mid]'), leg = tgt.closest('[data-leg]'), rot = tgt.closest('.rot');
  const ext = tgt.closest('[data-ext]');
  if (el && ext) { e.preventDefault(); ui.drag = { mode: 'ext', el, end: ext.dataset.ext, start, branch: e.ctrlKey || e.metaKey }; return; }
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
  const was = ui.selectedId === g.dataset.id;
  ui.selectedId = g.dataset.id;
  const sel = getEl(ui.selectedId);
  // Ctrl (⌘) + drag on a line adds a bend point there
  if ((e.ctrlKey || e.metaKey) && sel.pts && !TYPES[sel.type].maxPts) {
    checkpoint();
    const px = sel.pts.map((q) => toPx(q[0], q[1]));
    const closed = TYPES[sel.type].closed;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < px.length - (closed ? 0 : 1); i++) {
      const d = distToSegment(start, px[i], px[(i + 1) % px.length]);
      if (d < bestD) { bestD = d; best = i; }
    }
    sel.pts.splice(best + 1, 0, fromPx(start[0], start[1]));
    ui.drag = { mode: 'vertex', el: sel, i: best + 1, inserted: true, moved: false };
    renderProps();
    render();
    return;
  }
  checkpoint();
  ui.drag = {
    mode: 'move', el: sel, start, moved: false, was,
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
  if (ui.splitting && !d) {
    const hit = getEl(e.target.closest?.('[data-id]')?.dataset.id);
    const next = hit?.type === 'segment' ? { id: hit.id, px: localPoint(e) } : null;
    if (next || ui.splitHover) { ui.splitHover = next; render(); }
    return;
  }
  if (!d) return;
  const p = localPoint(e);
  if (d.mode === 'ext') {
    if (dist(p, d.start) < 5) return;
    checkpoint();
    const ll = fromPx(p[0], p[1]);
    if (d.branch) {
      // Ctrl: drag out a new road connected to this end, and drag its far end
      const road = newConnectedRoad(d.el, d.end, [ll]);
      els().push(road);
      ui.selectedId = road.id;
      ui.drag = { mode: 'vertex', el: road, i: 1, inserted: true };
      renderProps();
    } else {
      // dragging the + adds a new end point and drags it
      if (d.end === 'end') d.el.pts.push(ll); else d.el.pts.unshift(ll);
      ui.drag = { mode: 'vertex', el: d.el, i: d.end === 'end' ? d.el.pts.length - 1 : 0, inserted: true };
    }
  }
  const dd = ui.drag;
  dd.moved = true;
  if (dd !== d) { render(); return; }
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
      if (d.el.p.links && (d.el.p.links.start || d.el.p.links.end)) {
        d.el.p.links = {};
        toast('Road disconnected. Drag an end onto an orange dot to reconnect.', { undoable: true });
      }
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
      const port = snapTarget(p, d.el.id);
      d.el.p.links = d.el.p.links || {};
      d.port = port;
      if (port) { ll = port.ll; d.el.p.links[end] = linkOf(port); } else delete d.el.p.links[end];
    }
    d.el.pts[d.i] = [ll[0], ll[1]];
  }
  render();
});

window.addEventListener('pointerup', () => {
  const d = ui.drag;
  if (!d) return;
  ui.drag = null;
  if (d.mode === 'ext') {
    if (d.branch) startBranch(d.el, d.end); else startExtend(d.el, d.end);
    return;
  }
  const undoable = ['move', 'rotate', 'leg', 'vertex'].includes(d.mode);
  if (undoable && !d.moved && !d.inserted) undoStack.pop();
  // a second click on a selected road picks the lane under the pointer
  if (d.mode === 'move' && !d.moved && d.was && d.el.type === 'segment') {
    const hit = roadHit(d.el, ctxFor(d.el), d.start);
    if (hit && hit.lane >= 0) ui.laneSel = laneSelIn(d.el) === hit.lane ? null : { id: d.el.id, i: hit.lane };
  }
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

// ---------- splitting roads ----------
// Cut a road in two so each piece can have its own lanes, e.g. to open a median at an intersection.

function setSplitting(on) {
  ui.splitting = on;
  ui.splitHover = null;
  if (on) {
    if (ui.tool !== 'select') setTool('select');
    ui.draft = null;
    ui.selectedId = null;
    renderProps();
  }
  overlay.classList.toggle('splitting', on);
  updateHint();
  render();
}

// Where a road would be cut for a pointer at px (screen pixels), or null if too near an end.
function splitTarget(el, px) {
  const pts = el.pts.map((p) => toPx(p[0], p[1]));
  const dirs = linkDirs.get(el.id) || {};
  const sm = samplePath(pts, { smooth: el.p.smooth, step: 2, startDir: dirs.start, endDir: dirs.end });
  if (sm.length < 2) return null;
  const total = sm[sm.length - 1].s, at = nearestOnSamples(sm, px).s;
  const minGap = Math.max(6, 1.5 * ppm(elLat(el)));
  if (at < minGap || total - at < minGap) return null;
  return { pts, sm, at, total, f: frameAt(sm, at) };
}

function splitMarkup() {
  const h = ui.splitting && ui.splitHover;
  const el = h && getEl(h.id);
  const hit = el && splitTarget(el, h.px);
  if (!hit) return '';
  const { at, total, f } = hit;
  const { nx, ny } = f;
  const { bounds } = laneLayout(el.p.lanes, at / total);
  const s = ppm(elLat(el)), l = bounds[0] * s - 8, r = bounds[bounds.length - 1] * s + 8;
  const c = f;
  const line = `M ${n(c.x + nx * l)} ${n(c.y + ny * l)} L ${n(c.x + nx * r)} ${n(c.y + ny * r)}`;
  return `<path d="${line}" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
    <path d="${line}" stroke="#ff9f1c" stroke-width="2.5" stroke-dasharray="6 4"/>`;
}

function splitRoad(el, px) {
  const hit = splitTarget(el, px);
  if (!hit) { toast('Too close to the end of the road to split there.'); return; }
  const { pts, sm, at, total, f } = hit;
  checkpoint();
  // Distance along the road of each original point (the curve passes through them, in order).
  let k = 0;
  const along = pts.map((p) => {
    let best = Infinity, bestK = k;
    for (let j = k; j < sm.length; j++) {
      const d = Math.hypot(sm[j].x - p[0], sm[j].y - p[1]);
      if (d < best) { best = d; bestK = j; }
    }
    k = bestK;
    return sm[bestK].s;
  });
  const sampleLL = (d) => { const q = frameAt(sm, d); return fromPx(q.x, q.y); };
  const cut = fromPx(f.x, f.y);
  const inner = el.pts.slice(1, -1), innerAlong = along.slice(1, -1);
  let ptsA = [el.pts[0], ...inner.filter((_, j) => innerAlong[j] < at - 1), cut];
  let ptsB = [cut, ...inner.filter((_, j) => innerAlong[j] > at + 1), el.pts[el.pts.length - 1]];
  // A two-point piece would draw straight, so give it a point from the middle of the curve.
  if (ptsA.length === 2 && el.p.smooth) ptsA = [ptsA[0], sampleLL(at / 2), ptsA[1]];
  if (ptsB.length === 2 && el.p.smooth) ptsB = [ptsB[0], sampleLL((at + total) / 2), ptsB[1]];

  const t = at / total;
  const widthAt = (l) => Math.max(0, l.w + ((l.w2 ?? l.w) - l.w) * t);
  const b = structuredClone(el);
  b.id = uid();
  b.pts = ptsB;
  b.p.lanes = el.p.lanes.map((l) => (l.w2 === null ? { ...l } : { ...l, w: widthAt(l) }));
  b.p.xwStart = false;
  b.p.links = { start: { id: el.id, key: 'end' } };
  if (el.p.links?.end) b.p.links.end = el.p.links.end;

  el.pts = ptsA;
  el.p.lanes = el.p.lanes.map((l) => (l.w2 === null ? l : { ...l, w2: widthAt(l) }));
  el.p.xwEnd = false;
  if (el.p.links) delete el.p.links.end;

  // Roads that were attached to the old far end now attach to the new piece.
  for (const o of els()) {
    if (o.type !== 'segment' || !o.p.links) continue;
    for (const end of ['start', 'end']) {
      const l = o.p.links[end];
      if (l?.id !== el.id) continue;
      if (l.key === 'end') o.p.links[end] = { id: b.id, key: 'end' };
      // roads meeting the side keep their spot, on whichever piece it's now on
      if (l.key === 'side') o.p.links[end] = l.s * total < at ? { ...l, s: (l.s * total) / at } : { ...l, id: b.id, s: (l.s * total - at) / (total - at) };
    }
  }
  els().splice(els().indexOf(el) + 1, 0, b);
  ui.splitHover = null;
  refresh();
  toast('Road split in two. Click either piece after Esc to change its lanes.', { undoable: true });
}

// ---------- smoothing a road's curve ----------
// Average the drawn curve over a stretch about 1.5 road-widths long, then keep only as many
// points as it takes to follow that within ~35 cm. Each press smooths a little more.
function rdp(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function smoothRoad(el) {
  const [lat0, lng0] = el.pts[0];
  const m = el.pts.map((p) => llToMeters(lat0, lng0, p[0], p[1]));
  const dirs = linkDirs.get(el.id) || {};
  const sm = samplePath(m, { smooth: true, step: 1, startDir: dirs.start, endDir: dirs.end }).map((p) => [p.x, p.y]);
  if (sm.length < 5) return;
  const r = clamp(Math.round(roadWidth(el.p.lanes, 0) * 0.75), 3, 30);
  // Mirror the curve through each endpoint so the average can run right to the ends:
  // the endpoints stay put and the road keeps its heading there.
  const N = sm.length, A = sm[0], Z = sm[N - 1];
  const at = (j) => (j < 0 ? [2 * A[0] - sm[-j][0], 2 * A[1] - sm[-j][1]]
    : j >= N ? [2 * Z[0] - sm[2 * N - 2 - j][0], 2 * Z[1] - sm[2 * N - 2 - j][1]] : sm[j]);
  const k = Math.min(r, Math.floor((N - 1) / 2));
  const avg = sm.map((_, i) => {
    let x = 0, y = 0;
    for (let j = i - k; j <= i + k; j++) { const q = at(j); x += q[0]; y += q[1]; }
    return [x / (2 * k + 1), y / (2 * k + 1)];
  });
  // Few, evenly spread points: bunched points make the curve overshoot.
  const gap = Math.max(6, roadWidth(el.p.lanes, 0));
  const kept = rdp(avg, 0.35);
  const pts = [kept[0]];
  for (const q of kept.slice(1, -1)) {
    if (dist(q, pts[pts.length - 1]) >= gap && dist(q, kept[kept.length - 1]) >= gap) pts.push(q);
  }
  pts.push(kept[kept.length - 1]);
  // Keep the heading at free ends, so roads continuing from them don't swing round.
  // (Connected ends already take their heading from what they connect to.)
  const lead = Math.min(gap, (sm.length - 1) / 3); // samples are 1 m apart
  for (const end of ['start', 'end']) {
    if (el.p.links?.[end] || el.pts.length < 2 || lead < 1) continue;
    const [e0, e1] = end === 'start' ? [m[0], m[1]] : [m[m.length - 1], m[m.length - 2]];
    const L = dist(e0, e1) || 1;
    const guide = [e0[0] + ((e1[0] - e0[0]) / L) * lead, e0[1] + ((e1[1] - e0[1]) / L) * lead];
    const E = end === 'start' ? pts[0] : pts[pts.length - 1];
    const inner = pts.slice(1, -1).filter((q) => dist(q, E) > lead * 1.5);
    pts.splice(1, pts.length - 2, ...(end === 'start' ? [guide, ...inner] : [...inner, guide]));
  }
  // Note where side streets meet this road, to put them back at the same spot afterwards.
  const attached = els().flatMap((o) => ['start', 'end'].map((e) => ({ o, e, l: o.p.links?.[e] })))
    .filter(({ l }) => l?.id === el.id && l.key === 'side')
    .map((a) => ({ ...a, ll: portFor(el, a.l)?.ll }))
    .filter((a) => a.ll);
  const before = el.pts.length;
  checkpoint();
  el.pts = pts.map(([x, y]) => offsetLL(lat0, lng0, x, -y));
  if (attached.length) {
    const m2 = el.pts.map((p) => llToMeters(lat0, lng0, p[0], p[1]));
    const sm2 = samplePath(m2, { smooth: true, step: 1, startDir: dirs.start, endDir: dirs.end });
    const len2 = sm2[sm2.length - 1].s || 1;
    for (const { o, e, ll } of attached) {
      const q = llToMeters(lat0, lng0, ll[0], ll[1]);
      o.p.links[e] = { ...o.p.links[e], s: clamp(nearestOnSamples(sm2, q).s / len2, 0.01, 0.99) };
    }
  }
  el.p.smooth = true;
  refresh();
  toast(`Smoothed the curve (${before} points → ${el.pts.length}).`, { undoable: true });
}

// True when a road is attached end-to-end with another road.
const joinedToRoad = (el) => ['start', 'end'].some((e) => getEl(el.p.links?.[e]?.id)?.type === 'segment')
  || els().some((o) => o.type === 'segment' && ['start', 'end'].some((e) => o.p.links?.[e]?.id === el.id));

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

// ---------- lane editor ----------
// A cross-section strip: lanes drawn to scale, left to right facing the road's arrow.
// Click a lane to edit it, drag it to reorder, drag the gap between two lanes to resize them.

/** Whether the road has (or is being given) different widths at each end, and which end the editor shows. */
function laneEditing(el) {
  const tapered = el.p.lanes.some((l) => l.w2 !== null) || ui.taperEdit === el.id;
  return { tapered, at: tapered ? ui.laneEnd : 0 };
}
const laneWidth = (l, at) => (at === 1 ? l.w2 ?? l.w : l.w);
function setLaneWidth(el, l, v) {
  const { tapered, at } = laneEditing(el);
  v = clamp(v, 0, 30);
  if (tapered && at === 1) l.w2 = v; else l.w = v;
}
const shortLen = (m) => (project.units === 'ft' ? `${Math.round(m * M2FT * 2) / 2}′` : `${+m.toFixed(1)}`);
// Dark or light text, whichever reads on a lane color.
function ink(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#1d1f22' : '#fff';
}
const laneSelIn = (el) => (ui.laneSel?.id === el.id && ui.laneSel.i < el.p.lanes.length ? ui.laneSel.i : null);

// Mirror mode: when both sides of the road have the same lanes, edits to one side copy across.
const symmetric = (L) => L.every((l, i) => l.type === L[L.length - 1 - i].type);
const mirroring = (el) => ui.mirror && symmetric(el.p.lanes);
/** The lane across the middle from lane i, or null (mirror off, or i is the middle lane). */
function partner(el, i) {
  if (!mirroring(el)) return null;
  const j = el.p.lanes.length - 1 - i;
  return j === i ? null : j;
}
const flipDir = (d) => (d === 'fwd' ? 'back' : d === 'back' ? 'fwd' : d);

function laneStripHtml(el) {
  const { at } = laneEditing(el);
  const L = el.p.lanes, sel = laneSelIn(el);
  return L.map((l, i) => {
    const T = LANE_TYPES[l.type], w = laneWidth(l, at);
    const arrow = T.dir ? (l.dir === 'back' ? '↓' : '↑') : '';
    const dirText = arrow ? (l.dir === 'back' ? ', toward you' : ', away') : '';
    return `<button class="lb${i === sel ? ' sel' : ''}${w < 0.05 ? ' zero' : ''}" data-i="${i}" style="flex-grow:${Math.max(w, 0.0001).toFixed(3)};background:${T.fill};color:${ink(T.fill)}"
      title="${T.label}, ${fmt(w)}${dirText}" aria-label="${T.label}, ${fmt(w)}${dirText}" aria-pressed="${i === sel}">
      ${arrow ? `<span class="la">${arrow}</span>` : ''}<span class="ll">${LANE_SHORT[l.type]}</span><span class="lw">${shortLen(w)}</span>
      ${i < L.length - 1 ? `<span class="grip" data-grip="${i}" title="Drag to resize these two lanes (Shift: just this one)"></span>` : ''}</button>`;
  }).join('');
}

function laneTotalsHtml(el) {
  const { at } = laneEditing(el);
  const L = el.p.lanes;
  const road = roadWidth(L, at), all = L.reduce((sum, l) => sum + laneWidth(l, at), 0);
  return `<span><strong>${fmt(road)}</strong> curb to curb</span><span>${fmt(all)} overall</span>`;
}

function laneCardHtml(el) {
  const i = laneSelIn(el);
  if (i === null) return '<p class="muted small lanehint">Click a lane in the strip or on the map to edit it.</p>';
  const lane = el.p.lanes[i], T = LANE_TYPES[lane.type];
  const { tapered } = laneEditing(el);
  const unit = unitLabel(), step = project.units === 'ft' ? 0.5 : 0.1;
  const num = (f, v, label, ph = '') => `<label class="lanenum">${label}<span><input type="number" data-lf="${f}" step="${step}" min="0" value="${v === null ? '' : toDisp(v)}" placeholder="${ph}"> ${unit}</span></label>`;
  return `<div class="lanecard">
    <div class="lanecard-top">
      <span class="swatch" style="background:${T.fill}"></span>
      <select data-lf="type" aria-label="Lane type">${Object.entries(LANE_TYPES).map(([k, t]) => `<option value="${k}" ${k === lane.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
      <button data-lact="left" title="Move left (Alt+←)" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button data-lact="right" title="Move right (Alt+→)" aria-label="Move right" ${i === el.p.lanes.length - 1 ? 'disabled' : ''}>▶</button>
      <button data-lact="dup" title="Duplicate lane" aria-label="Duplicate lane">${ACT_ICONS.dup}</button>
      <button data-lact="del" class="danger" title="Remove lane (Del)" aria-label="Remove lane">${ACT_ICONS.del}</button>
    </div>
    <div class="lanecard-row">
      ${tapered ? num('w', lane.w, 'Start') + num('w2', lane.w2, 'End', toDisp(lane.w)) : num('w', lane.w, 'Width')}
      ${T.dir ? `<div class="seg" role="group" aria-label="Direction of travel">
        <button data-dir="fwd" class="${lane.dir !== 'back' ? 'on' : ''}" title="Same way as the road's arrow">↑ Away</button>
        <button data-dir="back" class="${lane.dir === 'back' ? 'on' : ''}" title="Against the road's arrow">↓ Toward</button></div>` : ''}
    </div>
  </div>`;
}

function lanesHtml(el) {
  const { tapered, at } = laneEditing(el);
  const tapers = el.p.lanes.some((l) => l.w2 !== null && l.w2 !== l.w);
  const sym = symmetric(el.p.lanes);
  return `<div class="lanes-head"><h3>Lanes</h3>
      <button data-mirror class="${ui.mirror && sym ? 'on' : ''}" aria-pressed="${ui.mirror && sym}" ${sym ? '' : 'disabled'}
        title="${sym ? 'Mirror: changes to one side of the road copy to the other side' : "Mirror needs the same lanes on both sides of the road"}">⇋ Mirror</button>
      <button data-lanecopy title="Copy these lanes to paste on another road">Copy</button>
      <button data-lanepaste title="Paste lanes copied from another road" ${ui.laneClip ? '' : 'disabled'}>Paste</button>
      <button data-flip title="Reverse the road's direction (lanes stay where they are)">Flip</button></div>
    <div class="lanetotal">${laneTotalsHtml(el)}</div>
    ${tapered ? `<div class="seg wide" role="group" aria-label="Widths shown for"><button data-laneend="0" class="${at === 0 ? 'on' : ''}">Start of road</button><button data-laneend="1" class="${at === 1 ? 'on' : ''}">End of road</button></div>` : ''}
    <div class="lanecaption"><span>◀ Left</span><span>facing the arrow</span><span>Right ▶</span></div>
    <div class="lanestrip" role="group" aria-label="Lanes, left to right. Arrow keys pick a lane, Alt+arrows move it, Delete removes it.">${laneStripHtml(el)}</div>
    <p class="muted small striphelp">Drag a lane to reorder. Drag the line between two lanes to resize them (Shift: just one).</p>
    <div id="lanecard">${laneCardHtml(el)}</div>
    <div class="row lane-add">
      <select data-addlane aria-label="Add a lane"><option value="">+ Add lane…</option>${Object.entries(LANE_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select>
      <select data-preset aria-label="Apply a preset"><option value="">Presets…</option>${Object.keys(PRESETS).map((k) => `<option>${esc(k)}</option>`).join('')}</select>
    </div>
    <label class="check"><input type="checkbox" data-taper ${tapered ? 'checked' : ''}> Different widths at each end (taper)</label>
    <details class="xsd"><summary>Cross-section drawing</summary><div id="xs"></div>
    ${tapers
      ? '<div class="row"><button data-xsdl="0">Download start (SVG)</button><button data-xsdl="1">Download end (SVG)</button></div>'
      : '<div class="row"><button data-xsdl="0">Download (SVG)</button></div>'}</details>`;
}

// Pick a lane (null to clear) and update the panel and map.
function selectLane(el, i, focus = false) {
  ui.laneSel = i === null ? null : { id: el.id, i };
  const strip = props.querySelector('.lanestrip');
  if (strip) strip.innerHTML = laneStripHtml(el);
  const card = $('lanecard');
  if (card) { card.innerHTML = laneCardHtml(el); wireLaneCard(el); }
  if (focus && i !== null) props.querySelector(`.lb[data-i="${i}"]`)?.focus();
  render();
}

// Redraw the strip and totals after a width change, without rebuilding the panel.
function updateLaneStrip(el) {
  const strip = props.querySelector('.lanestrip');
  if (strip) strip.innerHTML = laneStripHtml(el);
  const tot = props.querySelector('.lanetotal');
  if (tot) tot.innerHTML = laneTotalsHtml(el);
  liveUpdate(el);
}

// Change the lane list, then rebuild the panel keeping the chosen lane (and focus) in view.
function editLanes(el, fn, { focusLane = false } = {}) {
  checkpoint();
  const next = fn(el.p.lanes);
  ui.lastLanes = structuredClone(el.p.lanes);
  if (next !== undefined) ui.laneSel = next === null ? null : { id: el.id, i: next };
  refresh();
  if (focusLane && ui.laneSel) props.querySelector(`.lb[data-i="${ui.laneSel.i}"]`)?.focus();
}

function wireLaneCard(el) {
  const card = $('lanecard');
  const i = laneSelIn(el);
  if (!card || i === null) return;
  const lane = el.p.lanes[i];
  card.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('focus', checkpoint, { once: true });
  });
  card.querySelector('[data-lf="type"]').addEventListener('change', (e) => {
    const T = LANE_TYPES[e.target.value];
    // On a road joined to another, keep the width so the pieces still line up.
    const keep = joinedToRoad(el);
    const j = partner(el, i);
    Object.assign(lane, { type: e.target.value, w: keep ? lane.w : T.def, w2: keep ? lane.w2 : null, dir: T.dir ? lane.dir || 'fwd' : null });
    if (j !== null) Object.assign(el.p.lanes[j], { type: lane.type, w: lane.w, w2: lane.w2, dir: flipDir(lane.dir) });
    ui.lastLanes = structuredClone(el.p.lanes);
    refresh();
  });
  card.querySelectorAll('input[data-lf]').forEach((input) => input.addEventListener('input', () => {
    const f = input.dataset.lf;
    if (f === 'w2' && input.value.trim() === '') lane.w2 = null;
    else {
      const v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      lane[f] = clamp(fromDisp(v), 0, 30);
    }
    const j = partner(el, i);
    if (j !== null) el.p.lanes[j][f] = lane[f];
    ui.lastLanes = structuredClone(el.p.lanes);
    updateLaneStrip(el);
  }));
  card.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => {
    const j = partner(el, i);
    editLanes(el, (L) => { lane.dir = b.dataset.dir; if (j !== null) L[j].dir = flipDir(lane.dir); });
  }));
  card.querySelectorAll('[data-lact]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.lact;
    const p = partner(el, i);
    editLanes(el, (L) => {
      if (a === 'del') {
        [i, p].filter((k) => k !== null).sort((x, y) => y - x).forEach((k) => L.splice(k, 1));
        return L.length ? Math.min(p !== null && p < i ? i - 1 : i, L.length - 1) : null;
      }
      if (a === 'dup') {
        if (p === null) { L.splice(i + 1, 0, structuredClone(lane)); return i + 1; }
        const twin = { ...structuredClone(lane), dir: flipDir(lane.dir) };
        if (i < p) { L.splice(p, 0, twin); L.splice(i + 1, 0, structuredClone(lane)); return i + 1; }
        L.splice(i + 1, 0, structuredClone(lane)); L.splice(p, 0, twin); return i + 2;
      }
      const j = a === 'left' ? i - 1 : i + 1;
      [L[i], L[j]] = [L[j], L[i]];
      // the twin moves the opposite way, unless the two swaps would undo each other
      if (p !== null) {
        const q = a === 'left' ? p + 1 : p - 1;
        if (q >= 0 && q < L.length && ![i, j].includes(p) && ![i, j].includes(q)) [L[p], L[q]] = [L[q], L[p]];
      }
      return j;
    });
  }));
}

function wireLanes(el) {
  const strip = props.querySelector('.lanestrip');
  if (!strip) return;
  wireLaneCard(el);

  strip.addEventListener('pointerdown', (e) => {
    const block = e.target.closest('.lb');
    if (!block || e.button !== 0) return;
    e.preventDefault();
    const i = +block.dataset.i, grip = e.target.closest('[data-grip]');
    const x0 = e.clientX;
    strip.setPointerCapture(e.pointerId);
    const L = el.p.lanes;
    let onMove, onUp;
    if (grip) {
      // resize: trade width with the right-hand neighbor so the overall width stays put
      const { at } = laneEditing(el);
      const a = L[i];
      const wa0 = laneWidth(a, at);
      const w0s = L.map((l) => laneWidth(l, at));
      const pxPerM = strip.getBoundingClientRect().width / Math.max(1, L.reduce((sum, l) => sum + laneWidth(l, at), 0));
      const step = project.units === 'ft' ? 0.5 / M2FT : 0.1;
      let moved = false;
      checkpoint();
      strip.classList.add('resizing');
      onMove = (ev) => {
        if (Math.abs(ev.clientX - x0) > 2) moved = true;
        if (!moved) return;
        let delta = Math.round((wa0 + (ev.clientX - x0) / pxPerM) / step) * step - wa0;
        // which lanes change, and by how many times delta (mirror mode also moves the other side)
        const coef = new Map(), add = (k, c) => coef.set(k, (coef.get(k) || 0) + c);
        const am = partner(el, i), bm = mirroring(el) ? L.length - 2 - i : null;
        add(i, 1);
        if (am !== null) add(am, 1);
        if (!ev.shiftKey) {
          if (i + 1 !== am) add(i + 1, -1);
          if (bm !== null && bm !== i) add(bm, -1);
        }
        // no lane narrower than zero
        for (const [k, c] of coef) {
          const w0 = w0s[k];
          if (c > 0) delta = Math.max(delta, -w0 / c); else if (c < 0) delta = Math.min(delta, w0 / -c);
        }
        for (const [k, c] of coef) setLaneWidth(el, L[k], w0s[k] + c * delta);
        ui.lastLanes = structuredClone(L);
        updateLaneStrip(el);
      };
      onUp = () => {
        strip.classList.remove('resizing');
        if (!moved) undoStack.pop();
        refresh();
      };
    } else {
      // reorder by dragging, or pick the lane with a click
      const blocks = [...strip.querySelectorAll('.lb')];
      const rects = blocks.map((bk) => bk.getBoundingClientRect());
      const sRect = strip.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.className = 'lanemark';
      let dragging = false, target = i;
      onMove = (ev) => {
        const dx = ev.clientX - x0;
        if (!dragging && Math.abs(dx) < 5) return;
        if (!dragging) { dragging = true; block.classList.add('dragging'); strip.appendChild(mark); }
        block.style.transform = `translateX(${dx}px)`;
        const others = rects.filter((_, k) => k !== i);
        target = others.filter((r) => r.left + r.width / 2 < ev.clientX).length;
        const edge = target < others.length ? others[target].left : others[others.length - 1].right;
        mark.style.left = `${edge - sRect.left - 2}px`;
      };
      onUp = () => {
        if (!dragging) { selectLane(el, laneSelIn(el) === i ? null : i, true); return; }
        mark.remove();
        if (target === i) { block.style.transform = ''; block.classList.remove('dragging'); return; }
        editLanes(el, (Ls) => { const [lane] = Ls.splice(i, 1); Ls.splice(target, 0, lane); return target; });
      };
    }
    const up = () => {
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', up);
      strip.removeEventListener('pointercancel', up);
      onUp();
    };
    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', up);
    strip.addEventListener('pointercancel', up);
  });
  strip.addEventListener('pointerover', (e) => {
    const block = e.target.closest('.lb');
    const i = block ? +block.dataset.i : null;
    if (i !== ui.laneHover) { ui.laneHover = i; render(); }
  });
  strip.addEventListener('pointerleave', () => { ui.laneHover = null; render(); });
  strip.addEventListener('keydown', (e) => {
    const block = e.target.closest('.lb');
    if (!block) return;
    const i = +block.dataset.i, L = el.p.lanes;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      handled();
      const j = clamp(i + (e.key === 'ArrowLeft' ? -1 : 1), 0, L.length - 1);
      if (e.altKey) { if (j !== i) editLanes(el, (Ls) => { [Ls[i], Ls[j]] = [Ls[j], Ls[i]]; return j; }, { focusLane: true }); } else selectLane(el, j, true);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      editLanes(el, (Ls) => { Ls.splice(i, 1); return Ls.length ? Math.min(i, Ls.length - 1) : null; }, { focusLane: true });
    } else if (e.key === 'Escape' && laneSelIn(el) !== null) {
      handled();
      selectLane(el, null);
    }
  });

  props.querySelectorAll('[data-laneend]').forEach((b) => b.addEventListener('click', () => {
    ui.laneEnd = +b.dataset.laneend;
    renderProps();
  }));
  props.querySelector('[data-taper]').addEventListener('change', (e) => {
    if (e.target.checked) {
      ui.taperEdit = el.id;
      ui.laneEnd = 1;
      renderProps();
      toast('Now showing the end of the road. Widths you change here taper from the start.');
    } else {
      ui.taperEdit = null;
      ui.laneEnd = 0;
      editLanes(el, (L) => { L.forEach((l) => { l.w2 = null; }); });
    }
  });
  props.querySelector('[data-mirror]').addEventListener('click', () => {
    ui.mirror = !ui.mirror;
    renderProps();
  });
  props.querySelector('[data-lanecopy]').addEventListener('click', () => {
    ui.laneClip = structuredClone(el.p.lanes);
    renderProps();
    toast('Lanes copied. Select another road and press Paste.');
  });
  props.querySelector('[data-lanepaste]').addEventListener('click', () => {
    if (!ui.laneClip) return;
    editLanes(el, () => { el.p.lanes = structuredClone(ui.laneClip); return null; });
    toast('Lanes pasted.', { undoable: true });
  });
  props.querySelector('[data-addlane]').addEventListener('change', (e) => {
    const type = e.target.value;
    if (!type) return;
    const T = LANE_TYPES[type];
    editLanes(el, (L) => {
      const sel = laneSelIn(el);
      const lane = (dir) => ({ type, w: T.def, w2: null, dir: T.dir ? dir : null });
      const p = sel !== null ? partner(el, sel) : null;
      if (p !== null) {
        // add a matching pair, one on each side
        const [lo, hi] = sel < p ? [sel, p] : [p, sel];
        L.splice(hi, 0, lane('fwd'));
        L.splice(lo + 1, 0, lane('back'));
        return sel < p ? sel + 1 : sel + 2;
      }
      const at = sel !== null ? sel + 1 : Math.ceil(L.length / 2);
      L.splice(at, 0, lane('fwd'));
      return at;
    });
  });
  props.querySelector('[data-preset]').addEventListener('change', (e) => {
    if (!e.target.value) return;
    editLanes(el, () => { el.p.lanes = structuredClone(PRESETS[e.target.value]); return null; });
  });
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

// How the lanes at one end of a road compare with the road it continues. Null if it doesn't continue one.
function jointMismatch(el, end) {
  const l = el.p.links?.[end];
  const target = l && getEl(l.id);
  if (target?.type !== 'segment' || l.key === 'side') return null;
  const theirs = lanesAtJoint(target, l.key, end);
  const t = end === 'start' ? 0 : 1;
  const { ws } = laneLayout(el.p.lanes, t);
  const ok = theirs.length === ws.length && theirs.every((x, i) => x.type === el.p.lanes[i].type && Math.abs(x.w - ws[i]) < 0.03);
  return ok ? null : { mine: roadWidth(el.p.lanes, t), theirs: roadWidth(theirs, 0), sameTypes: theirs.length === ws.length && theirs.every((x, i) => x.type === el.p.lanes[i].type) };
}

function linksHtml(el) {
  if (el.type !== 'segment') return '';
  const label = (o) => esc(nameOf(o));
  const rows = ['start', 'end'].map((end) => {
    const l = el.p.links?.[end];
    const target = l && getEl(l.id);
    if (!target) return '';
    const what = l.key.startsWith('leg') ? `${TYPES[target.type].label.toLowerCase()} leg ${+l.key.slice(3) + 1}`
      : l.key === 'side' ? `the side of ${label(target)}`
        : TYPES[target.type].lanes ? `${label(target)} (its ${l.key})` : TYPES[target.type].label.toLowerCase();
    const End = end === 'start' ? 'Start' : 'End';
    const bad = jointMismatch(el, end);
    const fix = bad ? `<div class="linkfix" data-hl="${target.id}">
        <span>⚠ The ${end} of this road is ${fmt(bad.mine)} curb to curb, but the road it continues is ${fmt(bad.theirs)}${bad.sameTypes ? '' : ' and has different lanes'}. The ${end} is marked on the map.</span>
        <button data-match="${end}" title="Change the lanes at this end to match the other road">Match lanes</button></div>` : '';
    return `<div class="linkrow" data-hl="${target.id}"><span><strong>${End}</strong> meets ${what}</span>
      <span class="linkbtns"><button data-show="${target.id}" title="Select that road">Show</button><button data-unlink="${end}">Disconnect</button></span></div>${fix}`;
  }).join('');
  // roads that attach to this one
  const joined = els().filter((o) => o.type === 'segment' && o.id !== el.id && ['start', 'end'].some((e) => o.p.links?.[e]?.id === el.id));
  const joinedRows = joined.map((o) => {
    const e = ['start', 'end'].find((x) => o.p.links?.[x]?.id === el.id);
    const how = o.p.links[e].key === 'side' ? 'joins its side' : `continues from its ${o.p.links[e].key}`;
    return `<div class="linkrow" data-hl="${o.id}"><span>${label(o)} ${how}</span><span class="linkbtns"><button data-show="${o.id}" title="Select that road">Show</button></span></div>`;
  }).join('');
  if (!rows && !joinedRows) return '';
  return `<h3>Connections</h3>${rows}${joinedRows ? `<div class="muted small linksub">Roads attached to this one</div>${joinedRows}` : ''}`;
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
      ${el.type === 'segment' ? `<button data-act="split" title="Split road (X): cut it into pieces with their own lanes" aria-label="Split road">${ACT_ICONS.split}</button>` : ''}
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
  if (t.lanes) {
    h += `${lanesHtml(el)}<h3>Shape</h3>
      <div class="row"><button data-smoothroad title="Even out wobbles and use fewer points. Press again to smooth more.">Smooth curve</button></div>
      <p class="muted small">${el.pts.length} points. Hold Ctrl (⌘ on Mac) and drag the road to add a bend; Alt+click a point to remove it.</p>
      <h3>Options</h3>`;
  }
  h += t.params.filter((d) => !d.when || d.when(el.p)).map((d) => paramHtml(d, el.p[d.k])).join('');
  if (t.legs) h += legsHtml(el);
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

  if (t.lanes) wireLanes(el);
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
    // roads attached to this one's side stay put
    for (const o of els()) {
      for (const end of ['start', 'end']) {
        const l = o.p.links?.[end];
        if (l?.id === el.id && l.key === 'side') o.p.links[end] = { ...l, s: 1 - l.s, side: -l.side };
      }
    }
    refresh();
  };
  props.querySelectorAll('[data-xsdl]').forEach((b) => b.addEventListener('click', () => {
    const t0 = +b.dataset.xsdl;
    const { svg } = crossSectionSvg(el.p.lanes, t0, fmt, { pxPerM: 30, title: t0 ? 'End of road' : 'Start of road' });
    download(svg, `cross-section-${t0 ? 'end' : 'start'}.svg`, 'image/svg+xml');
  }));
  const smoothBtn = props.querySelector('[data-smoothroad]');
  if (smoothBtn) smoothBtn.onclick = () => smoothRoad(el);
  props.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
    ui.selectedId = b.dataset.show;
    ui.hoverId = null;
    render();
    renderProps();
  }));
  props.querySelectorAll('[data-hl]').forEach((row) => {
    row.addEventListener('pointerenter', () => { ui.hoverId = row.dataset.hl; render(); });
    row.addEventListener('pointerleave', () => { ui.hoverId = null; render(); });
  });
  props.querySelectorAll('[data-match]').forEach((b) => b.addEventListener('click', () => {
    const end = b.dataset.match, l = el.p.links[end];
    const theirs = lanesAtJoint(getEl(l.id), l.key, end);
    checkpoint();
    const L = el.p.lanes;
    if (theirs.length === L.length && theirs.every((x, i) => x.type === L[i].type)) {
      // same lanes, different widths: change this end only, so the far end still lines up
      L.forEach((lane, i) => {
        if (end === 'start') { lane.w2 = lane.w2 ?? lane.w; lane.w = theirs[i].w; } else lane.w2 = theirs[i].w;
        if (lane.w2 !== null && Math.abs(lane.w2 - lane.w) < 0.005) lane.w2 = null;
      });
    } else el.p.lanes = theirs;
    refresh();
    toast('Lanes now match the connected road.', { undoable: true });
  }));
  props.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', () => {
    checkpoint();
    delete el.p.links[b.dataset.unlink];
    refresh();
  }));

  props.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'split') setSplitting(true);
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
       <div class="row"><button id="qtyCopy">Copy as table</button></div>
       <p class="muted small">Placeholder prices for a first-pass estimate; edit them for your area. Excludes drainage, utilities, signals and design fees. "Copy as table" pastes into a spreadsheet or doc.</p>`
    : '<p class="muted small">Quantities appear here as you draw.</p>';
  const copyBtn = $('qtyCopy');
  if (copyBtn) copyBtn.onclick = async () => {
    // tab-separated, so it pastes into spreadsheets as cells
    const lines = [...$('qtySec').querySelectorAll('table.qty tr')].map((tr) => [...tr.children].map((td) => {
      const input = td.querySelector('input');
      return (input ? input.value : td.textContent).trim();
    }).join('\t'));
    lines[0] = ['Item', ...lines[0].split('\t').slice(1)].join('\t');
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Quantities copied. Paste into a spreadsheet or document.');
    } catch { toast('Clipboard blocked by the browser.'); }
  };
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
    download(JSON.stringify(project), `${fileStem()}.json`, 'application/json');
    toast('Project file saved to your downloads. Use Open to load it again.');
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
      toast("That file isn't a Left Of Way project.");
    }
  });
}

// ---------- export ----------
// Notes, measurements and turning paths export in their own group so they're easy to hide in Figma.
const ANNOTATIONS = new Set(['note', 'dimension', 'vehicle']);
const fileStem = () => {
  const name = project.variants[project.current].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `left-of-way-${name || 'option'}-${new Date().toLocaleDateString('en-CA')}`;
};
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
  const layer = (el) => {
    let name = nameOf(el);
    const c = (counts.get(name) || 0) + 1;
    counts.set(name, c);
    if (c > 1) name += ` (${c})`;
    return markup(el, { interactive: false, layerName: name });
  };
  const body = els().filter((el) => !ANNOTATIONS.has(el.type)).map(layer).join('\n');
  const notes = els().filter((el) => ANNOTATIONS.has(el.type)).map(layer).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${bg}
${backdropMarkup(false)}
<g id="${esc(project.variants[project.current].name)}">
${body}
</g>
${notes ? `<g id="Annotations">\n${notes}\n</g>` : ''}
${scaleBar(W, H)}
${credit ? `<text id="Attribution" x="${W - 8}" y="${H - 8}" fill="#fff" fill-opacity="0.85" font-family="Inter, sans-serif" font-size="11" text-anchor="end">${esc(credit)}</text>` : ''}
</svg>`;
}

async function runExport(action) {
  const status = $('status');
  if (map.getZoom() < 15) { status.textContent = 'Zoom in further before exporting (street level).'; toast(status.textContent); return; }
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
      download(svg, `${fileStem()}.svg`, 'image/svg+xml');
      status.textContent = `Downloaded (${mb} MB). Drag the file into Figma.`;
    }
    toast(status.textContent);
  } catch (err) {
    status.textContent = action === 'copy' && err.name === 'NotAllowedError'
      ? 'Clipboard blocked by the browser. Use Download instead.'
      : `Export failed: ${err.message}`;
    toast(status.textContent);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// ---------- keyboard ----------
// Bend-point handles only show while Ctrl (⌘) is held, so dragging a line doesn't add points by accident.
const setCtrl = (on) => { if (ui.ctrlHeld !== on) { ui.ctrlHeld = on; if (getEl(ui.selectedId)?.pts) render(); } };
document.addEventListener('keydown', (e) => { if (e.key === 'Control' || e.key === 'Meta') setCtrl(true); });
document.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Meta') setCtrl(false); });
window.addEventListener('blur', () => setCtrl(false));
// With something selected, arrow keys nudge it instead of panning the map (Leaflet listens on the map itself).
document.addEventListener('keydown', (e) => {
  if (!e.key.startsWith('Arrow') || !getEl(ui.selectedId) || e.ctrlKey || e.metaKey) return;
  if (e.target.matches('input:not([type=checkbox]), select, textarea') || e.target.closest?.('.lanestrip')) return;
  e.stopPropagation();
  e.preventDefault();
  nudge(e);
}, true);

// Move the selection by 1 screen pixel, or 10 with Shift.
function nudge(e) {
  const el = getEl(ui.selectedId), step = e.shiftKey ? 10 : 1;
  const dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0, dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
  if (!e.repeat) checkpoint();
  const shift = (lat, lng) => { const [x, y] = toPx(lat, lng); return fromPx(x + dx, y + dy); };
  if (el.pts) {
    el.pts = el.pts.map((q) => shift(q[0], q[1]));
    if (el.p.links) el.p.links = {};
  } else [el.lat, el.lng] = shift(el.lat, el.lng);
  render(); save();
}
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
  if (ui.extend) {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finishExtend(); return; }
    if (e.key === 'Backspace' && ui.extend.added) {
      const el = getEl(ui.extend.id);
      if (ui.extend.end === 'end') el.pts.pop(); else el.pts.shift();
      ui.extend.added--;
      render();
      return;
    }
  }
  if (ui.draft) {
    if (e.key === 'Enter') { e.preventDefault(); finishDraft(); return; }
    if (e.key === 'Escape') { ui.draft = null; render(); return; }
    if (e.key === 'Backspace') { ui.draft.pts.pop(); if (!ui.draft.pts.length) ui.draft = null; render(); return; }
  }
  if (e.key === 'Escape' && ui.splitting) { setSplitting(false); return; }
  if (k === 'x') { setSplitting(!ui.splitting); return; }
  if (e.key === 'Escape') {
    if (ui.tool === 'select' && !ui.calibrate && !ui.adjustBackdrop && ui.selectedId) {
      ui.selectedId = null; render(); renderProps(); return;
    }
    ui.calibrate = null;
    if (ui.adjustBackdrop) { ui.adjustBackdrop = false; overlay.classList.remove('adjusting'); renderImagery(); }
    setTool('select');
    return;
  }
  if (k === 'v') { setTool('select'); return; }
  if (e.key === '\\') { togglePanel(); return; }
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
function togglePanel(show = document.body.classList.contains('no-panel')) {
  document.body.classList.toggle('no-panel', !show);
  $('panelToggle').setAttribute('aria-pressed', show);
  map.invalidateSize();
  render();
  try { localStorage.setItem('road-drafter-panel', show ? '1' : '0'); } catch { /* ignore */ }
}
$('panelToggle').onclick = () => togglePanel();
try { if (localStorage.getItem('road-drafter-panel') === '0') togglePanel(false); } catch { /* ignore */ }
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
