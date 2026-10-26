// Search box: pasted Google Maps links / coordinates, addresses (Nominatim),
// and street intersections (Overpass: nodes shared by two named streets).

const NOMINATIM = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=us';
// Public Overpass servers, tried in order (the main one is often busy).
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const esc = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

async function geocode(q, limit = 5) {
  const res = await fetch(`${NOMINATIM}&limit=${limit}&q=${encodeURIComponent(q)}`);
  return (await res.json()).map((h) => ({ label: h.display_name, lat: +h.lat, lng: +h.lon }));
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 25000);
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ac.signal })
        .finally(() => clearTimeout(timer));
      if (res.ok) return (await res.json()).elements || [];
      lastErr = new Error(`street lookup failed (${res.status})`);
    } catch (err) { lastErr = err.name === 'AbortError' ? new Error('street lookup timed out') : err; }
  }
  throw lastErr;
}

const STREET_SUFFIX = /\s+(street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct|parkway|pkwy|highway|hwy|terrace|ter|circle|cir)\.?$/i;
const STREET_PREFIX = /^(n|s|e|w|north|south|east|west)\.?\s+/i;
// "E Colfax Ave" -> "Colfax", so it matches OSM's "East Colfax Avenue".
const streetCore = (s) => s.trim().replace(STREET_PREFIX, '').replace(STREET_SUFFIX, '').trim() || s.trim();
// Escape for a regex that itself sits inside an Overpass "quoted string" (hence doubled).
const escRegex = (s) => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\\\$&');

/** A pasted Google Maps link (".../@39.74,-104.98,19z" or "!3d39.74!4d-104.98") or "lat, lng". */
export function parseCoords(q) {
  const m = q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || q.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function parseIntersection(q) {
  const m = q.match(/^(.+?)\s+(?:and|at)\s+(.+)$/i) || q.match(/^(.+?)\s*[&@/]\s*(.+)$/);
  if (!m) return null;
  const [streetB, ...place] = m[2].split(',');
  return { a: m[1].trim(), b: streetB.trim(), place: place.join(',').trim() };
}

async function intersectionSearch(map, { a, b, place }) {
  let center;
  if (place) {
    const hit = (await geocode(place, 1))[0];
    if (!hit) throw new Error(`Couldn't find "${place}"`);
    center = hit;
  } else if (map.getZoom() >= 10) {
    center = map.getCenter();
  } else {
    throw new Error('Add a city, e.g. "Main St & 5th Ave, Springfield"');
  }
  const around = `around:10000,${center.lat},${center.lng}`;
  const re = (s) => `"name"~"\\\\b${escRegex(streetCore(s))}\\\\b",i`;
  const query = `[out:json][timeout:25];
    way["highway"][${re(a)}](${around})->.a;
    way["highway"][${re(b)}](${around})->.b;
    node(w.a)(w.b);out;`;
  const nodes = await overpass(query);
  // Divided roads meet at several nodes; merge ones within ~60 m.
  const here = L.latLng(center.lat, center.lng);
  const spots = [];
  for (const nd of nodes) {
    const ll = L.latLng(nd.lat, nd.lon);
    if (!spots.some((s) => s.distanceTo(ll) < 60)) spots.push(ll);
  }
  spots.sort((p, q) => p.distanceTo(here) - q.distanceTo(here));
  return spots.slice(0, 8).map((ll) => ({
    label: `${a} & ${b}, ${(ll.distanceTo(here) / 1609.34).toFixed(1)} mi from ${place || 'map center'}`,
    lat: ll.lat, lng: ll.lng,
  }));
}

export function setupSearch(map, form, input, results) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const coords = parseCoords(q);
    if (coords) { map.setView([coords.lat, coords.lng], 19); results.hidden = true; return; }
    const cross = parseIntersection(q);
    results.hidden = false;
    results.innerHTML = cross
      ? '<li class="muted">Looking up intersection… this can take up to a minute.</li>'
      : '<li class="muted">Searching…</li>';
    try {
      let hits = cross ? await intersectionSearch(map, cross) : await geocode(q);
      if (!hits.length && cross) hits = await geocode(q); // maybe "&" was part of a place name
      if (!hits.length) {
        results.innerHTML = '<li class="muted">No results. For intersections try "Main St & 5th Ave, City".</li>';
        return;
      }
      results.innerHTML = hits.map((h, i) => `<li data-i="${i}">${esc(h.label)}</li>`).join('');
      results.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
        const h = hits[+li.dataset.i];
        map.setView([h.lat, h.lng], 19);
        results.hidden = true;
      }));
    } catch (err) {
      results.innerHTML = `<li class="muted">Search failed: ${esc(err.message)}.
        Tip: paste a Google Maps link or "lat, lng" to jump straight there.</li>`;
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#search')) results.hidden = true; });
}
