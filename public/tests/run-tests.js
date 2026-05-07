#!/usr/bin/env node
/* Coach Adaptatif — pure-function unit tests.
 *
 * Why a bespoke harness?
 *   The frontend is plain browser JS with top-level function declarations and
 *   globals (S, EX_BY_ID, document). We don't want to introduce Jest/Vitest
 *   and a bundler for a single-file SPA. Instead we load app.js inside a
 *   vm.Context with minimal browser shims and then reach into it for the
 *   pure functions we want to test.
 *
 * What we cover:
 *   - computeWeeklyVolume   (the new weekly-sets-per-zone feature)
 *   - computeStreak         (streak reset rules)
 *   - countPRs              (PR detection)
 *   - computeXP             (level curve sanity)
 *   - supportsWeight        (which gear accepts added load)
 *   - capWeight             (barre/halteres max enforcement)
 *   - ytEmbedUrl            (YouTube ID regex guard)
 *
 * Run with:  node public/tests/run-tests.js
 * Exit 0 on all-pass, 1 on first failure batch.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Load app.js into a sandboxed context with browser shims ----
const appPath = path.join(__dirname, '..', 'app.js');
let source = fs.readFileSync(appPath, 'utf8');

// `let`/`const` in a strict script do NOT become globalThis properties; they
// live in the script's top-level lexical environment, invisible from outside.
// We append an epilogue that re-exposes the symbols we want to test and a
// __setState helper so we can mutate the inner `S` binding.
source += `
;Object.assign(globalThis, {
  EX_BY_ID,
  supportsWeight, capWeight,
  computeXP, levelInfo, computeStreak, countPRs,
  computeWeeklyVolume,
  warmupSets,
  swapRationale,
  estimate1RM, best1RMFor,
  shouldDeload, computeHeatmap,
  ytEmbedUrl: typeof ytEmbedUrl === 'function' ? ytEmbedUrl : undefined,
});
globalThis.__setState = (s) => { S = Object.assign({ profile: null, history: [], adjustments: [], formScore: 70 }, s); };
globalThis.__getState = () => S;
`;

// app.js declares 'use strict' at the top. Under strict-script semantics the
// top-level `function foo(){}` declarations still become properties of the
// script's global object in a vm.Context, so we can leave the directive in.
// We DO need to strip module-side-effect registrations (window.addEventListener
// for online/offline) — they won't hurt because our window shim no-ops.

// Minimal DOM/Window shim. Tests don't render; we just need the APIs app.js
// touches at module-top-level not to throw.
const fakeEl = () => {
  const el = { classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
               style: {}, innerHTML: '', textContent: '',
               dataset: {}, // wireChips reads/writes .dataset.wired
               addEventListener(){}, appendChild(){},
               querySelectorAll(){ return []; },
               setAttribute(){}, getAttribute(){ return null; } };
  el.children = [];
  return el;
};

const sandbox = {
  console,
  window: undefined,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  document: {
    getElementById() { return fakeEl(); },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    cookie: '',
    body: fakeEl(),
  },
  navigator: { serviceWorker: { register() { return Promise.resolve(); } } },
  location: { pathname: '/', search: '', hash: '', href: 'http://localhost/' },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  fetch: () => Promise.reject(new Error('fetch stub: not used in unit tests')),
  AudioContext: function () { return { createOscillator() { return { connect(){}, start(){}, stop(){}, frequency: {} }; }, createGain(){ return { connect(){}, gain:{setValueAtTime(){},linearRampToValueAtTime(){}} }; }, destination: {}, currentTime: 0 }; },
  URL: URL,
  URLSearchParams: URLSearchParams,
  Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(source, sandbox, { filename: 'app.js' });
} catch (e) {
  // Some side-effect code paths (addEventListener on a real window) may throw;
  // stub enough that everything initialises.
  console.error('app.js load failed:', e.stack);
  process.exit(1);
}

// ---- Tiny assertion DSL ----
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('\x1b[32m✓\x1b[0m ' + name + '\n');
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    process.stdout.write('\x1b[31m✗\x1b[0m ' + name + '  — ' + e.message + '\n');
  }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'expected equal') + ': ' + sa + ' !== ' + sb);
}
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function falsy(v, msg) { if (v) throw new Error(msg || 'expected falsy'); }

// ---- Helpers to seed state inside the VM ----
const ctx = sandbox;
function setState(s) { ctx.__setState(s); }
function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString();
}

// ============================= TESTS =============================

// --- supportsWeight: machines should now count (regression guard) ---
test('supportsWeight: barre exercise returns true', () => {
  truthy(ctx.supportsWeight('squat'));
});
test('supportsWeight: bodyweight exo returns false', () => {
  // 'pompes' is pdc-only — no added load.
  const lib = ctx.EX_BY_ID['pompes'];
  truthy(lib, 'pompes must exist in library');
  falsy(ctx.supportsWeight('pompes'));
});
test('supportsWeight: machine exercise returns true', () => {
  // 'legpress' is machine-gear. Without the machine branch this returned false.
  if (ctx.EX_BY_ID['legpress']) {
    truthy(ctx.supportsWeight('legpress'));
  }
});
test('supportsWeight: timed exercise always returns false', () => {
  // 'gainage' / 'planche' is timed.
  const timedId = Object.keys(ctx.EX_BY_ID).find(k => ctx.EX_BY_ID[k].timed);
  truthy(timedId, 'at least one timed exo');
  falsy(ctx.supportsWeight(timedId));
});

// --- capWeight: respects user-declared max per gear ---
test('capWeight: caps barre exercise at user maxBarre', () => {
  setState({ profile: { maxBarre: 60 } });
  eq(ctx.capWeight('squat', 80), 60);
});
test('capWeight: no cap declared → passes through', () => {
  setState({ profile: {} });
  eq(ctx.capWeight('squat', 80), 80);
});

// --- computeStreak: consecutive-days logic ---
test('computeStreak: empty history → 0', () => {
  eq(ctx.computeStreak([]), 0);
});
test('computeStreak: single session today → 1', () => {
  eq(ctx.computeStreak([{ date: daysAgoISO(0) }]), 1);
});
test('computeStreak: 3-day gap still counts', () => {
  // Last session 3 days ago should still produce streak ≥ 1.
  const hist = [{ date: daysAgoISO(3) }];
  truthy(ctx.computeStreak(hist) >= 1);
});
test('computeStreak: >3 day gap → 0', () => {
  eq(ctx.computeStreak([{ date: daysAgoISO(10) }]), 0);
});

// --- countPRs: new top score per exo = 1 PR ---
test('countPRs: first entry is baseline (no PR yet)', () => {
  const hist = [{ sets: [{ exoId: 'squat', weight: 60, reps: 5 }] }];
  eq(ctx.countPRs(hist), 0);
});
test('countPRs: beat baseline → 1 PR', () => {
  const hist = [
    { sets: [{ exoId: 'squat', weight: 60, reps: 5 }] },
    { sets: [{ exoId: 'squat', weight: 70, reps: 5 }] },
  ];
  eq(ctx.countPRs(hist), 1);
});
test('countPRs: lower score after PR does not decrement', () => {
  const hist = [
    { sets: [{ exoId: 'squat', weight: 60, reps: 5 }] },
    { sets: [{ exoId: 'squat', weight: 70, reps: 5 }] },
    { sets: [{ exoId: 'squat', weight: 50, reps: 5 }] },
  ];
  eq(ctx.countPRs(hist), 1);
});

// --- computeXP / levelInfo sanity ---
test('computeXP: empty history → 0', () => {
  eq(ctx.computeXP([]), 0);
});
test('computeXP: one session → positive', () => {
  const hist = [{ date: daysAgoISO(0), sets: [{ weight: 60, reps: 5 }], rpe: 7, pains: [] }];
  truthy(ctx.computeXP(hist) >= 100);
});
test('levelInfo: 0 XP → level 1', () => {
  eq(ctx.levelInfo(0).level, 1);
});
test('levelInfo: level monotonically increases with xp', () => {
  const l1 = ctx.levelInfo(100).level;
  const l2 = ctx.levelInfo(100000).level;
  truthy(l2 > l1, 'high xp should give a higher level');
});

// --- computeWeeklyVolume: the new feature ---
test('computeWeeklyVolume: empty → all zeros', () => {
  setState({ history: [] });
  const r = ctx.computeWeeklyVolume();
  eq(r.thisWeek.legs, 0);
  eq(r.thisWeek.chest, 0);
});
test('computeWeeklyVolume: counts sets in last 7 days by zone', () => {
  setState({
    history: [
      { date: daysAgoISO(2), sets: [
        { exoId: 'squat', reps: 5, weight: 60 },
        { exoId: 'squat', reps: 5, weight: 60 },
        { exoId: 'squat', reps: 5, weight: 60 },
      ]},
    ]
  });
  const r = ctx.computeWeeklyVolume();
  eq(r.thisWeek.legs, 3, 'squat × 3 sets → 3 leg sets this week');
});
test('computeWeeklyVolume: sets older than 7 days go to lastWeek', () => {
  setState({
    history: [
      { date: daysAgoISO(10), sets: [{ exoId: 'squat', reps: 5, weight: 60 }] },
    ]
  });
  const r = ctx.computeWeeklyVolume();
  eq(r.thisWeek.legs, 0);
  eq(r.lastWeek.legs, 1);
});
test('computeWeeklyVolume: skipped sets (0 reps, 0 duration) not counted', () => {
  setState({
    history: [
      { date: daysAgoISO(1), sets: [
        { exoId: 'squat', reps: 5, weight: 60 },
        { exoId: 'squat', reps: 0, weight: 0 }, // skipped
      ]}
    ]
  });
  const r = ctx.computeWeeklyVolume();
  eq(r.thisWeek.legs, 1, 'only the one completed set counts');
});
test('computeWeeklyVolume: multi-zone exercises count for each zone', () => {
  // 'sdt' (deadlift) hits legs + back in its z array.
  const sdt = ctx.EX_BY_ID['sdt'];
  if (!sdt) return; // library may rename; skip if not present
  setState({
    history: [
      { date: daysAgoISO(1), sets: [{ exoId: 'sdt', reps: 5, weight: 80 }] },
    ]
  });
  const r = ctx.computeWeeklyVolume();
  const zones = sdt.z || [];
  for (const z of zones) {
    eq(r.thisWeek[z], 1, 'sdt set should count for ' + z);
  }
});

// --- ytEmbedUrl: strict 11-char ID regex ---
test('ytEmbedUrl: valid 11-char ID returns nocookie URL', () => {
  if (typeof ctx.ytEmbedUrl !== 'function') return;
  const url = ctx.ytEmbedUrl('dQw4w9WgXcQ');
  truthy(url && url.includes('youtube-nocookie.com'));
});
test('ytEmbedUrl: invalid input returns null or empty', () => {
  if (typeof ctx.ytEmbedUrl !== 'function') return;
  const bad = ctx.ytEmbedUrl('<script>');
  falsy(bad, 'must not produce URL from untrusted input');
});

// --- warmupSets: ramp-up calculation for compounds ---
test('warmupSets: isolation/non-compound returns empty', () => {
  eq(ctx.warmupSets('curl', 80).length, 0);
});
test('warmupSets: light load (<40kg) returns empty', () => {
  eq(ctx.warmupSets('squat', 30).length, 0);
});
test('warmupSets: 40-59kg returns single 50% set', () => {
  const w = ctx.warmupSets('squat', 50);
  eq(w.length, 1);
  eq(w[0].pct, 50);
  eq(w[0].weight, 25);
});
test('warmupSets: 60+kg returns 50% and 70% sets', () => {
  const w = ctx.warmupSets('dc', 80);
  eq(w.length, 2);
  eq(w[0].weight, 40);
  eq(w[1].weight, 55); // 56 rounded down to nearest 2.5
});
test('warmupSets: rounds to 2.5kg increments', () => {
  const w = ctx.warmupSets('squat', 100);
  eq(w[0].weight % 2.5, 0);
  eq(w[1].weight % 2.5, 0);
});

// --- estimate1RM: Epley formula sanity ---
test('estimate1RM: invalid input returns null', () => {
  eq(ctx.estimate1RM(0, 5).weight, null);
  eq(ctx.estimate1RM(50, 0).weight, null);
});
test('estimate1RM: 1 rep returns slightly above the load', () => {
  // Epley with r=1: 100 * (1 + 1/30) = 103.33. Rounded to nearest 0.5 = 103.5.
  eq(ctx.estimate1RM(100, 1).weight, 103.5);
});
test('estimate1RM: 5 reps at 100kg ≈ 117kg', () => {
  const r = ctx.estimate1RM(100, 5);
  truthy(r.weight >= 116 && r.weight <= 117.5, 'got ' + r.weight);
  eq(r.reliable, true);
});
test('estimate1RM: 15 reps flagged unreliable', () => {
  eq(ctx.estimate1RM(60, 15).reliable, false);
});

test('best1RMFor: empty history returns null', () => {
  eq(ctx.best1RMFor([], 'squat'), null);
});
test('best1RMFor: returns the highest estimated 1RM', () => {
  const hist = [
    { date: '2026-04-01', sets: [{ exoId: 'squat', reps: 5, weight: 100 }] },
    { date: '2026-04-08', sets: [{ exoId: 'squat', reps: 3, weight: 110 }] },
  ];
  const best = ctx.best1RMFor(hist, 'squat');
  // 110*(1+3/30) = 121 vs 100*(1+5/30) = 116.67. Should pick 121.
  truthy(best >= 120 && best <= 122, 'got ' + best);
});
test('best1RMFor: ignores other exercises', () => {
  const hist = [
    { date: '2026-04-01', sets: [{ exoId: 'curl', reps: 10, weight: 50 }] },
  ];
  eq(ctx.best1RMFor(hist, 'squat'), null);
});

// --- swapRationale: explains why a candidate is a reasonable substitute ---
test('swapRationale: pain offload mentions joint', () => {
  const cur = ctx.EX_BY_ID['squat'];
  const cand = ctx.EX_BY_ID['gluteb']; // glute bridge has no genou pain
  if (!cur || !cand) return;
  const r = ctx.swapRationale(cur, cand, { painToday: ['genou'] });
  truthy(r.toLowerCase().includes('genou'), 'pain rationale should name joint, got: ' + r);
});
test('swapRationale: returns a string for any same-zone candidate', () => {
  const cur = ctx.EX_BY_ID['squat'];
  const cand = ctx.EX_BY_ID['jumpsquat'];
  if (!cur || !cand) return;
  const r = ctx.swapRationale(cur, cand, { painToday: [] });
  truthy(typeof r === 'string' && r.length > 0, 'should return non-empty string');
});

// --- shouldDeload: rising-RPE 3-week pattern ---
test('shouldDeload: empty history → no deload', () => {
  eq(ctx.shouldDeload([]).deload, false);
});
test('shouldDeload: rising RPE 6→7→9 → deload', () => {
  const now = Date.now();
  const D = 86400000;
  const hist = [
    // week-3 bucket (centered ~17 days ago)
    { date: new Date(now - 16 * D).toISOString(), rpe: 6, sets: [{exoId:'squat',reps:5,weight:80}] },
    { date: new Date(now - 18 * D).toISOString(), rpe: 6, sets: [{exoId:'squat',reps:5,weight:80}] },
    // week-2 bucket
    { date: new Date(now - 9 * D).toISOString(),  rpe: 7, sets: [{exoId:'squat',reps:5,weight:80}] },
    { date: new Date(now - 11 * D).toISOString(), rpe: 7, sets: [{exoId:'squat',reps:5,weight:80}] },
    // last week
    { date: new Date(now - 2 * D).toISOString(),  rpe: 9, sets: [{exoId:'squat',reps:5,weight:80}] },
    { date: new Date(now - 4 * D).toISOString(),  rpe: 9, sets: [{exoId:'squat',reps:5,weight:80}] },
  ];
  const v = ctx.shouldDeload(hist, now);
  eq(v.deload, true);
});
test('shouldDeload: stable RPE → no deload', () => {
  const now = Date.now();
  const D = 86400000;
  const hist = [
    { date: new Date(now - 16 * D).toISOString(), rpe: 7, sets: [{exoId:'squat',reps:5,weight:80}] },
    { date: new Date(now - 9 * D).toISOString(),  rpe: 7, sets: [{exoId:'squat',reps:5,weight:80}] },
    { date: new Date(now - 2 * D).toISOString(),  rpe: 7, sets: [{exoId:'squat',reps:5,weight:80}] },
  ];
  const v = ctx.shouldDeload(hist, now);
  eq(v.deload, false);
});

// --- computeHeatmap: bucketing by date ---
test('computeHeatmap: empty history returns empty levels', () => {
  const r = ctx.computeHeatmap([], 16);
  eq(Object.keys(r.levels).length, 0);
});
test('computeHeatmap: ignores entries older than weeksBack', () => {
  const now = Date.now();
  const D = 86400000;
  const hist = [
    { date: new Date(now - 200 * D).toISOString(), sets: [{exoId:'squat'}] },
    { date: new Date(now - 1 * D).toISOString(),   sets: [{exoId:'squat'}] },
  ];
  const r = ctx.computeHeatmap(hist, 16);
  // 200 days > 16 weeks (112 days) → only the recent entry survives.
  eq(Object.keys(r.levels).length, 1);
});

// ============================= Summary =============================
console.log('\n' + (failed === 0 ? '\x1b[32m' : '\x1b[31m') +
  passed + ' passed, ' + failed + ' failed\x1b[0m');
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log('  - ' + f.name);
    console.log('    ' + f.err.stack.split('\n').slice(0, 3).join('\n    '));
  }
  process.exit(1);
}
process.exit(0);
