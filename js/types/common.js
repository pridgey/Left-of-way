import { n } from '../geo.js';

export const COLORS = {
  asphalt: '#46484b',
  asphaltLight: '#5b5d60',
  curb: '#ece9e2',
  concrete: '#cdc6b8',
  apron: '#b48f6d',
  green: '#5f8a49',
  paint: '#ffffff',
  yellow: '#f0c330',
  brick: '#a8664c',
  bike: '#3f8f5c',
  bus: '#a8473c',
  wood: '#a07c52',
  canopy: '#3f6b34',
};

/**
 * Continental crosswalk crossing along x from x0 to x1, centered on y = yc.
 * Bars are 2 ft wide with 2 ft gaps and run parallel to traffic (along y).
 * gaps: [[a, b], ...] ranges along x with no bars (e.g. a refuge island).
 */
export function zebra(x0, x1, yc, bandW, s, gaps = []) {
  const bar = 0.6, gap = 0.6;
  const span = x1 - x0;
  const count = Math.max(1, Math.floor((span + gap) / (bar + gap)));
  const start = x0 + (span - (count * bar + (count - 1) * gap)) / 2;
  let out = '';
  for (let i = 0; i < count; i++) {
    const bx = start + i * (bar + gap);
    if (gaps.some(([a, b]) => bx + bar > a && bx < b)) continue;
    out += `<rect x="${n(bx * s)}" y="${n((yc - bandW / 2) * s)}" width="${n(bar * s)}" height="${n(bandW * s)}" fill="${COLORS.paint}"/>`;
  }
  return out;
}

/** Paint area (m²) of a zebra crosswalk, for quantity estimates. */
export function zebraArea(span, bandW) {
  const count = Math.max(1, Math.floor((span + 0.6) / 1.2));
  return count * 0.6 * bandW;
}

/** Bumpout-style shape: straight curb edge on y = 0, bulging to y = sign * depth. */
export function bumpPath(length, depth, taper, s, sign = 1) {
  const L = length / 2, D = depth * sign, T = Math.min(taper, L * 0.9);
  return `M ${n(-L * s)} 0
    C ${n((-L + T / 2) * s)} 0 ${n((-L + T / 2) * s)} ${n(D * s)} ${n((-L + T) * s)} ${n(D * s)}
    L ${n((L - T) * s)} ${n(D * s)}
    C ${n((L - T / 2) * s)} ${n(D * s)} ${n((L - T / 2) * s)} 0 ${n(L * s)} 0 Z`;
}

/** Invisible box so thin or striped elements are easy to click. Removed on export. */
export const hitRect = (x0, y0, x1, y1, s) =>
  `<rect x="${n(x0 * s)}" y="${n(y0 * s)}" width="${n((x1 - x0) * s)}" height="${n((y1 - y0) * s)}" fill="#000" fill-opacity="0.001" data-hit="1"/>`;

export const curbStroke = (s, w = 0.3) => `stroke="${COLORS.curb}" stroke-width="${n(w * s)}"`;
