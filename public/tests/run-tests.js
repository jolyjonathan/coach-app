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
 *   - Science.* (niveau 5)  : RIR Zourdos, Hooper, HRV Plews, bodyWeightTrend
 *                             Hall, proteinTargets Schoenfeld, PVT Dinges,
 *                             asymmetryReport Bishop, detraining Mujika,
 *                             NEAT trend, caffeine-sleep correlation.
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
// Charge d'abord science.js (qui n'a aucune dépendance) puis app.js. Comme
// science.js publie sur window.Science et que la sandbox window === sandbox,
// l'objet est ensuite accessible via sandbox.Science.
try {
  const sciencePath = path.join(__dirname, '..', 'science.js');
  vm.runInContext(fs.readFileSync(sciencePath, 'utf8'), sandbox, { filename: 'science.js' });
} catch (e) {
  console.error('science.js load failed:', e.stack);
  process.exit(1);
}
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

// ============================= SCIENCE.JS =============================
// Tests pour le module Science (niveau 5). On accède via ctx.Science car
// science.js fait window.Science = {...} et window === sandbox.

const Sci = ctx.Science;
truthy(Sci, 'Science module must be loaded');

// --- RIR (Zourdos 2016) ---
test('Science.rirToRpe: 0 reps in reserve → RPE 10 (échec)', () => {
  eq(Sci.rirToRpe(0), 10);
});
test('Science.rirToRpe: 1 RIR → RPE 9', () => {
  eq(Sci.rirToRpe(1), 9);
});
test('Science.rirToRpe: 3 RIR → RPE 7', () => {
  eq(Sci.rirToRpe(3), 7);
});
test('Science.rirToRpe: 5+ RIR → RPE plafonné à 5.5', () => {
  eq(Sci.rirToRpe(5), 5.5);
  eq(Sci.rirToRpe(8), 5.5);
});
test('Science.rirToRpe: null/NaN → null', () => {
  eq(Sci.rirToRpe(null), null);
  eq(Sci.rirToRpe(NaN), null);
});
test('Science.rpeToRir: inversion cohérente', () => {
  eq(Sci.rpeToRir(10), 0);
  eq(Sci.rpeToRir(8), 2);
  eq(Sci.rpeToRir(5), 5);
});
test('Science.rirReliability: échec → variance basse', () => {
  truthy(Sci.rirReliability(0) < Sci.rirReliability(4));
});

// --- Hooper (1995) ---
test('Science.hooperIndex: 5 items moyens → raw=20 (4 par item)', () => {
  const r = Sci.hooperIndex({sleep:4, stress:4, mood:4, soreness:4, fatigue:4});
  eq(r.raw, 20);
  eq(r.n, 5);
});
test('Science.hooperIndex: normalise si items manquants', () => {
  // 3 items à 4 → moyenne 4 → ramené à 5 items = 20
  const r = Sci.hooperIndex({sleep:4, stress:4, mood:4});
  eq(r.raw, 20);
  eq(r.n, 3);
});
test('Science.hooperIndex: rejette si <3 items renseignés', () => {
  eq(Sci.hooperIndex({sleep:4, stress:4}), null);
});
test('Science.hooperIndex: ignore les valeurs hors range 1-7', () => {
  const r = Sci.hooperIndex({sleep:4, stress:4, mood:4, soreness:99, fatigue:0});
  eq(r.n, 3);  // 99 et 0 ignorés
});
test('Science.hooperReadiness: index 5 → ready 100, index 35 → ready 0', () => {
  const best = Sci.hooperReadiness({sleep:1, stress:1, mood:1, soreness:1, fatigue:1});
  eq(best.ready, 100);
  const worst = Sci.hooperReadiness({sleep:7, stress:7, mood:7, soreness:7, fatigue:7});
  eq(worst.ready, 0);
});
test('Science.hooperReadiness: index ≥22 → label caution ou low', () => {
  const r = Sci.hooperReadiness({sleep:5, stress:5, mood:4, soreness:4, fatigue:5});
  truthy(r.label === 'caution' || r.label === 'low');
});

// --- bodyWeightTrend (Hall 2011) ---
test('Science.bodyWeightTrend: rejette si <3 points', () => {
  eq(Sci.bodyWeightTrend([{date:'2026-01-01', kg:80}, {date:'2026-01-02', kg:79}]), null);
});
test('Science.bodyWeightTrend: pente positive détecte une prise', () => {
  const ws = [];
  for (let i = 0; i < 30; i++) {
    ws.push({date: new Date(Date.now() - (29-i)*86400000).toISOString(), kg: 70 + 0.05*i});
  }
  const t = Sci.bodyWeightTrend(ws, {weeks: 6});
  truthy(t.slopeKgPerWeek > 0.3);
  truthy(t.kcalPerDay > 200);  // prise → excédent calorique
});
test('Science.bodyWeightTrend: 1 kg/sem ≈ 1100 kcal/jour (Hall)', () => {
  const ws = [];
  for (let i = 0; i < 28; i++) {
    ws.push({date: new Date(Date.now() - (27-i)*86400000).toISOString(), kg: 70 + (i/7)});
  }
  const t = Sci.bodyWeightTrend(ws, {weeks: 4});
  // Slope ~1 kg/sem → 7700/7 = 1100 kcal/jour (Hall 2011, 1kg ≈ 7700kcal)
  truthy(Math.abs(t.kcalPerDay - 1100) < 100, 'expected ~1100, got ' + t.kcalPerDay);
});

// --- linearRegression ---
test('Science.linearRegression: droite parfaite y=2x+1 → slope=2, r²=1', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({x: i, y: 2*i + 1});
  const r = Sci.linearRegression(pts);
  truthy(Math.abs(r.slope - 2) < 1e-9);
  truthy(Math.abs(r.intercept - 1) < 1e-9);
  truthy(Math.abs(r.r2 - 1) < 1e-9);
});
test('Science.movingAverage: fenêtre 3 lisse les valeurs', () => {
  const ma = Sci.movingAverage([1, 2, 3, 4, 5], 3);
  eq(ma.length, 5);
  eq(ma[2], 2);  // (1+2+3)/3
  eq(ma[4], 4);  // (3+4+5)/3
});

// --- proteinTargets (Schoenfeld 2018) ---
test('Science.proteinTargets: 80kg → 128-176 g/jour', () => {
  const p = Sci.proteinTargets(80, 4);
  eq(p.perDayMin, 128);   // 1.6 × 80
  eq(p.perDayMax, 176);   // 2.2 × 80
  eq(p.perMealMin, 32);   // 0.4 × 80
});
test('Science.proteinTargets: clamp nombre de repas 2-6', () => {
  eq(Sci.proteinTargets(70, 1).mealsPerDay, 2);
  eq(Sci.proteinTargets(70, 10).mealsPerDay, 6);
});
test('Science.proteinTargets: rejette si poids ≤0', () => {
  eq(Sci.proteinTargets(0, 4), null);
  eq(Sci.proteinTargets(null, 4), null);
});

// --- PVT (Dinges 1985) ---
test('Science.pvtAnalyze: réactions valides → meanMs cohérent', () => {
  const r = Sci.pvtAnalyze([300, 320, 280, 310, 295]);
  truthy(Math.abs(r.meanMs - 301) < 2);
  eq(r.lapses, 0);
});
test('Science.pvtAnalyze: lapses (RT>500ms) comptés correctement', () => {
  const r = Sci.pvtAnalyze([300, 540, 600, 290, 700]);
  eq(r.lapses, 3);
});
test('Science.pvtAnalyze: false starts (<100ms) séparés des RT', () => {
  const r = Sci.pvtAnalyze([300, 50, 280, 80, 310]);
  eq(r.falseStarts, 2);
  eq(r.n, 3);  // 3 RT valides
});
test('Science.pvtAnalyze: tableau vide → null', () => {
  eq(Sci.pvtAnalyze([]), null);
});

// --- Asymétries (Bishop 2018) ---
test('Science.asymmetryReport: déséquilibre 30% flaggé severe', () => {
  const hist = [];
  for (let d = 0; d < 10; d++) {
    hist.push({
      date: new Date(Date.now() - d*86400000*2).toISOString(),
      sets: [
        {exoId: 'bulgare', side: 'L', reps: 6, weight: 14},
        {exoId: 'bulgare', side: 'R', reps: 10, weight: 20},
      ]
    });
  }
  const r = Sci.asymmetryReport(hist);
  truthy(r.length === 1);
  eq(r[0].label, 'severe');
  eq(r[0].weaker, 'L');
});
test('Science.asymmetryReport: ignore les exos bilatéraux (side=B ou null)', () => {
  const hist = [{
    date: new Date().toISOString(),
    sets: [
      {exoId: 'squat', side: 'B', reps: 10, weight: 80},
      {exoId: 'squat', reps: 10, weight: 80},
    ]
  }];
  eq(Sci.asymmetryReport(hist).length, 0);
});
test('Science.asymmetryReport: ignore si <minReps par côté', () => {
  const hist = [{
    date: new Date().toISOString(),
    sets: [{exoId: 'bulgare', side: 'L', reps: 8, weight: 20},
           {exoId: 'bulgare', side: 'R', reps: 10, weight: 22}],
  }];
  // Un seul set par côté < minReps=6 → ignoré
  eq(Sci.asymmetryReport(hist).length, 0);
});

// --- Détraining (Mujika & Padilla 2000) ---
test('Science.detrainingProjection: <7 jours → null (pas de perte)', () => {
  eq(Sci.detrainingProjection(3), null);
  eq(Sci.detrainingProjection(6), null);
});
test('Science.detrainingProjection: 14j ≈ 5% loss (cohérent Mujika)', () => {
  const r = Sci.detrainingProjection(14);
  truthy(r.lossPct >= 3 && r.lossPct <= 7);
});
test('Science.detrainingProjection: 28j ≈ 12% loss', () => {
  const r = Sci.detrainingProjection(28);
  truthy(r.lossPct >= 10 && r.lossPct <= 15);
});
test('Science.detrainingProjection: 56j → significant + plateau ≤30%', () => {
  const r = Sci.detrainingProjection(56);
  eq(r.severity, 'significant');
  truthy(r.lossPct >= 18 && r.lossPct <= 25);
});
test('Science.detrainingProjection: long arrêt → plafond ~35%', () => {
  const r = Sci.detrainingProjection(180);
  truthy(r.lossPct <= 36);
});

// --- lastTrainingGapDays ---
test('Science.lastTrainingGapDays: pas d\'historique → null', () => {
  eq(Sci.lastTrainingGapDays([]), null);
});
test('Science.lastTrainingGapDays: dernière séance hier → 1', () => {
  const hist = [{date: new Date(Date.now() - 86400000).toISOString()}];
  eq(Sci.lastTrainingGapDays(hist), 1);
});

// --- HRV (Plews 2013) ---
test('Science.hrvBaseline: rejette si <3 points', () => {
  eq(Sci.hrvBaseline([{date:'2026-01-01', rmssd: 50}]), null);
});
test('Science.hrvBaseline: calcule baseline et SD', () => {
  const physio = [];
  for (let i = 0; i < 21; i++) {
    physio.push({date: new Date(Date.now() - (20-i)*86400000).toISOString(), rmssd: 55});
  }
  const b = Sci.hrvBaseline(physio);
  truthy(b);
  truthy(Math.abs(b.baselineRmssd - 55) < 1);
  truthy(b.sd >= 0);
});
test('Science.hrvReadiness: chute brutale → label low', () => {
  const physio = [];
  for (let i = 0; i < 21; i++) {
    physio.push({date: new Date(Date.now() - (20-i)*86400000).toISOString(),
                 rmssd: 55 + Math.sin(i)*2});
  }
  physio.push({date: new Date().toISOString(), rmssd: 30});
  const r = Sci.hrvReadiness(physio);
  truthy(r.label === 'low' || r.label === 'caution');
  truthy(r.z < -0.5);
});

// --- NEAT (Levine 2005) ---
test('Science.neatTrend: calcule avg 7j et delta', () => {
  const ls = [];
  for (let i = 0; i < 14; i++) {
    ls.push({date: new Date(Date.now() - (13-i)*86400000).toISOString().slice(0,10),
             steps: 8000});
  }
  const t = Sci.neatTrend(ls);
  truthy(Math.abs(t.avg7 - 8000) < 1);
  truthy(Math.abs(t.delta) < 1);  // pas de changement
});

// --- Caffeine-sleep correlation (Drake 2013) ---
test('Science.caffeineSleepCorrelation: trop peu de paires → corr null', () => {
  const r = Sci.caffeineSleepCorrelation([], []);
  eq(r.corr, null);
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
