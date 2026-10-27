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

// Tiles rendered on demand from a USGS ImageServer.
const ImageServerLayer = L.TileLayer.extend({
  getTileUrl(c) {
    const size = (2 * HALF_WORLD) / 2 ** c.z;
    const minX = -HALF_WORLD + c.x * size, maxY = HALF_WORLD - c.y * size;
    const bbox = [minX, maxY - size, minX + size, maxY].join(',');
    return `${USGS}/${this.options.service}/ImageServer/exportImage?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=512,512&format=jpg&f=image`;
  },
});

export function createImagery(map, onStatus = () => {}) {
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
      layers.push(L.tileLayer(USGS_CACHED, { maxZoom: 15, attribution: SOURCES.naip.attribution }));
      layers.push(new ImageServerLayer('', { service, minZoom: 16, maxNativeZoom: 19, maxZoom: 22, attribution: src.attribution }));
    } else {
      layers.push(L.tileLayer(tpl, { maxNativeZoom: nativeMax(), maxZoom: 22, attribution: src.attribution, crossOrigin: 'anonymous' }));
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
