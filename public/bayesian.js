/* =============================================================
 * Coach Adaptatif — Niveau 3 : modélisation bayésienne du 1RM
 * =============================================================
 *
 * Filtre de Kalman 2D (local linear trend) par exercice. État caché :
 *   x = [μ, β]  où μ = 1RM réel courant, β = pente d'évolution (kg/jour).
 *
 *   Évolution : x_{t+1} = F_dt · x_t + bruit_processus
 *               F_dt = [[1, dt], [0, 1]]
 *               bruit ~ N(0, Q·dt)
 *
 *   Observation : y_t = μ_t + bruit_observation
 *                 H = [1, 0]
 *                 bruit ~ N(0, R) ; R dépend de reps + RPE.
 *
 * Pourquoi 2D plutôt que 1D : le filtre 1D donne juste la moyenne courante
 * mais ne forecaste rien. En modélisant la pente comme état caché on récupère
 * gratuitement une trajectoire prévisionnelle avec intervalle de confiance
 * qui s'élargit avec le temps — exactement ce qu'on veut pour "à ce rythme,
 * tu atteindras X kg dans Y jours".
 *
 * Aucune dépendance — module pur. Lit window.EX_BY_ID en best-effort pour
 * filtrer les exos non-pondérés (timed, gainage, etc.).
 * ============================================================= */
(function () {
  'use strict';

  /* -----------------------------------------------------------
   * Bruit de processus (Q) — variances par jour.
   * ----------------------------------------------------------- */
  // Q_μ : combien le 1RM réel peut bouger aléatoirement par jour, hors
  // tendance. Pour un trainee normal, ~0.3 kg/jour de variation autour
  // de la tendance (sommeil, fatigue, calibration neurale). σ²=0.09.
  const Q_MU = 0.09;
  // Q_β : combien la pente peut elle-même évoluer par jour. Très petit
  // pour ne pas laisser le filtre "courir derrière" du bruit. Une pente
  // change de quelques centièmes de kg/jour par mois.
  const Q_BETA = 0.0001;

  /* -----------------------------------------------------------
   * Bruit d'observation (R) — variance de l'estimation Epley.
   * Plus on s'éloigne du max effort (1RM), plus l'estimation est bruitée.
   * Données empiriques (Mayhew, Epley, Lombardi cross-validation) :
   *   Reps 1-3, RPE 9-10 : σ ≈ 1.5 kg → R = 2.25
   *   Reps 4-6, RPE 8-9  : σ ≈ 2.5 kg → R = 6.25
   *   Reps 7-10          : σ ≈ 4 kg   → R = 16
   *   Reps 10+ ou RPE<7  : σ ≈ 7 kg   → R = 49
   * RPE bas réduit aussi la fiabilité (le user pouvait faire plus → biais
   * vers le bas).
   * ----------------------------------------------------------- */
  function observationVariance(reps, rpe) {
    if (!isFinite(reps) || reps < 1) return 100;
    let R;
    if (reps <= 3) R = 2.25;
    else if (reps <= 6) R = 6.25;
    else if (reps <= 10) R = 16;
    else R = 49;
    // RPE bas → variance plus élevée. Si pas de RPE, on assume 8 (conservateur).
    const r = isFinite(rpe) ? rpe : 8;
    if (r < 7) R *= 2.5;
    else if (r < 8) R *= 1.5;
    return R;
  }

  /* -----------------------------------------------------------
   * Estimation Epley ajustée par RPE.
   * Si RPE < 10, le user pouvait faire plus de reps. On approxime :
   *   reps_to_failure ≈ reps + (10 - RPE)
   * Limite à 10 (cap de la formule Epley pour rester fiable).
   * ----------------------------------------------------------- */
  function epleyAdjusted(weight, reps, rpe) {
    const w = +weight, r = +reps;
    if (!isFinite(w) || w <= 0 || !isFinite(r) || r < 1) return null;
    const rpeVal = isFinite(rpe) ? rpe : 8;
    const repsToFail = Math.min(10, r + Math.max(0, 10 - rpeVal));
    return w * (1 + repsToFail / 30);
  }

  /* -----------------------------------------------------------
   * Pas de prédiction et de mise à jour.
   * State : { mu, beta, Pmu, Pmb, Pb, lastT }
   *   Pmu = Var(μ), Pb = Var(β), Pmb = Cov(μ,β)
   * ----------------------------------------------------------- */
  function predict(state, dtDays, qScale) {
    if (dtDays <= 0) dtDays = 0;
    // qScale (default 1.0) permet de moduler le bruit de processus selon
    // le type de réponse de l'utilisateur. Voir computeState() qui le
    // dérive de classifyResponder() de programming.js.
    const qs = (qScale != null) ? qScale : 1.0;
    const mu = state.mu + state.beta * dtDays;
    const beta = state.beta;
    // P_pred = F P F^T + Q·dt
    // F P : [[Pmu + dt*Pmb, Pmb + dt*Pb], [Pmb, Pb]]
    // F P F^T : [[(Pmu+dt*Pmb) + dt*(Pmb+dt*Pb), Pmb+dt*Pb], [Pmb+dt*Pb, Pb]]
    const Pmu = state.Pmu + 2 * dtDays * state.Pmb + dtDays * dtDays * state.Pb + Q_MU * qs * dtDays;
    const Pmb = state.Pmb + dtDays * state.Pb;
    const Pb = state.Pb + Q_BETA * qs * dtDays;
    return { mu, beta, Pmu, Pmb, Pb, lastT: state.lastT };
  }

  // K_HUBER : seuil au-delà duquel on considère qu'une observation est
  // "trop éloignée" et on inflate son R (M-estimateur de Huber). À 2σ on
  // a 95% des innovations gaussiennes — au-delà c'est probablement un
  // outlier (PR exceptionnelle, fail, erreur de saisie).
  const K_HUBER = 2.0;

  function update(state, y, R) {
    // Robust Kalman update — version M-estimateur de Huber. Calcule d'abord
    // l'innovation standardisée z = (y - μ_pred) / sqrt(S). Si |z| dépasse
    // K_HUBER, on inflate R par (|z|/K_HUBER)² — équivalent à donner un
    // poids de Huber w = K_HUBER/|z|. Permet à une observation aberrante
    // de bouger μ un peu (mais pas beaucoup), tout en préservant la
    // mise à jour de la covariance pour les observations légitimes.
    //
    // Note : si plusieurs observations consécutives sont "outliers" dans
    // la même direction, le filtre rattrape progressivement (chaque update
    // bouge un peu l'estimation). C'est ce qu'on veut pour une vraie PR.
    let R_eff = R;
    const S0 = state.Pmu + R;
    if (S0 > 0) {
      const innov0 = y - state.mu;
      const z = innov0 / Math.sqrt(S0);
      if (Math.abs(z) > K_HUBER) {
        const factor = (Math.abs(z) / K_HUBER) * (Math.abs(z) / K_HUBER);
        R_eff = R * factor;
      }
    }
    const S = state.Pmu + R_eff;
    if (S <= 0) return state; // garde-fou numérique
    // K = P H^T / S = [Pmu/S, Pmb/S]
    const Kmu = state.Pmu / S;
    const Kb = state.Pmb / S;
    const innov = y - state.mu;
    const mu = state.mu + Kmu * innov;
    const beta = state.beta + Kb * innov;
    // P_new = (I - K H) P
    // I - KH = [[1-Kmu, 0], [-Kb, 1]]
    // (I-KH) P = [[(1-Kmu)Pmu, (1-Kmu)Pmb], [-Kb*Pmu+Pmb, -Kb*Pmb+Pb]]
    const Pmu = (1 - Kmu) * state.Pmu;
    const Pmb = (1 - Kmu) * state.Pmb;
    const Pb = -Kb * state.Pmb + state.Pb;
    return { mu, beta, Pmu, Pmb, Pb, lastT: state.lastT };
  }

  /* -----------------------------------------------------------
   * Initialisation : prior très large, le premier observé sert de seed.
   * ----------------------------------------------------------- */
  function initialState(firstY, t0) {
    return {
      mu: firstY,
      beta: 0,            // pas de tendance connue au départ
      Pmu: 25,            // σ=5kg sur le niveau au départ — modéré, pas faible
      Pmb: 0,
      Pb: 0.0025,         // σ_β=0.05 kg/jour ≈ ±5kg/mois — large par défaut
      lastT: t0,
    };
  }

  /* -----------------------------------------------------------
   * computeState — applique le filtre sur tout l'historique d'un exo.
   * Renvoie { mu, beta, Pmu, Pmb, Pb, n, lastDate } ou null si pas de
   * sets pondérés exploitables.
   * ----------------------------------------------------------- */
  // qScaleForResponder — multiplicateur du bruit de processus selon le type
  // de réponse classifié par programming.js. Le filtre devient plus
  // réactif (Q×2) pour un fast responder qui progresse vite, plus
  // conservateur (Q÷2) pour un slow responder en plateau.
  function qScaleForResponder(type) {
    switch (type) {
      case 'fast':       return 2.0;
      case 'moderate':   return 1.0;
      case 'slow':       return 0.5;
      case 'regressing': return 1.5;  // on garde de la flexibilité pour rattraper
      default:           return 1.0;
    }
  }

  function computeState(history, exoId, opts) {
    opts = opts || {};
    if (!Array.isArray(history)) return null;
    // qScale dérivé du responder si dispo. Permet d'adapter automatiquement
    // le filtre au profil de progression de l'utilisateur. Si programming.js
    // n'a pas assez de données pour classer, on retombe sur 1.0 (nominal).
    let qScale = opts.qScale != null ? opts.qScale : 1.0;
    if (opts.qScale == null && typeof window !== 'undefined' &&
        window.Programming && typeof window.Programming.classifyResponder === 'function') {
      // Propage opts.halfLifeDays au classify pour que le qScale dérive
      // de la même fenêtre temporelle que les autres modules.
      const r = window.Programming.classifyResponder(history,
        opts.halfLifeDays != null ? { halfLifeDays: opts.halfLifeDays } : {});
      if (r && r.type !== 'unknown') {
        qScale = qScaleForResponder(r.type);
      }
    }
    const obs = [];
    for (const h of history) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t)) continue;
      const rpe = h.rpe;
      for (const s of (h.sets || [])) {
        if (s.exoId !== exoId) continue;
        if (!s.weight || !s.reps) continue;
        const y = epleyAdjusted(s.weight, s.reps, rpe);
        if (y == null) continue;
        const R = observationVariance(s.reps, rpe);
        obs.push({ t, y, R });
      }
    }
    if (obs.length === 0) return null;
    obs.sort((a, b) => a.t - b.t);
    let state = initialState(obs[0].y, obs[0].t);
    state = update(state, obs[0].y, obs[0].R);  // premier update consume le seed
    for (let i = 1; i < obs.length; i++) {
      const dtDays = (obs[i].t - state.lastT) / 86400000;
      state = predict(state, dtDays, qScale);
      state = update(state, obs[i].y, obs[i].R);
      state.lastT = obs[i].t;
    }
    state.n = obs.length;
    state.lastDate = new Date(state.lastT).toISOString().slice(0, 10);
    state.qScale = qScale;
    // Cap la pente à un range raisonnable pour les forecasts : ±0.5 kg/jour.
    // Au-delà c'est presque certainement du bruit non absorbé par le filtre.
    state.betaClipped = Math.max(-0.5, Math.min(0.5, state.beta));
    return state;
  }

  // computeAllStates — pour tous les exos pondérés présents dans l'historique.
  function computeAllStates(history) {
    const seen = new Set();
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      for (const s of (h.sets || [])) {
        if (s.exoId && s.weight) seen.add(s.exoId);
      }
    }
    const out = {};
    seen.forEach(id => {
      const st = computeState(history, id);
      if (st) out[id] = st;
    });
    return out;
  }

  /* -----------------------------------------------------------
   * Intervalle de confiance courant.
   * ciLevel : 0.9 → ±1.645σ ; 0.95 → ±1.96σ ; 0.68 → ±1σ.
   * ----------------------------------------------------------- */
  const Z_FROM_CI = { 0.68: 1.0, 0.80: 1.282, 0.90: 1.645, 0.95: 1.960 };

  function current1RM(state, ciLevel) {
    if (!state) return null;
    const z = Z_FROM_CI[ciLevel || 0.9] || 1.645;
    const sigma = Math.sqrt(Math.max(0, state.Pmu));
    return {
      mu: state.mu,
      sigma,
      low: state.mu - z * sigma,
      high: state.mu + z * sigma,
      n: state.n,
    };
  }

  /* -----------------------------------------------------------
   * Forecast — projette daysAhead jours dans le futur.
   * ----------------------------------------------------------- */
  function forecast(state, daysAhead, ciLevel) {
    if (!state) return null;
    const z = Z_FROM_CI[ciLevel || 0.9] || 1.645;
    const dt = Math.max(0, daysAhead);
    const beta = state.betaClipped != null ? state.betaClipped : state.beta;
    const mu = state.mu + beta * dt;
    // Var(μ_t+dt) = Pmu + 2*dt*Pmb + dt²*Pb + Q_μ*dt
    const variance = state.Pmu + 2 * dt * state.Pmb + dt * dt * state.Pb + Q_MU * dt;
    const sigma = Math.sqrt(Math.max(0, variance));
    return {
      mu, sigma,
      low: mu - z * sigma,
      high: mu + z * sigma,
      daysAhead: dt,
    };
  }

  // forecastTrajectory — tableau de points pour graph SVG.
  // Entre 0 et daysAhead, par pas de stepDays.
  function forecastTrajectory(state, daysAhead, stepDays, ciLevel) {
    daysAhead = daysAhead || 90;
    stepDays = stepDays || 7;
    const out = [];
    for (let d = 0; d <= daysAhead; d += stepDays) {
      const f = forecast(state, d, ciLevel);
      if (f) out.push({ day: d, mu: f.mu, low: f.low, high: f.high });
    }
    return out;
  }

  /* -----------------------------------------------------------
   * Détection d'anomalie sur un set fraîchement loggé.
   * Compare l'observation aux prédictions du filtre AVANT cette obs.
   * Renvoie { isAnomaly, zScore, predicted, observed }.
   * Threshold : |z| > 2.5 → ~99e percentile.
   * ----------------------------------------------------------- */
  function detectAnomaly(set, history, exoId, threshold) {
    threshold = threshold || 2.5;
    if (!set || !set.weight || !set.reps) return { isAnomaly: false };
    // Recompute state SANS le set en question (on suppose que le set
    // courant n'est pas encore intégré à l'history, ou bien on l'exclut
    // par référence).
    const stateBefore = computeState(history, exoId);
    if (!stateBefore) return { isAnomaly: false }; // pas de baseline
    // Predict au moment T du set (dt depuis le dernier observé).
    const t = Date.parse(set.date || new Date().toISOString());
    const dt = Math.max(0, (t - stateBefore.lastT) / 86400000);
    const pred = predict(stateBefore, dt);
    const observed = epleyAdjusted(set.weight, set.reps, set.rpe || (history.slice(-1)[0] || {}).rpe);
    if (observed == null) return { isAnomaly: false };
    const R = observationVariance(set.reps, set.rpe);
    const variance = pred.Pmu + R;
    const sigma = Math.sqrt(Math.max(1, variance));
    const z = (observed - pred.mu) / sigma;
    return {
      isAnomaly: Math.abs(z) > threshold,
      zScore: z,
      predicted: pred.mu,
      predictedSigma: Math.sqrt(Math.max(0, pred.Pmu)),
      observed,
      direction: z > 0 ? 'high' : 'low',
    };
  }

  /* -----------------------------------------------------------
   * Détection de dérive lente — overtraining silencieux.
   * Complémentaire à detectAnomaly (qui vise les pics) : on regarde la
   * pente β du filtre. Si elle est significativement négative et que
   * l'incertitude sur la pente est faible (le filtre est "sûr" qu'il y
   * a régression), on flag.
   *
   * Critères :
   *   - β < -0.2 kg/sem (-0.029 kg/jour) — régression notable
   *   - |β| / σ_β > 1.5 — significatif statistiquement
   *   - state.n ≥ 8 — pas une fluctuation early-data
   *
   * Renvoie { drifting: bool, severity: 'mild'|'strong', betaPerWeek, advice }.
   * ----------------------------------------------------------- */
  function detectDrift(state) {
    if (!state || state.n < 8) return { drifting: false };
    const betaPerDay = state.betaClipped != null ? state.betaClipped : state.beta;
    const betaPerWeek = betaPerDay * 7;
    const sigmaBeta = Math.sqrt(Math.max(0, state.Pb));
    const sigmaBetaPerWeek = sigmaBeta * 7;
    if (betaPerWeek >= -0.2) return { drifting: false };
    const tStat = sigmaBetaPerWeek > 0 ? Math.abs(betaPerWeek) / sigmaBetaPerWeek : 0;
    // Deux critères de flag :
    //   (a) Statistiquement significatif : tStat ≥ 1.5 (résiste à 12+ obs propres)
    //   (b) Régression marquée : β < -0.4 kg/sem même si tStat plus bas
    //       (l'app préfère alerter sur une vraie régression visible que de
    //        rater le signal à cause d'un test statistique strict).
    const significantStat = tStat >= 1.5;
    const visiblyMarked = betaPerWeek < -0.4;
    if (!significantStat && !visiblyMarked) return { drifting: false };
    const severity = (betaPerWeek < -0.5 && (tStat >= 2.0 || state.n >= 16))
      ? 'strong' : 'mild';
    return {
      drifting: true,
      severity,
      betaPerWeek: +betaPerWeek.toFixed(2),
      tStat: +tStat.toFixed(1),
      advice: severity === 'strong'
        ? "Régression marquée. Une semaine de deload + sommeil + nutrition correcte avant de reprendre, idéalement après un check-up si tu sens d'autres signaux (sommeil, motivation, douleurs)."
        : "Tendance à la baisse. Vérifie sommeil, stress, charge de travail. Une semaine plus light peut suffire à inverser.",
    };
  }

  /* -----------------------------------------------------------
   * EXPORT
   * ----------------------------------------------------------- */
  window.Bayesian = {
    Q_MU, Q_BETA,
    observationVariance,
    epleyAdjusted,
    predict, update,
    initialState,
    computeState, computeAllStates,
    current1RM,
    forecast, forecastTrajectory,
    detectAnomaly,
    detectDrift,
    qScaleForResponder,
  };
})();
