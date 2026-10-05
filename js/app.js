/*
 * app.js — UI for the UAS Flight Planning (mission, geofence, rally points).
 * Depends on Leaflet (L) and formats.js (MPFormats).
 */
(function () {
  'use strict';

  const F = window.MPFormats;
  const G = F.geo;
  const SV = window.MPSurvey;
  const TR = window.MPTerrain;

  // ------------------------------------------------------------ settings
  // Starting map view when there is no saved plan. Change to your training area.
  const DEFAULT_VIEW = { lat: 55.7105, lon: 13.2100, zoom: 15 };
  const STORAGE_KEY = 'uas-mission-planner/v1';
  const MAX_HISTORY = 100;

  // --------------------------------------------------------------- state
  let uid = 1;
  const nid = () => uid++;

  function defaultSurvey() {
    const c = SV.cameraById('sony-a6000-16');
    return {
      area: [],                       // [{lat, lon}] survey polygon
      camera: c.id,
      cam: { sw: c.sw, sh: c.sh, focal: c.focal, iw: c.iw, ih: c.ih },
      alt: 80, front: 75, side: 65,   // altitude (m, relative to home), overlaps (%)
      angle: 0,                       // compass bearing of the flight lines
      portrait: 0, overshoot: 0, trigger: true, reverse: false,
      sig: null,                      // settings the current survey waypoints were generated from
    };
  }

  function blankState() {
    return {
      planName: 'training-mission',
      home: null, // {lat, lon, alt}
      settings: { defaultAlt: 50, defaultFrame: 3, speed: 10, maxAlt: 120, rallyAlt: 30, circleRadius: 100 },
      mission: [], // {id, cmd, frame, p:[4], lat, lon, alt}
      fence: { returnPoint: null, polygons: [], circles: [] },
      rally: [], // {id, lat, lon, alt}
      survey: defaultSurvey(),
    };
  }

  let state = loadLocal() || blankState();
  const ui = {
    mode: 'mission',
    tool: null,      // 'wp' | 'home' | 'poly-inclusion' | 'poly-exclusion' | 'circle-inclusion' | 'circle-exclusion' | 'return' | 'rally'
    sel: null,       // {kind: 'wp'|'poly'|'circle'|'rally', id}
    drawing: null,   // id of polygon being drawn
    showLegs: true,
    surveyOpen: false, // Survey card expanded
  };
  const history = [];

  function reindexIds() {
    let max = 0;
    const all = [].concat(state.mission, state.rally, state.fence.polygons, state.fence.circles);
    all.forEach((o) => { if (!o.id) o.id = 0; max = Math.max(max, o.id); });
    uid = max + 1;
    all.forEach((o) => { if (!o.id) o.id = nid(); });
  }
  reindexIds();

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > MAX_HISTORY) history.shift();
  }

  /** Apply a change to the plan with undo support. */
  function mutate(fn) {
    snapshot();
    fn();
    changed();
  }

  function changed() {
    if (layers && layers.terrain) layers.terrain.clearLayers(); // highlights belong to the plan they were checked for
    saveLocal();
    scheduleRender();
  }

  function undo() {
    if (!history.length) return toast('Nothing to undo');
    state = JSON.parse(history.pop());
    if (ui.drawing && !findPoly(ui.drawing)) { ui.drawing = null; setTool(null); }
    if (ui.sel && !selectedObject()) ui.sel = null;
    changed();
  }

  function saveLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function loadLocal() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      const obj = JSON.parse(s);
      return normalizeState(obj);
    } catch (e) { return null; }
  }
  function normalizeState(obj) {
    const b = blankState();
    const s = Object.assign(b, obj || {});
    s.settings = Object.assign(blankState().settings, (obj && obj.settings) || {});
    s.fence = Object.assign({ returnPoint: null, polygons: [], circles: [] }, (obj && obj.fence) || {});
    s.mission = Array.isArray(s.mission) ? s.mission : [];
    s.rally = Array.isArray(s.rally) ? s.rally : [];
    const dsv = defaultSurvey();
    s.survey = Object.assign(dsv, (obj && obj.survey) || {});
    s.survey.cam = Object.assign(defaultSurvey().cam, (obj && obj.survey && obj.survey.cam) || {});
    s.survey.area = Array.isArray(s.survey.area) ? s.survey.area : [];
    return s;
  }

  // ------------------------------------------------------------- lookups
  const findWp = (id) => state.mission.find((w) => w.id === id);
  const findPoly = (id) => state.fence.polygons.find((p) => p.id === id);
  const findCircle = (id) => state.fence.circles.find((c) => c.id === id);
  const findRally = (id) => state.rally.find((r) => r.id === id);
  function selectedObject() {
    if (!ui.sel) return null;
    return { wp: findWp, poly: findPoly, circle: findCircle, rally: findRally }[ui.sel.kind](ui.sel.id) || null;
  }
  function select(kind, id) {
    ui.sel = kind ? { kind, id } : null;
    scheduleRender();
  }
  const isSel = (kind, id) => ui.sel && ui.sel.kind === kind && ui.sel.id === id;

  // ------------------------------------------------------------- helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r6 = (v) => Math.round(v * 1e7) / 1e7;
  function fmtDist(m) {
    if (!isFinite(m)) return '–';
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }
  function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return '–';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
  }
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const safeName = () => (state.planName || 'plan').trim().replace(/[^\w.-]+/g, '_') || 'plan';

  // ------------------------------------------------------------ mission
  function newWaypoint(lat, lon) {
    return { id: nid(), cmd: 16, frame: Number(state.settings.defaultFrame), p: [0, 0, 0, 0], lat: r6(lat), lon: r6(lon), alt: Number(state.settings.defaultAlt) };
  }
  function newCommand(cmd) {
    const info = F.cmdInfo(cmd);
    const p = [0, 0, 0, 0];
    if (cmd === 177) p[1] = 1;
    if (cmd === 178) { p[0] = 1; p[1] = Number(state.settings.speed) || 10; p[2] = -1; }
    if (cmd === 19) p[0] = 10;
    if (cmd === 18) p[0] = 1;
    if (cmd === 93 || cmd === 112) p[0] = 5;
    if (cmd === 93) { p[1] = -1; p[2] = -1; p[3] = -1; }
    return { id: nid(), cmd, frame: Number(state.settings.defaultFrame), p, lat: 0, lon: 0, alt: info.alt ? Number(state.settings.defaultAlt) : 0 };
  }
  function insertMissionItem(item) {
    let idx = state.mission.length;
    if (ui.sel && ui.sel.kind === 'wp') {
      const i = state.mission.findIndex((w) => w.id === ui.sel.id);
      if (i >= 0) idx = i + 1;
    }
    state.mission.splice(idx, 0, item);
    ui.sel = { kind: 'wp', id: item.id };
  }

  /** Flight path: home + all navigation items with a position. */
  function missionPath() {
    const pts = [];
    if (state.home) pts.push({ lat: state.home.lat, lon: state.home.lon, home: true });
    let rtl = false;
    state.mission.forEach((it, i) => {
      const info = F.cmdInfo(it.cmd);
      if (it.cmd === 20) rtl = true;
      if (info.nav && F.itemHasPosition(it)) pts.push({ lat: it.lat, lon: it.lon, idx: i, id: it.id });
    });
    return { pts, rtl };
  }

  function missionStats() {
    const { pts, rtl } = missionPath();
    const legDist = {}; // item id -> distance from previous point
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = G.distance(pts[i - 1], pts[i]);
      legDist[pts[i].id] = d;
      total += d;
    }
    if (rtl && state.home && pts.length > 1) total += G.distance(pts[pts.length - 1], state.home);
    const speed = Number(state.settings.speed) || 0;
    let holds = 0;
    state.mission.forEach((it) => {
      if (it.cmd === 16 || it.cmd === 82) holds += Number(it.p[0]) || 0;
      if (it.cmd === 19 || it.cmd === 93 || it.cmd === 112) holds += Number(it.p[0]) || 0;
    });
    return { legDist, total, time: speed > 0 ? total / speed + holds : NaN, pts, rtl };
  }

  // -------------------------------------------------------------- checks
  function inclusionPolys() { return state.fence.polygons.filter((p) => p.type === 'inclusion' && p.points.length >= 3); }
  function exclusionPolys() { return state.fence.polygons.filter((p) => p.type === 'exclusion' && p.points.length >= 3); }

  /** Is the point allowed by the fence? (inside all inclusion zones, outside all exclusion zones) */
  function fenceViolation(pt) {
    const inc = inclusionPolys();
    const incC = state.fence.circles.filter((c) => c.type === 'inclusion');
    if (inc.length || incC.length) {
      const inside = inc.some((p) => G.pointInPolygon(pt, p.points)) || incC.some((c) => G.distance(pt, c) <= c.radius);
      // ArduPilot: with several inclusion zones the vehicle must be inside all of them
      const insideAll = inc.every((p) => G.pointInPolygon(pt, p.points)) && incC.every((c) => G.distance(pt, c) <= c.radius);
      if (!inside) return 'outside the inclusion fence';
      if (!insideAll) return 'outside one of the inclusion zones';
    }
    if (exclusionPolys().some((p) => G.pointInPolygon(pt, p.points))) return 'inside an exclusion zone';
    if (state.fence.circles.some((c) => c.type === 'exclusion' && G.distance(pt, c) <= c.radius)) return 'inside an exclusion circle';
    return null;
  }
  const hasFence = () => state.fence.polygons.length || state.fence.circles.length;

  function missionChecks() {
    const out = [];
    const m = state.mission;
    const maxAlt = Number(state.settings.maxAlt) || 0;
    if (!m.length) { out.push(['info', 'The mission is empty. Pick "Add waypoints" and click on the map.']); return out; }
    if (!state.home) out.push(['warn', 'No home position set. The first waypoint will be used as home in the exported file.']);
    const firstNav = m.find((it) => F.cmdInfo(it.cmd).nav);
    if (firstNav && firstNav.cmd !== 22) out.push(['info', 'The first navigation item is not a TAKEOFF. Copters normally need one to start an AUTO mission from the ground.']);
    if (surveyPending()) out.push(['info', 'The survey settings or area changed since its waypoints were generated. Click "Regenerate waypoints" in the Survey card.']);
    const last = m[m.length - 1];
    if (![20, 21, 17].includes(last.cmd)) out.push(['info', 'The mission does not end with RTL, LAND or LOITER. Plan how the flight ends.']);
    m.forEach((it, i) => {
      const n = i + 1, info = F.cmdInfo(it.cmd);
      if (info.alt && (info.loc === true || it.cmd === 22)) {
        if (Number(it.alt) <= 0 && it.cmd !== 21) out.push(['warn', `Item ${n}: altitude is ${it.alt} m.`]);
        if (maxAlt && Number(it.frame) !== 0 && Number(it.alt) > maxAlt) out.push(['warn', `Item ${n}: altitude ${it.alt} m is above the ${maxAlt} m limit.`]);
      }
      if (it.cmd === 177) {
        const t = Math.round(it.p[0]);
        if (t < 1 || t > m.length || t === n) out.push(['error', `Item ${n}: DO_JUMP target ${t} is not a valid item number.`]);
      }
      if (hasFence() && F.itemHasPosition(it) && info.nav) {
        const v = fenceViolation(it);
        if (v) out.push(['error', `Item ${n} is ${v}.`]);
      }
    });
    if (hasFence()) {
      const { pts } = missionPath();
      const polys = state.fence.polygons.filter((p) => p.points.length >= 3);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const crossing = polys.find((p) => G.segmentCrossesPolygon(a, b, p.points));
        const crossC = state.fence.circles.find((c) => c.type === 'exclusion' && G.distanceToSegment(c, a, b) <= c.radius);
        const from = a.home ? 'home' : 'item ' + (a.idx + 1);
        if (crossing) out.push(['warn', `Leg ${from} → item ${b.idx + 1} crosses a ${crossing.type} fence boundary.`]);
        else if (crossC) out.push(['warn', `Leg ${from} → item ${b.idx + 1} passes through an exclusion circle.`]);
      }
      if (state.home && fenceViolation(state.home)) out.push(['error', 'Home is ' + fenceViolation(state.home) + '. ArduPilot will refuse to arm.']);
    }
    if (!out.some((c) => c[0] !== 'info')) out.push(['ok', 'No problems found.']);
    return out;
  }

  function fenceChecks() {
    const out = [];
    const f = state.fence;
    if (!f.polygons.length && !f.circles.length) { out.push(['info', 'No fence yet. Draw an inclusion polygon around the flying area.']); return out; }
    f.polygons.forEach((p, i) => {
      const name = `${cap(p.type)} polygon ${i + 1}`;
      if (p.points.length < 3) out.push(['error', `${name} has only ${p.points.length} vertices (minimum 3).`]);
      else if (G.polygonSelfIntersects(p.points)) out.push(['error', `${name} crosses itself. ArduPilot will reject it.`]);
    });
    f.circles.forEach((c, i) => { if (!(c.radius > 0)) out.push(['error', `Circle ${i + 1} needs a radius above 0.`]); });
    if (!inclusionPolys().length && !f.circles.some((c) => c.type === 'inclusion')) out.push(['info', 'There is no inclusion zone, only exclusion zones.']);
    if (f.returnPoint && fenceViolation(f.returnPoint)) out.push(['error', 'The return point is ' + fenceViolation(f.returnPoint) + '.']);
    if (state.home && fenceViolation(state.home)) out.push(['error', 'Home is ' + fenceViolation(state.home) + '.']);
    if (!out.some((c) => c[0] === 'error' || c[0] === 'warn')) out.unshift(['ok', 'Fence geometry looks valid.']);
    return out;
  }

  function rallyChecks() {
    const out = [];
    if (!state.rally.length) { out.push(['info', 'No rally points. Add safe landing / loiter spots near the flying area.']); return out; }
    const maxAlt = Number(state.settings.maxAlt) || 0;
    state.rally.forEach((r, i) => {
      if (hasFence() && fenceViolation(r)) out.push(['error', `Rally point ${i + 1} is ${fenceViolation(r)}.`]);
      if (maxAlt && r.alt > maxAlt) out.push(['warn', `Rally point ${i + 1}: altitude ${r.alt} m is above the ${maxAlt} m limit.`]);
      if (r.alt <= 0) out.push(['warn', `Rally point ${i + 1}: altitude is ${r.alt} m.`]);
    });
    out.push(['info', 'RTL only uses rally points when RALLY_LIMIT_KM and (for copter) RALLY_INCL_HOME are set accordingly.']);
    if (!out.some((c) => c[0] === 'error' || c[0] === 'warn')) out.unshift(['ok', 'Rally points look valid.']);
    return out;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ================================================================= MAP
  const map = L.map('map', { zoomControl: true, doubleClickZoom: true }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);
  const baseLayers = {
    'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }),
    'Street map (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, attribution: 'Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors',
    }),
    'Topographic (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, attribution: 'Tiles &copy; Esri, HERE, Garmin, USGS, NGA, OpenStreetMap contributors',
    }),
    'Street map (OSM)': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }),
    'Topographic (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 17, attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    }),
    'Light street map (CARTO Voyager)': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20, maxNativeZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }),
    'Cycling & terrain (CyclOSM)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 20, subdomains: 'abc', attribution: '<a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a> | Map data: &copy; OpenStreetMap contributors',
    }),
  };
  baseLayers['Satellite (Esri)'].addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  const layers = {
    fenceShapes: L.layerGroup().addTo(map),
    fenceHandles: L.layerGroup().addTo(map),
    surveyShape: L.layerGroup().addTo(map),
    surveyPreview: L.layerGroup().addTo(map),
    surveyHandles: L.layerGroup().addTo(map),
    missionPath: L.layerGroup().addTo(map),
    missionMarkers: L.layerGroup().addTo(map),
    rally: L.layerGroup().addTo(map),
    terrain: L.layerGroup().addTo(map),
  };

  const LOCATE_BUTTON = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.innerHTML = '<a href="#" title="Zoom to plan" role="button" style="font-size:15px">⤢</a><a href="#" title="My location" role="button" style="font-size:15px">◎</a>';
      const [fit, loc] = div.querySelectorAll('a');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(fit, 'click', (e) => { L.DomEvent.preventDefault(e); zoomToPlan(); });
      L.DomEvent.on(loc, 'click', (e) => { L.DomEvent.preventDefault(e); map.locate({ setView: true, maxZoom: 16 }); });
      return div;
    },
  });
  map.addControl(new LOCATE_BUTTON());
  map.on('locationerror', () => toast('Could not get your location', true));

  function zoomToPlan() {
    const pts = [];
    if (state.home) pts.push([state.home.lat, state.home.lon]);
    state.mission.forEach((it) => { if (F.itemHasPosition(it)) pts.push([it.lat, it.lon]); });
    state.fence.polygons.forEach((p) => p.points.forEach((v) => pts.push([v.lat, v.lon])));
    state.fence.circles.forEach((c) => {
      const b = L.latLng(c.lat, c.lon).toBounds(c.radius * 2);
      pts.push([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]);
    });
    state.rally.forEach((r) => pts.push([r.lat, r.lon]));
    state.survey.area.forEach((v) => pts.push([v.lat, v.lon]));
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 18 });
  }

  map.on('mousemove', (e) => {
    $('#cursor').textContent = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
  });

  map.on('click', (e) => {
    const lat = r6(e.latlng.lat), lon = r6(e.latlng.lng);
    switch (ui.tool) {
      case 'wp':
        mutate(() => insertMissionItem(newWaypoint(lat, lon)));
        break;
      case 'survey':
        mutate(() => {
          if (!ui.surveyDrawing) { state.survey.area = []; ui.surveyDrawing = true; }
          state.survey.area.push({ lat, lon });
        });
        break;
      case 'home':
        mutate(() => { state.home = { lat, lon, alt: state.home ? state.home.alt : 0 }; });
        setTool(null);
        break;
      case 'poly-inclusion':
      case 'poly-exclusion': {
        mutate(() => {
          let poly = ui.drawing && findPoly(ui.drawing);
          if (!poly) {
            poly = { id: nid(), type: ui.tool.split('-')[1], points: [] };
            state.fence.polygons.push(poly);
            ui.drawing = poly.id;
          }
          poly.points.push({ lat, lon });
          ui.sel = { kind: 'poly', id: poly.id };
        });
        break;
      }
      case 'circle-inclusion':
      case 'circle-exclusion': {
        mutate(() => {
          const c = { id: nid(), type: ui.tool.split('-')[1], lat, lon, radius: Number(state.settings.circleRadius) || 100 };
          state.fence.circles.push(c);
          ui.sel = { kind: 'circle', id: c.id };
        });
        setTool(null);
        break;
      }
      case 'return':
        mutate(() => { state.fence.returnPoint = { lat, lon }; });
        setTool(null);
        break;
      case 'rally':
        mutate(() => {
          const r = { id: nid(), lat, lon, alt: Number(state.settings.rallyAlt) || 30 };
          state.rally.push(r);
          ui.sel = { kind: 'rally', id: r.id };
        });
        break;
      default:
        if (ui.shapeClicked) { ui.shapeClicked = false; break; }
        if (ui.sel) select(null);
    }
  });

  function finishPolygon() {
    const poly = ui.drawing && findPoly(ui.drawing);
    ui.drawing = null;
    if (poly && poly.points.length < 3) {
      state.fence.polygons = state.fence.polygons.filter((p) => p !== poly);
      if (ui.sel && ui.sel.id === poly.id) ui.sel = null;
      toast('A polygon needs at least 3 vertices — discarded');
      saveLocal();
    }
    setTool(null);
  }

  // icons
  function wpIcon(item, n, selected, active) {
    let cls = 'wp-icon';
    if (item.cmd === 21) cls += ' land';
    else if (item.cmd === 201) cls += ' roi';
    else if (item.cmd !== 16 && item.cmd !== 82) cls += ' special';
    if (selected) cls += ' sel';
    if (!active) cls += ' dim';
    if (item.survey) { // dense survey grids: slightly smaller marker, number always shown
      const px = n > 99 ? 24 : 20;
      return L.divIcon({ className: '', html: `<div class="${cls} small" style="width:${px}px;height:${px}px">${n}</div>`, iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
    }
    return L.divIcon({ className: '', html: `<div class="${cls}" style="width:24px;height:24px">${n}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  }
  const homeIcon = (active) => L.divIcon({ className: '', html: `<div class="home-icon${active ? '' : ' dim'}" style="width:24px;height:24px">H</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  const rallyIcon = (n, selected, active) => L.divIcon({ className: '', html: `<div class="rally-icon${selected ? ' sel' : ''}${active ? '' : ' dim'}" style="width:22px;height:22px">R${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const vtxIcon = (type, first) => L.divIcon({ className: '', html: `<div class="vtx-icon${type === 'exclusion' ? ' excl' : ''}${first ? ' first' : ''}" style="width:12px;height:12px"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
  const midIcon = L.divIcon({ className: '', html: '<div class="mid-icon" style="width:10px;height:10px"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
  const retIcon = (active) => L.divIcon({ className: '', html: `<div class="ret-icon${active ? '' : ' dim'}" style="width:22px;height:22px">F</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });

  // drag helper: snapshot on start, live update while dragging, full render at end
  function makeDraggable(marker, onMove, onLive) {
    marker.on('dragstart', () => snapshot());
    marker.on('drag', (e) => { const ll = e.target.getLatLng(); onMove(r6(ll.lat), r6(ll.lng)); if (onLive) onLive(); });
    marker.on('dragend', () => changed());
  }

  function renderMissionPath() {
    layers.missionPath.clearLayers();
    const active = ui.mode === 'mission';
    const { pts, rtl, legDist } = missionStats();
    const color = active ? '#facc15' : '#facc15';
    if (pts.length > 1) {
      L.polyline(pts.map((p) => [p.lat, p.lon]), { color, weight: 3, opacity: active ? 0.95 : 0.5, interactive: false }).addTo(layers.missionPath);
      if (ui.showLegs && active) {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const sa = a.id && findWp(a.id), sb = b.id && findWp(b.id);
          if (sa && sa.survey && sb && sb.survey) continue; // dense survey grid: skip leg labels
          const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
          L.tooltip({ permanent: true, direction: 'center', className: 'leg-label', interactive: false })
            .setLatLng(mid).setContent(fmtDist(legDist[b.id]) + ' · ' + Math.round(G.bearing(a, b)) + '°').addTo(layers.missionPath);
        }
      }
    }
    if (rtl && state.home && pts.length > 1) {
      const last = pts[pts.length - 1];
      L.polyline([[last.lat, last.lon], [state.home.lat, state.home.lon]], { color, weight: 2, dashArray: '6 6', opacity: active ? 0.9 : 0.4, interactive: false }).addTo(layers.missionPath);
    }
    // ROI lines
    state.mission.forEach((it, i) => {
      if (it.cmd !== 201) return;
      const prev = pts.filter((p) => p.idx !== undefined && p.idx < i).pop();
      if (prev) L.polyline([[prev.lat, prev.lon], [it.lat, it.lon]], { color: '#db2777', weight: 1.5, dashArray: '3 5', interactive: false }).addTo(layers.missionPath);
    });
  }

  function renderMissionMarkers() {
    layers.missionMarkers.clearLayers();
    const active = ui.mode === 'mission';
    if (state.home) {
      const hm = L.marker([state.home.lat, state.home.lon], { icon: homeIcon(active), draggable: active, interactive: active, zIndexOffset: 500, title: 'Home' }).addTo(layers.missionMarkers);
      makeDraggable(hm, (lat, lon) => { state.home.lat = lat; state.home.lon = lon; }, renderMissionPath);
    }
    state.mission.forEach((it, i) => {
      if (!F.itemHasPosition(it)) return;
      const sel = isSel('wp', it.id);
      const m = L.marker([it.lat, it.lon], {
        icon: wpIcon(it, i + 1, sel, active), draggable: active, interactive: active,
        zIndexOffset: sel ? 1000 : 0, title: `${i + 1}: ${F.cmdInfo(it.cmd).label} — ${it.alt} m`,
      }).addTo(layers.missionMarkers);
      m.on('click', () => { if (ui.tool) return; select('wp', it.id); scrollToSelected(); });
      makeDraggable(m, (lat, lon) => { it.lat = lat; it.lon = lon; }, renderMissionPath);
    });
  }

  function renderFence() {
    layers.fenceShapes.clearLayers();
    layers.fenceHandles.clearLayers();
    const active = ui.mode === 'fence';

    state.fence.polygons.forEach((poly) => {
      const color = poly.type === 'exclusion' ? '#dc2626' : '#15803d';
      const sel = isSel('poly', poly.id);
      const latlngs = poly.points.map((p) => [p.lat, p.lon]);
      if (latlngs.length >= 2) {
        const shape = (ui.drawing === poly.id ? L.polyline : L.polygon)(latlngs, {
          color, weight: sel ? 3.5 : 2.5, opacity: active ? 1 : 0.6,
          fillOpacity: poly.type === 'exclusion' ? 0.22 : 0.07, dashArray: ui.drawing === poly.id ? '6 5' : null,
          interactive: active, bubblingMouseEvents: true,
        }).addTo(layers.fenceShapes);
        shape.on('click', () => { if (ui.tool) return; ui.shapeClicked = true; select('poly', poly.id); scrollToSelected(); });
      }
      if (!active) return;
      poly.points.forEach((pt, vi) => {
        const isFirst = vi === 0 && ui.drawing === poly.id;
        const m = L.marker([pt.lat, pt.lon], { icon: vtxIcon(poly.type, isFirst), draggable: true, zIndexOffset: 800, title: `Vertex ${vi + 1} (right-click to delete)` }).addTo(layers.fenceHandles);
        m.on('click', () => {
          if (ui.drawing === poly.id && vi === 0 && poly.points.length >= 3) { finishPolygon(); return; }
          if (!ui.tool) select('poly', poly.id);
        });
        m.on('contextmenu', () => {
          if (poly.points.length <= 3 && ui.drawing !== poly.id) return toast('A polygon needs at least 3 vertices');
          mutate(() => poly.points.splice(vi, 1));
        });
        makeDraggable(m, (lat, lon) => { pt.lat = lat; pt.lon = lon; }, () => redrawShapesOnly());
      });
      // midpoint handles to insert vertices
      if (sel && ui.drawing !== poly.id && poly.points.length >= 3) {
        poly.points.forEach((a, vi) => {
          const b = poly.points[(vi + 1) % poly.points.length];
          const mm = L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], { icon: midIcon, title: 'Click to add a vertex here' }).addTo(layers.fenceHandles);
          mm.on('click', () => mutate(() => poly.points.splice(vi + 1, 0, { lat: r6((a.lat + b.lat) / 2), lon: r6((a.lon + b.lon) / 2) })));
        });
      }
    });

    state.fence.circles.forEach((c) => {
      const color = c.type === 'exclusion' ? '#dc2626' : '#15803d';
      const sel = isSel('circle', c.id);
      const circle = L.circle([c.lat, c.lon], {
        radius: Number(c.radius) || 0, color, weight: sel ? 3.5 : 2.5, opacity: active ? 1 : 0.6,
        fillOpacity: c.type === 'exclusion' ? 0.22 : 0.07, interactive: active, bubblingMouseEvents: true,
      }).addTo(layers.fenceShapes);
      circle.on('click', () => { if (ui.tool) return; ui.shapeClicked = true; select('circle', c.id); scrollToSelected(); });
      if (active) {
        const m = L.marker([c.lat, c.lon], { icon: vtxIcon(c.type, false), draggable: true, zIndexOffset: 800, title: 'Circle centre' }).addTo(layers.fenceHandles);
        m.on('click', () => { if (!ui.tool) select('circle', c.id); });
        makeDraggable(m, (lat, lon) => { c.lat = lat; c.lon = lon; circle.setLatLng([lat, lon]); });
      }
    });

    const rp = state.fence.returnPoint;
    if (rp) {
      const m = L.marker([rp.lat, rp.lon], { icon: retIcon(active), draggable: active, interactive: active, title: 'Fence return point' }).addTo(layers.fenceHandles);
      makeDraggable(m, (lat, lon) => { rp.lat = lat; rp.lon = lon; });
    }
  }

  function redrawShapesOnly() {
    // keep handles (one is being dragged), rebuild polygons only
    layers.fenceShapes.eachLayer((l) => {
      if (l instanceof L.Circle) return;
      layers.fenceShapes.removeLayer(l);
    });
    state.fence.polygons.forEach((poly) => {
      if (poly.points.length < 2) return;
      const color = poly.type === 'exclusion' ? '#dc2626' : '#15803d';
      (ui.drawing === poly.id ? L.polyline : L.polygon)(poly.points.map((p) => [p.lat, p.lon]), {
        color, weight: 3, fillOpacity: poly.type === 'exclusion' ? 0.22 : 0.07, interactive: false,
      }).addTo(layers.fenceShapes);
    });
  }

  function renderRally() {
    layers.rally.clearLayers();
    const active = ui.mode === 'rally';
    state.rally.forEach((r, i) => {
      const m = L.marker([r.lat, r.lon], { icon: rallyIcon(i + 1, isSel('rally', r.id), active), draggable: active, interactive: active, title: `Rally ${i + 1} — ${r.alt} m` }).addTo(layers.rally);
      m.on('click', () => { if (ui.tool) return; select('rally', r.id); scrollToSelected(); });
      makeDraggable(m, (lat, lon) => { r.lat = lat; r.lon = lon; });
    });
  }

  // ============================================================ TOOLBAR
  const TOOLS = {
    mission: [
      ['wp', 'Add waypoints', 'Click the map to add waypoints. They are inserted after the selected item.', '#1f6feb'],
      ['home', 'Set home', 'Click the map where the vehicle will take off (home).', '#c2410c'],
      ['survey', 'Survey area', 'Click the corners of the area to survey. Click the yellow first corner, press Enter or "Finish" to close.', '#06b6d4'],
    ],
    fence: [
      ['poly-inclusion', 'Inclusion polygon', 'Click to add vertices. Click the yellow first vertex, press Enter or "Finish" to close.', '#15803d'],
      ['poly-exclusion', 'Exclusion polygon', 'Click to add vertices of a no-fly zone. Click the yellow first vertex, press Enter or "Finish" to close.', '#dc2626'],
      ['circle-inclusion', 'Inclusion circle', 'Click the centre of the circle. Set the radius in the side panel.', '#15803d'],
      ['circle-exclusion', 'Exclusion circle', 'Click the centre of the no-fly circle. Set the radius in the side panel.', '#dc2626'],
      ['return', 'Return point', 'Click to place the fence return point.', '#0f172a'],
    ],
    rally: [
      ['rally', 'Add rally points', 'Click the map to add rally points.', '#7c3aed'],
    ],
  };

  function endSurveyDrawing() {
    if (!ui.surveyDrawing) return;
    ui.surveyDrawing = false;
    if (state.survey.area.length < 3) {
      state.survey.area = [];
      toast('A survey area needs at least 3 corners — discarded');
      saveLocal();
    }
  }

  function setTool(tool) {
    if (ui.tool === 'survey' && tool !== 'survey') endSurveyDrawing();
    if (ui.drawing && tool !== ui.tool) {
      const t = ui.tool; ui.tool = null;
      if (t) { finishPolygonQuiet(); }
    }
    ui.tool = tool;
    if (tool === 'survey' && !ui.surveyOpen) {
      ui.surveyOpen = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { const c = $('#survey-card'); if (c) c.scrollIntoView({ block: 'nearest' }); }));
    }
    $('.map-wrap').classList.toggle('tool-on', !!tool);
    scheduleRender();
  }
  function finishPolygonQuiet() {
    const poly = ui.drawing && findPoly(ui.drawing);
    ui.drawing = null;
    if (poly && poly.points.length < 3) {
      state.fence.polygons = state.fence.polygons.filter((p) => p !== poly);
      toast('A polygon needs at least 3 vertices — discarded');
      saveLocal();
    }
  }

  function renderTools() {
    const el = $('#map-tools');
    el.innerHTML = TOOLS[ui.mode].map(([id, label, , color]) =>
      `<button class="tool${ui.tool === id ? ' active' : ''}" data-tool="${id}"><span class="sw" style="background:${color}"></span>${label}</button>`).join('');
    const hint = $('#hint');
    const t = TOOLS[ui.mode].find((x) => x[0] === ui.tool);
    if (t) {
      const poly = ui.drawing && findPoly(ui.drawing);
      const sdraw = ui.tool === 'survey' && ui.surveyDrawing;
      let extra = '';
      if (poly) extra = `<span class="muted" style="color:#cbd5e1">${poly.points.length} vertices</span><button data-hint="finish">Finish</button>`;
      else if (sdraw) extra = `<span class="muted" style="color:#cbd5e1">${state.survey.area.length} corners</span><button data-hint="finish">Finish</button>`;
      hint.innerHTML = `<span>${esc(t[2])}</span>${extra}<button class="ghost" data-hint="cancel">${poly || sdraw ? 'Cancel' : 'Done'} (Esc)</button>`;
      hint.hidden = false;
    } else hint.hidden = true;
  }

  $('#map-tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const t = b.dataset.tool;
    if (ui.drawing) finishPolygon();
    setTool(ui.tool === t ? null : t);
  });
  L.DomEvent.disableClickPropagation($('#map-tools'));
  L.DomEvent.disableClickPropagation($('#hint'));
  $('#hint').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hint]');
    if (!b) return;
    if (b.dataset.hint === 'finish') { if (ui.tool === 'survey') setTool(null); else finishPolygon(); }
    else if (ui.tool === 'survey' && ui.surveyDrawing) {
      mutate(() => { state.survey.area = []; });
      setTool(null);
    } else if (ui.drawing) {
      // cancel drawing: remove polygon
      const id = ui.drawing; ui.drawing = null;
      mutate(() => { state.fence.polygons = state.fence.polygons.filter((p) => p.id !== id); ui.sel = null; });
      setTool(null);
    } else setTool(null);
  });

  // ============================================================ SIDEBAR
  function field(label, bind, value, opts = {}) {
    const type = opts.type || 'number';
    const step = opts.step || 'any';
    const dis = opts.disabled ? ' disabled' : '';
    return `<label class="f">${esc(label)}<input type="${type}" step="${step}" data-bind="${bind}" value="${esc(value ?? '')}"${dis}${opts.min !== undefined ? ` min="${opts.min}"` : ''}></label>`;
  }
  function selectField(label, bind, value, options) {
    return `<label class="f">${esc(label)}<select data-bind="${bind}">${options.map(([v, t]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  }
  const cmdOptions = (current) => {
    const opts = F.CMD_ORDER.map((c) => [c, F.CMD[c].label]);
    if (!F.CMD[current]) opts.push([current, F.cmdInfo(current).label]);
    return opts;
  };
  const frameOptions = (current) => {
    const o = Object.entries(F.FRAME_LABELS);
    if (!F.FRAME_LABELS[current]) o.push([current, 'Frame ' + current]);
    return o;
  };
  function checksHtml(list) {
    return `<div class="card"><h3>Checks</h3><ul class="checks">${list.map(([lvl, msg]) => `<li class="${lvl}">${esc(msg)}</li>`).join('')}</ul></div>`;
  }

  // ============================================================ TERRAIN CHECK
  let terrainCtx = null;
  const FRAME_SHORT = { 0: 'AMSL', 10: 'terrain' };
  const frameShort = (f) => FRAME_SHORT[Number(f)] || 'rel. home';
  const fmtM = (v) => (isFinite(v) ? Math.round(v) + ' m' : '–');

  function terrainRoute() {
    const route = [];
    state.mission.forEach((it, i) => {
      if (!F.cmdInfo(it.cmd).nav || !F.itemHasPosition(it)) return;
      route.push({ lat: Number(it.lat), lon: Number(it.lon), alt: Number(it.alt) || 0, frame: Number(it.frame), cmd: it.cmd, id: it.id, n: i + 1 });
    });
    return route;
  }

  async function terrainCheck() {
    const route = terrainRoute();
    if (!route.length) return toast('Add some waypoints first', true);
    const dlg = $('#terrain-dialog'), body = $('#terrain-body');
    body.innerHTML = '<p class="muted">Loading elevation data…</p>';
    if (!dlg.open) dlg.showModal();
    const home = state.home || route[0];
    try {
      const prof = await TR.profile(route, home, 15);
      const prev = terrainCtx || {};
      terrainCtx = {
        prof, homeFromWp: !state.home, demHome: prof.homeGround,
        homeGround: Math.round(prof.homeGround * 10) / 10,
        minClear: prev.minClear !== undefined ? prev.minClear : 20,
        maxAgl: Number(state.settings.maxAlt) || 0,
      };
      renderTerrain();
    } catch (e) {
      body.innerHTML = `<p class="checks"><span class="err-box">Could not load elevation data. Check your internet connection and try again.</span></p><p class="help">${esc(e.message || e)}</p>`;
    }
  }

  function drawTerrainHighlights(r) {
    layers.terrain.clearLayers();
    r.runs.forEach((run) => {
      const pts = r.samples.slice(run.from, run.to + 1).map((s) => [s.lat, s.lon]);
      const color = run.kind === 'high' ? '#d97706' : '#dc2626';
      const tip = terrainRunText(run);
      (pts.length > 1 ? L.polyline(pts, { color, weight: 7, opacity: 0.8 }) : L.circleMarker(pts[0], { radius: 7, color, fillColor: color, fillOpacity: 0.8 }))
        .bindTooltip(tip).addTo(layers.terrain);
    });
  }

  function terrainRunText(run) {
    const t = terrainCtx, route = t.prof.route;
    const a = route[run.seg0].n, bIdx = Math.min(run.seg1 + 1, route.length - 1), b = route[bIdx].n;
    const where = a === b ? `at item ${a}` : `between items ${a} and ${b}`;
    if (run.kind === 'under') return `Below the terrain ${where} (${Math.round(run.worst)} m)`;
    if (run.kind === 'low') return `Clearance only ${Math.round(run.worst)} m ${where} (minimum ${t.minClear} m)`;
    return `${Math.round(run.worst)} m above ground ${where} (limit ${t.maxAgl} m)`;
  }

  function terrainChart(r) {
    const W = 720, H = 220, ml = 50, mr = 12, mt = 12, mb = 26;
    const S = r.samples, total = r.total || 1;
    const t = terrainCtx;
    const all = S.map((s) => s.ground).concat(S.map((s) => s.flight), S.map((s) => s.ground + t.minClear));
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = Math.max(5, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    const X = (d) => ml + (d / total) * (W - ml - mr);
    const Y = (e) => mt + (1 - (e - lo) / (hi - lo)) * (H - mt - mb);
    const line = (key, off = 0) => S.map((s, i) => `${i ? 'L' : 'M'}${X(s.d).toFixed(1)},${Y(s[key] + off).toFixed(1)}`).join('');
    const ground = `${line('ground')}L${X(S[S.length - 1].d).toFixed(1)},${H - mb}L${X(S[0].d).toFixed(1)},${H - mb}Z`;
    const minLine = S.map((s, i) => `${i ? 'L' : 'M'}${X(s.d).toFixed(1)},${Y(s.ground + t.minClear).toFixed(1)}`).join('');
    const bad = r.runs.map((run) => {
      const pts = S.slice(run.from, run.to + 1);
      const cls = run.kind === 'high' ? 'tp-high' : 'tp-bad';
      return pts.length > 1
        ? `<path class="${cls}" d="${pts.map((s, i) => `${i ? 'L' : 'M'}${X(s.d).toFixed(1)},${Y(s.flight).toFixed(1)}`).join('')}"/>`
        : `<circle class="${cls}" cx="${X(pts[0].d).toFixed(1)}" cy="${Y(pts[0].flight).toFixed(1)}" r="4"/>`;
    }).join('');
    const showN = r.wps.length <= 25;
    const dots = r.wps.map((w) => `<circle class="tp-wp ${w.status}" cx="${X(w.d).toFixed(1)}" cy="${Y(w.flight).toFixed(1)}" r="3.5"/>`
      + (showN ? `<text class="tp-n" x="${X(w.d).toFixed(1)}" y="${(Y(w.flight) - 7).toFixed(1)}" text-anchor="middle">${w.n}</text>` : '')).join('');
    return `<svg class="tp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terrain profile along the flight path">
      <path class="tp-ground" d="${ground}"/>
      <path class="tp-min" d="${minLine}"/>
      <path class="tp-flight" d="${line('flight')}"/>
      ${bad}${dots}
      <text class="tp-ax" x="${ml - 6}" y="${Y(hi) + 8}" text-anchor="end">${Math.round(hi)} m</text>
      <text class="tp-ax" x="${ml - 6}" y="${Y(lo)}" text-anchor="end">${Math.round(lo)} m</text>
      <text class="tp-ax" x="${ml}" y="${H - 8}">0</text>
      <text class="tp-ax" x="${W - mr}" y="${H - 8}" text-anchor="end">${fmtDist(total)} along path</text>
    </svg>
    <div class="tp-legend"><span><i class="lg lg-flight"></i>Flight path</span><span><i class="lg lg-ground"></i>Terrain</span><span><i class="lg lg-min"></i>Minimum clearance</span><span><i class="lg lg-bad"></i>Problem</span></div>`;
  }

  function renderTerrain() {
    const t = terrainCtx;
    if (!t) return;
    const r = TR.evaluate(t.prof, { homeGround: t.homeGround, minClear: t.minClear, maxAgl: t.maxAgl });
    t.result = r;
    drawTerrainHighlights(r);
    const STATUS = { ok: 'OK', low: 'Low clearance', under: 'Below terrain', high: 'Above limit', land: 'Landing' };
    const bad = r.wps.filter((w) => w.status !== 'ok' && w.status !== 'land').length;
    let banner;
    if (!r.runs.length && !bad) {
      const m = r.min;
      banner = `<div class="tp-banner ok">✓ No terrain problems found.${m ? ` Lowest clearance ${Math.round(m.agl)} m, ${fmtDist(m.d)} along the path.` : ''}</div>`;
    } else {
      banner = `<div class="tp-banner bad"><b>${bad} waypoint${bad === 1 ? '' : 's'} and ${r.runs.length} stretch${r.runs.length === 1 ? '' : 'es'} with problems.</b><ul>${
        r.runs.slice(0, 8).map((run) => `<li>${esc(terrainRunText(run))}</li>`).join('')}${r.runs.length > 8 ? `<li>…and ${r.runs.length - 8} more</li>` : ''}</ul>
        <span class="muted">The problem stretches are also marked on the map.</span></div>`;
    }
    const num = (label, key, val, min) => `<label class="f">${label}<input type="number" step="any" data-t="${key}" value="${esc(val)}"${min !== undefined ? ` min="${min}"` : ''}></label>`;
    const homeNote = t.homeFromWp ? 'No home is set, so the first waypoint was used.' : 'Terrain data at home';
    const rows = r.wps.map((w) => `<tr class="${w.status}"><td>${w.n}</td><td>${Math.round(w.alt)} m <span class="muted">${frameShort(w.frame)}</span></td><td>${fmtM(w.flight)}</td><td>${fmtM(w.ground)}</td><td>${w.status === 'land' ? '–' : fmtM(w.agl)}</td><td>${STATUS[w.status]}</td></tr>`).join('');
    $('#terrain-body').innerHTML = `
      <div class="grid3">
        ${num('Home ground elevation (m AMSL)', 'homeGround', t.homeGround)}
        ${num('Minimum clearance (m)', 'minClear', t.minClear, 0)}
        ${num('Maximum height above ground (m, 0 = off)', 'maxAgl', t.maxAgl, 0)}
      </div>
      <p class="help">${homeNote}: ${t.demHome.toFixed(1)} m. Waypoints relative to home are placed at home elevation plus their altitude.
        ${!t.homeFromWp && state.home && Math.round(Number(state.home.alt)) !== Math.round(t.homeGround) ? '<button type="button" class="b" data-t-act="set-home">Set home altitude to ' + Math.round(t.homeGround) + ' m</button>' : ''}</p>
      ${banner}
      ${terrainChart(r)}
      <div class="tp-table"><table><thead><tr><th>Item</th><th>Set altitude</th><th>Flight alt AMSL</th><th>Ground AMSL</th><th>Clearance</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="help">Elevation comes from open global terrain tiles (SRTM, EU-DEM and others, roughly 10 to 30 m resolution). It can miss trees, buildings and masts, so use it as a guide and verify the site. The takeoff climb and the RTL return leg are not checked, and descents to a landing point are skipped.</p>`;
  }

  $('#terrain-body').addEventListener('change', (e) => {
    const key = e.target.dataset.t;
    if (!key || !terrainCtx) return;
    const v = Number(e.target.value);
    if (!isFinite(v)) return;
    terrainCtx[key] = v;
    renderTerrain();
  });
  $('#terrain-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-t-act="set-home"]') && state.home && terrainCtx) {
      mutate(() => { state.home.alt = Math.round(terrainCtx.homeGround); });
      drawTerrainHighlights(terrainCtx.result);
      renderTerrain();
    }
  });

  // ============================================================ SURVEY (GRID)
  const surveyIcon = (first) => L.divIcon({ className: '', html: `<div class="vtx-icon survey${first ? ' first' : ''}" style="width:12px;height:12px"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });

  /** Footprint figures and the generated path for the current survey settings. */
  function surveyCalc() {
    const s = state.survey;
    const fp = SV.footprint(s.cam, Number(s.alt), Number(s.front), Number(s.side), Number(s.portrait));
    if (!fp) return { fp: null, gen: null, error: 'Check the camera values and the altitude.' };
    if (s.area.length < 3) return { fp, gen: null, error: 'Draw the survey area first.' };
    const gen = SV.generate(s.area, { angle: s.angle, spacing: fp.spacing, overshoot: s.overshoot, reverse: s.reverse });
    return { fp, gen: gen.error ? null : gen, error: gen.error };
  }
  const surveySig = () => { const s = state.survey; return JSON.stringify([s.area, s.cam, s.alt, s.front, s.side, s.angle, s.portrait, s.overshoot, s.trigger, s.reverse]); };
  const surveyItemCount = () => state.mission.filter((it) => it.survey).length;
  const surveyPending = () => surveyItemCount() > 0 && state.survey.sig !== surveySig();

  function generateSurvey() {
    const c = surveyCalc();
    if (!c.gen) return toast(c.error || 'Draw the survey area first', true);
    const s = state.survey;
    const trig = s.trigger && c.fp.trigger > 0;
    mutate(() => {
      const items = [];
      const cmd206 = (dist) => { const t = newCommand(206); t.p[0] = dist; t.survey = true; return t; };
      if (trig) items.push(cmd206(Math.round(c.fp.trigger * 10) / 10));
      c.gen.points.forEach((pt) => {
        const w = newWaypoint(pt.lat, pt.lon);
        w.alt = Number(s.alt); w.frame = 3; w.survey = true; // relative to home
        items.push(w);
      });
      if (trig) items.push(cmd206(0));

      // replace a previous survey in place, otherwise insert after the selection or before a final RTL/Land
      let at = state.mission.findIndex((it) => it.survey);
      state.mission = state.mission.filter((it) => !it.survey);
      if (at < 0) {
        const si = ui.sel && ui.sel.kind === 'wp' ? state.mission.findIndex((w) => w.id === ui.sel.id) : -1;
        const lastItem = state.mission[state.mission.length - 1];
        at = si >= 0 ? si + 1 : lastItem && (lastItem.cmd === 20 || lastItem.cmd === 21) ? state.mission.length - 1 : state.mission.length;
      }
      state.mission.splice(at, 0, ...items);
      s.sig = surveySig();
      ui.sel = null;
    });
    toast(`Survey inserted: ${c.gen.points.length} waypoints on ${c.gen.lines} lines`);
  }

  function drawSurveyPreview() {
    layers.surveyPreview.clearLayers();
    if (ui.mode !== 'mission') return;
    const c = surveyCalc();
    if (!c.gen || (surveyItemCount() && !surveyPending())) return;
    L.polyline(c.gen.points.map((p) => [p.lat, p.lon]), { color: '#22d3ee', weight: 2, dashArray: '5 4', opacity: 0.95, interactive: false }).addTo(layers.surveyPreview);
  }

  function renderSurvey() {
    layers.surveyShape.clearLayers();
    layers.surveyHandles.clearLayers();
    const s = state.survey;
    const active = ui.mode === 'mission';
    const drawing = ui.tool === 'survey' && ui.surveyDrawing;
    const ll = s.area.map((p) => [p.lat, p.lon]);
    if (ll.length >= 2) {
      (drawing ? L.polyline : L.polygon)(ll, {
        color: '#06b6d4', weight: 2.5, opacity: active ? 1 : 0.5, fillOpacity: 0.08,
        dashArray: drawing ? '6 5' : null, interactive: false,
      }).addTo(layers.surveyShape);
    }
    drawSurveyPreview();
    if (!active) return;
    s.area.forEach((pt, vi) => {
      const m = L.marker([pt.lat, pt.lon], { icon: surveyIcon(vi === 0 && drawing), draggable: true, zIndexOffset: 700, title: `Survey corner ${vi + 1} (right-click to delete)` }).addTo(layers.surveyHandles);
      m.on('click', () => { if (drawing && vi === 0 && s.area.length >= 3) setTool(null); });
      m.on('contextmenu', () => {
        if (s.area.length <= 3 && !drawing) return toast('A survey area needs at least 3 corners');
        mutate(() => s.area.splice(vi, 1));
      });
      makeDraggable(m, (lat, lon) => { pt.lat = lat; pt.lon = lon; }, () => {
        layers.surveyShape.clearLayers();
        L.polygon(s.area.map((p) => [p.lat, p.lon]), { color: '#06b6d4', weight: 2.5, fillOpacity: 0.08, interactive: false }).addTo(layers.surveyShape);
        drawSurveyPreview();
      });
    });
    // midpoint handles to add corners
    if (!drawing && s.area.length >= 3) {
      s.area.forEach((a, vi) => {
        const b = s.area[(vi + 1) % s.area.length];
        const mm = L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], { icon: midIcon, title: 'Click to add a corner here' }).addTo(layers.surveyHandles);
        mm.on('click', () => mutate(() => s.area.splice(vi + 1, 0, { lat: r6((a.lat + b.lat) / 2), lon: r6((a.lon + b.lon) / 2) })));
      });
    }
  }

  function renderSurveyCard() {
    const s = state.survey, c = surveyCalc(), fp = c.fp;
    const have = surveyItemCount();
    const speed = Number(state.settings.speed) || 0;
    const area = s.area.length >= 3 ? G.polygonArea(s.area) : 0;
    const stat = (v, l) => `<div><b>${v}</b><span class="muted">${l}</span></div>`;
    const check = (label, bind) => `<label class="f" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-bind="${bind}" ${s[bind.split(':')[1]] ? 'checked' : ''} style="width:auto"> ${label}</label>`;
    let stats = '';
    if (fp) {
      stats += stat(isFinite(fp.gsd) ? fp.gsd.toFixed(1) + ' cm/px' : '–', 'ground resolution (GSD)');
      stats += stat(`${Math.round(fp.across)} × ${Math.round(fp.along)} m`, 'image footprint');
      stats += stat(fp.spacing > 0 ? Math.round(fp.spacing * 10) / 10 + ' m' : '–', 'line spacing');
      stats += stat(fp.trigger > 0 ? Math.round(fp.trigger * 10) / 10 + ' m' : '–', 'trigger distance');
    }
    if (c.gen) {
      stats += stat(c.gen.lines, 'flight lines');
      stats += stat(c.gen.points.length, 'waypoints');
      stats += stat(fmtDist(c.gen.length), 'survey distance');
      stats += stat(speed > 0 ? fmtTime(c.gen.length / speed) : '–', `time @ ${speed} m/s`);
      if (fp.trigger > 0) stats += stat('≈ ' + Math.ceil(c.gen.length / fp.trigger), 'photos');
    }
    if (area) stats += stat(fmtArea(area), 'area');
    const open = ui.surveyOpen;
    const header = `<h3><button class="card-toggle" data-act="survey-toggle" aria-expanded="${open}" aria-controls="survey-body"><span class="chev">${open ? '▾' : '▸'}</span>Survey (grid)</button>
        ${open ? `<button class="b" data-act="tool:survey">${ui.tool === 'survey' ? 'Stop drawing' : s.area.length ? 'Redraw area' : 'Draw area'}</button>` : ''}</h3>`;
    if (!open) {
      const bits = [s.area.length >= 3 ? `${s.area.length} corners` : 'No area drawn'];
      if (have) bits.push(`${have} items in mission`);
      return `<div class="card collapsed" id="survey-card">${header}<p class="help" style="margin:0">${bits.join(' · ')}. Click to open the grid survey tools.</p></div>`;
    }
    return `
    <div class="card" id="survey-card">
      ${header}
      <div id="survey-body">
      ${s.area.length >= 3 ? `<p class="help" style="margin:0 0 8px">${s.area.length} corners. Drag a corner to move it, click a midpoint handle to add one, right-click a corner to remove it.</p>`
        : '<p class="help" style="margin:0 0 8px">Pick <b>Draw area</b> and click the corners of the area you want to cover. Choose your camera and overlaps below, then generate the waypoints.</p>'}
      ${selectField('Camera', 'survey:camera', s.camera, SV.CAMERAS.map((k) => [k.id, k.name]))}
      ${s.camera === 'custom' ? `<div class="grid3" style="margin-top:8px">
        ${field('Sensor width (mm)', 'survey:cam:sw', s.cam.sw, { min: 0 })}${field('Sensor height (mm)', 'survey:cam:sh', s.cam.sh, { min: 0 })}${field('Focal length (mm)', 'survey:cam:focal', s.cam.focal, { min: 0 })}
        ${field('Image width (px)', 'survey:cam:iw', s.cam.iw, { min: 0 })}${field('Image height (px)', 'survey:cam:ih', s.cam.ih, { min: 0 })}</div>` : ''}
      <div class="grid2" style="margin-top:8px">
        ${field('Altitude (m, above home)', 'survey:alt', s.alt, { min: 1 })}
        ${selectField('Camera orientation', 'survey:portrait', Number(s.portrait), [[0, 'Landscape'], [1, 'Portrait']])}
        ${field('Front overlap (%)', 'survey:front', s.front, { min: 0 })}
        ${field('Side overlap (%)', 'survey:side', s.side, { min: 0 })}
        ${field('Line angle (° from north)', 'survey:angle', s.angle)}
        ${field('Overshoot (m)', 'survey:overshoot', s.overshoot, { min: 0 })}
      </div>
      <div class="btns" style="align-items:center">
        ${s.area.length >= 3 ? '<button class="b" data-act="survey-best-angle" title="Fly along the longest side of the area">Align to longest side</button>' : ''}
        ${check('Camera trigger commands', 'survey:trigger')}
        ${check('Start from the other side', 'survey:reverse')}
      </div>
      <div class="stats" style="margin-top:10px">${stats}</div>
      ${c.error && s.area.length >= 3 ? `<p class="help" style="color:var(--err)">${esc(c.error)}</p>` : ''}
      ${fp && fp.trigger <= 0 ? '<p class="help" style="color:var(--warn)">Front overlap is too high for a trigger distance.</p>' : ''}
      <div class="btns">
        <button class="b primary" data-act="survey-gen"${c.gen ? '' : ' disabled'}>${have ? 'Regenerate waypoints' : 'Generate waypoints'}</button>
        ${have ? '<button class="b" data-act="terrain-check">Check terrain</button><button class="b danger" data-act="survey-remove">Remove survey waypoints</button>' : ''}
        ${s.area.length ? '<button class="b" data-act="survey-clear-area">Clear area</button>' : ''}
      </div>
      <p class="help">${have ? `${have} survey items are in the mission${surveyPending() ? '. <b>Settings changed. Regenerate to update them.</b>' : '.'} ` : ''}Waypoints are relative to home. The dashed cyan line previews the path. Camera values are typical, so check them against your camera's datasheet.</p>
      </div>
    </div>`;
  }

  function renderMissionPanel() {
    const s = state.settings;
    const st = missionStats();
    const sel = ui.sel && ui.sel.kind === 'wp' ? findWp(ui.sel.id) : null;
    const h = state.home;
    let html = `
    <div class="card">
      <h3>Plan</h3>
      ${field('Plan name (used for file names)', 'planName', state.planName, { type: 'text' })}
      <div class="stats" style="margin-top:10px">
        <div><b>${state.mission.length}</b><span class="muted">items</span></div>
        <div><b>${fmtDist(st.total)}</b><span class="muted">flight distance${st.rtl ? ' incl. RTL' : ''}</span></div>
        <div><b>${fmtTime(st.time)}</b><span class="muted">est. time @ ${s.speed} m/s</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Home / launch point</h3>
      ${h ? `<div class="grid3">${field('Latitude', 'home:lat', h.lat)}${field('Longitude', 'home:lon', h.lon)}${field('Alt AMSL (m)', 'home:alt', h.alt)}</div>`
          : '<p class="muted" style="margin:0">Not set. Use “Set home” and click the launch site.</p>'}
      <div class="btns"><button class="b" data-act="tool:home">${h ? 'Move' : 'Set'} home on map</button>${h ? '<button class="b danger" data-act="clear-home">Clear</button>' : ''}</div>
    </div>
    <div class="card">
      <h3>Defaults for new waypoints</h3>
      <div class="grid2">
        ${field('Altitude (m)', 'settings:defaultAlt', s.defaultAlt)}
        ${selectField('Altitude frame', 'settings:defaultFrame', s.defaultFrame, frameOptions(s.defaultFrame))}
        ${field('Cruise speed (m/s)', 'settings:speed', s.speed, { min: 0 })}
        ${field('Max altitude check (m)', 'settings:maxAlt', s.maxAlt, { min: 0 })}
      </div>
      <div class="btns">
        <button class="b" data-act="all-alt">Apply altitude to all</button>
        <label class="f" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-bind="ui:showLegs" ${ui.showLegs ? 'checked' : ''} style="width:auto"> Show leg distances</label>
      </div>
    </div>
    <div class="card">
      <h3><span class="grow">Mission items</span>
        <button class="b" data-act="tool:wp">${ui.tool === 'wp' ? 'Stop adding' : '+ Waypoints'}</button></h3>
      <div class="btns" style="margin:0 0 8px">
        <button class="b" data-act="add-takeoff">+ Takeoff</button>
        <button class="b" data-act="append-cmd:20" title="Append at the end">+ RTL</button>
        <button class="b" data-act="append-cmd:21" title="Append at the end">+ Land</button>
        <select class="b" data-act-select="add-cmd" aria-label="Add another command">
          <option value="">+ Other command…</option>
          ${F.CMD_ORDER.filter((c) => ![16, 20, 21].includes(c)).map((c) => `<option value="${c}">${esc(F.CMD[c].label)}</option>`).join('')}
        </select>
      </div>
      ${state.mission.length ? '<div class="list-head row mission-row" style="cursor:default"><span>#</span><span>Command</span><span>Alt (m)</span><span style="text-align:right">Leg</span><span></span></div>' : ''}
      <div class="list" id="mission-list">
        ${state.mission.length ? state.mission.map((it, i) => {
          const info = F.cmdInfo(it.cmd);
          const altOn = info.alt;
          return `<div class="row mission-row${isSel('wp', it.id) ? ' selected' : ''}" data-sel="wp:${it.id}">
            <span class="idx">${i + 1}</span>
            <select data-bind="wp:${it.id}:cmd">${cmdOptions(it.cmd).map(([v, t]) => `<option value="${v}"${v == it.cmd ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
            <input type="number" step="any" data-bind="wp:${it.id}:alt" value="${altOn ? it.alt : ''}" ${altOn ? '' : 'disabled'} aria-label="Altitude">
            <span class="dist">${st.legDist[it.id] !== undefined ? fmtDist(st.legDist[it.id]) : ''}</span>
            <span class="row-actions">
              <button data-act="wp-del:${it.id}" title="Delete">✕</button>
            </span></div>`;
        }).join('') : '<div class="empty">No items yet.</div>'}
      </div>
      ${state.mission.length ? '<div class="btns"><button class="b" data-act="terrain-check" title="Compare waypoint heights with the terrain">Check terrain</button><button class="b" data-act="reverse">Reverse order</button><button class="b danger" data-act="clear-mission">Clear mission</button></div>' : ''}
    </div>`;
    html += renderSurveyCard();

    if (sel) {
      const i = state.mission.indexOf(sel);
      const info = F.cmdInfo(sel.cmd);
      const params = info.params.map((lbl, k) => lbl ? field(lbl, `wp:${sel.id}:p${k}`, sel.p[k]) : '').join('');
      const showPos = info.loc !== false;
      html += `
      <div class="card" id="editor">
        <h3>Item ${i + 1} · ${esc(info.label)}</h3>
        <div class="grid2">
          ${selectField('Command', `wp:${sel.id}:cmd`, sel.cmd, cmdOptions(sel.cmd))}
          ${info.alt || showPos ? selectField('Altitude frame', `wp:${sel.id}:frame`, sel.frame, frameOptions(sel.frame)) : '<span></span>'}
          ${showPos ? field('Latitude', `wp:${sel.id}:lat`, sel.lat) + field('Longitude', `wp:${sel.id}:lon`, sel.lon) : ''}
          ${info.alt ? field('Altitude (m)', `wp:${sel.id}:alt`, sel.alt) : ''}
          ${params}
        </div>
        <p class="help">${esc(info.help)}</p>
        ${info.loc === 'opt' ? `<div class="btns"><button class="b" data-act="pos-from-center:${sel.id}">Place at map centre</button>${F.itemHasPosition(sel) ? `<button class="b" data-act="pos-clear:${sel.id}">Use current position (0,0)</button>` : ''}</div>` : ''}
      </div>`;
    }
    html += checksHtml(missionChecks());
    return html;
  }

  function renderFencePanel() {
    const f = state.fence;
    const sel = selectedObject();
    let html = `
    <div class="card">
      <h3>Geofence zones</h3>
      <div class="btns" style="margin-top:0">
        <button class="b" data-act="tool:poly-inclusion">+ Inclusion polygon</button>
        <button class="b" data-act="tool:poly-exclusion">+ Exclusion polygon</button>
        <button class="b" data-act="tool:circle-inclusion">+ Inclusion circle</button>
        <button class="b" data-act="tool:circle-exclusion">+ Exclusion circle</button>
      </div>
      <div class="list" style="margin-top:10px">
        ${f.polygons.map((p, i) => `<div class="row shape-row${isSel('poly', p.id) ? ' selected' : ''}" data-sel="poly:${p.id}">
            <span class="swatch" style="background:${p.type === 'exclusion' ? 'var(--excl)' : 'var(--incl)'}"></span>
            <span>${cap(p.type)} polygon ${i + 1} <span class="muted">· ${p.points.length} vertices · ${fmtArea(G.polygonArea(p.points))}</span></span>
            <span class="row-actions"><button data-act="poly-del:${p.id}" title="Delete">✕</button></span></div>`).join('')}
        ${f.circles.map((c, i) => `<div class="row shape-row${isSel('circle', c.id) ? ' selected' : ''}" data-sel="circle:${c.id}">
            <span class="swatch" style="border-radius:50%;background:${c.type === 'exclusion' ? 'var(--excl)' : 'var(--incl)'}"></span>
            <span>${cap(c.type)} circle ${i + 1} <span class="muted">· r ${Math.round(c.radius)} m</span></span>
            <span class="row-actions"><button data-act="circle-del:${c.id}" title="Delete">✕</button></span></div>`).join('')}
        ${!f.polygons.length && !f.circles.length ? '<div class="empty">No zones yet.</div>' : ''}
      </div>
      <div class="grid2" style="margin-top:8px">${field('Default circle radius (m)', 'settings:circleRadius', state.settings.circleRadius, { min: 1 })}</div>
      ${f.polygons.length || f.circles.length ? '<div class="btns"><button class="b danger" data-act="clear-fence">Clear fence</button></div>' : ''}
    </div>`;

    if (sel && ui.sel.kind === 'poly') {
      html += `<div class="card" id="editor"><h3><span class="grow">${cap(sel.type)} polygon · vertices</span>
        <button class="b" data-act="poly-type:${sel.id}">Make ${sel.type === 'inclusion' ? 'exclusion' : 'inclusion'}</button></h3>
        <div class="list">${sel.points.map((pt, k) => `<div class="row" style="grid-template-columns:22px 1fr 1fr auto;cursor:default">
          <span class="idx">${k + 1}</span>
          <input type="number" step="any" data-bind="poly:${sel.id}:${k}:lat" value="${pt.lat}" aria-label="Latitude">
          <input type="number" step="any" data-bind="poly:${sel.id}:${k}:lon" value="${pt.lon}" aria-label="Longitude">
          <span class="row-actions"><button data-act="vtx-del:${sel.id}:${k}" title="Delete vertex">✕</button></span></div>`).join('')}
        </div>
        <p class="help">Drag the square handles on the map to move vertices. Click a round midpoint handle to add a vertex. Right-click a vertex to delete it.</p></div>`;
    } else if (sel && ui.sel.kind === 'circle') {
      html += `<div class="card" id="editor"><h3><span class="grow">${cap(sel.type)} circle</span>
        <button class="b" data-act="circle-type:${sel.id}">Make ${sel.type === 'inclusion' ? 'exclusion' : 'inclusion'}</button></h3>
        <div class="grid3">${field('Latitude', `circle:${sel.id}:lat`, sel.lat)}${field('Longitude', `circle:${sel.id}:lon`, sel.lon)}${field('Radius (m)', `circle:${sel.id}:radius`, sel.radius, { min: 1 })}</div></div>`;
    }

    html += `<div class="card"><h3>Return point</h3>
      ${f.returnPoint ? `<div class="grid2">${field('Latitude', 'ret:lat', f.returnPoint.lat)}${field('Longitude', 'ret:lon', f.returnPoint.lon)}</div>` : '<p class="muted" style="margin:0">Not set (optional).</p>'}
      <div class="btns"><button class="b" data-act="tool:return">${f.returnPoint ? 'Move' : 'Set'} on map</button>${f.returnPoint ? '<button class="b danger" data-act="ret-clear">Clear</button>' : ''}</div></div>`;
    html += checksHtml(fenceChecks());
    return html;
  }
  function fmtArea(m2) { return m2 >= 1e6 ? (m2 / 1e6).toFixed(2) + ' km²' : Math.round(m2).toLocaleString() + ' m²'; }

  function renderRallyPanel() {
    let html = `
    <div class="card">
      <h3><span class="grow">Rally points</span><button class="b" data-act="tool:rally">${ui.tool === 'rally' ? 'Stop adding' : '+ Rally points'}</button></h3>
      <div class="grid2" style="margin-bottom:8px">${field('Default altitude (m, relative)', 'settings:rallyAlt', state.settings.rallyAlt)}</div>
      ${state.rally.length ? '<div class="list-head row rally-row" style="cursor:default"><span>#</span><span>Latitude</span><span>Longitude</span><span>Alt (m)</span><span></span></div>' : ''}
      <div class="list">${state.rally.length ? state.rally.map((r, i) => `<div class="row rally-row${isSel('rally', r.id) ? ' selected' : ''}" data-sel="rally:${r.id}">
        <span class="idx">R${i + 1}</span>
        <input type="number" step="any" data-bind="rally:${r.id}:lat" value="${r.lat}" aria-label="Latitude">
        <input type="number" step="any" data-bind="rally:${r.id}:lon" value="${r.lon}" aria-label="Longitude">
        <input type="number" step="any" data-bind="rally:${r.id}:alt" value="${r.alt}" aria-label="Altitude">
        <span class="row-actions"><button data-act="rally-del:${r.id}" title="Delete">✕</button></span></div>`).join('') : '<div class="empty">No rally points yet.</div>'}</div>
      ${state.rally.length ? '<div class="btns"><button class="b" data-act="rally-all-alt">Apply default altitude to all</button><button class="b danger" data-act="clear-rally">Clear rally points</button></div>' : ''}
      <p class="help">Rally points are alternative return locations. On RTL the vehicle flies to the closest rally point (or home) at the given altitude above home.</p>
    </div>`;
    html += checksHtml(rallyChecks());
    return html;
  }

  function renderSidebar() {
    const sb = $('#sidebar');
    const focusKey = document.activeElement && sb.contains(document.activeElement) ? document.activeElement.dataset.bind : null;
    const scroll = sb.scrollTop;
    sb.innerHTML = ui.mode === 'mission' ? renderMissionPanel() : ui.mode === 'fence' ? renderFencePanel() : renderRallyPanel();
    sb.scrollTop = scroll;
    if (focusKey) {
      const el = sb.querySelector(`[data-bind="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (el.select && el.type !== 'number') el.select(); }
    }
  }

  function scrollToSelected() {
    requestAnimationFrame(() => {
      const el = $('#sidebar .row.selected');
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  }

  // ----------------------------------------------------- sidebar events
  function setBound(bind, el) {
    const parts = bind.split(':');
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    const numv = Number(raw);
    const isNum = el.type === 'number' || el.tagName === 'SELECT';
    if (isNum && el.type === 'number' && (raw === '' || !isFinite(numv))) { scheduleRender(); return; }
    const v = isNum ? numv : raw;

    if (parts[0] === 'ui') { ui[parts[1]] = raw; scheduleRender(); return; }
    mutate(() => {
      switch (parts[0]) {
        case 'planName': state.planName = String(raw); break;
        case 'survey': {
          const sv = state.survey;
          if (parts[1] === 'camera') {
            const c = SV.cameraById(raw);
            sv.camera = String(raw);
            if (c && c.id !== 'custom') sv.cam = { sw: c.sw, sh: c.sh, focal: c.focal, iw: c.iw, ih: c.ih };
          } else if (parts[1] === 'cam') { sv.cam[parts[2]] = v; sv.camera = 'custom'; }
          else sv[parts[1]] = v;
          break;
        }
        case 'settings': state.settings[parts[1]] = v; break;
        case 'home': state.home[parts[1]] = v; break;
        case 'ret': state.fence.returnPoint[parts[1]] = v; break;
        case 'wp': {
          const it = findWp(Number(parts[1]));
          if (!it) break;
          const key = parts[2];
          if (key === 'cmd') changeCommand(it, v);
          else if (key[0] === 'p' && key.length === 2) it.p[Number(key[1])] = v;
          else it[key] = v;
          break;
        }
        case 'poly': {
          const p = findPoly(Number(parts[1]));
          if (p && p.points[Number(parts[2])]) p.points[Number(parts[2])][parts[3]] = v;
          break;
        }
        case 'circle': { const c = findCircle(Number(parts[1])); if (c) c[parts[2]] = v; break; }
        case 'rally': { const r = findRally(Number(parts[1])); if (r) r[parts[2]] = v; break; }
      }
    });
  }

  function changeCommand(it, cmd) {
    const before = F.cmdInfo(it.cmd);
    const after = F.cmdInfo(cmd);
    const fresh = newCommand(cmd);
    it.cmd = cmd;
    it.p = fresh.p;
    // gaining a position: put it at the map centre if it had none
    if (after.loc === true && !(it.lat || it.lon)) {
      const c = map.getCenter(); it.lat = r6(c.lat); it.lon = r6(c.lng);
    }
    if (after.alt && !before.alt) it.alt = Number(state.settings.defaultAlt);
  }

  $('#sidebar').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.bind) setBound(el.dataset.bind, el);
    else if (el.dataset.actSelect === 'add-cmd' && el.value) {
      const cmd = Number(el.value);
      mutate(() => {
        const item = newCommand(cmd);
        if (F.cmdInfo(cmd).loc === true) { const c = map.getCenter(); item.lat = r6(c.lat); item.lon = r6(c.lng); }
        insertMissionItem(item);
      });
    }
  });

  $('#sidebar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act && act.tagName === 'BUTTON') { handleAction(act.dataset.act); return; }
    if (e.target.closest('input, select, label')) {
      const row = e.target.closest('[data-sel]');
      if (row) selectRow(row.dataset.sel, false);
      return;
    }
    const row = e.target.closest('[data-sel]');
    if (row) selectRow(row.dataset.sel, true);
  });

  function selectRow(sel, pan) {
    const [kind, id] = sel.split(':');
    if (isSel(kind, Number(id))) return;
    ui.sel = { kind, id: Number(id) };
    const o = selectedObject();
    if (pan && o) {
      if (kind === 'poly' && o.points.length) map.fitBounds(o.points.map((p) => [p.lat, p.lon]), { padding: [60, 60], maxZoom: map.getZoom() });
      else if (o.lat !== undefined && (o.lat || o.lon) && !map.getBounds().contains([o.lat, o.lon])) map.panTo([o.lat, o.lon]);
    }
    scheduleRender();
  }

  function handleAction(a) {
    const [name, x, y] = a.split(':');
    const id = Number(x);
    switch (name) {
      case 'tool': {
        const t = a.slice(5);
        if (ui.drawing) finishPolygon();
        setTool(ui.tool === t ? null : t);
        break;
      }
      case 'survey-toggle':
        ui.surveyOpen = !ui.surveyOpen;
        scheduleRender();
        if (ui.surveyOpen) requestAnimationFrame(() => requestAnimationFrame(() => { const c = $('#survey-card'); if (c) c.scrollIntoView({ block: 'nearest' }); }));
        break;
      case 'survey-gen': generateSurvey(); break;
      case 'terrain-check': terrainCheck(); break;
      case 'survey-remove': mutate(() => { state.mission = state.mission.filter((it) => !it.survey); ui.sel = null; }); break;
      case 'survey-clear-area': mutate(() => { state.survey.area = []; }); break;
      case 'survey-best-angle': mutate(() => { state.survey.angle = SV.longestEdgeAngle(state.survey.area); }); break;
      case 'clear-home': mutate(() => { state.home = null; }); break;
      case 'all-alt':
        mutate(() => state.mission.forEach((it) => {
          if (F.cmdInfo(it.cmd).alt) { it.alt = Number(state.settings.defaultAlt); it.frame = Number(state.settings.defaultFrame); }
        }));
        toast('Altitude set to ' + state.settings.defaultAlt + ' m for all items');
        break;
      case 'add-takeoff':
        mutate(() => {
          const t = newCommand(22);
          state.mission.unshift(t);
          ui.sel = { kind: 'wp', id: t.id };
        });
        break;
      case 'add-cmd': mutate(() => insertMissionItem(newCommand(id))); break;
      case 'append-cmd': mutate(() => {
        const it = newCommand(id);
        state.mission.push(it);
        ui.sel = { kind: 'wp', id: it.id };
      }); break;
      case 'wp-del': mutate(() => { state.mission = state.mission.filter((w) => w.id !== id); if (isSel('wp', id)) ui.sel = null; }); break;
      case 'reverse': mutate(() => {
        // keep a leading takeoff and trailing RTL/LAND in place
        const m = state.mission;
        const head = m[0] && m[0].cmd === 22 ? 1 : 0;
        const tail = m.length > head && [20, 21].includes(m[m.length - 1].cmd) ? 1 : 0;
        const mid = m.slice(head, m.length - tail).reverse();
        state.mission = m.slice(0, head).concat(mid, m.slice(m.length - tail));
      }); break;
      case 'clear-mission':
        if (confirm('Delete all mission items?')) mutate(() => { state.mission = []; ui.sel = null; });
        break;
      case 'pos-from-center': mutate(() => { const it = findWp(id); const c = map.getCenter(); it.lat = r6(c.lat); it.lon = r6(c.lng); }); break;
      case 'pos-clear': mutate(() => { const it = findWp(id); it.lat = 0; it.lon = 0; }); break;

      case 'poly-del': mutate(() => { state.fence.polygons = state.fence.polygons.filter((p) => p.id !== id); if (ui.drawing === id) { ui.drawing = null; ui.tool = null; } if (isSel('poly', id)) ui.sel = null; }); break;
      case 'circle-del': mutate(() => { state.fence.circles = state.fence.circles.filter((c) => c.id !== id); if (isSel('circle', id)) ui.sel = null; }); break;
      case 'poly-type': mutate(() => { const p = findPoly(id); p.type = p.type === 'inclusion' ? 'exclusion' : 'inclusion'; }); break;
      case 'circle-type': mutate(() => { const c = findCircle(id); c.type = c.type === 'inclusion' ? 'exclusion' : 'inclusion'; }); break;
      case 'vtx-del': {
        const p = findPoly(id);
        if (p.points.length <= 3 && ui.drawing !== id) { toast('A polygon needs at least 3 vertices'); break; }
        mutate(() => p.points.splice(Number(y), 1));
        break;
      }
      case 'ret-clear': mutate(() => { state.fence.returnPoint = null; }); break;
      case 'clear-fence':
        if (confirm('Delete all fence zones and the return point?')) mutate(() => { state.fence = { returnPoint: null, polygons: [], circles: [] }; ui.sel = null; ui.drawing = null; });
        break;

      case 'rally-del': mutate(() => { state.rally = state.rally.filter((r) => r.id !== id); if (isSel('rally', id)) ui.sel = null; }); break;
      case 'rally-all-alt': mutate(() => state.rally.forEach((r) => { r.alt = Number(state.settings.rallyAlt); })); break;
      case 'clear-rally':
        if (confirm('Delete all rally points?')) mutate(() => { state.rally = []; ui.sel = null; });
        break;
    }
  }

  // ------------------------------------------------------------- modes
  function setMode(mode) {
    if (ui.drawing) finishPolygon();
    if (ui.tool === 'survey') endSurveyDrawing();
    ui.mode = mode;
    ui.tool = null;
    ui.sel = null;
    $('.map-wrap').classList.remove('tool-on');
    document.querySelectorAll('.mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.setAttribute('aria-selected', b.dataset.mode === mode);
    });
    scheduleRender();
  }
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
    if (e.key === 'Escape') {
      if (ui.drawing) finishPolygon();
      else if (ui.tool) setTool(null);
      else if (ui.sel) select(null);
    }
    if (e.key === 'Enter' && ui.drawing && !typing) finishPolygon();
    if (e.key === 'Enter' && ui.tool === 'survey' && ui.surveyDrawing && !typing) setTool(null);
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ui.sel) {
      e.preventDefault();
      const k = ui.sel.kind;
      handleAction({ wp: 'wp-del', poly: 'poly-del', circle: 'circle-del', rally: 'rally-del' }[k] + ':' + ui.sel.id);
    }
  });
  $('#btn-undo').addEventListener('click', undo);

  // ============================================================ IMPORT
  $('#file-import').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) {
      try {
        const text = await file.text();
        importText(text, file.name);
      } catch (err) {
        toast(file.name + ': ' + err.message, true);
      }
    }
    zoomToPlan();
  });

  function withIds(arr) { return arr.map((o) => Object.assign({ id: nid() }, o)); }

  function importText(text, name) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const obj = JSON.parse(trimmed);
      if (obj.format === 'uas-mission-planner-project') {
        if (!confirm(`Replace the current plan with project "${name}"?`)) return;
        snapshot();
        state = normalizeState(obj.state);
        reindexIds();
        ui.sel = null;
        changed();
        toast('Project loaded');
        return;
      }
      if (obj.fileType === 'Plan') {
        const r = F.parseQGCPlan(obj);
        mutate(() => {
          if (r.mission && r.mission.items.length) { state.mission = withIds(r.mission.items); if (r.mission.home) state.home = r.mission.home; }
          if (r.fence && (r.fence.polygons.length || r.fence.circles.length)) {
            state.fence = { returnPoint: r.fence.returnPoint, polygons: withIds(r.fence.polygons), circles: withIds(r.fence.circles) };
          }
          if (r.rally && r.rally.length) state.rally = withIds(r.rally);
          ui.sel = null;
        });
        toast('QGroundControl plan imported' + (r.skipped ? ` (${r.skipped} complex item(s) such as surveys skipped)` : ''));
        return;
      }
      throw new Error('Unrecognised JSON file');
    }
    const r = F.parseQGC(text);
    mutate(() => {
      if (r.kind === 'mission') {
        state.mission = withIds(r.items);
        if (r.home) state.home = r.home;
        setMode('mission');
      } else if (r.kind === 'fence') {
        state.fence = { returnPoint: r.fence.returnPoint, polygons: withIds(r.fence.polygons), circles: withIds(r.fence.circles) };
        setMode('fence');
      } else {
        state.rally = withIds(r.points);
        setMode('rally');
      }
      ui.sel = null;
    });
    toast(`${name}: ${r.kind} imported`);
  }

  // ============================================================ EXPORT
  $('#btn-save-project').addEventListener('click', () => {
    download(safeName() + '.project.json', JSON.stringify({ format: 'uas-mission-planner-project', version: 1, saved: new Date().toISOString(), state }, null, 2), 'application/json');
  });

  function exportFiles() {
    const base = safeName();
    return [
      {
        key: 'mission', label: 'Mission', count: state.mission.length, unit: 'items',
        filename: base + '_mission.waypoints',
        text: state.mission.length ? F.missionToQGC({ home: state.home, items: state.mission }) : '',
        checks: missionChecks(),
      },
      {
        key: 'fence', label: 'Geofence', count: state.fence.polygons.length + state.fence.circles.length, unit: 'zones',
        filename: base + '_fence.waypoints',
        text: state.fence.polygons.length || state.fence.circles.length || state.fence.returnPoint
          ? F.fenceToQGC({ returnPoint: state.fence.returnPoint, polygons: state.fence.polygons.filter((p) => p.points.length >= 3), circles: state.fence.circles })
          : '',
        checks: fenceChecks(),
      },
      {
        key: 'rally', label: 'Rally points', count: state.rally.length, unit: 'points',
        filename: base + '_rally.waypoints',
        text: state.rally.length ? F.rallyToQGC(state.rally) : '',
        checks: rallyChecks(),
      },
    ];
  }

  $('#btn-export').addEventListener('click', () => {
    if (ui.drawing) finishPolygon();
    const files = exportFiles();
    const body = $('#export-body');
    body.innerHTML = files.map((f) => {
      const errs = f.checks.filter((c) => c[0] === 'error').length;
      const warns = f.checks.filter((c) => c[0] === 'warn').length;
      const status = !f.text ? '<span class="muted">nothing to export</span>'
        : errs ? `<span style="color:var(--err)">${errs} error(s)</span>` : warns ? `<span style="color:var(--warn)">${warns} warning(s)</span>` : '<span style="color:#067647">ready</span>';
      return `<div class="exp"><div class="exp-top">
          <div class="name"><b>${f.label}</b> · ${f.count} ${f.unit} · ${status}<br><code>${esc(f.filename)}</code></div>
          <button type="button" class="b primary" data-dl="${f.key}" ${f.text ? '' : 'disabled'}>Download</button></div>
          ${f.text ? `<details><summary>Preview file</summary><pre>${esc(f.text)}</pre></details>` : ''}</div>`;
    }).join('') + `
      <div class="btns" style="margin:0 0 14px"><button type="button" class="b primary" data-dl="all">Download all</button></div>
      <div class="howto"><b>Loading the files in Mission Planner</b>
        <ol>
          <li>Open the <b>PLAN</b> screen.</li>
          <li>In the drop-down above the waypoint list (next to the altitude frame), choose <b>Mission</b>, <b>Fence</b> or <b>Rally</b>.</li>
          <li>Click <b>Load File</b> (or right-click the map → <i>File Load/Save</i>) and pick the matching file.</li>
          <li>Check the plan on the map, then <b>Write</b> it to the vehicle (or simulator).</li>
        </ol>
      </div>`;
    $('#export-dialog').showModal();
  });

  $('#export-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dl]');
    if (!b) return;
    const files = exportFiles().filter((f) => f.text && (b.dataset.dl === 'all' || f.key === b.dataset.dl));
    if (!files.length) return toast('Nothing to export');
    files.forEach((f, i) => setTimeout(() => download(f.filename, f.text), i * 400));
  });

  // ============================================================ RENDER
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 0);
  }
  function render() {
    renderFence();
    renderSurvey();
    renderMissionPath();
    renderMissionMarkers();
    renderRally();
    renderTools();
    renderSidebar();
  }

  render();
  if (state.mission.length || state.fence.polygons.length || state.rally.length || state.home) zoomToPlan();

  // ---------------------------------------------------------- info popover
  const infoBtn = $('#btn-info'), infoPop = $('#info-pop');
  function setInfo(open) {
    infoPop.hidden = !open;
    infoBtn.setAttribute('aria-expanded', open);
  }
  infoBtn.addEventListener('click', (e) => { e.stopPropagation(); setInfo(infoPop.hidden); });
  document.addEventListener('click', (e) => { if (!infoPop.hidden && !infoPop.contains(e.target)) setInfo(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setInfo(false); });

  // expose for debugging / tests and the tutorial
  window.__planner = { get state() { return state; }, ui, map, F, importText, exportFiles, setMode, setTool, render: scheduleRender };
})();
