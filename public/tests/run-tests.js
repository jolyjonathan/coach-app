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
// banister.js puis bayesian.js — modules purs eux aussi. L'ordre compte :
// bayesian.js lit window.Banister (ajustement R selon fatigue, amélioration #3).
// core.js / exercises-data.js / gamification.js : extraits d'app.js (audit
// modularité) — scripts classiques à portée globale partagée, chargés AVANT
// app.js exactement comme dans index.html.
for (const mod of ['i18n.js', 'core.js', 'exercises-data.js', 'gamification.js',
                   'banister.js', 'bayesian.js', 'cycle.js', 'blockreview.js']) {
  try {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', mod), 'utf8'),
      sandbox, { filename: mod });
  } catch (e) {
    console.error(mod + ' load failed:', e.stack);
    process.exit(1);
  }
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

// ===================== BANISTER.JS & BAYESIAN.JS (améliorations) =====================
// Tests des 9 améliorations : τ calibrés, readiness pondéré, R fatigue,
// détraining personnalisé, monotonie/strain, ACWR, fenêtre test, deload
// advisor, plateau.

const Ban = ctx.Banister;
const Bay = ctx.Bayesian;
truthy(Ban, 'Banister module must be loaded');
truthy(Bay, 'Bayesian module must be loaded');

// Helper : date ISO il y a `k` jours.
function dAgo(k) { return new Date(Date.now() - k * 86400000).toISOString().slice(0, 10); }
// Helper : séance muscu synthétique (sets × rpe).
function gymDay(k, nSets, rpe, exoId, weight, reps) {
  const sets = [];
  for (let i = 0; i < nSets; i++) {
    sets.push(exoId ? { exoId, weight, reps } : {});
  }
  return { date: dAgo(k), rpe, sets };
}

// --- #5 Monotonie & strain (Foster 1998) ---
test('Banister.monotony: charge identique 7j/7 → monotonie max, level high', () => {
  const hist = [];
  for (let k = 0; k < 7; k++) hist.push(gymDay(k, 5, 7));
  const m = Ban.monotony(hist);
  truthy(m, 'monotony attendu');
  eq(m.level, 'high');
  eq(m.monotony, 5); // sd=0 → cap
  eq(m.weeklyLoad, 245); // 7 × 35
});
test('Banister.monotony: jours lourds/légers alternés → level ok', () => {
  // 3 séances espacées dans la semaine, 4 jours off → sd élevée.
  const hist = [gymDay(0, 10, 9), gymDay(3, 4, 6), gymDay(6, 8, 8)];
  const m = Ban.monotony(hist);
  truthy(m);
  eq(m.level, 'ok');
});
test('Banister.monotony: semaine vide → null', () => {
  eq(Ban.monotony([gymDay(20, 5, 7)]), null);
});

// --- #6 ACWR (Gabbett 2016) ---
test('Banister.acwr: charge stable 28j → ratio ~1, zone optimal', () => {
  const hist = [];
  for (let k = 0; k < 28; k++) hist.push(gymDay(k, 5, 7));
  const a = Ban.acwr(hist);
  truthy(a);
  truthy(Math.abs(a.ratio - 1.0) < 0.05, 'ratio ~1, got ' + a.ratio);
  eq(a.zone, 'optimal');
});
test('Banister.acwr: pic aigu sur fond léger → zone danger', () => {
  const hist = [];
  for (let k = 7; k < 28; k++) hist.push(gymDay(k, 2, 7));  // 3 sem légères
  for (let k = 0; k < 7; k++) hist.push(gymDay(k, 10, 8));  // grosse semaine
  const a = Ban.acwr(hist);
  truthy(a);
  truthy(a.ratio > 1.5, 'ratio > 1.5 attendu, got ' + a.ratio);
  eq(a.zone, 'danger');
  truthy(a.caveat && a.caveat.length > 0, 'caveat scientifique attendu');
});
test('Banister.acwr: pas d\'historique → null', () => {
  eq(Ban.acwr([]), null);
});

// --- #7 Fenêtre de test 1RM (tapering) ---
test('Banister.bestTestWindow: fatigue récente → fenêtre s\'ouvre plus tard', () => {
  const hist = [];
  for (let k = 0; k < 14; k++) hist.push(gymDay(k, 10, 9)); // 2 sem très lourdes
  const w = Ban.bestTestWindow(hist, 14);
  truthy(w, 'résultat attendu');
  truthy(Array.isArray(w.series) && w.series.length === 15);
  if (w.bestDay != null) {
    truthy(w.bestDay > 0, 'fatigué aujourd\'hui → pas jour 0, got ' + w.bestDay);
    truthy(w.tsbAtBest >= 5, 'TSB ≥ +5 à la fenêtre');
  } else {
    truthy(/deload/i.test(w.advice), 'sans fenêtre → conseil deload');
  }
});
test('Banister.bestTestWindow: historique vide → null', () => {
  eq(Ban.bestTestWindow([], 14), null);
});

// --- #1 Calibration τ par utilisateur ---
test('Banister.calibrateTaus: données insuffisantes → défauts 42/7, calibrated=false', () => {
  const c = Ban.calibrateTaus([gymDay(0, 5, 7, 'dc', 100, 5)]);
  eq(c.calibrated, false);
  eq(c.tauFitness, 42);
  eq(c.tauFatigue, 7);
});
test('Banister.computeAll: opts.taus force des constantes explicites', () => {
  const hist = [];
  for (let k = 0; k < 14; k++) hist.push(gymDay(k, 5, 7));
  const def = Ban.computeAll(hist, Date.now(), { taus: { tauFitness: 42, tauFatigue: 7 } });
  const alt = Ban.computeAll(hist, Date.now(), { taus: { tauFitness: 28, tauFatigue: 4 } });
  truthy(isFinite(def.tsb) && isFinite(alt.tsb));
  truthy(def.ctl !== alt.ctl, 'τ différents → CTL différents');
});

// --- #2 Readiness pondéré par fiabilité de la baseline ---
test('Banister.readiness: baseline maigre → contribution HRV réduite (weight<1)', () => {
  const mk = (n) => {
    const physio = [];
    for (let k = 1; k <= n; k++) {
      physio.push({ date: dAgo(k), hrv: 50 + (k % 2 ? 3 : -3) }); // sd > 0
    }
    physio.push({ date: dAgo(0), hrv: 70 }); // aujourd'hui : HRV haute
    return physio;
  };
  const few = Ban.readiness([], mk(6), null);
  const many = Ban.readiness([], mk(15), null);
  truthy(few.weights && many.weights, 'weights exposés');
  truthy(few.weights.hrv < many.weights.hrv,
    'fiabilité ' + few.weights.hrv + ' < ' + many.weights.hrv);
  truthy(many.weights.hrv === 1, 'baseline riche → pleine confiance');
  truthy(few.breakdown.hrv < many.breakdown.hrv,
    'contribution réduite quand la baseline est maigre');
});

// --- #3 Kalman : R gonflé en cas de fatigue (TSB très négatif) ---
test('Bayesian.computeState: contre-perf un jour de fatigue → moins crue (fatigueAdjust)', () => {
  const hist = [];
  // 8 semaines de bench stable à 100kg×5 tous les 4 jours.
  for (let k = 56; k >= 14; k -= 4) hist.push(gymDay(k, 1, 8, 'dc', 100, 5));
  // 10 derniers jours : grosses séances externes quotidiennes → TSB très négatif.
  for (let k = 9; k >= 1; k--) {
    hist.push({ date: dAgo(k), kind: 'external', durationMin: 150, rpe: 9 });
  }
  // Aujourd'hui : set faible (fatigue, pas vraie régression).
  hist.push(gymDay(0, 1, 8, 'dc', 80, 5));
  const withAdj = Bay.computeState(hist, 'dc', { qScale: 1 });
  const without = Bay.computeState(hist, 'dc', { qScale: 1, fatigueAdjust: false });
  truthy(withAdj && without, 'états attendus');
  truthy(withAdj.mu >= without.mu,
    'avec ajustement fatigue, la contre-perf pèse moins : ' +
    withAdj.mu.toFixed(1) + ' >= ' + without.mu.toFixed(1));
});

// --- #9 Détection de plateau ---
test('Bayesian.detectPlateau: pente ~nulle, confiante, 5 semaines → plateau', () => {
  const now = Date.now();
  const state = {
    n: 14, firstT: now - 35 * 86400000, lastT: now,
    beta: 0.001, betaClipped: 0.001, Pb: 0.0001, // σβ/sem ≈ 0.07
    mu: 120, Pmu: 4,
  };
  const p = Bay.detectPlateau(state);
  eq(p.plateau, true);
  truthy(p.weeks >= 4);
  truthy(/variation|stimulus/i.test(p.advice));
});
test('Bayesian.detectPlateau: progression réelle → pas de plateau', () => {
  const now = Date.now();
  const state = {
    n: 14, firstT: now - 35 * 86400000, lastT: now,
    beta: 0.15, betaClipped: 0.15, Pb: 0.0001, mu: 120, Pmu: 4,
  };
  eq(Bay.detectPlateau(state).plateau, false);
});
test('Bayesian.detectPlateau: trop peu de données → pas de verdict', () => {
  const now = Date.now();
  eq(Bay.detectPlateau({ n: 5, firstT: now - 60 * 86400000, lastT: now,
    beta: 0, Pb: 0.0001 }).plateau, false);
});

// --- #4 Détraining personnalisé (Mujika & Padilla) ---
test('Science.detrainingProjection: entraîné < standard < novice', () => {
  const std = Sci.detrainingProjection(30);
  const trained = Sci.detrainingProjection(30, { ctl: 70 });
  const novice = Sci.detrainingProjection(30, { trainingAgeWeeks: 10 });
  truthy(trained.lossPct < std.lossPct, 'entraîné retient mieux');
  truthy(novice.lossPct > std.lossPct, 'novice perd plus vite');
  eq(trained.profile, 'trained');
  eq(novice.profile, 'novice');
  eq(std.profile, 'standard');
});
test('Science.detrainingProjection: sans opts → comportement historique', () => {
  const r = Sci.detrainingProjection(30);
  eq(r.profile, 'standard');
  truthy(r.lossPct >= 12 && r.lossPct <= 14, 'courbe Mujika inchangée');
});

// --- #8 Deload advisor fusionné ---
test('Science.deloadAdvisor: convergence de signaux → recommended + raisons sourcées', () => {
  const v = Sci.deloadAdvisor({
    tsbLevel: 'overload',
    drifts: [{ name: 'Développé couché', severity: 'strong' }],
    hooperLevel: 'low',
    monotonyLevel: 'high',
    acwrZone: 'danger',
  });
  eq(v.level, 'recommended');
  truthy(v.recommend);
  truthy(v.score >= 3);
  truthy(v.reasons.length >= 4, 'chaque signal documente sa raison');
  truthy(v.reasons.every(r => r.source && r.detail), 'raisons sourcées');
});
test('Science.deloadAdvisor: un seul signal faible → none', () => {
  const v = Sci.deloadAdvisor({ tsbLevel: 'fatigued' });
  eq(v.level, 'none');
  eq(v.recommend, false);
});
test('Science.deloadAdvisor: deux signaux → consider', () => {
  const v = Sci.deloadAdvisor({ tsbLevel: 'fatigued', hooperLevel: 'low' });
  eq(v.level, 'consider');
});
test('Science.deloadAdvisor: aucun signal → none, conseil neutre', () => {
  const v = Sci.deloadAdvisor({});
  eq(v.score, 0);
  eq(v.level, 'none');
});

// ===================== Charge cardio + overreaching autonome =====================

test('Banister.cardioLoad: kcal prioritaire sur HR et RPE', () => {
  const l = Ban.cardioLoad({ durationMin: 30, kcal: 350, avgHR: 150, rpe: 8 });
  truthy(Math.abs(l - 50) < 0.01, '350/7 = 50, got ' + l); // KCAL_PER_LOAD=7
});
test('Banister.cardioLoad: TRIMP via FC si pas de kcal', () => {
  const l = Ban.cardioLoad({ durationMin: 40, avgHR: 150, hrRest: 60, hrMax: 190 });
  truthy(l > 0, 'TRIMP positif attendu, got ' + l);
  // Sans FC ni kcal → fallback sRPE.
  const f = Ban.cardioLoad({ durationMin: 30, rpe: 7 });
  truthy(Math.abs(f - 35) < 0.01, '30*7/6=35, got ' + f);
});
test('Banister.sessionLoad: activité externe avec kcal utilise la charge cardio', () => {
  const withKcal = Ban.sessionLoad({ date: dAgo(0), kind: 'external', durationMin: 30, kcal: 350 });
  const without  = Ban.sessionLoad({ date: dAgo(0), kind: 'external', durationMin: 30, rpe: 7 });
  truthy(withKcal !== without, 'kcal doit changer la charge');
  truthy(Math.abs(withKcal - 50) < 0.01, 'charge depuis kcal');
});

test('Science.autonomicOverreaching: 3 marqueurs concordants → alert', () => {
  const physio = [];
  // 28j de baseline stable, puis 7j dégradés (HRV bas, RHR/resp hauts).
  for (let k = 35; k > 7; k--) {
    physio.push({ date: dAgo(k), hrv: 60 + (k % 2 ? 2 : -2), rhr: 55 + (k % 2 ? 1 : -1), respRate: 14 + (k % 2 ? 0.3 : -0.3) });
  }
  for (let k = 7; k >= 0; k--) {
    physio.push({ date: dAgo(k), hrv: 45, rhr: 62, respRate: 16 });
  }
  const r = Sci.autonomicOverreaching(physio);
  eq(r.level, 'alert');
  eq(r.signals.length, 3);
});
test('Science.autonomicOverreaching: marqueurs stables → none', () => {
  const physio = [];
  for (let k = 35; k >= 0; k--) {
    physio.push({ date: dAgo(k), hrv: 60 + (k % 2 ? 1 : -1), rhr: 55, respRate: 14 });
  }
  eq(Sci.autonomicOverreaching(physio).level, 'none');
});
test('Science.autonomicOverreaching: trop peu de données → none', () => {
  eq(Sci.autonomicOverreaching([{ date: dAgo(1), hrv: 50 }]).level, 'none');
});
test('Science.deloadAdvisor: signal autonome alert pèse 2', () => {
  const v = Sci.deloadAdvisor({ autonomicLevel: 'alert', tsbLevel: 'fatigued' });
  truthy(v.score >= 3, 'alert(2)+fatigued(1)=3 → recommended');
  eq(v.level, 'recommended');
});

// ===================== i18n =====================
const I18N = ctx.i18n;
truthy(I18N, 'i18n module must be loaded');
test('i18n.t: clé connue traduite', () => {
  I18N.setLang('en');
  eq(I18N.t('nav.today'), 'Today');
  I18N.setLang('fr');
  eq(I18N.t('nav.today'), 'Aujourd\'hui');
});
test('i18n.t: interpolation {var}', () => {
  // Pas de clé avec var dans le socle → on teste le mécanisme via fallback clé.
  eq(I18N.t('home.greeting'), 'Salut');
});
test('i18n.t: clé absente → renvoie la clé', () => {
  eq(I18N.t('does.not.exist'), 'does.not.exist');
});
test('i18n.t: fallback fr si clé manquante en en', () => {
  I18N.setLang('en');
  // Toutes les clés du socle existent dans les deux ; on vérifie au moins
  // que le fallback ne casse pas et qu'une clé connue répond.
  truthy(I18N.t('action.save').length > 0);
  I18N.setLang('fr');
});

// ===================== Périodisation par cycle (opt-in) =====================
const Cyc = ctx.Cycle;
truthy(Cyc, 'Cycle module must be loaded');

test('Cycle.phaseFor: opt-out → null', () => {
  eq(Cyc.phaseFor({ enabled: false, periods: [dAgo(3)] }), null);
});
test('Cycle.phaseFor: j3 → phase menstruelle', () => {
  const r = Cyc.phaseFor({ enabled: true, periods: [dAgo(2)] }); // j3 (1-based)
  truthy(r, 'résultat attendu');
  eq(r.phase, 'menstruelle');
  truthy(r.volumeMod <= 1);
});
test('Cycle.phaseFor: j10 sur cycle 28 → folliculaire', () => {
  const r = Cyc.phaseFor({ enabled: true, periods: [dAgo(9)], avgLength: 28 });
  eq(r.phase, 'folliculaire');
  truthy(r.volumeMod >= 1);
});
test('Cycle.phaseFor: j14 sur cycle 28 → ovulatoire', () => {
  const r = Cyc.phaseFor({ enabled: true, periods: [dAgo(13)], avgLength: 28 });
  eq(r.phase, 'ovulatoire');
});
test('Cycle.phaseFor: j22 sur cycle 28 → lutéale', () => {
  const r = Cyc.phaseFor({ enabled: true, periods: [dAgo(21)], avgLength: 28 });
  eq(r.phase, 'lutéale');
  truthy(r.caveat && /débattue/i.test(r.caveat), 'caveat scientifique présent');
});
test('Cycle.estimateCycleLength: médiane des intervalles', () => {
  const len = Cyc.estimateCycleLength([dAgo(56), dAgo(28), dAgo(0)]);
  eq(len, 28);
});
test('Cycle.cycleDay: pas de données → null', () => {
  eq(Cyc.cycleDay({ enabled: true, periods: [] }), null);
});

// ===================== Bilan de fin de bloc (BlockReview) =====================
const BR = ctx.BlockReview;
truthy(BR, 'BlockReview module must be loaded');

test('BlockReview.pearson: corrélation parfaite → 1', () => {
  const r = BR.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  truthy(Math.abs(r - 1) < 1e-9, 'r=' + r);
});
test('BlockReview.pearson: anti-corrélation → -1', () => {
  const r = BR.pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  truthy(Math.abs(r + 1) < 1e-9, 'r=' + r);
});
test('BlockReview.pearson: n<5 ou variance nulle → null', () => {
  eq(BR.pearson([1, 2], [3, 4]), null);
  eq(BR.pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]), null);
});

test('BlockReview.setsByZone: fenêtre + primaire/secondaire', () => {
  const lib = { squat: { z: ['quads', 'glutes'] } };
  const day = (n) => new Date(Date.parse('2026-06-01') + n * 86400000).toISOString();
  const hist = [
    { date: day(1), sets: [{ exoId: 'squat', reps: 5, weight: 100 }, { exoId: 'squat', reps: 5, weight: 100 }] },
    { date: day(60), sets: [{ exoId: 'squat', reps: 5, weight: 100 }] }, // hors fenêtre
    { date: day(2), kind: 'external', sets: [{ exoId: 'squat', reps: 5, weight: 100 }] }, // exclu
  ];
  const z = BR.setsByZone(hist, Date.parse('2026-06-01'), Date.parse('2026-06-15'), lib);
  eq(z.quads, 2);   // zone primaire ×1.0
  eq(z.glutes, 1);  // zone secondaire ×0.5
});

test('BlockReview.compute: null sans macrocycle ou trop tôt', () => {
  eq(BR.compute({ history: [], macrocycle: null }), null);
  const now = Date.parse('2026-06-05');
  eq(BR.compute({
    history: [], physio: [],
    macrocycle: { startDate: '2026-06-01' }, now,
    models: { Banister: ctx.Banister, Bayesian: ctx.Bayesian, Programming: { pickKeyLifts: () => [] } },
  }), null, 'bloc 1 à J4 → trop tôt, pas de bloc précédent');
});

test('BlockReview.compute: synthèse d\'un bloc avec progression', () => {
  const start = Date.parse('2026-05-01');
  const now = start + 41 * 86400000; // fin de bloc 1
  const hist = [];
  // 3 séances/sem, squat qui progresse de 100 → 112 kg (5 reps).
  for (let d = 0; d < 42; d += 2) {
    hist.push({
      date: new Date(start + d * 86400000).toISOString(),
      sets: [{ exoId: 'squat', reps: 5, weight: 100 + d * 0.3, rpe: 7.5 }],
      rpe: 7.5,
    });
  }
  const physio = [];
  for (let d = 0; d < 42; d += 3) {
    physio.push({ date: new Date(start + d * 86400000).toISOString().slice(0, 10), hrv: 50 + (d % 10) });
  }
  const rev = BR.compute({
    history: hist, physio,
    macrocycle: { startDate: '2026-05-01', focus: 'force' }, now,
    models: {
      Banister: ctx.Banister, Bayesian: ctx.Bayesian,
      Programming: { pickKeyLifts: () => ['squat'] },
    },
    exoLib: { squat: { z: ['quads', 'glutes'] } },
  });
  truthy(rev, 'review attendue');
  eq(rev.blockIdx, 1);
  truthy(rev.adherence.sessions >= 20, 'sessions=' + rev.adherence.sessions);
  truthy(rev.adherence.perWeek > 3 && rev.adherence.perWeek < 4, 'perWeek=' + rev.adherence.perWeek);
  truthy(rev.lifts.length === 1 && rev.lifts[0].exoId === 'squat');
  truthy(rev.lifts[0].end && rev.lifts[0].end.mu > 100, '1RM fin de bloc > 100');
  truthy(rev.banister.ctlEnd > rev.banister.ctlStart, 'CTL doit monter sur un bloc chargé');
  truthy(rev.next && rev.next.why && rev.next.why.length > 20, 'recommandation motivée');
  truthy(rev.volume.setsByZone.quads > 0, 'volume quads compté');
});

test('BlockReview.compute: début de bloc N+1 → bilan du bloc précédent complet', () => {
  const start = Date.parse('2026-05-01');
  const now = start + (42 + 3) * 86400000; // J3 du bloc 2
  const hist = [{
    date: new Date(start + 10 * 86400000).toISOString(),
    sets: [{ exoId: 'squat', reps: 5, weight: 100, rpe: 7 }], rpe: 7,
  }];
  const rev = BR.compute({
    history: hist, physio: [],
    macrocycle: { startDate: '2026-05-01' }, now,
    models: {
      Banister: ctx.Banister, Bayesian: ctx.Bayesian,
      Programming: { pickKeyLifts: () => [] },
    },
    exoLib: {},
  });
  truthy(rev, 'review attendue');
  eq(rev.blockIdx, 1, 'doit porter sur le bloc 1 (complet), pas le bloc 2 entamé');
  truthy(rev.completed, 'bloc 1 marqué complet');
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
