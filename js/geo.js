// Geometry helpers shared by the element types and the app.

export const M2FT = 3.28084;
export const HALF_WORLD = 20037508.342789244;
const M_PER_DEG_LAT = 111320;
const RAD = Math.PI / 180;

/** Screen pixels per meter at a latitude and zoom (Web Mercator). */
export const ppmAt = (lat, zoom) => (256 * 2 ** zoom) / (40075016.686 * Math.cos(lat * RAD));

/** Round for compact SVG output. */
export const n = (v) => +v.toFixed(2);

/** Move a lat/lng by meters east and north. */
export function offsetLL(lat, lng, east, north) {
  return [lat + north / M_PER_DEG_LAT, lng + east / (M_PER_DEG_LAT * Math.cos(lat * RAD))];
}

/** Lat/lng -> local meters (x east, y south) relative to an origin. */
export function llToMeters(lat0, lng0, lat, lng) {
  return [(lng - lng0) * M_PER_DEG_LAT * Math.cos(lat0 * RAD), -(lat - lat0) * M_PER_DEG_LAT];
}

/** A point element's local meters (x right, y down, before rotation) -> lat/lng. */
export function localToLL(el, x, y) {
  const a = el.rot * RAD, c = Math.cos(a), s = Math.sin(a);
  return offsetLL(el.lat, el.lng, x * c - y * s, -(x * s + y * c));
}

/** Compass bearing (degrees clockwise from north) -> unit vector in screen space (y down). */
export const bearingVec = (deg) => [Math.sin(deg * RAD), -Math.cos(deg * RAD)];
/** Unit vector (y down) -> compass bearing. */
export const vecBearing = (dx, dy) => ((Math.atan2(dx, -dy) / RAD) + 360) % 360;

export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Turn a list of points into a dense list of samples {x, y, s} (s = distance along).
 * smooth: Catmull-Rom curve through the points.
 * startDir / endDir: optional unit vectors forcing the direction of travel at the ends
 * (used so roads leave a roundabout leg in a straight line).
 */
export function samplePath(pts, { smooth = true, closed = false, step = 4, startDir = null, endDir = null } = {}) {
  if (pts.length < 2) return pts.map((p) => ({ x: p[0], y: p[1], s: 0 }));
  let raw = [];
  if (!smooth || (pts.length < 3 && !startDir && !endDir)) {
    raw = pts.map((p) => [p[0], p[1]]);
    if (closed) raw.push([pts[0][0], pts[0][1]]);
  } else {
    const P = pts.map((p) => [p[0], p[1]]);
    let ctrl;
    if (closed) {
      ctrl = [P[P.length - 1], ...P, P[0], P[1]];
    } else {
      const d0 = dist(P[0], P[1]), dn = dist(P[P.length - 2], P[P.length - 1]);
      const first = startDir ? [P[0][0] - startDir[0] * d0, P[0][1] - startDir[1] * d0] : [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]];
      const L = P.length - 1;
      const last = endDir ? [P[L][0] + endDir[0] * dn, P[L][1] + endDir[1] * dn] : [2 * P[L][0] - P[L - 1][0], 2 * P[L][1] - P[L - 1][1]];
      ctrl = [first, ...P, last];
    }
    for (let i = 1; i < ctrl.length - 2; i++) {
      const [p0, p1, p2, p3] = [ctrl[i - 1], ctrl[i], ctrl[i + 1], ctrl[i + 2]];
      const steps = Math.max(2, Math.ceil(dist(p1, p2) / step));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        raw.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t
          + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    const end = closed ? ctrl[ctrl.length - 2] : ctrl[ctrl.length - 2];
    raw.push([end[0], end[1]]);
  }
  const out = [];
  let s = 0;
  for (const p of raw) {
    const prev = out[out.length - 1];
    if (prev) {
      const d = Math.hypot(p[0] - prev.x, p[1] - prev.y);
      if (d < 0.01) continue;
      s += d;
    }
    out.push({ x: p[0], y: p[1], s });
  }
  return out;
}

/** Per-sample right-hand normals, with miter scaling so offsets keep a constant width at bends. */
export function normals(samples) {
  const N = samples.length;
  const segDir = [];
  for (let i = 0; i < N - 1; i++) {
    const dx = samples[i + 1].x - samples[i].x, dy = samples[i + 1].y - samples[i].y;
    const L = Math.hypot(dx, dy) || 1;
    segDir.push([dx / L, dy / L]);
  }
  return samples.map((_, i) => {
    const a = segDir[Math.max(0, i - 1)] || [1, 0];
    const b = segDir[Math.min(N - 2, i)] || a;
    // right-hand normal of (dx, dy) in screen space is (-dy, dx)
    let nx = -a[1] - b[1], ny = a[0] + b[0];
    const L = Math.hypot(nx, ny);
    if (L < 1e-6) { nx = -b[1]; ny = b[0]; } else { nx /= L; ny /= L; }
    const miter = 1 / Math.max(0.35, nx * -b[1] + ny * b[0]);
    return [nx * miter, ny * miter];
  });
}

/** Offset samples sideways. offsets: number or per-sample array (positive = right of travel). */
export function offsetPts(samples, norms, offsets) {
  return samples.map((p, i) => {
    const o = typeof offsets === 'number' ? offsets : offsets[i];
    return [p.x + norms[i][0] * o, p.y + norms[i][1] * o];
  });
}

/** Position and direction at distance s along the samples. */
export function frameAt(samples, s) {
  const last = samples.length - 1;
  s = Math.max(0, Math.min(samples[last].s, s));
  let i = 0;
  while (i < last - 1 && samples[i + 1].s < s) i++;
  const a = samples[i], b = samples[Math.min(i + 1, last)];
  const seg = (b.s - a.s) || 1;
  const t = (s - a.s) / seg;
  const tx = (b.x - a.x) / seg, ty = (b.y - a.y) / seg;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx, ty, nx: -ty, ny: tx };
}

export const pathD = (pts, close = false) =>
  pts.length ? `M ${pts.map((p) => `${n(p[0])} ${n(p[1])}`).join(' L ')}${close ? ' Z' : ''}` : '';

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export const polylineLength = (pts) => pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i], p), 0);

/** Distance from point p to segment ab. */
export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
