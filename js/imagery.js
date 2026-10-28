// Aerial imagery sources, and fetching a single image of the current view for export.
import { HALF_WORLD } from './geo.js';

const USGS = 'https://imagery.nationalmap.gov/arcgis/rest/services';
const USGS_CACHED = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const ESRI = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=';

export const SOURCES = {
  naip: { label: 'USGS NAIP (free, no key)', service: 'USGSNAIPImagery', attribution: 'Imagery: USGS The National Map / USDA NAIP' },
  naipplus: { label: 'USGS NAIP Plus (sharper in some cities)', service: 'USGSNAIPPlus', attribution: 'Imagery: USGS The National Map / USDA NAIP / HRO' },
  esri: { label: 'Esri World Imagery (free key)', attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' },
  custom: { label: 'Custom tile server', attribution: 'Imagery: custom source' },
};

// ---------- tile memory ----------
// Leaflet drops tiles soon after they leave the screen, and the USGS ImageServer renders every
// request fresh, so panning back used to download them again. Loaded tile images are kept here
// and reused. Tiles near the design get a bigger budget so the work area stays loaded.
const KEEP_RADIUS = 300; // meters around anything drawn
const MAX_NEAR = 800, MAX_FAR = 300; // tiles kept near / away from the design
const tileCache = new Map(); // url -> { img, center, reach }; oldest first
let keepNear = () => [];

function rememberTile(url, img, bounds) {
  tileCache.delete(url);
  tileCache.set(url, { img, center: bounds.getCenter(), reach: bounds.getNorthWest().distanceTo(bounds.getSouthEast()) / 2 });
  if (tileCache.size > MAX_NEAR + MAX_FAR + 50) trimTiles(); // trim in batches, not on every tile
}

function trimTiles() {
  const pts = keepNear().map((p) => L.latLng(p[0], p[1]));
  const near = [], far = [];
  for (const [url, t] of tileCache) {
    if (t.img.parentNode) continue; // on screen right now
    (pts.some((p) => t.center.distanceTo(p) < KEEP_RADIUS + t.reach) ? near : far).push(url);
  }
  near.slice(0, Math.max(0, near.length - MAX_NEAR)).forEach((u) => tileCache.delete(u));
  far.slice(0, Math.max(0, far.length - MAX_FAR)).forEach((u) => tileCache.delete(u));
}

// A tile layer that reuses images it has already loaded.
const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const url = this.getTileUrl(coords);
    const hit = tileCache.get(url);
    if (hit && !hit.img.parentNode) {
      tileCache.delete(url);
      tileCache.set(url, hit);
      Promise.resolve().then(() => done(null, hit.img));
      return hit.img;
    }
    const img = L.TileLayer.prototype.createTile.call(this, coords, done);
    const bounds = this._tileCoordsToBounds(coords);
    img.addEventListener('load', () => rememberTile(url, img, bounds), { once: true });
    return img;
  },
  // Leaflet blanks a removed tile's src to cancel its download. Only do that for tiles still
  // downloading, so loaded ones can be reused.
  _removeTile(key) {
    const el = this._tiles[key]?.el;
    const base = el?.complete && el.naturalWidth ? L.GridLayer : L.TileLayer;
    return base.prototype._removeTile.call(this, key);
  },
});

// Tiles rendered on demand from a USGS ImageServer.
const ImageServerLayer = CachedTileLayer.extend({
  getTileUrl(c) {
    const size = (2 * HALF_WORLD) / 2 ** c.z;
    const minX = -HALF_WORLD + c.x * size, maxY = HALF_WORLD - c.y * size;
    const bbox = [minX, maxY - size, minX + size, maxY].join(',');
    return `${USGS}/${this.options.service}/ImageServer/exportImage?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=512,512&format=jpg&f=image`;
  },
});

/** keepNearFn returns [lat, lng] points of the design; tiles around them stay loaded longest. */
export function createImagery(map, onStatus = () => {}, keepNearFn = null) {
  if (keepNearFn) keepNear = keepNearFn;
  let layers = [];
  let cfg = null;

  // Report 'loading', 'ready' or 'error' so the page can say what's happening.
  function watch(layer) {
    let failed = 0, loaded = 0;
    layer.on('loading', () => { failed = 0; loaded = 0; onStatus('loading'); });
    layer.on('tileload', () => { loaded++; });
    layer.on('tileerror', (e) => {
      failed++;
      // busy servers drop the odd tile; try each one once more
      const img = e.tile;
      if (img.dataset.retried) return;
      img.dataset.retried = '1';
      setTimeout(() => { img.src = `${img.src}${img.src.includes('?') ? '&' : '?'}retry=1`; }, 1500);
    });
    layer.on('load', () => onStatus(failed && !loaded ? 'error' : 'ready'));
  }

  function tileTemplate() {
    if (cfg.source === 'esri') return cfg.esriKey ? ESRI + encodeURIComponent(cfg.esriKey) : null;
    if (cfg.source === 'custom') return cfg.customUrl || null;
    return null;
  }
  const nativeMax = () => (cfg.source === 'esri' ? 20 : cfg.source === 'custom' ? +cfg.customMax || 19 : 19);

  function apply(next) {
    cfg = { ...next };
    layers.forEach((l) => map.removeLayer(l));
    layers = [];
    const src = SOURCES[cfg.source];
    const tpl = tileTemplate();
    if (src.service || !tpl) {
      // USGS (also the fallback when a key or URL is missing)
      const service = src.service || 'USGSNAIPImagery';
      layers.push(new CachedTileLayer(USGS_CACHED, { maxZoom: 15, attribution: SOURCES.naip.attribution }));
      layers.push(new ImageServerLayer('', { service, minZoom: 16, maxNativeZoom: 19, maxZoom: 22, attribution: src.attribution }));
    } else {
      layers.push(new CachedTileLayer(tpl, { maxNativeZoom: nativeMax(), maxZoom: 22, attribution: src.attribution, crossOrigin: 'anonymous' }));
    }
    layers.forEach((l) => { watch(l); l.addTo(map); });
    return src.service || tpl ? null : 'Add a key or tile URL to use this source. Showing USGS for now.';
  }

  const attribution = () => SOURCES[cfg.source].attribution;

  /** One image of exactly the current view, as a data URL, at `scale` x screen resolution. */
  async function exportBackground(scale) {
    const size = map.getSize();
    const tpl = tileTemplate();
    if (SOURCES[cfg.source].service || !tpl) {
      const service = SOURCES[cfg.source].service || 'USGSNAIPImagery';
      const b = map.getBounds();
      const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
      const k = Math.min(scale, 4000 / Math.max(size.x, size.y));
      const url = `${USGS}/${service}/ImageServer/exportImage?bbox=${sw.x},${sw.y},${ne.x},${ne.y}&bboxSR=3857&imageSR=3857`
        + `&size=${Math.round(size.x * k)},${Math.round(size.y * k)}&format=jpg&compressionQuality=85&f=image`;
      const res = await fetch(url);
      if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) throw new Error('imagery request failed');
      return blobToDataUrl(await res.blob());
    }
    return stitchTiles(tpl, scale);
  }

  async function stitchTiles(tpl, scale) {
    const size = map.getSize();
    const z = Math.round(map.getZoom());
    const tz = Math.min(z + Math.round(Math.log2(scale)), nativeMax());
    const f = 2 ** (z - tz); // tile size at zoom z, in units of 256 px
    const pb = map.getPixelBounds();
    const k = scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size.x * k);
    canvas.height = Math.round(size.y * k);
    const g = canvas.getContext('2d');
    const t = 256 * f;
    const jobs = [];
    for (let tx = Math.floor(pb.min.x / t); tx <= Math.floor(pb.max.x / t); tx++) {
      for (let ty = Math.floor(pb.min.y / t); ty <= Math.floor(pb.max.y / t); ty++) {
        const url = L.Util.template(tpl, { z: tz, x: tx, y: ty, '-y': 2 ** tz - 1 - ty, s: 'a' });
        jobs.push(loadImage(url).then((img) => g.drawImage(img, (tx * t - pb.min.x) * k, (ty * t - pb.min.y) * k, t * k, t * k)));
      }
    }
    const results = await Promise.allSettled(jobs);
    if (results.every((r) => r.status === 'rejected')) throw new Error('could not load imagery tiles');
    try {
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch {
      throw new Error("this tile server doesn't allow its images to be exported (no CORS)");
    }
  }

  return { apply, attribution, exportBackground };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
