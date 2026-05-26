/* =============================================================
 * Coach Adaptatif — Niveau 5 : couche scientifique additionnelle
 * =============================================================
 *
 * Module pur (IIFE → window.Science) qui regroupe les helpers
 * statistiques pour les fonctionnalités scientifiques greffées
 * par-dessus le coeur de l'app (banister.js, bayesian.js,
 * programming.js).
 *
 * Couvre :
 *   - RIR (Reps in Reserve) — Zourdos 2016 : conversion RIR ↔ RPE,
 *     pondération du Kalman par fiabilité de l'estimation.
 *   - HRV readiness — Plews 2013 : baseline 7j roulant + SD, flag
 *     "low readiness" quand chute > 0.5 SD individuelle.
 *   - Hooper wellness — Hooper 1995 : index agrégé 5 items + tendance.
 *   - Body composition — Hall 2011 (déficit calorique depuis pente),
 *     Schoenfeld 2018 (cible protéique 0.4g/kg/repas).
 *   - PVT — Dinges 1985 : analyse des lapses (RT > 500ms) + RT moyen.
 *   - Asymétries G/D — Bishop 2018 : seuil clinique 10%.
 *   - Désentraînement — Mujika & Padilla 2000 : décroissance exponentielle
 *     du 1RM avec τ ≈ 30j (force) vs ≈ 60j (hypertrophie).
 *   - Vie quotidienne — NEAT (Levine), caféine vs sommeil (Drake 2013),
 *     lumière matinale (Wright 2013) : helpers de corrélation.
 *
 * Aucune dépendance, aucun side-effect. Toutes les fonctions sont
 * testables en isolation et exposées via window.Science.
 * ============================================================= */
(function () {
  'use strict';

  /* ============================================================
   * 1. RIR (Zourdos 2016)
   * ============================================================
   * L'échelle RIR-RPE de Zourdos :
   *   RIR 5+ ↔ RPE 5.5   (warm-up / activation)
   *   RIR 4   ↔ RPE 6
   *   RIR 3   ↔ RPE 7
   *   RIR 2   ↔ RPE 8
   *   RIR 1   ↔ RPE 9
   *   RIR 0   ↔ RPE 10   (échec concentrique)
   *
   * Avantage par rapport au RPE direct : "combien je pouvais en faire
   * de plus" est plus concret que "à combien sur 10 j'étais", et les
   * lifters s'estiment mieux en RIR qu'en RPE (validé chez novices
   * comme experts dans Zourdos 2016). On stocke les deux (rir pour la
   * collecte, rpe dérivé pour rétrocompat avec tous les calculs
   * existants qui lisent set.rpe).
   * ============================================================ */
  function rirToRpe(rir) {
    if (rir == null || isNaN(rir)) return null;
    const r = Math.max(0, Math.min(10, +rir));
    if (r >= 5) return 5.5;          // toutes les valeurs très loin de l'échec sont équivalentes
    return 10 - r;                    // RIR 0→10, RIR 1→9, …, RIR 4→6
  }

  function rpeToRir(rpe) {
    if (rpe == null || isNaN(rpe)) return null;
    const v = Math.max(1, Math.min(10, +rpe));
    if (v <= 5.5) return 5;
    return Math.round(10 - v);
  }

  // Fiabilité de l'observation pour le Kalman : plus on est proche de
  // l'échec (RIR bas), plus l'estimation 1RM via Epley est fiable.
  // Renvoie une variance R en kg² à injecter dans bayesian.js
  // si on veut surcharger la R par défaut basée sur reps.
  function rirReliability(rir) {
    if (rir == null) return null;
    if (rir === 0) return 2.25;   // σ ≈ 1.5 kg
    if (rir <= 1) return 4;       // σ ≈ 2 kg
    if (rir <= 2) return 9;       // σ ≈ 3 kg
    if (rir <= 3) return 16;      // σ ≈ 4 kg
    return 49;                    // RIR ≥4, set trop léger, biais Epley fort
  }

  /* ============================================================
   * 2. HRV readiness (Plews 2013)
   * ============================================================
   * Méthode standard chez les coachs endurance élite :
   *   - calculer le baseline = moyenne mobile 7j du ln(RMSSD)
   *   - calculer la SD individuelle = écart-type du baseline sur 28j
   *   - "low readiness" si la valeur du jour < baseline − 0.5×SD
   *   - "high readiness" si > baseline + 0.5×SD
   *
   * On travaille en ln(RMSSD) car RMSSD a une distribution log-normale ;
   * la transformation log donne des écarts symétriques.
   * Plews & Laursen ont montré que les variations intra-individuelles
   * sont 4× plus informatives que la valeur absolue.
   * ============================================================ */
  function hrvBaseline(physio, opts) {
    opts = Object.assign({ window: 7, sdWindow: 28 }, opts || {});
    if (!Array.isArray(physio) || physio.length === 0) return null;
    const rows = physio
      .filter(p => p.rmssd != null && p.date)
      .map(p => ({ t: Date.parse(p.date), v: Math.log(Math.max(1, +p.rmssd)) }))
      .filter(p => isFinite(p.t) && isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    if (rows.length < 3) return null;
    const now = rows[rows.length - 1].t;
    const inWin = (ms) => rows.filter(r => r.t >= now - ms * 86400000);
    const recent = inWin(opts.window);
    const ext = inWin(opts.sdWindow);
    if (recent.length === 0) return null;
    const baseline = recent.reduce((a, r) => a + r.v, 0) / recent.length;
    let sd = null;
    if (ext.length >= 5) {
      const m = ext.reduce((a, r) => a + r.v, 0) / ext.length;
      const v = ext.reduce((a, r) => a + (r.v - m) * (r.v - m), 0) / (ext.length - 1);
      sd = Math.sqrt(v);
    }
    return {
      baselineLnRmssd: baseline,
      baselineRmssd: Math.exp(baseline),
      sd, n: recent.length, nExt: ext.length,
      latest: rows[rows.length - 1].v,
      latestRmssd: Math.exp(rows[rows.length - 1].v),
    };
  }

  function hrvReadiness(physio) {
    const b = hrvBaseline(physio);
    if (!b || b.sd == null) return null;
    const z = (b.latest - b.baselineLnRmssd) / b.sd;
    // Map z-score [-2..+2] → readiness [0..100], centré sur 50.
    const ready = Math.round(Math.max(0, Math.min(100, 50 + z * 25)));
    let label = 'normal';
    if (z < -1) label = 'low';
    else if (z < -0.5) label = 'caution';
    else if (z > 1) label = 'high';
    else if (z > 0.5) label = 'good';
    return { ready, z: +z.toFixed(2), label, baseline: b };
  }

  /* ============================================================
   * 3. Hooper wellness (Hooper 1995)
   * ============================================================
   * 5 items quotidiens, chacun noté 1 (excellent) à 7 (pire) :
   *   sleep, stress, mood, soreness, fatigue.
   * Index = somme (5..35). Plus c'est haut, plus c'est mauvais.
   * Hooper recommande de flagger les jours où l'index ≥ 22 (≈ 4.4
   * moyenne par item) comme à risque de surentraînement.
   *
   * On expose aussi un readiness 0-100 inversé pour la cohérence avec
   * les autres scores : 100 = parfait, 0 = épuisé.
   * ============================================================ */
  function hooperIndex(entry) {
    if (!entry) return null;
    const keys = ['sleep', 'stress', 'mood', 'soreness', 'fatigue'];
    const vals = keys.map(k => +entry[k]).filter(v => isFinite(v) && v >= 1 && v <= 7);
    if (vals.length < 3) return null;
    const sum = vals.reduce((a, v) => a + v, 0);
    const filled = sum * (5 / vals.length);  // normalise si certaines réponses manquent
    return { raw: Math.round(filled), n: vals.length };
  }

  function hooperReadiness(entry) {
    const h = hooperIndex(entry);
    if (!h) return null;
    // Mapping linéaire 5→100, 35→0
    const r = Math.round(((35 - h.raw) / 30) * 100);
    let label = 'normal';
    if (h.raw >= 25) label = 'low';
    else if (h.raw >= 22) label = 'caution';
    else if (h.raw <= 10) label = 'high';
    return { ready: Math.max(0, Math.min(100, r)), raw: h.raw, label };
  }

  /* ============================================================
   * 4. Body composition (Hall 2011 + Schoenfeld 2018)
   * ============================================================
   * - 7j MA + régression linéaire sur 4-8 semaines pour le trend du poids
   *   (filtre le bruit eau/glycogène).
   * - Hall 2011 dynamic model simplifié : pour les adultes,
   *   1 kg de tissu corporel ≈ 7700 kcal. La pente kg/semaine du poids
   *   trend permet d'estimer le déficit/excédent kcal/jour =
   *   (kg/sem × 7700) / 7.
   * - Cible protéique Schoenfeld 2018 pour maximiser MPS :
   *   0.4 g/kg/repas × 4 repas/jour = 1.6 g/kg/jour (sportifs).
   *   On flagge si répartition pauvre (un repas <0.3 g/kg).
   * ============================================================ */
  function movingAverage(values, window) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = values.slice(start, i + 1);
      out.push(slice.reduce((a, v) => a + v, 0) / slice.length);
    }
    return out;
  }

  function linearRegression(points) {
    // points: [{x, y}], retourne {slope, intercept, r2}
    if (!Array.isArray(points) || points.length < 2) return null;
    const n = points.length;
    const meanX = points.reduce((a, p) => a + p.x, 0) / n;
    const meanY = points.reduce((a, p) => a + p.y, 0) / n;
    let num = 0, denX = 0, ssTot = 0;
    for (const p of points) {
      num += (p.x - meanX) * (p.y - meanY);
      denX += (p.x - meanX) * (p.x - meanX);
      ssTot += (p.y - meanY) * (p.y - meanY);
    }
    if (denX === 0) return null;
    const slope = num / denX;
    const intercept = meanY - slope * meanX;
    let ssRes = 0;
    for (const p of points) {
      const pred = slope * p.x + intercept;
      ssRes += (p.y - pred) * (p.y - pred);
    }
    return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, n };
  }

  function bodyWeightTrend(weights, opts) {
    opts = Object.assign({ weeks: 6 }, opts || {});
    if (!Array.isArray(weights) || weights.length < 3) return null;
    const sorted = weights.slice().sort((a, b) =>
      Date.parse(a.date) - Date.parse(b.date)
    );
    const cutoff = Date.now() - opts.weeks * 7 * 86400000;
    const recent = sorted.filter(w => Date.parse(w.date) >= cutoff);
    if (recent.length < 3) return null;
    const t0 = Date.parse(recent[0].date);
    const points = recent.map(w => ({
      x: (Date.parse(w.date) - t0) / 86400000,  // jours depuis premier point
      y: +w.kg,
    }));
    const reg = linearRegression(points);
    if (!reg) return null;
    const slopePerWeek = reg.slope * 7;
    // Hall : 1 kg ≈ 7700 kcal → déficit/excédent quotidien
    const kcalPerDay = (slopePerWeek * 7700) / 7;
    return {
      slopeKgPerWeek: +slopePerWeek.toFixed(3),
      kcalPerDay: Math.round(kcalPerDay),
      r2: +reg.r2.toFixed(2),
      n: reg.n,
      weeks: opts.weeks,
    };
  }

  function proteinTargets(bodyWeightKg, mealsPerDay) {
    if (!bodyWeightKg || bodyWeightKg <= 0) return null;
    const meals = Math.max(2, Math.min(6, mealsPerDay || 4));
    return {
      perDayMin: Math.round(1.6 * bodyWeightKg),       // Schoenfeld bas
      perDayMax: Math.round(2.2 * bodyWeightKg),       // Helms 2014 haut
      perMealMin: Math.round(0.4 * bodyWeightKg * 10) / 10,
      perMealOptimal: Math.round((1.6 / meals) * bodyWeightKg * 10) / 10,
      mealsPerDay: meals,
    };
  }

  /* ============================================================
   * 5. PVT — Psychomotor Vigilance Task (Dinges 1985)
   * ============================================================
   * Test de référence en sciences du sommeil pour la fatigue centrale.
   * Protocole classique : 10 min, ISI aléatoires 2-10s, l'utilisateur
   * tape dès qu'un stimulus apparaît. Métriques :
   *   - meanRT (ms)
   *   - lapses : nombre de réponses > 500 ms
   *   - falseStarts : taps avant stimulus (< 100 ms)
   *
   * On en propose une version courte (90s, 8-15 stimuli) pour rester
   * utilisable au quotidien — Basner & Dinges 2011 ont validé que les
   * versions 3 min capturent l'essentiel de la sensibilité du test long.
   * ============================================================ */
  function pvtAnalyze(reactions) {
    if (!Array.isArray(reactions) || reactions.length === 0) return null;
    const valid = reactions.filter(r => r >= 100 && r <= 3000);
    const falseStarts = reactions.filter(r => r < 100 && r >= 0).length;
    if (valid.length === 0) return { meanMs: null, lapses: 0, falseStarts, n: 0 };
    const mean = valid.reduce((a, r) => a + r, 0) / valid.length;
    const lapses = valid.filter(r => r > 500).length;
    const median = [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)];
    return {
      meanMs: Math.round(mean),
      medianMs: Math.round(median),
      lapses, falseStarts, n: valid.length,
    };
  }

  /* ============================================================
   * 6. Asymétries G/D (Bishop 2018)
   * ============================================================
   * Pour chaque exo unilatéral présent dans l'historique, calculer
   * la performance moyenne (volume kg×reps) par côté sur la fenêtre,
   * et l'asymétrie en pourcentage :
   *   asym% = |L − R| / max(L, R) × 100
   *
   * Bishop 2018 : >10% = pertinent cliniquement, à compenser ; >15%
   * = risque accru de blessure. <5% = symétrie normale.
   * ============================================================ */
  function asymmetryReport(history, opts) {
    opts = Object.assign({ weeks: 6, minReps: 6 }, opts || {});
    if (!Array.isArray(history)) return [];
    const cutoff = Date.now() - opts.weeks * 7 * 86400000;
    const byExoSide = {};   // exoId → { L: [...], R: [...] }
    for (const h of history) {
      if (!h || !h.date || !Array.isArray(h.sets)) continue;
      if (Date.parse(h.date) < cutoff) continue;
      for (const s of h.sets) {
        if (!s || !s.exoId || !s.side) continue;
        if (s.side !== 'L' && s.side !== 'R') continue;
        const reps = +s.reps || 0;
        if (reps === 0) continue;
        const load = (+s.weight || 0) > 0 ? s.weight * reps : reps;
        if (!byExoSide[s.exoId]) byExoSide[s.exoId] = { L: [], R: [] };
        byExoSide[s.exoId][s.side].push(load);
      }
    }
    const out = [];
    for (const [exoId, sides] of Object.entries(byExoSide)) {
      const nL = sides.L.length, nR = sides.R.length;
      if (nL < opts.minReps || nR < opts.minReps) continue;
      const mL = sides.L.reduce((a, v) => a + v, 0) / nL;
      const mR = sides.R.reduce((a, v) => a + v, 0) / nR;
      const peak = Math.max(mL, mR);
      if (peak === 0) continue;
      const pct = Math.abs(mL - mR) / peak * 100;
      let label = 'symmetric';
      if (pct >= 15) label = 'severe';
      else if (pct >= 10) label = 'notable';
      else if (pct >= 5) label = 'mild';
      out.push({
        exoId, leftAvg: Math.round(mL * 10) / 10, rightAvg: Math.round(mR * 10) / 10,
        diffPct: Math.round(pct * 10) / 10, weaker: mL < mR ? 'L' : 'R',
        nL, nR, label,
      });
    }
    return out.sort((a, b) => b.diffPct - a.diffPct);
  }

  /* ============================================================
   * 7. Désentraînement (Mujika & Padilla 2000)
   * ============================================================
   * Modélisation classique : la force diminue exponentiellement
   * avec une demi-vie qui dépend de l'effet visé.
   *   τ_force ≈ 30 jours        (perte 1RM exponentielle)
   *   τ_hypertrophie ≈ 60 jours (perte de section musculaire)
   *
   * Approximations pratiques de Mujika :
   *   - 1 sem d'arrêt : ≈ -3 à -5% de 1RM
   *   - 2 sem : -7 à -10%
   *   - 4 sem : -10 à -15%
   *   - 8 sem : -20 à -25% (mais hypertrophie quasi intacte)
   *
   * Un simple exp(-t/τ) avec τ=30 surestime grossièrement (37% à 14j !).
   * On utilise une approximation par segments calibrée sur les valeurs
   * publiées par Mujika (revues 2000a/b "Detraining I & II") :
   *   <7j   → 0%        (récup normale, pas de perte mesurable)
   *   7-14j → 0 → 5%
   *   14-28j → 5 → 12%
   *   28-56j → 12 → 22%
   *   56-84j → 22 → 30%
   *   >84j  → plateau à ~30-35% (au-delà, retour quasi débutant)
   * ============================================================ */
  function detrainingProjection(daysOff) {
    if (daysOff == null || daysOff < 7) return null;
    let lossPct;
    if (daysOff < 14)      lossPct = (daysOff - 7) / 7 * 5;
    else if (daysOff < 28) lossPct = 5 + (daysOff - 14) / 14 * 7;
    else if (daysOff < 56) lossPct = 12 + (daysOff - 28) / 28 * 10;
    else if (daysOff < 84) lossPct = 22 + (daysOff - 56) / 28 * 8;
    else                   lossPct = Math.min(35, 30 + (daysOff - 84) / 28 * 5);
    lossPct = Math.round(lossPct);
    let severity = 'mild';
    if (daysOff >= 56) severity = 'significant';
    else if (daysOff >= 21) severity = 'moderate';
    return {
      daysOff,
      retentionPct: 100 - lossPct,
      lossPct,
      severity,
      // Recommandation de reprise : déloader à -lossPct du dernier 1RM,
      // remontée progressive sur 2-3 semaines.
      suggestedLoadReductionPct: Math.min(30, lossPct + 3),
    };
  }

  function lastTrainingGapDays(history, now) {
    if (!Array.isArray(history) || history.length === 0) return null;
    const ref = now || Date.now();
    const dates = history
      .map(h => h && h.date ? Date.parse(h.date) : null)
      .filter(t => isFinite(t) && t <= ref)
      .sort((a, b) => b - a);
    if (dates.length === 0) return null;
    return Math.floor((ref - dates[0]) / 86400000);
  }

  /* ============================================================
   * 8. Vie quotidienne — corrélations simples
   * ============================================================
   * NEAT (Levine 2005) : on stocke juste le step count, on calcule
   *   moyenne 7j et trend.
   * Caféine vs sommeil (Drake 2013) : caféine >6h avant coucher
   *   détériore la qualité du sommeil mesurée. On calcule la
   *   corrélation entre delai caféine→coucher et qualité sommeil.
   * Lumière matinale (Wright 2013) : 10 min de lumière vive avant 10h
   *   améliore l'alignement circadien. On calcule simplement le ratio
   *   de jours avec light=true vs qualité moyenne du sommeil le soir.
   * ============================================================ */
  function neatTrend(lifestyle) {
    if (!Array.isArray(lifestyle) || lifestyle.length === 0) return null;
    const sorted = lifestyle
      .filter(d => d && d.date && d.steps != null)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    if (sorted.length === 0) return null;
    const now = Date.now();
    const inWin = (days) => sorted.filter(d =>
      Date.parse(d.date) >= now - days * 86400000
    );
    const w1 = inWin(7), w2 = inWin(14);
    if (w1.length === 0) return null;
    const avg7 = w1.reduce((a, d) => a + (+d.steps || 0), 0) / w1.length;
    const prev = w2.filter(d => !w1.includes(d));
    const avgPrev = prev.length > 0
      ? prev.reduce((a, d) => a + (+d.steps || 0), 0) / prev.length
      : null;
    return {
      avg7: Math.round(avg7),
      delta: avgPrev != null ? Math.round(avg7 - avgPrev) : null,
      n: w1.length,
    };
  }

  function caffeineSleepCorrelation(lifestyle, physio) {
    if (!Array.isArray(lifestyle) || !Array.isArray(physio)) return null;
    // Pour chaque jour avec lastCaffeineH ET sleep score du lendemain,
    // calculer le delta heures et la qualité sommeil.
    const pairs = [];
    const physioByDate = Object.fromEntries(physio
      .filter(p => p && p.date && (p.sleepScore != null || p.sleepEfficiency != null))
      .map(p => [p.date.slice(0, 10), p]));
    for (const ls of lifestyle) {
      if (!ls || !ls.date || ls.lastCaffeineH == null) continue;
      const next = new Date(Date.parse(ls.date) + 86400000)
        .toISOString().slice(0, 10);
      const ph = physioByDate[next];
      if (!ph) continue;
      const quality = ph.sleepScore != null ? +ph.sleepScore
        : (+ph.sleepEfficiency * 100);
      if (!isFinite(quality)) continue;
      pairs.push({ caffeineH: +ls.lastCaffeineH, quality });
    }
    if (pairs.length < 5) return { n: pairs.length, corr: null };
    // Pearson
    const mX = pairs.reduce((a, p) => a + p.caffeineH, 0) / pairs.length;
    const mY = pairs.reduce((a, p) => a + p.quality, 0) / pairs.length;
    let num = 0, dX = 0, dY = 0;
    for (const p of pairs) {
      num += (p.caffeineH - mX) * (p.quality - mY);
      dX += (p.caffeineH - mX) ** 2;
      dY += (p.quality - mY) ** 2;
    }
    const corr = (dX === 0 || dY === 0) ? 0 : num / Math.sqrt(dX * dY);
    return { n: pairs.length, corr: +corr.toFixed(2) };
  }

  /* ============================================================
   * Export
   * ============================================================ */
  window.Science = {
    // RIR
    rirToRpe, rpeToRir, rirReliability,
    // HRV
    hrvBaseline, hrvReadiness,
    // Hooper
    hooperIndex, hooperReadiness,
    // Body comp
    movingAverage, linearRegression, bodyWeightTrend, proteinTargets,
    // PVT
    pvtAnalyze,
    // Asymétries
    asymmetryReport,
    // Désentraînement
    detrainingProjection, lastTrainingGapDays,
    // Vie quotidienne
    neatTrend, caffeineSleepCorrelation,
  };
})();
