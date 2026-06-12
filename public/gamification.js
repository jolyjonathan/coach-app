/* =============================================================
 * Coach Adaptatif — gamification.js
 * =============================================================
 * Moteur XP / niveaux / streak / records / mascotte. EXTRAIT d'app.js
 * (audit modularite, action 6 — premiere brique du decoupage par
 * domaine). Fonctions pures sur l'historique, sans DOM : les renderers
 * (renderBadges, renderGamification) restent dans app.js.
 * Charge AVANT app.js (portee globale partagee, scripts classiques).
 * ============================================================= */

/* =================== GAMIFICATION ENGINE =================== */
// XP sources: fixed 100/session + volume/10 + form bonus (reaction/tap) + streak multiplier.
function computeXP(history) {
  if (!history || history.length === 0) return 0;
  let total = 0;
  // Group by ISO date for streak bonus application per day.
  const byDate = {};
  for (const h of history) {
    const d = (h.date || '').slice(0, 10);
    (byDate[d] ||= []).push(h);
  }
  const dates = Object.keys(byDate).sort();
  let streak = 0, prev = null;
  for (const d of dates) {
    if (prev) {
      const diff = (new Date(d) - new Date(prev)) / 86400000;
      streak = diff <= 3 ? streak + 1 : 1;
    } else streak = 1;
    prev = d;
    const mult = streak >= 5 ? 1.5 : (streak >= 3 ? 1.2 : 1);
    for (const h of byDate[d]) {
      let xp = 100;
      const vol = (h.sets || []).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
      xp += Math.min(300, Math.round(vol / 10));
      // form bonus: fast reaction + fast tap.
      if (h.aggReactionMs != null && h.aggReactionMs < 450) xp += 25;
      if (h.aggTapMs != null && h.aggTapMs < 600) xp += 25;
      // perfect session: RPE <= 7 and no pain.
      if (h.rpe <= 7 && (!h.pains || h.pains.length === 0)) xp += 15;
      total += Math.round(xp * mult);
    }
  }
  return total;
}

// Level curve — more xp needed per level.
function xpForLevel(n) { return Math.round(150 * n * (n + 1) / 2); }
function computeLevel(xp) {
  let lv = 1;
  while (xp >= xpForLevel(lv + 1)) lv++;
  return lv;
}
function levelInfo(xp) {
  const lv = computeLevel(xp);
  const curBase = xpForLevel(lv);
  const nextBase = xpForLevel(lv + 1);
  const into = xp - curBase;
  const span = nextBase - curBase;
  return { level: lv, xp, into, span, pct: Math.round(100 * into / span) };
}
const LEVEL_NAMES = [
  'Débutant',         // 1
  'Apprenti',         // 2
  'Régulier',         // 3
  'Motivé',           // 4
  'Déterminé',        // 5
  'Guerrier',         // 6
  'Athlète',          // 7
  'Vétéran',          // 8
  'Machine',          // 9
  'Champion',         // 10
  'Légende',          // 11+
];
function levelName(lv) {
  return LEVEL_NAMES[Math.min(lv - 1, LEVEL_NAMES.length - 1)];
}

// Streak = consecutive DAYS (or 3-day-tolerant "semaine active") with a session.
function computeStreak(history) {
  if (!history || history.length === 0) return 0;
  const dates = [...new Set(history.map(h => (h.date || '').slice(0, 10)))].sort();
  if (dates.length === 0) return 0;
  const lastDay = dates[dates.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const gap = (new Date(today) - new Date(lastDay)) / 86400000;
  if (gap > 3) return 0;
  let s = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    const diff = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
    if (diff <= 3) s++; else break;
  }
  return s;
}

// computeRollingTarget — modèle « dette de séance » plutôt que streak strict.
// Adapté aux emplois du temps imprévisibles : on ne casse pas un compteur
// quand la personne saute un jour, on regarde combien de séances ont été
// faites sur une fenêtre glissante.
//
// history     : array S.history.
// targetCount : objectif (ex: 6 séances).
// windowDays  : taille de la fenêtre glissante en jours (ex: 14).
//
// Retourne :
//   completed : nombre de jours distincts avec séance dans la fenêtre.
//   target    : copie du targetCount.
//   pct       : ratio completed/target capé à 1.
//   status    : 'ahead' (≥100%), 'on-track' (≥ pace attendu), 'behind' sinon.
//   pace      : completed attendus à ce stade de la fenêtre (utile pour UI).
//
// La pace attendue est target * (windowDays/windowDays) = target en fin de
// fenêtre. À mi-fenêtre on attend 50%. On compare completed à pace.
function computeRollingTarget(history, targetCount, windowDays) {
  targetCount = Math.max(1, targetCount || 1);
  windowDays = Math.max(1, windowDays || 14);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const cutoff = new Date(today.getTime() - (windowDays - 1) * 86400000);
  cutoff.setHours(0, 0, 0, 0);
  const seen = new Set();
  for (const h of (history || [])) {
    const t = Date.parse(h.date || '');
    if (Number.isNaN(t)) continue;
    if (t < cutoff.getTime() || t > today.getTime()) continue;
    seen.add((h.date || '').slice(0, 10));
  }
  const completed = seen.size;
  // Pace attendu = même taux constant sur la fenêtre. Pour 14j et 6 cibles,
  // pace = 6 partout en fin de fenêtre. L'utilisateur compare "X aujourd'hui
  // vs Y attendus" — pas de pénalité si la fenêtre n'est pas finie.
  const pace = targetCount;
  const pct = Math.min(1, completed / targetCount);
  let status;
  if (completed >= targetCount) status = 'ahead';
  else if (completed >= targetCount * 0.5) status = 'on-track';
  else status = 'behind';
  return { completed, target: targetCount, pct, status, pace, windowDays };
}

// rollingWindowConfig — dérive la cible et la fenêtre depuis le profil.
// freq=3 → cible=6 sur 14j (un cycle de 2 semaines). On expose la fonction
// pour qu'une future option utilisateur puisse y brancher des valeurs perso.
function rollingWindowConfig(profile) {
  const freq = (profile && +profile.freq) || 3;
  return {
    targetCount: freq * 2,   // 2 semaines à la fréquence cible
    windowDays: 14,
  };
}

// Count of PRs across all exercises.
function countPRs(history) {
  const best = {};
  let prs = 0;
  for (const h of history) {
    if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
    for (const s of (h.sets || [])) {
      if (!s.exoId) continue;
      const key = s.exoId;
      const e = EX_BY_ID[key];
      if (!e) continue;
      const score = e.timed ? (s.heldSecs ?? s.reps ?? 0) : (s.weight || 0) * (s.reps || 0);
      if (best[key] == null) { best[key] = score; continue; }
      if (score > best[key]) { prs++; best[key] = score; }
    }
  }
  return prs;
}

// Achievement catalog. Each `check(S)` returns true once earned.
function computeAchievements() {
  const h = S.history || [];
  const total = h.length;
  const minReact = h.map(x => x.aggReactionMs).filter(x => x != null).reduce((m, v) => Math.min(m, v), 9999);
  const streak = computeStreak(h);
  const prs = countPRs(h);
  return [
    { id: 'first',    icon: '🔥', title: 'Première',   sub: 'Séance 1',    earned: total >= 1 },
    { id: 's5',       icon: '💪', title: '5 séances',  sub: 'On est sérieux', earned: total >= 5 },
    { id: 's10',      icon: '🏋️', title: '10 séances', sub: 'Régulier',    earned: total >= 10 },
    { id: 's25',      icon: '⭐', title: '25 séances', sub: 'Machine',     earned: total >= 25 },
    { id: 'pr1',      icon: '🏆', title: 'Premier PR', sub: 'Record battu', earned: prs >= 1 },
    { id: 'pr5',      icon: '👑', title: '5 PRs',      sub: 'En pleine progression', earned: prs >= 5 },
    { id: 'react',    icon: '⚡', title: 'Réflexe',    sub: '< 300ms',     earned: minReact < 300 },
    { id: 'streak3',  icon: '🎯', title: 'Streak 3',   sub: '3 séances d\'affilée', earned: streak >= 3 },
    { id: 'streak7',  icon: '🚀', title: 'Streak 7',   sub: '7 séances d\'affilée', earned: streak >= 7 },
  ];
}

/* =================== MASCOT (inline SVG, scales with level) =================== */
// 5 visual stages based on level bucket. Colors from Telix palette.
function mascotStage(level) {
  if (level >= 10) return 4;
  if (level >= 7)  return 3;
  if (level >= 4)  return 2;
  if (level >= 2)  return 1;
  return 0;
}
function renderMascot(level) {
  const stage = mascotStage(level);
  // torso width, arm thickness, bicep bulge — grow with stage.
  const torso = 38 + stage * 6;       // 38..62
  const armW  = 10 + stage * 3;       // 10..22
  const bicep = 6 + stage * 2.5;      // 6..16
  const neck  = 12 + stage;           // 12..16
  const eyebrows = stage >= 2;
  // Progression neutre → bleu → ambre (récompense au niveau max).
  const hue = ['#c8cde0','#7a8098','#4a6bb0','#26408b','#e8954d'][stage];
  const skin = '#ffd7a8';
  const shadow = 'rgba(0,0,0,0.2)';
  return `<svg viewBox="0 0 140 180" width="140" height="180" xmlns="http://www.w3.org/2000/svg">
    <!-- shadow -->
    <ellipse cx="70" cy="170" rx="36" ry="4" fill="${shadow}"/>
    <!-- legs -->
    <rect x="${70-16}" y="125" width="13" height="40" rx="6" fill="${hue}"/>
    <rect x="${70+3}"  y="125" width="13" height="40" rx="6" fill="${hue}"/>
    <!-- torso -->
    <path d="M ${70-torso/2} 75
             Q 70 ${65 - stage*2} ${70+torso/2} 75
             L ${70+torso/2-6} 130
             Q 70 135 ${70-torso/2+6} 130 Z"
          fill="${hue}"/>
    <!-- chest line -->
    <path d="M ${70-torso/2+8} 92 Q 70 ${92+stage} ${70+torso/2-8} 92"
          stroke="rgba(0,0,0,0.18)" stroke-width="1.5" fill="none"/>
    <!-- abs -->
    ${stage >= 2 ? `<line x1="70" y1="98" x2="70" y2="126" stroke="rgba(0,0,0,0.22)" stroke-width="1.3"/>
    <line x1="${70-10}" y1="108" x2="${70+10}" y2="108" stroke="rgba(0,0,0,0.22)" stroke-width="1.3"/>
    <line x1="${70-10}" y1="118" x2="${70+10}" y2="118" stroke="rgba(0,0,0,0.22)" stroke-width="1.3"/>` : ''}
    <!-- arms (L) -->
    <path d="M ${70-torso/2+2} 78
             Q ${70-torso/2-bicep} 95 ${70-torso/2-2} 115
             L ${70-torso/2+armW-2} 115
             Q ${70-torso/2+armW-bicep} 95 ${70-torso/2+armW+2} 78 Z"
          fill="${skin}"/>
    <!-- arms (R) -->
    <path d="M ${70+torso/2-2} 78
             Q ${70+torso/2+bicep} 95 ${70+torso/2+2} 115
             L ${70+torso/2-armW+2} 115
             Q ${70+torso/2-armW+bicep} 95 ${70+torso/2-armW-2} 78 Z"
          fill="${skin}"/>
    <!-- neck -->
    <rect x="${70-neck/2}" y="58" width="${neck}" height="14" fill="${skin}"/>
    <!-- head -->
    <circle cx="70" cy="45" r="20" fill="${skin}"/>
    <!-- hair -->
    <path d="M 52 38 Q 70 22 88 38 Q 86 30 70 28 Q 54 30 52 38 Z" fill="#1d1b17"/>
    <!-- eyes -->
    <circle cx="63" cy="46" r="2" fill="#1d1b17"/>
    <circle cx="77" cy="46" r="2" fill="#1d1b17"/>
    ${eyebrows ? `<path d="M 58 42 L 67 40" stroke="#1d1b17" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M 73 40 L 82 42" stroke="#1d1b17" stroke-width="1.8" stroke-linecap="round"/>` : ''}
    <!-- mouth -->
    ${stage >= 3
      ? `<path d="M 62 54 Q 70 60 78 54" stroke="#1d1b17" stroke-width="2" fill="none" stroke-linecap="round"/>`
      : `<path d="M 64 54 Q 70 57 76 54" stroke="#1d1b17" stroke-width="1.8" fill="none" stroke-linecap="round"/>`}
    ${stage === 4 ? `<!-- champion cape/star -->
      <text x="100" y="30" font-size="18">⭐</text>
      <text x="30" y="30" font-size="18">⭐</text>` : ''}
  </svg>`;
}
