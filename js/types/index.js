import { POINT_TYPES, makeLegs } from './points.js';
import { PATH_TYPES } from './paths.js';

export const TYPES = { ...POINT_TYPES, ...PATH_TYPES };

export const GROUPS = ['Intersections', 'Streets', 'Traffic calming', 'Markings', 'Streetscape', 'Analysis'];

// 24x24 line icons, drawn with currentColor.
const I = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
  select: I('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  roundabout: I('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>'),
  mini: I('<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  raised: I('<rect x="5" y="5" width="14" height="14" rx="1"/><path d="M8 5v3M11 5v3M14 5v3M17 5v3M8 16v3M11 16v3M14 16v3"/>'),
  diverter: I('<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="2 2"/><path d="M6 6l4.5 4.5M13.5 13.5L18 18" stroke-width="3"/>'),
  segment: I('<path d="M3 20C8 14 10 8 21 4"/><path d="M3 15C7 10 9 5 17 2" stroke-dasharray="2 2"/>'),
  patch: I('<path d="M5 6l9-2 6 7-4 9-10-2z" fill="currentColor" fill-opacity="0.25"/>'),
  bumpout: I('<path d="M3 6h18"/><path d="M5 6c2 0 2 6 4 6h6c2 0 2-6 4-6"/>'),
  chicane: I('<path d="M3 4h18M3 20h18"/><path d="M3 4c2 0 2 5 4 5h3c2 0 2-5 4-5M10 20c2 0 2-5 4-5h3c2 0 2 5 4 5"/>'),
  hump: I('<path d="M2 17h4c2-6 10-6 12 0h4"/>'),
  refuge: I('<rect x="7" y="10" width="10" height="4" rx="2"/><path d="M12 3v4M12 17v4"/>'),
  crosswalk: I('<path d="M5 4v16M9 4v16M13 4v16M17 4v16"/>'),
  arrow: I('<path d="M12 21V8M7 12l5-6 5 6"/>'),
  sharrow: I('<circle cx="12" cy="15" r="2"/><circle cx="12" cy="21" r="1.5"/><path d="M8 8l4-3 4 3M8 12l4-3 4 3"/>'),
  tree: I('<circle cx="12" cy="11" r="7"/><path d="M12 11v10"/>'),
  parklet: I('<rect x="3" y="8" width="18" height="8"/><path d="M7 8v8M11 8v8M15 8v8"/>'),
  vehicle: I('<path d="M4 20c0-8 6-14 16-14" stroke-dasharray="3 2"/><rect x="13" y="3" width="8" height="5" rx="1"/>'),
  dimension: I('<path d="M3 12h18M3 8v8M21 8v8"/>'),
  note: I('<path d="M4 5h16v11H9l-5 4z"/>'),
};

/** Bring older saved elements up to date. */
export function migrateElement(el) {
  if ((el.type === 'roundabout' || el.type === 'mini') && !Array.isArray(el.p.legs)) {
    el.p.legs = makeLegs(el.p.legs || 4, el.p.approach || (el.type === 'mini' ? 9 : 11));
    el.p.legs.forEach((l) => { l.crosswalk = false; });
    delete el.p.approach;
  }
  // fill in any parameters added since the element was saved
  const t = TYPES[el.type];
  if (!t) return null;
  for (const d of t.params) if (el.p[d.k] === undefined) el.p[d.k] = d.def;
  if (t.defaults) for (const [k, v] of Object.entries(t.defaults())) if (el.p[k] === undefined) el.p[k] = v;
  return el;
}

export function newParams(type) {
  const t = TYPES[type];
  return { ...Object.fromEntries(t.params.map((d) => [d.k, d.def])), ...(t.defaults ? t.defaults() : {}) };
}
