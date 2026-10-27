// Elements drawn by clicking several points: road segments, patches,
// dimensions and vehicle turning paths. They draw in screen pixels.
import {
  n, samplePath, normals, offsetPts, frameAt, pathD, polygonArea, llToMeters,
  vecBearing, bearingVec, polylineLength,
} from '../geo.js';
import { COLORS as C } from './common.js';

// ---------- road segment ----------

// Defaults are round US numbers (feet), stored in meters.
const F = (ft) => ft / 3.28084;

export const LANE_TYPES = {
  sidewalk: { label: 'Sidewalk', def: F(6), off: true, fill: C.concrete },
  planting: { label: 'Planting strip', def: F(5), off: true, fill: C.green },
  parking: { label: 'Parking', def: F(8), fill: C.asphalt },
  bike: { label: 'Bike lane', def: F(6), fill: C.bike, dir: true },
  buffer: { label: 'Painted buffer', def: F(3), fill: C.asphalt, hatch: true },
  posts: { label: 'Buffer + flex posts', def: F(3), fill: C.asphalt, hatch: true, posts: true },
  separator: { label: 'Curb separator', def: F(2), raised: true, fill: C.concrete },
  travel: { label: 'Travel lane', def: F(11), fill: C.asphalt, dir: true },
  turn: { label: 'Turn lane', def: F(10), fill: C.asphalt, dir: true },
  center: { label: 'Two-way turn lane', def: F(11), fill: C.asphalt },
  bus: { label: 'Bus lane', def: F(11), fill: C.bus, dir: true },
  median: { label: 'Median', def: F(10), raised: true, fill: C.green },
};

const L = (type, w, dir, w2) => ({ type, w, w2: w2 ?? null, dir: dir ?? null });
export const PRESETS = {
  'Two-lane street with parking': [L('sidewalk', F(6)), L('planting', F(5)), L('parking', F(8)), L('travel', F(11), 'back'), L('travel', F(11), 'fwd'), L('parking', F(8)), L('planting', F(5)), L('sidewalk', F(6))],
  'Two-lane with bike lanes': [L('sidewalk', F(6)), L('bike', F(6), 'back'), L('travel', F(11), 'back'), L('travel', F(11), 'fwd'), L('bike', F(6), 'fwd'), L('sidewalk', F(6))],
  'Protected bike lanes': [L('sidewalk', F(6)), L('bike', F(6), 'back'), L('posts', F(3)), L('travel', F(10), 'back'), L('travel', F(10), 'fwd'), L('posts', F(3)), L('bike', F(6), 'fwd'), L('sidewalk', F(6))],
  'Center turn lane + bike lanes': [L('sidewalk', F(6)), L('bike', F(6), 'back'), L('travel', F(11), 'back'), L('center', F(11)), L('travel', F(11), 'fwd'), L('bike', F(6), 'fwd'), L('sidewalk', F(6))],
  'Turn lane ends, median begins': [L('sidewalk', F(6)), L('bike', F(6), 'back'), L('travel', F(11), 'back'), L('turn', F(10), 'back', 0), L('median', 0, null, F(10)), L('travel', F(11), 'fwd'), L('bike', F(6), 'fwd'), L('sidewalk', F(6))],
  'Boulevard with median': [L('sidewalk', F(8)), L('planting', F(5)), L('travel', F(11), 'back'), L('travel', F(11), 'back'), L('median', F(14)), L('travel', F(11), 'fwd'), L('travel', F(11), 'fwd'), L('planting', F(5)), L('sidewalk', F(8))],
  'One-way with bike lane': [L('sidewalk', F(6)), L('parking', F(8)), L('travel', F(11), 'fwd'), L('buffer', F(3)), L('bike', F(6), 'fwd'), L('sidewalk', F(6))],
};

const laneW = (lane, t) => Math.max(0, lane.w + ((lane.w2 ?? lane.w) - lane.w) * t);
const isMoving = (l) => ['travel', 'turn', 'bus', 'center'].includes(l.type);

/** Boundary offsets (meters from the centerline, + = right) at fraction t along the road. */
export function laneLayout(lanes, t) {
  const ws = lanes.map((l) => laneW(l, t));
  let leftOff = 0;
  for (let i = 0; i < lanes.length && LANE_TYPES[lanes[i].type].off; i++) leftOff += ws[i];
  const road = ws.reduce((sum, w, i) => sum + (LANE_TYPES[lanes[i].type].off ? 0 : w), 0);
  const bounds = [-road / 2 - leftOff];
  ws.forEach((w) => bounds.push(bounds[bounds.length - 1] + w));
  return { ws, bounds, road };
}

/** Curb-to-curb width at the start (t = 0) or end (t = 1). */
export const roadWidth = (lanes, t) => laneLayout(lanes, t).road;

function separator(a, b) {
  const A = LANE_TYPES[a.type], B = LANE_TYPES[b.type];
  if (A.off && B.off) return 'none';
  if (A.off !== B.off || A.raised || B.raised) return 'curb';
  if (isMoving(a) && isMoving(b)) {
    if (a.type === 'center') return 'centerLeft';
    if (b.type === 'center') return 'centerRight';
    if (a.dir !== b.dir) return 'yellowDouble';
    if (a.type === 'turn' || b.type === 'turn' || a.type === 'bus' || b.type === 'bus') return 'white';
    return 'whiteDash';
  }
  if (a.type === 'parking' && b.type === 'parking') return 'none';
  return 'white';
}

function lineSvg(pts, color, width, dash) {
  return `<path d="${pathD(pts)}" fill="none" stroke="${color}" stroke-width="${n(width)}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

const segment = {
  kind: 'path', label: 'Road segment', group: 'Streets', key: 's', minPts: 2,
  hint: 'Click along the street centerline; double-click or Enter to finish. Start or end on an orange dot to connect.',
  help: 'Drag an end onto an orange dot to connect it. Drag the small dots to add bends. The arrow shows which way is "forward" for the lane list.',
  params: [
    { k: 'smooth', label: 'Smooth curves', type: 'bool', def: true },
    { k: 'xwStart', label: 'Crosswalk at start', type: 'bool', def: false },
    { k: 'xwEnd', label: 'Crosswalk at end', type: 'bool', def: false },
    { k: 'xwWidth', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6, when: (p) => p.xwStart || p.xwEnd },
    { k: 'xwSetback', label: 'Crosswalk setback from end', type: 'len', def: F(4), min: 0, max: 15, when: (p) => p.xwStart || p.xwEnd },
  ],
  lanes: true,
  defaults: () => ({ lanes: structuredClone(PRESETS['Two-lane with bike lanes']), links: {} }),
  name: (el, f) => `Road ${f(roadWidth(el.p.lanes, 0))} curb to curb`,

  ports(el) {
    const pts = el.pts;
    if (pts.length < 2) return [];
    const out = (a, b) => { const [x, y] = llToMeters(b[0], b[1], a[0], a[1]); return vecBearing(x, y); };
    return [
      { key: 'start', ll: pts[0], bearing: out(pts[0], pts[1]), width: roadWidth(el.p.lanes, 0) },
      { key: 'end', ll: pts[pts.length - 1], bearing: out(pts[pts.length - 1], pts[pts.length - 2]), width: roadWidth(el.p.lanes, 1) },
    ];
  },

  draw(el, ctx) {
    const { s } = ctx;
    const lanes = el.p.lanes;
    if (!lanes.length || el.pts.length < 2) return '';
    const px = el.pts.map((p) => ctx.toPx(p[0], p[1]));
    const sm = samplePath(px, { smooth: el.p.smooth, step: 4, startDir: ctx.dirs.start, endDir: ctx.dirs.end });
    if (sm.length < 2) return '';
    const total = sm[sm.length - 1].s;
    const norms = normals(sm);
    const layouts = sm.map((p) => laneLayout(lanes, p.s / total));
    const boundary = (k) => offsetPts(sm, norms, layouts.map((lay) => lay.bounds[k] * s));
    const B = lanes.map((_, k) => boundary(k)).concat([boundary(lanes.length)]);
    const at = (dist, off) => { const f = frameAt(sm, dist); return [f.x + f.nx * off, f.y + f.ny * off]; };
    const layoutAt = (dist) => laneLayout(lanes, Math.max(0, Math.min(1, dist / total)));

    let fills = '', marks = '', curbs = '';
    lanes.forEach((lane, i) => {
      const T = LANE_TYPES[lane.type];
      if (Math.max(lane.w, lane.w2 ?? lane.w) < 0.05) return;
      const poly = B[i].concat(B[i + 1].slice().reverse());
      fills += `<path d="${pathD(poly, true)}" fill="${T.fill}"/>`;
      if (T.hatch) {
        // diagonal buffer hatching every 3 m
        for (let d = 1.5 * s; d < total - 1.5 * s; d += 3 * s) {
          const lay = layoutAt(d), lay2 = layoutAt(d + 1.2 * s);
          if (lay.ws[i] < 0.3) continue;
          const a = at(d, (lay.bounds[i] + 0.1) * s), b = at(d + 1.2 * s, (lay2.bounds[i + 1] - 0.1) * s);
          marks += lineSvg([a, b], C.paint, 0.15 * s);
        }
      }
      if (T.posts) {
        for (let d = 2 * s; d < total - 1 * s; d += 4 * s) {
          const lay = layoutAt(d);
          const c = at(d, ((lay.bounds[i] + lay.bounds[i + 1]) / 2) * s);
          marks += `<circle cx="${n(c[0])}" cy="${n(c[1])}" r="${n(0.14 * s)}" fill="${C.paint}" stroke="#d94f3d" stroke-width="${n(0.05 * s)}"/>`;
        }
      }
    });

    // Lines between lanes, plus curbs on the outer roadway edges.
    const dash = `${n(3 * s)} ${n(9 * s)}`;
    for (let k = 0; k <= lanes.length; k++) {
      const a = lanes[k - 1], b = lanes[k];
      let style;
      if (!a) style = LANE_TYPES[b.type].off ? 'none' : 'curb';
      else if (!b) style = LANE_TYPES[a.type].off ? 'none' : 'curb';
      else style = separator(a, b);
      const pts = B[k];
      const shifted = (m) => offsetPts(sm, norms, layouts.map((lay) => (lay.bounds[k] + m) * s));
      if (style === 'curb') curbs += lineSvg(pts, C.curb, 0.3 * s);
      else if (style === 'white') marks += lineSvg(pts, C.paint, 0.15 * s);
      else if (style === 'whiteDash') marks += lineSvg(pts, C.paint, 0.15 * s, dash);
      else if (style === 'yellowDouble') marks += lineSvg(shifted(-0.15), C.yellow, 0.12 * s) + lineSvg(shifted(0.15), C.yellow, 0.12 * s);
      else if (style === 'centerLeft') marks += lineSvg(shifted(-0.15), C.yellow, 0.12 * s) + lineSvg(shifted(0.15), C.yellow, 0.12 * s, dash);
      else if (style === 'centerRight') marks += lineSvg(shifted(-0.15), C.yellow, 0.12 * s, dash) + lineSvg(shifted(0.15), C.yellow, 0.12 * s);
    }

    // Crosswalks at the ends, across the roadway, with gaps at raised medians.
    const crosswalkAt = (d) => {
      const f = frameAt(sm, d), lay = layoutAt(d);
      const raisedRanges = [];
      let roadL = null, roadR = null;
      lanes.forEach((l, i) => {
        const T = LANE_TYPES[l.type];
        if (T.off) return;
        if (roadL === null) roadL = lay.bounds[i];
        roadR = lay.bounds[i + 1];
        if (T.raised && lay.ws[i] > 0.05) raisedRanges.push([lay.bounds[i], lay.bounds[i + 1]]);
      });
      if (roadL === null) return '';
      const cw = el.p.xwWidth, bar = 0.6, gap = 0.6;
      const span = roadR - roadL - 0.4;
      const count = Math.max(1, Math.floor((span + gap) / (bar + gap)));
      const start = roadL + 0.2 + (span - (count * bar + (count - 1) * gap)) / 2;
      let out = '';
      for (let i = 0; i < count; i++) {
        const u0 = start + i * (bar + gap), u1 = u0 + bar;
        if (raisedRanges.some(([a, b]) => u1 > a - 0.1 && u0 < b + 0.1)) continue;
        const corner = (u, v) => [f.x + f.nx * u * s + f.tx * v * s, f.y + f.ny * u * s + f.ty * v * s];
        out += `<path d="${pathD([corner(u0, -cw / 2), corner(u1, -cw / 2), corner(u1, cw / 2), corner(u0, cw / 2)], true)}" fill="${C.paint}"/>`;
      }
      return out;
    };
    const off = (el.p.xwSetback + el.p.xwWidth / 2) * s;
    if (el.p.xwStart && total > off * 2) marks += crosswalkAt(off);
    if (el.p.xwEnd && total > off * 2) marks += crosswalkAt(total - off);

    const hit = `<path d="${pathD(sm.map((p) => [p.x, p.y]))}" fill="none" stroke="#000" stroke-opacity="0.001" stroke-width="16" data-hit="1"/>`;
    return `<g id="Lanes">${fills}</g><g id="Markings">${marks}</g><g id="Curbs">${curbs}</g>${hit}`;
  },

  warnings(el, f) {
    const w = new Set();
    for (const l of el.p.lanes) {
      const wide = Math.max(l.w, l.w2 ?? l.w);
      if (wide < 0.05) continue;
      if (l.type === 'travel' && wide < 3.0) w.add(`Travel lanes under ${f(3)} are tight for trucks and buses.`);
      if (l.type === 'travel' && wide > 3.66) w.add(`Travel lanes over ${f(3.66)} encourage speeding. NACTO recommends ${f(3)}–${f(3.3)} on city streets.`);
      if (l.type === 'bike' && wide < 1.5) w.add(`Bike lanes under ${f(1.5)} are below most guidelines.`);
      if (l.type === 'sidewalk' && wide < 1.5) w.add(`Sidewalks under ${f(1.5)} don't let two people pass (ADA minimum clear width is ${f(1.2)}).`);
      if (l.type === 'parking' && wide < 2.1) w.add(`Parking lanes are usually at least ${f(2.1)}.`);
      if (l.type === 'bus' && wide < 3.3) w.add(`Bus lanes are usually ${f(3.3)}–${f(3.7)}.`);
      if (l.type === 'median' && wide < 1.8 && (el.p.xwStart || el.p.xwEnd)) w.add(`A median under ${f(1.8)} is too narrow to be a pedestrian refuge.`);
    }
    const lanes = el.p.lanes;
    for (let i = 0; i < lanes.length - 1; i++) {
      if (lanes[i].type === 'bike' && lanes[i + 1].type === 'parking' || lanes[i].type === 'parking' && lanes[i + 1].type === 'bike') {
        w.add('Bike lane right next to parking puts riders in the door zone. Consider a buffer.');
      }
    }
    return [...w];
  },

  qty(el) {
    const [lat0, lng0] = el.pts[0];
    const m = el.pts.map((p) => llToMeters(lat0, lng0, p[0], p[1]));
    const sm = samplePath(m, { smooth: el.p.smooth, step: 1 });
    const len = sm.length ? sm[sm.length - 1].s : 0;
    const q = { asphalt: 0, concrete: 0, green: 0, paint: 0 };
    el.p.lanes.forEach((l) => {
      const area = ((l.w + (l.w2 ?? l.w)) / 2) * len;
      const T = LANE_TYPES[l.type];
      if (l.type === 'sidewalk' || l.type === 'separator') q.concrete += area;
      else if (l.type === 'planting' || l.type === 'median') q.green += area;
      else q.asphalt += area;
      if (l.type === 'bike' || l.type === 'bus') q.paint += area;
      if (T.hatch) q.paint += area * 0.15;
    });
    q.paint += (el.p.lanes.length - 1) * len * 0.15 * 0.5;
    const road = roadWidth(el.p.lanes, 0);
    q.paint += ((el.p.xwStart ? 1 : 0) + (el.p.xwEnd ? 1 : 0)) * road * 0.5 * el.p.xwWidth;
    return q;
  },
};

/** Cross-section diagram of a road segment at fraction t (0 = start, 1 = end). */
const SHORT = {
  sidewalk: 'Sidewalk', planting: 'Planting', parking: 'Parking', bike: 'Bike', buffer: 'Buffer', posts: 'Posts',
  separator: 'Curb', travel: 'Travel', turn: 'Turn', center: 'Center turn', bus: 'Bus', median: 'Median',
};

// Place labels on up to two rows so neighbors never overlap.
function staggered(items, rowYs, charW) {
  const rightEdge = rowYs.map(() => -Infinity);
  return items.map(({ cx, text }) => {
    const half = (text.length * charW) / 2 + 3;
    let row = rightEdge.findIndex((r) => cx - half >= r);
    if (row < 0) row = rightEdge.indexOf(Math.min(...rightEdge));
    rightEdge[row] = cx + half;
    return { cx, text, y: rowYs[row] };
  });
}

export function crossSectionSvg(lanes, t, f, { pxPerM = 22, title = '' } = {}) {
  const { ws, road } = laneLayout(lanes, t);
  const shown = lanes.map((l, i) => ({ l, w: ws[i] })).filter((x) => x.w > 0.05);
  const total = shown.reduce((sum, x) => sum + x.w, 0);
  const W = Math.max(200, total * pxPerM + 20);
  const font = 'font-family="Inter, sans-serif"';
  const top = title ? 18 : 0;
  let x = 10, bars = '';
  const names = [], widths = [];
  for (const { l, w } of shown) {
    const T = LANE_TYPES[l.type];
    const bw = w * pxPerM;
    const raised = T.off || T.raised;
    const y = top + (raised ? 38 : 44);
    bars += `<rect x="${n(x)}" y="${y}" width="${n(bw)}" height="${raised ? 20 : 14}" fill="${T.fill}" stroke="#111" stroke-width="0.5"/>`;
    if (l.dir) {
      const cx = x + bw / 2, cy = top + 51, d = l.dir === 'fwd' ? -1 : 1;
      bars += `<path d="M ${n(cx - 3)} ${n(cy - d * 2)} L ${n(cx)} ${n(cy + d * 3)} L ${n(cx + 3)} ${n(cy - d * 2)}" fill="none" stroke="#fff" stroke-width="1.3"/>`;
    }
    names.push({ cx: x + bw / 2, text: SHORT[l.type] || T.label });
    widths.push({ cx: x + bw / 2, text: f(w) });
    x += bw;
  }
  let out = bars;
  for (const lb of staggered(names, [top + 32, top + 18], 5.6)) {
    out += `<text x="${n(lb.cx)}" y="${lb.y}" font-size="10" text-anchor="middle" fill="#ddd" ${font}>${lb.text}</text>`;
  }
  for (const lb of staggered(widths, [top + 72, top + 85], 5.4)) {
    out += `<text x="${n(lb.cx)}" y="${lb.y}" font-size="10" text-anchor="middle" fill="#bbb" ${font}>${lb.text}</text>`;
  }
  out += `<line x1="10" y1="${top + 93}" x2="${n(x)}" y2="${top + 93}" stroke="#777"/>
    <text x="${n((10 + x) / 2)}" y="${top + 108}" font-size="11" text-anchor="middle" fill="#fff" ${font}>${f(total)} total · ${f(road)} curb to curb</text>`;
  if (title) out += `<text x="10" y="13" font-size="11" font-weight="600" fill="#aaa" ${font}>${title}</text>`;
  const H = top + 118;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${H}" viewBox="0 0 ${n(W)} ${H}"><rect width="100%" height="100%" rx="4" fill="#1f2226"/>${out}</svg>`, width: W, height: H };
}

// ---------- patch (repave / remove markings) ----------

const MATERIALS = {
  asphalt: { label: 'Fresh asphalt (removes markings)', fill: C.asphalt, qty: 'asphalt' },
  concrete: { label: 'Concrete / sidewalk', fill: C.concrete, qty: 'concrete' },
  grass: { label: 'Landscaping', fill: C.green, qty: 'green' },
  brick: { label: 'Pavers / plaza', fill: C.brick, qty: 'concrete' },
};

const patch = {
  kind: 'path', label: 'Patch / remove', group: 'Streets', key: 'p', minPts: 3, closed: true,
  hint: 'Click around an area to cover it, e.g. paint out old turn lanes. Double-click or Enter to finish.',
  help: 'Covers whatever is underneath, such as old turn lanes or markings. Drag the small dots to add corners.',
  params: [
    { k: 'material', label: 'Material', type: 'select', def: 'asphalt', options: Object.entries(MATERIALS).map(([k, v]) => [k, v.label]) },
    { k: 'curb', label: 'Curb outline', type: 'bool', def: false },
    { k: 'smooth', label: 'Smooth edges', type: 'bool', def: false },
  ],
  name: (el) => `Patch (${el.p.material})`,
  draw(el, ctx) {
    const px = el.pts.map((p) => ctx.toPx(p[0], p[1]));
    const sm = samplePath(px, { smooth: el.p.smooth, closed: true, step: 4 }).map((p) => [p.x, p.y]);
    const stroke = el.p.curb ? `stroke="${C.curb}" stroke-width="${n(0.3 * ctx.s)}"` : '';
    return `<path d="${pathD(sm, true)}" fill="${MATERIALS[el.p.material].fill}" ${stroke}/>`;
  },
  qty(el) {
    const [lat0, lng0] = el.pts[0];
    const area = polygonArea(el.pts.map((p) => llToMeters(lat0, lng0, p[0], p[1])));
    return { [MATERIALS[el.p.material].qty]: area };
  },
};

// ---------- dimension ----------

const dimension = {
  kind: 'path', label: 'Measure', group: 'Analysis', key: 'd', minPts: 2, maxPts: 2,
  hint: 'Click two points to measure. It exports as a labeled dimension line.',
  help: 'Drag either end to re-measure. It exports as a labeled dimension line.',
  params: [{ k: 'size', label: 'Label size (px)', type: 'num', def: 13, min: 8, max: 32 }],
  name: (el, f) => `Dimension ${f(dimLength(el))}`,
  draw(el, ctx) {
    if (el.pts.length < 2) return '';
    const [a, b] = el.pts.map((p) => ctx.toPx(p[0], p[1]));
    const dx = b[0] - a[0], dy = b[1] - a[1], Lp = Math.hypot(dx, dy) || 1;
    const nx = -dy / Lp * 6, ny = dx / Lp * 6;
    const label = ctx.f(dimLength(el));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const size = el.p.size, tw = label.length * size * 0.6 + 10;
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    const st = 'stroke="#ffd34d" stroke-width="2"';
    return `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${st}/>
      <line x1="${n(a[0] - nx)}" y1="${n(a[1] - ny)}" x2="${n(a[0] + nx)}" y2="${n(a[1] + ny)}" ${st}/>
      <line x1="${n(b[0] - nx)}" y1="${n(b[1] - ny)}" x2="${n(b[0] + nx)}" y2="${n(b[1] + ny)}" ${st}/>
      <g transform="translate(${n(mx)} ${n(my)}) rotate(${n(ang)})">
        <rect x="${n(-tw / 2)}" y="${n(-size / 2 - 4)}" width="${n(tw)}" height="${n(size + 8)}" rx="3" fill="#111" fill-opacity="0.8"/>
        <text x="0" y="${n(size * 0.35)}" fill="#ffd34d" font-family="Inter, system-ui, sans-serif" font-size="${size}" text-anchor="middle">${label}</text>
      </g>
      <line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke="#000" stroke-opacity="0.001" stroke-width="14" data-hit="1"/>`;
  },
};
function dimLength(el) {
  if (el.pts.length < 2) return 0;
  const [a, b] = el.pts;
  const [x, y] = llToMeters(a[0], a[1], b[0], b[1]);
  return Math.hypot(x, y);
}

// ---------- vehicle turning path ----------

// AASHTO design vehicles (meters). minR = minimum design turning radius.
export const VEHICLES = {
  car: { label: 'Passenger car (P)', wb: 3.35, w: 2.13, fo: 0.91, ro: 1.52, minR: 7.3 },
  su30: { label: 'Delivery truck (SU-30)', wb: 6.1, w: 2.44, fo: 1.22, ro: 1.83, minR: 12.8 },
  bus: { label: 'City bus (CITY-BUS)', wb: 7.62, w: 2.59, fo: 2.13, ro: 2.44, minR: 12.8 },
  fire: { label: 'Fire truck (typical pumper)', wb: 5.8, w: 2.6, fo: 2.2, ro: 3.3, minR: 11.6 },
};
const tightSpots = new WeakMap();

const vehicle = {
  kind: 'path', label: 'Turning check', group: 'Analysis', key: 't', minPts: 2,
  hint: 'Click the path the front axle follows through the turn. The orange area is the space the vehicle sweeps.',
  help: 'The orange area is the space the vehicle sweeps. Red dots mark turns tighter than it can make. Drag points to adjust the path.',
  params: [
    { k: 'vehicle', label: 'Vehicle', type: 'select', def: 'fire', options: Object.entries(VEHICLES).map(([k, v]) => [k, v.label]) },
  ],
  name: (el) => `Swept path: ${VEHICLES[el.p.vehicle].label}`,
  draw(el, ctx) {
    const v = VEHICLES[el.p.vehicle], s = ctx.s;
    const px = el.pts.map((p) => ctx.toPx(p[0], p[1]));
    const sm = samplePath(px, { smooth: true, step: Math.max(1, 0.25 * s) });
    if (sm.length < 2) return '';
    const wb = v.wb * s;
    const f0 = frameAt(sm, 0);
    let rear = [sm[0].x - f0.tx * wb, sm[0].y - f0.ty * wb];
    const bodies = [];
    let lastBodyS = -Infinity;
    const body = (F, R) => {
      const hx = (F[0] - R[0]) / wb, hy = (F[1] - R[1]) / wb, nx = -hy * (v.w / 2) * s, ny = hx * (v.w / 2) * s;
      const fb = [F[0] + hx * v.fo * s, F[1] + hy * v.fo * s], rb = [R[0] - hx * v.ro * s, R[1] - hy * v.ro * s];
      return [[fb[0] + nx, fb[1] + ny], [fb[0] - nx, fb[1] - ny], [rb[0] - nx, rb[1] - ny], [rb[0] + nx, rb[1] + ny]];
    };
    for (const p of sm) {
      const F = [p.x, p.y];
      const vx = F[0] - rear[0], vy = F[1] - rear[1], Lr = Math.hypot(vx, vy) || 1;
      rear = [F[0] - (vx / Lr) * wb, F[1] - (vy / Lr) * wb];
      if (p.s - lastBodyS >= 0.4 * s) { bodies.push(body(F, rear)); lastBodyS = p.s; }
    }
    const lastP = sm[sm.length - 1];
    bodies.push(body([lastP.x, lastP.y], rear));

    // Spots where the path curves tighter than the vehicle can steer.
    const limit = (v.minR - v.w / 2) * s, span = 2 * s;
    let tight = '', count = 0, inTight = false;
    for (let d = span; d < lastP.s - span; d += 0.5 * s) {
      const a = frameAt(sm, d - span), b = frameAt(sm, d), c = frameAt(sm, d + span);
      const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ca = Math.hypot(a.x - c.x, a.y - c.y);
      const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      const radius = cross < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cross);
      if (radius < limit) {
        tight += `<circle cx="${n(b.x)}" cy="${n(b.y)}" r="4" fill="#ff3b30"/>`;
        if (!inTight) count++;
        inTight = true;
      } else inTight = false;
    }
    tightSpots.set(el, count);

    const outline = (poly) => `<path d="${pathD(poly, true)}" fill="none" stroke="#ff8a3d" stroke-width="1.5"/>`;
    return `<g opacity="0.35" fill="#ff8a3d">${bodies.map((b) => `<path d="${pathD(b, true)}"/>`).join('')}</g>
      ${outline(bodies[0])}${outline(bodies[bodies.length - 1])}
      <path d="${pathD(sm.map((p) => [p.x, p.y]))}" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="6 4"/>${tight}`;
  },
  warnings(el) {
    const c = tightSpots.get(el) || 0;
    return c ? [`The path is tighter than a ${VEHICLES[el.p.vehicle].label.toLowerCase()} can steer in ${c} place${c > 1 ? 's' : ''} (red dots).`] : [];
  },
};

export const PATH_TYPES = { segment, patch, dimension, vehicle };
export { bearingVec, polylineLength };
