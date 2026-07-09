/* =============================================================
 * blockreview.js — Bilan de fin de bloc (mesocycle review)
 * =============================================================
 * Module PUR (zéro DOM, zéro dépendance réseau), même pattern que
 * banister.js / bayesian.js : IIFE + export unique window.BlockReview.
 *
 * Synthétise un bloc Issurin de 6 semaines à partir des modèles déjà en
 * place — aucune science nouvelle, uniquement de l'agrégation sourcée :
 *   - adhérence (séances/semaine) sur la fenêtre du bloc ;
 *   - volume par zone musculaire (même convention primaire=1.0 /
 *     secondaire=0.5 que Programming.weeklyVolumeByZone, mais bornée à la
 *     fenêtre du bloc, pas à "les N dernières semaines") ;
 *   - delta 1RM par key lift : état Kalman AVANT le bloc vs FIN de bloc,
 *     avec incertitude (Bayesian.computeState / current1RM) et drift ;
 *   - charge Banister : CTL/TSB début vs fin (fenêtre du bloc) ;
 *   - corrélation TSB ↔ HRV sur le bloc (Plews 2013 : le HRV matinal
 *     traque l'état de récupération — un TSB qui ne "colle" pas au HRV
 *     suggère des τ à recalibrer ou une charge externe non loggée) ;
 *   - recommandation motivée pour le bloc suivant (drift Kalman → deload
 *     anticipé, cf. Issurin 2010 sur la réalisation écourtée).
 *
 * Consommé par app.js (carte Tendances → Insights). Testé par
 * tests/run-tests.js en VM Node.
 * ============================================================= */
(function () {
  'use strict';

  var BLOCK_DAYS = 42; // 6 semaines Issurin (accumulation → … → deload)

  // Pearson r sur deux tableaux appariés. Renvoie null si n < 5 ou
  // variance nulle (corrélation non définie).
  function pearson(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 5) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    var mx = sx / n, my = sy / n;
    var num = 0, dx2 = 0, dy2 = 0;
    for (var j = 0; j < n; j++) {
      var dx = xs[j] - mx, dy = ys[j] - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    if (dx2 === 0 || dy2 === 0) return null;
    return num / Math.sqrt(dx2 * dy2);
  }

  // Sets par zone sur une fenêtre [startMs, endMs] — même convention que
  // Programming.weeklyVolumeByZone (primaire 1.0, secondaire 0.5), lib
  // injectable pour les tests.
  function setsByZone(history, startMs, endMs, lib) {
    lib = lib || (typeof window !== 'undefined' && window.EX_BY_ID) || {};
    var out = {};
    for (var i = 0; i < (history || []).length; i++) {
      var h = history[i];
      if (!h || h.kind === 'snack' || h.kind === 'external') continue;
      var t = Date.parse(h.date || '');
      if (!isFinite(t) || t < startMs || t > endMs) continue;
      var sets = h.sets || [];
      for (var k = 0; k < sets.length; k++) {
        var s = sets[k];
        if (!s || !s.exoId) continue;
        var e = lib[s.exoId];
        if (!e || !Array.isArray(e.z) || e.z.length === 0) continue;
        var isReal = (s.weight && s.weight > 0) || s.heldSecs || s.reps;
        if (!isReal) continue;
        for (var zi = 0; zi < e.z.length; zi++) {
          var z = e.z[zi];
          out[z] = (out[z] || 0) + (zi === 0 ? 1.0 : 0.5);
        }
      }
    }
    return out;
  }

  // compute — synthèse du bloc courant (ou du dernier bloc écoulé).
  //
  // opts = {
  //   history,    // S.history (obligatoire)
  //   physio,     // S.body.physio — [{date, hrv, …}] (optionnel)
  //   macrocycle, // S.macrocycle {startDate, focus} (obligatoire)
  //   now,        // ms epoch — défaut Date.now() (injectable pour tests)
  //   models,     // {Banister, Bayesian, Programming} — défaut window.*
  //   exoLib,     // EX_BY_ID — défaut window.EX_BY_ID (injectable pour tests)
  // }
  //
  // Renvoie null si pas de macrocycle, date invalide, ou < 14 jours de
  // recul (un bilan à mi-première-semaine n'a pas de sens). Sinon un objet
  // review — voir la construction en fin de fonction.
  function compute(opts) {
    opts = opts || {};
    var history = opts.history || [];
    var mc = opts.macrocycle;
    if (!mc || !mc.startDate) return null;
    var W = (typeof window !== 'undefined') ? window : {};
    var models = opts.models || {};
    var Ban = models.Banister || W.Banister;
    var Bay = models.Bayesian || W.Bayesian;
    var Prog = models.Programming || W.Programming;
    if (!Ban || !Bay || !Prog) return null;

    var now = opts.now || Date.now();
    var start = Date.parse(mc.startDate);
    if (!isFinite(start) || start > now) return null;

    // Fenêtre du bloc courant (le dernier multiple de 42 j depuis startDate).
    var daysSince = Math.floor((now - start) / 86400000);
    var blockIdx = Math.floor(daysSince / BLOCK_DAYS);
    var blockStart = start + blockIdx * BLOCK_DAYS * 86400000;
    var blockEnd = blockStart + BLOCK_DAYS * 86400000;
    var completed = now >= blockEnd;
    var reviewEnd = Math.min(now, blockEnd);
    var daysIn = Math.floor((reviewEnd - blockStart) / 86400000);
    if (daysIn < 14) {
      // Trop tôt dans CE bloc : si un bloc précédent complet existe, faire
      // le bilan de celui-là (c'est le moment naturel où on veut le lire).
      if (blockIdx === 0) return null;
      blockIdx -= 1;
      blockStart -= BLOCK_DAYS * 86400000;
      blockEnd -= BLOCK_DAYS * 86400000;
      completed = true;
      reviewEnd = blockEnd;
      daysIn = BLOCK_DAYS;
    }
    var weeks = daysIn / 7;

    // --- Adhérence -------------------------------------------------
    var sessionsIn = 0;
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (!h || h.kind === 'snack') continue;
      var t = Date.parse(h.date || '');
      if (isFinite(t) && t >= blockStart && t <= reviewEnd) sessionsIn++;
    }

    // --- Volume par zone -------------------------------------------
    var zones = setsByZone(history, blockStart, reviewEnd, opts.exoLib);
    var zonesPerWeek = {};
    var zk = Object.keys(zones);
    for (var z = 0; z < zk.length; z++) {
      zonesPerWeek[zk[z]] = +(zones[zk[z]] / weeks).toFixed(1);
    }

    // --- Key lifts : delta 1RM Kalman + drift ----------------------
    var histToEnd = history.filter(function (e) {
      var t = Date.parse((e && e.date) || '');
      return isFinite(t) && t <= reviewEnd;
    });
    var histBefore = history.filter(function (e) {
      var t = Date.parse((e && e.date) || '');
      return isFinite(t) && t < blockStart;
    });
    var keyLifts = (typeof Prog.pickKeyLifts === 'function')
      ? Prog.pickKeyLifts(histToEnd, 4, {}) : [];
    var lifts = [];
    var driftingCount = 0;
    for (var kl = 0; kl < keyLifts.length; kl++) {
      var exoId = keyLifts[kl];
      var stEnd = Bay.computeState(histToEnd, exoId);
      if (!stEnd) continue;
      var cur = Bay.current1RM(stEnd, 0.9);
      var stStart = Bay.computeState(histBefore, exoId);
      var startRM = stStart ? Bay.current1RM(stStart, 0.9) : null;
      var drift = (typeof Bay.detectDrift === 'function') ? Bay.detectDrift(stEnd) : { drifting: false };
      if (drift && drift.drifting) driftingCount++;
      lifts.push({
        exoId: exoId,
        end: cur ? { mu: cur.mu, sigma: cur.sigma, n: cur.n } : null,
        start: startRM ? { mu: startRM.mu, sigma: startRM.sigma } : null,
        deltaKg: (cur && startRM) ? +(cur.mu - startRM.mu).toFixed(1) : null,
        drift: drift || { drifting: false },
      });
    }

    // --- Banister : début vs fin de bloc ---------------------------
    var bStart = Ban.computeAll(history, blockStart);
    var bEnd = Ban.computeAll(history, reviewEnd);

    // --- Corrélation TSB ↔ HRV sur le bloc (Plews 2013) ------------
    var tsbs = [], hrvs = [];
    var physio = opts.physio || [];
    for (var p = 0; p < physio.length; p++) {
      var pe = physio[p];
      if (!pe || !isFinite(+pe.hrv) || +pe.hrv <= 0) continue;
      var pt = Date.parse(pe.date || '');
      if (!isFinite(pt) || pt < blockStart || pt > reviewEnd) continue;
      tsbs.push(Ban.computeAll(history, pt).tsb);
      hrvs.push(+pe.hrv);
    }
    var corr = pearson(tsbs, hrvs);

    // --- Recommandation motivée pour la suite ----------------------
    var next;
    if (driftingCount >= 2) {
      next = {
        action: 'deload',
        why: driftingCount + ' key lifts en régression significative (drift Kalman) — ' +
          'écourter la réalisation et placer le deload maintenant plutôt qu\'en semaine 6 ' +
          '(Issurin 2010 : la réalisation ne paie que sur un organisme qui absorbe encore).',
      };
    } else if (bEnd.tsb < -15) {
      next = {
        action: 'reduce-volume',
        why: 'TSB de fin de bloc à ' + bEnd.tsb.toFixed(0) +
          ' — la fatigue accumulée dépasse la zone productive (Banister : TSB < -15 = risque de ' +
          'surmenage). Démarrer le bloc suivant 10-20 % sous le volume de celui-ci.',
      };
    } else {
      next = {
        action: 'progress',
        why: 'Progression saine (pas de drift multiple, TSB dans la zone gérable) — ' +
          'enchaîner le bloc suivant avec la surcharge progressive standard.',
      };
    }

    return {
      blockIdx: blockIdx + 1, // 1-based pour affichage
      startDate: new Date(blockStart).toISOString().slice(0, 10),
      endDate: new Date(blockEnd).toISOString().slice(0, 10),
      completed: completed,
      daysIn: daysIn,
      focus: mc.focus || null,
      adherence: {
        sessions: sessionsIn,
        perWeek: +(sessionsIn / weeks).toFixed(1),
      },
      volume: {
        setsByZone: zones,
        setsPerWeekByZone: zonesPerWeek,
      },
      lifts: lifts,
      banister: {
        ctlStart: +bStart.ctl.toFixed(1),
        ctlEnd: +bEnd.ctl.toFixed(1),
        ctlDelta: +(bEnd.ctl - bStart.ctl).toFixed(1),
        tsbEnd: +bEnd.tsb.toFixed(1),
      },
      tsbHrvCorr: corr == null ? null : { r: +corr.toFixed(2), n: tsbs.length },
      next: next,
    };
  }

  // Export
  if (typeof window !== 'undefined') {
    window.BlockReview = { compute: compute, pearson: pearson, setsByZone: setsByZone, BLOCK_DAYS: BLOCK_DAYS };
  }
})();
