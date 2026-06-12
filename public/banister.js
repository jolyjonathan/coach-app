/* =============================================================
 * Coach Adaptatif — Niveau 4 : modèle Banister fitness-fatigue
 * =============================================================
 *
 * Le modèle Banister (1975) est le standard en science du sport pour
 * quantifier l'équilibre entre forme (fitness, accumulée lentement) et
 * fatigue (accumulée rapidement). On utilise la formulation moderne
 * popularisée par TrainingPeaks (CTL/ATL/TSB) :
 *
 *   CTL(t) = EWMA_42j de la charge quotidienne   ← Fitness à long terme
 *   ATL(t) = EWMA_7j  de la charge quotidienne   ← Fatigue à court terme
 *   TSB(t) = CTL(t) - ATL(t)                     ← Training Stress Balance
 *
 * Interprétation du TSB :
 *   TSB > +25 : tapered, prêt pour un peak
 *   TSB ≈ +5 à +15 : frais
 *   TSB ≈ -5 à -15 : zone d'entraînement productive
 *   TSB < -20 : surcharge, recommandation repos
 *
 * En complément, si l'utilisateur a fourni des données physiologiques
 * (HRV, sommeil, fréquence cardiaque au repos), on calcule un score
 * `readiness` composite qui blend les signaux objectifs avec le formScore
 * déclaratif. Substituable au formScore brut dans modFromForm.
 *
 * Aucune dépendance — module pur. Compatible avec les sessions normales,
 * snacks (pondérés à 50%), et activités externes (durée + RPE déclaré).
 * ============================================================= */
(function () {
  'use strict';

  // Constantes Banister classiques — utilisées comme défaut tant que la
  // calibration par utilisateur (voir calibrateTaus plus bas) n'a pas
  // assez de données ou n'améliore pas significativement le fit.
  const TAU_FITNESS = 42; // jours — décroissance lente du fitness
  const TAU_FATIGUE = 7;  // jours — décroissance rapide de la fatigue

  /* -----------------------------------------------------------
   * Calcul de la charge d'une session (sRPE × volume).
   * Méthode session-RPE de Foster (1998), adaptée à notre modèle.
   *
   * Audit F1 — UNIFICATION DES ÉCHELLES. Avant, la muscu utilisait
   * `sets × RPE` (séance type 5 sets RPE 7 → 35) tandis que les séances
   * externes utilisaient le sRPE brut de Foster `durationMin × RPE`
   * (footing 30 min RPE 7 → 210). Soit un facteur ~6× en faveur du cardio
   * dans le MÊME CTL/ATL/TSB : dès qu'un utilisateur loggait des activités
   * externes (ou des imports Strava), sa charge était dominée par le cardio
   * et le TSB devenait illisible.
   *
   * On ramène donc le sRPE des séances externes à l'échelle muscu en
   * divisant par EXTERNAL_SCALE. Calibration : une séance de musculation
   * « moyenne » (≈ 5 sets, RPE 7 ≈ 20 min effectives) vaut 35 ; un footing
   * de 30 min au même RPE 7 donne 30×7/6 = 35. Les deux types contribuent
   * désormais de façon comparable à la charge interne.
   *
   * Snacks (≤ 15 min) : pondérés à 50% — c'est de l'activité, pas de
   *   l'entraînement structuré.
   * Sessions sans RPE : assume RPE 7 (par défaut Foster).
   * ----------------------------------------------------------- */
  // Diviseur qui aligne le sRPE Foster (durée×RPE) des activités externes sur
  // l'échelle des séances de musculation (sets×RPE). Voir le commentaire ci-dessus.
  const EXTERNAL_SCALE = 6;

  // cardioLoad — charge d'une activité cardio sur l'échelle muscu unifiée,
  // par ordre de fiabilité décroissant des données disponibles :
  //   1. kcal (énergie active) : mesure intégrée du travail. ~7 kcal = 1 pt
  //      de charge (calibré pour qu'un footing de 30 min ≈ 300 kcal ≈ 43,
  //      du même ordre qu'une séance muscu moyenne ≈ 35).
  //   2. TRIMP de Banister via FC : durée × HRr × 0.64·e^(1.92·HRr), où
  //      HRr = (avgHR − hrRest)/(hrMax − hrRest) est la fraction de réserve
  //      cardiaque. Ramené à l'échelle muscu par /TRIMP_SCALE.
  //   3. sRPE Foster (durée × RPE) / EXTERNAL_SCALE — fallback historique.
  // Renvoie un nombre ≥ 0. opts : {durationMin, kcal, avgHR, hrRest, hrMax, rpe}.
  const KCAL_PER_LOAD = 7;   // 7 kcal ≈ 1 point de charge interne
  const TRIMP_SCALE = 4;     // ramène le TRIMP Banister sur l'échelle muscu
  function cardioLoad(opts) {
    opts = opts || {};
    const dur = +opts.durationMin || 30;
    const kcal = +opts.kcal;
    if (isFinite(kcal) && kcal > 0) {
      return kcal / KCAL_PER_LOAD;
    }
    const avgHR = +opts.avgHR;
    const hrRest = +opts.hrRest || 60;
    const hrMax = +opts.hrMax || 190;
    if (isFinite(avgHR) && avgHR > hrRest && hrMax > hrRest) {
      const hrr = Math.max(0, Math.min(1, (avgHR - hrRest) / (hrMax - hrRest)));
      const trimp = dur * hrr * 0.64 * Math.exp(1.92 * hrr); // Banister TRIMP
      return trimp / TRIMP_SCALE;
    }
    const rpe = +opts.rpe || 7;
    return (dur * rpe) / EXTERNAL_SCALE; // sRPE Foster
  }

  function sessionLoad(h) {
    if (!h || !h.date) return 0;
    if (h.kind === 'external') {
      // Audit produit : si l'activité externe porte des données physio
      // (kcal / FC moyenne — typiquement issues d'un import Strava ou d'un
      // wearable), on calcule une charge cardio réelle plutôt que le sRPE
      // approximé. Rétro-compatible : sans ces champs, retombe sur Foster.
      return cardioLoad({
        durationMin: h.durationMin,
        kcal: h.kcal != null ? h.kcal : h.activeEnergy,
        avgHR: h.avgHR,
        hrRest: h.hrRest,
        hrMax: h.hrMax,
        rpe: h.rpe,
      });
    }
    if (h.kind === 'snack') {
      const sets = (h.sets || []).length || 4;
      const rpe = +h.rpe || 6;
      return (sets * rpe) * 0.5; // demi-charge — activité légère
    }
    const sets = (h.sets || []).length;
    if (sets === 0) return 0;
    const rpe = +h.rpe || 7;
    return sets * rpe;
  }

  /* -----------------------------------------------------------
   * EWMA : moyenne mobile exponentiellement pondérée.
   * loadFn permet d'extraire la charge d'un h record (typiquement
   * sessionLoad). atTime = milliseconds since epoch (Date.now() par
   * défaut). tau = constante de temps en jours.
   *
   * La normalisation /tau ramène le résultat à l'échelle "charge moyenne
   * quotidienne" — convention TrainingPeaks/CTL.
   * ----------------------------------------------------------- */
  function ewma(history, atTime, tau, loadFn) {
    atTime = atTime || Date.now();
    let sum = 0;
    for (const h of (history || [])) {
      const t = Date.parse(h.date || '');
      if (!isFinite(t) || t > atTime) continue;
      const ageDays = (atTime - t) / 86400000;
      sum += loadFn(h) * Math.exp(-ageDays / tau);
    }
    return sum / tau;
  }

  function fitness(history, atTime) {
    return ewma(history, atTime, TAU_FITNESS, sessionLoad);
  }

  function fatigue(history, atTime) {
    return ewma(history, atTime, TAU_FATIGUE, sessionLoad);
  }

  function form(history, atTime) {
    return fitness(history, atTime) - fatigue(history, atTime);
  }

  /* =============================================================
   * Calibration des constantes de temps PAR UTILISATEUR.
   *
   * Banister (1975) a publié τ_fitness=42j / τ_fatigue=7j comme moyennes de
   * groupe, mais la littérature de modélisation impulse-réponse (Busso 1997,
   * Hellard 2006) montre une variabilité inter-individuelle large. Idée :
   * la performance observée (1RM estimé par Epley, standardisé par exercice)
   * devrait corréler positivement avec le TSB du jour — on cherche donc le
   * couple (τf, τa) qui maximise cette corrélation sur l'historique.
   *
   * Garde-fous (philosophie : pas de sur-ajustement vendu comme science) :
   *   - minimum 20 jours de performance distincts sur ≥ 6 semaines ;
   *   - la corrélation du meilleur couple doit dépasser celle du défaut
   *     42/7 d'au moins 0.05, ET être > 0.15 en absolu — sinon on garde
   *     le défaut et calibrated=false ;
   *   - grille bornée à des valeurs physiologiquement plausibles.
   *
   * Mémoïsé sur (longueur de l'historique, date du dernier item) — le grid
   * search ne tourne qu'une fois par changement d'historique.
   * ============================================================= */
  const TAU_F_GRID = [28, 35, 42, 49, 56];
  const TAU_A_GRID = [4, 5, 6, 7, 9, 11];

  // perfDays — série {t, z} : pour chaque jour avec ≥1 set pondéré, le
  // meilleur z-score Epley du jour (standardisation PAR exercice pour
  // pouvoir mélanger développé couché et squat dans la même série).
  function perfDays(history) {
    const byExo = {}; // exoId → [{t, e}]
    for (const h of (history || [])) {
      if (!h || h.kind === 'snack' || h.kind === 'external') continue;
      const t = Date.parse(h.date || '');
      if (!isFinite(t)) continue;
      for (const s of (h.sets || [])) {
        if (!s || !s.exoId || !s.weight || !s.reps) continue;
        const e = (+s.weight) * (1 + Math.min(10, +s.reps) / 30); // Epley
        if (!isFinite(e) || e <= 0) continue;
        (byExo[s.exoId] = byExo[s.exoId] || []).push({ t, e });
      }
    }
    const byDay = {}; // dayKey → best z
    for (const exoId in byExo) {
      const obs = byExo[exoId];
      if (obs.length < 8) continue; // trop peu pour standardiser
      const mean = obs.reduce((s, o) => s + o.e, 0) / obs.length;
      const sd = Math.sqrt(obs.reduce((s, o) => s + (o.e - mean) * (o.e - mean), 0) / obs.length);
      if (!(sd > 0)) continue;
      for (const o of obs) {
        const day = Math.floor(o.t / 86400000);
        const z = (o.e - mean) / sd;
        if (byDay[day] == null || z > byDay[day].z) {
          byDay[day] = { t: o.t, z };
        }
      }
    }
    return Object.values(byDay).sort((a, b) => a.t - b.t);
  }

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return 0;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) * (xs[i] - mx);
      dy += (ys[i] - my) * (ys[i] - my);
    }
    const den = Math.sqrt(dx * dy);
    return den > 0 ? num / den : 0;
  }

  // tsbWith — TSB à l'instant t avec des τ arbitraires (scan unique).
  function tsbWith(history, atTime, tauF, tauA) {
    let sumF = 0, sumA = 0;
    for (const h of (history || [])) {
      const t = Date.parse(h.date || '');
      if (!isFinite(t) || t > atTime) continue;
      const ageDays = (atTime - t) / 86400000;
      const L = sessionLoad(h);
      sumF += L * Math.exp(-ageDays / tauF);
      sumA += L * Math.exp(-ageDays / tauA);
    }
    return sumF / tauF - sumA / tauA;
  }

  function calibrateTaus(history) {
    const days = perfDays(history);
    const fallback = {
      tauFitness: TAU_FITNESS, tauFatigue: TAU_FATIGUE,
      calibrated: false, n: days.length, r: null, rDefault: null,
    };
    if (days.length < 20) return fallback;
    const spanDays = (days[days.length - 1].t - days[0].t) / 86400000;
    if (spanDays < 42) return fallback;

    const zs = days.map(d => d.z);
    let best = null;
    let rDefault = 0;
    for (const tf of TAU_F_GRID) {
      for (const ta of TAU_A_GRID) {
        if (ta >= tf) continue; // la fatigue décroît toujours plus vite
        const tsbs = days.map(d => tsbWith(history, d.t, tf, ta));
        const r = pearson(tsbs, zs);
        if (tf === TAU_FITNESS && ta === TAU_FATIGUE) rDefault = r;
        if (!best || r > best.r) best = { tauFitness: tf, tauFatigue: ta, r };
      }
    }
    if (!best || best.r < 0.15 || best.r - rDefault < 0.05) {
      return { ...fallback, r: rDefault, rDefault };
    }
    return {
      tauFitness: best.tauFitness, tauFatigue: best.tauFatigue,
      calibrated: true, n: days.length,
      r: +best.r.toFixed(2), rDefault: +rDefault.toFixed(2),
    };
  }

  // Mémoïsation : clé = (longueur, date du dernier item). Suffisant — un
  // historique append-only change l'un des deux à chaque séance.
  let _calibCache = null;
  function getCalibration(history) {
    const h = history || [];
    const key = h.length + '|' + (h.length ? (h[h.length - 1].date || '') : '');
    if (_calibCache && _calibCache.key === key) return _calibCache.value;
    const value = calibrateTaus(h);
    _calibCache = { key, value };
    return value;
  }

  // computeAll — un seul scan de l'history pour avoir CTL/ATL/TSB.
  // Plus économe que 3 appels séparés sur de gros historiques.
  //
  // opts.taus : {tauFitness, tauFatigue} pour forcer des constantes.
  // Par défaut, utilise la calibration par utilisateur si elle est
  // disponible et significative (getCalibration, mémoïsé) — la science
  // s'adapte en arrière-plan, l'appelant n'a rien à faire.
  function computeAll(history, atTime, opts) {
    atTime = atTime || Date.now();
    const taus = (opts && opts.taus) || getCalibration(history);
    const tauF = taus.tauFitness || TAU_FITNESS;
    const tauA = taus.tauFatigue || TAU_FATIGUE;
    let sumF = 0, sumA = 0;
    for (const h of (history || [])) {
      const t = Date.parse(h.date || '');
      if (!isFinite(t) || t > atTime) continue;
      const ageDays = (atTime - t) / 86400000;
      const L = sessionLoad(h);
      sumF += L * Math.exp(-ageDays / tauF);
      sumA += L * Math.exp(-ageDays / tauA);
    }
    const ctl = sumF / tauF;
    const atl = sumA / tauA;
    return { ctl, atl, tsb: ctl - atl };
  }

  /* -----------------------------------------------------------
   * Trajectoire pour graph — calcule (CTL, ATL, TSB) à intervalles
   * réguliers sur les daysBack derniers jours.
   * ----------------------------------------------------------- */
  function trajectory(history, daysBack, stepDays) {
    daysBack = daysBack || 42;
    stepDays = stepDays || 1;
    const now = Date.now();
    const out = [];
    for (let d = daysBack; d >= 0; d -= stepDays) {
      const t = now - d * 86400000;
      const r = computeAll(history, t);
      out.push({ daysAgo: d, t, ctl: r.ctl, atl: r.atl, tsb: r.tsb });
    }
    return out;
  }

  /* -----------------------------------------------------------
   * Recommandation textuelle basée sur le TSB.
   * Renvoie { level, label, advice } où level ∈ {peak, fresh, train,
   * fatigued, overload}.
   * ----------------------------------------------------------- */
  function recommendation(tsb) {
    if (!isFinite(tsb)) return { level: 'unknown', label: 'Indéterminé',
      advice: 'Pas assez de données pour évaluer ta charge.' };
    if (tsb > 25)  return { level: 'peak', label: 'Pic de forme',
      advice: 'TSB très positif — tu es tapéré, idéal pour un test 1RM ou une compétition. Mais ne reste pas trop longtemps ici, tu perds en fitness.' };
    if (tsb > 5)   return { level: 'fresh', label: 'Frais',
      advice: 'TSB positif — bonne récupération. Tu peux pousser l\'intensité aujourd\'hui.' };
    if (tsb > -10) return { level: 'train', label: 'Zone d\'entraînement',
      advice: 'TSB en zone productive. C\'est le meilleur compromis charge / récupération pour progresser.' };
    if (tsb > -20) return { level: 'fatigued', label: 'Fatigué',
      advice: 'TSB négatif marqué. Charge accumulée — séance allégée ou exo de qualité plutôt que volume.' };
    return { level: 'overload', label: 'Surcharge',
      advice: 'TSB très négatif — risque d\'overreaching. Prends une journée de repos ou une séance de mobilité légère.' };
  }

  /* =============================================================
   * Monotonie & strain — Foster (1998), le MÊME papier que le
   * session-RPE déjà utilisé pour la charge.
   *
   *   monotonie = moyenne(charge quotidienne 7j) / écart-type
   *   strain    = charge hebdo totale × monotonie
   *
   * Foster a montré que les pics de strain et la monotonie élevée
   * (entraînement identique tous les jours, pas de jours légers)
   * précèdent les infections et les épisodes d'overreaching. Une charge
   * hebdo identique répartie 35-35-35-35-35-35-35 est plus risquée que
   * 70-10-60-15-55-20-15 — c'est exactement ce que la monotonie capture.
   * ============================================================= */

  // dailyLoads — charges quotidiennes (somme) des `days` derniers jours,
  // zéros inclus. Index 0 = il y a (days-1) jours, dernier = aujourd'hui.
  function dailyLoads(history, atTime, days) {
    atTime = atTime || Date.now();
    const out = new Array(days).fill(0);
    const startDay = Math.floor(atTime / 86400000) - (days - 1);
    for (const h of (history || [])) {
      const t = Date.parse(h.date || '');
      if (!isFinite(t) || t > atTime) continue;
      const idx = Math.floor(t / 86400000) - startDay;
      if (idx < 0 || idx >= days) continue;
      out[idx] += sessionLoad(h);
    }
    return out;
  }

  function monotony(history, atTime) {
    const loads = dailyLoads(history, atTime, 7);
    const weeklyLoad = loads.reduce((s, v) => s + v, 0);
    if (weeklyLoad <= 0) return null; // semaine vide — rien à dire
    const mean = weeklyLoad / 7;
    const sd = Math.sqrt(loads.reduce((s, v) => s + (v - mean) * (v - mean), 0) / 7);
    // sd≈0 (charge identique tous les jours) → monotonie maximale. Cap à 5
    // pour rester affichable — au-delà la nuance n'apporte rien.
    const m = sd > 0 ? Math.min(5, mean / sd) : 5;
    const strain = weeklyLoad * m;
    let level = 'ok';
    if (m >= 2.0) level = 'high';        // seuil Foster classique
    else if (m >= 1.5) level = 'moderate';
    return {
      monotony: +m.toFixed(2),
      weeklyLoad: +weeklyLoad.toFixed(1),
      strain: +strain.toFixed(0),
      level,
      advice: level === 'high'
        ? 'Monotonie élevée (Foster 1998) : charge trop uniforme jour après jour. Alterne jours lourds et jours légers — même charge hebdo, risque moindre.'
        : level === 'moderate'
          ? 'Monotonie modérée. Garde au moins un vrai jour léger ou off par semaine.'
          : 'Bonne alternance jours lourds / légers.',
    };
  }

  /* =============================================================
   * ACWR — Acute:Chronic Workload Ratio (Gabbett 2016).
   *
   *   aiguë    = charge totale des 7 derniers jours
   *   chronique = charge hebdo moyenne des 28 derniers jours
   *
   * Zone « sweet spot » historique : 0.8–1.3. Au-delà de 1.5, sur-risque
   * de blessure rapporté dans plusieurs cohortes (rugby, cricket, foot).
   * HONNÊTETÉ SCIENTIFIQUE : la validité causale de l'ACWR est débattue
   * (Impellizzeri 2020 critique le couplage mathématique aigu/chronique).
   * On le présente comme un indicateur complémentaire au TSB, pas comme
   * une vérité — le champ `caveat` est destiné à l'UI.
   * ============================================================= */
  function acwr(history, atTime) {
    const loads = dailyLoads(history, atTime, 28);
    const chronicTotal = loads.reduce((s, v) => s + v, 0);
    if (chronicTotal <= 0) return null;
    const acute = loads.slice(21).reduce((s, v) => s + v, 0); // 7 derniers jours
    const chronicWeekly = chronicTotal / 4;
    if (chronicWeekly <= 0) return null;
    const ratio = acute / chronicWeekly;
    let zone, advice;
    if (ratio < 0.8) {
      zone = 'low';
      advice = 'Charge aiguë nettement sous ta moyenne — désentraînement possible si ça dure.';
    } else if (ratio <= 1.3) {
      zone = 'optimal';
      advice = 'Progression de charge dans la zone historique 0.8–1.3.';
    } else if (ratio <= 1.5) {
      zone = 'caution';
      advice = 'Montée de charge rapide — surveille les signaux (sommeil, douleurs, RPE qui dérive).';
    } else {
      zone = 'danger';
      advice = 'Pic de charge aiguë >1.5× ta moyenne — associé à un sur-risque de blessure dans plusieurs cohortes (Gabbett 2016). Lisse la montée.';
    }
    return {
      ratio: +ratio.toFixed(2),
      acute: +acute.toFixed(1),
      chronicWeekly: +chronicWeekly.toFixed(1),
      zone,
      advice,
      caveat: 'Indicateur débattu (Impellizzeri 2020) — à lire avec le TSB, pas à sa place.',
    };
  }

  /* =============================================================
   * bestTestWindow — « à charge nulle à partir d'aujourd'hui, quand
   * serai-je au mieux pour un test 1RM ? »
   *
   * On projette CTL/ATL/TSB vers l'avant SANS nouvelle séance : la fatigue
   * (τ court) fond plus vite que le fitness (τ long), donc le TSB remonte
   * puis le fitness s'érode. La fenêtre idéale = premier jour où le TSB
   * entre dans la zone fraîche (≥ +5), tant que le CTL n'a pas trop fondu.
   * C'est l'application directe du tapering façon Banister/TrainingPeaks.
   * ============================================================= */
  function bestTestWindow(history, daysAhead, atTime) {
    daysAhead = daysAhead || 14;
    atTime = atTime || Date.now();
    if (!history || history.length === 0) return null;
    const series = [];
    let bestDay = null;
    for (let d = 0; d <= daysAhead; d++) {
      const r = computeAll(history, atTime + d * 86400000);
      series.push({ day: d, ctl: +r.ctl.toFixed(1), tsb: +r.tsb.toFixed(1) });
      if (bestDay == null && r.tsb >= 5) bestDay = d;
    }
    if (bestDay == null) {
      return {
        series, bestDay: null,
        advice: 'TSB ne repasse pas en zone fraîche sous ' + daysAhead +
          ' jours sans entraînement — la fatigue accumulée est importante, vise d\'abord un deload.',
      };
    }
    const at = series[bestDay];
    return {
      series,
      bestDay,
      tsbAtBest: at.tsb,
      ctlAtBest: at.ctl,
      advice: bestDay === 0
        ? 'TSB déjà en zone fraîche — bonne fenêtre pour un test 1RM aujourd\'hui.'
        : 'En levant le pied, ta fenêtre de test 1RM s\'ouvre dans ~' + bestDay +
          ' jour' + (bestDay > 1 ? 's' : '') + ' (TSB projeté ' +
          (at.tsb >= 0 ? '+' : '') + at.tsb + ').',
    };
  }

  /* =============================================================
   * Données physiologiques (HRV, sommeil, FC repos)
   * ============================================================= */

  // baseline — moyenne sur les 28 derniers jours, exclut today.
  // Renvoie { mean, sd, n } ou null si trop peu de données.
  function baseline(physio, key, atTime) {
    atTime = atTime || Date.now();
    const cutoff = atTime - 29 * 86400000;
    const today = atTime - 1 * 86400000; // exclure today (souvent non encore loggé)
    const vals = [];
    for (const p of (physio || [])) {
      const t = Date.parse(p.date || '');
      if (!isFinite(t) || t < cutoff || t > today) continue;
      const v = +p[key];
      if (isFinite(v) && v > 0) vals.push(v);
    }
    if (vals.length < 5) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
    return { mean, sd: Math.sqrt(variance), n: vals.length };
  }

  // todayPhysio — dernière entrée physio dans les 2 derniers jours.
  // Renvoie l'objet physio ou null.
  function todayPhysio(physio, atTime) {
    atTime = atTime || Date.now();
    const minT = atTime - 2 * 86400000;
    let best = null;
    for (const p of (physio || [])) {
      const t = Date.parse(p.date || '');
      if (!isFinite(t) || t < minT || t > atTime) continue;
      if (!best || t > Date.parse(best.date)) best = p;
    }
    return best;
  }

  /* -----------------------------------------------------------
   * Composite readiness 0-100.
   * Démarre à 50, ajuste selon :
   *   - HRV : ±15 selon écart vs baseline (z-score capé à ±1.5)
   *   - RHR : ±15 (lower is better, signe inversé)
   *   - Sommeil : ±10 selon écart vs baseline
   *   - TSB : ±10 selon zone (peak +10, fresh +5, train 0, fatigued -5, overload -10)
   *   - formScore déclaratif : pondéré 0.3 si dispo
   * Capé [0, 100].
   *
   * Renvoie { score, breakdown: {hrv, rhr, sleep, tsb, declarative}, source }.
   * ----------------------------------------------------------- */
  // reliabilityWeight — pondère la contribution d'un signal physio par la
  // solidité de sa baseline. Avec n=5 points sur 28 jours, le z-score est
  // bruité ; à n=14+ il devient digne de confiance. Rampe linéaire :
  // n=5 → 0.1, n=14 → 1.0. Philosophie : un score honnête vaut mieux
  // qu'un score précis-en-apparence calculé sur trois mesures.
  function reliabilityWeight(b) {
    if (!b || !(b.n > 4)) return 0;
    return Math.min(1, (b.n - 4) / 10);
  }

  function readiness(history, physio, declaredFormScore, atTime) {
    atTime = atTime || Date.now();
    const today = todayPhysio(physio, atTime);
    let score = 50;
    const breakdown = { hrv: 0, rhr: 0, sleep: 0, tsb: 0, declarative: 0 };
    const weights = { hrv: 0, rhr: 0, sleep: 0 }; // fiabilité par canal, pour l'UI
    let usedPhysio = false;

    if (today) {
      // HRV : haut = mieux. Utilise z-score capé, pondéré par fiabilité.
      if (isFinite(+today.hrv) && +today.hrv > 0) {
        const b = baseline(physio, 'hrv', atTime);
        if (b && b.sd > 0) {
          const w = reliabilityWeight(b);
          const z = Math.max(-1.5, Math.min(1.5, (today.hrv - b.mean) / b.sd));
          breakdown.hrv = z * 10 * w; // ±15 max à pleine fiabilité
          weights.hrv = +w.toFixed(2);
          score += breakdown.hrv;
          usedPhysio = true;
        }
      }
      // RHR : bas = mieux (signe inversé).
      if (isFinite(+today.rhr) && +today.rhr > 0) {
        const b = baseline(physio, 'rhr', atTime);
        if (b && b.sd > 0) {
          const w = reliabilityWeight(b);
          const z = Math.max(-1.5, Math.min(1.5, (today.rhr - b.mean) / b.sd));
          breakdown.rhr = -z * 10 * w; // signe inversé
          weights.rhr = +w.toFixed(2);
          score += breakdown.rhr;
          usedPhysio = true;
        }
      }
      // Sommeil : haut = mieux.
      if (isFinite(+today.sleep) && +today.sleep > 0) {
        const b = baseline(physio, 'sleep', atTime);
        if (b && b.sd > 0) {
          const w = reliabilityWeight(b);
          const z = Math.max(-1.5, Math.min(1.5, (today.sleep - b.mean) / b.sd));
          breakdown.sleep = z * 7 * w; // ±10 max à pleine fiabilité
          weights.sleep = +w.toFixed(2);
          score += breakdown.sleep;
          usedPhysio = true;
        } else {
          // Pas de baseline — utilise un seuil absolu : <6h pénalité, >7.5 bonus.
          if (today.sleep < 6) { breakdown.sleep = -5; score -= 5; usedPhysio = true; }
          else if (today.sleep >= 7.5) { breakdown.sleep = 5; score += 5; usedPhysio = true; }
        }
      }
    }

    // TSB : bonus/malus selon zone (toujours appliqué si on a un historique).
    if (history && history.length > 0) {
      const all = computeAll(history, atTime);
      const rec = recommendation(all.tsb);
      const tsbAdj = { peak: 10, fresh: 5, train: 0, fatigued: -5, overload: -10, unknown: 0 }[rec.level] || 0;
      breakdown.tsb = tsbAdj;
      score += tsbAdj;
    }

    // formScore déclaratif : pondéré 0.3 (centré autour de 50). On
    // l'utilise dans tous les cas — il complète les signaux physio.
    if (isFinite(+declaredFormScore)) {
      const declAdj = (declaredFormScore - 50) * 0.3;
      breakdown.declarative = declAdj;
      score += declAdj;
    }

    score = Math.max(0, Math.min(100, score));
    return {
      score: +score.toFixed(1),
      breakdown,
      weights, // fiabilité 0-1 par canal physio (Audit amélioration #2)
      hasPhysio: usedPhysio,
      source: usedPhysio ? 'composite' : (isFinite(+declaredFormScore) ? 'declarative' : 'tsb-only'),
    };
  }

  /* -----------------------------------------------------------
   * Parsing CSV physio simple. Format attendu :
   *   date,hrv,sleep,rhr
   *   2026-04-15,52,7.3,58
   *   2026-04-16,48,6.8,60
   *
   * Tolère :
   *   - colonnes manquantes (vides → ignorées)
   *   - séparateur virgule ou point-virgule
   *   - première ligne header (auto-détectée)
   * ----------------------------------------------------------- */
  function parseCSV(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return [];
    const sep = lines[0].indexOf(';') >= 0 ? ';' : ',';
    // Auto-detect header : première cellule non parseable en Date → header.
    const firstCells = lines[0].split(sep);
    const headerLikely = isNaN(Date.parse(firstCells[0]));
    const startIdx = headerLikely ? 1 : 0;

    const out = [];
    for (let i = startIdx; i < lines.length; i++) {
      const cells = lines[i].split(sep).map(c => c.trim());
      if (cells.length === 0 || !cells[0]) continue;
      const t = Date.parse(cells[0]);
      if (!isFinite(t)) continue;
      const entry = { date: new Date(t).toISOString().slice(0, 10) };
      const hrv = +cells[1];
      const sleep = +cells[2];
      const rhr = +cells[3];
      let any = false;
      if (isFinite(hrv) && hrv > 0)   { entry.hrv = hrv;     any = true; }
      if (isFinite(sleep) && sleep > 0) { entry.sleep = sleep; any = true; }
      if (isFinite(rhr) && rhr > 0)   { entry.rhr = rhr;     any = true; }
      if (any) out.push(entry);
    }
    return out;
  }

  /* -----------------------------------------------------------
   * EXPORT
   * ----------------------------------------------------------- */
  window.Banister = {
    TAU_FITNESS, TAU_FATIGUE,
    sessionLoad,
    cardioLoad,
    fitness, fatigue, form,
    computeAll,
    trajectory,
    recommendation,
    baseline,
    todayPhysio,
    readiness,
    parseCSV,
    // Calibration τ par utilisateur (Busso 1997)
    calibrateTaus, getCalibration,
    // Monotonie & strain (Foster 1998)
    dailyLoads, monotony,
    // Acute:Chronic Workload Ratio (Gabbett 2016)
    acwr,
    // Fenêtre de test 1RM (tapering Banister)
    bestTestWindow,
  };
})();
