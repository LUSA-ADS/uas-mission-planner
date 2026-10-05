/*
 * terrain.js — terrain elevation lookup and clearance check. Exposes window.MPTerrain.
 *
 * Elevation comes from the open "Terrarium" terrain tiles on AWS (no key, CORS enabled).
 * Each tile is a PNG whose RGB encodes metres: elevation = R*256 + G + B/256 - 32768.
 * Tiles are decoded in the browser and sampled with bilinear interpolation.
 * The data is a global DEM (about 10-30 m resolution): a guide, not survey-grade.
 */
(function (root) {
  'use strict';

  const TILE_URL = (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
  const MAX_Z = 14, MIN_Z = 8, MAX_TILES = 30, MAX_SAMPLES = 3000;
  const rad = Math.PI / 180;
  const cache = new Map(); // "z/x/y" -> Promise<Float32Array(65536)>

  function loadTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (cache.has(key)) return cache.get(key);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, 256, 256).data;
          const e = new Float32Array(65536);
          for (let i = 0; i < 65536; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          resolve(e);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('Could not load elevation tile ' + key));
      img.src = TILE_URL(z, x, y);
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    return p;
  }

  function worldPx(lat, lon, z) {
    const s = 256 * Math.pow(2, z);
    const sin = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * rad);
    return { x: (lon + 180) / 360 * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  }

  function tilesFor(points, z) {
    const set = new Set();
    points.forEach((pt) => {
      const w = worldPx(pt.lat, pt.lon, z);
      [-1, 0, 1].forEach((dx) => [-1, 0, 1].forEach((dy) => {
        set.add(Math.floor((w.x + dx * 0.5) / 256) + ',' + Math.floor((w.y + dy * 0.5) / 256));
      }));
    });
    return set;
  }

  function chooseZoom(points) {
    for (let z = MAX_Z; z > MIN_Z; z--) if (tilesFor(points, z).size <= MAX_TILES) return z;
    return MIN_Z;
  }

  /** Ground elevation (m AMSL) for each {lat, lon}. */
  async function elevations(points) {
    if (!points.length) return { values: [], zoom: MAX_Z };
    const z = chooseZoom(points);
    const n = Math.pow(2, z);
    const tiles = new Map();
    await Promise.all([...tilesFor(points, z)].map(async (k) => {
      const [tx, ty] = k.split(',').map(Number);
      if (ty < 0 || ty >= n) return;
      tiles.set(((tx % n) + n) % n + ',' + ty, await loadTile(z, ((tx % n) + n) % n, ty));
    }));
    const size = 256 * n;
    const pix = (px, py) => {
      px = ((px % size) + size) % size;
      py = Math.max(0, Math.min(size - 1, py));
      const t = tiles.get(Math.floor(px / 256) + ',' + Math.floor(py / 256));
      return t ? t[(py % 256) * 256 + (px % 256)] : 0;
    };
    const values = points.map((pt) => {
      const w = worldPx(pt.lat, pt.lon, z);
      const fx = w.x - 0.5, fy = w.y - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const top = pix(x0, y0) * (1 - tx) + pix(x0 + 1, y0) * tx;
      const bot = pix(x0, y0 + 1) * (1 - tx) + pix(x0 + 1, y0 + 1) * tx;
      return top * (1 - ty) + bot * ty;
    });
    return { values, zoom: z };
  }

  function dist(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Sample the route and look up ground elevation.
   * route: [{lat, lon, alt, frame, cmd, id, n}] in flight order (n = item number shown to the user).
   * home:  {lat, lon}
   */
  async function profile(route, home, step) {
    const segLen = [];
    let total = 0;
    for (let i = 0; i + 1 < route.length; i++) { const d = dist(route[i], route[i + 1]); segLen.push(d); total += d; }
    const st = Math.max(step || 15, total / MAX_SAMPLES, 1);
    const samples = [];
    let cum = 0;
    route.forEach((r, i) => { r.d = cum; if (i < segLen.length) cum += segLen[i]; });
    if (route.length === 1) samples.push({ seg: 0, t: 0, lat: route[0].lat, lon: route[0].lon, d: 0 });
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      const k = Math.max(1, Math.ceil(segLen[i] / st));
      for (let j = i === 0 ? 0 : 1; j <= k; j++) {
        const t = j / k;
        samples.push({ seg: i, t, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, d: a.d + segLen[i] * t });
      }
    }
    const pts = samples.concat(route.map((r) => ({ lat: r.lat, lon: r.lon })), [{ lat: home.lat, lon: home.lon }]);
    const el = await elevations(pts);
    samples.forEach((s, i) => { s.ground = el.values[i]; });
    route.forEach((r, i) => { r.ground = el.values[samples.length + i]; });
    return { samples, route, total, zoom: el.zoom, homeGround: el.values[el.values.length - 1] };
  }

  /**
   * Work out flight altitude and clearance everywhere.
   * Frames: 0 = AMSL, 10 = above terrain, anything else (3) = relative to home.
   * opts: {homeGround, minClear, maxAgl}
   */
  function evaluate(prof, opts) {
    const { route, samples } = prof;
    const hg = Number(opts.homeGround);
    const minClear = Number(opts.minClear) || 0;
    const maxAgl = Number(opts.maxAgl) || 0;
    const amsl = (r) => (Number(r.frame) === 0 ? Number(r.alt) : Number(r.frame) === 10 ? r.ground + Number(r.alt) : hg + Number(r.alt));
    const classify = (agl, exempt) => {
      if (exempt) return 'ok';
      if (agl < 0) return 'under';
      if (agl < minClear) return 'low';
      if (maxAgl && agl > maxAgl) return 'high';
      return 'ok';
    };
    const ev = samples.map((s) => {
      const a = route[s.seg], b = route[Math.min(s.seg + 1, route.length - 1)];
      let flight;
      if (Number(a.frame) === 10 && Number(b.frame) === 10) flight = s.ground + Number(a.alt) + (Number(b.alt) - Number(a.alt)) * s.t;
      else flight = amsl(a) + (amsl(b) - amsl(a)) * s.t;
      const exempt = a.cmd === 21 || b.cmd === 21; // descent to a landing point
      const agl = flight - s.ground;
      return Object.assign({}, s, { flight, agl, exempt, status: classify(agl, exempt) });
    });
    const wps = route.map((r) => {
      const flight = amsl(r);
      const agl = flight - r.ground;
      const land = r.cmd === 21;
      return { n: r.n, id: r.id, d: r.d, alt: r.alt, frame: r.frame, cmd: r.cmd, ground: r.ground, flight, agl, status: land ? 'land' : classify(agl, false) };
    });
    // runs of consecutive problem samples
    const runs = [];
    let cur = null;
    ev.forEach((s, i) => {
      if (s.status === 'ok') { cur = null; return; }
      if (!cur || cur.kind !== s.status) { cur = { kind: s.status, from: i, to: i, worst: s.agl, seg0: s.seg, seg1: s.seg }; runs.push(cur); }
      cur.to = i; cur.seg1 = s.seg;
      cur.worst = s.status === 'high' ? Math.max(cur.worst, s.agl) : Math.min(cur.worst, s.agl);
    });
    const live = ev.filter((s) => !s.exempt);
    let min = null, max = null;
    live.forEach((s) => { if (!min || s.agl < min.agl) min = s; if (!max || s.agl > max.agl) max = s; });
    return { samples: ev, wps, runs, min, max, homeGround: hg, total: prof.total };
  }

  root.MPTerrain = { profile, evaluate, elevations };
})(typeof window !== 'undefined' ? window : globalThis);
