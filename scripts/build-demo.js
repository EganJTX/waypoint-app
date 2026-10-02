// Builds demo.html: a single, fully self-contained copy of the Waypoint UI
// running on fictional "John Doe" fixtures from demo-src/.
//
// Safety: the demo never talks to server.js and never reads or writes the
// real config.json / data.json / coachAnalyses.json. The real app's own
// index.html, css/styles.css, js/app.js and js/calculator.js are inlined
// verbatim, and a small in-page fetch shim stands in for the server's API
// (state kept in this browser's localStorage under a demo-only key).
//
// The projection code is lifted from server.js at build time rather than
// re-typed, so the demo's numbers come from the same logic as the real app.
//
// Usage: node scripts/build-demo.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const dataUri = (p, mime) => `data:${mime};base64,${fs.readFileSync(path.join(ROOT, p)).toString('base64')}`;
// Keeps inlined JSON/JS from closing its own <script> tag early.
const safeScript = s => s.replace(/<\/script/gi, '<\\/script');

// ── Pull the projection functions out of server.js verbatim ────────────────
const serverSrc = read('server.js');
const start = serverSrc.indexOf('function ageFromDob');
const end = serverSrc.indexOf('function recomputeAndPersistProjection');
if (start < 0 || end < 0) throw new Error('Could not locate projection code in server.js');
const projectionCode = serverSrc.slice(start, end);

const calculatorSrc = read('js/calculator.js');

const fixtures = {
  config: JSON.parse(read('demo-src/config.json')),
  data: JSON.parse(read('demo-src/data.json')),
  analyses: JSON.parse(read('demo-src/coachAnalyses.json')),
};

const DEMO_COACH_MESSAGE =
  'This is a demo. The coach runs a real, local Claude Code analysis in the full app, ' +
  'which needs the Waypoint app (index.html + server) running on your own machine. ' +
  'It does not run here. Grab the code from the repo to see this part work end to end.';

const shim = `
(function () {
  'use strict';
  // Fictional demo only. No requests leave this page: window.fetch is replaced
  // so every call the app makes to its own API is answered from the fixtures
  // below, with edits kept in this browser's localStorage.
  const STORE_KEY = 'waypoint_demo_v1';
  const SEED = ${safeScript(JSON.stringify(fixtures))};
  const DEMO_COACH_MESSAGE = ${JSON.stringify(DEMO_COACH_MESSAGE)};

  const calculator = (function () {
    const module = { exports: {} };
    ${safeScript(calculatorSrc)}
    return module.exports;
  })();

  ${safeScript(projectionCode)}

  const clone = o => JSON.parse(JSON.stringify(o));
  let mem = null;
  function load() {
    if (mem) return mem;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.config && s.data) { mem = s; return mem; }
      }
    } catch (e) { /* storage blocked or corrupt: fall back to the seed */ }
    mem = { config: clone(SEED.config), data: clone(SEED.data) };
    return mem;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch (e) { /* in-memory only */ }
  }
  function readData() {
    const d = load().data;
    if (!Array.isArray(d.vehicles)) d.vehicles = [];
    if (!Array.isArray(d.snapshots)) d.snapshots = [];
    if (!Array.isArray(d.assessments)) d.assessments = [];
    return d;
  }
  function recompute() {
    const s = load();
    s.data.currentProjection = computeProjection(s.config, readData());
    save();
    return s.data.currentProjection;
  }

  const routes = {
    'GET config': () => [200, load().config],
    'POST config': body => {
      const ok = body && typeof body === 'object' &&
        'household' in body && 'destinationNumber' in body && 'targetRetirementAge' in body;
      if (!ok) return [400, { error: 'Refusing to write an incomplete config body' }];
      load().config = body; save();
      return [200, { ok: true }];
    },
    'GET data': () => [200, readData()],
    'POST data': body => {
      const incoming = body || {};
      const existing = readData();
      load().data = {
        vehicles: Array.isArray(incoming.vehicles) ? incoming.vehicles : [],
        snapshots: Array.isArray(incoming.snapshots) ? incoming.snapshots : [],
        assessments: Array.isArray(incoming.assessments) ? incoming.assessments : [],
        currentProjection: existing.currentProjection || null,
      };
      save();
      return [200, { ok: true }];
    },
    'GET projection': () => [200, readData().currentProjection || recompute()],
    'POST projection/recompute': () => [200, recompute()],
    'GET coach-analyses': () => [200, SEED.analyses],
    'POST projection/coach-analyze': () => [200, { ok: false, error: DEMO_COACH_MESSAGE }],
  };

  window.fetch = async function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const m = String(url).match(/\\/waypoint-app\\/api\\/([^?]+)/);
    let status = 404, payload = { error: 'Not available in the demo' };
    const handler = m && routes[method + ' ' + m[1]];
    if (handler) {
      let body = null;
      try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { /* ignore */ }
      [status, payload] = handler(body);
    }
    return new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  };

  window.__resetWaypointDemo = function () {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    mem = null;
    location.reload();
  };
})();
`;

// ── Assemble ───────────────────────────────────────────────────────────────
let html = read('index.html');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error('index.html no longer contains: ' + from);
  html = html.replace(from, () => to);
};

swap('<title>Waypoint</title>', '<title>Waypoint (Demo)</title>');
swap('<link rel="icon" href="assets/logo.png" />', `<link rel="icon" href="${dataUri('assets/logo.png', 'image/png')}" />`);
swap('src="assets/hero.png"', `src="${dataUri('assets/hero.png', 'image/png')}"`);
swap('<link rel="stylesheet" href="css/styles.css" />', `<style>\n${read('css/styles.css')}\n.demo-hero-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}\n.demo-badge{display:inline-block;padding:3px 10px;border-radius:999px;background:#B8783D;color:#fff;font:600 10.5px/1.4 Inter,sans-serif;letter-spacing:.08em;vertical-align:middle}\n.demo-reset{padding:0;background:none;border:0;color:var(--coach-amber);opacity:.85;font:500 11px Inter,sans-serif;letter-spacing:.02em;text-decoration:underline;cursor:pointer}\n.demo-reset:hover{opacity:1}\n</style>`);
// The demo badge and reset link ride in the hero, next to the amber greeting
// (app.js rewrites #hero-eyebrow's text, so they live beside it, not inside it).
swap('<div class="hero-eyebrow" id="hero-eyebrow">GOOD MORNING</div>',
  '<div class="demo-hero-row">\n        <div class="hero-eyebrow" id="hero-eyebrow">GOOD MORNING</div>\n        <span class="demo-badge">DEMO · FICTIONAL DATA</span>\n        <button class="demo-reset" onclick="__resetWaypointDemo()" title="Discard any edits you made and reload the original John Doe data">Reset Demo Data to Original State</button>\n      </div>');

// In the demo the coach's "can't run here" message is the point, not a failure.
let appJs = read('js/app.js')
  .replace(
    "status.style.color = '#d32f2f';\n        status.textContent = `Failed: ${result.error || 'Unknown error'}`;",
    "status.style.color = '#B8783D';\n        status.textContent = result.error || 'Unknown error';"
  );
if (!appJs.includes("status.style.color = '#B8783D'")) throw new Error("app.js coach-error block changed; update build-demo.js");

// The projection-chart fixes (axis trim, callout placement/yield, hover dots,
// hover guide, tooltip layering) now live in js/app.js itself, so the demo
// inherits them. Fail loudly if they ever get lost.
for (const marker of ['horizonLen', "id: 'calloutYield'", "id: 'hoverGuide'", 'pointHoverRadius: 0', 'beforeDatasetsDraw(chart)']) {
  if (!appJs.includes(marker)) throw new Error('js/app.js is missing chart fix marker: ' + marker);
}

swap('<script src="js/app.js"></script>', `<script>${shim}</script>\n<script>\n${safeScript(appJs)}\n</script>`);

const out = path.join(ROOT, 'demo.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`Wrote ${out} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
