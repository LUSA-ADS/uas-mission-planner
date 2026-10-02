/*
 * formats.js — Mission Planner / ArduPilot file formats and geometry helpers.
 *
 * All three plan types are written in the "QGC WPL 110" plain-text format,
 * which is what Mission Planner reads and writes from its Plan screen:
 *
 *   QGC WPL 110
 *   <index> <current> <frame> <command> <p1> <p2> <p3> <p4> <lat> <lon> <alt> <autocontinue>
 *
 * (fields separated by TAB)
 *
 *  - Mission : line 0 is the home position, then mission items 1..N.
 *  - Geofence: MAV_CMD_NAV_FENCE_* items (5000 return point, 5001/5002 polygon
 *              vertices with p1 = vertex count, 5003/5004 circles with p1 = radius).
 *  - Rally   : MAV_CMD_NAV_RALLY_POINT (5100) items.
 *
 * This file has no DOM dependencies so it can be unit-tested in Node.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- frames
  const FRAME = { ABSOLUTE: 0, RELATIVE: 3, TERRAIN: 10 };
  const FRAME_LABELS = {
    0: 'Absolute (above sea level)',
    3: 'Relative to home',
    10: 'Above terrain',
  };

  // -------------------------------------------------------------- commands
  // loc:  true  -> item has a map position
  //       'opt' -> position optional (0,0 means "current position")
  //       false -> no position
  // alt:  altitude field is meaningful
  // nav:  item is a navigation command (drawn as part of the flight path)
  const CMD = {
    16: { name: 'WAYPOINT', label: 'Waypoint', loc: true, alt: true, nav: true,
      params: ['Hold time (s)', 'Accept radius (m)', 'Pass radius (m)', 'Yaw (deg)'],
      help: 'Fly to this position. Hold time makes a copter pause at the waypoint.' },
    82: { name: 'SPLINE_WAYPOINT', label: 'Spline waypoint', loc: true, alt: true, nav: true,
      params: ['Hold time (s)', null, null, null],
      help: 'Fly to this position along a smooth curved path (copter).' },
    22: { name: 'TAKEOFF', label: 'Takeoff', loc: false, alt: true, nav: true,
      params: ['Min pitch (deg, plane)', null, null, 'Yaw (deg)'],
      help: 'Climb to the given altitude above the current position. Should normally be the first item.' },
    17: { name: 'LOITER_UNLIM', label: 'Loiter (unlimited)', loc: true, alt: true, nav: true,
      params: [null, null, 'Radius (m)', 'Yaw (deg)'],
      help: 'Loiter at this position until the mode is changed. The mission does not continue.' },
    18: { name: 'LOITER_TURNS', label: 'Loiter (turns)', loc: true, alt: true, nav: true,
      params: ['Turns', null, 'Radius (m)', 'Exit (0 = centre, 1 = tangent)'],
      help: 'Circle this position a number of times, then continue.' },
    19: { name: 'LOITER_TIME', label: 'Loiter (time)', loc: true, alt: true, nav: true,
      params: ['Time (s)', null, 'Radius (m)', 'Exit (0 = centre, 1 = tangent)'],
      help: 'Loiter at this position for a set time, then continue.' },
    31: { name: 'LOITER_TO_ALT', label: 'Loiter to altitude', loc: true, alt: true, nav: true,
      params: ['Heading required (0/1)', 'Radius (m)', null, 'Exit (0 = centre, 1 = tangent)'],
      help: 'Circle this position until the altitude is reached (plane).' },
    21: { name: 'LAND', label: 'Land', loc: 'opt', alt: false, nav: true,
      params: ['Abort alt (m)', 'Precision land (0-2)', null, 'Yaw (deg)'],
      help: 'Land at this position. If no position is set (0, 0) the vehicle lands where it is.' },
    20: { name: 'RETURN_TO_LAUNCH', label: 'Return to launch (RTL)', loc: false, alt: false, nav: true,
      params: [null, null, null, null],
      help: 'Return to the home position (or nearest rally point, if enabled) and land / loiter according to RTL parameters.' },
    93: { name: 'DELAY', label: 'Delay', loc: false, alt: false, nav: true,
      params: ['Delay (s)', 'Hour (UTC, -1 = ignore)', 'Minute', 'Second'],
      help: 'Wait at the current position before continuing.' },
    112: { name: 'CONDITION_DELAY', label: 'Condition: delay', loc: false, alt: false,
      params: ['Delay (s)', null, null, null],
      help: 'Delay the next DO command(s) by a number of seconds.' },
    114: { name: 'CONDITION_DISTANCE', label: 'Condition: distance', loc: false, alt: false,
      params: ['Distance (m)', null, null, null],
      help: 'Run the next DO command(s) when the vehicle is this close to the next waypoint.' },
    115: { name: 'CONDITION_YAW', label: 'Condition: yaw', loc: false, alt: false,
      params: ['Heading (deg)', 'Rate (deg/s)', 'Direction (-1 ccw, 1 cw)', 'Relative (0/1)'],
      help: 'Turn the vehicle to a heading (copter).' },
    177: { name: 'DO_JUMP', label: 'Do jump', loc: false, alt: false,
      params: ['Target item #', 'Repeat count', null, null],
      help: 'Jump back to an earlier item number, repeated the given number of times.' },
    178: { name: 'DO_CHANGE_SPEED', label: 'Change speed', loc: false, alt: false,
      params: ['Speed type (0 air, 1 ground)', 'Speed (m/s)', 'Throttle (%, -1 = no change)', null],
      help: 'Change the target speed for the rest of the mission.' },
    183: { name: 'DO_SET_SERVO', label: 'Set servo', loc: false, alt: false,
      params: ['Servo number', 'PWM (µs)', null, null],
      help: 'Set a servo output to a PWM value (e.g. payload release).' },
    206: { name: 'DO_SET_CAM_TRIGG_DIST', label: 'Camera trigger distance', loc: false, alt: false,
      params: ['Distance (m, 0 = stop)', 'Shutter (ms)', 'Trigger once now (0/1)', null],
      help: 'Trigger the camera every N metres.' },
    201: { name: 'DO_SET_ROI', label: 'Region of interest', loc: true, alt: true,
      params: ['ROI mode', null, null, null],
      help: 'Point the vehicle / gimbal at this location.' },
    189: { name: 'DO_LAND_START', label: 'Land start marker', loc: 'opt', alt: false,
      params: [null, null, null, null],
      help: 'Marks the start of a landing sequence (used by plane RTL / auto-landing).' },
  };
  const CMD_ORDER = [16, 82, 22, 19, 18, 17, 31, 21, 20, 93, 178, 112, 114, 115, 177, 183, 206, 201, 189];

  const FENCE_CMD = {
    RETURN: 5000, POLY_INCL: 5001, POLY_EXCL: 5002, CIRCLE_INCL: 5003, CIRCLE_EXCL: 5004,
  };
  const RALLY_CMD = 5100;

  function cmdInfo(n) {
    return CMD[n] || {
      name: 'CMD_' + n, label: 'Command ' + n, loc: 'opt', alt: true,
      params: ['Param 1', 'Param 2', 'Param 3', 'Param 4'],
      help: 'Command not known to this planner. It is kept unchanged on export.',
    };
  }

  /** Does this mission item have a position that should be shown on the map? */
  function itemHasPosition(item) {
    const info = cmdInfo(item.cmd);
    if (info.loc === true) return true;
    if (info.loc === 'opt') return !(Number(item.lat) === 0 && Number(item.lon) === 0);
    return false;
  }

  // ------------------------------------------------------------ formatting
  function num(n, decimals) {
    const v = Number(n);
    if (!isFinite(v)) return (0).toFixed(decimals);
    return v.toFixed(decimals);
  }

  function qgcLine(index, current, frame, cmd, p, lat, lon, alt) {
    return [
      index, current, frame, cmd,
      num(p[0], 6), num(p[1], 6), num(p[2], 6), num(p[3], 6),
      num(lat, 8), num(lon, 8), num(alt, 6), 1,
    ].join('\t');
  }

  const EOL = '\r\n';

  /**
   * Mission -> QGC WPL 110.
   * @param {{home: {lat,lon,alt}|null, items: Array}} plan
   */
  function missionToQGC(plan) {
    const items = plan.items || [];
    let home = plan.home;
    if (!home) {
      const first = items.find(itemHasPosition);
      home = first ? { lat: first.lat, lon: first.lon, alt: 0 } : { lat: 0, lon: 0, alt: 0 };
    }
    const out = ['QGC WPL 110'];
    out.push(qgcLine(0, 1, FRAME.ABSOLUTE, 16, [0, 0, 0, 0], home.lat, home.lon, home.alt || 0));
    items.forEach((it, i) => {
      const info = cmdInfo(it.cmd);
      const hasPos = info.loc === true || (info.loc === 'opt' && itemHasPosition(it));
      const lat = hasPos ? it.lat : 0;
      const lon = hasPos ? it.lon : 0;
      const alt = info.alt || hasPos ? it.alt : 0;
      const p = (it.p || [0, 0, 0, 0]).map((v) => Number(v) || 0);
      const frame = Number.isFinite(Number(it.frame)) ? Number(it.frame) : FRAME.RELATIVE;
      out.push(qgcLine(i + 1, 0, frame, it.cmd, p, lat, lon, alt));
    });
    return out.join(EOL) + EOL;
  }

  /**
   * Geofence -> QGC WPL 110 (ArduPilot 4.0+ polygon / circle fences).
   * @param {{returnPoint, polygons:[{type,points}], circles:[{type,lat,lon,radius}]}} fence
   */
  function fenceToQGC(fence) {
    const out = ['QGC WPL 110'];
    let idx = 0;
    if (fence.returnPoint) {
      out.push(qgcLine(idx++, 0, FRAME.ABSOLUTE, FENCE_CMD.RETURN, [0, 0, 0, 0],
        fence.returnPoint.lat, fence.returnPoint.lon, 0));
    }
    (fence.polygons || []).forEach((poly) => {
      const cmd = poly.type === 'exclusion' ? FENCE_CMD.POLY_EXCL : FENCE_CMD.POLY_INCL;
      const n = poly.points.length;
      poly.points.forEach((pt) => {
        out.push(qgcLine(idx++, 0, FRAME.ABSOLUTE, cmd, [n, 0, 0, 0], pt.lat, pt.lon, 0));
      });
    });
    (fence.circles || []).forEach((c) => {
      const cmd = c.type === 'exclusion' ? FENCE_CMD.CIRCLE_EXCL : FENCE_CMD.CIRCLE_INCL;
      out.push(qgcLine(idx++, 0, FRAME.ABSOLUTE, cmd, [c.radius, 0, 0, 0], c.lat, c.lon, 0));
    });
    return out.join(EOL) + EOL;
  }

  /** Rally points -> QGC WPL 110 (MAV_CMD_NAV_RALLY_POINT). */
  function rallyToQGC(points) {
    const out = ['QGC WPL 110'];
    points.forEach((r, i) => {
      out.push(qgcLine(i, 0, FRAME.RELATIVE, RALLY_CMD, [0, 0, 0, 0], r.lat, r.lon, r.alt));
    });
    return out.join(EOL) + EOL;
  }

  // --------------------------------------------------------------- parsing
  function parseRows(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !/^QGC WPL 110/.test(lines[0])) {
      throw new Error('Not a "QGC WPL 110" waypoint file.');
    }
    return lines.slice(1).map((l, i) => {
      const f = l.split(/\s+/).map(Number);
      if (f.length < 12 || f.slice(0, 12).some((v) => !isFinite(v))) {
        throw new Error('Line ' + (i + 2) + ' is not a valid waypoint line.');
      }
      return {
        index: f[0], current: f[1], frame: f[2], cmd: f[3],
        p: [f[4], f[5], f[6], f[7]], lat: f[8], lon: f[9], alt: f[10],
      };
    });
  }

  /**
   * Parse a QGC WPL 110 file and decide whether it is a mission, fence or rally file.
   * Returns { kind: 'mission', home, items } | { kind: 'fence', fence } | { kind: 'rally', points }
   */
  function parseQGC(text) {
    const rows = parseRows(text);
    const isFence = rows.length && rows.every((r) => r.cmd >= 5000 && r.cmd <= 5004);
    const isRally = rows.length && rows.every((r) => r.cmd === RALLY_CMD);

    if (isFence) {
      const fence = { returnPoint: null, polygons: [], circles: [] };
      let cur = null;
      rows.forEach((r) => {
        if (r.cmd === FENCE_CMD.RETURN) {
          fence.returnPoint = { lat: r.lat, lon: r.lon };
          cur = null;
        } else if (r.cmd === FENCE_CMD.POLY_INCL || r.cmd === FENCE_CMD.POLY_EXCL) {
          const type = r.cmd === FENCE_CMD.POLY_EXCL ? 'exclusion' : 'inclusion';
          if (!cur || cur.type !== type || cur.points.length >= cur.expected) {
            cur = { type, expected: Math.max(1, Math.round(r.p[0])), points: [] };
            fence.polygons.push(cur);
          }
          cur.points.push({ lat: r.lat, lon: r.lon });
        } else {
          cur = null;
          fence.circles.push({
            type: r.cmd === FENCE_CMD.CIRCLE_EXCL ? 'exclusion' : 'inclusion',
            lat: r.lat, lon: r.lon, radius: r.p[0],
          });
        }
      });
      fence.polygons.forEach((p) => delete p.expected);
      return { kind: 'fence', fence };
    }

    if (isRally) {
      return { kind: 'rally', points: rows.map((r) => ({ lat: r.lat, lon: r.lon, alt: r.alt })) };
    }

    if (rows.some((r) => r.cmd >= 5000 && r.cmd <= 5100)) {
      throw new Error('File mixes mission, fence and/or rally items.');
    }

    let home = null;
    let items = rows;
    if (rows.length && rows[0].index === 0 && rows[0].cmd === 16) {
      home = { lat: rows[0].lat, lon: rows[0].lon, alt: rows[0].alt };
      if (home.lat === 0 && home.lon === 0) home = null;
      items = rows.slice(1);
    }
    return {
      kind: 'mission', home,
      items: items.map((r) => ({ cmd: r.cmd, frame: r.frame, p: r.p, lat: r.lat, lon: r.lon, alt: r.alt })),
    };
  }

  /**
   * Parse a QGroundControl .plan (JSON) file into the same three parts.
   * Complex items (surveys etc.) are skipped and reported.
   */
  function parseQGCPlan(obj) {
    const result = { mission: null, fence: null, rally: null, skipped: 0 };
    if (obj.mission) {
      const items = [];
      (obj.mission.items || []).forEach((it) => {
        if (it.type !== 'SimpleItem') { result.skipped++; return; }
        const p = it.params || [];
        items.push({
          cmd: it.command, frame: it.frame,
          p: [p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0],
          lat: p[4] || 0, lon: p[5] || 0, alt: p[6] || 0,
        });
      });
      const hp = obj.mission.plannedHomePosition;
      result.mission = { home: hp ? { lat: hp[0], lon: hp[1], alt: hp[2] || 0 } : null, items };
    }
    if (obj.geoFence) {
      result.fence = {
        returnPoint: null,
        polygons: (obj.geoFence.polygons || []).map((pg) => ({
          type: pg.inclusion === false ? 'exclusion' : 'inclusion',
          points: (pg.polygon || []).map((c) => ({ lat: c[0], lon: c[1] })),
        })),
        circles: (obj.geoFence.circles || []).map((c) => ({
          type: c.inclusion === false ? 'exclusion' : 'inclusion',
          lat: c.circle.center[0], lon: c.circle.center[1], radius: c.circle.radius,
        })),
      };
      const br = obj.geoFence.breachReturn;
      if (br && (br[0] || br[1])) result.fence.returnPoint = { lat: br[0], lon: br[1] };
    }
    if (obj.rallyPoints) {
      result.rally = (obj.rallyPoints.points || []).map((p) => ({ lat: p[0], lon: p[1], alt: p[2] || 0 }));
    }
    return result;
  }

  // -------------------------------------------------------------- geometry
  const R_EARTH = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distance(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  // local equirectangular projection (metres) — fine at fence scales
  function project(p, ref) {
    return { x: rad(p.lon - ref.lon) * R_EARTH * Math.cos(rad(ref.lat)), y: rad(p.lat - ref.lat) * R_EARTH };
  }

  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (((a.lat > pt.lat) !== (b.lat > pt.lat)) &&
          pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon) {
        inside = !inside;
      }
    }
    return inside;
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    const o = (a, b, c) => (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function polygonSelfIntersects(poly) {
    const n = poly.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
        if (segmentsIntersect(a1, a2, poly[j], poly[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  function segmentCrossesPolygon(a, b, poly) {
    for (let i = 0; i < poly.length; i++) {
      if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
    }
    return false;
  }

  /** Shortest distance (m) from point p to segment a-b. */
  function distanceToSegment(p, a, b) {
    const P = project(p, a), B = project(b, a);
    const len2 = B.x * B.x + B.y * B.y;
    let t = len2 ? (P.x * B.x + P.y * B.y) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P.x - t * B.x, P.y - t * B.y);
  }

  function polygonArea(poly) {
    if (poly.length < 3) return 0;
    const ref = poly[0];
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = project(poly[i], ref), b = project(poly[(i + 1) % poly.length], ref);
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  const api = {
    FRAME, FRAME_LABELS, CMD, CMD_ORDER, FENCE_CMD, RALLY_CMD,
    cmdInfo, itemHasPosition,
    missionToQGC, fenceToQGC, rallyToQGC, parseQGC, parseQGCPlan,
    geo: { distance, bearing, pointInPolygon, polygonSelfIntersects, segmentCrossesPolygon, distanceToSegment, polygonArea },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPFormats = api;
})(typeof window !== 'undefined' ? window : this);
