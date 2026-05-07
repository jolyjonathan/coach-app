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

  // Constantes Banister classiques. Ajustables si on calibre par utilisateur.
  const TAU_FITNESS = 42; // jours — décroissance lente du fitness
  const TAU_FATIGUE = 7;  // jours — décroissance rapide de la fatigue

  /* -----------------------------------------------------------
   * Calcul de la charge d'une session (sRPE × volume).
   * Méthode session-RPE de Foster (1998), adaptée à notre modèle :
   *   load = sets × RPE / 10
   *
   * Sessions externes (course, yoga, etc.) : load = durationMin × 7 / 60
   *   (on assume un RPE ~6-7 sans données plus précises).
   * Snacks (≤ 15 min) : pondérés à 50% — c'est de l'activité, pas de
   *   l'entraînement structuré.
   * Sessions sans RPE : assume RPE 7 (par défaut Foster).
   * ----------------------------------------------------------- */
  // Échelle de charge calibrée pour donner des CTL/ATL/TSB lisibles dans
  // les ranges TrainingPeaks classiques (typiquement 30-100 pour CTL, TSB
  // ±20-30). Une session moyenne (5 sets, RPE 7) donne load = 35.
  function sessionLoad(h) {
    if (!h || !h.date) return 0;
    if (h.kind === 'external') {
      const dur = +h.durationMin || 30;
      const rpe = +h.rpe || 7;
      return dur * rpe; // Foster sRPE classique : durée(min) × RPE
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

  // computeAll — un seul scan de l'history pour avoir CTL/ATL/TSB.
  // Plus économe que 3 appels séparés sur de gros historiques.
  function computeAll(history, atTime) {
    atTime = atTime || Date.now();
    let sumF = 0, sumA = 0;
    for (const h of (history || [])) {
      const t = Date.parse(h.date || '');
      if (!isFinite(t) || t > atTime) continue;
      const ageDays = (atTime - t) / 86400000;
      const L = sessionLoad(h);
      sumF += L * Math.exp(-ageDays / TAU_FITNESS);
      sumA += L * Math.exp(-ageDays / TAU_FATIGUE);
    }
    const ctl = sumF / TAU_FITNESS;
    const atl = sumA / TAU_FATIGUE;
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
  function readiness(history, physio, declaredFormScore, atTime) {
    atTime = atTime || Date.now();
    const today = todayPhysio(physio, atTime);
    let score = 50;
    const breakdown = { hrv: 0, rhr: 0, sleep: 0, tsb: 0, declarative: 0 };
    let usedPhysio = false;

    if (today) {
      // HRV : haut = mieux. Utilise z-score capé.
      if (isFinite(+today.hrv) && +today.hrv > 0) {
        const b = baseline(physio, 'hrv', atTime);
        if (b && b.sd > 0) {
          const z = Math.max(-1.5, Math.min(1.5, (today.hrv - b.mean) / b.sd));
          breakdown.hrv = z * 10; // ±15 max
          score += breakdown.hrv;
          usedPhysio = true;
        }
      }
      // RHR : bas = mieux (signe inversé).
      if (isFinite(+today.rhr) && +today.rhr > 0) {
        const b = baseline(physio, 'rhr', atTime);
        if (b && b.sd > 0) {
          const z = Math.max(-1.5, Math.min(1.5, (today.rhr - b.mean) / b.sd));
          breakdown.rhr = -z * 10; // signe inversé
          score += breakdown.rhr;
          usedPhysio = true;
        }
      }
      // Sommeil : haut = mieux.
      if (isFinite(+today.sleep) && +today.sleep > 0) {
        const b = baseline(physio, 'sleep', atTime);
        if (b && b.sd > 0) {
          const z = Math.max(-1.5, Math.min(1.5, (today.sleep - b.mean) / b.sd));
          breakdown.sleep = z * 7; // ±10 max
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
    fitness, fatigue, form,
    computeAll,
    trajectory,
    recommendation,
    baseline,
    todayPhysio,
    readiness,
    parseCSV,
  };
})();
