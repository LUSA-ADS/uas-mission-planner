/*
 * tutorial.js — guided walkthrough for UAS Flight Planning.
 * Highlights a control, explains it, and lets students try it on the real map.
 * Highlights never block clicks. The tutorial can be exited at any time with the
 * Exit button, the ✕ in the card, or Esc (when nothing else is being cancelled).
 * Depends on window.__planner (exposed by app.js).
 */
(function () {
  'use strict';

  const P = window.__planner;
  if (!P) return;
  const SEEN_KEY = 'uas-flight-planning/tutorial-seen';

  const $ = (s) => document.querySelector(s);
  const card = (n) => () => document.querySelectorAll('#sidebar > .card')[n];
  const hasCmd = (...c) => P.state.mission.some((i) => c.includes(i.cmd));

  // target: CSS selector or function returning an element (null = centred card, no highlight)
  // mode:   plan type to show for this step
  // check:  returns true once the student has done what the step asks (shows a tick, never blocks Next)
  const STEPS = [
    {
      title: 'Welcome',
      text: 'This short tour shows how to plan a mission, a geofence and rally points, then export them for Mission Planner. You can try each step on the map as you go. Use <b>Exit tutorial</b> at any time to stop.',
    },
    {
      title: 'Three plan types',
      target: '.modes',
      mode: 'mission',
      text: 'Use these tabs to switch between the <b>Mission</b> (the route), the <b>Geofence</b> (where the vehicle may fly) and <b>Rally points</b> (safe places to return to). Each one is exported as its own file.',
    },
    {
      title: 'Set the home point',
      target: '[data-tool="home"]',
      mode: 'mission',
      text: 'Click <b>Set home</b>, then click the map where the vehicle will take off. Pan and zoom the map first to find your launch site.',
      check: () => !!P.state.home,
    },
    {
      title: 'Defaults for new waypoints',
      target: card(2),
      mode: 'mission',
      text: 'New waypoints use this altitude, altitude frame and cruise speed. The frame is <i>relative to home</i> by default. The max altitude value is only used by the checks at the bottom of the panel.',
    },
    {
      title: 'Add a takeoff',
      target: '[data-act="add-takeoff"]',
      mode: 'mission',
      text: 'Most missions start with a <b>Takeoff</b> command. Click <b>+ Takeoff</b> to put one at the start of the list.',
      check: () => hasCmd(22),
    },
    {
      title: 'Add waypoints',
      target: '[data-tool="wp"]',
      mode: 'mission',
      text: 'Click <b>Add waypoints</b>, then click the map to place at least two waypoints. Each new waypoint is inserted after the selected item. Drag a marker to move it.',
      check: () => P.state.mission.filter((i) => i.cmd === 16).length >= 2,
    },
    {
      title: 'Edit a mission item',
      target: '#mission-list',
      mode: 'mission',
      text: 'Click a row to select it and edit its command, altitude and parameters in the panel below. Use the arrows to reorder items and ✕ to delete one. The <b>Leg</b> column shows the distance from the previous item.',
    },
    {
      title: 'Finish with RTL or Land',
      target: '[data-act="append-cmd:20"]',
      mode: 'mission',
      text: 'End the mission with <b>+ RTL</b> (return to launch) or <b>+ Land</b>. They are added at the end of the list.',
      check: () => hasCmd(20, 21),
    },
    {
      title: 'Read the checks',
      target: () => { const c = $('#sidebar .checks'); return c && c.closest('.card'); },
      mode: 'mission',
      text: 'The <b>Checks</b> card warns about problems such as an altitude above the limit, a missing takeoff or RTL, or waypoints outside the fence. Fix any red items before you export.',
    },
    {
      title: 'Draw a geofence',
      target: '[data-tool="poly-inclusion"]',
      mode: 'fence',
      text: 'Choose <b>Inclusion polygon</b> and click at least three points around your route. Press <b>Enter</b>, click <b>Finish</b> or click the yellow first vertex to close it. The vehicle must stay inside an inclusion zone.',
      check: () => P.state.fence.polygons.some((p) => p.type === 'inclusion' && p.points.length >= 3),
    },
    {
      title: 'No-fly zones',
      target: '[data-tool="poly-exclusion"]',
      mode: 'fence',
      text: '<b>Exclusion</b> polygons and circles mark areas the vehicle must stay out of. Try one if you like. Drag vertices to reshape a polygon, and right-click a vertex to remove it.',
      check: () => P.state.fence.polygons.some((p) => p.type === 'exclusion') || P.state.fence.circles.some((c) => c.type === 'exclusion'),
    },
    {
      title: 'Rally points',
      target: '[data-tool="rally"]',
      mode: 'rally',
      text: 'Rally points are alternative return locations. Click <b>Add rally points</b>, then click the map to place one or more.',
      check: () => P.state.rally.length >= 1,
    },
    {
      title: 'Undo and save',
      target: '#btn-undo',
      mode: 'mission',
      text: '<b>Undo</b> (Ctrl+Z) reverts your last change. <b>Save project</b> downloads a file you can re-open later with <b>Import</b>. Your plan is also kept in this browser automatically.',
    },
    {
      title: 'Export for Mission Planner',
      target: '#btn-export',
      mode: 'mission',
      text: 'When the checks look good, click <b>Export for Mission Planner</b>. You get a mission, fence and rally file, and the dialog explains how to load each one on the Plan screen in Mission Planner. That completes the tour.',
    },
  ];

  // ------------------------------------------------------------ DOM
  const ring = document.createElement('div');
  ring.className = 'tour-ring';
  ring.hidden = true;
  const dim = document.createElement('div');
  dim.className = 'tour-dim';
  dim.hidden = true;
  const box = document.createElement('div');
  box.className = 'tour-card';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Tutorial');
  box.hidden = true;
  document.body.append(dim, ring, box);

  const welcome = document.createElement('div');
  welcome.className = 'tour-welcome';
  welcome.hidden = true;
  welcome.innerHTML = `<b>New here?</b> Take a short guided tour of the planner.
    <button class="b primary" data-w="start">Start tutorial</button>
    <button class="b" data-w="no">No thanks</button>`;
  document.body.append(welcome);

  // ------------------------------------------------------------ state
  let active = false;
  let idx = 0;
  let raf = 0;
  let scrolled = false;
  let lastDone = null;

  function remember() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* storage blocked */ } }
  function seen() { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return true; } }

  function planIsEmpty() {
    const s = P.state;
    return !s.home && !s.mission.length && !s.rally.length && !s.fence.polygons.length && !s.fence.circles.length;
  }

  function start() {
    welcome.hidden = true;
    remember();
    if (active) return;
    if (!planIsEmpty() && !confirm('The tutorial asks you to add items to your plan. Your current plan will be kept, and you can use Undo or Save project first if you want a backup.\n\nStart the tutorial?')) return;
    active = true;
    document.body.classList.add('touring');
    go(0);
    loop();
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    document.body.classList.remove('touring');
    ring.hidden = dim.hidden = box.hidden = true;
  }

  function go(i) {
    idx = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[idx];
    scrolled = false;
    lastDone = null;
    P.setTool(null);
    if (s.mode && P.ui.mode !== s.mode) P.setMode(s.mode);
    renderCard();
  }

  function renderCard() {
    const s = STEPS[idx];
    const last = idx === STEPS.length - 1;
    box.innerHTML = `
      <div class="tour-head"><span class="tour-step">Step ${idx + 1} of ${STEPS.length}</span>
        <button class="tour-x" data-t="exit" aria-label="Exit tutorial" title="Exit tutorial">✕</button></div>
      <h3>${s.title}</h3>
      <p>${s.text}</p>
      <p class="tour-done" hidden>✓ Done. Continue when you are ready.</p>
      <div class="tour-btns">
        <button class="b ghost" data-t="exit">Exit tutorial</button>
        <span class="grow"></span>
        <button class="b" data-t="back"${idx === 0 ? ' disabled' : ''}>Back</button>
        <button class="b primary" data-t="${last ? 'exit' : 'next'}">${last ? 'Finish' : idx === 0 ? 'Start' : 'Next'}</button>
      </div>`;
    box.hidden = false;
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'exit') stop();
    else if (b.dataset.t === 'next') go(idx + 1);
    else if (b.dataset.t === 'back') go(idx - 1);
  });

  welcome.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    if (b.dataset.w === 'start') start();
    else { welcome.hidden = true; remember(); }
  });

  // Esc exits only when the app has nothing of its own to cancel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active && !P.ui.tool && !P.ui.drawing && !P.ui.sel) stop();
  });

  $('#btn-tutorial').addEventListener('click', () => { if (active) stop(); else start(); });

  // ------------------------------------------------------------ layout
  function resolveTarget(s) {
    if (!s.target) return null;
    const el = typeof s.target === 'function' ? s.target() : $(s.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? el : null;
  }

  function place(r) {
    const m = 12;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (!r) { box.style.left = Math.max(m, (vw - w) / 2) + 'px'; box.style.top = Math.max(m, (vh - h) / 3) + 'px'; return; }
    const fits = (x, y) => x >= m && y >= m && x + w <= vw - m && y + h <= vh - m;
    const cx = r.left + r.width / 2 - w / 2;
    const cy = r.top + r.height / 2 - h / 2;
    const options = [
      [cx, r.bottom + m], [cx, r.top - h - m], [r.left - w - m, cy], [r.right + m, cy],
    ];
    let pos = options.find(([x, y]) => fits(x, y));
    if (!pos) pos = [vw - w - m, vh - h - m]; // fallback: bottom-right corner
    box.style.left = Math.min(Math.max(m, pos[0]), Math.max(m, vw - w - m)) + 'px';
    box.style.top = Math.min(Math.max(m, pos[1]), Math.max(m, vh - h - m)) + 'px';
  }

  function loop() {
    if (!active) return;
    const s = STEPS[idx];
    const el = resolveTarget(s);
    if (el && !scrolled) { el.scrollIntoView({ block: 'nearest' }); scrolled = true; }
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 5;
      Object.assign(ring.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
      ring.hidden = false;
      dim.hidden = true;
      place(r);
    } else {
      ring.hidden = true;
      dim.hidden = !!s.target; // welcome step dims the page; a missing target just shows the card
      place(null);
    }
    if (s.check) {
      const done = !!s.check();
      if (done !== lastDone) {
        lastDone = done;
        const d = box.querySelector('.tour-done');
        if (d) d.hidden = !done;
      }
    }
    raf = requestAnimationFrame(loop);
  }

  // First visit with an empty plan: offer the tour once.
  if (!seen() && planIsEmpty()) setTimeout(() => { if (!active) welcome.hidden = false; }, 800);

  window.__tutorial = { start, stop };
})();
