// Elements placed with a single click: drawn around their own center in local
// meters (x right, y down; at rotation 0 "up" is north). svg(p, s) returns
// markup pre-scaled by s = pixels per meter, so Figma keeps stroke widths.
import { n } from '../geo.js';
import { COLORS as C, zebra, zebraArea, bumpPath, hitRect, curbStroke } from './common.js';

const PI = Math.PI;
// Defaults are round US numbers (feet), stored in meters.
const F = (ft) => ft / 3.28084;

// ---------- roundabouts (shared by full and mini) ----------

export const makeLegs = (count, approach, old = []) =>
  Array.from({ length: count }, (_, i) => ({
    angle: (i * 360) / count,
    approach: old[i]?.approach ?? approach,
    crosswalk: old[i]?.crosswalk ?? true,
  }));

export const legLength = (p) => p.icd / 2 + p.splitLen + 4;

// Splitter island width at distance d from the center (0 outside the island).
function splitterWidthAt(p, R, d, painted) {
  const y0 = R + (painted ? 0.6 : 1.2), y1 = R + p.splitLen;
  if (p.splitLen < 0.5 || d < y0 || d > y1) return 0;
  return p.splitW * (1 - 0.76 * ((d - y0) / (y1 - y0)));
}

function legsSvg(p, s, R, painted) {
  const L = p.splitLen, w = p.splitW, len = legLength(p);
  let curb = '', fill = '', top = '';
  for (const leg of p.legs) {
    const A = leg.approach;
    const rot = `rotate(${n(leg.angle)})`;
    curb += `<g transform="${rot}">
      <line x1="${n(-A / 2 * s)}" y1="${n(-len * s)}" x2="${n(-A / 2 * s)}" y2="0"/>
      <line x1="${n(A / 2 * s)}" y1="${n(-len * s)}" x2="${n(A / 2 * s)}" y2="0"/></g>`;
    fill += `<rect transform="${rot}" x="${n(-A / 2 * s)}" y="${n(-len * s)}" width="${n(A * s)}" height="${n(len * s)}"/>`;

    let legTop = '';
    if (L >= 0.5) {
      const y0 = -(R + (painted ? 0.6 : 1.2)), y1 = -(R + L);
      const island = `M ${n(-w / 2 * s)} ${n(y0 * s)} Q 0 ${n((y0 + w * 0.4) * s)} ${n(w / 2 * s)} ${n(y0 * s)}
        L ${n(w * 0.12 * s)} ${n(y1 * s)} Q 0 ${n((y1 - 0.5) * s)} ${n(-w * 0.12 * s)} ${n(y1 * s)} Z`;
      const style = painted
        ? `fill="${C.paint}" fill-opacity="0.3" stroke="${C.paint}" stroke-width="${n(0.2 * s)}"`
        : `fill="${C.concrete}" ${curbStroke(s)}`;
      legTop += `<path d="${island}" ${style}/>`;
    }
    // Yield line across the entry lane. US traffic enters on the right, the -x side of a leg pointing up.
    const yy = n(-(R + 0.4) * s);
    const inner = L >= 0.5 ? -w / 2 - 0.3 : -0.3;
    legTop += `<line x1="${n((-A / 2 + 0.4) * s)}" y1="${yy}" x2="${n(inner * s)}" y2="${yy}"
      stroke="${C.paint}" stroke-width="${n(0.35 * s)}" stroke-dasharray="${n(0.6 * s)} ${n(0.45 * s)}"/>`;

    if (leg.crosswalk) {
      const d = R + p.xwOffset;
      if (d + p.xwWidth / 2 < len) {
        const wAt = splitterWidthAt(p, R, d, painted);
        if (wAt > 0 && !painted) {
          // pedestrian cut-through in the splitter island
          legTop += `<rect x="${n(-wAt / 2 * s - 1)}" y="${n((-d - p.xwWidth / 2) * s)}" width="${n(wAt * s + 2)}"
            height="${n(p.xwWidth * s)}" fill="${C.asphalt}"/>`;
        }
        legTop += zebra(-A / 2 + 0.3, A / 2 - 0.3, -d, p.xwWidth, s, wAt > 0 ? [[-wAt / 2 - 0.2, wAt / 2 + 0.2]] : []);
      }
    }
    top += `<g transform="${rot}">${legTop}</g>`;
  }
  // Curb outlines first, then asphalt on top hides the interior lines,
  // leaving one clean outline around the whole road surface.
  return `<g fill="none" stroke="${C.curb}" stroke-width="${n(0.6 * s)}">${curb}<circle r="${n(R * s)}"/></g>
    <g fill="${C.asphalt}">${fill}<circle r="${n(R * s)}"/></g>${top}`;
}

const legPorts = (p) => {
  const D = legLength(p);
  return p.legs.map((leg, i) => {
    const a = (leg.angle * PI) / 180;
    return { key: `leg${i}`, x: Math.sin(a) * D, y: -Math.cos(a) * D, angle: leg.angle, width: leg.approach };
  });
};

function legsQty(p, R) {
  const len = legLength(p);
  let asphalt = 0, paint = 0;
  for (const leg of p.legs) {
    asphalt += leg.approach * (len - R);
    paint += (leg.approach / 2) * 0.35;
    if (leg.crosswalk) paint += zebraArea(leg.approach - 0.6, p.xwWidth);
  }
  return { asphalt, paint, island: p.splitLen >= 0.5 ? p.legs.length * 0.6 * p.splitLen * p.splitW : 0 };
}

const crosswalkParams = (offset) => [
  { k: 'xwOffset', label: 'Crosswalk distance from circle', type: 'len', def: offset, min: 2, max: 15 },
  { k: 'xwWidth', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6 },
];

const roundabout = {
  kind: 'point', label: 'Roundabout', group: 'Intersections', key: 'r', legs: true,
  hint: 'Drag the orange squares to aim each leg down its street. Draw roads from the leg ends.',
  params: [
    { k: 'icd', label: 'Outer diameter', type: 'len', def: F(130), min: 25, max: 75 },
    { k: 'circ', label: 'Circulating lane width', type: 'len', def: F(20), min: 4, max: 12 },
    { k: 'apron', label: 'Truck apron width', type: 'len', def: F(12), min: 0, max: 6 },
    { k: 'splitLen', label: 'Splitter island length', type: 'len', def: F(60), min: 0, max: 40 },
    { k: 'splitW', label: 'Splitter island width', type: 'len', def: F(12), min: 1, max: 6 },
    ...crosswalkParams(F(20)),
  ],
  defaults: () => ({ legs: makeLegs(4, F(36)) }),
  bbox: (p) => { const r = legLength(p); return [-r, -r, r, r]; },
  ports: legPorts,
  name: (p, f) => `Roundabout ${f(p.icd)}`,
  svg(p, s) {
    const R = p.icd / 2, Ri = Math.max(R - p.circ, 1), Rg = Math.max(Ri - p.apron, 0);
    return `${legsSvg(p, s, R, false)}
      <circle r="${n(Ri * s)}" fill="${p.apron > 0 ? C.apron : C.green}" ${curbStroke(s)}/>
      ${p.apron > 0 && Rg > 0 ? `<circle r="${n(Rg * s)}" fill="${C.green}" ${curbStroke(s)}/>` : ''}`;
  },
  warnings(p, f) {
    const w = [];
    if (p.icd < 27) w.push(`Single-lane roundabouts are usually ${f(27)}–${f(55)} across. At this size a mini-roundabout may fit better.`);
    if (p.icd > 55) w.push(`Larger than a typical single-lane roundabout (${f(27)}–${f(55)}). Two-lane ones run about ${f(46)}–${f(91)}.`);
    if (p.circ < 4.9) w.push(`Circulating lanes under ${f(4.9)} are tight for trucks; a truck apron helps.`);
    if (p.splitW < 1.8 && p.legs.some((l) => l.crosswalk)) w.push(`Splitter islands under ${f(1.8)} wide are too narrow to be a pedestrian refuge.`);
    if (p.xwOffset < 4.5) w.push(`Crosswalks are usually set back about ${f(6)} (one car length) from the circle.`);
    return w;
  },
  qty(p) {
    const R = p.icd / 2, Ri = Math.max(R - p.circ, 1), Rg = Math.max(Ri - p.apron, 0);
    const legs = legsQty(p, R);
    return {
      asphalt: PI * (R * R - Ri * Ri) + legs.asphalt,
      concrete: (p.apron > 0 ? PI * (Ri * Ri - Rg * Rg) : 0) + legs.island,
      green: PI * (p.apron > 0 ? Rg * Rg : Ri * Ri),
      paint: legs.paint,
    };
  },
};

const mini = {
  kind: 'point', label: 'Mini-roundabout', group: 'Intersections', key: 'm', legs: true,
  hint: 'Drag the orange squares to aim each leg down its street.',
  params: [
    { k: 'icd', label: 'Outer diameter', type: 'len', def: F(70), min: 13, max: 30 },
    { k: 'island', label: 'Center island diameter', type: 'len', def: F(24), min: 2, max: 14 },
    { k: 'splitLen', label: 'Painted island length', type: 'len', def: F(25), min: 0, max: 20 },
    { k: 'splitW', label: 'Painted island width', type: 'len', def: F(5), min: 0.5, max: 4 },
    ...crosswalkParams(F(16)),
  ],
  defaults: () => ({ legs: makeLegs(4, F(30)) }),
  bbox: (p) => { const r = legLength(p); return [-r, -r, r, r]; },
  ports: legPorts,
  name: (p, f) => `Mini-roundabout ${f(p.icd)}`,
  svg(p, s) {
    const R = p.icd / 2, r = Math.min(p.island / 2, R - 2);
    return `${legsSvg(p, s, R, true)}
      <circle r="${n(r * s)}" fill="#eeeae1" stroke="${C.paint}" stroke-width="${n(0.3 * s)}"/>
      <circle r="${n((r + 0.5) * s)}" fill="none" stroke="${C.paint}" stroke-width="${n(0.15 * s)}"
        stroke-dasharray="${n(0.5 * s)} ${n(0.4 * s)}"/>`;
  },
  warnings(p, f) {
    const w = [];
    if (p.icd < 13.7 || p.icd > 27.4) w.push(`Mini-roundabouts are typically ${f(13.7)}–${f(27.4)} across (FHWA).`);
    if (p.island > p.icd * 0.45) w.push('A large center island can block trucks. Minis rely on a center that larger vehicles drive over.');
    return w;
  },
  qty(p) {
    const R = p.icd / 2, r = Math.min(p.island / 2, R - 2);
    const legs = legsQty(p, R);
    return { asphalt: PI * R * R + legs.asphalt, concrete: PI * r * r, paint: legs.paint + legs.island };
  },
};

// ---------- intersections ----------

const raised = {
  kind: 'point', label: 'Raised intersection', group: 'Intersections', key: null,
  hint: 'Size it to the intersection, curb to curb. Roads can snap to its four sides.',
  params: [
    { k: 'width', label: 'Width (east-west)', type: 'len', def: F(45), min: 6, max: 40 },
    { k: 'height', label: 'Depth (north-south)', type: 'len', def: F(45), min: 6, max: 40 },
    { k: 'ramp', label: 'Ramp length', type: 'len', def: F(6), min: 0.6, max: 4 },
    { k: 'crosswalks', label: 'Crosswalks on all sides', type: 'bool', def: true },
    { k: 'xwWidth', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6, when: (p) => p.crosswalks },
  ],
  bbox: (p) => [-p.width / 2 - p.ramp, -p.height / 2 - p.ramp, p.width / 2 + p.ramp, p.height / 2 + p.ramp],
  ports: (p) => [
    { key: 'n', x: 0, y: -p.height / 2 - p.ramp, angle: 0, width: p.width },
    { key: 'e', x: p.width / 2 + p.ramp, y: 0, angle: 90, width: p.height },
    { key: 's', x: 0, y: p.height / 2 + p.ramp, angle: 180, width: p.width },
    { key: 'w', x: -p.width / 2 - p.ramp, y: 0, angle: 270, width: p.height },
  ],
  name: (p, f) => `Raised intersection ${f(p.width)} x ${f(p.height)}`,
  svg(p, s) {
    const W = p.width, H = p.height, r = p.ramp, cw = p.xwWidth;
    let out = `<rect x="${n((-W / 2 - r) * s)}" y="${n((-H / 2 - r) * s)}" width="${n((W + 2 * r) * s)}" height="${n((H + 2 * r) * s)}"
        fill="${C.brick}" fill-opacity="0.5"/>
      <rect x="${n(-W / 2 * s)}" y="${n(-H / 2 * s)}" width="${n(W * s)}" height="${n(H * s)}" fill="${C.brick}"/>`;
    if (p.crosswalks) {
      const inset = cw / 2 + 0.3;
      out += zebra(-W / 2 + 0.3, W / 2 - 0.3, -H / 2 + inset, cw, s);
      out += zebra(-W / 2 + 0.3, W / 2 - 0.3, H / 2 - inset, cw, s);
      out += `<g transform="translate(${n((-W / 2 + inset) * s)} 0) rotate(90)">${zebra(-H / 2 + 0.3, H / 2 - 0.3, 0, cw, s)}</g>`;
      out += `<g transform="translate(${n((W / 2 - inset) * s)} 0) rotate(90)">${zebra(-H / 2 + 0.3, H / 2 - 0.3, 0, cw, s)}</g>`;
    }
    return out;
  },
  qty: (p) => ({
    asphalt: (p.width + 2 * p.ramp) * (p.height + 2 * p.ramp),
    paint: p.crosswalks ? 2 * zebraArea(p.width, p.xwWidth) + 2 * zebraArea(p.height, p.xwWidth) : 0,
  }),
};

const diverter = {
  kind: 'point', label: 'Diagonal diverter', group: 'Intersections', key: null,
  hint: 'Size it to the intersection. Rotate 90° to flip the diagonal. The gap lets bikes through.',
  params: [
    { k: 'size', label: 'Intersection size', type: 'len', def: F(40), min: 6, max: 30 },
    { k: 'width', label: 'Island width', type: 'len', def: F(7), min: 1, max: 5 },
    { k: 'bikeGap', label: 'Gap for bikes', type: 'bool', def: true },
    { k: 'gap', label: 'Gap width', type: 'len', def: F(6), min: 1.2, max: 3, when: (p) => p.bikeGap },
    { k: 'planted', label: 'Planted', type: 'bool', def: true },
  ],
  bbox: (p) => [-p.size / 2, -p.size / 2, p.size / 2, p.size / 2],
  name: (p, f) => `Diverter ${f(p.size)}`,
  svg(p, s) {
    const Ld = p.size * Math.SQRT2 - 2, w = p.width, g = p.bikeGap ? p.gap : 0;
    const piece = (x0, x1) => `<rect x="${n(x0 * s)}" y="${n(-w / 2 * s)}" width="${n((x1 - x0) * s)}" height="${n(w * s)}"
      rx="${n(Math.min(w / 2, 0.8) * s)}" fill="${p.planted ? C.green : C.concrete}" ${curbStroke(s)}/>`;
    const body = g > 0 ? piece(-Ld / 2, -g / 2) + piece(g / 2, Ld / 2) : piece(-Ld / 2, Ld / 2);
    return `<rect x="${n(-p.size / 2 * s)}" y="${n(-p.size / 2 * s)}" width="${n(p.size * s)}" height="${n(p.size * s)}"
        fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="${n(0.15 * s)}" stroke-dasharray="${n(1 * s)} ${n(1 * s)}" data-hit="1"/>
      <g transform="rotate(45)">${body}</g>`;
  },
  warnings: (p, f) => (p.bikeGap && p.gap < 1.5 ? [`Bike gaps are usually at least ${f(1.5)} wide.`] : []),
  qty(p) {
    const area = (p.size * Math.SQRT2 - 2 - (p.bikeGap ? p.gap : 0)) * p.width;
    return p.planted ? { green: area } : { concrete: area };
  },
};

// ---------- traffic calming ----------

const bumpout = {
  kind: 'point', label: 'Bumpout', group: 'Traffic calming', key: 'b',
  hint: 'The straight edge is the curb; the bump points into the street. Turn on the crosswalk to cross from it.',
  params: [
    { k: 'length', label: 'Length along curb', type: 'len', def: F(40), min: 3, max: 40 },
    { k: 'depth', label: 'Depth into street', type: 'len', def: F(8), min: 1, max: 5 },
    { k: 'taper', label: 'End taper', type: 'len', def: F(8), min: 0.5, max: 8 },
    { k: 'planter', label: 'Planting strip', type: 'bool', def: true },
    { k: 'crosswalk', label: 'Crosswalk from bumpout', type: 'bool', def: false },
    { k: 'xwLen', label: 'Street width to cross', type: 'len', def: F(30), min: 3, max: 30, when: (p) => p.crosswalk },
    { k: 'xwWidth', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6, when: (p) => p.crosswalk },
    { k: 'xwShift', label: 'Crosswalk position along curb', type: 'len', def: 0, min: -15, max: 15, when: (p) => p.crosswalk },
  ],
  bbox: (p) => [Math.min(-p.length / 2, p.crosswalk ? p.xwShift - p.xwWidth / 2 : 0), 0,
    Math.max(p.length / 2, p.crosswalk ? p.xwShift + p.xwWidth / 2 : 0), p.depth + (p.crosswalk ? p.xwLen : 0)],
  name: (p, f) => `Bumpout ${f(p.length)} x ${f(p.depth)}`,
  svg(p, s) {
    const L = p.length / 2, D = p.depth, T = Math.min(p.taper, L * 0.9);
    let out = `<path d="${bumpPath(p.length, D, p.taper, s)}" fill="${C.concrete}" ${curbStroke(s)}/>`;
    const pw = 2 * (L - T) - 1, ph = D - 1;
    if (p.planter && pw > 1 && ph > 0.5) {
      out += `<rect x="${n(-pw / 2 * s)}" y="${n(0.5 * s)}" width="${n(pw * s)}" height="${n(ph * s)}" rx="${n(0.4 * s)}" fill="${C.green}"/>`;
    }
    if (p.crosswalk) {
      out += `<g transform="translate(${n(p.xwShift * s)} ${n(D * s)}) rotate(90)">${zebra(0.2, p.xwLen - 0.2, 0, p.xwWidth, s)}</g>`;
    }
    return out;
  },
  warnings(p, f) {
    const w = [];
    if (p.depth > 2.6) w.push(`Deeper than a typical parking lane (${f(2.1)}–${f(2.4)}). Check it doesn't block a travel or bike lane.`);
    if (p.crosswalk && p.xwWidth < 1.8) w.push(`Crosswalks should be at least ${f(1.8)} wide.`);
    return w;
  },
  qty(p) {
    const L = p.length / 2, T = Math.min(p.taper, L * 0.9);
    const area = (p.length - T) * p.depth;
    const pw = 2 * (L - T) - 1, ph = p.depth - 1;
    const green = p.planter && pw > 1 && ph > 0.5 ? pw * ph : 0;
    return { concrete: area - green, green, paint: p.crosswalk ? zebraArea(p.xwLen, p.xwWidth) : 0 };
  },
};

const chicane = {
  kind: 'point', label: 'Chicane', group: 'Traffic calming', key: null,
  hint: 'Two offset bumpouts that make drivers weave. Rotate so the road runs left-right.',
  params: [
    { k: 'roadWidth', label: 'Curb-to-curb width', type: 'len', def: F(30), min: 5, max: 20 },
    { k: 'length', label: 'Each bump length', type: 'len', def: F(30), min: 4, max: 25 },
    { k: 'depth', label: 'Bump depth', type: 'len', def: F(8), min: 1, max: 5 },
    { k: 'taper', label: 'Bump taper', type: 'len', def: F(10), min: 0.5, max: 8 },
    { k: 'spacing', label: 'Offset between bumps', type: 'len', def: F(50), min: 4, max: 40 },
    { k: 'planter', label: 'Planted', type: 'bool', def: true },
  ],
  bbox: (p) => [-p.spacing / 2 - p.length / 2, -p.roadWidth / 2, p.spacing / 2 + p.length / 2, p.roadWidth / 2],
  name: (p, f) => `Chicane ${f(p.spacing)}`,
  svg(p, s) {
    const fill = p.planter ? C.green : C.concrete;
    const one = (x, y, sign) => `<g transform="translate(${n(x * s)} ${n(y * s)})">
      <path d="${bumpPath(p.length, p.depth, p.taper, s, sign)}" fill="${fill}" ${curbStroke(s)}/></g>`;
    return `<rect x="${n((-p.spacing / 2 - p.length / 2) * s)}" y="${n(-p.roadWidth / 2 * s)}"
        width="${n((p.spacing + p.length) * s)}" height="${n(p.roadWidth * s)}" fill="none" stroke="#fff" stroke-opacity="0.3"
        stroke-width="${n(0.12 * s)}" stroke-dasharray="${n(1 * s)} ${n(1 * s)}" data-hit="1"/>
      ${one(-p.spacing / 2, -p.roadWidth / 2, 1)}${one(p.spacing / 2, p.roadWidth / 2, -1)}`;
  },
  warnings: (p, f) => (p.roadWidth - p.depth < 3 ? [`Only ${f(p.roadWidth - p.depth)} left beside each bump. ${f(3)} or more is typical.`] : []),
  qty(p) {
    const T = Math.min(p.taper, (p.length / 2) * 0.9);
    const area = 2 * (p.length - T) * p.depth;
    return p.planter ? { green: area } : { concrete: area };
  },
};

const hump = {
  kind: 'point', label: 'Speed hump', group: 'Traffic calming', key: null,
  hint: 'Width runs across the street. Cushions leave gaps for fire truck wheels.',
  params: [
    { k: 'kind', label: 'Type', type: 'select', def: 'hump', options: [['hump', 'Speed hump'], ['table', 'Speed table'], ['cushion', 'Speed cushions']] },
    { k: 'roadWidth', label: 'Width across street', type: 'len', def: F(30), min: 3, max: 20 },
    { k: 'depth', label: 'Length along street', type: 'len', def: F(12), min: 2, max: 10 },
    { k: 'padWidth', label: 'Cushion pad width', type: 'len', def: F(6), min: 1.2, max: 3, when: (p) => p.kind === 'cushion' },
    { k: 'padGap', label: 'Gap between pads', type: 'len', def: F(3), min: 0.5, max: 2, when: (p) => p.kind === 'cushion' },
  ],
  bbox: (p) => [-p.roadWidth / 2, -p.depth / 2, p.roadWidth / 2, p.depth / 2],
  name: (p, f) => `${{ hump: 'Speed hump', table: 'Speed table', cushion: 'Speed cushions' }[p.kind]} ${f(p.roadWidth)}`,
  svg(p, s) {
    const W = p.roadWidth, D = p.depth;
    const tri = (cx) => `<path d="M ${n((cx - 0.6) * s)} ${n((D / 2 - 0.4) * s)} L ${n(cx * s)} ${n((-D / 2 + 0.4) * s)}
      L ${n((cx + 0.6) * s)} ${n((D / 2 - 0.4) * s)} Z" fill="${C.paint}"/>`;
    let out = hitRect(-W / 2, -D / 2, W / 2, D / 2, s);
    if (p.kind === 'cushion') {
      const pads = Math.max(1, Math.floor((W + p.padGap) / (p.padWidth + p.padGap)));
      const total = pads * p.padWidth + (pads - 1) * p.padGap;
      for (let i = 0; i < pads; i++) {
        const x = -total / 2 + i * (p.padWidth + p.padGap);
        out += `<rect x="${n(x * s)}" y="${n(-D / 2 * s)}" width="${n(p.padWidth * s)}" height="${n(D * s)}" rx="${n(0.3 * s)}"
          fill="${C.asphaltLight}" stroke="${C.paint}" stroke-width="${n(0.12 * s)}"/>${tri(x + p.padWidth / 2)}`;
      }
      return out;
    }
    out += `<rect x="${n(-W / 2 * s)}" y="${n(-D / 2 * s)}" width="${n(W * s)}" height="${n(D * s)}" fill="${p.kind === 'table' ? C.brick : C.asphaltLight}"/>`;
    if (p.kind === 'table') {
      const r = Math.min(1.8, D / 4);
      out += `<rect x="${n(-W / 2 * s)}" y="${n((-D / 2 + r) * s)}" width="${n(W * s)}" height="${n((D - 2 * r) * s)}" fill="#b97a5e"/>`;
    }
    const count = Math.max(1, Math.floor(W / 3));
    for (let i = 0; i < count; i++) out += tri(-W / 2 + (W / count) * (i + 0.5));
    return out;
  },
  warnings(p, f) {
    const w = [];
    if (p.kind === 'hump' && (p.depth < 3.3 || p.depth > 4.3)) w.push(`Speed humps are typically ${f(3.7)}–${f(4.3)} long.`);
    if (p.kind === 'table' && p.depth < 6) w.push(`Speed tables are typically about ${f(6.7)} long.`);
    if (p.kind === 'cushion' && p.padWidth > 2) w.push(`Pads wider than about ${f(2)} won't let fire truck wheels straddle them.`);
    return w;
  },
  qty: (p) => ({ asphalt: p.roadWidth * p.depth, paint: Math.max(1, Math.floor(p.roadWidth / 3)) * 0.5 * 1.2 * (p.depth - 0.8) }),
};

const refuge = {
  kind: 'point', label: 'Refuge island', group: 'Traffic calming', key: null,
  hint: 'A median island with a crosswalk through it. Line the long side up with traffic.',
  params: [
    { k: 'roadWidth', label: 'Street width to cross', type: 'len', def: F(45), min: 6, max: 30 },
    { k: 'length', label: 'Island length', type: 'len', def: F(30), min: 3, max: 40 },
    { k: 'width', label: 'Island width', type: 'len', def: F(8), min: 1, max: 6 },
    { k: 'planted', label: 'Planted', type: 'bool', def: true },
    { k: 'crosswalk', label: 'Crosswalk through island', type: 'bool', def: true },
    { k: 'xwWidth', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6, when: (p) => p.crosswalk },
  ],
  bbox: (p) => (p.crosswalk
    ? [-Math.max(p.length, p.xwWidth) / 2, -p.roadWidth / 2, Math.max(p.length, p.xwWidth) / 2, p.roadWidth / 2]
    : [-p.length / 2, -p.width / 2, p.length / 2, p.width / 2]),
  name: (p, f) => `Refuge island ${f(p.length)} x ${f(p.width)}`,
  svg(p, s) {
    const L = p.length, W = p.width, cw = p.xwWidth;
    let out = `<rect x="${n(-L / 2 * s)}" y="${n(-W / 2 * s)}" width="${n(L * s)}" height="${n(W * s)}" rx="${n(Math.min(W / 2, 1.2) * s)}"
      fill="${p.planted ? C.green : C.concrete}" ${curbStroke(s)}/>`;
    if (p.crosswalk) {
      out += `<rect x="${n(-cw / 2 * s)}" y="${n((-W / 2 - 0.2) * s)}" width="${n(cw * s)}" height="${n((W + 0.4) * s)}" fill="${C.concrete}"/>`;
      out += `<g transform="rotate(90)">${zebra(-p.roadWidth / 2 + 0.2, p.roadWidth / 2 - 0.2, 0, cw, s, [[-W / 2 - 0.2, W / 2 + 0.2]])}</g>`;
    }
    return out;
  },
  warnings: (p, f) => (p.width < 1.8 ? [`Refuge islands need at least ${f(1.8)} (${f(2.4)}–${f(3)} preferred) to hold a person with a bike or stroller.`] : []),
  qty(p) {
    const area = p.length * p.width;
    return { [p.planted ? 'green' : 'concrete']: area, paint: p.crosswalk ? zebraArea(p.roadWidth - p.width, p.xwWidth) : 0 };
  },
};

// ---------- markings ----------

const crosswalk = {
  kind: 'point', label: 'Crosswalk', group: 'Markings', key: 'c',
  hint: 'Length runs across the street. Rotate so the stripes run the same way as traffic.',
  params: [
    { k: 'length', label: 'Crossing length', type: 'len', def: F(40), min: 3, max: 40 },
    { k: 'width', label: 'Crosswalk width', type: 'len', def: F(10), min: 1.8, max: 6 },
    { k: 'raised', label: 'Raised crosswalk', type: 'bool', def: false },
  ],
  bbox: (p) => [-p.length / 2, -p.width / 2 - (p.raised ? 1.8 : 0), p.length / 2, p.width / 2 + (p.raised ? 1.8 : 0)],
  name: (p, f) => `${p.raised ? 'Raised crosswalk' : 'Crosswalk'} ${f(p.length)}`,
  svg(p, s) {
    const L = p.length, W = p.width;
    let out = hitRect(-L / 2, -W / 2, L / 2, W / 2, s);
    if (p.raised) {
      const ramp = 1.8;
      out += `<rect x="${n(-L / 2 * s)}" y="${n((-W / 2 - ramp) * s)}" width="${n(L * s)}" height="${n((W + 2 * ramp) * s)}" fill="${C.brick}" fill-opacity="0.55"/>
        <rect x="${n(-L / 2 * s)}" y="${n(-W / 2 * s)}" width="${n(L * s)}" height="${n(W * s)}" fill="${C.brick}"/>`;
    }
    return out + zebra(-L / 2, L / 2, 0, W, s);
  },
  warnings: (p, f) => (p.width < 1.8 ? [`Crosswalks should be at least ${f(1.8)} wide (MUTCD).`] : []),
  qty: (p) => ({ paint: zebraArea(p.length, p.width), asphalt: p.raised ? p.length * (p.width + 3.6) : 0 }),
};

const arrow = {
  kind: 'point', label: 'Lane arrow', group: 'Markings', key: null,
  hint: 'Points up (north) at 0°. Rotate it to match the lane.',
  params: [
    { k: 'kind', label: 'Arrow', type: 'select', def: 'straight', options: [
      ['straight', 'Straight'], ['left', 'Left turn'], ['right', 'Right turn'],
      ['straightLeft', 'Straight + left'], ['straightRight', 'Straight + right']] },
    { k: 'length', label: 'Length', type: 'len', def: F(10), min: 1.5, max: 6 },
  ],
  bbox: (p) => [-p.length * 0.45, -p.length / 2, p.length * 0.45, p.length / 2],
  name: (p) => `Arrow ${p.kind}`,
  svg(p, s) {
    const L = p.length * s, sw = n(0.22 * p.length / 2.9 * s), h = L * 0.22;
    const head = (x, y, dx, dy) => {
      const px = -dy, py = dx;
      return `<path d="M ${n(x + dx * h)} ${n(y + dy * h)} L ${n(x + px * h * 0.55)} ${n(y + py * h * 0.55)} L ${n(x - px * h * 0.55)} ${n(y - py * h * 0.55)} Z" fill="${C.paint}"/>`;
    };
    const st = `fill="none" stroke="${C.paint}" stroke-width="${sw}" stroke-linecap="butt"`;
    const turn = (dir) => {
      const ex = dir * L * 0.32, ey = -L * 0.18;
      return `<path d="M 0 ${n(L * 0.05)} Q 0 ${n(ey)} ${n(ex)} ${n(ey)}" ${st}/>${head(ex, ey, dir, 0)}`;
    };
    let out = hitRect(-p.length * 0.45, -p.length / 2, p.length * 0.45, p.length / 2, s);
    const hasStraight = p.kind === 'straight' || p.kind.startsWith('straight');
    out += `<line x1="0" y1="${n(L / 2)}" x2="0" y2="${n(hasStraight ? -L / 2 + h : L * 0.05)}" ${st}/>`;
    if (hasStraight) out += head(0, -L / 2 + h, 0, -1);
    if (/left/i.test(p.kind)) out += turn(-1);
    if (/right/i.test(p.kind)) out += turn(1);
    return out;
  },
  qty: (p) => ({ paint: 0.25 * p.length * 0.6 }),
};

const sharrow = {
  kind: 'point', label: 'Bike marking', group: 'Markings', key: null,
  hint: 'Shared-lane marking ("sharrow"). Chevrons point the direction of travel.',
  params: [{ k: 'length', label: 'Length', type: 'len', def: F(10), min: 1.5, max: 5 }],
  bbox: (p) => [-0.6 * p.length / 3.3, -p.length / 2, 0.6 * p.length / 3.3, p.length / 2],
  name: () => 'Bike marking',
  svg(p, s) {
    const k = (p.length / 3.3) * s, sw = n(0.18 * k);
    const st = `fill="none" stroke="${C.paint}" stroke-width="${sw}"`;
    const chev = (y) => `<polyline points="${n(-0.55 * k)},${n((y + 0.45) * k)} 0,${n(y * k)} ${n(0.55 * k)},${n((y + 0.45) * k)}" ${st}/>`;
    return `${hitRect(-0.6, -1.65, 0.6, 1.65, k)}${chev(-1.6)}${chev(-1.05)}
      <circle cx="0" cy="${n(0.0 * k)}" r="${n(0.42 * k)}" ${st}/>
      <circle cx="0" cy="${n(1.15 * k)}" r="${n(0.42 * k)}" ${st}/>
      <polyline points="0,${n(0 * k)} ${n(0.25 * k)},${n(0.6 * k)} 0,${n(1.15 * k)}" ${st}/>`;
  },
  qty: () => ({ paint: 0.4 }),
};

// ---------- streetscape ----------

const tree = {
  kind: 'point', label: 'Tree', group: 'Streetscape', key: null, noRotate: true,
  params: [{ k: 'diameter', label: 'Canopy diameter', type: 'len', def: F(20), min: 2, max: 15 }],
  bbox: (p) => [-p.diameter / 2, -p.diameter / 2, p.diameter / 2, p.diameter / 2],
  name: (p, f) => `Tree ${f(p.diameter)}`,
  svg(p, s) {
    const r = (p.diameter / 2) * s;
    return `<circle r="${n(r)}" fill="${C.canopy}" fill-opacity="0.9" stroke="#2c4f25" stroke-width="${n(0.2 * s)}"/>
      <circle cx="${n(-r * 0.2)}" cy="${n(-r * 0.2)}" r="${n(r * 0.55)}" fill="#55893f" fill-opacity="0.8"/>
      <circle r="${n(0.25 * s)}" fill="#5b4330"/>`;
  },
  qty: () => ({ trees: 1 }),
};

const parklet = {
  kind: 'point', label: 'Parklet', group: 'Streetscape', key: null,
  hint: 'The straight edge is the curb; the deck sits in the parking lane.',
  params: [
    { k: 'length', label: 'Length', type: 'len', def: F(20), min: 2, max: 20 },
    { k: 'depth', label: 'Depth', type: 'len', def: F(6), min: 1, max: 3 },
  ],
  bbox: (p) => [-p.length / 2, 0, p.length / 2, p.depth],
  name: (p, f) => `Parklet ${f(p.length)}`,
  svg(p, s) {
    const L = p.length, D = p.depth, pl = Math.min(0.6, L / 6);
    let planks = '';
    for (let x = -L / 2 + 0.5; x < L / 2 - 0.2; x += 0.5) {
      planks += `<line x1="${n(x * s)}" y1="0" x2="${n(x * s)}" y2="${n(D * s)}" stroke="#7d5e3c" stroke-width="${n(0.04 * s)}"/>`;
    }
    return `<rect x="${n(-L / 2 * s)}" y="0" width="${n(L * s)}" height="${n(D * s)}" fill="${C.wood}" ${curbStroke(s, 0.15)}/>${planks}
      <rect x="${n(-L / 2 * s)}" y="0" width="${n(pl * s)}" height="${n(D * s)}" fill="${C.green}"/>
      <rect x="${n((L / 2 - pl) * s)}" y="0" width="${n(pl * s)}" height="${n(D * s)}" fill="${C.green}"/>
      <rect x="${n(-L / 2 * s)}" y="${n((D - 0.3) * s)}" width="${n(L * s)}" height="${n(0.3 * s)}" fill="${C.green}"/>`;
  },
  warnings: (p, f) => (p.depth > 2.4 ? [`Parklets usually stay within the parking lane (about ${f(2.4)}).`] : []),
  qty: (p) => ({ deck: p.length * p.depth }),
};

const note = {
  kind: 'point', label: 'Note', group: 'Analysis', key: 'n',
  hint: 'Text label. It stays the same size on screen and exports as editable text.',
  params: [
    { k: 'text', label: 'Text', type: 'text', def: 'Note' },
    { k: 'size', label: 'Font size (px)', type: 'num', def: 14, min: 8, max: 48 },
    { k: 'box', label: 'Dark background', type: 'bool', def: true },
  ],
  bbox: (p, s) => {
    const w = (p.text.length * p.size * 0.56 + 12) / s / 2, h = (p.size + 10) / s / 2;
    return [-w, -h, w, h];
  },
  name: (p) => `Note “${p.text.length > 28 ? p.text.slice(0, 28) + '…' : p.text}”`,
  svg(p) {
    const w = p.text.length * p.size * 0.56 + 12, h = p.size + 10;
    const esc = p.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="4" fill="#111" fill-opacity="${p.box ? 0.75 : 0.001}"/>
      <text x="0" y="${n(p.size * 0.35)}" fill="#fff" font-family="Inter, system-ui, sans-serif" font-size="${p.size}" text-anchor="middle">${esc}</text>`;
  },
};

export const POINT_TYPES = { roundabout, mini, raised, diverter, bumpout, chicane, hump, refuge, crosswalk, arrow, sharrow, tree, parklet, note };
