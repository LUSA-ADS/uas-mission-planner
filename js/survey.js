/*
 * survey.js — survey (grid) mission maths, like Mission Planner's "Survey (Grid)".
 * Pure functions, no DOM. Exposes window.MPSurvey.
 *
 *   camera + altitude + overlaps  ->  footprint, GSD, line spacing, trigger distance
 *   polygon + angle + spacing     ->  serpentine list of waypoints covering the polygon
 */
(function (root) {
  'use strict';

  const R = 6371000;
  const rad = Math.PI / 180;
  const MAX_LINES = 400;

  // Typical values. sw >= sh is the physical sensor size in mm, focal is the real
  // (not 35 mm equivalent) focal length, iw x ih is the image size in pixels.
  const CAMERAS = [
    { id: 'sony-a6000-16', name: 'Sony A6000, 16 mm lens', sw: 23.5, sh: 15.6, focal: 16, iw: 6000, ih: 4000 },
    { id: 'dji-p4p', name: 'DJI Phantom 4 Pro / Pro V2', sw: 13.2, sh: 8.8, focal: 8.8, iw: 5472, ih: 3648 },
    { id: 'dji-m2p', name: 'DJI Mavic 2 Pro', sw: 13.2, sh: 8.8, focal: 10.3, iw: 5472, ih: 3648 },
    { id: 'dji-m3e', name: 'DJI Mavic 3 Enterprise (wide)', sw: 17.3, sh: 13, focal: 12.3, iw: 5280, ih: 3956 },
    { id: 'dji-p4', name: 'DJI Phantom 4', sw: 6.17, sh: 4.55, focal: 3.6, iw: 4000, ih: 3000 },
    { id: 'parrot-anafi', name: 'Parrot Anafi', sw: 6.17, sh: 4.55, focal: 4, iw: 5344, ih: 4016 },
    { id: 'custom', name: 'Custom (enter values)', sw: 13.2, sh: 8.8, focal: 8.8, iw: 5472, ih: 3648 },
  ];
  const cameraById = (id) => CAMERAS.find((c) => c.id === id);

  /** Ground footprint of one image and the derived spacings. portrait = long side along the flight line. */
  function footprint(cam, alt, front, side, portrait) {
    const sw = Number(cam.sw), sh = Number(cam.sh), f = Number(cam.focal);
    if (!(sw > 0 && sh > 0 && f > 0 && alt > 0)) return null;
    const across = (portrait ? sh : sw) * alt / f;
    const along = (portrait ? sw : sh) * alt / f;
    const px = (portrait ? Number(cam.ih) : Number(cam.iw)) || 0; // pixels across track
    return {
      across, along,
      gsd: px > 0 ? across / px * 100 : NaN, // cm per pixel
      spacing: across * (1 - side / 100),
      trigger: along * (1 - front / 100),
    };
  }

  // ---- local metric projection around a reference point
  function projector(points) {
    const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon0 = points.reduce((s, p) => s + p.lon, 0) / points.length;
    const kx = R * rad * Math.cos(lat0 * rad), ky = R * rad;
    return {
      fwd: (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }),
      inv: (q) => ({ lat: lat0 + q.y / ky, lon: lon0 + q.x / kx }),
    };
  }

  /** Compass bearing (0-180) of the polygon's longest edge: flying along it gives the fewest turns. */
  function longestEdgeAngle(poly) {
    if (poly.length < 3) return 0;
    const pr = projector(poly);
    const q = poly.map(pr.fwd);
    let best = 0, ang = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > best) { best = d; ang = (Math.atan2(b.x - a.x, b.y - a.y) / rad + 360) % 180; }
    }
    return Math.round(ang);
  }

  /**
   * Generate the serpentine path.
   * poly: [{lat, lon}], opts: {angle (compass deg of the flight lines), spacing (m), overshoot (m), reverse (bool)}
   * returns {points: [{lat, lon}], lines, length} or {error}
   */
  function generate(poly, opts) {
    if (!poly || poly.length < 3) return { error: 'Draw the survey area first (at least 3 corners).' };
    const spacing = Number(opts.spacing);
    if (!(spacing > 0.5)) return { error: 'Line spacing is too small. Check the camera, altitude and side overlap.' };
    const over = Math.max(0, Number(opts.overshoot) || 0);
    const a = (Number(opts.angle) || 0) * rad;
    const pr = projector(poly);
    const q = poly.map(pr.fwd);
    // u = along the flight lines, v = across them
    const d = { x: Math.sin(a), y: Math.cos(a) };
    const n = { x: Math.cos(a), y: -Math.sin(a) };
    const P = q.map((p) => ({ u: p.x * d.x + p.y * d.y, v: p.x * n.x + p.y * n.y }));
    const vmin = Math.min(...P.map((p) => p.v)), vmax = Math.max(...P.map((p) => p.v));
    const count = Math.max(1, Math.ceil((vmax - vmin) / spacing));
    if (count > MAX_LINES) return { error: `That would need ${count} flight lines. Increase the spacing or draw a smaller area.` };
    const first = vmin + ((vmax - vmin) - (count - 1) * spacing) / 2;

    const lines = [];
    for (let k = 0; k < count; k++) {
      const c = first + k * spacing + 1e-6;
      const us = [];
      for (let i = 0; i < P.length; i++) {
        const p1 = P[i], p2 = P[(i + 1) % P.length];
        if ((p1.v <= c) !== (p2.v <= c)) us.push(p1.u + (c - p1.v) / (p2.v - p1.v) * (p2.u - p1.u));
      }
      us.sort((x, y) => x - y);
      const segs = [];
      for (let i = 0; i + 1 < us.length; i += 2) segs.push([us[i] - over, us[i + 1] + over, c]);
      if (segs.length) lines.push(segs);
    }
    if (!lines.length) return { error: 'The grid does not intersect the area. Check the polygon.' };
    if (opts.reverse) lines.reverse();

    const pts = [];
    lines.forEach((segs, k) => {
      const forward = k % 2 === 0;
      const ordered = forward ? segs : segs.slice().reverse();
      ordered.forEach(([u0, u1, c]) => {
        const s = forward ? [u0, u1] : [u1, u0];
        s.forEach((u) => pts.push({ x: u * d.x + c * n.x, y: u * d.y + c * n.y }));
      });
    });

    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return {
      points: pts.map((p) => {
        const ll = pr.inv(p);
        return { lat: Math.round(ll.lat * 1e7) / 1e7, lon: Math.round(ll.lon * 1e7) / 1e7 };
      }),
      lines: lines.length,
      length,
    };
  }

  root.MPSurvey = { CAMERAS, cameraById, footprint, generate, longestEdgeAngle };
})(typeof window !== 'undefined' ? window : globalThis);
