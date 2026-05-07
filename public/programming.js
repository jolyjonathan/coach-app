/* =============================================================
 * Coach Adaptatif — Programmation niveau 2 (Israetel + Issurin)
 * =============================================================
 *
 * Quatre briques :
 *
 *   1. LANDMARKS — MEV/MAV/MRV par groupe musculaire (Renaissance
 *      Periodization). Calcul du volume hebdo par zone, code couleur
 *      "sous-stimulé / sweet spot / sur-volume".
 *
 *   2. BLOCK — Périodisation par blocs (Issurin). Cycle de 6 semaines :
 *      accumulation × 3 → transmutation → réalisation → deload.
 *      Modificateurs de génération par phase courante.
 *
 *   3. TAXONOMY — Patrons de mouvement (push hor/vert, pull hor/vert,
 *      squat, hinge, lunge, anti-rot, anti-ext, carry). Calcul ratios,
 *      détection des déséquilibres push/pull et squat/hinge.
 *
 *   4. RESPONDER — Classification du type de réponse (fast / moderate /
 *      slow) selon la pente de progression du 1RM estimé. Adapte
 *      l'incrément de charge et la fréquence de deload.
 *
 * Toutes les fonctions sont pures et exposées via window.Programming.
 * Aucune dépendance à app.js — ce module est utilisable seul, mais il
 * lit window.EX_BY_ID quand il a besoin de mapper des exos à leurs
 * zones (fallback : '?' / pattern null).
 * ============================================================= */
(function () {
  'use strict';

  /* ============================================================
   * 1. LANDMARKS DE VOLUME (MEV / MAV / MRV)
   * ============================================================
   * Sources : Mike Israetel / Renaissance Periodization, Schoenfeld 2017
   * meta-analyses. Les valeurs sont des sets/semaine de "travail dur"
   * (RPE >= 7, à proximité de l'échec). Ce sont des moyennes population —
   * un utilisateur peut individuellement avoir des seuils +20%/-20%.
   *
   * MEV = Maintenance/Minimum Effective Volume — sous ce seuil, pas de
   *       progression, juste maintien à condition d'intensité haute.
   * MAV = Maximum Adaptive Volume (range) — la zone optimale de progression.
   * MRV = Maximum Recoverable Volume — au-dessus, on régresse car la
   *       fatigue dépasse la capacité de récupération.
   *
   * Mapping sur nos zones grossières (legs/chest/back/shoulders/arms/core)
   * → on agrège les sous-groupes du modèle RP. Par exemple legs = quads +
   * ischios + fessiers + mollets, donc le total est plus élevé que les
   * sous-groupes individuels.
   */
  const VOLUME_LANDMARKS = {
    legs:      { mev: 12, mav: [16, 24], mrv: 28, label: 'Jambes',     desc: 'Quadriceps + ischios + fessiers + mollets' },
    chest:     { mev:  8, mav: [12, 20], mrv: 22, label: 'Pectoraux',  desc: 'Pec major + minor + fibres claviculaires' },
    back:      { mev: 10, mav: [14, 22], mrv: 25, label: 'Dos',        desc: 'Lats + rhomboides + trapèze + erector' },
    shoulders: { mev:  8, mav: [12, 18], mrv: 22, label: 'Épaules',    desc: 'Deltoïdes ant/lat/post + coiffe' },
    arms:      { mev:  6, mav: [10, 16], mrv: 22, label: 'Bras',       desc: 'Biceps + triceps (combiné)' },
    core:      { mev:  0, mav: [ 8, 16], mrv: 20, label: 'Gainage',    desc: 'Abdos + transverse + obliques' },
  };

  // weeklyVolumeByZone — somme les sets effectifs par zone sur les
  // weeksBack semaines glissantes. Pondération : un set d'exo poly-articulaire
  // compte 1.0 pour la zone primaire (z[0]) et 0.5 pour les zones secondaires.
  // Évite la sur-comptage tout en reconnaissant que le squat sollicite
  // partiellement le core, etc.
  function weeklyVolumeByZone(history, weeksBack) {
    weeksBack = weeksBack || 1;
    const cutoff = Date.now() - weeksBack * 7 * 86400000;
    const out = {};
    Object.keys(VOLUME_LANDMARKS).forEach(z => out[z] = 0);
    const lib = (typeof window !== 'undefined' && window.EX_BY_ID) || {};
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t) || t < cutoff) continue;
      for (const s of (h.sets || [])) {
        if (!s.exoId) continue;
        const e = lib[s.exoId];
        if (!e || !Array.isArray(e.z) || e.z.length === 0) continue;
        // Compte uniquement les sets "qui progressent" : présence d'un poids
        // OU set timed avec heldSecs. On exclut les sets purs warm-up (ces
        // données n'existent pas dans notre modèle, c'est une approximation).
        const isReal = (s.weight && s.weight > 0) || s.heldSecs || s.reps;
        if (!isReal) continue;
        e.z.forEach((z, i) => {
          if (out[z] == null) return; // zone inconnue de RP
          out[z] += (i === 0) ? 1.0 : 0.5;
        });
      }
    }
    // Normalisation hebdo si on a regardé sur N semaines.
    Object.keys(out).forEach(k => out[k] = +(out[k] / weeksBack).toFixed(1));
    return out;
  }

  // personalizeLandmarks — calcule un multiplicateur (~0.85 à 1.15) à
  // appliquer aux MEV/MAV/MRV d'une zone donnée, basé sur la relation
  // observée entre volume et RPE moyen de l'utilisateur.
  //
  // Heuristique :
  //   - Si volume haut (≥ MAV haut) ET RPE moyen bas (< 7.5) → user tolère
  //     bien ce volume, on bump landmarks à 1.15 (le sweet spot est plus
  //     haut pour lui).
  //   - Si volume nominal (MAV) ET RPE moyen haut (> 8.5) → user fatigue
  //     vite, on shrink à 0.85.
  //   - Sinon → 1.0 (ranges population standard).
  //
  // Fenêtre : 4 semaines glissantes. Minimum 4 sessions sur la zone pour
  // être considéré exploitable, sinon on retombe sur 1.0.
  //
  // Le multiplicateur est conservateur (±15%) pour ne pas dériver loin
  // des landmarks population sur la base d'un mois de données.
  function personalizeLandmarks(history, zoneId) {
    const L = VOLUME_LANDMARKS[zoneId];
    if (!L) return 1.0;
    const cutoff = Date.now() - 4 * 7 * 86400000;
    const lib = (typeof window !== 'undefined' && window.EX_BY_ID) || {};
    let totalSets = 0;
    let totalSessions = 0;
    let rpeSum = 0;
    let rpeN = 0;
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t) || t < cutoff) continue;
      let zoneInSession = false;
      for (const s of (h.sets || [])) {
        const e = lib[s.exoId];
        if (!e || !Array.isArray(e.z)) continue;
        if (e.z.includes(zoneId)) {
          totalSets += (e.z[0] === zoneId) ? 1.0 : 0.5;
          zoneInSession = true;
        }
      }
      if (zoneInSession) {
        totalSessions++;
        const rpe = +h.rpe;
        if (isFinite(rpe)) { rpeSum += rpe; rpeN++; }
      }
    }
    if (totalSessions < 4 || rpeN === 0) return 1.0;
    const weeklyVolume = totalSets / 4;        // 4 semaines de fenêtre
    const avgRpe = rpeSum / rpeN;
    if (weeklyVolume >= L.mav[1] && avgRpe < 7.5) return 1.15;
    if (weeklyVolume >= L.mev && avgRpe > 8.5) return 0.85;
    return 1.0;
  }

  // landmarksFor — version personnalisée des MEV/MAV/MRV pour une zone.
  // Si pas d'historique → retombe sur les valeurs population.
  function landmarksFor(zoneId, history) {
    const L = VOLUME_LANDMARKS[zoneId];
    if (!L) return null;
    const mult = (history && history.length >= 4)
      ? personalizeLandmarks(history, zoneId)
      : 1.0;
    return {
      mev: Math.round(L.mev * mult * 10) / 10,
      mav: [Math.round(L.mav[0] * mult * 10) / 10, Math.round(L.mav[1] * mult * 10) / 10],
      mrv: Math.round(L.mrv * mult * 10) / 10,
      label: L.label, desc: L.desc,
      multiplier: mult,
      personalized: mult !== 1.0,
    };
  }

  // landmarkStatus — pour un volume donné, retourne le statut narratif et
  // un code couleur exploitable par l'UI. Accepte un history optionnel
  // pour personnaliser les seuils.
  function landmarkStatus(zone, volume, history) {
    const L = (history != null) ? landmarksFor(zone, history) : VOLUME_LANDMARKS[zone];
    if (!L) return { status: 'unknown', label: '?', color: 'var(--mut)' };
    if (volume < L.mev) {
      return { status: 'sub-mev', label: 'sous-stimulé',
               color: 'var(--warn,#F2C457)',
               advice: `Sous le minimum effectif (${L.mev} sets/sem). Augmente le volume si tu veux progresser sur cette zone.` };
    }
    if (volume <= L.mav[0]) {
      return { status: 'mev-mav', label: 'maintien',
               color: 'var(--blue,#7BA1FF)',
               advice: `Volume de maintien. OK pour conserver, ajoute 1-2 sets/sem pour entrer en zone optimale.` };
    }
    if (volume <= L.mav[1]) {
      return { status: 'mav', label: 'sweet spot',
               color: 'var(--success,#5DD4A4)',
               advice: `Zone optimale de progression (${L.mav[0]}-${L.mav[1]} sets/sem). Continue.` };
    }
    if (volume <= L.mrv) {
      return { status: 'mav-mrv', label: 'volume haut',
               color: 'var(--warn,#F2C457)',
               advice: `Au-dessus du sweet spot mais sous le MRV. Surveille la récup, surtout si tu deload bientôt.` };
    }
    return { status: 'sur-mrv', label: 'sur-volume',
             color: 'var(--danger,#FF6B6B)',
             advice: `Au-dessus du MRV (${L.mrv} sets/sem). Risque de stagnation/régression. Dé-charge la semaine prochaine.` };
  }


  /* ============================================================
   * 2. PÉRIODISATION PAR BLOCS (Issurin / Verkhoshansky)
   * ============================================================
   * Cycle de 6 semaines avec rotation des qualités dominantes :
   *
   *   Sem 1-3  : Accumulation  — volume haut, intensité modérée (60-75%
   *              1RM, RPE 7-8). On accumule la fatigue et le travail.
   *   Sem 4    : Transmutation — volume baisse de ~25%, intensité monte
   *              (75-85%, RPE 8-9). On convertit le volume en force/qualité.
   *   Sem 5    : Réalisation   — volume bas (~50% normale), intensité
   *              haute (85-95%, RPE 9). Singles/doubles, peaking.
   *   Sem 6    : Deload        — volume 50%, intensité 70%. Récupération.
   *
   * À la fin du cycle, on redémarre automatiquement à Sem 1 avec un
   * incrément de charge basé sur le PR atteint en Sem 5 (si nouveau PR :
   * +2.5kg sur la base de progression ; sinon : on garde la même base).
   */
  const PHASES = [
    { id: 'accumulation', label: 'Accumulation',
      volMod: +0.20, intMod: -0.05, restMod:  +5,
      desc: 'Volume haut, intensité modérée. On accumule la fatigue de travail.' },
    { id: 'transmutation', label: 'Transmutation',
      volMod: -0.25, intMod: +0.05, restMod: +15,
      desc: 'Volume baisse, intensité monte. On convertit le volume en force.' },
    { id: 'realization', label: 'Réalisation',
      volMod: -0.50, intMod: +0.15, restMod: +30,
      desc: 'Volume bas, intensité haute. Phase de peaking — singles et doubles proches du max.' },
    { id: 'deload', label: 'Deload',
      volMod: -0.50, intMod: -0.30, restMod:  +0,
      desc: 'Récupération active. -50% de volume et -30% de charge pour absorber les semaines précédentes.' },
  ];

  // Plan d'attribution de phase semaine par semaine (cycle de 6).
  const PHASE_BY_WEEK = [
    'accumulation', 'accumulation', 'accumulation',
    'transmutation', 'realization', 'deload',
  ];

  // recentRpeAvg — moyenne des RPE des séances complètes (kind absent
  // ou non-snack/external) sur les `daysBack` derniers jours. null si pas
  // de données.
  function recentRpeAvg(history, daysBack) {
    daysBack = daysBack || 7;
    const cutoff = Date.now() - daysBack * 86400000;
    let sum = 0, n = 0;
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t) || t < cutoff) continue;
      const r = +h.rpe;
      if (isFinite(r)) { sum += r; n++; }
    }
    return n > 0 ? sum / n : null;
  }

  // adaptiveBlockOverride — décide si la phase scheduled doit être
  // remplacée par une autre selon les signaux RPE récents. Garde-fous :
  //  - On ne saute JAMAIS plus d'une phase à la fois.
  //  - On ne raccourcit jamais le deload (on peut prolonger seulement).
  //  - On respecte une stabilité minimale : pas de switch tous les jours.
  //
  // Renvoie soit null (= pas de override, garder la phase scheduled),
  // soit { phaseId, reason } pour signaler la phase effective.
  function adaptiveBlockOverride(macrocycle, history, scheduled) {
    if (!macrocycle || !scheduled || !scheduled.phase) return null;
    const sched = scheduled.phase.id;
    const rpe7 = recentRpeAvg(history, 7);
    const rpe14 = recentRpeAvg(history, 14);
    if (rpe7 == null) return null; // pas assez de données — laisse passer

    // 1) Accumulation → fatigue précoce. Si RPE moyen 7j > 8.5 ET la
    //    semaine en cours est ≥ 2 (au moins 7 jours d'accumulation faits),
    //    on suggère de basculer en transmutation.
    if (sched === 'accumulation' && scheduled.weekInCycle >= 2 && rpe7 >= 8.5) {
      return { phaseId: 'transmutation',
               reason: `RPE 7j ${rpe7.toFixed(1)} ≥ 8.5 — accumulation écourtée, passage en transmutation` };
    }
    // 2) Transmutation → poussée trop dure. Si RPE 7j > 9, on saute le
    //    pic d'intensité et on file directement en deload.
    if (sched === 'transmutation' && rpe7 >= 9) {
      return { phaseId: 'deload',
               reason: `RPE 7j ${rpe7.toFixed(1)} ≥ 9 — réalisation skipée, deload anticipé` };
    }
    // 3) Réalisation → si RPE 7j ≥ 9.5, on déloade plutôt que de continuer.
    if (sched === 'realization' && rpe7 >= 9.5) {
      return { phaseId: 'deload',
               reason: `RPE 7j ${rpe7.toFixed(1)} ≥ 9.5 — peaking abandonné pour préserver la santé articulaire` };
    }
    // 4) Deload → si la fatigue n'est pas redescendue (RPE 7j > 8 = signal
    //    que même les séances allégées sont dures), on prolonge le deload.
    //    On force phaseId = 'deload' même si la semaine schedulée était la
    //    suivante (= début d'un nouveau cycle d'accumulation).
    if (sched === 'accumulation' && scheduled.weekInCycle === 1
        && rpe14 != null && rpe14 >= 8) {
      return { phaseId: 'deload',
               reason: `RPE 14j ${rpe14.toFixed(1)} ≥ 8 — récupération incomplète, deload prolongé d'une semaine` };
    }
    return null;
  }

  // currentBlockState — calcule semaine du cycle, phase, mods.
  // macrocycle = { startDate, focus }
  // Renvoie null si pas de macrocycle actif.
  function currentBlockState(macrocycle) {
    if (!macrocycle || !macrocycle.startDate) return null;
    const start = Date.parse(macrocycle.startDate);
    if (Number.isNaN(start)) return null;
    const days = Math.floor((Date.now() - start) / 86400000);
    if (days < 0) return null;
    const weekIdx = Math.floor(days / 7);          // 0-based
    const cycleWeek = weekIdx % 6;                  // position dans le cycle de 6
    const cycleNum = Math.floor(weekIdx / 6) + 1;   // numéro de macrocycle (1-based)
    const phaseId = PHASE_BY_WEEK[cycleWeek];
    const phase = PHASES.find(p => p.id === phaseId) || PHASES[0];
    return {
      cycleNum,
      weekInCycle: cycleWeek + 1, // 1-based pour affichage
      totalWeeks: 6,
      daysSince: days,
      phase,
    };
  }

  // blockMods — extrait les modificateurs de génération. Si history fourni,
  // le cycle s'adapte aux RPE récents via adaptiveBlockOverride et la
  // phase effective peut différer de la phase schedulée.
  function blockMods(macrocycle, history) {
    const st = currentBlockState(macrocycle);
    if (!st) return { volMod: 0, intMod: 0, restMod: 0, exoCountMod: 0 };
    let p = st.phase;
    let adaptiveReason = null;
    if (history && Array.isArray(history) && history.length > 0) {
      const ovr = adaptiveBlockOverride(macrocycle, history, st);
      if (ovr && ovr.phaseId) {
        const newPhase = PHASES.find(x => x.id === ovr.phaseId);
        if (newPhase) {
          p = newPhase;
          adaptiveReason = ovr.reason;
        }
      }
    }
    // exoCountMod : on ne garde pas le même nombre d'exos sur les phases
    // intenses (réalisation se concentre sur 2-3 mouvements maîtres).
    let exoCountMod = 0;
    if (p.id === 'realization') exoCountMod = -2;
    else if (p.id === 'transmutation') exoCountMod = -1;
    else if (p.id === 'deload') exoCountMod = -1;
    return {
      volMod: p.volMod, intMod: p.intMod, restMod: p.restMod,
      exoCountMod, phaseId: p.id, phaseLabel: p.label,
      adaptive: adaptiveReason != null,
      adaptiveReason,
    };
  }


  /* ============================================================
   * 3. TAXONOMIE DE MOUVEMENT
   * ============================================================
   * Mapping exoId → patron de mouvement. Maintenu ici pour ne pas
   * polluer l'EX library inline. Tout exo non listé est ignoré du
   * calcul de ratio (renvoie null sur inférence).
   *
   * Patrons :
   *   pushHor / pushVert  — pousser horizontal (DC, pompes) / vertical (presse au-dessus).
   *   pullHor / pullVert  — tirer horizontal (rowing) / vertical (tractions, latpull).
   *   squat / hinge / lunge — patrons chaîne basse.
   *   antiRot / antiExt   — gainage rotation / extension.
   *   carry / iso         — déplacements chargés / isométriques (gainage classique).
   */
  const PATTERN_MAP = {
    // Push horizontal
    dc: 'pushHor', dcincline: 'pushHor', pompes: 'pushHor', pompediam: 'pushHor',
    ecarte: 'pushHor', pecdeck: 'pushHor', dip: 'pushHor', trxpush: 'pushHor',
    // Push vertical
    militaire: 'pushVert', pikepush: 'pushVert', kbpress: 'pushVert',
    lateraux: 'pushVert',
    // Pull horizontal
    row: 'pullHor', rowelast: 'pullHor', invrow: 'pullHor', cablerow: 'pullHor',
    trxrow: 'pullHor', facepull: 'pullHor',
    // Pull vertical
    tract: 'pullVert', tirage: 'pullVert', latpull: 'pullVert',
    // Squat
    squat: 'squat', goblet: 'squat', jumpsquat: 'squat', wallsit: 'squat',
    pistol: 'squat', boxjump: 'squat', legpress: 'squat', legext: 'squat',
    // Hinge
    sdt: 'hinge', sdtrm: 'hinge', kbswing: 'hinge', kbgoblet: 'hinge',
    hipthrust: 'hinge', gluteb: 'hinge', bandgm: 'hinge', legcurl: 'hinge',
    superman: 'hinge',
    // Lunge / unilateral
    fentes: 'lunge', bulgare: 'lunge', stepup: 'lunge',
    // Anti-rotation / anti-extension / iso
    gainage: 'antiExt', sideplank: 'antiRot', deadbug: 'antiExt',
    hollow: 'antiExt', hangleg: 'antiExt', crunch: 'antiExt',
    rustwist: 'antiRot', birddog: 'antiExt',
    // Carry / cardio explosif
    burpee: 'cardio', mountain: 'cardio', highknee: 'cardio',
    kbtgu: 'carry', mollet: 'iso',
    // Curls / triceps isolation : bras pures, pas un patron, on garde simple
    curl: 'pullHor', cablecurl: 'pullHor', // bicep est un fléchisseur, on l'attache à pull pour ratio
    triceps: 'pushHor', tripush: 'pushHor', // extenseur du coude, on l'attache à push
    bandpa: 'pullHor', bandwalk: 'lunge',
  };

  function inferPattern(exoId) {
    return PATTERN_MAP[exoId] || null;
  }

  // auditPatternCoverage — utilitaire dev pour vérifier que tout exo de la
  // bibliothèque EX a bien une entrée dans PATTERN_MAP. À appeler depuis
  // la console quand on ajoute des exos. Retourne la liste des ids
  // manquants (vide si tout est mappé).
  function auditPatternCoverage() {
    const lib = (typeof window !== 'undefined' && window.EX_BY_ID) || {};
    const missing = [];
    for (const id of Object.keys(lib)) {
      if (!PATTERN_MAP[id]) missing.push(id);
    }
    return missing;
  }

  // weeklyVolumeByPattern — comme weeklyVolumeByZone, mais agrégé par patron.
  function weeklyVolumeByPattern(history, weeksBack) {
    weeksBack = weeksBack || 1;
    const cutoff = Date.now() - weeksBack * 7 * 86400000;
    const out = {};
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t) || t < cutoff) continue;
      for (const s of (h.sets || [])) {
        const p = inferPattern(s.exoId);
        if (!p) continue;
        const isReal = (s.weight && s.weight > 0) || s.heldSecs || s.reps;
        if (!isReal) continue;
        out[p] = (out[p] || 0) + 1;
      }
    }
    Object.keys(out).forEach(k => out[k] = +(out[k] / weeksBack).toFixed(1));
    return out;
  }

  // ============================================================
  // GOAL_RANGES — table extensible des ranges de ratio par objectif.
  // ============================================================
  // Chaque entrée définit ses propres seuils pour les 3 ratios suivis.
  // Si plusieurs goals sont actifs (multi-select onboarding), les ranges
  // effectifs prennent le min(lo) et max(hi) de chaque goal — c'est la
  // tolérance la plus large, qui correspond à l'union des intentions.
  //
  // Pour ajouter un nouveau goal, on ajoute une entrée ici. Si un goal
  // est mentionné par le user mais absent de cette table, DEFAULT_RANGES
  // s'applique pour ce goal (donc pas de crash, juste un fallback sain).
  //
  // Sources : Cook, Boyle, Cressey (équilibre généraliste) ; Israetel
  // (hypertrophie) ; Wendler/Rippetoe (force) ; Verkhoshansky (puissance).
  //
  // Convention : lo/hi inclusifs ; ratio < lo = trop de "denominator",
  // ratio > hi = trop de "numerator".
  const GOAL_RANGES = {
    // Population générale — l'équilibre symétrique est l'idéal.
    forme: {
      pushPullHor:  [0.8, 1.2],
      pushPullVert: [0.5, 0.8],
      squatHinge:   [0.7, 1.2],
    },
    // Hypertrophie — volume haut, équilibre important pour éviter les
    // déséquilibres esthétiques et les blessures.
    hypertrophie: {
      pushPullHor:  [0.8, 1.2],
      pushPullVert: [0.5, 0.8],
      squatHinge:   [0.7, 1.2],
    },
    // Force / powerlifting — SDT lourd peut domier, DC bench peut dominer.
    // On accepte des ratios beaucoup plus larges sans flagger.
    force: {
      pushPullHor:  [0.7, 1.4],
      pushPullVert: [0.4, 1.0],
      squatHinge:   [0.4, 1.8],
    },
    // Endurance musculaire — focus sur la résistance à la fatigue, ratios
    // moins critiques que la capacité de répétition.
    endurance: {
      pushPullHor:  [0.6, 1.5],
      pushPullVert: [0.4, 1.0],
      squatHinge:   [0.5, 1.5],
    },
    // Perte de gras — mêmes priorités qu'endurance (volume cardio + muscu
    // mixte), ratios déséquilibrés moins préoccupants.
    perte_gras: {
      pushPullHor:  [0.6, 1.5],
      pushPullVert: [0.4, 1.0],
      squatHinge:   [0.5, 1.5],
    },
    // Puissance / explosivité — sport athlétique. Ratios variables selon
    // la spécialité (un sprinter aura plus de hinge, un boxeur plus de
    // push). On élargit.
    puissance: {
      pushPullHor:  [0.6, 1.5],
      pushPullVert: [0.4, 1.0],
      squatHinge:   [0.4, 1.8],
    },
    // Mobilité / souplesse — l'app ne mesure pas vraiment ce ratio, mais
    // on tolère tout sans flagger pour ne pas pénaliser les utilisateurs
    // qui font du stretching plus que du muscu lourd.
    mobilite: {
      pushPullHor:  [0.4, 2.5],
      pushPullVert: [0.3, 1.5],
      squatHinge:   [0.3, 2.5],
    },
    // Débutant — ranges plus stricts pour encourager l'équilibre dès le
    // début. C'est la phase d'apprentissage du mouvement, ne pas laisser
    // s'installer des déséquilibres précoces.
    debutant: {
      pushPullHor:  [0.85, 1.15],
      pushPullVert: [0.55, 0.75],
      squatHinge:   [0.75, 1.15],
    },
    // Compétition / sport-spécifique — préparer une compétition demande
    // souvent une asymétrie volontaire (un nageur aura plus de pull qu'un
    // coureur). On accepte tout sans flagger.
    competition: {
      pushPullHor:  [0.4, 2.5],
      pushPullVert: [0.3, 1.5],
      squatHinge:   [0.3, 2.5],
    },
  };

  // Fallback explicite — utilisé si aucun goal renseigné OU si un goal
  // listé n'est pas dans GOAL_RANGES.
  const DEFAULT_RANGES = GOAL_RANGES.forme;

  // effectiveRanges — combine les ranges des goals actifs en prenant la
  // tolérance la plus large (min des lo, max des hi) sur chaque ratio.
  // Renvoie aussi `unknownGoals` listant les goals non reconnus pour
  // qu'on puisse signaler en debug.
  function effectiveRanges(goals) {
    if (!Array.isArray(goals) || goals.length === 0) {
      return Object.assign({ unknownGoals: [] }, DEFAULT_RANGES);
    }
    const known = goals.filter(g => GOAL_RANGES[g]);
    const unknown = goals.filter(g => !GOAL_RANGES[g]);
    if (known.length === 0) {
      // Tous les goals sont inconnus → fallback default.
      return Object.assign({ unknownGoals: unknown }, DEFAULT_RANGES);
    }
    const ratios = ['pushPullHor', 'pushPullVert', 'squatHinge'];
    const out = { unknownGoals: unknown };
    for (const r of ratios) {
      let lo = Infinity, hi = -Infinity;
      for (const g of known) {
        const range = GOAL_RANGES[g][r];
        if (!range) continue;
        if (range[0] < lo) lo = range[0];
        if (range[1] > hi) hi = range[1];
      }
      out[r] = (isFinite(lo) && isFinite(hi)) ? [lo, hi] : DEFAULT_RANGES[r];
    }
    return out;
  }

  // imbalanceReport — détecte les déséquilibres notables. Cibles classiques
  // de la littérature (Cook, Boyle, Cressey) : push/pull horizontal ~ 1:1
  // (idéalement 0.8-1.2), squat/hinge ~ 1:1 à 1:1.5 (légèrement plus de
  // hinge pour la santé du dos), pushVert/pullVert ~ 1:1.5 (plus de pull
  // pour compenser la posture moderne assise).
  //
  // Adapté aux objectifs via la table GOAL_RANGES (extensible). Si le
  // profile contient un goal non reconnu, le warning est silencieux et
  // on retombe sur les ranges des goals connus restants.
  //
  // Renvoie array de { kind, value, target, severity, message }.
  // severity : 'ok' | 'warn' | 'high'.
  function imbalanceReport(history, profile) {
    const v = weeklyVolumeByPattern(history, 4); // moyenne 4 semaines
    const ratio = (a, b) => (b > 0 ? +(a / b).toFixed(2) : (a > 0 ? Infinity : null));
    const rPush = ratio(v.pushHor || 0, v.pullHor || 0);
    const rVert = ratio(v.pushVert || 0, v.pullVert || 0);
    const rSqHi = ratio(v.squat || 0, v.hinge || 0);

    const goals = (profile && Array.isArray(profile.goals)) ? profile.goals : [];
    const ranges = effectiveRanges(goals);

    const knownGoals = goals.filter(g => GOAL_RANGES[g]);
    const goalNote = knownGoals.length > 0
      ? ` (ranges ajustés à ton objectif "${knownGoals.slice(0, 2).join('/')}").`
      : '';

    const out = [];

    function classify(value, range, kind, label, advice) {
      const [lo, hi] = range;
      if (value == null || value === Infinity) {
        out.push({ kind, label, value: '∞ ou nul', severity: 'warn',
                   message: `Données insuffisantes ou un côté à zéro. ${advice}` });
        return;
      }
      if (value >= lo && value <= hi) {
        out.push({ kind, label, value, target: `${lo}-${hi}`, severity: 'ok',
                   message: 'Ratio équilibré.' + goalNote });
      } else {
        const sev = (value > hi * 1.5 || value < lo * 0.5) ? 'high' : 'warn';
        out.push({ kind, label, value, target: `${lo}-${hi}`, severity: sev,
                   message: advice + goalNote });
      }
    }
    classify(rPush, ranges.pushPullHor, 'pushPullHor', 'Push/Pull horizontal',
      'Vise un ratio proche de 1:1. Trop de push antérieur (DC, pompes) sans tirage horizontal génère des cyphoses et des conflits d\'épaule.');
    classify(rVert, ranges.pushPullVert, 'pushPullVert', 'Push/Pull vertical',
      'Vise plus de tirage vertical (tractions, latpull) que de presse au-dessus. Compense la posture moderne.');
    classify(rSqHi, ranges.squatHinge, 'squatHinge', 'Squat/Hinge',
      'Équilibre quadriceps-dominant (squat) vs hanche-dominant (hinge, hip thrust, SDT). Trop de squat sans hinge fragilise la chaîne postérieure.');
    if (ranges.unknownGoals && ranges.unknownGoals.length > 0) {
      // Avertissement silencieux dev — visible dans la console pour debug
      // sans polluer l'UI utilisateur.
      try { console.warn('imbalanceReport: goals inconnus dans GOAL_RANGES :', ranges.unknownGoals); } catch (_) {}
    }
    return out;
  }


  /* ============================================================
   * 4. CLASSIFICATION DU TYPE DE RÉPONSE
   * ============================================================
   * Calcule la pente moyenne de progression du 1RM estimé sur les exos
   * principaux (squat, dc, sdt, tract). Sur 8 semaines minimum sinon
   * 'unknown'. Seuils littéraires :
   *   > 1.5 kg/sem → fast (programme classique sans ralentir)
   *   0.5 - 1.5    → moderate (incrément standard)
   *   < 0.5        → slow (micro-progressions, cycles plus longs)
   *
   * Utilisé pour ajuster :
   *  - L'incrément de progressiveWeight (loadStep)
   *  - La fréquence de deload (chaque 4 sem si fast, 6 si slow)
   */
  const KEY_LIFTS = ['squat', 'dc', 'sdt', 'tract', 'goblet', 'sdtrm'];

  // pickKeyLifts — choisit dynamiquement les exos principaux selon le profil
  // RÉEL d'entraînement, avec pondération par décroissance exponentielle
  // dans le temps. Au lieu d'un hard cutoff à 12 semaines (qui crée un
  // effet falaise — un exo abandonné disparaît brutalement), on pondère
  // chaque set par exp(-age/τ) avec une half-life paramétrable.
  //
  // Half-life par défaut = 60 jours :
  //   - set d'aujourd'hui  : poids 1.0
  //   - set de 60j         : poids 0.5
  //   - set de 120j        : poids 0.25
  //   - set de 180j        : poids 0.125
  //
  // Bénéfice : un user qui change de programme tous les 6 mois conserve
  // de la mémoire long-terme tout en privilégiant son activité actuelle.
  // Le squat fait 100 fois sur 2 ans reste prioritaire sur 5 sessions de
  // pompes récentes mais cède la place après 2-3 mois sans pratique.
  //
  // opts.halfLifeDays : surcharge la half-life (60 par défaut).
  // opts.minWeight    : seuil minimum de poids pondéré pour qu'un exo
  //                     soit considéré (0.5 par défaut, soit ~3 sets
  //                     très récents ou ~6 sets à 60j).
  function pickKeyLifts(history, n, opts) {
    n = n || 6;
    opts = opts || {};
    const halfLifeDays = opts.halfLifeDays || 60;
    const minWeight = opts.minWeight != null ? opts.minWeight : 0.5;
    const lambda = Math.LN2 / halfLifeDays; // décroissance exp avec λ = ln(2)/τ
    const now = Date.now();
    const counts = {};
    for (const h of (history || [])) {
      if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
      const t = Date.parse(h.date || '');
      if (Number.isNaN(t)) continue;
      const ageDays = Math.max(0, (now - t) / 86400000);
      const w = Math.exp(-lambda * ageDays);
      for (const s of (h.sets || [])) {
        if (!s.exoId) continue;
        // pickKeyLifts compte tous les exos pratiqués, y compris les
        // bodyweight (weight=0) — sinon un user 100% pdc retombe sur la
        // liste hardcodée. Le filtre "weighted only" se fait plus tard,
        // dans computeState et classifyResponder.
        const real = (s.weight && s.weight > 0) || s.reps > 0 || s.heldSecs > 0;
        if (!real) continue;
        counts[s.exoId] = (counts[s.exoId] || 0) + w;
      }
    }
    const ranked = Object.keys(counts)
      .map(id => ({ id, w: counts[id] }))
      .filter(x => x.w >= minWeight)
      .sort((a, b) => b.w - a.w);
    if (ranked.length < 3) return KEY_LIFTS;  // fallback : pas assez de données
    return ranked.slice(0, n).map(x => x.id);
  }

  // estimateOneRmFromSet est dupliqué ici (Epley) pour ne pas dépendre de
  // app.js et permettre à programming.js d'être testable en isolation.
  function epley1RM(weight, reps) {
    const w = +weight, r = +reps;
    if (!isFinite(w) || w <= 0 || !isFinite(r) || r < 1) return null;
    const cappedReps = Math.min(r, 10);
    return w * (1 + cappedReps / 30);
  }

  function classifyResponder(history, opts) {
    opts = opts || {};
    // Fenêtre adaptative et confidence :
    //   ≥ 8 sem ET ≥ 2 exos analysables → confidence 'high'
    //   ≥ 4 sem ET ≥ 1 exo  analysable → confidence 'low' (tentative)
    //   sinon → 'unknown'
    // Avec 4 semaines, on a typiquement 3-4 buckets hebdo, ce qui
    // permet une régression linéaire mais avec une grande incertitude.
    // Le caller choisit s'il utilise le résultat pour adapter les
    // paramètres durs (loadStep) ou seulement pour l'affichage.
    const eightWeeksMs = 8 * 7 * 86400000;
    const cutoff = Date.now() - eightWeeksMs;
    // Propage opts.halfLifeDays à pickKeyLifts pour rester cohérent
    // avec la préférence utilisateur (mémoire récente vs long-terme).
    const lifts = pickKeyLifts(history, 6, opts);
    const slopes = [];
    let maxSpanWeeks = 0;
    for (const exoId of lifts) {
      const points = [];
      for (const h of (history || [])) {
        if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
        const t = Date.parse(h.date || '');
        if (Number.isNaN(t) || t < cutoff) continue;
        for (const s of (h.sets || [])) {
          if (s.exoId !== exoId) continue;
          const e = epley1RM(s.weight, s.reps);
          if (e == null) continue;
          points.push({ t, e });
        }
      }
      if (points.length < 3) continue; // minimum absolu pour une régression
      // Bucket par semaine, garder le best.
      const byWeek = {};
      for (const p of points) {
        const wk = Math.floor((p.t - cutoff) / (7 * 86400000));
        byWeek[wk] = Math.max(byWeek[wk] || 0, p.e);
      }
      const xs = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
      if (xs.length < 3) continue;  // ≥ 3 buckets pour une pente — était 4
      maxSpanWeeks = Math.max(maxSpanWeeks, xs[xs.length - 1] - xs[0] + 1);
      const ys = xs.map(x => byWeek[x]);
      // Régression linéaire ys = a*x + b → on veut a (kg/semaine).
      const n = xs.length;
      const meanX = xs.reduce((s, v) => s + v, 0) / n;
      const meanY = ys.reduce((s, v) => s + v, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - meanX) * (ys[i] - meanY);
        den += (xs[i] - meanX) * (xs[i] - meanX);
      }
      if (den === 0) continue;
      slopes.push(num / den); // kg / semaine
    }
    if (slopes.length === 0) {
      return { type: 'unknown', slope: null, sample: 0,
               confidence: 'unknown',
               label: 'Données insuffisantes',
               advice: 'Continue à logger 4+ semaines sur 1+ exo principal pour qu\'on commence à classer ton type de réponse.' };
    }
    const avgSlope = slopes.reduce((s, v) => s + v, 0) / slopes.length;
    // Confidence : 'high' si on a 8+ semaines de couverture sur 2+ exos,
    // 'low' sinon. Permet aux callers (loadStep, UI) de moduler.
    const confidence = (maxSpanWeeks >= 7 && slopes.length >= 2) ? 'high' : 'low';
    let type, label, advice;
    if (avgSlope >= 1.5) {
      type = 'fast'; label = 'Progresseur rapide';
      advice = 'Tu progresses vite. Tu peux te permettre des incréments de +2,5 kg fréquents et des deloads tous les 4 cycles.';
    } else if (avgSlope >= 0.5) {
      type = 'moderate'; label = 'Progresseur modéré';
      advice = 'Rythme classique. Incréments de +1,25 kg et deload toutes les 5-6 semaines.';
    } else if (avgSlope >= 0) {
      type = 'slow'; label = 'Progresseur lent / spécifique';
      advice = 'Micro-progressions de +0,5 kg, cycles plus longs. Privilégie le perfectionnement technique avant l\'augmentation de charge.';
    } else {
      type = 'regressing'; label = 'Régression détectée';
      advice = 'Ton 1RM moyen baisse — fatigue accumulée probable. Une semaine deload + nuit de meilleur sommeil avant de reprendre.';
    }
    if (confidence === 'low') {
      label += ' (estimation préliminaire)';
      advice = 'Estimation précoce — ' + advice.charAt(0).toLowerCase() + advice.slice(1) +
               ' La classification se précisera après 8 semaines de logs réguliers.';
    }
    return {
      type, slope: +avgSlope.toFixed(2), sample: slopes.length,
      confidence, weeksCovered: maxSpanWeeks,
      label, advice,
    };
  }

  // loadStepForResponder — incrément de charge à appliquer dans la prochaine
  // tentative d'overload. Ne touche pas aux warm-ups, juste aux sets de travail.
  function loadStepForResponder(type) {
    switch (type) {
      case 'fast':       return 2.5;
      case 'moderate':   return 1.25;
      case 'slow':       return 0.5;
      case 'regressing': return 0;     // on ne progresse pas en régression
      default:           return 1.25;
    }
  }


  /* ============================================================
   * EXPORT
   * ============================================================ */
  window.Programming = {
    // Brique 1
    VOLUME_LANDMARKS,
    weeklyVolumeByZone,
    personalizeLandmarks,
    landmarksFor,
    landmarkStatus,
    // Brique 2
    PHASES,
    PHASE_BY_WEEK,
    currentBlockState,
    adaptiveBlockOverride,
    blockMods,
    recentRpeAvg,
    // Brique 3
    PATTERN_MAP,
    GOAL_RANGES,
    DEFAULT_RANGES,
    effectiveRanges,
    inferPattern,
    auditPatternCoverage,
    weeklyVolumeByPattern,
    imbalanceReport,
    // Brique 4
    KEY_LIFTS,
    pickKeyLifts,
    classifyResponder,
    loadStepForResponder,
  };
})();
