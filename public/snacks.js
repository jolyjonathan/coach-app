/* =============================================================
 * Coach Adaptatif — Snack Workouts
 * =============================================================
 *
 * Bibliothèque de mini-routines de 4-15 minutes pour les fenêtres
 * de temps imprévues. Chaque snack pointe sur des exos déjà connus
 * (EX_BY_ID dans app.js) ou sur des exos rééduc (Rehab.EXERCISE_BY_ID)
 * pour la mobilité/cervicales — afin que le viewer de détail technique
 * fonctionne sans duplication.
 *
 * Modèle d'exo dans un snack :
 *   { ref, sets, reps, rest, timed?, label? }
 *     ref     — id pointant vers EX_BY_ID ou Rehab.EXERCISE_BY_ID.
 *     label   — override du nom affiché (sinon on tire le nom de la lib).
 *     timed   — true = la « rep » est en secondes (gainage, wall sit).
 *
 * Les snacks sont marqués comme kind:'snack' sur S.currentSession pour
 * que le reste de l'app sache que ce n'est pas une séance « formelle »
 * (pas de PR à tracker, pas d'ajustement d'algo).
 *
 * Chargé AVANT app.js dans index.html.
 * ============================================================= */
(function () {
  'use strict';

  // Catégories pour le picker. Chaque snack en a une — on regroupe le
  // picker visuellement.
  const CATEGORIES = [
    { id: 'mobilite',    label: '🌅 Mobilité',          desc: 'Démarrer la journée, casser une longue position assise' },
    { id: 'force_pdc',   label: '💪 Force express',     desc: 'Push / pull / jambes au poids du corps' },
    { id: 'gainage',     label: '🪨 Gainage',           desc: 'Sangle abdo et stabilité du tronc' },
    { id: 'cardio',      label: '🔥 Cardio',            desc: 'Boost cardio rapide, intensité élevée' },
    { id: 'fullbody',    label: '🌍 Full body',         desc: 'Tout le corps en une seule routine' },
    { id: 'recup',       label: '😌 Récup / soir',      desc: 'Détente, mobilité douce, avant-coucher' },
  ];

  const SNACKS = [
    // --- MOBILITÉ ---
    {
      id: 'snack-wake-mobility', name: 'Réveil mobilité', category: 'mobilite',
      duration: 4, gear: 'aucun',
      desc: '4 min pour dérouiller la colonne et les hanches au réveil.',
      exos: [
        { ref: 'reh-dos-cat-camel', sets: 1, reps: 10, rest: 0 },
        { ref: 'reh-hanche-9090', sets: 1, reps: 6, rest: 10 },
        { ref: 'reh-cervicales-mobilite', sets: 1, reps: 8, rest: 0 },
      ],
    },
    {
      id: 'snack-desk-break', name: 'Pause bureau', category: 'mobilite',
      duration: 5, gear: 'aucun',
      desc: 'Anti-position assise — décharge dos, épaules, cervicales.',
      exos: [
        { ref: 'reh-cervicales-chin-tuck', sets: 2, reps: 6, rest: 10, timed: true },
        { ref: 'reh-pectoral-etire-porte', sets: 2, reps: 30, rest: 10, timed: true },
        { ref: 'reh-dos-cat-camel', sets: 1, reps: 10, rest: 0 },
        { ref: 'reh-hanche-9090', sets: 1, reps: 6, rest: 0 },
      ],
    },
    {
      id: 'snack-bedtime-stretch', name: 'Avant le coucher', category: 'recup',
      duration: 7, gear: 'aucun',
      desc: 'Détente musculaire douce — favorise l\'endormissement.',
      exos: [
        { ref: 'reh-dos-cat-camel', sets: 1, reps: 10, rest: 0 },
        { ref: 'reh-pectoral-etire-porte', sets: 2, reps: 30, rest: 10, timed: true },
        { ref: 'reh-hanche-clamshell', sets: 2, reps: 12, rest: 15 },
        { ref: 'reh-cervicales-mobilite', sets: 1, reps: 8, rest: 0 },
      ],
    },

    // --- FORCE EXPRESS ---
    {
      id: 'snack-push-express', name: 'Push express', category: 'force_pdc',
      duration: 8, gear: 'pdc',
      desc: '3 exos de poussée — pectoraux, épaules, triceps. Rien que le corps.',
      exos: [
        { ref: 'pompes', sets: 3, reps: 12, rest: 45 },
        { ref: 'pikepush', sets: 3, reps: 8, rest: 45 },
        { ref: 'pompediam', sets: 2, reps: 10, rest: 30 },
      ],
    },
    {
      id: 'snack-pull-express', name: 'Pull express', category: 'force_pdc',
      duration: 8, gear: 'élastiques ou TRX',
      desc: 'Tirage horizontal — équilibre la posture après une journée à l\'écran.',
      exos: [
        { ref: 'invrow', sets: 3, reps: 10, rest: 45 },
        { ref: 'rowelast', sets: 3, reps: 12, rest: 30 },
        { ref: 'facepull', sets: 2, reps: 15, rest: 30 },
      ],
    },
    {
      id: 'snack-legs-express', name: 'Jambes express', category: 'force_pdc',
      duration: 10, gear: 'pdc',
      desc: 'Quadris + fessiers + mollets, tout au poids du corps.',
      exos: [
        { ref: 'squat', sets: 3, reps: 15, rest: 45 },
        { ref: 'fentes', sets: 3, reps: 10, rest: 45 },
        { ref: 'mollet', sets: 2, reps: 20, rest: 30 },
      ],
    },
    {
      id: 'snack-glute-burner', name: 'Fessiers feu', category: 'force_pdc',
      duration: 8, gear: 'pdc',
      desc: 'Spécial fessier — utile post journée assise.',
      exos: [
        { ref: 'gluteb', sets: 3, reps: 15, rest: 30 },
        { ref: 'reh-hanche-clamshell', sets: 3, reps: 15, rest: 20 },
        { ref: 'bulgare', sets: 2, reps: 8, rest: 45 },
      ],
    },
    {
      // Petersen 2011 (Am J Sports Med) : RCT chez 942 footeurs danois.
      // 3×10 eccentric 2×/sem → -70% d'incidence de claquage ischios sur 9 mois.
      // Méta-analyse van Dyk 2019 (Br J Sports Med) confirme : -51% sur 14 RCT.
      // À faire EN PRÉVENTIF, idéalement séparé d'au moins 48h d'une grosse séance
      // jambes — les courbatures eccentriques sont massives la première semaine.
      id: 'snack-nordic-hams', name: 'Nordic Hamstring (prévention)', category: 'force_pdc',
      duration: 6, gear: 'ancrage',
      desc: 'Petersen 2011 — protocole anti-claquage ischios validé RCT.',
      exos: [
        { ref: 'nordic', sets: 3, reps: 6, rest: 90 },
      ],
    },

    // --- GAINAGE ---
    {
      id: 'snack-core-quick', name: 'Gainage 8 min', category: 'gainage',
      duration: 8, gear: 'pdc',
      desc: 'Sangle abdominale et stabilité — 4 exos en circuit.',
      exos: [
        { ref: 'gainage', sets: 3, reps: 30, rest: 20, timed: true },
        { ref: 'sideplank', sets: 2, reps: 25, rest: 20, timed: true },
        { ref: 'deadbug', sets: 2, reps: 10, rest: 20 },
        { ref: 'hollow', sets: 2, reps: 20, rest: 20, timed: true },
      ],
    },
    {
      id: 'snack-back-resilience', name: 'Dos solide', category: 'gainage',
      duration: 6, gear: 'pdc',
      desc: 'Renforce les paravertébraux — anti-mal de dos.',
      exos: [
        { ref: 'birddog', sets: 3, reps: 8, rest: 20 },
        { ref: 'superman', sets: 2, reps: 12, rest: 20 },
        { ref: 'gainage', sets: 2, reps: 30, rest: 20, timed: true },
      ],
    },

    // --- CARDIO ---
    {
      id: 'snack-hiit-12', name: 'HIIT 12 min', category: 'cardio',
      duration: 12, gear: 'pdc',
      desc: 'Cardio haute intensité — 4 cycles de 30s effort / 30s repos.',
      exos: [
        { ref: 'burpee', sets: 4, reps: 30, rest: 30, timed: true },
        { ref: 'jumpsquat', sets: 4, reps: 30, rest: 30, timed: true },
        { ref: 'mountain', sets: 4, reps: 30, rest: 30, timed: true },
        { ref: 'highknee', sets: 4, reps: 30, rest: 30, timed: true },
      ],
    },
    {
      id: 'snack-quick-cardio', name: 'Cardio express', category: 'cardio',
      duration: 6, gear: 'pdc',
      desc: 'Boost cardio en 6 min, idéal entre deux réunions.',
      exos: [
        { ref: 'jumpsquat', sets: 3, reps: 20, rest: 20 },
        { ref: 'mountain', sets: 3, reps: 30, rest: 20, timed: true },
        { ref: 'highknee', sets: 2, reps: 30, rest: 20, timed: true },
      ],
    },

    // --- FULL BODY ---
    {
      id: 'snack-fullbody-15', name: 'Full body 15 min', category: 'fullbody',
      duration: 15, gear: 'pdc',
      desc: 'Tout le corps en circuit — push, pull, jambes, gainage.',
      exos: [
        { ref: 'squat', sets: 3, reps: 12, rest: 30 },
        { ref: 'pompes', sets: 3, reps: 10, rest: 30 },
        { ref: 'invrow', sets: 3, reps: 10, rest: 30 },
        { ref: 'gainage', sets: 2, reps: 30, rest: 30, timed: true },
      ],
    },
    {
      id: 'snack-fullbody-10', name: 'Full body éclair', category: 'fullbody',
      duration: 10, gear: 'pdc',
      desc: '3 exos polyarticulaires — version courte du full body.',
      exos: [
        { ref: 'squat', sets: 3, reps: 15, rest: 30 },
        { ref: 'pompes', sets: 3, reps: 10, rest: 30 },
        { ref: 'invrow', sets: 2, reps: 12, rest: 30 },
      ],
    },
  ];

  // Index pour accès rapide.
  const SNACK_BY_ID = Object.fromEntries(SNACKS.map(s => [s.id, s]));

  // Résolution du nom d'un exo référencé. Cherche d'abord dans Rehab
  // (préfixe `reh-`), puis dans EX_BY_ID. Si non trouvé, retourne le label
  // explicite (les snacks bien formés ne devraient pas tomber là).
  function resolveExoName(ref, fallback) {
    if (typeof ref === 'string') {
      if (ref.startsWith('reh-') && window.Rehab && window.Rehab.EXERCISE_BY_ID[ref]) {
        return window.Rehab.EXERCISE_BY_ID[ref].n;
      }
      // EX_BY_ID est défini dans app.js (chargé après snacks.js). On y
      // accède via window pour ne pas créer de dépendance d'ordre forte.
      if (window.EX_BY_ID && window.EX_BY_ID[ref]) {
        return window.EX_BY_ID[ref].n;
      }
    }
    return fallback || ref || '?';
  }

  // adaptToSession transforme un snack en objet currentSession compatible
  // avec renderNext()/viewSession. La séance est tagguée kind:'snack' pour
  // que les autres modules (algo, history) la traitent différemment.
  function adaptToSession(snackId) {
    const s = SNACK_BY_ID[snackId];
    if (!s) return null;
    const exos = (s.exos || []).map(e => ({
      id: e.ref,
      name: resolveExoName(e.ref, e.label),
      sets: e.sets || 3,
      reps: e.reps || 10,
      rest: e.rest != null ? e.rest : 30,
      timed: !!e.timed,
      weight: null,
      reason: e.timed ? `Tenue / format chrono` : null,
    }));
    return {
      id: 'snack-' + s.id + '-' + Date.now(),
      date: new Date().toISOString(),
      kind: 'snack',
      title: `🥪 ${s.name} · ${s.duration} min`,
      groups: [s.category],
      rotIdx: 0,
      exos,
      sets: [],
      snackId: s.id,
      snackDuration: s.duration,
      snackDesc: s.desc,
    };
  }

  window.Snacks = {
    CATEGORIES,
    SNACKS,
    SNACK_BY_ID,
    adaptToSession,
    resolveExoName,
  };
})();
