/* =============================================================
 * Coach Adaptatif — cycle.js
 * =============================================================
 * Périodisation par cycle menstruel — OPT-IN, données sensibles.
 *
 * Principe (revues McNulty 2020, Sims & Heather 2018) : les fluctuations
 * hormonales du cycle modulent légèrement la disponibilité à l'entraînement.
 * La littérature est DÉBATTUE (effet moyen faible, forte variabilité
 * individuelle) — on présente donc ça comme une suggestion calibrable, jamais
 * une contrainte, avec un caveat explicite côté UI.
 *
 * Modèle simple à 4 phases sur un cycle de référence (longueur médiane
 * personnalisée, défaut 28 j), compté depuis le 1er jour des dernières règles :
 *   - menstruelle (j1–5)        : volume légèrement réduit si symptômes
 *   - folliculaire (j6–13)      : fenêtre favorable, on peut pousser
 *   - ovulatoire (j14 ±1)       : pic de force possible — bon pour un test
 *   - lutéale (j15–fin)         : fatigue/thermogenèse ↑, on lisse l'intensité
 *
 * Confidentialité : aucune donnée ne quitte l'appareil (comme tout le reste).
 * Opt-in strict : le module ne calcule rien tant que cycle.enabled !== true.
 * Pur, sans DOM, sans dépendance.
 * ============================================================= */
(function () {
  'use strict';

  const DEFAULT_LEN = 28;
  const MIN_LEN = 21;
  const MAX_LEN = 40;

  // estimateCycleLength — médiane des intervalles entre débuts de règles.
  // periods : array de dates ISO (YYYY-MM-DD) de 1er jour de règles.
  function estimateCycleLength(periods) {
    if (!Array.isArray(periods) || periods.length < 2) return DEFAULT_LEN;
    const ts = periods.map(d => Date.parse(d)).filter(isFinite).sort((a, b) => a - b);
    if (ts.length < 2) return DEFAULT_LEN;
    const gaps = [];
    for (let i = 1; i < ts.length; i++) {
      const g = Math.round((ts[i] - ts[i - 1]) / 86400000);
      if (g >= MIN_LEN && g <= MAX_LEN) gaps.push(g);
    }
    if (gaps.length === 0) return DEFAULT_LEN;
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
  }

  // cycleDay — jour du cycle (1-based) à `atTime`, à partir du dernier début
  // de règles connu. Renvoie null si pas de données ou date future.
  function cycleDay(cycle, atTime) {
    if (!cycle || cycle.enabled !== true) return null;
    const periods = Array.isArray(cycle.periods) ? cycle.periods : [];
    atTime = atTime || Date.now();
    const ts = periods.map(d => Date.parse(d)).filter(t => isFinite(t) && t <= atTime).sort((a, b) => b - a);
    if (ts.length === 0) return null;
    const len = clampLen(cycle.avgLength || estimateCycleLength(periods));
    let days = Math.floor((atTime - ts[0]) / 86400000) + 1; // j1 = jour des règles
    // Si on a dépassé la longueur estimée (règles en retard / non loggées),
    // on modulo pour rester dans une phase plausible plutôt que d'afficher j45.
    if (days > len) days = ((days - 1) % len) + 1;
    return { day: days, length: len };
  }

  function clampLen(n) {
    n = +n || DEFAULT_LEN;
    return Math.max(MIN_LEN, Math.min(MAX_LEN, n));
  }

  // phaseFor — phase + modulation suggérée à `atTime`.
  // Renvoie null si opt-out ou pas de données. Sinon :
  //   { phase, day, length, volumeMod, intensityMod, advice, caveat }
  // volumeMod / intensityMod : multiplicateurs ~[0.85..1.05] à appliquer en
  // douceur (le caller décide s'il les utilise — opt-in dans l'opt-in).
  function phaseFor(cycle, atTime) {
    const cd = cycleDay(cycle, atTime);
    if (!cd) return null;
    const { day, length } = cd;
    const ovulation = length - 14; // lutéale ~constante à 14j (corps jaune)
    let phase, volumeMod = 1, intensityMod = 1, advice;
    if (day <= 5) {
      phase = 'menstruelle';
      volumeMod = 0.92; intensityMod = 0.97;
      advice = 'Phase menstruelle : si tu as des symptômes (crampes, fatigue), un volume légèrement réduit est ok. Sinon, entraîne-toi normalement — beaucoup performent très bien ici.';
    } else if (day < ovulation) {
      phase = 'folliculaire';
      volumeMod = 1.03; intensityMod = 1.02;
      advice = 'Phase folliculaire : fenêtre souvent favorable à la force et au volume. Bon moment pour pousser un peu.';
    } else if (day <= ovulation + 1) {
      phase = 'ovulatoire';
      volumeMod = 1.0; intensityMod = 1.04;
      advice = 'Autour de l\'ovulation : pic de force possible — fenêtre intéressante pour un test 1RM ou une grosse séance (attention articulaire, la laxité ligamentaire peut augmenter).';
    } else {
      phase = 'lutéale';
      volumeMod = 0.95; intensityMod = 0.98;
      advice = 'Phase lutéale : température et fatigue perçue peuvent monter. Lisse l\'intensité, soigne l\'hydratation et le sommeil. Rien d\'obligatoire — écoute tes sensations.';
    }
    return {
      phase, day, length,
      volumeMod: +volumeMod.toFixed(2),
      intensityMod: +intensityMod.toFixed(2),
      advice,
      caveat: 'Littérature débattue (McNulty 2020) : effet moyen faible, forte variabilité individuelle. À utiliser comme repère, pas comme règle — tes sensations priment.',
    };
  }

  window.Cycle = {
    DEFAULT_LEN,
    estimateCycleLength,
    cycleDay,
    phaseFor,
  };
})();
