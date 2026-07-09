/* Coach Adaptatif — frontend SPA.
 * Data lives on the server (per-user JSON file). This client is a thin UI over
 * /api/data with optimistic local state + debounced PUTs.
 *
 * Timing philosophy:
 *   - Rep exercise: user logs reps/poids → beep aléatoire post-effort (mesure
 *     fatigue neuro aiguë) → tap test → repos silencieux avec tintement.
 *   - Exo chronométré (planche, gainage) : décompte → beep à 0 → user stoppe
 *     = mesure de fatigue au pic d'effort. Puis tap + repos.
 */
'use strict';

/* =================== API CLIENT =================== */
// getCookie / csrfToken / escapeHtml vivent dans core.js (audit action 3).

/* =================== MODAL SYSTEM (a11y) =================== */
// Replaces the 17 native prompt/alert/confirm calls. Pattern matches what
// WAI-ARIA Authoring Practices recommends for a modal dialog:
//   - role="dialog" aria-modal="true"
//   - aria-labelledby points at the title
//   - focus moves to the first focusable element on open
//   - focus is restored to the trigger element on close
//   - Tab/Shift+Tab cycles within the dialog (focus trap)
//   - ESC closes (resolves with the cancel value)
//   - Click outside the card resolves cancel (non-critical only)
//
// All four flavours go through openModal(opts) and return a Promise:
//   alert      → openAlert(title, message)              → Promise<void>
//   confirm    → openConfirm(title, message, [opts])    → Promise<bool>
//   prompt     → openPrompt(title, message, [opts])     → Promise<string|null>
//   custom     → openModal({title, body, fields, buttons, critical})
function openModal(opts) {
  return new Promise((resolve) => {
    const title    = opts.title || '';
    const bodyHtml = opts.body || '';
    const fields   = opts.fields || [];
    const buttons  = opts.buttons || [{label:'OK', value:true, primary:true}];
    const critical = !!opts.critical;
    const trigger  = document.activeElement;

    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const titleId = 'modalT_' + Math.random().toString(36).slice(2, 8);

    // Build form fields if any.
    const fieldsHtml = fields.map(f => {
      const id = 'modalF_' + Math.random().toString(36).slice(2, 8);
      f._id = id;
      const t = f.type || 'text';
      const ac = f.autocomplete ? `autocomplete="${f.autocomplete}"` : '';
      const ph = f.placeholder ? `placeholder="${f.placeholder}"` : '';
      const val = f.value != null ? `value="${String(f.value).replace(/"/g, '&quot;')}"` : '';
      const inputmode = f.inputmode ? `inputmode="${f.inputmode}"` : '';
      return `<div class="field">
        <label for="${id}">${f.label}</label>
        ${f.tag === 'textarea'
          ? `<textarea id="${id}" ${ph}>${f.value || ''}</textarea>`
          : `<input id="${id}" type="${t}" ${ac} ${ph} ${val} ${inputmode}>`}
      </div>`;
    }).join('');

    back.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <h2 id="${titleId}">${title}</h2>
        ${bodyHtml ? `<div class="modal-body">${bodyHtml}</div>` : ''}
        ${fieldsHtml}
        <p class="err" role="alert" id="modalErr"></p>
        <div class="modal-actions"></div>
      </div>`;

    // Build buttons. Last button is wired as primary (Enter activates).
    const card = back.querySelector('.modal-card');
    const errEl = back.querySelector('#modalErr');
    const actions = back.querySelector('.modal-actions');
    const btnEls = buttons.map((b, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      if (b.primary) el.classList.add('magenta');
      else if (b.danger) el.classList.add('ko');
      else el.classList.add('sec');
      el.addEventListener('click', () => settle(b));
      actions.appendChild(el);
      return el;
    });

    function settle(button) {
      // Validate fields before resolving.
      const data = {};
      for (const f of fields) {
        const el = back.querySelector('#' + f._id);
        const v = (el.value || '').trim();
        if (button.value !== false && f.required && !v) {
          errEl.textContent = `« ${f.label} » est requis.`;
          el.focus();
          return;
        }
        data[f.name || f._id] = v;
      }
      cleanup();
      // Resolution shape:
      //  - confirm/alert  → button.value (bool / undefined)
      //  - prompt (1 field) → field value or null on cancel
      //  - custom        → { value, fields }
      if (button.value === false) {
        if (fields.length === 1) resolve(null);
        else if (buttons.length <= 2) resolve(false);
        else resolve({ value: button.value, fields: data });
      } else {
        if (fields.length === 1) resolve(Object.values(data)[0]);
        else if (buttons.length <= 2 && fields.length === 0) resolve(button.value);
        else resolve({ value: button.value, fields: data });
      }
    }

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      // Restore focus to whatever element opened the dialog. Defensive: it
      // may have been removed from the DOM (rare), in which case we fall
      // back to <main>.
      if (trigger && document.body.contains(trigger)) trigger.focus();
      else document.getElementById('mainContent')?.focus();
    }

    function focusables() {
      return back.querySelectorAll(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
      );
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        if (critical) return; // Critical dialogs require explicit choice.
        const cancelBtn = buttons.find(b => b.value === false);
        if (cancelBtn) { e.preventDefault(); settle(cancelBtn); }
        else { e.preventDefault(); cleanup(); resolve(null); }
        return;
      }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        // Enter activates the primary button — unless focus is on a non-
        // primary button (don't override an explicit choice).
        if (e.target.tagName === 'BUTTON' && !e.target.classList.contains('magenta')) return;
        const primary = buttons.find(b => b.primary) || buttons[buttons.length - 1];
        e.preventDefault();
        settle(primary);
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap. Cycle within the dialog.
        const items = Array.from(focusables());
        if (items.length === 0) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }

    // Click outside the card → cancel (unless critical).
    back.addEventListener('click', (e) => {
      if (critical) return;
      if (e.target === back) {
        const cancelBtn = buttons.find(b => b.value === false);
        if (cancelBtn) settle(cancelBtn);
      }
    });

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);

    // Hook optionnel après insertion DOM — pour câbler des boutons custom
    // dans le body (ex. copier/télécharger les codes de récupération).
    if (typeof opts.onRender === 'function') {
      try { opts.onRender(card); } catch (_) { /* best-effort */ }
    }

    // Initial focus: first field if any, else primary button.
    const initial = back.querySelector('input, textarea')
                 || btnEls.find((_, i) => buttons[i].primary)
                 || btnEls[btnEls.length - 1];
    if (initial) initial.focus();
  });
}

// Convenience wrappers — mirror the native APIs so callsites read clearly.
function openAlert(title, message) {
  return openModal({
    title,
    body: message ? `<p>${message}</p>` : '',
    buttons: [{ label: 'OK', value: true, primary: true }],
  });
}
function openConfirm(title, message, opts) {
  opts = opts || {};
  return openModal({
    title,
    body: message ? `<p>${message}</p>` : '',
    critical: !!opts.critical,
    buttons: [
      { label: opts.cancelLabel || 'Annuler', value: false },
      { label: opts.confirmLabel || 'Confirmer', value: true,
        primary: !opts.danger, danger: !!opts.danger },
    ],
  });
}
function openPrompt(title, message, opts) {
  opts = opts || {};
  return openModal({
    title,
    body: message ? `<p>${message}</p>` : '',
    fields: [{
      label: opts.label || 'Réponse',
      type: opts.type || 'text',
      autocomplete: opts.autocomplete,
      placeholder: opts.placeholder,
      value: opts.defaultValue || '',
      inputmode: opts.inputmode,
      required: opts.required !== false,
    }],
    buttons: [
      { label: opts.cancelLabel || 'Annuler', value: false },
      { label: opts.confirmLabel || 'Valider', value: true, primary: true },
    ],
  });
}

/* =================== TOAST + HAPTIC =================== */
// showToast — non-bloquant, auto-dismiss. Pour les "OK ça a marché" qu'on
// ne veut pas faire stopper l'utilisateur. Les actions critiques (delete,
// password change) restent en modal.
//
// Usage:
//   showToast('Mot de passe changé');
//   showToast('Erreur réseau', { variant: 'error', message: e.message });
//   showToast('Hors ligne', { variant: 'info', duration: 6000 });
function showToast(title, opts) {
  opts = opts || {};
  const variant = opts.variant || 'success';   // success|error|info
  const duration = opts.duration != null ? opts.duration : 3500;
  const message = opts.message || '';

  const stack = document.getElementById('toastStack');
  if (!stack) return;

  // Cap simultaneous toasts — plus que 4 on dégomme le plus ancien.
  while (stack.children.length >= 4) stack.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  // Icône selon variant. Glyphes Unicode légers (pas d'emoji pour cohérence).
  const icons = { success: '✓', error: '!', info: 'i' };
  el.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[variant] || '•'}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      ${message ? '<div class="toast-msg"></div>' : ''}
    </div>
    <button class="toast-close" type="button" aria-label="Fermer la notification">×</button>`;
  el.querySelector('.toast-title').textContent = title;
  if (message) el.querySelector('.toast-msg').textContent = message;

  const dismiss = () => {
    if (!el.parentNode) return;
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  stack.appendChild(el);

  // Errors stick around longer; pas d'auto-dismiss si duration === 0.
  if (duration > 0) {
    setTimeout(dismiss, variant === 'error' ? Math.max(duration, 5000) : duration);
  }
  return dismiss;
}

// haptic — wrapper sécurisé sur navigator.vibrate. Pas dispo sur iOS Safari
// mais on dégrade silencieusement. Patterns en ms : un nombre ou un tableau
// (vibration, pause, vibration, …).
function haptic(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) {}
}
// Patterns réutilisables — gardent l'app cohérente.
const HAPTIC = {
  tap:        15,                 // tap léger (validation rapide)
  set:        [25, 30, 25],       // série terminée — double tap
  restEnd:    [50, 80, 50, 80, 100], // fin de repos — pulse pulse pulse
  achievement:[20, 40, 20, 40, 20, 40, 80], // badge gagné
  error:      [80],
};

async function api(method, path, body) {
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // CSRF: double-submit — echo the cookie value in a header on writes.
  if (method !== 'GET' && method !== 'HEAD') {
    // Audit M-03 : sur HTTPS le cookie est nommé __Host-coach_csrf
    // (durcissement préfixe). On lit les deux noms en fallback.
    const t = csrfToken();
    if (t) headers['X-CSRF-Token'] = t;
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (netErr) {
    // Hard fetch failure — browser couldn't reach anything, not even the SW.
    setOffline(true);
    const e = new Error('offline');
    e.offline = true;
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    // Expose the parsed body so callers can react to structured signals
    // (e.g. login's {need2fa: true} challenge) without re-parsing.
    err.data = data;
    // The SW returns { offline: true } with 503 when we have no network. Use
    // it to show the banner without waiting for a hard fetch failure.
    if (data && data.offline) { err.offline = true; setOffline(true); }
    throw err;
  }
  // Le SW peut servir une copie cachée de /api/me ou /api/data quand on
  // est offline. Il marque la réponse avec X-Coach-Stale: 1 pour qu'on
  // sache qu'on n'est pas vraiment back online — on garde la bannière
  // offline et on ne marque pas le succès comme un round-trip réseau.
  if (res.headers.get('X-Coach-Stale') === '1') {
    setOffline(true);
    return data;
  }
  // Any successful round-trip means we're back online. Clear the banner.
  setOffline(false);
  return data;
}

// setOffline toggles the banner at the top of the page. Called from api() on
// network failures / synthetic offline 503, and from window online/offline
// events. Debounced at the DOM level — we only touch the class if it changed.
let _offline = false;
function setOffline(on) {
  if (on === _offline) return;
  _offline = on;
  const el = document.getElementById('offlineBar');
  if (el) el.classList.toggle('hide', !on);
}
window.addEventListener('online', () => setOffline(false));
window.addEventListener('offline', () => setOffline(true));

/* =================== STATE =================== */
// S mirrors the server-stored document. Never trust client to keep it
// consistent — the server whitelists top-level keys on save.
let S = { profile: null, history: [], currentSession: null, formScore: 70, adjustments: [], notes: {} };
let currentUserEmail = null;
let currentUserIsAdmin = false;
// currentUserAlgoOptOut mirrors User.AlgoOptOut from the server. When true,
// the home view hides generated adjustments — the user has exercised their
// Article 22 RGPD right to object to automated decisions. The toggle in
// the profile (Confidentialité & droits) flips this flag and POSTs to the
// server; this var keeps the cached state for sync rendering.
let currentUserAlgoOptOut = false;
// État 2FA / codes de récupération (miroir de /api/me) pour le rendu sync
// du panneau sécurité du profil.
let currentUser2faEnabled = false;
let currentUserRecoveryLeft = null;

// setAdminLinkVisible toggles the "🛡 admin" shortcut in the header. Pure UI —
// the server enforces admin authorization on every /api/admin/* call, so
// even if the link got shown by accident the user couldn't act on it.
function setAdminLinkVisible(on) {
  const el = document.getElementById('adminLink');
  if (el) el.classList.toggle('hide', !on);
}

/* =================== EXERCISE LIBRARY ===================
 * Deplacee dans exercises-data.js (audit modularite, action 4).
 * EX, EX_BY_ID, supportsWeight, capWeight... y sont definis et
 * partages via la portee globale. */

/* =================== VIDEO DEMOS ===================
 * Every exercise in EX can optionally set `yt: 'YOUTUBE_ID'` (the 11-char ID
 * from a youtube.com/watch?v=<ID> URL). When set, the detail view embeds the
 * video via youtube-nocookie.com (no tracking cookies until user hits play).
 * When not set, we fall back to a YouTube search link so the user always has
 * at least one way to find a demo.
 *
 * CSP whitelists only https://www.youtube-nocookie.com — other origins won't
 * frame. Regex validation on the ID protects against an ID slipping in that
 * would break out of the src= attribute. */
function ytEmbedUrl(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0&modestbranding=1';
}
// ytSearchUrl — recherche vidéo. Auparavant on pointait sur youtube.com/results
// (ce qui pose des cookies Google dès l'ouverture). On bascule sur DuckDuckGo
// images/videos qui ne pose pas de cookie tracker chez l'utilisateur. Le
// résultat liste des vidéos YouTube (et autres), donc l'utilisateur garde
// le choix de la source.
function ytSearchUrl(name) {
  return 'https://duckduckgo.com/?q=' +
         encodeURIComponent((name || '') + ' tutoriel technique') +
         '&ia=videos';
}

// renderVideoCard — affiche un placeholder cliquable au lieu d'un iframe live.
// Avant : l'iframe se chargeait dès le mount → IP + user-agent envoyés à
// Google sans intervention. Maintenant : thumbnail YouTube (img venant de
// i.ytimg.com déjà autorisé en CSP) + bouton play. L'iframe n'est créée
// qu'au clic explicite, ce qui satisfait l'esprit "no third-party contact
// without consent" du RGPD.
function renderVideoCard(e) {
  const searchUrl = ytSearchUrl(e.n);
  const embed = ytEmbedUrl(e.yt);
  if (embed && e.yt) {
    // Le thumbnail YouTube est servi par i.ytimg.com, déjà autorisé via
    // notre CSP img-src. Pas de cookie posé pour une simple image.
    const thumb = 'https://i.ytimg.com/vi/' + e.yt + '/hqdefault.jpg';
    return `
    <div class="card">
      <h2>Démonstration vidéo</h2>
      <div class="video-wrap" id="ytPlaceholder" data-yt-id="${escapeHtml(e.yt)}"
           style="position:relative;aspect-ratio:16/9;background:#000;border-radius:8px;
                  overflow:hidden;cursor:pointer">
        <img src="${escapeHtml(thumb)}" alt="Aperçu : ${escapeHtml(e.n)}"
             style="width:100%;height:100%;object-fit:cover;display:block;opacity:.85">
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
                    pointer-events:none">
          <div style="background:rgba(0,0,0,.65);width:64px;height:64px;border-radius:50%;
                      display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px">
            ▶
          </div>
        </div>
        <div style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.65);color:#fff;
                    padding:4px 8px;border-radius:4px;font-size:11px;line-height:1.3">
          Cliquer pour charger la vidéo (contacte YouTube)
        </div>
      </div>
      <p class="mt8" style="font-size:13px">
        <a href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener noreferrer">
          Voir d'autres démos (recherche DuckDuckGo) ↗
        </a>
      </p>
    </div>`;
  }
  return `
    <div class="card">
      <h2>Démonstration vidéo</h2>
      <p class="mut">Regarde la technique en vidéo (recherche via DuckDuckGo, sans cookies tiers).</p>
      <a class="btn" href="${escapeHtml(searchUrl)}"
         target="_blank" rel="noopener noreferrer">Chercher une démo ↗</a>
    </div>`;
}

// activateYouTubePlaceholder — remplace le placeholder par une iframe live
// au clic. Appelé après chaque rendu de exo detail (où le placeholder est
// inséré). Le clic est explicite donc on a le consentement RGPD-acceptable
// pour transmettre IP + user-agent à Google.
function activateYouTubePlaceholder() {
  const ph = document.getElementById('ytPlaceholder');
  if (!ph) return;
  ph.addEventListener('click', () => {
    const id = ph.dataset.ytId;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    const embed = ytEmbedUrl(id) + '&autoplay=1';
    ph.outerHTML = `
      <div class="video-wrap" style="aspect-ratio:16/9;border-radius:8px;overflow:hidden">
        <iframe src="${embed}"
                title="Démonstration"
                loading="lazy"
                referrerpolicy="no-referrer"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
                style="width:100%;height:100%;border:0"></iframe>
      </div>`;
  }, { once: true });
}

/* =================== VIEW ROUTING =================== */
const ALL_VIEWS = ['viewAuth','viewEnroll2FA','viewConsent','viewOnboarding','viewHome','viewSession','viewQuestion',
                   'viewHistory','viewTimer','viewTap','viewGuide','viewExerciseDetail','viewInsights',
                   'viewTrends','viewCoach'];

// Map view id → page title fragment. Used to keep document.title in sync
// with the current screen so screen-reader users hear the new context and
// browser history shows meaningful entries.
const VIEW_TITLES = {
  viewAuth:           'Connexion',
  viewEnroll2FA:      'Vérification 2 étapes',
  viewConsent:        'Consentement',
  viewOnboarding:     'Profil',
  viewHome:           'Aujourd\'hui',
  viewTrends:         'Tendances',
  viewCoach:          'Coach',
  viewSession:        'Séance',
  viewQuestion:       'Bilan',
  viewHistory:        'Historique',
  viewTimer:          'Repos',
  viewTap:            'Tap test',
  viewGuide:          'Guide',
  viewExerciseDetail: 'Exercice',
};

function show(id) {
  ALL_VIEWS.forEach(v => {
    const el = document.getElementById(v);
    if (el) {
      el.classList.add('hide');
      // Strip the entrance class on every hide so the animation re-fires
      // next time the view is shown. CSS animations don't replay on a
      // display:none toggle alone — we have to retrigger by class swap +
      // reflow (see below).
      el.classList.remove('view-enter');
    }
  });
  const target = document.getElementById(id);
  target.classList.remove('hide');
  // Force a reflow before re-adding the animation class. Without this the
  // browser collapses the remove/add into a no-op and the animation
  // doesn't replay on subsequent navigations.
  void target.offsetWidth;
  target.classList.add('view-enter');

  document.querySelectorAll('nav.bottom button[data-tab]').forEach(b => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });
  const map = {viewHome:'home', viewTrends:'trends', viewCoach:'coach', viewOnboarding:'onboarding',
               // viewHistory s'ouvre depuis Tendances → on garde l'onglet Tendances actif.
               viewHistory:'trends'};
  const tab = map[id];
  if (tab) {
    const b = document.querySelector(`nav.bottom button[data-tab="${tab}"]`);
    if (b) {
      b.classList.add('active');
      // aria-current="page" tells screen readers which tab is selected.
      // Cheaper than a full role=tablist/aria-controls dance and just as
      // conformant for navigation-style tab strips.
      b.setAttribute('aria-current', 'page');
    }
  }
  // Bottom nav stays hidden on auth-related screens (login, 2FA enrollment,
  // health-data consent gate) — those are blocking flows, the user must
  // complete or back out before they can navigate to the rest of the app.
  document.querySelector('nav.bottom').classList.toggle(
    'hide',
    id === 'viewAuth' || id === 'viewEnroll2FA' || id === 'viewConsent'
  );
  // Slide the nav pill under the active tab. Defer to next frame so the
  // tab's layout is measured *after* the nav.bottom .hide toggle above.
  requestAnimationFrame(positionNavPill);
  window.scrollTo(0, 0);

  // Keep document.title and main's tabindex hint in sync. Focusing main
  // on every view change is too aggressive (would steal focus from inputs
  // mid-typing), so we only do it when the change was triggered by a
  // bottom-nav tap — which we detect by main not currently being focused
  // on a child.
  const titleSuffix = VIEW_TITLES[id];
  if (titleSuffix) document.title = `${titleSuffix} · Coach Adaptatif`;
}

document.querySelectorAll('nav.bottom button[data-tab]').forEach(b => {
  b.addEventListener('click', () => {
    const t = b.dataset.tab;
    if (t === 'home') openHome();
    else if (t === 'trends') openTrends();
    else if (t === 'coach') openCoach();
    else if (t === 'onboarding') openOnboarding();
  });
});

// FAB Démarrer — coral floating button au centre de la bottom nav. Action
// principale de l'app : "lance ma séance maintenant". Reuse openSession()
// qui a déjà le guard onboarding et la génération paresseuse.
const fabStart = document.getElementById('fabStart');
if (fabStart) fabStart.addEventListener('click', () => {
  haptic(HAPTIC.tap);
  openSession();
});

/* =================== REFONTE MOBILE — câblage =================== */

// Check-in repliable : toggle sur le head. Repliée par défaut (l'accueil
// reste orienté action) ; le mini-anneau readiness la déplie + scroll.
function toggleScienceCard(forceOpen) {
  const card = document.getElementById('scienceCard');
  const head = document.getElementById('scienceCardHead');
  if (!card || !head) return;
  const open = forceOpen === true ? true : !card.classList.contains('open');
  card.classList.toggle('open', open);
  head.setAttribute('aria-expanded', String(open));
}
const scienceHead = document.getElementById('scienceCardHead');
if (scienceHead) scienceHead.addEventListener('click', () => toggleScienceCard());
const readyRingBtn = document.getElementById('readyRing');
if (readyRingBtn) readyRingBtn.addEventListener('click', () => {
  toggleScienceCard(true);
  const card = document.getElementById('scienceCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Segmented control Tendances : Charge / Force / Activité.
const trendsSeg = document.getElementById('trendsSeg');
if (trendsSeg) trendsSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pane]');
  if (!btn) return;
  trendsSeg.querySelectorAll('button').forEach(b => {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    // Roving tabindex : seul l'onglet actif est dans l'ordre de tabulation.
    b.setAttribute('tabindex', on ? '0' : '-1');
  });
  const pane = btn.dataset.pane;
  const panes = { charge: 'paneCharge', force: 'paneForce', activite: 'paneActivite' };
  for (const k in panes) {
    const el = document.getElementById(panes[k]);
    if (el) el.classList.toggle('hide', k !== pane);
  }
});
// Navigation clavier du tablist (motif ARIA : ←/→ déplacent l'onglet actif).
if (trendsSeg) trendsSeg.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = Array.from(trendsSeg.querySelectorAll('button[role="tab"]'));
  const cur = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
  if (cur < 0) return;
  e.preventDefault();
  const next = e.key === 'ArrowRight'
    ? (cur + 1) % tabs.length
    : (cur - 1 + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
});

// Historique : accessible depuis Tendances → Activité, retour vers Tendances.
const trendsHistBtn = document.getElementById('trendsHistoryBtn');
if (trendsHistBtn) trendsHistBtn.addEventListener('click', () => openHistory());
const histBack = document.getElementById('histBackBtn');
if (histBack) histBack.addEventListener('click', () => openTrends());

// Header rétractable : se compacte quand on scrolle vers le bas, se
// redéploie dès qu'on remonte. rAF-throttlé pour ne pas coûter au scroll.
(function () {
  const hdr = document.querySelector('header');
  if (!hdr) return;
  let lastY = 0, ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      if (y > 64 && y > lastY) hdr.classList.add('hdr-compact');
      else if (y < lastY - 4 || y <= 64) hdr.classList.remove('hdr-compact');
      lastY = y;
      ticking = false;
    });
  }, { passive: true });
})();

// Stepper +/− — délégation unique sur le document parce que les inputs
// poids/reps sont rendus dynamiquement à chaque set. data-step porte
// l'incrément (1 pour reps, 2.5 pour kg, négatif pour soustraire),
// data-target l'id de l'input à modifier.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.step-btn');
  if (!btn) return;
  e.preventDefault();
  const targetId = btn.dataset.target;
  const step = parseFloat(btn.dataset.step);
  const input = document.getElementById(targetId);
  if (!input || isNaN(step)) return;
  const cur = parseFloat(input.value) || 0;
  let next = cur + step;
  // Clamp à min/max si définis sur l'input.
  if (input.min !== '' && next < +input.min) next = +input.min;
  if (input.max !== '' && next > +input.max) next = +input.max;
  // Round to 1 decimal pour éviter les artefacts de float (ex: 2.5+2.5+2.5 = 7.5...000003)
  input.value = Math.round(next * 10) / 10;
  // Trigger 'input' pour que tout listener attaché sur l'input réagisse.
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

// positionNavPill — calcule la position et la largeur de la pill animée
// pour qu'elle se cale exactement sous le bouton .active. Appelée à chaque
// changement de vue (depuis show()) et au resize de la fenêtre. Premier
// appel pose la classe `.ready` qui révèle la pill (évite le flash en T0
// pendant que la nav se monte).
function positionNavPill() {
  const nav = document.querySelector('nav.bottom');
  const pill = nav && nav.querySelector('.nav-pill');
  const active = nav && nav.querySelector('button[data-tab].active');
  if (!nav || !pill || !active) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  const x = btnRect.left - navRect.left;
  pill.style.transform = `translateX(${x}px)`;
  pill.style.width = `${btnRect.width}px`;
  // Reveal on first successful position.
  pill.classList.add('ready');
}
window.addEventListener('resize', () => requestAnimationFrame(positionNavPill));
window.addEventListener('orientationchange', () => requestAnimationFrame(positionNavPill));

/* =================== CHIP HELPERS =================== */
// Idempotent — calling this twice on the same container does not double-wire
// click handlers. Without this, reopening the end-of-session bilan after every
// session added another listener, net-toggling twice so chips stopped working.
function wireChips(containerId) {
  const el = document.getElementById(containerId);
  if (!el || el.dataset.wired === '1') return;
  el.dataset.wired = '1';
  el.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => c.classList.toggle('on'));
  });
}
function readChips(containerId) {
  return [...document.querySelectorAll(`#${containerId} .chip.on`)]
    .map(c => c.dataset.goal || c.dataset.gear || c.dataset.pain);
}
function setChips(id, vals, attr) {
  document.querySelectorAll(`#${id} .chip`).forEach(c => {
    c.classList.toggle('on', vals.includes(c.dataset[attr]));
  });
}

/* =================== AUTH FLOW ===================
 * Public registration is closed — accounts are created by an admin on /admin.
 * We keep a stub setAuthMode for compatibility with existing callers that
 * default to 'login'. */
function setAuthMode(_mode) {
  document.getElementById('authErr').textContent = '';
  document.getElementById('authPass').setAttribute('autocomplete', 'current-password');
}

document.getElementById('authSubmit').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  const err = document.getElementById('authErr');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Email + mot de passe requis.'; return; }
  // doLogin attempts a single POST /api/login. If the server responds with
  // need2fa=true we prompt for the TOTP code and retry once. We keep the
  // password in a local var so the second call can re-send it without
  // touching the DOM input again (which we want cleared on success).
  const doLogin = async (totpCode) => {
    const body = { email, password: pass };
    if (totpCode) body.totpCode = totpCode;
    return api('POST', '/api/login', body);
  };
  try {
    let resp;
    try {
      resp = await doLogin();
    } catch (e) {
      // Server signals: password was correct but a TOTP code is required.
      // Prompt once. If the user cancels or enters an invalid code, fall
      // through to the normal error path.
      if (e && e.data && e.data.need2fa) {
        const code = await openPrompt(
          'Vérification en 2 étapes',
          'Saisis le code à 6 chiffres affiché par ton appli d\'authentification.',
          { label: 'Code à 6 chiffres', inputmode: 'numeric',
            autocomplete: 'one-time-code', placeholder: '123456' }
        );
        if (!code) { err.textContent = 'Code 2FA requis.'; return; }
        resp = await doLogin(code.trim());
      } else {
        throw e;
      }
    }
    currentUserEmail = resp.email;
    currentUserIsAdmin = !!resp.isAdmin;
    setAdminLinkVisible(currentUserIsAdmin);
    document.getElementById('authPass').value = '';
    // Audit L-05 : purger le cache SW à chaque login frais — pas seulement
    // au logout. Évite qu'un user qui se reconnecte sur un device partagé
    // voie brièvement les données du compte précédent depuis le cache SW
    // tant que le réseau n'a pas répondu.
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'clear-data-cache' });
    }
    await refreshCSRF();
    // 2FA is mandatory by default: if the server says we haven't enrolled
    // yet, every data call will 403 until we do. Send the user straight
    // to the enrollment screen, then resume normal boot.
    if (resp.needsEnroll2FA) {
      const enrolled = await forceEnroll2FA();
      // If the user clicked "Se déconnecter" during enrollment, doLogout
      // already tore down the session and switched to viewAuth. Don't try
      // to bootAuthenticated — that just hits 401s.
      if (!enrolled) return;
    }
    // Health-data consent gate (RGPD art. 9). After 2FA, before any data
    // call. We re-fetch /api/me to pick up the consent flag because the
    // login response was emitted before consent state could be refreshed.
    let me;
    try { me = await api('GET', '/api/me'); } catch (_) { me = null; }
    if (me && me.user && (!me.user.healthConsent || !me.user.healthConsent.given)) {
      const consented = await forceHealthConsent();
      if (!consented) return;
    }
    // Cache opt-out flag (art. 22) so home view can hide adjustments.
    currentUserAlgoOptOut = !!(me && me.user && me.user.algoOptOut);
    if (me && me.user && me.user.email) currentUserEmail = me.user.email;
    if (me && me.user) {
      currentUser2faEnabled = !!me.user.twofaEnabled;
      currentUserRecoveryLeft = (typeof me.user.recoveryCodesLeft === 'number')
        ? me.user.recoveryCodesLeft : null;
    }
    refreshRecoveryUI();
    await bootAuthenticated();
    try { refreshCycleUI(); } catch (_) {}
  } catch (e) {
    err.textContent = e.message;
  }
});

async function refreshCSRF() {
  try { await api('GET', '/api/csrf'); } catch (_) {}
}

async function doLogout() {
  try { await api('POST', '/api/logout'); } catch (_) {}
  // Demande au SW de purger le cache de /api/me et /api/data — sans ça,
  // un user qui passe offline juste après logout pourrait voir l'identité
  // et les données du compte précédent en consultant son cache local.
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'clear-data-cache' });
  }
  S = { profile: null, history: [], currentSession: null, formScore: 70, adjustments: [] };
  currentUserEmail = null;
  currentUserIsAdmin = false;
  setAdminLinkVisible(false);
  setHeaderSub('non connecté');
  show('viewAuth');
  setAuthMode('login');
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);

document.getElementById('deleteAcctBtn').addEventListener('click', async () => {
  const ok = await openConfirm(
    'Supprimer ton compte ?',
    'Cette action est <strong>définitive</strong>. Ton historique, ton programme et tes réglages seront effacés. Aucune sauvegarde n\'est possible.',
    { confirmLabel: 'Supprimer définitivement', cancelLabel: 'Annuler',
      danger: true, critical: true }
  );
  if (!ok) return;
  try {
    await api('POST', '/api/delete-account');
    location.reload();
  } catch (e) { showToast('Erreur', { variant: 'error', message: e.message }); }
});

// ===== Toggle mode avancé ============================================
// Active l'affichage des intervalles complets (1RM avec "intervalle X-Y"
// au lieu de "± Z"), des détails bayésiens dans la carte programmation,
// et conserve les forecasts visibles. Pour ne pas perturber un utilisateur
// qui découvre l'app, default = false.
function refreshAdvancedModeUI() {
  const btn = document.getElementById('advancedModeBtn');
  const sub = document.getElementById('advancedModeSub');
  const dot = document.getElementById('advancedModeDot');
  if (btn) {
    // Default = avancé. Compact = opt-in (advancedMode === false).
    const on = !S.profile || S.profile.advancedMode !== false;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (sub) sub.textContent = on
      ? 'Activé (défaut) — intervalles bayésiens complets, statistiques détaillées'
      : 'Désactivé — affichage simplifié, 1RM en ± kg';
    if (dot) {
      dot.textContent = on ? '●' : '○';
      dot.style.color = on ? 'var(--accent)' : 'var(--mut)';
    }
  }
  // Sync l'état des chips half-life avec S.profile.keyLiftHalfLife.
  const hlRow = document.getElementById('keyLiftHalfLifeRow');
  if (hlRow) {
    const stored = (S.profile && S.profile.keyLiftHalfLife) || 60;
    hlRow.querySelectorAll('.chip').forEach(b => {
      b.classList.toggle('on', +b.dataset.halflife === +stored);
    });
  }
}

// keyLiftHalfLifeFor — lit la pondération temporelle depuis le profile.
// Default 60j si absent. Utilisé par tous les callers de pickKeyLifts.
function keyLiftHalfLifeFor() {
  return (S.profile && +S.profile.keyLiftHalfLife) || 60;
}
const _advancedModeBtn = document.getElementById('advancedModeBtn');
if (_advancedModeBtn) {
  _advancedModeBtn.addEventListener('click', () => {
    if (!S.profile) return;
    // Default avancé : si undefined ou true → on toggle vers false (opt-out).
    // Si false → retour vers true (default).
    const currentlyOn = S.profile.advancedMode !== false;
    S.profile.advancedMode = !currentlyOn;
    queueSave();
    refreshAdvancedModeUI();
    // Re-render de la home si elle est visible — pour que le format 1RM
    // change immédiatement dans renderNext.
    const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
    if (homeVisible) openHome();
  });
}

// Half-life key lifts — 3 options. Le changement re-render la home si
// elle est visible (la liste de key lifts peut bouger, donc les forecasts
// affichés changent).
const _keyLiftHlRow = document.getElementById('keyLiftHalfLifeRow');
if (_keyLiftHlRow) {
  _keyLiftHlRow.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      if (!S.profile) return;
      const hl = +c.dataset.halflife || 60;
      S.profile.keyLiftHalfLife = hl;
      queueSave();
      refreshAdvancedModeUI();
      const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
      if (homeVisible) openHome();
    });
  });
}

// ===== RGPD: bouton "Mes données et droits" =========================
// Ouvre une modale informative récapitulant les catégories de données
// stockées, les durées, et les actions possibles. Pas de retour utile —
// la modale se ferme par OK. Les actions concrètes (export, suppression,
// opt-out) sont les boutons existants ailleurs dans le profil.
document.getElementById('dataRightsBtn').addEventListener('click', async () => {
  const html = `
    <p style="margin-top:0">
      Coach Adaptatif te garantit une transparence totale sur ce qu'il stocke.
      Voici le détail.
    </p>
    <h3 style="margin:14px 0 4px;font-size:14px">Données détenues</h3>
    <ul style="margin:0;padding-left:20px;font-size:13.5px;line-height:1.55">
      <li><strong>Identifiants</strong>&nbsp;: email, hash bcrypt du mot de passe,
        secret 2FA, date de création.</li>
      <li><strong>Données de santé</strong>&nbsp;: âge, sexe, poids, taille, niveau,
        douleurs, allergies, ressenti d'effort, courbatures, notes.</li>
      <li><strong>Comportement</strong>&nbsp;: historique de séances, charges, reps,
        ajustements algorithmiques, tap test.</li>
      <li><strong>Technique</strong>&nbsp;: IP (logs d'audit admin et rate limiter),
        cookies de session et CSRF.</li>
    </ul>
    <h3 style="margin:14px 0 4px;font-size:14px">Durées de conservation</h3>
    <ul style="margin:0;padding-left:20px;font-size:13.5px;line-height:1.55">
      <li>Compte et historique&nbsp;: tant que le compte existe.</li>
      <li>Sessions actives&nbsp;: 30 jours max.</li>
      <li>Audit admin&nbsp;: 12 mois glissants.</li>
      <li>Comptes inactifs &gt; 24 mois&nbsp;: purge possible après notification.</li>
    </ul>
    <h3 style="margin:14px 0 4px;font-size:14px">Tes actions disponibles ici</h3>
    <ul style="margin:0 0 8px;padding-left:20px;font-size:13.5px;line-height:1.55">
      <li><em>Exporter mes données</em> &mdash; téléchargement JSON complet (art. 20).</li>
      <li><em>Ajustements automatiques</em> &mdash; toggle pour t'opposer à la décision
        automatisée (art. 22).</li>
      <li><em>Supprimer mon compte</em> &mdash; effacement définitif (art. 17).</li>
    </ul>
    <p style="font-size:12px;color:var(--mut);margin:12px 0 0">
      Pour rectifier (art. 16), modifier le profil suffit. Pour toute autre
      demande&nbsp;:
      <a href="mailto:joly.jonathan@protonmail.com" style="color:var(--blue)">joly.jonathan@protonmail.com</a>.
      Réclamation auprès de la
      <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener" style="color:var(--blue)">CNIL</a>
      possible à tout moment.
    </p>
  `;
  await openModal({
    title: 'Mes données et droits',
    body: html,
    buttons: [{ label: 'Fermer', value: true, primary: true }],
  });
});

// ===== RGPD art. 22: toggle ajustements automatiques (algo opt-out) ====
// Inverse l'état actuel et persiste côté serveur. Met à jour le label en
// place pour refléter immédiatement le nouvel état. Si la requête échoue,
// le toggle ne change pas — pas besoin de rollback puisqu'on n'a rien
// modifié localement avant le succès du serveur.
function refreshAlgoOptOutUI() {
  const btn = document.getElementById('algoOptOutBtn');
  const sub = document.getElementById('algoOptOutSub');
  const dot = document.getElementById('algoOptOutToggle');
  if (!btn) return;
  const off = currentUserAlgoOptOut === true;
  btn.setAttribute('aria-pressed', off ? 'true' : 'false');
  if (sub) {
    sub.textContent = off
      ? 'Désactivés — aucun ajustement automatique. Tu es maître de chaque séance.'
      : 'Activés — l\'app adapte tes séances à ton ressenti';
  }
  if (dot) {
    dot.textContent = off ? '○' : '●';
    dot.style.color = off ? 'var(--mut)' : 'var(--success)';
  }
  // Hide the home-screen adjustment card when the user has opted out so we
  // don't surface algorithmic recommendations they've objected to. Display
  // continuity (the data is still computed) preserves history; we just
  // stop *recommending*.
  const card = document.getElementById('adjustCard');
  if (card) card.classList.toggle('hide', off);
}
document.getElementById('algoOptOutBtn').addEventListener('click', async () => {
  const next = !currentUserAlgoOptOut;
  // Confirm only when *enabling* opt-out — toggling adjustments back on
  // doesn't need a confirmation. The opposite (turning recommendations off)
  // is the meaningful direction so we make sure it's intentional.
  if (next) {
    const ok = await openConfirm(
      'Désactiver les ajustements automatiques ?',
      "L'app calcule des ajustements (deload, swap, modulation) à partir de ton ressenti. " +
      "En les désactivant, tu exerces ton droit d'opposition (RGPD art. 22) — aucune " +
      "recommandation algorithmique ne te sera plus présentée. Tu pourras les réactiver à tout moment.",
      { confirmLabel: 'Désactiver', cancelLabel: 'Annuler' }
    );
    if (!ok) return;
  }
  try {
    await api('POST', '/api/algo-optout', { optOut: next });
    currentUserAlgoOptOut = next;
    refreshAlgoOptOutUI();
    showToast(
      next ? 'Ajustements désactivés' : 'Ajustements réactivés',
      { variant: next ? 'info' : 'success',
        message: next
          ? "Aucune recommandation algorithmique ne te sera plus proposée."
          : "L'app adaptera de nouveau tes séances à ton ressenti." }
    );
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
});

// ensureQRCodeLib — chargement À LA DEMANDE de qrcode.js (audit modularité,
// action 5). La librairie (12 K gzip) ne sert qu'à l'enrôlement 2FA, soit
// ~une fois par utilisateur — la charger à chaque boot était du gâchis.
// CSP-compatible : script same-origin injecté dynamiquement (script-src
// 'self' l'autorise). Le SW garde /static/qrcode.js dans le shell cache,
// donc l'enrôlement marche aussi hors-ligne.
let _qrLibPromise = null;
function ensureQRCodeLib() {
  if (typeof window.qrcode === 'function') return Promise.resolve();
  if (_qrLibPromise) return _qrLibPromise;
  _qrLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/static/qrcode.js';
    s.onload = () => resolve();
    s.onerror = () => { _qrLibPromise = null; reject(new Error('qrcode.js introuvable')); };
    document.head.appendChild(s);
  });
  return _qrLibPromise;
}

// renderQrInto draws an otpauth:// URL as an inline SVG QR code into the
// given container element. Uses the vendored kazuhikoarase/qrcode-generator
// library (window.qrcode), chargée à la demande par ensureQRCodeLib(). We
// use auto type number (0) and 'M' error correction — that's the level
// Google Authenticator's docs recommend.
async function renderQrInto(container, otpauthUrl) {
  container.textContent = '…';
  try {
    await ensureQRCodeLib();
  } catch (_) {
    container.textContent = 'QR indisponible — utilise la clé manuelle.';
    return;
  }
  container.textContent = '';
  if (typeof window.qrcode !== 'function') {
    container.textContent = 'QR indisponible — utilise la clé manuelle.';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(otpauthUrl);
    qr.make();
    // cellSize=5px, margin=2 modules → ~200px QR for typical otpauth payload.
    // scalable=true makes it a vector that grows with CSS if we want.
    const svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    container.innerHTML = svg;
    // The library's SVG sets explicit width/height; nudge it to behave well
    // inside our flexbox wrapper.
    const el = container.querySelector('svg');
    if (el) {
      el.setAttribute('width', '200');
      el.setAttribute('height', '200');
      el.style.display = 'block';
    }
  } catch (e) {
    container.textContent = 'QR indisponible — utilise la clé manuelle.';
  }
}

// runEnroll2FAFlow shows viewEnroll2FA, calls /api/2fa/setup, renders the QR
// code + secret, and resolves with true once the user successfully verifies a
// code, or false if they cancel. Shared between the settings "enable 2FA"
// button and the forced-enrollment gate.
//
// opts.mandatory (bool): when true, the cancel button logs the user out (we
//   can't let them stay in a half-authenticated state with no 2FA). When
//   false, cancel just resolves with false so the caller can return to
//   settings.
function runEnroll2FAFlow(opts) {
  opts = opts || {};
  return new Promise(async (resolve) => {
    const titleEl  = document.getElementById('twofaTitle');
    const introEl  = document.getElementById('twofaIntro');
    const qrEl     = document.getElementById('twofaQr');
    const secretEl = document.getElementById('twofaSecret');
    const codeEl   = document.getElementById('twofaCode');
    const errEl    = document.getElementById('twofaError');
    const verifyBtn = document.getElementById('twofaVerifyBtn');
    const cancelBtn = document.getElementById('twofaCancelBtn');

    titleEl.textContent = opts.mandatory
      ? '🔐 Vérification en 2 étapes — obligatoire'
      : '🔐 Activer la vérification en 2 étapes';
    cancelBtn.textContent = opts.mandatory ? 'Se déconnecter' : 'Annuler';
    codeEl.value = '';
    errEl.textContent = '';
    qrEl.textContent = 'Génération du QR…';
    secretEl.textContent = '…';

    show('viewEnroll2FA');
    setHeaderSub(opts.mandatory
      ? 'vérification en 2 étapes — obligatoire'
      : 'vérification en 2 étapes');

    // Hit /api/2fa/setup to get the secret + otpauth URL. If this fails the
    // screen is useless, so surface the error and let the user cancel.
    let setup;
    try {
      setup = await api('POST', '/api/2fa/setup');
    } catch (e) {
      errEl.textContent = e.message || 'Impossible de démarrer la 2FA.';
      qrEl.textContent = '—';
      secretEl.textContent = '—';
    }

    if (setup) {
      secretEl.textContent = setup.secret;
      renderQrInto(qrEl, setup.otpauthUrl);
    }

    // Wire cancel/verify. We replace handlers each call (clone+replace) so
    // re-entries don't stack listeners.
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newVerify = verifyBtn.cloneNode(true);
    verifyBtn.parentNode.replaceChild(newVerify, verifyBtn);

    newCancel.addEventListener('click', async () => {
      if (opts.mandatory) {
        await doLogout();
        // doLogout reloads/redirects; resolve anyway in case it doesn't.
        resolve(false);
      } else {
        resolve(false);
      }
    });

    newVerify.addEventListener('click', async () => {
      const code = (codeEl.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        errEl.textContent = 'Saisis le code à 6 chiffres affiché par ton app.';
        return;
      }
      errEl.textContent = '';
      newVerify.disabled = true;
      try {
        const res = await api('POST', '/api/2fa/verify', { code });
        // Codes de récupération : affichés UNE seule fois, juste après
        // l'enrôlement. On bloque la sortie tant que l'utilisateur n'a pas
        // confirmé les avoir notés.
        if (res && Array.isArray(res.recoveryCodes) && res.recoveryCodes.length) {
          await showRecoveryCodes(res.recoveryCodes, { firstTime: true });
        }
        resolve(true);
      } catch (e) {
        errEl.textContent = e.message || 'Code invalide. Réessaie.';
        newVerify.disabled = false;
      }
    });

    // Submit on Enter in the code field for convenience.
    codeEl.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        newVerify.click();
      }
    }, { once: true });
    codeEl.focus();
  });
}

// showRecoveryCodes — modale qui affiche les codes de secours 2FA. Ils ne
// sont JAMAIS re-montrés ensuite (le serveur ne stocke que des hash), donc
// on insiste : copier / télécharger, et confirmation explicite « notés ».
function showRecoveryCodes(codes, opts) {
  opts = opts || {};
  const list = codes.map(c => `<code class="recovery-code">${escapeHtml(c)}</code>`).join('');
  const intro = opts.firstTime
    ? 'Ta 2FA est active. Voici tes <strong>codes de récupération</strong> — note-les MAINTENANT.'
    : 'Voici tes <strong>nouveaux codes de récupération</strong>. Les anciens ne fonctionnent plus.';
  return openModal({
    title: '🔑 Codes de récupération',
    critical: true,
    body: `
      <p style="font-size:13px;line-height:1.5;margin:0 0 8px">${intro}</p>
      <p class="mut" style="font-size:12px;line-height:1.5;margin:0 0 12px">
        Si tu perds ton téléphone, chaque code te permet de te connecter une fois,
        à la place du code à 6 chiffres. Garde-les hors de ton téléphone (gestionnaire
        de mots de passe, papier dans un tiroir). On ne pourra pas te les remontrer.
      </p>
      <div class="recovery-grid">${list}</div>
      <div class="row mt10">
        <button type="button" class="sec flex1" id="recoveryCopy">📋 Copier</button>
        <button type="button" class="sec flex1" id="recoveryDownload">⬇ Télécharger</button>
      </div>`,
    buttons: [{ label: 'Je les ai notés', value: true, primary: true }],
    onRender: (root) => {
      const text = codes.join('\n');
      const copyBtn = root.querySelector('#recoveryCopy');
      const dlBtn = root.querySelector('#recoveryDownload');
      if (copyBtn) copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); showToast('Codes copiés'); }
        catch (_) { showToast('Copie impossible', { variant: 'error', message: 'Sélectionne-les à la main.' }); }
      });
      if (dlBtn) dlBtn.addEventListener('click', () => {
        const blob = new Blob(
          ['Coach Adaptatif — codes de récupération 2FA\n(chaque code est utilisable une seule fois)\n\n' + text + '\n'],
          { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'coach-recovery-codes.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    },
  });
}

// forceEnroll2FA blocks the user on the dedicated screen until they finish
// enrollment. Server-side require2FA already rejects every data call until
// then — this is the matching client-side affordance.
async function forceEnroll2FA() {
  const ok = await runEnroll2FAFlow({ mandatory: true });
  // If ok is false, the user clicked "Se déconnecter" and doLogout already
  // tore down the session. Nothing else to do here.
  return ok;
}

// forceHealthConsent shows the consent gate (RGPD art. 9) and blocks until
// the user either accepts (POST /api/consent) or refuses + logs out. The
// server-side handleSaveData also enforces this: any attempt to save data
// without a fresh consent returns 403 needsConsent.
//
// Returns true if consent was recorded, false if the user logged out.
function forceHealthConsent() {
  return new Promise((resolve) => {
    show('viewConsent');
    const cb = document.getElementById('consentHealth');
    const errEl = document.getElementById('consentError');
    const acceptBtn = document.getElementById('consentAcceptBtn');
    const refuseBtn = document.getElementById('consentRefuseBtn');
    if (cb) cb.checked = false;
    if (errEl) errEl.textContent = '';

    // Use addEventListener with { once: true } and detach the *other*
    // handler manually on resolve. Avoids stale handlers if the user
    // re-enters this view (which shouldn't happen but defensive).
    const onAccept = async () => {
      if (errEl) errEl.textContent = '';
      if (!cb || !cb.checked) {
        if (errEl) errEl.textContent = 'Coche la case pour confirmer ton consentement.';
        return;
      }
      acceptBtn.disabled = true;
      try {
        await api('POST', '/api/consent', { accept: true });
        cleanup();
        resolve(true);
      } catch (e) {
        if (errEl) errEl.textContent = e.message || 'Erreur. Réessaie.';
        acceptBtn.disabled = false;
      }
    };
    const onRefuse = async () => {
      cleanup();
      await doLogout();
      resolve(false);
    };
    const cleanup = () => {
      acceptBtn.removeEventListener('click', onAccept);
      refuseBtn.removeEventListener('click', onRefuse);
      acceptBtn.disabled = false;
    };
    acceptBtn.addEventListener('click', onAccept);
    refuseBtn.addEventListener('click', onRefuse);
  });
}

document.getElementById('twofaBtn').addEventListener('click', async () => {
  // Toggle: if already enabled → ask for password to disable; else → setup flow.
  let status;
  try { status = await api('GET', '/api/2fa/status'); }
  catch (e) { showToast('Erreur', { variant: 'error', message: e.message }); return; }
  if (status.enabled) {
    const pw = await openPrompt(
      'Désactiver la 2FA',
      'Pour confirmer, saisis ton mot de passe.',
      { label: 'Mot de passe', type: 'password', autocomplete: 'current-password' }
    );
    if (!pw) return;
    try {
      await api('POST', '/api/2fa/disable', { password: pw });
      currentUser2faEnabled = false;
      currentUserRecoveryLeft = null;
      refreshRecoveryUI();
      showToast('2FA désactivée', { variant: 'info', message: 'La vérification en 2 étapes est désactivée.' });
    } catch (e) { showToast('Erreur', { variant: 'error', message: e.message }); }
    return;
  }
  // Enrollment from the settings screen — non-mandatory, so cancel just
  // bounces back without logging out.
  const ok = await runEnroll2FAFlow({ mandatory: false });
  if (ok) {
    currentUser2faEnabled = true;
    currentUserRecoveryLeft = 10; // générés à l'enrôlement
    refreshRecoveryUI();
    showToast('2FA activée', { variant: 'success', message: 'À la prochaine connexion, on te demandera un code à 6 chiffres.' });
    show('viewHome');
  } else {
    show('viewHome');
  }
});

// Codes de récupération : régénération (exige le mot de passe). Affiche les
// nouveaux codes une seule fois via la même modale que l'enrôlement.
const recoveryBtn = document.getElementById('recoveryBtn');
if (recoveryBtn) recoveryBtn.addEventListener('click', async () => {
  const pw = await openPrompt(
    'Régénérer les codes de récupération',
    'Les anciens codes seront invalidés. Saisis ton mot de passe pour confirmer.',
    { label: 'Mot de passe', type: 'password', autocomplete: 'current-password' }
  );
  if (!pw) return;
  try {
    const res = await api('POST', '/api/2fa/recovery', { password: pw });
    if (res && Array.isArray(res.codes)) {
      currentUserRecoveryLeft = res.codes.length;
      await showRecoveryCodes(res.codes, { firstTime: false });
      refreshRecoveryUI();
    }
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
});

/* =================== CYCLE MENSTRUEL (opt-in) =================== */
// Données stockées dans S.body.cycle = { enabled, periods: [ISO dates], avgLength }.
// 100% local (comme tout le reste), extra-sensible → opt-in strict.
function getCycleState() {
  ensureBodyState();
  if (!S.body.cycle) S.body.cycle = { enabled: false, periods: [] };
  return S.body.cycle;
}
function refreshCycleUI() {
  const sub = document.getElementById('cycleSub');
  if (!sub) return;
  const c = getCycleState();
  if (!c.enabled) { sub.textContent = 'Adapter la charge selon ton cycle'; sub.style.color = ''; return; }
  const ph = window.Cycle ? window.Cycle.phaseFor(c) : null;
  sub.textContent = ph ? `Activé · phase ${ph.phase} (j${ph.day})` : 'Activé · logge tes règles';
  sub.style.color = '';
}
// Sélecteur de langue (i18n). Bascule fr/en + persistance localStorage ;
// applyI18n re-traduit le DOM tagué à chaud.
const langBtn = document.getElementById('langBtn');
if (langBtn) langBtn.addEventListener('click', async () => {
  if (!window.i18n) return;
  const cur = window.i18n.getLang();
  const choice = await openModal({
    title: '🌐 Langue / Language',
    body: '<p class="mut" style="font-size:12px;margin:0 0 6px">La traduction est en cours de déploiement — certaines sections restent en français.</p>',
    buttons: [
      { label: 'Français', value: 'fr', primary: cur === 'fr' },
      { label: 'English', value: 'en', primary: cur === 'en' },
    ],
  });
  if (choice === 'fr' || choice === 'en') {
    window.i18n.setLang(choice);
    const sub = document.getElementById('langSub');
    if (sub) sub.textContent = choice === 'en' ? 'English' : 'Français';
  }
});

const cycleBtn = document.getElementById('cycleBtn');
if (cycleBtn) cycleBtn.addEventListener('click', async () => {
  const c = getCycleState();
  const ph = (c.enabled && window.Cycle) ? window.Cycle.phaseFor(c) : null;
  const todayISO = new Date().toISOString().slice(0, 10);
  const res = await openModal({
    title: '🌙 Cycle menstruel',
    body: `
      <p style="font-size:13px;line-height:1.5;margin:0 0 8px">
        Optionnel. Si tu l'actives, le coach module légèrement le volume et
        l'intensité selon la phase de ton cycle. <strong>Ces données restent
        sur ton appareil</strong>, comme le reste.
      </p>
      <p class="mut" style="font-size:11px;line-height:1.5;margin:0 0 10px">
        La science est débattue (effet moyen faible, forte variabilité) — c'est
        un repère, pas une règle. Tes sensations priment toujours.
      </p>
      ${ph ? `<div style="padding:8px 10px;background:var(--bg2);border-radius:8px;font-size:12px;margin-bottom:8px">
        Aujourd'hui : <strong>phase ${escapeHtml(ph.phase)}</strong> (jour ${ph.day}/${ph.length}).<br>
        <span class="mut">${escapeHtml(ph.advice)}</span>
      </div>` : ''}`,
    fields: [
      { name: 'period', label: 'Date du 1er jour de tes dernières règles', type: 'date',
        value: (c.periods && c.periods.length ? c.periods[c.periods.length - 1] : todayISO) },
    ],
    buttons: c.enabled
      ? [
          { label: 'Désactiver', value: 'off', danger: true },
          { label: 'Enregistrer', value: 'save', primary: true },
        ]
      : [
          { label: 'Annuler', value: false },
          { label: 'Activer', value: 'save', primary: true },
        ],
  });
  if (!res || res.value === false) return;
  if (res.value === 'off') {
    c.enabled = false;
    queueSave(); refreshCycleUI();
    showToast('Cycle désactivé', { variant: 'info' });
    return;
  }
  // save : active + enregistre la date de règles si fournie/nouvelle.
  c.enabled = true;
  const d = res.fields && res.fields.period;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    c.periods = Array.isArray(c.periods) ? c.periods : [];
    if (!c.periods.includes(d)) c.periods.push(d);
    // Garde au plus 24 derniers cycles, recalcule la longueur médiane.
    c.periods = c.periods.sort().slice(-24);
    if (window.Cycle) c.avgLength = window.Cycle.estimateCycleLength(c.periods);
  }
  queueSave(); refreshCycleUI();
  showToast('Cycle activé', { variant: 'success', message: 'La charge s\'adaptera à ta phase.' });
});

// refreshRecoveryUI — affiche/masque le bouton « Codes de récupération »
// selon que la 2FA est active, et alerte quand il reste peu de codes.
// Alimenté par /api/me (recoveryCodesLeft) au boot, et par les actions 2FA.
function refreshRecoveryUI() {
  const btn = document.getElementById('recoveryBtn');
  const sub = document.getElementById('recoverySub');
  if (!btn) return;
  const enabled = !!currentUser2faEnabled;
  btn.classList.toggle('hide', !enabled);
  if (sub) {
    const n = currentUserRecoveryLeft;
    if (n != null && n <= 2) {
      sub.textContent = `⚠ Plus que ${n} code${n > 1 ? 's' : ''} — régénère-les`;
      sub.style.color = 'var(--warn)';
    } else if (n != null) {
      sub.textContent = `${n} codes restants · régénérer`;
      sub.style.color = '';
    } else {
      sub.textContent = 'Régénérer tes codes de secours';
      sub.style.color = '';
    }
  }
}

document.getElementById('changePwBtn').addEventListener('click', async () => {
  // Single modal with all three fields — better UX than three sequential
  // prompts and works around the focus-restore issue you'd get with
  // chained dialogs.
  const result = await openModal({
    title: 'Changer mon mot de passe',
    body: '<p>Le nouveau mot de passe doit faire au moins 10 caractères et mélanger lettres et chiffres ou symboles.</p>',
    fields: [
      { name: 'oldPassword', label: 'Ancien mot de passe', type: 'password',
        autocomplete: 'current-password', required: true },
      { name: 'newPassword', label: 'Nouveau mot de passe', type: 'password',
        autocomplete: 'new-password', required: true },
      { name: 'confirmPw',   label: 'Confirme le nouveau', type: 'password',
        autocomplete: 'new-password', required: true },
    ],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Changer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const { oldPassword, newPassword, confirmPw } = result.fields;
  if (newPassword !== confirmPw) {
    await openAlert('Mots de passe différents', 'Les deux saisies du nouveau mot de passe ne correspondent pas.');
    return;
  }
  try {
    await api('POST', '/api/change-password', { oldPassword, newPassword });
    showToast('Mot de passe changé', { variant: 'success', message: 'Toutes tes autres sessions ont été déconnectées.' });
  } catch (e) { showToast('Erreur', { variant: 'error', message: e.message }); }
});

/* =================== REMOTE SAVE (debounced) =================== */
let saveTimer = null;
let saveInflight = false;
let savePending = false;

function setSaveState(text) {
  const el = document.getElementById('saveState');
  if (!text) { el.classList.add('hide'); el.classList.remove('saving'); return; }
  el.classList.remove('hide');
  el.textContent = text;
  // The "saving" class drives a gentle pulse animation in CSS. We toggle it
  // by inspecting the icon — '💾 …' means in flight; checkmark or warn
  // means we're done with this round.
  if (text.indexOf('💾') !== -1) el.classList.add('saving');
  else el.classList.remove('saving');
}

function queueSave() {
  if (!currentUserEmail) return;
  savePending = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
  setSaveState('💾 …');
}

async function flushSave() {
  if (saveInflight) return;
  if (!savePending) return;
  savePending = false;
  saveInflight = true;
  try {
    await api('PUT', '/api/data', { data: S });
    setSaveState('✓');
    setTimeout(() => setSaveState(''), 600);
  } catch (e) {
    console.warn('save failed', e);
    setSaveState('⚠ non sauvé');
    savePending = true;
    setTimeout(flushSave, 3000);
  } finally {
    saveInflight = false;
    if (savePending) flushSave();
  }
}

window.addEventListener('pagehide', () => {
  if (savePending && currentUserEmail) {
    // Audit M-03 : sur HTTPS le cookie est nommé __Host-coach_csrf
    // (durcissement préfixe). On lit les deux noms en fallback.
    const t = csrfToken();
    const blob = new Blob([JSON.stringify({data: S})], {type:'application/json'});
    try {
      fetch('/api/data', {
        method: 'PUT', keepalive: true, credentials: 'same-origin',
        headers: {'Content-Type':'application/json', 'X-CSRF-Token': t || ''},
        body: blob,
      });
    } catch (_) {}
  }
});

/* =================== ONBOARDING =================== */
function openOnboarding() {
  show('viewOnboarding');
  // L'email du compte vit en bas de cette vue (section Compte). On le
  // met à jour à chaque ouverture pour rester sync après changement.
  const acctEl = document.getElementById('accountEmail');
  if (acctEl) acctEl.textContent = currentUserEmail || '—';
  // Sync the RGPD opt-out toggle UI on every open so it reflects the
  // canonical server-side state (in case it was changed in another tab).
  refreshAlgoOptOutUI();
  // Sync the rééduc UI (toggle, config, phase hint) at every open. Pure
  // read of S.rehab — never writes back.
  refreshRehabUI();
  // Suivi corporel — re-render la sparkline et la dernière entrée à chaque
  // ouverture du profil pour rester sync après une nouvelle pesée.
  renderBodySparkline();
  // Mode avancé — sync UI au passage.
  refreshAdvancedModeUI();
  // Intégrations physio — re-render du panneau (async, non bloquant).
  physioRender();
  // Bouton "onbDone" : libellé selon l'état du profil. Création la 1ère
  // fois, enregistrement ensuite — convention standard formulaire.
  const onbDone = document.getElementById('onbDone');
  if (onbDone) onbDone.textContent = S.profile
    ? 'Enregistrer mon profil'
    : 'Créer mon programme →';
  if (S.profile) {
    document.getElementById('onbAge').value = S.profile.age;
    document.getElementById('onbWeight').value = S.profile.weight;
    if (S.profile.height) document.getElementById('onbHeight').value = S.profile.height;
    if (S.profile.sex) document.getElementById('onbSex').value = S.profile.sex;
    document.getElementById('onbLevel').value = S.profile.level;
    document.getElementById('onbFreq').value = S.profile.freq;
    document.getElementById('onbDur').value = S.profile.duration;
    if (S.profile.diet) document.getElementById('onbDiet').value = S.profile.diet;
    if (S.profile.nutGoal) document.getElementById('onbNutGoal').value = S.profile.nutGoal;
    if (S.profile.meals) document.getElementById('onbMeals').value = S.profile.meals;
    if (S.profile.water != null) document.getElementById('onbWater').value = S.profile.water;
    if (S.profile.maxHalteres != null) document.getElementById('onbMaxHalteres').value = S.profile.maxHalteres;
    if (S.profile.maxBarre != null) document.getElementById('onbMaxBarre').value = S.profile.maxBarre;
    setChips('onbGoals', S.profile.goals || [], 'goal');
    setChips('onbGear', S.profile.gear || [], 'gear');
    setChips('onbPain', S.profile.painToday || [], 'pain');
    setChips('onbAllergies', S.profile.allergies || [], 'pain');
  }
}
// Liste des zones douleurs / courbatures partagée entre :
//   - bannière soreness (home),
//   - questionnaire de bilan (qPain),
//   - onboarding (onbPain).
// On garde des clés ASCII pour la compat data (history.pains[] stocke ces clés).
// Élargissement v2 : 15 zones (vs 6 avant) pour capter aussi les douleurs
// musculaires (ischio, mollet, quadri, fessier) et axiales (nuque, lombaires,
// abdo) en plus des articulations.
const SORENESS_PARTS = [
  { key: 'nuque',     label: 'Nuque / cou' },
  { key: 'epaule',    label: 'Épaules' },
  { key: 'coude',     label: 'Coudes' },
  { key: 'poignet',   label: 'Poignets' },
  { key: 'avantbras', label: 'Avant-bras' },
  { key: 'dos',       label: 'Haut du dos' },
  { key: 'lombaires', label: 'Lombaires' },
  { key: 'abdo',      label: 'Abdos' },
  { key: 'hanche',    label: 'Hanches' },
  { key: 'fessier',   label: 'Fessiers' },
  { key: 'quadri',    label: 'Quadriceps' },
  { key: 'ischio',    label: 'Ischios' },
  { key: 'genou',     label: 'Genoux' },
  { key: 'mollet',    label: 'Mollets' },
  { key: 'cheville',  label: 'Chevilles' },
];

// Hydrate les conteneurs de zones douleurs depuis SORENESS_PARTS (source unique).
// onbPain et qPain ont des <button> statiques dans le HTML qu'on remplace ici
// pour que les nouveaux ajouts à la liste apparaissent automatiquement.
function hydratePainChips() {
  const list = SORENESS_PARTS;
  if (!list) return;
  ['onbPain', 'qPain'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = list.map(p =>
      `<button type="button" class="chip" data-pain="${p.key}">${p.label}</button>`
    ).join('');
    // Re-wire (idempotent guard est sur dataset.wired).
    if (el.dataset.wired === '1') {
      // wireChips déjà appelé : recâble manuellement les nouveaux chips.
      el.querySelectorAll('.chip').forEach(c => {
        c.addEventListener('click', () => c.classList.toggle('on'));
      });
    }
  });
}
hydratePainChips();
['onbGoals','onbGear','onbPain','onbAllergies'].forEach(wireChips);

/* =================== SUIVI CORPOREL ===================
 * Pesées hebdo + mensurations. Stocké dans S.body, persisté via la
 * whitelist `body` côté serveur. UI : 2 boutons (Pesée / Mensurations)
 * sur la card "Suivi corporel" du profil + sparkline du poids avec
 * moyenne mobile 4 semaines.
 *
 * Pas de photos pour v1 — le stockage en base64 dans le data file fait
 * exploser le poids (200KB par photo × 12 mois = 2,4 MB par utilisateur).
 * À refaire avec une route dédiée + chiffrement si on veut shipper.
 */
function ensureBodyState() {
  if (!S.body || typeof S.body !== 'object') {
    S.body = { weights: [], measurements: [], physio: [] };
  }
  if (!Array.isArray(S.body.weights)) S.body.weights = [];
  if (!Array.isArray(S.body.measurements)) S.body.measurements = [];
  if (!Array.isArray(S.body.physio)) S.body.physio = [];
  // Extensions science (niveau 5) — voir science.js pour la justification :
  //   hooper    : [{date, sleep, stress, mood, soreness, fatigue, raw, ready}]
  //   lifestyle : [{date, steps, lastCaffeineH, morningLight}]
  //   pvt       : [{date, meanMs, medianMs, lapses, falseStarts, n}]
  //   intentions: [{date, trigger, action, status: 'pending'|'done'|'missed'}]
  if (!Array.isArray(S.body.hooper)) S.body.hooper = [];
  if (!Array.isArray(S.body.lifestyle)) S.body.lifestyle = [];
  if (!Array.isArray(S.body.pvt)) S.body.pvt = [];
  if (!Array.isArray(S.body.intentions)) S.body.intentions = [];
}

// movingAverage — fenêtre glissante de N entrées. Renvoie un array de
// même longueur, où chaque point est la moyenne des N derniers (ou moins
// si début de série).
function movingAverage(values, windowSize) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = values.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    out.push(avg);
  }
  return out;
}

// renderBodySparkline — dessine un mini-graphique SVG du poids dans le
// temps. Trace la valeur brute (gris clair) ET la moyenne mobile 4 semaines
// (couleur accent). Affiche aussi delta vs il y a 1 mois et 3 mois.
function renderBodySparkline() {
  ensureBodyState();
  const box = document.getElementById('bodyWeightSparkline');
  const last = document.getElementById('bodyLastEntry');
  if (!box) return;
  const ws = S.body.weights;
  if (ws.length === 0) {
    box.innerHTML = '<p class="mut" style="font-size:13px;margin:8px 0;text-align:center">Aucune pesée. Logge ta première pesée pour voir la courbe.</p>';
    if (last) last.textContent = '';
    return;
  }
  // Tri chronologique défensif.
  const sorted = [...ws].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const values = sorted.map(w => +w.kg);
  const ma = movingAverage(values, 4);
  const minV = Math.min.apply(null, values.concat(ma));
  const maxV = Math.max.apply(null, values.concat(ma));
  const range = Math.max(0.5, maxV - minV);
  const W = 320, H = 80, P = 8;
  function pt(i, v) {
    const x = P + (sorted.length === 1 ? W / 2 : (W - 2 * P) * i / (sorted.length - 1));
    const y = P + (H - 2 * P) * (1 - (v - minV) / range);
    return [x, y];
  }
  const rawPath = values.map((v, i) => {
    const [x, y] = pt(i, v);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  const maPath = ma.map((v, i) => {
    const [x, y] = pt(i, v);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  const dots = values.map((v, i) => {
    const [x, y] = pt(i, v);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="var(--mut)"/>`;
  }).join('');
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:80px;display:block">
      <path d="${rawPath}" stroke="var(--mut)" stroke-width="1" fill="none" opacity=".5"/>
      <path d="${maPath}" stroke="var(--accent)" stroke-width="2" fill="none"/>
      ${dots}
      <text x="${P}" y="${H - 2}" font-size="9" fill="var(--mut)">${minV.toFixed(1)}kg</text>
      <text x="${W - P}" y="${H - 2}" font-size="9" fill="var(--mut)" text-anchor="end">${maxV.toFixed(1)}kg</text>
    </svg>`;
  if (last) {
    const lastEntry = sorted[sorted.length - 1];
    const lastDate = new Date(lastEntry.date);
    const lastTxt = lastDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    // Deltas
    function deltaSince(daysAgo) {
      const cutoff = Date.now() - daysAgo * 86400000;
      const past = sorted.filter(w => Date.parse(w.date) <= cutoff);
      if (past.length === 0) return null;
      const ref = past[past.length - 1];
      return +(+lastEntry.kg - +ref.kg).toFixed(1);
    }
    const d30 = deltaSince(30), d90 = deltaSince(90);
    const fmtD = d => d == null ? '—' : (d > 0 ? '+' + d : '' + d) + ' kg';
    // Trend Hall 2011 : régression linéaire 6 semaines → kcal/jour de déficit
    // ou d'excédent (1 kg ≈ 7700 kcal). Plus fiable que le delta brut à 30j
    // car filtre le bruit eau/glycogène.
    let trendHtml = '';
    if (window.Science) {
      const trend = window.Science.bodyWeightTrend(ws, { weeks: 6 });
      if (trend && Math.abs(trend.slopeKgPerWeek) > 0.05 && trend.r2 > 0.2) {
        const dir = trend.slopeKgPerWeek > 0 ? 'prise' : 'perte';
        const sign = trend.kcalPerDay > 0 ? '+' : '';
        trendHtml = `<br><span class="mut" style="font-size:11px">
          📈 Trend 6 sem (Hall 2011) : ${dir} de ${Math.abs(trend.slopeKgPerWeek).toFixed(2)} kg/sem
          ≈ ${sign}${trend.kcalPerDay} kcal/jour (R²=${trend.r2})
        </span>`;
      }
      // Cibles protéiques Schoenfeld 2018 (0.4 g/kg/repas × 4 = 1.6 g/kg/j)
      const lastKg = +lastEntry.kg;
      const meals = (S.profile && +S.profile.meals) || 4;
      const prot = window.Science.proteinTargets(lastKg, meals);
      if (prot) {
        trendHtml += `<br><span class="mut" style="font-size:11px">
          🥩 Cible protéines (Schoenfeld 2018) : <strong>${prot.perDayMin}-${prot.perDayMax} g/jour</strong>
          · ${prot.perMealOptimal} g/repas (sur ${prot.mealsPerDay} repas)
        </span>`;
      }
    }
    last.innerHTML = `Dernière pesée : <strong>${(+lastEntry.kg).toFixed(1)} kg</strong> le ${escapeHtml(lastTxt)}.
      30j : ${fmtD(d30)} · 90j : ${fmtD(d90)}.${trendHtml}`;
  }
}

async function logBodyWeight() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  const last = S.body.weights[S.body.weights.length - 1];
  const result = await openModal({
    title: '⚖️ Pesée',
    body: '<p style="margin:0 0 8px;font-size:13px">Idéalement le matin, à jeun, après les toilettes.</p>',
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: today, required: true },
      { name: 'kg', label: 'Poids (kg)', type: 'number', value: last ? last.kg : '',
        placeholder: 'ex: 75.4', inputmode: 'decimal', required: true },
    ],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Enregistrer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const f = result.fields;
  const kg = +f.kg;
  if (!isFinite(kg) || kg < 20 || kg > 300) {
    showToast('Poids invalide', { variant: 'error', message: 'Saisis un poids entre 20 et 300 kg.' });
    return;
  }
  // Si pesée déjà existante à cette date → remplacer (cas du re-pesée).
  const date = f.date;
  const exists = S.body.weights.findIndex(w => w.date === date);
  const entry = { date, kg };
  if (exists >= 0) S.body.weights[exists] = entry;
  else S.body.weights.push(entry);
  S.body.weights.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  queueSave();
  renderBodySparkline();
  showToast('Pesée enregistrée', { variant: 'success', message: kg + ' kg le ' + date });
}

async function logBodyMeasurements() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  const last = S.body.measurements[S.body.measurements.length - 1] || {};
  const result = await openModal({
    title: '📐 Mensurations',
    body: '<p style="margin:0 0 8px;font-size:13px">À mesurer froid, sans contraction. Tous les champs sont facultatifs — ne logge que ceux que tu prends.</p>',
    fields: [
      { name: 'date',      label: 'Date',                 type: 'date',   value: today, required: true },
      { name: 'waistCm',   label: 'Tour de taille (cm)',  type: 'number', value: last.waistCm   || '', inputmode: 'decimal' },
      { name: 'hipsCm',    label: 'Tour de hanches (cm)', type: 'number', value: last.hipsCm    || '', inputmode: 'decimal' },
      { name: 'bicepsLCm', label: 'Biceps gauche (cm)',   type: 'number', value: last.bicepsLCm || '', inputmode: 'decimal' },
      { name: 'bicepsRCm', label: 'Biceps droit (cm)',    type: 'number', value: last.bicepsRCm || '', inputmode: 'decimal' },
      { name: 'thighCm',   label: 'Cuisse (cm)',          type: 'number', value: last.thighCm   || '', inputmode: 'decimal' },
    ],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Enregistrer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const f = result.fields;
  const entry = { date: f.date };
  let any = false;
  ['waistCm', 'hipsCm', 'bicepsLCm', 'bicepsRCm', 'thighCm'].forEach(k => {
    const v = +f[k];
    if (isFinite(v) && v > 0 && v < 300) { entry[k] = v; any = true; }
  });
  if (!any) {
    showToast('Aucune valeur', { variant: 'info', message: 'Saisis au moins une mensuration.' });
    return;
  }
  // Replace if same date.
  const exists = S.body.measurements.findIndex(m => m.date === entry.date);
  if (exists >= 0) S.body.measurements[exists] = entry;
  else S.body.measurements.push(entry);
  S.body.measurements.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  queueSave();
  showToast('Mensurations enregistrées', { variant: 'success', message: 'Bien noté.' });
}

async function showBodyHistory() {
  ensureBodyState();
  const ws = [...S.body.weights].reverse();
  const ms = [...S.body.measurements].reverse();
  const wHtml = ws.length === 0
    ? '<p class="mut">Aucune pesée.</p>'
    : '<ul style="padding-left:18px;margin:4px 0 12px">' +
      ws.slice(0, 30).map(w =>
        `<li>${escapeHtml(w.date)} — <strong>${(+w.kg).toFixed(1)} kg</strong></li>`).join('') +
      '</ul>';
  const mHtml = ms.length === 0
    ? '<p class="mut">Aucune mensuration.</p>'
    : '<ul style="padding-left:18px;margin:4px 0 0">' +
      ms.slice(0, 20).map(m => {
        const parts = [];
        if (m.waistCm)   parts.push('taille ' + m.waistCm);
        if (m.hipsCm)    parts.push('hanches ' + m.hipsCm);
        if (m.bicepsLCm) parts.push('biceps G ' + m.bicepsLCm);
        if (m.bicepsRCm) parts.push('biceps D ' + m.bicepsRCm);
        if (m.thighCm)   parts.push('cuisse ' + m.thighCm);
        return `<li>${escapeHtml(m.date)} — ${escapeHtml(parts.join(', ') || '—')} (cm)</li>`;
      }).join('') +
      '</ul>';
  await openModal({
    title: 'Historique corporel',
    body: `<h3 style="margin:8px 0 4px;font-size:14px">Pesées (30 dernières)</h3>${wHtml}
           <h3 style="margin:12px 0 4px;font-size:14px">Mensurations (20 dernières)</h3>${mHtml}`,
    buttons: [{ label: 'Fermer', value: true, primary: true }],
  });
}

async function logBodyPhysio() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  const last = S.body.physio[S.body.physio.length - 1] || {};
  const result = await openModal({
    title: '💗 Physio du jour',
    body: `<p style="margin:0 0 8px;font-size:13px;line-height:1.4">
             Données mesurées le matin au réveil pour la fiabilité. Tous les
             champs sont facultatifs — logge ce que tu as.
           </p>
           <p class="mut" style="font-size:11px;margin:0 0 4px">
             <strong>HRV</strong> : variabilité cardiaque (ms, RMSSD typique 30-80).
             <strong>Sommeil</strong> : durée totale (h).
             <strong>FC repos</strong> : fréquence cardiaque au repos (bpm).
           </p>`,
    fields: [
      { name: 'date',  label: 'Date',           type: 'date',   value: today, required: true },
      { name: 'hrv',   label: 'HRV (ms)',       type: 'number', value: last.hrv   || '', inputmode: 'decimal' },
      { name: 'sleep', label: 'Sommeil (h)',    type: 'number', value: last.sleep || '', inputmode: 'decimal' },
      { name: 'rhr',   label: 'FC repos (bpm)', type: 'number', value: last.rhr   || '', inputmode: 'numeric' },
    ],
    buttons: [
      { label: 'Annuler',     value: false },
      { label: 'Enregistrer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const f = result.fields;
  const entry = { date: f.date };
  let any = false;
  const hrv = +f.hrv;   if (isFinite(hrv) && hrv > 0 && hrv < 300)   { entry.hrv = hrv;     any = true; }
  const sl  = +f.sleep; if (isFinite(sl) && sl > 0 && sl < 24)        { entry.sleep = sl;    any = true; }
  const rhr = +f.rhr;   if (isFinite(rhr) && rhr > 30 && rhr < 200)  { entry.rhr = rhr;     any = true; }
  if (!any) {
    showToast('Aucune valeur', { variant: 'info', message: 'Saisis au moins HRV, sommeil ou FC repos.' });
    return;
  }
  // Replace if same date.
  const idx = S.body.physio.findIndex(p => p.date === entry.date);
  if (idx >= 0) S.body.physio[idx] = entry;
  else S.body.physio.push(entry);
  S.body.physio.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  queueSave();
  showToast('Physio enregistrée', { variant: 'success',
    message: 'Composite readiness mis à jour.' });
  // Re-render home pour que la card Charge & Récup reflète immédiatement.
  const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
  if (homeVisible) openHome();
}

// importPhysioCSV — lit un fichier CSV physio et merge avec S.body.physio.
// Format : date,hrv,sleep,rhr (header optionnel auto-détecté). Utile pour
// les imports manuels (Apple Health export brut, dump Garmin Connect, etc.).
/* =================== INTÉGRATIONS PHYSIO LIVE ===================
 * Pilote l'UI du panneau "Wearables & santé" dans le profil.
 *
 * Deux providers, deux flows :
 *   - Strava       (kind:'live')    OAuth + webhooks push. Une seule
 *                                   connexion utilisateur, ensuite Strava
 *                                   nous push automatiquement chaque
 *                                   nouvelle activité.
 *   - Apple Health (kind:'webhook') Pas d'API web possible (contrainte
 *                                   Apple). On guide l'utilisateur vers
 *                                   un Raccourci iOS gratuit qui pousse
 *                                   les métriques chaque nuit sur notre
 *                                   webhook signé.
 *
 * La méta des providers vit dans PROVIDERS — étendre ce tableau pour
 * ajouter un nouveau service. Status d'une card :
 *   - 'live'    : OAuth direct, branché serveur
 *   - 'webhook' : reçoit via le webhook signé, guide pour configuration
 */

// PROVIDERS — métadonnées d'affichage et de comportement.
// `kind` : 'live' (OAuth direct), 'webhook' (via push externe), 'soon'.
// `connector` : id côté serveur (clé dans User.PhysioTokens). N/A pour webhook-only.
// `brandColor` : couleur de la pastille / accent. CSS color value.
// `bg` : couleur de fond de la card (CSS).
// `connectFn` : fonction JS appelée au clic du bouton de connexion.
const PROVIDERS = [
  {
    id: 'strava', name: 'Strava', kind: 'live', connector: 'strava',
    icon: '🏃', brandColor: '#FC4C02', bg: '#FC4C02', fg: '#fff',
    description: 'OAuth + webhooks push. Une seule connexion, on reçoit ensuite chaque activité automatiquement.',
    docUrl: 'https://developers.strava.com/',
    connectFn: 'physioStravaConnect', disconnectFn: 'physioStravaDisconnect',
    syncFn: 'physioSyncNow',
  },
  {
    id: 'applehealth', name: 'Apple Health', kind: 'webhook',
    icon: '', brandColor: '#000', bg: '#000', fg: '#fff', appleStyle: true,
    description: 'iPhone / Apple Watch via un Raccourci iOS gratuit. Configuration une fois, push quotidien automatique.',
    docUrl: 'https://support.apple.com/guide/shortcuts/welcome/ios',
    connectFn: 'physioAppleHealthGuide',
  },
];

// physioFetchIntegrations — récupère le statut auprès du serveur.
async function physioFetchIntegrations() {
  try {
    const res = await api('GET', '/api/physio/integrations');
    return res.integrations || {};
  } catch (e) {
    return null;
  }
}

// physioProviderCard — construit une card pour un provider donné.
// `status` : objet shape côté serveur (peut être undefined).
// Retourne { html, postWire } — postWire est appelé après injection.
function physioProviderCard(p, status, webhookUrl) {
  const isConnected = !!(status && status.enabled);
  const isLive = p.kind === 'live';
  const isWebhookProvider = p.kind === 'webhook' || p.kind === 'webhook-only';
  const isSoon = p.kind === 'soon';

  // Badge d'état.
  let badgeText, badgeColor;
  if (isConnected) {
    badgeText = '✓ Connecté';
    badgeColor = 'var(--success,#5DD4A4)';
  } else if (isWebhookProvider && p.id === 'webhook') {
    badgeText = (status && status.enabled) ? '✓ Actif' : 'Inactif';
    badgeColor = (status && status.enabled) ? 'var(--success,#5DD4A4)' : 'var(--mut)';
  } else if (isWebhookProvider) {
    badgeText = 'Via webhook';
    badgeColor = 'var(--blue,#7BA1FF)';
  } else if (isSoon) {
    badgeText = 'Bientôt';
    badgeColor = 'var(--mut)';
  } else {
    badgeText = 'Disponible';
    badgeColor = 'var(--accent)';
  }

  // Icône / logo. Apple style = pomme dessinée en SVG inline.
  const iconSvg = p.appleStyle
    ? `<svg viewBox="0 0 384 512" width="20" height="20" fill="currentColor" aria-hidden="true">
         <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
       </svg>`
    : `<span aria-hidden="true">${escapeHtml(p.icon || '🔗')}</span>`;

  // Bouton d'action principal — style "Connect with X" Microsoft-like.
  let actionHtml = '';
  if (isLive && !isConnected) {
    actionHtml = `
      <button type="button" data-action="connect" data-provider="${escapeHtml(p.id)}"
              class="provider-connect-btn"
              style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                     background:${escapeHtml(p.bg)};color:${escapeHtml(p.fg)};
                     border:1px solid ${escapeHtml(p.bg)};border-radius:6px;
                     font-size:13px;font-weight:500;cursor:pointer;width:100%;
                     justify-content:center;transition:opacity .15s">
        ${iconSvg}<span>Se connecter avec ${escapeHtml(p.name)}</span>
      </button>`;
  } else if (isLive && isConnected) {
    const lastSyncTxt = status.lastSync
      ? 'sync ' + relativeTime(Date.parse(status.lastSync))
      : 'jamais sync';
    actionHtml = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button type="button" data-action="sync" data-provider="${escapeHtml(p.id)}" class="sec"
                style="font-size:12px;padding:4px 10px;flex:1">⟲ Sync now</button>
        <button type="button" data-action="disconnect" data-provider="${escapeHtml(p.id)}" class="sec"
                style="font-size:11px;padding:4px 8px;color:var(--mut)">déconnecter</button>
      </div>
      <div class="mut" style="font-size:11px;margin-top:6px">${escapeHtml(lastSyncTxt)}</div>`;
  } else if (isWebhookProvider && p.id === 'webhook') {
    // Card webhook générique — boutons activer/copier/rotate/désactiver.
    if (status && status.enabled) {
      actionHtml = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
          <button type="button" data-action="webhook-copy" class="sec" style="font-size:11px;padding:4px 8px">📋 Copier</button>
          <button type="button" data-action="webhook-rotate" class="sec" style="font-size:11px;padding:4px 8px;color:var(--warn)">🔄 Rotate</button>
          <button type="button" data-action="webhook-disable" class="sec" style="font-size:11px;padding:4px 8px;color:var(--mut)">désactiver</button>
        </div>
        <code data-webhook-url style="display:block;font-size:10.5px;background:var(--bg);padding:6px 8px;
              border-radius:4px;word-break:break-all;border:1px solid var(--line);
              font-family:ui-monospace,Menlo,monospace">${escapeHtml(webhookUrl)}</code>`;
    } else {
      actionHtml = `
        <button type="button" data-action="webhook-enable" class="provider-connect-btn"
                style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                       background:${escapeHtml(p.bg)};color:${escapeHtml(p.fg)};
                       border:1px solid var(--line);border-radius:6px;
                       font-size:13px;font-weight:500;cursor:pointer;width:100%;
                       justify-content:center">
          ${iconSvg}<span>Activer le webhook</span>
        </button>`;
    }
  } else if (isWebhookProvider) {
    // Apple Health : guide pour configurer le Raccourci iOS qui POSTe
    // sur le webhook signé.
    actionHtml = `
      <button type="button" data-action="guide" data-provider="${escapeHtml(p.id)}"
              class="provider-connect-btn"
              style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                     background:${escapeHtml(p.bg)};color:${escapeHtml(p.fg)};
                     border:1px solid ${escapeHtml(p.bg)};border-radius:6px;
                     font-size:13px;font-weight:500;cursor:pointer;width:100%;
                     justify-content:center">
        ${iconSvg}<span>Configurer ${escapeHtml(p.name)}</span>
      </button>`;
  } else if (isSoon) {
    actionHtml = `
      <button type="button" disabled aria-disabled="true"
              title="OAuth pas encore implémenté — voir INTEGRATIONS.md pour le pattern"
              style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                     background:var(--bg);color:var(--mut);
                     border:1px dashed var(--line);border-radius:6px;
                     font-size:13px;cursor:not-allowed;width:100%;
                     justify-content:center;opacity:.6">
        ${iconSvg}<span>Bientôt — phase 2</span>
      </button>
      <a href="${escapeHtml(p.docUrl)}" target="_blank" rel="noopener"
         class="mut" style="font-size:11px;text-decoration:underline;color:var(--blue);
                            display:block;margin-top:4px;text-align:center">
        Doc API ↗
      </a>`;
  }

  const accentBar = `<div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:${escapeHtml(p.brandColor)};border-radius:3px 0 0 3px"></div>`;

  return `
    <div class="provider-card" data-provider-card="${escapeHtml(p.id)}"
         style="position:relative;padding:12px 14px 12px 18px;background:var(--bg2);
                border:1px solid var(--line);border-radius:8px;margin-bottom:8px">
      ${accentBar}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
        <strong style="font-size:14px">${escapeHtml(p.name)}</strong>
        <span style="background:var(--bg);color:${badgeColor};padding:2px 8px;
                     border-radius:6px;font-size:10.5px;font-weight:600;border:1px solid var(--line)">
          ${escapeHtml(badgeText)}
        </span>
      </div>
      <p class="mut" style="font-size:11.5px;margin:0 0 8px;line-height:1.4">
        ${escapeHtml(p.description)}
      </p>
      ${actionHtml}
    </div>`;
}

// physioRender — peint le panneau à partir du statut serveur.
async function physioRender() {
  const body = document.getElementById('physioIntegrationsBody');
  if (!body) return;
  const integ = await physioFetchIntegrations();
  if (!integ) {
    body.innerHTML = '<p class="err" style="font-size:12px;margin:0">Impossible de joindre le serveur.</p>';
    return;
  }
  const origin = window.location.origin;
  const wh = integ.webhook || { enabled: false };
  const webhookUrl = wh.enabled ? (origin + wh.path) : '';

  const cards = PROVIDERS.map(p => {
    let status = null;
    if (p.id === 'webhook') status = wh;
    else if (p.connector) status = integ[p.connector] || { enabled: false };
    return physioProviderCard(p, status, webhookUrl);
  }).join('');

  body.innerHTML = `
    <p class="mut" style="font-size:11.5px;margin:0 0 10px;line-height:1.5">
      Connecte Strava et Apple Health. Les données (activités, HRV, sommeil, FC repos)
      arrivent automatiquement et alimentent le score de readiness composite. Tu n'as
      qu'une connexion à faire — ensuite c'est totalement transparent.
    </p>
    ${cards}`;

  // Wire global event delegation.
  body.addEventListener('click', physioCardActionDelegate);
}

// physioCardActionDelegate — gestionnaire unique pour tous les boutons des
// cards. Lit data-action et data-provider pour router vers la bonne fn.
function physioCardActionDelegate(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const provider = btn.dataset.provider;
  switch (action) {
    case 'connect':
      if (provider === 'oura') physioOuraConnect();
      else if (provider === 'strava') physioStravaConnect();
      break;
    case 'disconnect':
      if (provider === 'oura') physioOuraDisconnect();
      else if (provider === 'strava') physioStravaDisconnect();
      break;
    case 'sync':
      if (provider === 'strava') physioStravaSync();
      else physioSync(false);
      break;
    case 'guide':
      if (provider === 'applehealth') physioAppleHealthGuide();
      break;
    case 'webhook-enable':
      physioWebhookEnable();
      break;
    case 'webhook-copy': {
      const code = ev.target.closest('.provider-card').querySelector('[data-webhook-url]');
      if (code) physioCopyWebhookUrl(code.textContent);
      break;
    }
    case 'webhook-rotate':
      physioWebhookRotate();
      break;
    case 'webhook-disable':
      physioWebhookDisable();
      break;
  }
}

// physioAppleHealthGuide — guide l'utilisateur à travers la création
// d'un Raccourci iOS gratuit qui POSTe quotidiennement HRV/sommeil/RHR
// vers notre webhook.
//
// Pourquoi cette approche : Apple ne fournit aucune API serveur pour
// HealthKit (les données vivent uniquement sur l'iPhone). Toute solution
// "cloud" passe forcément par un truc côté appareil. Les options :
//   - Health Auto Export (~5€) — payant, pas conforme à la promesse "gratuit"
//   - Raccourci iOS + Automation — natif Apple, gratuit, configuration une
//     seule fois (~5 min) puis le push s'exécute chaque nuit en arrière-plan
//   - App native — gros chantier, pas dans le scope
//
// On active le webhook server-side au préalable (l'iOS Shortcut va POST
// dessus). L'utilisateur est ensuite guidé pas à pas pour installer le
// Raccourci et programmer son automation.
async function physioAppleHealthGuide() {
  const integ = await physioFetchIntegrations();
  if (!integ) return;
  let wh = integ.webhook || { enabled: false };
  if (!wh.enabled) {
    // Activation silencieuse — c'est juste une plomberie côté serveur,
    // pas la peine de demander à l'utilisateur (il a déjà cliqué sur
    // "Configurer Apple Health", il sait pourquoi il est là).
    try {
      await api('POST', '/api/physio/integrations/webhook');
    } catch (e) {
      showToast('Erreur', { variant: 'error', message: e.message });
      return;
    }
    const integ2 = await physioFetchIntegrations();
    wh = (integ2 && integ2.webhook) || { enabled: false };
  }
  const url = window.location.origin + (wh.path || '');
  await openModal({
    title: '🍎 Apple Health — Raccourci iOS',
    body: `
      <p style="margin:0 0 10px;font-size:13px;line-height:1.5">
        Apple ne donne pas d'accès web aux données Health — il faut <strong>un
        Raccourci iOS</strong> qui les pousse depuis ton iPhone. C'est <strong>gratuit
        et natif Apple</strong> (pas d'app à acheter). Tout se fait <strong>sur ce
        téléphone</strong>, en ~3 min. Ensuite le push s'exécute chaque nuit, tout seul.
        <br><span class="mut" style="font-size:11px">Instructions à jour pour iOS 26 (app Raccourcis / Shortcuts).</span>
      </p>

      <p style="margin:14px 0 6px;font-size:13px;font-weight:600">1 · Copie ton URL</p>
      <p style="margin:0 0 4px;font-size:12px;color:var(--mut)">Appuie sur « Copier l'URL » en bas, puis garde-la — tu la colleras à l'étape 3.</p>
      <code style="display:block;font-size:11px;background:var(--bg);padding:8px;
            border-radius:4px;word-break:break-all;border:1px solid var(--line);
            font-family:ui-monospace,Menlo,monospace;margin:4px 0 14px">${escapeHtml(url)}</code>

      <p style="margin:0 0 6px;font-size:13px;font-weight:600">2 · Crée le raccourci</p>
      <ol style="margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.7">
        <li>Ouvre l'app <strong>Raccourcis</strong> — préinstallée sur iOS.</li>
        <li>Onglet <strong>Raccourcis</strong> → bouton <strong>+</strong> (en haut à droite) → tape sur le nom en haut pour le renommer « Coach Sync ».</li>
        <li>Touche <strong>« Ajouter une action »</strong>, cherche <strong>« Rechercher des échantillons de santé »</strong>. Règle <em>Type</em> = <em>Variabilité de la fréq. cardiaque</em> (HRV) et le filtre de date sur la dernière journée.</li>
        <li>Ajoute <strong>« Calculer des statistiques »</strong> → <em>Moyenne</em> sur le résultat précédent.</li>
        <li>Refais les deux dernières actions pour <em>Sommeil</em> (depuis iOS 26 les phases sont dispo directement) et <em>Fréquence cardiaque au repos</em>.</li>
      </ol>

      <p style="margin:0 0 6px;font-size:13px;font-weight:600">3 · Envoie vers le coach</p>
      <ol start="6" style="margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.7">
        <li>Ajoute <strong>« Obtenir le contenu de l'URL »</strong>, puis touche <strong>« Afficher plus »</strong> :
          <ul style="margin:4px 0 4px;padding-left:18px">
            <li>URL : <em>colle</em> l'URL copiée à l'étape 1</li>
            <li>Méthode : <code>POST</code></li>
            <li>Corps de la requête : <code>JSON</code></li>
            <li>Champs JSON (touche chaque valeur entre crochets et insère la variable correspondante) :
              <code style="display:block;font-size:10.5px;background:var(--bg);padding:6px 8px;border-radius:4px;border:1px solid var(--line);font-family:ui-monospace,Menlo,monospace;margin-top:4px">{ "date": "[Date du jour ISO]", "hrv": [Moyenne HRV], "sleep": [Moyenne Sommeil], "rhr": [Moyenne RHR] }</code>
            </li>
          </ul>
        </li>
      </ol>

      <p style="margin:0 0 6px;font-size:13px;font-weight:600">4 · Automatise (push quotidien)</p>
      <ol start="7" style="margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.7">
        <li>Onglet <strong>Automatisation</strong> (en bas) → <strong>+</strong> → <strong>« Heure de la journée »</strong> → 06:00 → <em>Quotidiennement</em>.</li>
        <li>Choisis <strong>« Exécuter immédiatement »</strong> (depuis iOS 17 c'est par défaut, aucune confirmation requise) → sélectionne le raccourci <strong>« Coach Sync »</strong> → <strong>OK</strong>.</li>
      </ol>

      <p class="mut" style="font-size:11px;margin:0;line-height:1.5">
        Le serveur accepte le format <code>{ date, hrv, sleep, rhr }</code> directement.
        Le secret de l'URL est unique à ton compte ; il peut être rotaté à tout moment
        (l'ancienne URL devient invalide). Pour pousser plus de métriques
        (énergie active, pas, masse corporelle…), ajoute simplement les champs
        correspondants au JSON. Astuce : lance le raccourci une fois à la main pour
        valider — iOS te demandera l'autorisation d'accès à Santé au premier run.
      </p>
    `,
    buttons: [
      { label: 'Copier l\'URL', value: 'copy', primary: false },
      { label: 'Fermer', value: true, primary: true },
    ],
  }).then(res => {
    if (res === 'copy') physioCopyWebhookUrl(url);
    physioRender();
  });
}

function physioSyncNow() { return physioSync(false); }

async function physioOuraConnect() {
  const result = await openModal({
    title: '💍 Connecter Oura',
    body: `<p style="margin:0 0 8px;font-size:13px;line-height:1.5">
             1. Ouvre <a href="https://cloud.ouraring.com/personal-access-tokens" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:underline">cloud.ouraring.com/personal-access-tokens</a><br>
             2. Génère un nouveau token (lecture seule)<br>
             3. Colle-le ici&nbsp;:
           </p>
           <p class="mut" style="font-size:11px;margin:4px 0 6px">
             Le token est stocké côté serveur (chmod 0600), jamais exposé au navigateur.
           </p>`,
    fields: [
      { name: 'token', label: 'Personal Access Token', type: 'password',
        autocomplete: 'off', required: true },
    ],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Connecter', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const tok = result.fields.token.trim();
  if (!tok) return;
  try {
    await api('POST', '/api/physio/integrations/oura', { token: tok });
    showToast('Oura connecté', { variant: 'success', message: 'On lance un premier sync.' });
    await physioRender();
    await physioSync(false);
  } catch (e) {
    showToast('Échec connexion', { variant: 'error', message: e.message || 'Token rejeté par Oura.' });
  }
}

async function physioOuraDisconnect() {
  const ok = await openConfirm('Déconnecter Oura ?',
    'Le token sera supprimé du serveur. Les données déjà synchronisées sont conservées.',
    { confirmLabel: 'Déconnecter', cancelLabel: 'Annuler' });
  if (!ok) return;
  try {
    await api('DELETE', '/api/physio/integrations/oura');
    showToast('Oura déconnecté', { variant: 'info', message: 'Token supprimé.' });
    await physioRender();
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
}

// physioStravaConnect — ouvre /auth/strava/start dans une popup. Strava
// redirige vers /auth/strava/callback qui notifie cette fenêtre par
// postMessage. À ce moment-là on rafraîchit le panneau et on déclenche
// un sync local pour rapatrier les activités.
//
// UX promise tenue : le user clique le bouton, autorise sur Strava, et
// c'est terminé. Aucune autre manipulation. Les nouvelles activités
// arriveront ensuite par webhook push automatique.
async function physioStravaConnect() {
  // Listener temporaire — désinstallé après un succès ou un timeout.
  const win = window.open('/auth/strava/start', 'strava_oauth',
    'width=560,height=720,menubar=no,toolbar=no,location=yes');
  if (!win) {
    showToast('Popup bloquée', { variant: 'error',
      message: 'Autorise les popups sur ce site puis recommence.' });
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const onMsg = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data.type !== 'strava-connected') return;
      settled = true;
      window.removeEventListener('message', onMsg);
      if (ev.data.status === 'ok') {
        showToast('Strava connecté', { variant: 'success',
          message: 'On rapatrie tes activités récentes.' });
      } else {
        showToast('Connexion Strava échouée', { variant: 'error' });
      }
      resolve();
    };
    window.addEventListener('message', onMsg);
    // Garde-fou : si le user ferme la popup sans postMessage, on poll
    // sa fermeture et on resolve quand même (le state expirera serveur-side).
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        if (!settled) {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      }
    }, 500);
  });
  await physioRender();
  // Petit délai pour laisser le sync initial server-side écrire dans
  // le data file, puis on recharge la home.
  setTimeout(() => {
    const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
    if (homeVisible) openHome();
  }, 1500);
}

async function physioStravaDisconnect() {
  const ok = await openConfirm('Déconnecter Strava ?',
    'Le serveur ne recevra plus les nouvelles activités. Les données déjà ' +
    'synchronisées sont conservées. Tu pourras te reconnecter à tout moment.',
    { confirmLabel: 'Déconnecter', cancelLabel: 'Annuler' });
  if (!ok) return;
  try {
    await api('DELETE', '/api/physio/integrations/strava');
    showToast('Strava déconnecté', { variant: 'info' });
    await physioRender();
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
}

// physioStravaSync — fetch manuel des 30 derniers jours. Utilisé par le
// bouton "Sync now" sur la card Strava. Pas vraiment nécessaire en usage
// normal (le webhook fait le boulot), mais utile pour rattraper après
// un downtime serveur ou si la subscription webhook n'est pas encore
// enregistrée par l'opérateur.
async function physioStravaSync() {
  try {
    const res = await api('POST', '/api/physio/integrations/strava/sync');
    showToast('Strava synchronisé', { variant: 'success',
      message: `${res.received || 0} activité${(res.received || 0) > 1 ? 's' : ''} rapatriée${(res.received || 0) > 1 ? 's' : ''}.` });
    await physioRender();
    const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
    if (homeVisible) openHome();
  } catch (e) {
    showToast('Sync échoué', { variant: 'error', message: e.message });
  }
}

// physioSync — déclenche un sync manuel et merge les entrées dans S.body.physio.
// silent=true → pas de toast en cas de succès (utilisé par auto-sync).
async function physioSync(silent) {
  try {
    const res = await api('POST', '/api/physio/sync');
    const entries = res.entries || [];
    if (entries.length === 0) {
      if (!silent) showToast('Aucune nouvelle donnée', { variant: 'info', message: 'Tout est déjà à jour.' });
      return;
    }
    ensureBodyState();
    const byDate = {};
    for (const p of S.body.physio) byDate[p.date] = p;
    for (const e of entries) {
      const existing = byDate[e.date] || { date: e.date };
      if (e.hrv > 0)   existing.hrv = e.hrv;
      if (e.sleep > 0) existing.sleep = e.sleep;
      if (e.rhr > 0)   existing.rhr = e.rhr;
      byDate[e.date] = existing;
    }
    S.body.physio = Object.values(byDate).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    queueSave();
    if (!silent) showToast('Sync OK', {
      variant: 'success',
      message: `${entries.length} entrée${entries.length > 1 ? 's' : ''} synchronisée${entries.length > 1 ? 's' : ''}.`
    });
    await physioRender();
    const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
    if (homeVisible) openHome();
  } catch (e) {
    if (!silent) showToast('Sync échoué', { variant: 'error', message: e.message });
  }
}

async function physioWebhookEnable() {
  try {
    const res = await api('POST', '/api/physio/integrations/webhook');
    showToast('Webhook activé', { variant: 'success', message: 'URL générée — copie-la.' });
    await physioRender();
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
}

async function physioWebhookRotate() {
  const ok = await openConfirm('Rotate le secret webhook ?',
    "L'ancienne URL deviendra invalide immédiatement. Les services qui l'utilisent devront être reconfigurés.",
    { confirmLabel: 'Rotate', cancelLabel: 'Annuler', danger: true });
  if (!ok) return;
  try {
    await api('POST', '/api/physio/integrations/webhook');
    showToast('Secret renouvelé', { variant: 'info', message: 'Nouvelle URL prête.' });
    await physioRender();
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
}

async function physioWebhookDisable() {
  const ok = await openConfirm('Désactiver le webhook ?',
    "L'URL ne fonctionnera plus. Les push entrants seront refusés (404).",
    { confirmLabel: 'Désactiver', cancelLabel: 'Annuler' });
  if (!ok) return;
  try {
    await api('DELETE', '/api/physio/integrations/webhook');
    showToast('Webhook désactivé', { variant: 'info' });
    await physioRender();
  } catch (e) {
    showToast('Erreur', { variant: 'error', message: e.message });
  }
}

async function physioCopyWebhookUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    showToast('URL copiée', { variant: 'success' });
  } catch (e) {
    // Fallback : sélectionner le code pour copy manuel.
    const el = document.getElementById('physioWebhookUrl');
    if (el) {
      const range = document.createRange();
      range.selectNode(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
    showToast('Sélectionne et copie', { variant: 'info' });
  }
}

// relativeTime — "il y a 5 min", "il y a 2h", etc.
function relativeTime(ts) {
  const ms = Date.now() - ts;
  if (ms < 0) return 'dans le futur';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

async function importPhysioCSV(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('Fichier trop gros', { variant: 'error', message: 'Limite 2 MiB.' });
    return;
  }
  const text = await file.text();
  if (!window.Banister || typeof window.Banister.parseCSV !== 'function') {
    showToast('Module Banister manquant', { variant: 'error', message: 'Recharge la page.' });
    return;
  }
  const parsed = window.Banister.parseCSV(text);
  if (parsed.length === 0) {
    showToast('CSV invalide', { variant: 'error',
      message: 'Format attendu : date,hrv,sleep,rhr (une ligne par jour).' });
    return;
  }
  ensureBodyState();
  // Merge : pour chaque ligne, replace si même date, sinon push.
  const byDate = {};
  for (const p of S.body.physio) byDate[p.date] = p;
  let added = 0, replaced = 0;
  for (const p of parsed) {
    if (byDate[p.date]) replaced++; else added++;
    byDate[p.date] = p;
  }
  S.body.physio = Object.values(byDate).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  queueSave();
  showToast('CSV importé', { variant: 'success',
    message: `${added} ajoutés · ${replaced} remplacés · ${parsed.length} lignes.` });
  const homeVisible = !document.getElementById('viewHome').classList.contains('hide');
  if (homeVisible) openHome();
}

const _bodyLogWeightBtn = document.getElementById('bodyLogWeightBtn');
if (_bodyLogWeightBtn) _bodyLogWeightBtn.addEventListener('click', logBodyWeight);
const _bodyLogMeasureBtn = document.getElementById('bodyLogMeasureBtn');
if (_bodyLogMeasureBtn) _bodyLogMeasureBtn.addEventListener('click', logBodyMeasurements);
const _bodyLogPhysioBtn = document.getElementById('bodyLogPhysioBtn');
if (_bodyLogPhysioBtn) _bodyLogPhysioBtn.addEventListener('click', logBodyPhysio);
const _bodyImportCsvBtn = document.getElementById('bodyImportCsvBtn');
const _bodyImportCsvInput = document.getElementById('bodyImportCsvInput');
if (_bodyImportCsvBtn && _bodyImportCsvInput) {
  _bodyImportCsvBtn.addEventListener('click', () => _bodyImportCsvInput.click());
  _bodyImportCsvInput.addEventListener('change', () => {
    const f = _bodyImportCsvInput.files && _bodyImportCsvInput.files[0];
    if (f) importPhysioCSV(f);
    _bodyImportCsvInput.value = ''; // permet de re-importer le même fichier
  });
}
const _bodyHistoryBtn = document.getElementById('bodyHistoryBtn');
if (_bodyHistoryBtn) _bodyHistoryBtn.addEventListener('click', showBodyHistory);

/* =================== MODE RÉÉDUCATION ===================
 * Tout le câblage UI du mode rééduc — toggle, config zones/date/phase,
 * disclaimer médical, indicateurs visuels. La logique métier (exos,
 * phases, génération de séance) vit dans public/rehab.js (window.Rehab).
 * Le mode est sauvegardé dans S.rehab et persisté au même titre que le
 * reste de S.data via le whitelist serveur (data.go).
 */

// Initialise S.rehab à un état neutre si absent. Idempotent.
function ensureRehabState() {
  if (!S.rehab || typeof S.rehab !== 'object') {
    S.rehab = {
      active: false,
      injuryDate: '',
      zones: [],
      manualPhase: null,                 // null = auto, sinon 'aigue'/'subaigue'/'retour'
      acceptedDisclaimerAt: null,
      acceptedDisclaimerVersion: null,
    };
  }
}

// Construit dynamiquement les chips de zones à partir de Rehab.ZONES.
// Réinjecté à chaque ouverture du profil pour rester sync avec S.rehab.zones.
function renderRehabZones() {
  const container = document.getElementById('rehabZones');
  if (!container || !window.Rehab) return;
  const selected = new Set((S.rehab && S.rehab.zones) || []);
  container.innerHTML = window.Rehab.ZONES.map(z =>
    `<button type="button" class="chip${selected.has(z.id) ? ' on' : ''}"
             data-rehabzone="${escapeHtml(z.id)}"
             title="${escapeHtml(z.desc)}">${escapeHtml(z.label)}</button>`
  ).join('');
  // Wire click sans s'appuyer sur wireChips (qui ne lit pas data-rehabzone).
  container.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      c.classList.toggle('on');
      const ids = [...container.querySelectorAll('.chip.on')]
        .map(x => x.dataset.rehabzone);
      ensureRehabState();
      S.rehab.zones = ids;
      // Une nouvelle zone touchée = la séance générée doit être recalculée.
      S.currentSession = null;
      queueSave();
      refreshRehabPhaseHint();
    });
  });
}

// Met à jour l'aperçu de la phase calculée et sa description sous le select.
function refreshRehabPhaseHint() {
  const hint = document.getElementById('rehabPhaseHint');
  if (!hint || !window.Rehab) return;
  ensureRehabState();
  if (!S.rehab.injuryDate) {
    hint.textContent = 'Saisis la date pour calculer la phase courante.';
    return;
  }
  const phase = window.Rehab.computePhase(S.rehab.injuryDate, S.rehab.manualPhase);
  const dayLabel = phase.daysSince === 0
    ? "aujourd'hui"
    : phase.daysSince === 1 ? 'hier' : 'il y a ' + phase.daysSince + ' jours';
  const overrideTxt = phase.manual ? ' (forcée manuellement)' : ' (auto)';
  hint.innerHTML = `Phase <strong>${escapeHtml(phase.label)}</strong>${overrideTxt} — ${escapeHtml(phase.range)}.<br>
    <span style="opacity:.85">${escapeHtml(phase.summary)}</span><br>
    <span class="mut">Blessure ${escapeHtml(dayLabel)}.</span>`;
}

// Synchronise l'apparence du toggle, du panneau config et de la bannière
// header avec l'état S.rehab.
function refreshRehabUI() {
  ensureRehabState();
  const btn = document.getElementById('rehabToggleBtn');
  const sub = document.getElementById('rehabToggleSub');
  const lbl = document.getElementById('rehabToggleLabel');
  const dot = document.getElementById('rehabToggleDot');
  const cfg = document.getElementById('rehabConfig');
  const date = document.getElementById('rehabInjuryDate');
  const phaseSel = document.getElementById('rehabPhaseSelect');
  if (!btn) return;
  const on = !!S.rehab.active;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (lbl) lbl.textContent = on ? 'Mode rééduc activé' : 'Activer le mode rééduc';
  if (sub) sub.textContent = on
    ? 'Activé — séances de rééducation à la place des séances normales'
    : 'Désactivé — séances normales d\'entraînement';
  if (dot) {
    dot.textContent = on ? '●' : '○';
    dot.style.color = on ? 'var(--accent)' : 'var(--mut)';
  }
  if (cfg) cfg.classList.toggle('hide', !on);
  if (date && S.rehab.injuryDate) date.value = S.rehab.injuryDate;
  if (phaseSel) phaseSel.value = S.rehab.manualPhase || 'auto';
  refreshRehabPhaseHint();
  // Si la home est déjà rendue (cas d'un toggle depuis le profil → retour),
  // on rafraîchit aussi sa bannière. Sinon openHome() s'en chargera.
  renderRehabBanner();
  if (on) renderRehabZones();
}

// renderRehabBanner injecte (ou retire) une bannière dans la home pour
// rappeler que le mode rééduc est actif et afficher la phase courante.
// Idempotent — appelée à chaque openHome().
function renderRehabBanner() {
  const home = document.getElementById('viewHome');
  if (!home) return;
  let banner = document.getElementById('rehabBanner');
  const isActive = !!(S.rehab && S.rehab.active);
  if (!isActive) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'rehabBanner';
    banner.className = 'card';
    banner.style.cssText = 'border-left:3px solid var(--accent);padding:12px 14px';
    // Insère en TOUT premier dans viewHome.
    home.insertBefore(banner, home.firstChild);
  }
  if (!window.Rehab) {
    banner.innerHTML = '<strong>🩹 Mode rééduc actif</strong>';
    return;
  }
  const zonesCount = (S.rehab.zones || []).length;
  if (zonesCount === 0) {
    banner.innerHTML = `
      <div style="font-size:14px;line-height:1.5">
        <strong>🩹 Mode rééduc actif — config incomplète.</strong><br>
        <span class="mut">Va dans Profil pour choisir les zones touchées et la date.</span>
      </div>`;
    return;
  }
  const phase = window.Rehab.computePhase(S.rehab.injuryDate, S.rehab.manualPhase);
  const zonesLabels = (S.rehab.zones || [])
    .map(zid => (window.Rehab.ZONES.find(z => z.id === zid) || {}).label || zid)
    .join(', ');
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
      <div style="font-size:14px;line-height:1.5;flex:1;min-width:0">
        <strong>🩹 Mode rééduc — phase ${escapeHtml(phase.label.toLowerCase())}</strong><br>
        <span class="mut">${escapeHtml(zonesLabels)} · J${phase.daysSince} depuis blessure</span>
      </div>
      <button type="button" id="rehabBannerOpenProfile" class="sec"
              style="flex:0 0 auto;font-size:12px">Configurer</button>
    </div>`;
  const btn = document.getElementById('rehabBannerOpenProfile');
  if (btn) btn.addEventListener('click', () => openOnboarding());
}

// Ouvre le disclaimer médical dans une modale custom (DOM construit à la
// main pour pouvoir lire la case à cocher avant fermeture). Le bouton
// principal reste désactivé tant que la case n'est pas cochée. Retourne
// true si accepté, false sinon. La logique est volontairement séparée
// d'openModal — l'API standard ne permet pas de gérer un checkbox
// dans le body avec validation gating.
function openRehabDisclaimer() {
  return new Promise((resolve) => {
    if (!window.Rehab) return resolve(false);
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const cbId = 'rehabDiscAccept_' + Math.random().toString(36).slice(2, 8);
    back.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="rehabDiscTitle">
        <h2 id="rehabDiscTitle">⚠️ Avertissement médical — mode rééducation</h2>
        <div class="modal-body">${window.Rehab.DISCLAIMER_HTML}
          <label for="${cbId}"
                 style="display:flex;align-items:flex-start;gap:10px;padding:12px;
                        background:var(--bg);border:1px solid var(--line);border-radius:10px;
                        margin-top:10px;cursor:pointer;font-size:14px;line-height:1.45">
            <input type="checkbox" id="${cbId}"
                   style="margin-top:3px;width:18px;height:18px;flex:0 0 auto;cursor:pointer">
            <span>Je confirme avoir lu cet avertissement, avoir consulté un professionnel
                  de santé concernant ma blessure, et j'accepte d'utiliser ce mode comme
                  un outil de soutien et non comme un avis médical.</span>
          </label>
        </div>
        <p class="err" role="alert" id="rehabDiscErr" style="margin-top:8px"></p>
        <div class="modal-actions">
          <button type="button" class="sec" id="rehabDiscCancel">Annuler</button>
          <button type="button" class="magenta" id="rehabDiscOk" disabled
                  aria-disabled="true">J'ai compris, activer</button>
        </div>
      </div>`;
    const trigger = document.activeElement;
    const cb = back.querySelector('#' + cbId);
    const ok = back.querySelector('#rehabDiscOk');
    const cancel = back.querySelector('#rehabDiscCancel');
    const err = back.querySelector('#rehabDiscErr');
    cb.addEventListener('change', () => {
      ok.disabled = !cb.checked;
      ok.setAttribute('aria-disabled', cb.checked ? 'false' : 'true');
      if (cb.checked) err.textContent = '';
    });
    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (trigger && document.body.contains(trigger)) trigger.focus();
      else document.getElementById('mainContent')?.focus();
    }
    function onKey(e) {
      // Pas d'Esc — disclaimer critique. L'utilisateur DOIT cliquer un bouton.
      if (e.key === 'Tab') {
        const items = back.querySelectorAll('input, button');
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }
    ok.addEventListener('click', () => {
      if (!cb.checked) {
        err.textContent = 'Coche la case pour confirmer.';
        cb.focus();
        return;
      }
      cleanup();
      resolve(true);
    });
    cancel.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    cb.focus();
  });
}

// Active le mode rééduc — ouvre le disclaimer si pas encore accepté à la
// version courante. Au succès, met à jour S.rehab + l'UI + invalide la
// séance courante (qui n'a pas le bon type).
async function activateRehab() {
  ensureRehabState();
  const cur = S.rehab.acceptedDisclaimerVersion;
  const need = window.Rehab && window.Rehab.DISCLAIMER_VERSION;
  if (cur !== need) {
    const ok = await openRehabDisclaimer();
    if (!ok) {
      showToast('Mode non activé', { variant: 'info', message: "L'avertissement n'a pas été accepté." });
      return;
    }
    S.rehab.acceptedDisclaimerAt = new Date().toISOString();
    S.rehab.acceptedDisclaimerVersion = need;
  }
  S.rehab.active = true;
  // Première activation : préremplir avec aujourd'hui si aucune date.
  if (!S.rehab.injuryDate) {
    S.rehab.injuryDate = new Date().toISOString().slice(0, 10);
  }
  S.currentSession = null;
  queueSave();
  refreshRehabUI();
  showToast('Mode rééduc activé', {
    variant: 'success',
    message: 'Sélectionne tes zones touchées pour générer une séance.'
  });
}

// Désactive le mode rééduc — confirme avant pour éviter une fausse manip.
async function deactivateRehab() {
  const ok = await openConfirm(
    'Désactiver le mode rééduc ?',
    'Tu reviens aux séances normales. Ta config rééduc (zones, date) reste mémorisée si tu réactives plus tard.',
    { confirmLabel: 'Désactiver', cancelLabel: 'Annuler' }
  );
  if (!ok) return;
  ensureRehabState();
  S.rehab.active = false;
  S.currentSession = null;
  queueSave();
  refreshRehabUI();
  showToast('Mode rééduc désactivé', { variant: 'info', message: 'Retour aux séances normales.' });
}

// Listeners — branchés une seule fois, après le chargement du DOM (le
// script.app.js est chargé en bas de body donc les éléments existent).
const _rehabToggleBtn = document.getElementById('rehabToggleBtn');
if (_rehabToggleBtn) {
  _rehabToggleBtn.addEventListener('click', () => {
    ensureRehabState();
    if (S.rehab.active) deactivateRehab();
    else activateRehab();
  });
}
const _rehabInjuryDate = document.getElementById('rehabInjuryDate');
if (_rehabInjuryDate) {
  _rehabInjuryDate.addEventListener('change', () => {
    ensureRehabState();
    S.rehab.injuryDate = _rehabInjuryDate.value;
    S.currentSession = null;
    queueSave();
    refreshRehabPhaseHint();
  });
}
const _rehabPhaseSelect = document.getElementById('rehabPhaseSelect');
if (_rehabPhaseSelect) {
  _rehabPhaseSelect.addEventListener('change', () => {
    ensureRehabState();
    const v = _rehabPhaseSelect.value;
    S.rehab.manualPhase = (v === 'auto') ? null : v;
    S.currentSession = null;
    queueSave();
    refreshRehabPhaseHint();
  });
}
const _rehabReadDisclaimerBtn = document.getElementById('rehabReadDisclaimerBtn');
if (_rehabReadDisclaimerBtn) {
  _rehabReadDisclaimerBtn.addEventListener('click', () => openRehabDisclaimer());
}


document.getElementById('onbDone').addEventListener('click', async () => {
  const goals = readChips('onbGoals');
  const gear = readChips('onbGear');
  if (gear.length === 0) { showToast('Équipement manquant', { variant: 'error', message: 'Choisis au moins un équipement (ou « poids du corps »).' }); return; }
  if (goals.length === 0) { showToast('Objectif manquant', { variant: 'error', message: 'Choisis au moins un objectif d\'entraînement.' }); return; }
  // Garde-fou mineur — RGPD art. 8 + loi française fixent le seuil de
  // consentement numérique à 15 ans. En dessous, un consentement parental
  // est requis et nous ne pouvons pas l'authentifier dans cette app.
  // On bloque la création du profil avec un message explicite.
  const ageVal = +document.getElementById('onbAge').value;
  if (ageVal && ageVal < 15) {
    await openAlert(
      'Âge minimum requis',
      'Coach Adaptatif n\'est pas accessible aux personnes de moins de 15 ans (' +
      'seuil français de consentement numérique). Si tu es accompagné par un parent ' +
      'ou un tuteur légal, demande-lui de contacter joly.jonathan@protonmail.com pour ' +
      'que la situation soit examinée. Sinon, reviens à 15 ans !'
    );
    return;
  }
  S.profile = {
    age: ageVal,
    weight: +document.getElementById('onbWeight').value,
    height: +document.getElementById('onbHeight').value,
    sex: document.getElementById('onbSex').value,
    level: +document.getElementById('onbLevel').value,
    goals, gear,
    freq: +document.getElementById('onbFreq').value,
    duration: +document.getElementById('onbDur').value,
    maxHalteres: +document.getElementById('onbMaxHalteres').value || null,
    maxBarre: +document.getElementById('onbMaxBarre').value || null,
    diet: document.getElementById('onbDiet').value,
    nutGoal: document.getElementById('onbNutGoal').value,
    meals: +document.getElementById('onbMeals').value,
    water: +document.getElementById('onbWater').value,
    allergies: readChips('onbAllergies'),
    painToday: readChips('onbPain'),
  };
  S.currentSession = null;
  queueSave();
  openHome();
});

/* =================== PROGRAM GENERATOR =================== */
function pickGroups() {
  const rotations = [
    ['legs','core'],
    ['chest','shoulders','arms'],
    ['back','arms','core'],
    ['legs','back'],
    ['chest','back','core'],
  ];
  const lastIdx = S.history.length > 0 ? (S.history[S.history.length-1].rotIdx ?? -1) : -1;
  const idx = (lastIdx + 1) % rotations.length;
  return { groups: rotations[idx], rotIdx: idx };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h;
}

function baseSetRep(p) {
  const isForce = p.goals.includes('force');
  const isHyper = p.goals.includes('hypertrophie');
  const isEndu = p.goals.includes('endurance') || p.goals.includes('perte_gras');
  if (isForce && !isEndu) return { sets: 4, reps: 5, rest: 120 };
  if (isHyper) return { sets: 4, reps: 10, rest: 75 };
  if (isEndu) return { sets: 3, reps: 15, rest: 45 };
  return { sets: 3, reps: 10, rest: 60 };
}

function modFromForm() {
  // Source effective de la forme : composite Banister si données physio
  // récentes (Banister.readiness avec hasPhysio === true), sinon le
  // formScore déclaratif. Le composite intègre HRV/sommeil/FC repos +
  // TSB + formScore. Cette substitution est invisible pour l'utilisateur
  // sans wearable — modFromForm garde son comportement legacy.
  let f = S.formScore;
  let source = 'declarative';
  if (window.Banister && S.body && Array.isArray(S.body.physio) && S.body.physio.length > 0) {
    const r = window.Banister.readiness(S.history, S.body.physio, S.formScore);
    if (r && r.hasPhysio) {
      f = r.score;
      source = 'composite';
    }
  }
  let setDelta = 0, repDelta = 0, restDelta = 0, loadBumpKg = 0;
  if (f >= 80) { setDelta = 1; repDelta = 1; loadBumpKg = 0.25; }
  else if (f >= 65) { repDelta = 1; loadBumpKg = 0.1; }
  else if (f >= 50) { /* stable */ }
  else if (f >= 35) { repDelta = -1; restDelta = 15; loadBumpKg = -0.1; }
  else { setDelta = -1; repDelta = -2; restDelta = 30; loadBumpKg = -0.25; }
  const last = S.history[S.history.length - 1];
  if (last) {
    if (last.rpe >= 9) { setDelta = Math.min(setDelta, 0) - 1; restDelta += 15; }
    if (last.rpe <= 3) { repDelta += 1; loadBumpKg += 0.1; }
  }
  return { setDelta, repDelta, restDelta, loadBumpKg, formSource: source, formUsed: f };
}

function findLastExo(exoId) {
  for (let i = S.history.length - 1; i >= 0; i--) {
    const h = S.history[i];
    const last = [...(h.sets || [])].reverse().find(s => s.exoId === exoId && s.weight);
    if (last) return last;
  }
  return null;
}

// Returns {weight, reason}. Progressive overload: if last time completed all reps
// easily (RPE <=7, no miss) → +2.5kg. If struggled (RPE >=9 or missed reps) → -2.5kg
// or stay. Otherwise maintain.
// estimate1RM — Epley formula: 1RM = w * (1 + r/30). Reliable for r in 1..10.
// Above 10 reps the formula overestimates badly — we cap reps at 10 and return
// the conservative estimate, with a flag the UI can use to mark it as "rough".
// Returns { weight, formula, reliable }. weight is null for invalid input.
function estimate1RM(weight, reps) {
  const w = +weight, r = +reps;
  if (!isFinite(w) || w <= 0 || !isFinite(r) || r < 1) {
    return { weight: null, formula: 'epley', reliable: false };
  }
  const cappedReps = Math.min(r, 10);
  const oneRM = w * (1 + cappedReps / 30);
  return {
    weight: Math.round(oneRM * 2) / 2, // round to 0.5kg
    formula: 'epley',
    reliable: r <= 10,
  };
}

/* =================== PLATEAU DETECTION ===================
 * Compare le best 1RM estimé sur les N dernières semaines au best d'avant.
 * Si pas d'amélioration → exo en plateau. On suggère ensuite une variation
 * via suggestVariation() qui réutilise la logique de openSwapModal.
 *
 * Pourquoi ça compte : la progression linéaire stagne après 3-6 mois sur
 * la plupart des exos, et les utilisateurs ne s'en rendent souvent pas
 * compte avant d'avoir perdu plusieurs semaines de momentum. La carte
 * d'alerte sur la home rend ce pattern visible.
 */
function detectPlateaus(history, opts) {
  opts = opts || {};
  const weeksWindow = opts.weeksWindow || 6;
  const minSets    = opts.minSets    || 3;
  const now = Date.now();
  const cutoff = now - weeksWindow * 7 * 86400000;

  const byExo = {};
  for (const h of (history || [])) {
    if (h && (h.kind === 'snack' || h.kind === 'external')) continue;
    const t = Date.parse(h.date || '');
    if (Number.isNaN(t)) continue;
    for (const s of (h.sets || [])) {
      if (!s.exoId || !s.weight || !s.reps) continue;
      const est = estimate1RM(s.weight, s.reps);
      if (est.weight == null) continue;
      byExo[s.exoId] = byExo[s.exoId] || [];
      byExo[s.exoId].push({ t, est: est.weight });
    }
  }

  const out = [];
  for (const exoId of Object.keys(byExo)) {
    const points = byExo[exoId];
    if (points.length < minSets) continue;
    points.sort((a, b) => a.t - b.t);
    const recent = points.filter(p => p.t >= cutoff);
    const older  = points.filter(p => p.t <  cutoff);
    // Besoin d'historique avant la fenêtre pour comparer (sinon c'est un
    // exo récemment ajouté, pas un plateau).
    if (recent.length < 2 || older.length === 0) continue;
    const recentMax = Math.max.apply(null, recent.map(p => p.est));
    const olderMax  = Math.max.apply(null, older.map(p => p.est));
    if (recentMax <= olderMax) {
      // Date du dernier set qui a égalé olderMax = jalon de la dernière progression.
      const lastImpT = older
        .filter(p => p.est >= olderMax)
        .reduce(function (m, p) { return Math.max(m, p.t); }, 0);
      const daysSince = Math.floor((now - lastImpT) / 86400000);
      const lib = EX_BY_ID[exoId];
      out.push({
        exoId,
        name: (lib && lib.n) || exoId,
        bestEst: olderMax,
        daysSince,
      });
    }
  }
  out.sort((a, b) => b.daysSince - a.daysSince);
  return out;
}

// suggestVariation — pour un exo donné, retourne jusqu'à 3 alternatives
// sensées : même groupe musculaire principal, gear compatible avec le profil,
// non-bloquées par les douleurs déclarées, et différentes du courant. Réutilise
// l'esprit de openSwapModal (mais plus simple : juste une liste, pas de modale).
function suggestVariation(exoId) {
  const lib = EX_BY_ID[exoId];
  if (!lib || !S.profile) return [];
  const userGear = new Set(S.profile.gear || []);
  const avoid = new Set(S.profile.painToday || []);
  const primaryZone = (lib.z || [])[0];
  const candidates = EX.filter(e =>
    e.id !== exoId &&
    e.z.includes(primaryZone) &&
    e.gear.some(g => userGear.has(g)) &&
    (!e.needs || e.needs.every(g => userGear.has(g))) &&
    !e.pain.some(p => avoid.has(p))
  );
  // Préfère les exos sur lesquels l'utilisateur n'a pas (encore) de plateau,
  // i.e. soit il les a faits et progresse, soit il ne les a jamais faits
  // (vrai effet de fraîcheur).
  const plateauedSet = new Set(detectPlateaus(S.history).map(p => p.exoId));
  candidates.sort(function (a, b) {
    const aBad = plateauedSet.has(a.id) ? 1 : 0;
    const bBad = plateauedSet.has(b.id) ? 1 : 0;
    return aBad - bBad;
  });
  return candidates.slice(0, 3);
}

// best1RMFor — scan the user's history and return their best estimated 1RM
// for a given exercise. Useful for percentage-based prescriptions.
function best1RMFor(history, exoId) {
  if (!Array.isArray(history)) return null;
  let best = null;
  for (const h of history) {
    for (const s of (h.sets || [])) {
      if (s.exoId !== exoId) continue;
      const est = estimate1RM(s.weight, s.reps);
      if (est.weight != null && (best == null || est.weight > best)) {
        best = est.weight;
      }
    }
  }
  return best;
}

// warmupSets — for heavy compound lifts, suggest 1-2 ramp-up sets so the user
// doesn't go cold into the working weight. Pure function: does NOT mutate the
// session, doesn't require logging (the user just does them; no XP, no PR).
// Returns [] when warm-ups are unnecessary (light load, isolation, BW, timed).
//
// Heuristic:
//   - only barbell/dumbbell compounds in the COMPOUND_IDS set
//   - only if working weight is provided AND ≥ 40kg
//   - 50% × 5 reps, 70% × 3 reps, rounded to 2.5kg
//     (we keep both even at 40kg because the gradient is gentle anyway)
//   - if weight < 60kg we drop the 70% set — overkill at light loads
const COMPOUND_IDS = new Set(['squat','sdt','sdtrm','dc','militaire','row','dcincline','hipthrust']);
function renderWarmupHint(sets) {
  if (!sets || sets.length === 0) return '';
  const items = sets.map(s =>
    `<li>${s.weight}kg × ${s.reps} <span style="opacity:.7">(${s.pct}%)</span></li>`).join('');
  return `<div class="focus-warmup">
    <div class="focus-warmup-title">🔥 Échauffement suggéré (avant la 1ʳᵉ série)</div>
    <ul>${items}</ul>
  </div>`;
}
function warmupSets(exoId, workingWeight) {
  if (!COMPOUND_IDS.has(exoId)) return [];
  const w = +workingWeight;
  if (!isFinite(w) || w < 40) return [];
  const r = (kg) => Math.max(0, Math.round(kg / 2.5) * 2.5);
  const out = [{ pct: 50, weight: r(w * 0.5), reps: 5 }];
  if (w >= 60) out.push({ pct: 70, weight: r(w * 0.7), reps: 3 });
  return out;
}

function progressiveWeight(exoId, targetReps, mod) {
  const prev = findLastExo(exoId);
  if (!prev) return { weight: null, reason: 'Démarre léger — on calibrera dès la prochaine.' };
  // Find the full history record for this set.
  let prevRpe = null, prevCompleted = null;
  for (let i = S.history.length - 1; i >= 0; i--) {
    const h = S.history[i];
    const match = (h.sets || []).filter(s => s.exoId === exoId);
    if (match.length) {
      prevRpe = h.rpe;
      const avgReps = match.reduce((a, s) => a + (s.reps || 0), 0) / match.length;
      prevCompleted = avgReps >= targetReps * 0.95;
      break;
    }
  }
  let bump = mod.loadBumpKg;
  let reason;
  // Pas de step fixe à +2.5kg : on adapte au type de réponse détecté
  // (fast/moderate/slow/regressing). Permet aux progresseurs lents de
  // micro-progresser et aux rapides de garder un rythme soutenu.
  // On n'utilise loadStepForResponder QUE si confidence === 'high' (≥ 8 sem
  // de couverture) — pour ne pas adapter les charges réelles sur une
  // estimation potentiellement bruyante. En low confidence, on retombe
  // sur le step modéré standard (1.25 kg).
  const responder = (typeof window !== 'undefined' && window.Programming
    && S.history && S.history.length >= 4)
    ? window.Programming.classifyResponder(S.history, { halfLifeDays: keyLiftHalfLifeFor() })
    : { type: 'moderate', confidence: 'unknown' };
  const useResponderStep = responder.confidence === 'high';
  const step = (useResponderStep && window.Programming && window.Programming.loadStepForResponder)
    ? window.Programming.loadStepForResponder(responder.type)
    : 1.25;
  if (prevCompleted && prevRpe != null && prevRpe <= 7) {
    bump += step;
    reason = step > 0
      ? `Dernière fois RPE ${prevRpe}, séries bouclées → +${step}kg`
      : `Dernière fois RPE ${prevRpe}, mais en phase de récup → charge maintenue`;
  } else if (prevRpe != null && prevRpe >= 9) {
    bump -= step > 0 ? step : 2.5;
    reason = `Dernière fois RPE ${prevRpe} (dur) → -${step > 0 ? step : 2.5}kg, on consolide`;
  } else if (prevCompleted === false) {
    reason = `Dernière fois reps non bouclées → on garde la charge`;
  } else {
    reason = `Charge identique — on valide la technique`;
  }
  // Bloc Issurin : multiplicateur d'intensité applique sur la charge cible.
  // Réalisation +15% / Deload -30% / etc. Appliqué après le bump pour que
  // l'effet de phase domine quand actif.
  if (S.macrocycle && window.Programming) {
    const block = window.Programming.blockMods(S.macrocycle, S.history);
    if (block.intMod !== 0) {
      const adj = (prev.weight || 0) * block.intMod;
      bump += adj;
      const sign = adj >= 0 ? '+' : '';
      reason += ` · phase ${block.phaseLabel.toLowerCase()} (${sign}${adj.toFixed(1)}kg)`;
    }
  }
  let w = Math.round(((prev.weight || 0) + bump) * 2) / 2; // round to 0.5kg
  w = Math.max(0, w);
  const capped = capWeight(exoId, w);
  if (capped != null && capped < w) {
    reason += ` (plafonné à ${capped}kg selon ton matériel)`;
    w = capped;
  }
  return { weight: w, reason };
}

/* =================== GAMIFICATION ENGINE ===================
 * Deplace dans gamification.js (audit modularite, action 6).
 * computeXP, levelInfo, computeStreak, countPRs, renderMascot...
 * y sont definis et partages via la portee globale. */

/* =================== SWAP MODAL =================== */
let swapCtx = null; // { exoIdx }

// swapRationale: explain *why* a given candidate is a reasonable swap for
// `current`. We check the most useful differentiators in priority order:
//   1) pain relief (this is THE reason most people swap)
//   2) equipment ("no barbell needed")
//   3) compound-vs-isolation shift (simpler technique)
//   4) machine vs free-weight (more stable, beginner-friendly)
//   5) same-zone confirmation (fallback)
// Keeps explanations short (6-8 words) so they fit inside the swap card.
function swapRationale(current, candidate, profile) {
  const curLib = EX_BY_ID[current.id];
  if (!curLib) return '';
  const avoid = new Set((profile && profile.painToday) || []);

  // 1) Pain relief: current exo lists a pain the user has, candidate doesn't.
  const currentBadPain = (curLib.pain || []).filter(p => avoid.has(p));
  const candidateSafe = !(candidate.pain || []).some(p => avoid.has(p));
  if (currentBadPain.length > 0 && candidateSafe) {
    // Name the specific joint if we know it.
    const joint = currentBadPain[0];
    const jointFr = { genou: 'les genoux', dos: 'le dos', epaule: 'les épaules',
                      coude: 'les coudes', poignet: 'les poignets', cheville: 'les chevilles' }[joint] || joint;
    return `Moins de charge sur ${jointFr}`;
  }

  // 2) Equipment relief: candidate uses only gear the current exo didn't require,
  //    OR is bodyweight-only while current needed a barbell.
  const curGear = new Set(curLib.gear);
  const candGear = new Set(candidate.gear);
  if (curGear.has('barre') && !candGear.has('barre') && candGear.has('pdc')) {
    return 'Variante au poids du corps';
  }
  if (curGear.has('barre') && !candGear.has('barre') && candGear.has('halteres')) {
    return 'Avec haltères (setup plus rapide)';
  }
  if (curGear.has('halteres') && !candGear.has('halteres') && candGear.has('pdc')) {
    return 'Sans matériel';
  }
  if (!curGear.has('machine') && candGear.has('machine')) {
    return 'Sur machine (trajectoire guidée)';
  }

  // 3) Compound → isolation: fewer zones = simpler movement.
  const curZones = (curLib.z || []).length;
  const candZones = (candidate.z || []).length;
  if (curZones > 1 && candZones === 1) {
    return `Isolation ${candidate.z[0]} (plus simple)`;
  }
  if (curZones === 1 && candZones > 1) {
    return 'Mouvement polyarticulaire (plus complet)';
  }

  // 4) Timed ↔ rep switch.
  if (!curLib.timed && candidate.timed) return 'Tenue isométrique (gainage)';
  if (curLib.timed && !candidate.timed) return 'Répétitions dynamiques';

  // 5) Same-zone fallback — always true at this point (filter guarantees it).
  const shared = (candidate.z || []).filter(z => (curLib.z || []).includes(z));
  if (shared.length > 0) {
    return `Même zone (${shared.join(', ')})`;
  }
  return '';
}

function openSwapModal(exoIdx) {
  const s = S.currentSession;
  if (!s) return;
  const current = s.exos[exoIdx];
  const lib = EX_BY_ID[current.id];
  if (!lib) return;
  const p = S.profile;
  const avoid = new Set(p.painToday || []);
  // Candidates: same primary zone, at least one shared gear, not painful, not already in session.
  const usedIds = new Set(s.exos.map(x => x.id));
  const candidates = EX.filter(e =>
    e.id !== current.id &&
    !usedIds.has(e.id) &&
    e.z.some(z => lib.z.includes(z)) &&
    e.gear.some(g => p.gear.includes(g)) &&
    (!e.needs || e.needs.every(g => p.gear.includes(g))) &&
    !e.pain.some(pn => avoid.has(pn))
  );
  const sub = document.getElementById('swapModalSub');
  sub.textContent = `Alternatives à « ${current.name} » (${lib.z.join(', ')})`;
  const list = document.getElementById('swapModalList');
  if (candidates.length === 0) {
    list.innerHTML = '<p class="mut">Pas d\'alternative disponible avec ton matériel et tes zones à éviter.</p>';
  } else {
    list.innerHTML = candidates.map(e => {
      const why = swapRationale(current, e, p);
      return `
      <div class="swap-item" data-exo="${escapeHtml(e.id)}">
        <div>
          <div class="swap-item-name">${escapeHtml(e.n)}${e.timed ? ' <span class="pill">tenue</span>' : ''}</div>
          ${why ? `<div class="swap-item-reason">${escapeHtml(why)}</div>` : ''}
          <div class="swap-item-desc">${escapeHtml(e.desc)}</div>
        </div>
        <div style="font-size:22px;color:var(--mut)">→</div>
      </div>`;
    }).join('');
    list.querySelectorAll('.swap-item').forEach(item => {
      item.addEventListener('click', () => doSwap(item.dataset.exo));
    });
  }
  swapCtx = { exoIdx };
  document.getElementById('swapModal').classList.remove('hide');
}

function closeSwapModal() {
  document.getElementById('swapModal').classList.add('hide');
  swapCtx = null;
}

function doSwap(newExoId) {
  if (!swapCtx) return;
  const e = EX_BY_ID[newExoId];
  const s = S.currentSession;
  const old = s.exos[swapCtx.exoIdx];
  const base = baseSetRep(S.profile);
  const mod = modFromForm();
  const isTimed = !!e.timed;
  const sets = old.sets;
  const reps = isTimed
    ? Math.max(20, Math.round((base.reps + mod.repDelta) * 2))
    : Math.max(5, base.reps + mod.repDelta);
  const rest = old.rest;
  let weight = null, reason = null;
  if (!isTimed && supportsWeight(e.id)) {
    const pw = progressiveWeight(e.id, reps, mod);
    weight = pw.weight; reason = pw.reason;
  } else if (isTimed) {
    reason = `Tenue ${reps}s — concentre-toi sur l'alignement`;
  }
  s.exos[swapCtx.exoIdx] = { id: e.id, name: e.n, sets, reps, rest, timed: isTimed, weight, reason };
  queueSave();
  closeSwapModal();
  renderNext();
}

// Wire modal buttons once.
document.getElementById('swapCancel').addEventListener('click', closeSwapModal);
document.getElementById('swapBackdrop').addEventListener('click', (ev) => {
  // Click outside modal box closes it.
  if (ev.target.id === 'swapBackdrop') closeSwapModal();
});

// effectiveTodayGear — resolves S.todayGear (one-shot override) against the
// profile's permanent gear list. Returns a fresh array (no mutation).
//   'default' → use profile.gear as-is
//   'home'    → typical home setup : pdc + halteres + elastiques + traction
//               (intersect with the user's actual gear so on n'invente rien)
//   'travel'  → only 'pdc' (bodyweight) — overrides profile entirely
//   'light'   → profile.gear minus 'barre' (skip the rack today)
// Anything else → treat as default.
function effectiveTodayGear(profile) {
  const base = (profile && profile.gear) || [];
  const mode = S.todayGear || 'default';
  if (mode === 'travel') return ['pdc'];
  if (mode === 'light') return base.filter(g => g !== 'barre');
  if (mode === 'home') {
    // Intersect avec le profil pour ne pas inventer de matériel — si le user
    // n'a pas d'haltères chez lui, on n'en propose pas. Pdc est toujours dispo.
    const homePool = new Set(['pdc', 'halteres', 'elastiques', 'traction', 'kettlebell', 'trx']);
    const intersect = base.filter(g => homePool.has(g));
    return intersect.length > 0 ? intersect : ['pdc'];
  }
  return base.slice();
}

// effectiveDuration — minutes que la séance doit cibler. S.todayDuration
// (number en minutes) override le profil pour une seule séance. 'auto' ou
// null → tombe sur p.duration. Bornes : 5 min minimum (sinon plus rien à
// proposer), 120 min max (au-delà c'est de la session de bodybuilder, pas
// notre cible).
function effectiveDuration(profile) {
  const def = (profile && profile.duration) || 45;
  const v = S.todayDuration;
  if (v === null || v === undefined || v === 'auto') return def;
  const n = +v;
  if (!Number.isFinite(n)) return def;
  return Math.max(5, Math.min(120, n));
}

// effectiveEnergyMod — modificateur de volume/intensité dépendant de l'état
// déclaré du jour ('low'/'mid'/'high'/null). Vient *en plus* de modFromForm()
// qui regarde le formScore. Champs : setDelta, repDelta, restDelta. Pas de
// loadBumpKg ici — on ne joue pas avec les charges sur la base d'un mood
// chip (ce serait risqué), juste le volume.
function effectiveEnergyMod() {
  switch (S.todayEnergy) {
    case 'low':  return { setDelta: -1, repDelta: -2, restDelta:  20, exoCountMod: -1 };
    case 'high': return { setDelta:  1, repDelta:  1, restDelta: -10, exoCountMod:  1 };
    case 'mid':  return { setDelta:  0, repDelta:  0, restDelta:   0, exoCountMod:  0 };
    default:     return { setDelta:  0, repDelta:  0, restDelta:   0, exoCountMod:  0 };
  }
}

// adaptRehabSession transforme une séance rééduc (shape Rehab.js) en shape
// compatible avec renderNext()/viewSession qui attendent {id, name, sets,
// reps, rest, timed, weight, reason}. Le dose textuel est placé dans
// `reason` et les cues techniques restent accessibles via le détail.
function adaptRehabSession(rehabSess) {
  if (!rehabSess) return null;
  const exos = (rehabSess.exos || []).map(ex => {
    const isHold = ex.kind === 'isometrique' || ex.kind === 'etirement' ||
                   /tenue|tiens|tenir|secondes|s\b/i.test(ex.dose || '');
    // Sets/reps sont des valeurs de référence — la véritable dose est dans
    // ex.dose et est affichée comme "raison" sous le nom de l'exo.
    return {
      id: ex.id,
      name: ex.n,
      sets: 3,
      reps: isHold ? 30 : 12,
      rest: 60,
      timed: isHold,
      weight: null,
      reason: ex.dose,
      // Champs étendus pour le détail / le viewer rééduc.
      rehab: {
        zone: ex.zone,
        kind: ex.kind,
        gear: ex.gear,
        how: ex.how,
        cues: ex.cues || [],
        caution: ex.caution || '',
      },
    };
  });
  return {
    id: rehabSess.id || ('rehab-' + Date.now()),
    date: new Date().toISOString(),
    kind: 'rehab',
    title: rehabSess.label || 'Séance rééducation',
    phaseLabel: rehabSess.phaseLabel,
    phaseId: rehabSess.phaseId,
    daysSince: rehabSess.daysSince,
    rehabNotes: rehabSess.notes,
    groups: ['rééduc'],
    rotIdx: 0,
    exos,
    sets: [],
  };
}

function generateSession() {
  // Mode rééduc — court-circuite la génération normale. Le serveur accepte
  // bien rehab dans le payload (whitelist data.go), donc la séance produite
  // se sauvegarde comme n'importe quelle autre.
  if (S.rehab && S.rehab.active && window.Rehab && typeof window.Rehab.generateSession === 'function') {
    if (!Array.isArray(S.rehab.zones) || S.rehab.zones.length === 0) {
      // Active mais aucune zone choisie — placeholder explicite pour que
      // l'utilisateur sache qu'il faut compléter la config (et qu'on ne
      // bascule pas silencieusement sur la séance normale, ce qui serait
      // un piège après une blessure).
      return {
        id: 'rehab-empty-' + Date.now(),
        date: new Date().toISOString(),
        kind: 'rehab',
        title: 'Séance rééduc — configuration incomplète',
        groups: ['rééduc'],
        rotIdx: 0,
        exos: [],
        sets: [],
        rehabPlaceholder: true,
      };
    }
    return adaptRehabSession(window.Rehab.generateSession(S.rehab));
  }
  const p = S.profile;
  if (!p) return null;
  const { groups, rotIdx } = pickGroups();
  const avoid = new Set(p.painToday || []);
  // Durée effective du jour. S.todayDuration override le profil en
  // one-shot — utile pour gérer une vie professionnelle imprévisible
  // sans toucher à la config permanente.
  const dur = effectiveDuration(p);
  // L'énergie modifie le compte d'exos sélectionnés (en plus du volume
  // par exo géré plus bas via setDelta/repDelta).
  const energy = effectiveEnergyMod();
  // Échelle d'exos basée sur la durée effective :
  //   ≥75 → 7, ≥60 → 6, ≥45 → 5, ≥30 → 4, ≥20 → 3, ≥10 → 2, sinon 1.
  // Plus exoCountMod (énergie) avec un floor à 1 et un ceiling à 8.
  let targetCount;
  if (dur >= 75) targetCount = 7;
  else if (dur >= 60) targetCount = 6;
  else if (dur >= 45) targetCount = 5;
  else if (dur >= 30) targetCount = 4;
  else if (dur >= 20) targetCount = 3;
  else if (dur >= 10) targetCount = 2;
  else targetCount = 1;
  targetCount = Math.max(1, Math.min(8, targetCount + energy.exoCountMod));
  // Périodisation par blocs (Issurin) : si actif, on applique exoCountMod
  // de la phase courante (réalisation = -2 exos, etc.) et on garde les
  // mods de volume/intensité pour plus bas (sets/reps/charge).
  const block = (S.macrocycle && window.Programming)
    ? window.Programming.blockMods(S.macrocycle, S.history)
    : { volMod: 0, intMod: 0, restMod: 0, exoCountMod: 0 };
  targetCount = Math.max(1, Math.min(8, targetCount + block.exoCountMod));
  // todayGear: a one-shot override of the user's profile.gear. Useful when
  // travelling ("only bodyweight") or when the gym's busy and we want to
  // skip the squat rack. Unset → fall back to the profile default.
  const effectiveGear = effectiveTodayGear(p);
  let pool = EX.filter(e =>
    e.z.some(z => groups.includes(z)) &&
    e.gear.some(g => effectiveGear.includes(g)) &&
    (!e.needs || e.needs.every(g => effectiveGear.includes(g))) &&
    !e.pain.some(pn => avoid.has(pn))
  );
  const seed = new Date().toDateString();
  pool = pool.map((e,i) => ({e, k: hash(seed + e.id + i)}))
    .sort((a,b) => a.k - b.k).map(x => x.e);

  const chosen = [], seenZ = new Set();
  for (const e of pool) {
    if (chosen.length >= targetCount) break;
    const key = e.z.find(z => groups.includes(z));
    if (chosen.length < groups.length && seenZ.has(key)) continue;
    chosen.push(e); seenZ.add(key);
  }
  while (chosen.length < targetCount && pool.length > chosen.length) {
    for (const e of pool) { if (!chosen.includes(e)) { chosen.push(e); break; } }
  }

  const base = baseSetRep(p);
  const mod = modFromForm();
  // Compose les modificateurs : forme (modFromForm) + énergie déclarée
  // (energy) + bloc Issurin (block). Le bloc applique des mods en
  // pourcentage sur le volume (sets) et l'intensité (charge), distinct
  // des deltas absolus de forme/énergie qui jouent sur reps/repos.
  const setDelta  = mod.setDelta  + energy.setDelta;
  const repDelta  = mod.repDelta  + energy.repDelta;
  const restDelta = mod.restDelta + energy.restDelta + block.restMod;
  // blockSetMult : multiplicateur final sur le nombre de sets de chaque
  // exo. volMod=+0.20 → 1.20× ; volMod=-0.50 → 0.50×.
  const blockSetMult = 1 + block.volMod;
  const blockIntMult = 1 + block.intMod;
  // Si la durée totale est très courte (<20 min), on raccourcit aussi le
  // repos pour qu'il y ait moyen de finir. Un mini-circuit de 10 min
  // tolère un rest de 30s, pas 90s.
  const restCap = dur <= 15 ? 45 : (dur <= 30 ? 60 : 999);
  const exos = chosen.map(e => {
    const isTimed = !!e.timed;
    // Sets : addition du delta forme/énergie puis multiplication par le
    // mod du bloc. Ordre choisi pour que -1 set en énergie low + -50% deload
    // ne donne pas un nombre négatif via l'arrondi.
    const setsRaw = (base.sets + setDelta) * blockSetMult;
    const sets = Math.max(1, Math.round(setsRaw));
    const reps = isTimed
      ? Math.max(15, Math.round((base.reps + repDelta) * 2))
      : Math.max(5, base.reps + repDelta);
    let rest = Math.max(20, base.rest + restDelta);
    if (rest > restCap) rest = restCap;
    let weight = null, reason = null;
    if (!isTimed && supportsWeight(e.id)) {
      const pw = progressiveWeight(e.id, reps, mod);
      weight = pw.weight;
      reason = pw.reason;
    } else if (isTimed) {
      reason = `Tenue ${reps}s — concentre-toi sur l'alignement`;
    }
    return { id: e.id, name: e.n, sets, reps, rest, timed: isTimed, weight, reason };
  });

  return {
    id: Date.now(),
    date: new Date().toISOString(),
    groups, rotIdx,
    title: `Séance ${['A','B','C','D','E'][rotIdx]} · ${groups.join(' + ')}`,
    exos,
    sets: [],
  };
}

/* =================== HOME =================== */
// paintHomeSkeleton — pose des placeholders animés dans le hero ring, les
// qstats et la card "prochaine séance" pendant qu'on attend /api/data.
// openHome() écrase tout ça sans flash car les éléments cibles sont les
// mêmes id que ceux remplis par openHome().
function paintHomeSkeleton() {
  // Hero ring : on cache temporairement le SVG et on fait pulser le centre.
  const heroLevel = document.getElementById('heroLevel');
  const heroLevelName = document.getElementById('heroLevelName');
  const heroXpText = document.getElementById('heroXpText');
  const heroNextText = document.getElementById('heroNextText');
  if (heroLevel)     heroLevel.innerHTML     = '<span class="skel" style="display:inline-block;width:48px;height:42px"></span>';
  if (heroLevelName) heroLevelName.innerHTML = '<span class="skel" style="display:inline-block;width:90px;height:12px"></span>';
  if (heroXpText)    heroXpText.innerHTML    = '<span class="skel" style="display:inline-block;width:80px;height:10px"></span>';
  if (heroNextText)  heroNextText.innerHTML  = '<span class="skel" style="display:inline-block;width:60px;height:10px"></span>';

  // Quick stats : 4 placeholders pulsants à la place des chiffres.
  ['qPace','qSessions','qForme','qPRs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="skel" style="display:inline-block;width:32px;height:20px"></span>';
  });

  // Badges row + adjustments — placeholders simples.
  const badges = document.getElementById('badgesRow');
  if (badges) badges.innerHTML = `
    <div class="skel" style="width:90px;height:62px;border-radius:12px"></div>
    <div class="skel" style="width:90px;height:62px;border-radius:12px"></div>
    <div class="skel" style="width:90px;height:62px;border-radius:12px"></div>`;
}

/* Refonte mobile — l'accueil ne rend plus que ce qui répond à « qu'est-ce
 * que je fais maintenant ? ». La gamification (hero XP, qstats, badges) et
 * les cartes d'analyse vivent dans Tendances (openTrends), les ajustements
 * dans Coach (openCoach). */

// renderGreeting — date du jour + salut + mini-anneau readiness.
function renderGreeting() {
  const dateEl = document.getElementById('greetDate');
  const nameEl = document.getElementById('greetName');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('fr-FR',
      { weekday: 'long', day: 'numeric', month: 'long' });
  }
  if (nameEl) {
    // Prénom approximé depuis l'email (avant @, avant . ou chiffre) — on n'a
    // volontairement pas de champ "nom" (minimisation des données, RGPD).
    let who = '';
    if (currentUserEmail) {
      const local = currentUserEmail.split('@')[0].split(/[._\d]/)[0];
      if (local) who = ' ' + local.charAt(0).toUpperCase() + local.slice(1);
    }
    nameEl.textContent = 'Salut' + who + ' 👋';
  }
  // Mini-anneau readiness (Banister composite). Circumference r=24 → 150.8.
  const bar = document.getElementById('readyRingBar');
  const val = document.getElementById('readyRingVal');
  if (bar && val && window.Banister) {
    ensureBodyState();
    const r = window.Banister.readiness(S.history, S.body.physio, S.formScore);
    const score = Math.round(r.score);
    val.textContent = score;
    const C = 150.8;
    bar.setAttribute('stroke-dashoffset', (C * (1 - score / 100)).toFixed(1));
    bar.setAttribute('stroke', score >= 65 ? 'var(--success)'
                            : score >= 40 ? 'var(--warn)'
                            : 'var(--danger)');
    // a11y (4.1.2) : le nom accessible du bouton porte le SCORE, pas juste
    // une description générique — un lecteur d'écran annonce la valeur.
    const ring = document.getElementById('readyRing');
    if (ring) ring.setAttribute('aria-label',
      `Readiness du jour : ${score} sur 100. Toucher pour le détail.`);
  }
}

// renderGamification — hero ring XP + quick stats + badges (onglet Tendances).
function renderGamification() {
  const xp = computeXP(S.history);
  const info = levelInfo(xp);
  const mascot = document.getElementById('mascotBox');
  if (mascot) mascot.innerHTML = renderMascot(info.level);
  const lv = document.getElementById('heroLevel');
  if (lv) lv.textContent = info.level;
  const ln = document.getElementById('heroLevelName');
  if (ln) ln.textContent = levelName(info.level);
  const xt = document.getElementById('heroXpText');
  if (xt) xt.textContent = `${info.into} / ${info.span} XP`;
  const nt = document.getElementById('heroNextText');
  if (nt) nt.textContent = `→ Niv. ${info.level + 1}`;
  const ring = document.getElementById('heroRingProgress');
  if (ring) {
    const circumference = 2 * Math.PI * 86; // ≈ 540.35
    const pct = Math.max(0.5, Math.min(100, info.pct));
    const offset = circumference * (1 - pct / 100);
    ring.setAttribute('stroke-dashoffset', offset.toFixed(2));
  }
  const cfg = rollingWindowConfig(S.profile);
  const pace = computeRollingTarget(S.history, cfg.targetCount, cfg.windowDays);
  const paceEl = document.getElementById('qPace');
  const paceIcon = document.getElementById('qPaceIcon');
  const paceTile = document.getElementById('qPaceTile');
  if (paceEl)   paceEl.textContent = pace.completed + '/' + pace.target;
  if (paceIcon) paceIcon.textContent = pace.status === 'ahead' ? '✅'
                                     : pace.status === 'on-track' ? '🎯' : '⏳';
  if (paceTile) {
    paceTile.style.color = pace.status === 'behind' ? 'var(--warn,var(--accent))' : '';
    paceTile.title = `${pace.completed} séance${pace.completed > 1 ? 's' : ''} sur ${pace.target}` +
      ` ciblée${pace.target > 1 ? 's' : ''} sur ${pace.windowDays} jours glissants` +
      (pace.status === 'ahead' ? ' — objectif atteint, bravo !'
       : pace.status === 'behind' ? ' — un peu en retard, mais une seule séance peut tout changer.'
       : ' — pile dans le rythme.');
  }
  const qs = document.getElementById('qSessions');
  if (qs) qs.textContent = S.history.length;
  const qf = document.getElementById('qForme');
  if (qf) qf.textContent = Math.round(S.formScore);
  const qp = document.getElementById('qPRs');
  if (qp) qp.textContent = countPRs(S.history);
  renderBadges();
}

// openTrends — onglet analyse : Charge / Force / Activité.
function openTrends() {
  if (!S.profile) { openOnboarding(); return; }
  show('viewTrends');
  renderGamification();
  renderWeeklyVolume();
  renderCalendarHeatmap();
  renderBanisterCard();
  renderProgrammingCard();
  renderMiniCharts();
}

// openCoach — onglet conseils : ajustements générés + guide.
function openCoach() {
  if (!S.profile) { openOnboarding(); return; }
  show('viewCoach');
  renderAdjustments();
}

function openHome() {
  if (!S.profile) { openOnboarding(); return; }
  show('viewHome');
  // Reset du "Afficher quand même" pour que la bannière de séance
  // d'aujourd'hui faite revienne à chaque retour sur la home.
  const _nsc = document.getElementById('nextSessionCard');
  if (_nsc) delete _nsc.dataset.showNextAnyway;

  // 1) Greeting + mini-anneau readiness.
  renderGreeting();

  // 2) Science card (Hooper / lifestyle / HRV / asymétries) — repliée par
  // défaut, dépliée via le head ou le mini-anneau readiness.
  try { renderScienceCard(); } catch (e) { console.warn('renderScienceCard:', e); }

  // 4) Next session (with swap buttons).
  // Defensive re-validation: if the stored session contains any exo the user
  // no longer has the gear for (library was updated, onboarding was redone,
  // `needs` filter was tightened), drop it so we regenerate with fresh rules.
  // Skip validation for rehab sessions — their exos are in window.Rehab,
  // not EX_BY_ID, and gear isn't a hard constraint (most are bodyweight or
  // elastic).
  if (S.currentSession && Array.isArray(S.currentSession.exos) && S.currentSession.kind !== 'rehab') {
    const userGear = new Set((S.profile && S.profile.gear) || []);
    const invalid = S.currentSession.exos.some(ex => {
      const lib = EX_BY_ID[ex.id];
      if (!lib) return true;
      if (lib.needs && !lib.needs.every(g => userGear.has(g))) return true;
      if (!lib.gear.some(g => userGear.has(g))) return true;
      return false;
    });
    if (invalid) {
      S.currentSession = null;
    }
  }
  // Si le mode rééduc vient d'être activé/désactivé, la séance courante
  // peut être de l'ancien type — on l'invalide pour forcer une régénération
  // dans le bon mode.
  if (S.currentSession) {
    const sessionIsRehab = S.currentSession.kind === 'rehab';
    const modeIsRehab = !!(S.rehab && S.rehab.active);
    if (sessionIsRehab !== modeIsRehab) {
      S.currentSession = null;
    }
  }
  // Bannière persistante en haut de la home quand le mode rééduc est actif.
  // Insérée dynamiquement (pas en HTML statique) parce qu'on veut afficher
  // la phase courante calculée à l'instant T.
  renderRehabBanner();
  if (!S.currentSession) { S.currentSession = generateSession(); queueSave(); }
  applyModeToggle();
  renderNext();

  // 4b) Soreness check — auto-shown if last session was 0-2 days ago and we
  //     haven't already collected feedback for today.
  renderSorenessCheck();

  // 5) Alertes contextuelles (deload / plateau / séance en pause) — elles
  // s'ancrent sur #nextSessionBox, donc elles restent sur l'accueil. Les
  // cartes d'analyse (volume, heatmap, Banister, programmation, mini charts,
  // ajustements) sont rendues par openTrends() / openCoach().
  renderDeloadHint();
  renderPlateauHint();
  renderPausedSessionHint();
}

// shouldDeload — flags overreach when the trailing form trend has dropped
// for two consecutive weeks. We compare avg formScore-equivalent (combination
// of RPE and "doneness") in week N-2..N-1 vs N-1..N and N..now. If both
// deltas are negative AND the latest avg is < 60, recommend a deload.
//
// Pure function — takes history + (optional) "now" so tests can pin time.
// Returns { deload: boolean, reason: string }.
function shouldDeload(history, nowMs) {
  if (!Array.isArray(history) || history.length < 6) {
    return { deload: false, reason: '' };
  }
  const now = nowMs || Date.now();
  const W = 7 * 86400000;
  const buckets = [[], [], []]; // 0: now-W..now, 1: now-2W..now-W, 2: now-3W..now-2W
  for (const h of history) {
    const ts = new Date(h.date).getTime();
    if (isNaN(ts)) continue;
    const ageW = (now - ts) / W;
    if (ageW < 0) continue;
    if (ageW < 1) buckets[0].push(h);
    else if (ageW < 2) buckets[1].push(h);
    else if (ageW < 3) buckets[2].push(h);
  }
  if (buckets.some(b => b.length === 0)) return { deload: false, reason: '' };
  const avgRpe = (b) => {
    const xs = b.map(h => +h.rpe).filter(x => isFinite(x));
    if (xs.length === 0) return null;
    return xs.reduce((a, x) => a + x, 0) / xs.length;
  };
  const r0 = avgRpe(buckets[0]);
  const r1 = avgRpe(buckets[1]);
  const r2 = avgRpe(buckets[2]);
  if (r0 == null || r1 == null || r2 == null) return { deload: false, reason: '' };
  // RPE rising over 3 weeks (workouts feel harder at same/lower load) → deload.
  if (r0 > r1 && r1 > r2 && r0 >= 8) {
    return {
      deload: true,
      reason: `RPE moyen monte 3 semaines de suite (${r2.toFixed(1)} → ${r1.toFixed(1)} → ${r0.toFixed(1)}). Deload conseillé : -20% de volume cette semaine.`,
    };
  }
  // Filet de sécurité : si l'utilisateur enchaîne 5+ semaines pleines (≥3 séances
  // par semaine en moyenne) sans deload explicite ET que la formScore reste
  // sous 65, on suggère une semaine plus light. Évite l'overtraining silencieux
  // de ceux qui ne montent jamais en RPE 9 mais s'épuisent à 7.5 chronique.
  const fiveWeeks = 5 * W;
  const recent = history.filter(h => {
    const ts = new Date(h.date).getTime();
    return isFinite(ts) && (now - ts) <= fiveWeeks;
  });
  if (recent.length >= 15) {  // ~3 séances/sem × 5 semaines
    const formNow = (typeof S !== 'undefined' && S && S.formScore) || 70;
    const allRpe = recent.map(h => +h.rpe).filter(x => isFinite(x));
    const avgAll = allRpe.length > 0 ? allRpe.reduce((a, x) => a + x, 0) / allRpe.length : 0;
    if (formNow < 65 && avgAll >= 7) {
      return {
        deload: true,
        reason: `5 semaines pleines sans deload (${recent.length} séances) et forme sous 65. Une semaine -30% volume / -10% charge serait bénéfique.`,
      };
    }
  }
  return { deload: false, reason: '' };
}

// computeHeatmap — build a {ISO date → intensity 0..4} map from history.
// Intensity = quartile of total set count for that day (4 = top quartile).
// Pure function so we can test it without the DOM.
function computeHeatmap(history, weeksBack = 16) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endMs = today.getTime() + 86400000;
  const startMs = endMs - weeksBack * 7 * 86400000;
  const counts = {};
  for (const h of (history || [])) {
    if (!h.date) continue;
    const ts = new Date(h.date).getTime();
    if (isNaN(ts) || ts < startMs || ts >= endMs) continue;
    const iso = new Date(ts).toISOString().slice(0, 10);
    counts[iso] = (counts[iso] || 0) + ((h.sets || []).length || 1);
  }
  // Quartile thresholds from the non-zero counts seen.
  const vals = Object.values(counts).filter(v => v > 0).sort((a, b) => a - b);
  const q = (frac) => vals.length === 0 ? 0 : vals[Math.min(vals.length - 1, Math.floor(vals.length * frac))];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const out = {};
  for (const [iso, n] of Object.entries(counts)) {
    let level = 1;
    if (n >= t3 && t3 > 0) level = 4;
    else if (n >= t2 && t2 > 0) level = 3;
    else if (n >= t1 && t1 > 0) level = 2;
    out[iso] = level;
  }
  return { levels: out, weeksBack };
}

function renderDeloadHint() {
  const box = document.getElementById('nextSessionBox');
  if (!box) return;
  // Remove any prior hint so we don't stack them on regen.
  const prior = document.getElementById('deloadHint');
  if (prior) prior.remove();
  const verdict = shouldDeload(S.history);
  if (!verdict.deload) return;
  const hint = document.createElement('div');
  hint.id = 'deloadHint';
  hint.className = 'deload-hint';
  hint.innerHTML = `🛑 <strong>Deload conseillé</strong><br>${escapeHtml(verdict.reason)}`;
  box.parentNode.insertBefore(hint, box);
}

/* =================== CARTE BANISTER (niveau 4) ===================
 * Affiche fitness (CTL), fatigue (ATL) et TSB courants, plus un mini-graph
 * de la trajectoire des 6 dernières semaines. Si l'utilisateur a fourni
 * des données physio (HRV/sommeil/FC repos) récentes, ajoute le composite
 * readiness 0-100 avec breakdown des contributions.
 *
 * La card ne s'affiche que si l'utilisateur a au moins 2 semaines
 * d'historique — sinon les calculs Banister n'ont pas de sens.
 */
function renderBanisterCard() {
  const card = document.getElementById('banisterCard');
  const body = document.getElementById('banisterBody');
  if (!card || !body || !window.Banister) return;
  const histLen = (S.history || []).length;
  if (histLen < 5) {
    card.classList.add('hide');
    return;
  }
  card.classList.remove('hide');

  const B = window.Banister;
  ensureBodyState();
  const now = B.computeAll(S.history);
  const reco = B.recommendation(now.tsb);
  const readiness = B.readiness(S.history, S.body.physio, S.formScore);

  // Trajectoire 42 jours, pas de 1 jour pour avoir un graph fluide.
  const traj = B.trajectory(S.history, 42, 1);

  // ---- Mini-graph SVG : CTL en accent, ATL en gris, TSB en accent translucide ----
  const W = 320, H = 90, PAD = 8;
  const allVals = traj.flatMap(p => [p.ctl, p.atl, p.tsb]);
  const minY = Math.min.apply(null, allVals);
  const maxY = Math.max.apply(null, allVals);
  const range = Math.max(1, maxY - minY);
  function px(p, key) {
    const x = PAD + (W - 2 * PAD) * (1 - p.daysAgo / 42);
    const y = PAD + (H - 2 * PAD) * (1 - (p[key] - minY) / range);
    return [x, y];
  }
  const path = (key) => traj.map((p, i) => {
    const [x, y] = px(p, key);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  // Ligne zéro pour le TSB.
  const zeroY = PAD + (H - 2 * PAD) * (1 - (0 - minY) / range);

  // ---- Top numbers ----
  const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(1);
  const tsbColor = reco.level === 'overload' ? 'var(--danger,#FF6B6B)'
                 : reco.level === 'fatigued' ? 'var(--warn,#F2C457)'
                 : reco.level === 'peak' ? 'var(--accent)'
                 : reco.level === 'fresh' ? 'var(--success,#5DD4A4)'
                 : 'var(--fg)';

  const readinessHtml = readiness.hasPhysio
    ? `<div style="margin:10px 0;padding:8px 10px;background:var(--bg2);border-radius:6px;font-size:13px">
         <div style="display:flex;justify-content:space-between;align-items:center">
           <strong>💗 Readiness composite : <span style="font-size:18px;color:${
             readiness.score >= 65 ? 'var(--success,#5DD4A4)' :
             readiness.score >= 40 ? 'var(--fg)' :
             'var(--danger,#FF6B6B)'}">${readiness.score}/100</span></strong>
           <span class="mut" style="font-size:11px">${escapeHtml(readiness.source)}</span>
         </div>
         <div style="font-size:11px;margin-top:4px;line-height:1.5">
           HRV ${fmt(readiness.breakdown.hrv)} · Sommeil ${fmt(readiness.breakdown.sleep)}
           · FC repos ${fmt(readiness.breakdown.rhr)} · TSB ${fmt(readiness.breakdown.tsb)}
           · Forme ${fmt(readiness.breakdown.declarative)}
         </div>
       </div>`
    : `<div style="margin:10px 0;padding:8px 10px;background:var(--bg2);border-radius:6px;font-size:12px;line-height:1.5">
         <strong>Readiness ${readiness.score.toFixed(0)}/100</strong>
         <span class="mut">— basé sur TSB et formScore déclaratif uniquement.</span><br>
         <span class="mut">Logger HRV / sommeil / FC repos pour un score objectif.</span>
       </div>`;

  body.innerHTML = `
    <div style="display:flex;justify-content:space-around;text-align:center;margin-bottom:8px">
      <div>
        <div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px">Fitness</div>
        <div style="font-size:20px;font-weight:600">${now.ctl.toFixed(1)}</div>
      </div>
      <div>
        <div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px">Fatigue</div>
        <div style="font-size:20px;font-weight:600">${now.atl.toFixed(1)}</div>
      </div>
      <div>
        <div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px">TSB</div>
        <div style="font-size:20px;font-weight:600;color:${tsbColor}">${fmt(now.tsb)}</div>
      </div>
    </div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
      <line x1="${PAD}" y1="${zeroY.toFixed(1)}" x2="${W - PAD}" y2="${zeroY.toFixed(1)}"
            stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,3"/>
      <path d="${path('ctl')}" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
      <path d="${path('atl')}" stroke="var(--mut)" stroke-width="1.2" fill="none" opacity="0.7"/>
      <path d="${path('tsb')}" stroke="var(--blue,#7BA1FF)" stroke-width="1.2" fill="none" stroke-dasharray="3,2"/>
      <text x="${PAD}" y="${H - 1}" font-size="9" fill="var(--mut)">42j</text>
      <text x="${W - PAD}" y="${H - 1}" font-size="9" fill="var(--mut)" text-anchor="end">aujourd'hui</text>
    </svg>
    <p class="mut" style="font-size:11px;margin:2px 0 0;line-height:1.4">
      Accent = fitness (CTL) · gris = fatigue (ATL) · pointillé bleu = TSB.
    </p>
    <div style="margin-top:10px;padding:8px 10px;border-left:3px solid ${tsbColor};
                background:var(--bg2);border-radius:4px;font-size:13px;line-height:1.5">
      <strong>${escapeHtml(reco.label)}.</strong>
      ${escapeHtml(reco.advice)}
    </div>
    ${readinessHtml}
    ${renderLoadRiskBlock(reco)}`;
}

/* =================== MODEL CACHE (audit modularité, action 2) ===================
 * Les états Kalman des key lifts étaient recalculés par CHAQUE renderer
 * (deload advisor, forecasts, mini-stats) à CHAQUE rendu — O(obs × histoire)
 * par exo, fois 6 exos, fois 2-3 renderers. Sur mobile avec 2-3 ans
 * d'historique, on frôlait la frame perceptible en travaillant en double.
 *
 * Même recette que Banister.getCalibration : mémoïsation sur la clé
 * (longueur de l'historique, date du dernier item) — un historique
 * append-only change l'une des deux à chaque séance, donc l'invalidation
 * est exacte et gratuite. */
const ModelCache = (() => {
  let key = null;
  let states = {};
  function histKey() {
    const h = S.history || [];
    return h.length + '|' + (h.length ? (h[h.length - 1].date || '') : '');
  }
  // kalmanState — wrapper mémoïsé de Bayesian.computeState(S.history, …).
  function kalmanState(exoId, opts) {
    if (!window.Bayesian) return null;
    const k = histKey();
    if (key !== k) { key = k; states = {}; }
    const ck = exoId + '|' + ((opts && opts.halfLifeDays) || '');
    if (!(ck in states)) {
      states[ck] = window.Bayesian.computeState(S.history, exoId, opts || {});
    }
    return states[ck];
  }
  return { kalmanState };
})();

/* =================== CHARGE & RISQUE (Foster / Gabbett / tapering) ===================
 * Bloc complémentaire de la carte Banister :
 *   - monotonie & strain (Foster 1998 — même papier que le session-RPE)
 *   - ACWR (Gabbett 2016, présenté avec son caveat — Impellizzeri 2020)
 *   - fenêtre de test 1RM projetée (tapering Banister)
 *   - verdict deload fusionné (Science.deloadAdvisor) qui croise TSB,
 *     dérive Kalman, Hooper, monotonie et ACWR
 *   - mention de la calibration τ personnalisée quand elle est active
 * Respecte l'opt-out art. 22 : les RECOMMANDATIONS (deload, fenêtre de
 * test) sont masquées si l'utilisateur a refusé les décisions
 * algorithmiques ; les métriques descriptives restent affichées.
 */
function renderLoadRiskBlock(reco) {
  const B = window.Banister;
  if (!B || typeof B.monotony !== 'function') return '';
  const mono = B.monotony(S.history);
  const ac = typeof B.acwr === 'function' ? B.acwr(S.history) : null;
  if (!mono && !ac) return '';

  const rows = [];
  if (mono) {
    const mColor = mono.level === 'high' ? 'var(--danger,#FF6B6B)'
                 : mono.level === 'moderate' ? 'var(--warn,#F2C457)'
                 : 'var(--success,#5DD4A4)';
    rows.push(`<div style="display:flex;justify-content:space-between;gap:8px">
      <span>Monotonie <span class="mut" style="font-size:10px">(Foster 1998)</span></span>
      <strong style="color:${mColor}">${mono.monotony}</strong>
    </div>
    <div style="display:flex;justify-content:space-between;gap:8px">
      <span>Strain hebdo</span><strong>${mono.strain}</strong>
    </div>`);
    if (mono.level !== 'ok') {
      rows.push(`<div class="mut" style="font-size:11px;line-height:1.4">${escapeHtml(mono.advice)}</div>`);
    }
  }
  if (ac) {
    const aColor = ac.zone === 'danger' ? 'var(--danger,#FF6B6B)'
                 : ac.zone === 'caution' ? 'var(--warn,#F2C457)'
                 : ac.zone === 'optimal' ? 'var(--success,#5DD4A4)'
                 : 'var(--mut)';
    rows.push(`<div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px">
      <span>ACWR <span class="mut" style="font-size:10px">(Gabbett 2016)</span></span>
      <strong style="color:${aColor}">${ac.ratio}</strong>
    </div>`);
    if (ac.zone !== 'optimal') {
      rows.push(`<div class="mut" style="font-size:11px;line-height:1.4">${escapeHtml(ac.advice)}</div>`);
    }
    rows.push(`<div class="mut" style="font-size:10px;line-height:1.3;opacity:.8">${escapeHtml(ac.caveat)}</div>`);
  }

  // Calibration τ personnalisée — transparence sur la science qui tourne.
  const calib = typeof B.getCalibration === 'function' ? B.getCalibration(S.history) : null;
  const calibHtml = (calib && calib.calibrated)
    ? `<div class="mut" style="font-size:10px;margin-top:4px">
         Constantes Banister calibrées sur TES données : τ ${calib.tauFitness}/${calib.tauFatigue}j
         (corrélation ${calib.r} vs ${calib.rDefault} en standard, n=${calib.n}).
       </div>`
    : '';

  // Recommandations algorithmiques — masquées si opt-out art. 22.
  let advisorHtml = '';
  let windowHtml = '';
  if (!currentUserAlgoOptOut) {
    // Verdict deload fusionné : croise les signaux déjà calculés.
    if (window.Science && typeof window.Science.deloadAdvisor === 'function' && window.Bayesian) {
      const drifts = [];
      try {
        const keyLifts = window.Programming && typeof window.Programming.pickKeyLifts === 'function'
          ? window.Programming.pickKeyLifts(S.history, 6, {})
          : [];
        for (const exoId of keyLifts) {
          const st = ModelCache.kalmanState(exoId, {});
          if (!st) continue;
          const d = window.Bayesian.detectDrift(st);
          if (d.drifting) {
            const lib = (window.EX_BY_ID || {})[exoId];
            drifts.push({ name: (lib && lib.n) || exoId, severity: d.severity });
          }
        }
      } catch (_) { /* best-effort */ }
      let hooperLevel = null;
      try {
        const hs = (S.body && Array.isArray(S.body.hooper)) ? S.body.hooper : [];
        const last = hs.length ? hs[hs.length - 1] : null;
        if (last && window.Science.hooperReadiness) {
          const hr = window.Science.hooperReadiness(last);
          hooperLevel = hr && hr.level;
        }
      } catch (_) {}
      let autonomicLevel = null;
      try {
        if (window.Science.autonomicOverreaching && S.body && Array.isArray(S.body.physio)) {
          autonomicLevel = (window.Science.autonomicOverreaching(S.body.physio) || {}).level;
        }
      } catch (_) {}
      const verdict = window.Science.deloadAdvisor({
        tsbLevel: reco.level,
        drifts,
        hooperLevel,
        monotonyLevel: mono && mono.level,
        acwrZone: ac && ac.zone,
        autonomicLevel,
      });
      if (verdict.level !== 'none') {
        const vColor = verdict.recommend ? 'var(--danger,#FF6B6B)' : 'var(--warn,#F2C457)';
        advisorHtml = `<div style="margin-top:8px;padding:8px 10px;border-left:3px solid ${vColor};
                          background:var(--bg2);border-radius:4px;font-size:12px;line-height:1.5">
          <strong>${verdict.recommend ? '🛑 Deload recommandé' : '⚠️ Deload à considérer'}</strong>
          — ${escapeHtml(verdict.advice)}
          <ul style="margin:6px 0 0;padding-left:16px">
            ${verdict.reasons.map(r =>
              `<li><strong>${escapeHtml(r.source)}</strong> : ${escapeHtml(r.detail)}</li>`).join('')}
          </ul>
        </div>`;
      }
    }
    // Fenêtre de test 1RM — pertinente seulement quand on n'est pas déjà frais.
    if (typeof B.bestTestWindow === 'function' && reco.level !== 'peak' && reco.level !== 'fresh') {
      const win = B.bestTestWindow(S.history, 14);
      if (win && win.advice) {
        windowHtml = `<div class="mut" style="font-size:11px;margin-top:6px;line-height:1.4">
          🎯 ${escapeHtml(win.advice)}
        </div>`;
      }
    }
  }

  return `<div style="margin:10px 0 0;padding:8px 10px;background:var(--bg2);border-radius:6px;font-size:12px">
    <div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
      Charge & risque
    </div>
    ${rows.join('')}
    ${calibHtml}
    ${windowHtml}
  </div>${advisorHtml}`;
}

/* =================== CARTE PROGRAMMATION (niveau 2) ===================
 * Pilote l'affichage du widget #programmingCard sur la home. Lit
 * window.Programming (chargé via /static/programming.js) et compose un
 * tableau lisible : volume hebdo par groupe musculaire vs MEV/MAV/MRV,
 * équilibre push/pull/squat/hinge, type de réponse, et bloc Issurin
 * en cours si activé.
 *
 * La carte ne s'affiche que si l'utilisateur a au moins 5 séances
 * loggées — sinon les calculs n'ont pas de sens (trop peu de données).
 */
function renderProgrammingCard() {
  const card = document.getElementById('programmingCard');
  const body = document.getElementById('programmingBody');
  if (!card || !body || !window.Programming) return;

  const histLen = (S.history || []).filter(h => !h.kind || h.kind === undefined ||
    (h.kind !== 'snack' && h.kind !== 'external')).length;
  if (histLen < 5) {
    card.classList.add('hide');
    return;
  }
  card.classList.remove('hide');

  const P = window.Programming;
  const vol = P.weeklyVolumeByZone(S.history, 1);
  const imb = P.imbalanceReport(S.history, S.profile);
  const responder = P.classifyResponder(S.history, { halfLifeDays: keyLiftHalfLifeFor() });
  const block = currentMacrocycleState();

  // ---- Volume bars ----
  // landmarksFor lit S.history et applique le multiplicateur personnalisé
  // (±15%) selon la relation volume/RPE observée. landmarkStatus reçoit
  // history pour utiliser les mêmes seuils personnalisés.
  const volBars = Object.keys(P.VOLUME_LANDMARKS).map(zoneId => {
    const L = P.landmarksFor(zoneId, S.history);
    const v = vol[zoneId] || 0;
    const status = P.landmarkStatus(zoneId, v, S.history);
    // Largeur de la barre : 0..MRV+5 pour avoir un visuel cohérent.
    const maxScale = L.mrv + 5;
    const pct = Math.min(100, (v / maxScale) * 100);
    // Marqueurs MEV / MAV / MRV positionnés en %.
    const mevPct = (L.mev / maxScale) * 100;
    const mavLoPct = (L.mav[0] / maxScale) * 100;
    const mavHiPct = (L.mav[1] / maxScale) * 100;
    const mrvPct = (L.mrv / maxScale) * 100;
    const personalizedTag = L.personalized
      ? `<span class="mut" style="font-size:10px;margin-left:4px;
              background:var(--bg);padding:1px 5px;border-radius:8px"
              title="Seuils personnalisés à partir de ton historique RPE/volume (×${L.multiplier.toFixed(2)})">
              perso ×${L.multiplier.toFixed(2)}</span>` : '';
    return `
      <div style="margin:8px 0;font-size:13px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span><strong>${escapeHtml(L.label)}</strong>
            <span class="mut" style="font-size:11px">· ${v} sets/sem</span>${personalizedTag}</span>
          <span style="color:${status.color};font-size:11px">${escapeHtml(status.label)}</span>
        </div>
        <div style="position:relative;height:8px;background:var(--bg);border-radius:4px;
                    margin-top:3px;overflow:hidden">
          <div style="position:absolute;top:0;left:${mavLoPct}%;width:${mavHiPct - mavLoPct}%;
                      height:100%;background:var(--success-tint,rgba(93,212,164,.15))"></div>
          <div style="position:absolute;top:0;left:0;width:${pct}%;height:100%;
                      background:${status.color};opacity:.85"></div>
          <div style="position:absolute;top:-1px;left:${mevPct}%;width:1px;height:10px;background:var(--mut)"></div>
          <div style="position:absolute;top:-1px;left:${mrvPct}%;width:1px;height:10px;background:var(--danger,#FF6B6B)"></div>
        </div>
      </div>`;
  }).join('');

  // ---- Imbalances ----
  const warns = imb.filter(i => i.severity !== 'ok');
  const imbHtml = warns.length === 0
    ? '<p class="mut" style="font-size:12px;margin:6px 0">✓ Aucun déséquilibre majeur sur 4 semaines.</p>'
    : warns.map(i =>
        `<div style="margin:6px 0;font-size:12px;line-height:1.4">
           <strong>⚖️ ${escapeHtml(i.label)} : ${i.value}</strong>
           <span class="mut">(cible ${escapeHtml(i.target || '?')})</span><br>
           <span class="mut">${escapeHtml(i.message)}</span>
         </div>`).join('');

  // ---- Responder ----
  const respHtml = `
    <div style="margin:8px 0;font-size:13px">
      <strong>🧬 Type de réponse&nbsp;:</strong> ${escapeHtml(responder.label)}
      ${responder.slope != null
        ? `<span class="mut">(${responder.slope > 0 ? '+' : ''}${responder.slope} kg/sem moyen sur ${responder.sample} exo${responder.sample > 1 ? 's' : ''})</span>`
        : ''}
      <p class="mut" style="font-size:12px;margin:4px 0 0;line-height:1.4">${escapeHtml(responder.advice)}</p>
    </div>`;

  // ---- Block periodization ----
  // Phase effective via blockMods (peut différer de la phase scheduled si
  // adaptiveBlockOverride a flagged un signal RPE).
  const blockEff = block ? P.blockMods(S.macrocycle, S.history) : null;
  const adaptiveBanner = (block && blockEff && blockEff.adaptive)
    ? `<div style="margin-top:6px;padding:6px 8px;background:var(--warn-tint,rgba(242,196,87,.15));
                   border-left:2px solid var(--warn);border-radius:4px;font-size:11px;line-height:1.4">
         <strong>⚙️ Adaptation auto :</strong> ${escapeHtml(blockEff.adaptiveReason)}.<br>
         Phase effective ce jour : <strong>${escapeHtml(blockEff.phaseLabel.toLowerCase())}</strong>
         (au lieu de ${escapeHtml(block.phase.label.toLowerCase())}).
       </div>`
    : '';
  const blockHtml = block
    ? `<div style="margin:10px 0 0;padding:8px 10px;background:var(--bg2);border-radius:6px;font-size:13px">
         <strong>📅 Cycle ${block.cycleNum} · Semaine ${block.weekInCycle}/${block.totalWeeks}</strong> — phase
         <strong style="color:var(--accent)">${escapeHtml(block.phase.label.toLowerCase())}</strong>.<br>
         <span class="mut" style="font-size:11px">${escapeHtml(block.phase.desc)}</span>
         ${adaptiveBanner}
         <br>
         <button type="button" id="blockResetBtn"
                 style="background:none;border:none;color:var(--mut);text-decoration:underline;
                        cursor:pointer;font-size:11px;padding:4px 0;margin-top:4px">
           Désactiver la périodisation
         </button>
       </div>`
    : `<div style="margin:10px 0 0;padding:8px 10px;background:var(--bg2);border-radius:6px;font-size:13px">
         <strong>📅 Périodisation par blocs</strong>
         <p class="mut" style="font-size:12px;margin:4px 0 8px;line-height:1.4">
           Cycle structuré 6 sem (Issurin) : 3 sem accumulation → transmutation → réalisation → deload.
           Adapte automatiquement le volume et l'intensité de tes séances selon la phase courante.
         </p>
         <button type="button" id="blockStartBtn" class="sec" style="font-size:12px;padding:4px 12px">
           Démarrer un cycle
         </button>
       </div>`;

  // ---- Bayesian forecasts (niveau 3) ----
  // Pour chaque key lift dispo, on dessine la trajectoire prévue avec
  // bande d'incertitude. Skipped si pas assez de données.
  const forecastHtml = renderBayesianForecasts();

  body.innerHTML = `
    <div style="font-size:12px;color:var(--mut);margin-bottom:4px">VOLUME HEBDO PAR GROUPE</div>
    ${volBars}
    <p class="mut" style="font-size:11px;margin:6px 0 12px">
      Trait gris = MEV (minimum) · zone verte = sweet spot · trait rouge = MRV (max récup).
    </p>
    <div style="font-size:12px;color:var(--mut);border-top:1px solid var(--line);padding-top:10px;margin-bottom:4px">ÉQUILIBRE MOUVEMENTS (4 SEM)</div>
    ${imbHtml}
    <div style="font-size:12px;color:var(--mut);border-top:1px solid var(--line);padding-top:10px;margin-bottom:4px;margin-top:10px">PROFIL DE RÉPONSE</div>
    ${respHtml}
    ${forecastHtml}
    ${blockHtml}`;

  // Wire des boutons.
  const startBtn = document.getElementById('blockStartBtn');
  if (startBtn) startBtn.addEventListener('click', startMacrocycle);
  const resetBtn = document.getElementById('blockResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', stopMacrocycle);
}

// renderBayesianForecasts — construit l'HTML d'une section "Trajectoires
// prévues" qui dessine, pour chaque key lift avec assez de données, un mini
// graph SVG de la projection à 90 jours avec bande d'incertitude (CI 90%).
//
// Le but : rendre la pente du filtre tangible visuellement et donner un
// objectif chiffré "à ce rythme tu atteindras X kg dans 90 jours".
function renderBayesianForecasts() {
  if (!window.Bayesian || !window.Programming) return '';
  // Choix dynamique des key lifts à projeter — basé sur le volume réel
  // pondéré par la half-life du profil (default 60j).
  const halfLife = keyLiftHalfLifeFor();
  const keyLifts = (typeof window.Programming.pickKeyLifts === 'function')
    ? window.Programming.pickKeyLifts(S.history, 6, { halfLifeDays: halfLife })
    : (window.Programming.KEY_LIFTS || []);
  const cards = [];
  const drifts = [];
  const plateaus = [];
  for (const exoId of keyLifts) {
    const state = ModelCache.kalmanState(exoId, { halfLifeDays: halfLife });
    if (!state || state.n < 4) continue;          // pas assez de données
    const traj = window.Bayesian.forecastTrajectory(state, 90, 7, 0.9);
    if (traj.length < 2) continue;
    const lib = (window.EX_BY_ID || {})[exoId];
    const name = (lib && lib.n) || exoId;
    cards.push(buildForecastCard(name, exoId, state, traj));
    // Détection de dérive lente (régression silencieuse).
    const drift = window.Bayesian.detectDrift(state);
    if (drift.drifting) {
      drifts.push({ name, exoId, drift });
    } else if (typeof window.Bayesian.detectPlateau === 'function') {
      // Plateau confiant (pente ~nulle, incertitude faible, ≥4 sem) —
      // mutuellement exclusif avec la dérive : on ne flag pas les deux.
      const plat = window.Bayesian.detectPlateau(state);
      if (plat.plateau) plateaus.push({ name, exoId, plat });
    }
  }
  if (cards.length === 0) return '';
  // Bandeau d'alerte regroupé pour les exos en dérive — séparé visuellement
  // des forecasts normaux pour ne pas se confondre avec une simple stagnation.
  const driftHtml = drifts.length === 0 ? '' : `
    <div style="margin:10px 0;padding:10px 12px;border-left:3px solid var(--warn,#F2C457);
                background:var(--bg2);border-radius:6px;font-size:13px;line-height:1.5">
      <strong>📉 Dérive détectée</strong> sur ${drifts.length} exo${drifts.length > 1 ? 's' : ''} :
      ${drifts.map(d =>
        `<span class="pill" style="margin-right:6px">${escapeHtml(d.name)} ` +
        `(${d.drift.betaPerWeek > 0 ? '+' : ''}${d.drift.betaPerWeek} kg/sem)</span>`
      ).join('')}
      <p class="mut" style="font-size:12px;margin:6px 0 0">${escapeHtml(drifts[0].drift.advice)}</p>
    </div>`;
  // Plateaux confiants — suggestion de variation (masquée si opt-out art. 22,
  // c'est une recommandation algorithmique).
  const plateauHtml = (plateaus.length === 0 || currentUserAlgoOptOut) ? '' : `
    <div style="margin:10px 0;padding:10px 12px;border-left:3px solid var(--blue,#7BA1FF);
                background:var(--bg2);border-radius:6px;font-size:13px;line-height:1.5">
      <strong>📊 Plateau confirmé</strong> sur ${plateaus.length} exo${plateaus.length > 1 ? 's' : ''} :
      ${plateaus.map(p =>
        `<span class="pill" style="margin-right:6px">${escapeHtml(p.name)} ` +
        `(${p.plat.weeks} sem)</span>`
      ).join('')}
      <p class="mut" style="font-size:12px;margin:6px 0 0">${escapeHtml(plateaus[0].plat.advice)}</p>
    </div>`;
  return `
    <div style="font-size:12px;color:var(--mut);border-top:1px solid var(--line);
                padding-top:10px;margin-bottom:4px;margin-top:10px">
      TRAJECTOIRES PRÉVUES (90 JOURS)
    </div>
    ${driftHtml}
    ${plateauHtml}
    ${cards.join('')}
    <p class="mut" style="font-size:11px;margin:4px 0 0;line-height:1.4">
      Filtre de Kalman 2D par exo, robuste aux outliers (M-estimateur Huber).
      Bande grise = intervalle de confiance 90 %, qui s'élargit avec l'horizon
      car l'incertitude grandit.
    </p>`;
}

// buildForecastCard — un graph SVG par exo. Trace la trajectoire moyenne
// + bande de CI. Texte récap : 1RM courant et projection à 90j.
function buildForecastCard(name, exoId, state, traj) {
  const W = 320, H = 80, PAD = 8;
  const minY = Math.min.apply(null, traj.map(p => p.low));
  const maxY = Math.max.apply(null, traj.map(p => p.high));
  const range = Math.max(1, maxY - minY);
  const minX = traj[0].day;
  const maxX = traj[traj.length - 1].day;
  const xRange = Math.max(1, maxX - minX);
  function px(p) {
    const x = PAD + (W - 2 * PAD) * (p.day - minX) / xRange;
    const y = PAD + (H - 2 * PAD) * (1 - (p.mu - minY) / range);
    const yLow = PAD + (H - 2 * PAD) * (1 - (p.low - minY) / range);
    const yHigh = PAD + (H - 2 * PAD) * (1 - (p.high - minY) / range);
    return [x, y, yLow, yHigh];
  }
  const points = traj.map(px);
  const meanPath = points.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  // Bande de CI : aller en haut puis revenir en bas pour fermer le polygone.
  const upperPath = points.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[3].toFixed(1)).join(' ');
  const lowerPath = points.slice().reverse().map((pt) => 'L' + pt[0].toFixed(1) + ' ' + pt[2].toFixed(1)).join(' ');
  const bandPath = upperPath + ' ' + lowerPath + ' Z';
  // Ticks visuels sur l'axe X aux 30/60/90 jours.
  const ticks = [30, 60, 90].map(d => {
    const x = PAD + (W - 2 * PAD) * (d - minX) / xRange;
    return `<line x1="${x.toFixed(1)}" y1="${PAD}" x2="${x.toFixed(1)}" y2="${H - PAD}"
              stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,3"/>`;
  }).join('');
  const cur = window.Bayesian.current1RM(state, 0.9);
  const f90 = window.Bayesian.forecast(state, 90, 0.9);
  const slopePerWeek = (state.betaClipped != null ? state.betaClipped : state.beta) * 7;
  const slopeTxt = slopePerWeek === 0
    ? 'tendance plate'
    : (slopePerWeek > 0 ? '+' : '') + slopePerWeek.toFixed(2) + ' kg/sem';
  return `
    <div style="margin:10px 0">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:2px">
        <strong>${escapeHtml(name)}</strong>
        <span class="mut" style="font-size:11px">${escapeHtml(slopeTxt)}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
        ${ticks}
        <path d="${bandPath}" fill="var(--mut)" opacity="0.15"/>
        <path d="${meanPath}" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
        <text x="${PAD}" y="${H - 1}" font-size="9" fill="var(--mut)">${minY.toFixed(0)}</text>
        <text x="${W - PAD}" y="${H - 1}" font-size="9" fill="var(--mut)" text-anchor="end">${maxY.toFixed(0)}kg</text>
        <text x="${PAD + (W - 2 * PAD) * 30 / xRange}" y="${PAD - 1}" font-size="9" fill="var(--mut)" text-anchor="middle">30j</text>
        <text x="${PAD + (W - 2 * PAD) * 60 / xRange}" y="${PAD - 1}" font-size="9" fill="var(--mut)" text-anchor="middle">60j</text>
        <text x="${PAD + (W - 2 * PAD) * 90 / xRange}" y="${PAD - 1}" font-size="9" fill="var(--mut)" text-anchor="middle">90j</text>
      </svg>
      <div style="font-size:11px;color:var(--mut);margin-top:2px">
        Aujourd'hui : <strong>${cur.mu.toFixed(1)} kg</strong>
        <span style="opacity:.8">(${cur.low.toFixed(0)}-${cur.high.toFixed(0)})</span>
        &nbsp;→&nbsp; +90j : <strong>${f90.mu.toFixed(1)} kg</strong>
        <span style="opacity:.8">(${f90.low.toFixed(0)}-${f90.high.toFixed(0)})</span>
      </div>
    </div>`;
}

// currentMacrocycleState — wrapper qui lit S.macrocycle et appelle Programming.
function currentMacrocycleState() {
  if (!S.macrocycle || !window.Programming) return null;
  return window.Programming.currentBlockState(S.macrocycle);
}

function startMacrocycle() {
  S.macrocycle = {
    startDate: new Date().toISOString().slice(0, 10),
    focus: (S.profile && S.profile.goals && S.profile.goals[0]) || 'force',
  };
  S.currentSession = null;
  queueSave();
  renderProgrammingCard();
  showToast('Cycle activé', { variant: 'success',
    message: 'Tu démarres en accumulation. Tes séances vont s\'adapter à la phase courante.' });
}

async function stopMacrocycle() {
  const ok = await openConfirm(
    'Désactiver la périodisation ?',
    'Tes séances reviendront à la génération adaptative classique. Tu pourras redémarrer un cycle quand tu veux.',
    { confirmLabel: 'Désactiver', cancelLabel: 'Garder' }
  );
  if (!ok) return;
  S.macrocycle = null;
  S.currentSession = null;
  queueSave();
  renderProgrammingCard();
  showToast('Périodisation désactivée', { variant: 'info', message: 'Retour au mode adaptatif.' });
}

// renderPausedSessionHint — affiche un encart de reprise quand une séance
// a été mise en pause. Boutons "Reprendre" (efface pausedAt + ouvre viewer)
// et "Abandonner" (drop currentSession). Idempotent.
function renderPausedSessionHint() {
  const box = document.getElementById('nextSessionBox');
  if (!box) return;
  const prior = document.getElementById('pausedHint');
  if (prior) prior.remove();
  const cs = S.currentSession;
  if (!cs || !cs.pausedAt) return;
  const ts = Date.parse(cs.pausedAt);
  const ago = isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 60000)) : 0;
  const agoTxt = ago < 1 ? 'à l\'instant'
               : ago < 60 ? `il y a ${ago} min`
               : ago < 1440 ? `il y a ${Math.floor(ago / 60)} h`
               : `il y a ${Math.floor(ago / 1440)} jours`;
  const setsCount = (cs.sets || []).length;
  const totalSets = (cs.exos || []).reduce((s, e) => s + (e.sets || 0), 0);
  const card = document.createElement('div');
  card.id = 'pausedHint';
  card.className = 'card';
  card.style.cssText = 'border-left:3px solid var(--accent);padding:12px 14px;margin-bottom:8px';
  card.innerHTML = `
    <div style="font-size:14px;line-height:1.5;margin-bottom:8px">
      <strong>⏸ Séance en pause</strong> — ${escapeHtml(cs.title || 'séance en cours')}.<br>
      <span class="mut">Mise en pause ${escapeHtml(agoTxt)} · ${setsCount}/${totalSets} sets faits.</span>
    </div>
    <div class="row">
      <button type="button" class="magenta flex1" id="resumeBtn">▶ Reprendre</button>
      <button type="button" class="sec" id="abandonBtn">Abandonner</button>
    </div>`;
  box.parentNode.insertBefore(card, box);
  card.querySelector('#resumeBtn').addEventListener('click', () => {
    delete S.currentSession.pausedAt;
    queueSave();
    openSession();
  });
  card.querySelector('#abandonBtn').addEventListener('click', async () => {
    const ok = await openConfirm(
      'Abandonner la séance ?',
      'Les sets faits seront perdus. Une nouvelle séance sera générée.',
      { confirmLabel: 'Abandonner', cancelLabel: 'Garder', danger: true }
    );
    if (!ok) return;
    S.currentSession = null;
    queueSave();
    openHome();
  });
}

// renderPlateauHint — affiche jusqu'à 2 exos en plateau et une suggestion
// de variante. Insérée au-dessus de nextSessionBox, sous renderDeloadHint
// (pour ne pas masquer un signal plus urgent). Idempotent.
function renderPlateauHint() {
  const box = document.getElementById('nextSessionBox');
  if (!box) return;
  const prior = document.getElementById('plateauHint');
  if (prior) prior.remove();
  const plateaus = detectPlateaus(S.history);
  if (plateaus.length === 0) return;
  // Top 2 par ancienneté.
  const top = plateaus.slice(0, 2);
  const card = document.createElement('div');
  card.id = 'plateauHint';
  card.className = 'card';
  card.style.cssText = 'border-left:3px solid var(--warn,#F2C457);padding:12px 14px;margin-bottom:8px;font-size:13px';
  const items = top.map(p => {
    const varias = suggestVariation(p.exoId);
    const variantList = varias.length === 0
      ? '<span class="mut">Aucune variante dispo avec ton matériel.</span>'
      : varias.map(v =>
          `<a href="#" class="lnk plateau-suggest" data-exo="${escapeHtml(v.id)}"
              style="color:var(--blue);text-decoration:underline;margin-right:8px">${escapeHtml(v.n)}</a>`
        ).join('');
    return `
      <div style="margin:6px 0">
        <strong>${escapeHtml(p.name)}</strong>
        — pas de progression depuis ${p.daysSince}j (1RM est. ${p.bestEst}kg).<br>
        <span class="mut" style="font-size:12px">Essaie une variante : ${variantList}</span>
      </div>`;
  }).join('');
  card.innerHTML = `
    <strong>📉 Stagnation détectée</strong>
    <div style="margin-top:6px">${items}</div>`;
  box.parentNode.insertBefore(card, box);
  card.querySelectorAll('.plateau-suggest').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openExerciseDetail(a.dataset.exo, openHome);
    });
  });
}

function renderCalendarHeatmap() {
  const box = document.getElementById('calHeatmap');
  if (!box) return;
  if (!Array.isArray(S.history) || S.history.length === 0) {
    box.innerHTML = '<p class="mut">Pas encore de données.</p>';
    return;
  }
  const { levels, weeksBack } = computeHeatmap(S.history, 16);
  // Build 7 rows × weeksBack columns. Layout: column-major; first column = oldest.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalDays = weeksBack * 7;
  // Align so the rightmost column ends on today's weekday — Mon=0..Sun=6 (FR convention).
  const todayIdx = (today.getDay() + 6) % 7; // 0=Mon
  const cells = [];
  for (let col = 0; col < weeksBack; col++) {
    for (let row = 0; row < 7; row++) {
      // dayOffset counted from today backwards.
      const offset = (weeksBack - 1 - col) * 7 + (todayIdx - row);
      if (offset < 0 || offset >= totalDays) {
        cells.push(`<div class="heatmap-cell" style="visibility:hidden"></div>`);
        continue;
      }
      const d = new Date(today.getTime() - offset * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const lvl = levels[iso] || 0;
      const cls = lvl > 0 ? `l${lvl}` : '';
      cells.push(`<div class="heatmap-cell ${cls}" title="${iso}${lvl ? ' — séance' : ''}"></div>`);
    }
  }
  // grid-auto-flow:column means we just emit cells row-by-row within each column,
  // so flatten in (row,col) order — but our loop is (col,row). The CSS handles it
  // because grid-auto-flow:column fills column-first. We need to emit by column,
  // row 0..6 within each column. Our current loop does exactly that.
  box.innerHTML = `
    <div class="heatmap-grid">${cells.join('')}</div>
    <div class="heatmap-legend">
      <span>Moins</span>
      <div class="heatmap-cell"></div>
      <div class="heatmap-cell l1"></div>
      <div class="heatmap-cell l2"></div>
      <div class="heatmap-cell l3"></div>
      <div class="heatmap-cell l4"></div>
      <span>Plus</span>
    </div>`;
}

// renderSorenessCheck — surfaces a small banner if the user trained recently
// (last session 0-2 days ago) and hasn't yet declared soreness today. The
// answer is stored on profile.painToday (overwriting the onboarding default
// for this session only) and a profile.sorenessCheckedAt date stamp keeps the
// banner from re-appearing the same day.
// SORENESS_PARTS est déclaré en haut du fichier (source unique de zones).
function renderSorenessCheck() {
  const card = document.getElementById('sorenessCard');
  if (!card) return;
  const last = (S.history || []).slice(-1)[0];
  if (!last || !last.date) { card.classList.add('hide'); return; }
  const lastDate = new Date(last.date);
  const today = new Date();
  const dayDiff = Math.floor((today - lastDate) / 86400000);
  const todayISO = today.toISOString().slice(0, 10);
  if (dayDiff > 2) { card.classList.add('hide'); return; }
  if (S.profile && S.profile.sorenessCheckedAt === todayISO) {
    card.classList.add('hide'); return;
  }
  // Selected pains start from current painToday so toggles round-trip.
  const selected = new Set(S.profile.painToday || []);
  const chipsBox = document.getElementById('sorenessChips');
  chipsBox.innerHTML = SORENESS_PARTS.map(p =>
    `<button type="button" class="chip ${selected.has(p.key) ? 'on' : ''}" data-key="${p.key}">${escapeHtml(p.label)}</button>`
  ).join('');
  chipsBox.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => c.classList.toggle('on'));
  });
  card.classList.remove('hide');

  document.getElementById('sorenessApply').onclick = () => {
    const picked = Array.from(chipsBox.querySelectorAll('.chip.on')).map(c => c.dataset.key);
    S.profile.painToday = picked;
    S.profile.sorenessCheckedAt = todayISO;
    S.currentSession = generateSession();
    queueSave();
    card.classList.add('hide');
    renderNext();
  };
  document.getElementById('sorenessSkip').onclick = () => {
    S.profile.sorenessCheckedAt = todayISO;
    queueSave();
    card.classList.add('hide');
  };
}

/* =============================================================
 * Science card (niveau 5) — check-in matinal + alertes intégrées.
 * Une seule card sur la home qui agrège :
 *   - Hooper wellness (5 items)             → S.body.hooper
 *   - Lifestyle (pas, café, lumière matin)  → S.body.lifestyle
 *   - Readiness composite (HRV + Hooper)    → calcul live
 *   - Bannière désentraînement (Mujika)     → si gap >7j depuis dernière séance
 *   - Asymétries G/D (Bishop)               → si différence >10% sur 6 sem
 *   - PVT hebdo (Dinges)                    → bouton si rien depuis 7j
 *   - Intentions (Gollwitzer)               → rappels si statut pending
 * ============================================================= */
function renderScienceCard() {
  const card = document.getElementById('scienceCard');
  const body = document.getElementById('scienceCardBody');
  if (!card || !body || !window.Science) return;
  ensureBodyState();
  const S2 = window.Science;
  const today = new Date().toISOString().slice(0, 10);

  // --- 1. Détection désentraînement -------------------------------------
  // Courbe personnalisée (Mujika & Padilla) : on passe l'ancienneté
  // d'entraînement (span de l'historique) et le CTL courant pour moduler
  // la perte projetée — un athlète entraîné retient mieux qu'un novice.
  const gap = S2.lastTrainingGapDays(S.history);
  let detrainOpts;
  try {
    const hist = S.history || [];
    if (hist.length > 1) {
      const ts = hist.map(h => Date.parse(h.date || '')).filter(isFinite);
      const spanWeeks = ts.length > 1
        ? (Math.max.apply(null, ts) - Math.min.apply(null, ts)) / (7 * 86400000)
        : 0;
      const ctl = window.Banister ? window.Banister.computeAll(hist).ctl : null;
      detrainOpts = { trainingAgeWeeks: spanWeeks, ctl };
    }
  } catch (_) { /* fallback courbe standard */ }
  const detrain = gap != null ? S2.detrainingProjection(gap, detrainOpts) : null;

  // --- 2. Readiness composite (HRV Plews + Hooper) ----------------------
  const hrv = S.body.physio && S.body.physio.length > 0
    ? S2.hrvReadiness(S.body.physio) : null;
  const todayHooper = (S.body.hooper || []).find(h => h.date === today);
  const hoop = todayHooper ? S2.hooperReadiness(todayHooper) : null;
  let composite = null;
  if (hrv || hoop) {
    const parts = [];
    if (hrv) parts.push(hrv.ready);
    if (hoop) parts.push(hoop.ready);
    composite = Math.round(parts.reduce((a, v) => a + v, 0) / parts.length);
  }

  // --- 3. Asymétries G/D (Bishop) ---------------------------------------
  const asyms = S2.asymmetryReport(S.history)
    .filter(a => a.label === 'notable' || a.label === 'severe').slice(0, 3);

  // --- 4. PVT — recommandé si rien depuis 7 jours -----------------------
  const lastPvt = S.body.pvt && S.body.pvt.length > 0
    ? S.body.pvt.reduce((m, p) =>
        Date.parse(p.date) > Date.parse(m.date) ? p : m, S.body.pvt[0])
    : null;
  const pvtAgeDays = lastPvt
    ? Math.floor((Date.now() - Date.parse(lastPvt.date)) / 86400000) : 999;

  // --- 5. Intentions en cours -------------------------------------------
  const pendingIntentions = (S.body.intentions || [])
    .filter(i => i.status === 'pending').slice(0, 3);

  // --- Render -----------------------------------------------------------
  const blocks = [];

  // 1. Bandeau désentraînement (priorité : tout en haut s'il existe)
  if (detrain && detrain.daysOff >= 7) {
    blocks.push(`
      <div class="sci-detrain ${detrain.severity}">
        <strong>⏸ Pause de ${detrain.daysOff} jours détectée</strong><br>
        <span style="opacity:.92">
          Selon Mujika (2000), tu as probablement perdu ~${detrain.lossPct}% de 1RM.
          Ta prochaine séance proposera des charges réduites de ${detrain.suggestedLoadReductionPct}%
          — remontée progressive sur 2-3 semaines.
        </span>
      </div>
    `);
  }

  // 2. Readiness composite (HRV Plews + Hooper)
  if (composite != null) {
    const cls = composite >= 70 ? 'good'
              : composite >= 50 ? 'normal'
              : composite >= 30 ? 'caution' : 'low';
    const lab = composite >= 70 ? 'Prêt à pousser'
              : composite >= 50 ? 'Normal'
              : composite >= 30 ? 'Réduire l\'intensité' : 'Repos conseillé';
    const detailParts = [];
    if (hrv) detailParts.push(`HRV ${hrv.ready}${hrv.label === 'low' ? ' (chute)' : ''}`);
    if (hoop) detailParts.push(`Hooper ${hoop.ready}`);
    blocks.push(`
      <div class="sci-section">
        <div class="sci-section-title">
          <span>⚡ Readiness</span><span class="pill">composite</span>
        </div>
        <div class="sci-readiness">
          <div class="sci-readiness-disc ${cls}">${composite}</div>
          <div>
            <div class="sci-readiness-label">${lab}</div>
            <div class="sci-readiness-detail">${detailParts.join(' · ') || 'baseline en construction'}</div>
          </div>
        </div>
      </div>
    `);
  }

  // 3. Hooper — questionnaire si pas encore rempli aujourd'hui
  if (!todayHooper) {
    const items = [
      ['sleep', 'Qualité de sommeil'],
      ['stress', 'Niveau de stress'],
      ['mood', 'Humeur'],
      ['soreness', 'Courbatures'],
      ['fatigue', 'Fatigue générale'],
    ];
    // NB : pas de `oninput=` ni `onclick=` inline — bloqués par la CSP
    // (script-src 'self' sans 'unsafe-inline'). Wiring fait plus bas via
    // addEventListener après injection du HTML.
    blocks.push(`
      <details class="sci-collapsible" data-sci-block="hooper-form">
        <summary>📋 Check-in Hooper (30s, 5 questions 1-7)</summary>
        <div class="sci-collapsible-body">
          <div class="sci-form-row">
            ${items.map(([k, lab]) => `
              <label>
                <span>${lab} <span class="mut" style="font-size:11px">(1=excellent, 7=mauvais)</span></span>
                <input type="range" min="1" max="7" step="1" value="4" id="hoop_${k}" data-sci-slider="${k}">
                <span class="sci-slider-value" id="hoop_${k}_v">4</span>
              </label>
            `).join('')}
          </div>
          <button type="button" class="ok w-full" data-sci-action="save-hooper" style="margin-top:10px">
            Enregistrer
          </button>
        </div>
      </details>
    `);
  } else {
    blocks.push(`
      <div class="sci-done">
        ✓ Hooper du jour enregistré · index <strong>${todayHooper.raw}/35</strong>
        ${todayHooper.raw >= 22 ? ' (surveillance recommandée)' : ''}
        <span class="lnk" data-sci-action="reset-hooper">refaire</span>
      </div>
    `);
  }

  // 4. Lifestyle (NEAT + caféine + lumière)
  // NEAT = "Non-Exercise Activity Thermogenesis" : tout ce que tu dépenses en
  // calories HORS sport intentionnel (marcher, rester debout, gestes du
  // quotidien). Levine 2005 a montré que c'est le principal facteur de
  // variance de poids long terme, plus que le sport lui-même. Compter ses
  // pas est le proxy le plus simple — pas besoin d'un wearable, juste la
  // valeur du soir affichée par Health/Google Fit/montre/podomètre.
  const todayLs = (S.body.lifestyle || []).find(l => l.date === today);
  if (!todayLs) {
    blocks.push(`
      <details class="sci-collapsible" data-sci-block="lifestyle-form">
        <summary>🌅 Vie quotidienne (NEAT + caféine + lumière)</summary>
        <div class="sci-collapsible-body">
          <div class="sci-form-row">
            <label>
              <span>Pas comptabilisés hier
                <span class="mut" style="font-size:11px">
                  (NEAT = activité hors sport, principal moteur du poids long terme — Levine 2005)
                </span>
              </span>
              <input type="number" id="ls_steps" min="0" max="50000" step="100" placeholder="ex: 8500 (regarde ton tél / montre)">
            </label>
            <label>
              <span>Heures entre dernier café et coucher hier
                <span class="mut" style="font-size:11px">(Drake 2013, idéal &gt;6h)</span>
              </span>
              <input type="number" id="ls_caffeine" min="0" max="24" step="0.5" placeholder="ex: 8 (dernier café à 14h, coucher 22h = 8)">
            </label>
            <label class="sci-check-label">
              <input type="checkbox" id="ls_light">
              <span>10 min de lumière vive dehors avant 10h ce matin
                <span class="mut" style="font-size:11px">(alignement circadien — Wright 2013)</span>
              </span>
            </label>
          </div>
          <button type="button" class="ok w-full" data-sci-action="save-lifestyle" style="margin-top:10px">
            Enregistrer
          </button>
        </div>
      </details>
    `);
  } else {
    const bits = [];
    if (todayLs.steps != null) bits.push(`<strong>${todayLs.steps}</strong> pas`);
    if (todayLs.lastCaffeineH != null) bits.push(`café <strong>${todayLs.lastCaffeineH}h</strong> avant coucher`);
    if (todayLs.morningLight) bits.push('lumière matin ✓');
    blocks.push(`
      <div class="sci-done">
        ✓ Vie quotidienne du jour : ${bits.join(' · ')}
      </div>
    `);
  }

  // 5. Asymétries (Bishop 2018) — affiché en alerte si présent
  if (asyms.length > 0) {
    blocks.push(`
      <div class="sci-warning">
        <strong>⚖️ Asymétrie détectée</strong>
        <span class="mut" style="font-size:11px"> · Bishop 2018</span>
        ${asyms.map(a => {
          const exo = (typeof EX_BY_ID !== 'undefined') ? EX_BY_ID[a.exoId] : null;
          const name = exo ? exo.n : a.exoId;
          return `<div class="sci-warning-item">
            <strong>${escapeHtml(name)}</strong> — côté ${a.weaker === 'L' ? 'gauche' : 'droit'}
            plus faible de ${a.diffPct}%
            (${Math.min(a.nL, a.nR)} séries / côté)
            ${a.label === 'severe' ? '<span class="sev">[sévère]</span>' : ''}
          </div>`;
        }).join('')}
        <p class="mut" style="font-size:11px;margin:6px 0 0">
          &gt;10% = séries supplémentaires côté faible recommandées.
        </p>
      </div>
    `);
  }

  // 6. PVT — recommandé si rien depuis 7 jours
  if (pvtAgeDays >= 7) {
    blocks.push(`
      <button class="sci-pvt-btn" data-sci-action="open-pvt">
        🧠 Test de vigilance PVT (90s)
        <div class="mut" style="font-size:11px;margin-top:4px">
          ${lastPvt ? `Dernier il y a ${pvtAgeDays}j` : 'Première fois'}
          · Dinges 1985, recommandé 1×/semaine
        </div>
      </button>
    `);
  } else if (lastPvt) {
    blocks.push(`
      <div class="sci-done">
        ✓ Dernier PVT il y a ${pvtAgeDays}j : ${lastPvt.meanMs} ms moyen, ${lastPvt.lapses} lapses
      </div>
    `);
  }

  // 7. Intentions en cours (Gollwitzer 1999)
  if (pendingIntentions.length > 0) {
    blocks.push(`
      <div class="sci-section">
        <div class="sci-section-title">
          <span>🎯 Intentions en cours</span><span class="pill">Gollwitzer</span>
        </div>
        ${pendingIntentions.map((it, i) => `
          <div class="sci-intention">
            <span class="sci-intention-text">
              <em>Si</em> ${escapeHtml(it.trigger)} <em>alors</em> ${escapeHtml(it.action)}
            </span>
            <button class="ok" style="padding:4px 10px;font-size:11px"
                    data-sci-action="mark-intention" data-idx="${i}" data-status="done">✓ fait</button>
            <button class="sec" style="padding:4px 8px;font-size:11px"
                    data-sci-action="mark-intention" data-idx="${i}" data-status="missed">✗</button>
          </div>
        `).join('')}
      </div>
    `);
  }

  // 8. Nouvelle intention — collapsible toujours présent
  blocks.push(`
    <details class="sci-collapsible" data-sci-block="intention-form">
      <summary>+ Nouvelle intention d'implémentation</summary>
      <div class="sci-collapsible-body">
        <div class="sci-form-row">
          <input type="text" id="int_trigger" placeholder="Si... (ex: je rentre du boulot mardi soir)" maxlength="120">
          <input type="text" id="int_action" placeholder="alors... (ex: je mets ma tenue avant de m'asseoir)" maxlength="120">
        </div>
        <button type="button" class="ok w-full" data-sci-action="save-intention" style="margin-top:8px">
          Enregistrer
        </button>
        <p class="mut" style="font-size:11px;margin:8px 0 0">
          Format Gollwitzer 1999 — d≈0.65 sur la formation d'habitudes.
        </p>
      </div>
    </details>
  `);

  // 9. Lien vers la vue Insights (corrélations long terme)
  blocks.push(`
    <button class="sci-insights-btn" data-sci-action="open-insights">
      📊 Voir mes corrélations long terme (café/sommeil, NEAT, body comp)
    </button>
  `);

  body.innerHTML = blocks.join('');

  // ============================================================
  // Wiring des handlers (CSP-safe — pas d'inline onclick/oninput)
  // ============================================================
  // 1) Sliders Hooper : live update du span associé.
  body.querySelectorAll('input[data-sci-slider]').forEach((sl) => {
    const key = sl.dataset.sciSlider;
    const out = body.querySelector('#hoop_' + key + '_v');
    if (!out) return;
    const sync = () => { out.textContent = sl.value; };
    sl.addEventListener('input', sync);
    sl.addEventListener('change', sync);
  });
  // 2) Actions sur boutons / liens via data-sci-action.
  body.querySelectorAll('[data-sci-action]').forEach((el) => {
    const action = el.dataset.sciAction;
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      switch (action) {
        case 'save-hooper':    saveHooper(); break;
        case 'save-lifestyle': saveLifestyle(); break;
        case 'save-intention': saveIntention(); break;
        case 'reset-hooper':   resetHooperToday(); break;
        case 'open-pvt':       openPvt(); break;
        case 'open-insights':  openInsights(); break;
        case 'mark-intention': {
          const idx = +el.dataset.idx;
          const status = el.dataset.status;
          markIntention(idx, status);
          break;
        }
      }
    });
  });
}

// Helper exposé sur window pour le bouton "refaire" du Hooper du jour.
function resetHooperToday() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  S.body.hooper = S.body.hooper.filter(h => h.date !== today);
  queueSave();
  renderScienceCard();
}

// Persiste un Hooper du jour à partir du formulaire ouvert dans la card.
function saveHooper() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  const entry = { date: today };
  for (const k of ['sleep', 'stress', 'mood', 'soreness', 'fatigue']) {
    entry[k] = +document.getElementById('hoop_' + k).value;
  }
  if (window.Science) {
    const h = window.Science.hooperIndex(entry);
    if (h) entry.raw = h.raw;
    const r = window.Science.hooperReadiness(entry);
    if (r) entry.ready = r.ready;
  }
  // Remplace si déjà présent
  const idx = S.body.hooper.findIndex(h => h.date === today);
  if (idx >= 0) S.body.hooper[idx] = entry; else S.body.hooper.push(entry);
  queueSave();
  renderScienceCard();
}

// Persiste les inputs lifestyle du jour
function saveLifestyle() {
  ensureBodyState();
  const today = new Date().toISOString().slice(0, 10);
  const steps = document.getElementById('ls_steps').value;
  const caf = document.getElementById('ls_caffeine').value;
  const light = document.getElementById('ls_light').checked;
  const entry = {
    date: today,
    steps: steps !== '' ? +steps : null,
    lastCaffeineH: caf !== '' ? +caf : null,
    morningLight: !!light,
  };
  const idx = S.body.lifestyle.findIndex(l => l.date === today);
  if (idx >= 0) S.body.lifestyle[idx] = entry; else S.body.lifestyle.push(entry);
  queueSave();
  renderScienceCard();
}

// Crée une nouvelle intention d'implémentation
function saveIntention() {
  ensureBodyState();
  const trigger = (document.getElementById('int_trigger').value || '').trim().slice(0, 120);
  const action = (document.getElementById('int_action').value || '').trim().slice(0, 120);
  if (!trigger || !action) return;
  S.body.intentions.push({
    date: new Date().toISOString(), trigger, action, status: 'pending',
  });
  queueSave();
  renderScienceCard();
}

// Marque une intention comme faite/manquée
function markIntention(pendingIdx, status) {
  ensureBodyState();
  const pending = S.body.intentions.filter(i => i.status === 'pending');
  const target = pending[pendingIdx];
  if (!target) return;
  const real = S.body.intentions.indexOf(target);
  S.body.intentions[real].status = status;
  queueSave();
  renderScienceCard();
}

/* =============================================================
 * PVT — Psychomotor Vigilance Task (Dinges 1985, Basner 2011 short)
 * =============================================================
 * Version courte (90s, 10-15 stimuli avec ISI 3-8s).
 * L'utilisateur tape dès qu'un cercle rouge apparaît à l'écran. On
 * mesure le temps de réaction par stimulus, et on calcule lapses
 * (RT>500ms), false starts (clic avant stimulus), RT moyen + median.
 * ============================================================= */
function openPvt() {
  if (!window.Science) { showToast && showToast('Module science manquant'); return; }
  ensureBodyState();
  // Modal full-screen avec un seul gros bouton tap
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui;text-align:center;padding:20px';
  overlay.innerHTML = `
    <div id="pvtMsg" style="font-size:22px;font-weight:600;margin-bottom:30px">
      Test PVT — vigilance psychomotrice (Dinges)
    </div>
    <div id="pvtTarget" style="width:140px;height:140px;border-radius:50%;background:#333;margin-bottom:30px;transition:background 80ms"></div>
    <div id="pvtHint" style="opacity:.7;font-size:14px;max-width:320px;line-height:1.5">
      Quand le cercle devient ROUGE, tape-le aussi vite que possible.<br>
      Durée : ~90s, 10-12 stimuli aléatoires.
    </div>
    <button id="pvtStart" style="margin-top:30px;padding:16px 32px;font-size:18px;background:#2d9b83;color:#fff;border:none;border-radius:10px">
      Démarrer
    </button>
    <button id="pvtAbort" style="margin-top:14px;font-size:13px;background:none;color:#888;border:none">
      Annuler
    </button>
  `;
  document.body.appendChild(overlay);
  const target = overlay.querySelector('#pvtTarget');
  const msg = overlay.querySelector('#pvtMsg');
  const hint = overlay.querySelector('#pvtHint');
  const start = overlay.querySelector('#pvtStart');
  const abort = overlay.querySelector('#pvtAbort');
  const reactions = [];
  let stimT = null, scheduled = null, stopFlag = false, idx = 0;
  const N = 12;
  function cleanup() { try { document.body.removeChild(overlay); } catch (_) {} }
  abort.onclick = () => { stopFlag = true; clearTimeout(scheduled); cleanup(); };
  target.style.cursor = 'pointer';

  function scheduleNext() {
    if (stopFlag || idx >= N) return finish();
    const isi = 2000 + Math.random() * 6000;  // 2-8s
    msg.textContent = `Stimulus ${idx + 1}/${N} — attends…`;
    target.style.background = '#333';
    scheduled = setTimeout(() => {
      if (stopFlag) return;
      stimT = performance.now();
      target.style.background = '#e74c3c';
      msg.textContent = 'TAP !';
    }, isi);
  }
  target.onclick = () => {
    if (stopFlag) return;
    if (stimT == null) {
      reactions.push(50);  // false start (<100ms par def)
      msg.textContent = 'Trop tôt ! Attends le rouge.';
      return;
    }
    const rt = performance.now() - stimT;
    reactions.push(Math.round(rt));
    stimT = null;
    idx++;
    target.style.background = '#333';
    msg.textContent = `${Math.round(rt)} ms`;
    setTimeout(scheduleNext, 800);
  };
  function finish() {
    const result = window.Science.pvtAnalyze(reactions);
    if (result) {
      const entry = Object.assign({ date: new Date().toISOString() }, result);
      S.body.pvt.push(entry);
      queueSave();
    }
    msg.textContent = 'Terminé !';
    hint.innerHTML = `
      <strong>RT moyen :</strong> ${result.meanMs || '—'} ms<br>
      <strong>Lapses (&gt;500ms) :</strong> ${result.lapses}<br>
      <strong>Faux départs :</strong> ${result.falseStarts}<br>
      <small style="opacity:.6">N=${result.n} stimuli valides</small>
    `;
    start.textContent = 'Fermer';
    start.onclick = cleanup;
    start.style.display = 'block';
    target.onclick = null;
    target.style.background = '#2d9b83';
  }
  start.onclick = () => {
    start.style.display = 'none';
    abort.style.display = 'none';
    hint.textContent = 'Concentre-toi sur le cercle.';
    setTimeout(scheduleNext, 1000);
  };
}

/* =============================================================
 * Vue Insights — corrélations long terme
 * =============================================================
 * Affiche les analyses qui n'ont du sens qu'avec ≥2 sem de données :
 *   - Trend NEAT (pas) : moyenne 7j vs précédent + plot
 *   - Corrélation café→sommeil : Pearson entre delai dernier café
 *     et qualité sommeil le lendemain (Drake 2013)
 *   - Lumière matinale × sommeil : ratio sommeil les jours light=true vs false
 *   - Trend body weight : pente Hall + intervalle de confiance R²
 *   - HRV : moyenne 7j vs baseline + variance individuelle (Plews)
 *   - Historique PVT : courbe RT moyen + lapses
 *   - Adhérence intentions : ratio done/total sur 30j (Gollwitzer)
 *
 * Cette vue est passive (read-only). Tous les inputs/edits restent
 * sur la science card de la home pour ne pas dupliquer les flows.
 * ============================================================= */
function openInsights() {
  show('viewInsights');
  renderInsights();
  // Wire le bouton "Retour" — CSP-safe.
  const back = document.getElementById('insightsBackBtn');
  if (back && !back._sciWired) {
    back._sciWired = true;
    back.addEventListener('click', (e) => { e.preventDefault(); openHome(); });
  }
}

// renderBlockReviewCard — carte HTML du bilan de bloc (BlockReview.compute).
// Pure présentation : toute la synthèse (adhérence, deltas Kalman, Banister,
// corrélation TSB↔HRV, recommandation motivée) vient de blockreview.js.
function renderBlockReviewCard(rev) {
  const liftName = (id) => {
    const e = window.EX_BY_ID && window.EX_BY_ID[id];
    return e ? (e.name || id) : id;
  };
  const liftRows = rev.lifts.filter(l => l.end).map(l => {
    const delta = l.deltaKg == null ? '—'
      : `${l.deltaKg > 0 ? '+' : ''}${l.deltaKg} kg`;
    const deltaColor = l.deltaKg == null ? 'var(--mut)'
      : l.deltaKg > 0 ? 'var(--ok, #3ddc84)' : l.deltaKg < 0 ? 'var(--danger, #ff5c7c)' : 'var(--mut)';
    const driftBadge = l.drift && l.drift.drifting
      ? ` <span style="color:var(--danger, #ff5c7c);font-size:10px">▼ drift</span>` : '';
    return `<tr>
      <td>${escapeHtml(liftName(l.exoId))}${driftBadge}</td>
      <td style="font-variant-numeric:tabular-nums">${l.end.mu.toFixed(1)} ±${l.end.sigma.toFixed(1)} kg</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:${deltaColor}">${delta}</td>
    </tr>`;
  }).join('');
  const corr = rev.tsbHrvCorr;
  return `
    <div class="card">
      <h2>📋 Bilan du bloc ${rev.blockIdx}${rev.completed ? '' : ' (en cours)'}</h2>
      <p class="mut" style="font-size:12px;margin:-4px 0 12px">
        ${rev.startDate} → ${rev.endDate} · cycle Issurin 6 sem · synthèse des modèles (Kalman, Banister, RP).
      </p>
      <div style="display:flex;gap:20px;align-items:baseline;flex-wrap:wrap">
        <div>
          <div class="stat">${rev.adherence.perWeek}</div>
          <div class="mut" style="font-size:11px">séances/sem (${rev.adherence.sessions} au total)</div>
        </div>
        <div>
          <div class="stat">${rev.banister.ctlDelta > 0 ? '+' : ''}${rev.banister.ctlDelta}</div>
          <div class="mut" style="font-size:11px">CTL (forme long terme) sur le bloc</div>
        </div>
        ${corr ? `
        <div>
          <div class="stat">${(corr.r > 0 ? '+' : '') + corr.r.toFixed(2)}</div>
          <div class="mut" style="font-size:11px">corrélation TSB↔HRV (${corr.n} j — Plews 2013)</div>
        </div>` : ''}
      </div>
      ${liftRows ? `
      <table style="width:100%;margin-top:12px;font-size:12px">
        <thead><tr class="mut"><th style="text-align:left">Key lift</th><th style="text-align:left">1RM estimé (90 % IC)</th><th style="text-align:right">Δ bloc</th></tr></thead>
        <tbody>${liftRows}</tbody>
      </table>` : ''}
      <p class="mut" style="font-size:11px;margin-top:12px">
        ${rev.next.action === 'deload' ? '⚠️' : rev.next.action === 'reduce-volume' ? '📉' : '✓'}
        ${escapeHtml(rev.next.why)}
      </p>
    </div>
  `;
}

function renderInsights() {
  const box = document.getElementById('insightsBody');
  if (!box || !window.Science) return;
  ensureBodyState();
  const Sci = window.Science;
  const cards = [];

  // --- 0. Bilan de fin de bloc (Issurin) — blockreview.js -----------
  // Ne doit JAMAIS casser les autres insights : try/catch défensif.
  if (S.macrocycle && window.BlockReview) {
    try {
      const rev = window.BlockReview.compute({
        history: S.history,
        physio: (S.body && S.body.physio) || [],
        macrocycle: S.macrocycle,
      });
      if (rev) cards.push(renderBlockReviewCard(rev));
    } catch (e) {
      console.warn('blockreview:', e);
    }
  }

  // --- 1. NEAT (Levine 2005) ----------------------------------------
  const neat = Sci.neatTrend(S.body.lifestyle);
  if (neat) {
    const arrow = neat.delta == null ? '' : (neat.delta > 0 ? '↑' : neat.delta < 0 ? '↓' : '→');
    const sign = neat.delta > 0 ? '+' : '';
    cards.push(`
      <div class="card">
        <h2>🚶 Activité quotidienne (NEAT)</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Levine 2005 — la dépense hors sport explique plus de variance dans le poids long terme que l'exercice lui-même.
        </p>
        <div style="display:flex;gap:20px;align-items:baseline">
          <div>
            <div class="stat">${neat.avg7.toLocaleString('fr-FR')}</div>
            <div class="mut" style="font-size:11px">pas/jour, moyenne 7j</div>
          </div>
          ${neat.delta != null ? `
            <div>
              <div style="font-size:18px;font-weight:600">${arrow} ${sign}${neat.delta.toLocaleString('fr-FR')}</div>
              <div class="mut" style="font-size:11px">vs semaine précédente</div>
            </div>
          ` : ''}
        </div>
        <p class="mut" style="font-size:11px;margin-top:10px">
          ${neat.avg7 < 5000 ? '🪑 Sédentaire — viser &gt;7500 pas/jour pour effet cardiovasculaire mesurable (Tudor-Locke 2011).'
            : neat.avg7 < 7500 ? '⚖️ Faiblement actif — viser &gt;7500 pas pour bénéfices santé.'
            : neat.avg7 < 10000 ? '✓ Actif — niveau santé général atteint.'
            : '🔥 Très actif — bénéfices maximaux.'}
        </p>
      </div>
    `);
  } else {
    cards.push(`
      <div class="card">
        <h2>🚶 Activité quotidienne (NEAT)</h2>
        <p class="mut">Logge tes pas quotidiens depuis la home pour voir le trend.</p>
      </div>
    `);
  }

  // --- 2. Caféine × sommeil (Drake 2013) ----------------------------
  const caf = Sci.caffeineSleepCorrelation(S.body.lifestyle, S.body.physio);
  cards.push(`
    <div class="card">
      <h2>☕ Caféine vs qualité du sommeil</h2>
      <p class="mut" style="font-size:12px;margin:-4px 0 12px">
        Drake 2013 — caféine &lt;6h avant coucher détériore objectivement la qualité du sommeil mesurée.
      </p>
      ${caf && caf.corr != null ? `
        <div style="display:flex;gap:20px;align-items:baseline">
          <div>
            <div class="stat">${(caf.corr > 0 ? '+' : '') + caf.corr.toFixed(2)}</div>
            <div class="mut" style="font-size:11px">corrélation Pearson</div>
          </div>
          <div>
            <div style="font-size:14px;font-weight:600">
              ${Math.abs(caf.corr) < 0.2 ? 'Pas d\'effet clair'
                : caf.corr > 0.4 ? 'Effet fort (plus tard = mieux dormi)'
                : caf.corr > 0 ? 'Effet modéré dans la direction attendue'
                : caf.corr < -0.4 ? '⚠️ Effet inverse fort — vérifier les inputs'
                : 'Léger effet inverse'}
            </div>
            <div class="mut" style="font-size:11px">${caf.n} paires café→sommeil</div>
          </div>
        </div>
        ${caf.n < 14 ? `
          <p class="mut" style="font-size:11px;margin-top:10px">
            🛈 ${caf.n} paires seulement — vise &gt;14 jours pour une corrélation fiable.
          </p>` : ''}
      ` : `
        <p class="mut">Logge ton dernier café + sommeil (Oura/manuel) pendant 2 semaines pour voir la corrélation.</p>
        ${caf ? `<p class="mut" style="font-size:11px">${caf.n}/14 paires collectées</p>` : ''}
      `}
    </div>
  `);

  // --- 3. Lumière matinale (Wright 2013) ----------------------------
  const ls = (S.body.lifestyle || []).filter(l =>
    l.morningLight != null && Date.parse(l.date) > Date.now() - 60 * 86400000
  );
  if (ls.length >= 7) {
    const lightDays = ls.filter(l => l.morningLight).length;
    const ratio = Math.round(lightDays / ls.length * 100);
    cards.push(`
      <div class="card">
        <h2>🌞 Lumière matinale</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Wright 2013 — 10 min de lumière vive avant 10h améliore l'alignement circadien et la qualité du sommeil le soir.
        </p>
        <div style="display:flex;gap:20px;align-items:baseline">
          <div>
            <div class="stat">${ratio}%</div>
            <div class="mut" style="font-size:11px">jours avec lumière (60 derniers)</div>
          </div>
          <div>
            <div style="font-size:14px;font-weight:600">
              ${ratio >= 70 ? '✓ Très régulier'
                : ratio >= 40 ? '⚖️ Irrégulier — viser &gt;70%'
                : '⚠️ Manque chronique de lumière du matin'}
            </div>
            <div class="mut" style="font-size:11px">${lightDays}/${ls.length} jours</div>
          </div>
        </div>
      </div>
    `);
  }

  // --- 4. Body weight trend (Hall 2011) -----------------------------
  if (S.body.weights && S.body.weights.length >= 3) {
    const t6 = Sci.bodyWeightTrend(S.body.weights, { weeks: 6 });
    const t12 = Sci.bodyWeightTrend(S.body.weights, { weeks: 12 });
    if (t6 || t12) {
      const row = (t, label) => t ? `
        <tr>
          <td>${label}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">
            ${t.slopeKgPerWeek > 0 ? '+' : ''}${t.slopeKgPerWeek} kg/sem
          </td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">
            ${t.kcalPerDay > 0 ? '+' : ''}${t.kcalPerDay} kcal/j
          </td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">R²=${t.r2}</td>
        </tr>` : '';
      cards.push(`
        <div class="card">
          <h2>⚖️ Trend poids (Hall 2011)</h2>
          <p class="mut" style="font-size:12px;margin:-4px 0 12px">
            Régression linéaire qui filtre le bruit eau/glycogène. 1 kg ≈ 7700 kcal.
          </p>
          <table style="width:100%;font-size:13px">
            <thead><tr style="color:var(--mut);text-align:left;font-size:11px">
              <th>Fenêtre</th><th style="text-align:right">Pente</th><th style="text-align:right">Bilan kcal</th><th style="text-align:right">Fit</th>
            </tr></thead>
            <tbody>${row(t6, '6 sem')}${row(t12, '12 sem')}</tbody>
          </table>
          ${t6 && t6.r2 < 0.3 ? `
            <p class="mut" style="font-size:11px;margin-top:10px">
              🛈 R² faible — beaucoup de variation jour-à-jour, le trend est encore incertain.
            </p>` : ''}
        </div>
      `);
    }
  }

  // --- 5. HRV (Plews 2013) -------------------------------------------
  const hrvR = S.body.physio && S.body.physio.length > 0
    ? Sci.hrvReadiness(S.body.physio) : null;
  if (hrvR) {
    const b = hrvR.baseline;
    cards.push(`
      <div class="card">
        <h2>💓 HRV — état autonomique</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Plews 2013 — RMSSD comparé à ta baseline 7j roulant. Plus sensible que l'absolu.
        </p>
        <div style="display:flex;gap:20px;align-items:baseline">
          <div>
            <div class="stat">${Math.round(b.latestRmssd)} ms</div>
            <div class="mut" style="font-size:11px">aujourd'hui</div>
          </div>
          <div>
            <div class="stat" style="opacity:.6">${Math.round(b.baselineRmssd)} ms</div>
            <div class="mut" style="font-size:11px">baseline 7j</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:600">z = ${hrvR.z}</div>
            <div class="mut" style="font-size:11px">${hrvR.label}</div>
          </div>
        </div>
        <p class="mut" style="font-size:11px;margin-top:10px">
          Variance individuelle (SD ln) : ${b.sd.toFixed(3)} sur ${b.nExt} jours.
          Chute &gt;0.5 SD = signal réduction de charge.
        </p>
      </div>
    `);
  }

  // --- 6. PVT historique (Dinges) ------------------------------------
  if (S.body.pvt && S.body.pvt.length >= 2) {
    const sorted = S.body.pvt.slice().sort((a, b) =>
      Date.parse(a.date) - Date.parse(b.date));
    const last = sorted[sorted.length - 1];
    const first = sorted[0];
    const meanTrend = last.meanMs - first.meanMs;
    const totalLapses = sorted.reduce((a, p) => a + (p.lapses || 0), 0);
    cards.push(`
      <div class="card">
        <h2>🧠 Vigilance (PVT)</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Dinges 1985 — temps de réaction et lapses (RT&gt;500ms) sur ${sorted.length} tests.
        </p>
        <div style="display:flex;gap:20px;align-items:baseline">
          <div>
            <div class="stat">${last.meanMs} ms</div>
            <div class="mut" style="font-size:11px">dernier RT moyen</div>
          </div>
          <div>
            <div style="font-size:16px;font-weight:600">
              ${meanTrend > 20 ? '↑' : meanTrend < -20 ? '↓' : '→'} ${meanTrend > 0 ? '+' : ''}${meanTrend} ms
            </div>
            <div class="mut" style="font-size:11px">vs premier test</div>
          </div>
          <div>
            <div class="stat">${last.lapses}</div>
            <div class="mut" style="font-size:11px">lapses dernier test</div>
          </div>
        </div>
        <p class="mut" style="font-size:11px;margin-top:10px">
          ${last.meanMs < 350 ? '✓ Vigilance excellente.'
            : last.meanMs < 500 ? 'Vigilance normale.'
            : last.lapses >= 3 ? '⚠️ Lapses fréquents — signe de fatigue cognitive (Basner 2011).'
            : 'Vigilance ralentie.'}
        </p>
      </div>
    `);
  }

  // --- 7. Adhérence intentions (Gollwitzer) --------------------------
  if (S.body.intentions && S.body.intentions.length > 0) {
    const cutoff = Date.now() - 30 * 86400000;
    const recent = S.body.intentions.filter(i => Date.parse(i.date) >= cutoff);
    const done = recent.filter(i => i.status === 'done').length;
    const missed = recent.filter(i => i.status === 'missed').length;
    const pending = recent.filter(i => i.status === 'pending').length;
    const closed = done + missed;
    const adherence = closed > 0 ? Math.round(done / closed * 100) : null;
    cards.push(`
      <div class="card">
        <h2>🎯 Adhérence aux intentions</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Gollwitzer 1999 — taux de "fait" sur les 30 derniers jours.
        </p>
        <div style="display:flex;gap:18px;align-items:baseline">
          <div>
            <div class="stat">${adherence != null ? adherence + '%' : '—'}</div>
            <div class="mut" style="font-size:11px">taux de succès</div>
          </div>
          <div style="font-size:13px;line-height:1.6">
            ✓ ${done} fait${done > 1 ? 's' : ''}<br>
            ✗ ${missed} manqué${missed > 1 ? 's' : ''}<br>
            ⏳ ${pending} en cours
          </div>
        </div>
      </div>
    `);
  }

  // --- 8. Asymétries (Bishop 2018) — vue détaillée ------------------
  const asyms = Sci.asymmetryReport(S.history, { weeks: 8, minReps: 4 });
  if (asyms.length > 0) {
    cards.push(`
      <div class="card">
        <h2>⚖️ Asymétries détaillées</h2>
        <p class="mut" style="font-size:12px;margin:-4px 0 12px">
          Bishop 2018 — agrégation 8 semaines. Cible &lt;5% pour réduire le risque blessure.
        </p>
        <table style="width:100%;font-size:13px">
          <thead><tr style="color:var(--mut);text-align:left;font-size:11px">
            <th>Exo</th><th>L</th><th>R</th>
            <th style="text-align:right">Écart</th><th>Statut</th>
          </tr></thead>
          <tbody>
            ${asyms.map(a => {
              const exo = EX_BY_ID[a.exoId];
              const name = exo ? exo.n : a.exoId;
              const sevColor = a.label === 'severe' ? 'var(--danger,#c0392b)'
                            : a.label === 'notable' ? 'var(--warning,#d68910)'
                            : 'var(--mut)';
              return `<tr>
                <td>${escapeHtml(name)}</td>
                <td style="font-variant-numeric:tabular-nums">${a.leftAvg}</td>
                <td style="font-variant-numeric:tabular-nums">${a.rightAvg}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;color:${sevColor}">${a.diffPct}%</td>
                <td style="color:${sevColor}">${a.label}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `);
  }

  // Etat vide
  if (cards.length === 0) {
    cards.push(`
      <div class="card">
        <p class="mut">Pas encore assez de données pour calculer les corrélations.</p>
        <p class="mut" style="font-size:12px">
          Reviens dans 1-2 semaines après avoir loggé Hooper, lifestyle, et fait quelques séances.
        </p>
      </div>
    `);
  }

  box.innerHTML = cards.join('');
}

function renderBadges() {
  const row = document.getElementById('badgesRow');
  if (!row) return;
  const badges = computeAchievements();
  row.innerHTML = badges.map(b => `
    <div class="badge ${b.earned ? 'earned' : ''}" title="${escapeHtml(b.sub)}">
      <div class="badge-icon">${b.icon}</div>
      <div class="badge-title">${escapeHtml(b.title)}</div>
      <div class="badge-sub">${escapeHtml(b.sub)}</div>
    </div>`).join('');
}

function renderMiniCharts() {
  const el = document.getElementById('miniCharts');
  if (!el) return;
  if (!S.history || S.history.length < 2) {
    el.innerHTML = '<p class="mut">Pas encore de données. Fais quelques séances.</p>';
    return;
  }
  const h = S.history;
  const forme = h.map(x => x.formAfter ?? x.formBefore ?? 70);
  const volume = h.map(x => (x.sets || []).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0));
  const reaction = h.map(x => x.aggReactionMs).filter(x => x != null);
  const mini = (label, vals, color, unit) => {
    if (vals.length < 2) return '';
    const last = vals[vals.length - 1];
    const first = vals[0];
    const trend = last > first ? '↑' : (last < first ? '↓' : '→');
    return `<div class="card-mini">
      <div class="mut" style="font-size:11px">${label}</div>
      <div class="row" style="align-items:baseline;gap:6px">
        <div class="stat">${last}${unit || ''}</div>
        <div class="mut" style="font-size:12px">${trend}</div>
      </div>
      ${sparkline(vals, { width: 220, height: 44, color })}
    </div>`;
  };
  el.innerHTML = `<div class="charts-grid">
    ${mini('Score de forme', forme, '#2d9b83', '')}
    ${mini('Volume (kg×reps)', volume, '#26408b', '')}
    ${mini('Réaction post-effort', reaction, '#e8954d', 'ms')}
  </div>`;
}

/* =================== WEEKLY VOLUME (sets per zone) ===================
 * Serious lifters care about weekly *sets* per muscle group, not kg×reps.
 * The literature consensus for hypertrophy is ~10-20 productive sets/week
 * per major muscle (under 10 = maintenance, over 20 = diminishing returns
 * for most people). We count every logged set whose exercise has the zone
 * in its `z` array — multi-joint exos (squat, SDT) count once per zone
 * they hit, which matches how coaches do MEV/MRV bookkeeping.
 *
 * Window: last 7 days rolling vs previous 7 days (for trend arrow).
 */
const VOLUME_ZONES = [
  { key: 'legs',      label: 'Jambes' },
  { key: 'chest',     label: 'Pectoraux' },
  { key: 'back',      label: 'Dos' },
  { key: 'shoulders', label: 'Épaules' },
  { key: 'arms',      label: 'Bras' },
  { key: 'core',      label: 'Gainage' },
];

function computeWeeklyVolume() {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const twoWeeksAgo = now - 14 * 24 * 3600 * 1000;
  const empty = () => ({ legs: 0, chest: 0, back: 0, shoulders: 0, arms: 0, core: 0 });
  const thisWeek = empty();
  const lastWeek = empty();
  for (const h of (S.history || [])) {
    const ts = new Date(h.date).getTime();
    if (isNaN(ts)) continue;
    if (ts < twoWeeksAgo) continue;
    const sets = Array.isArray(h.sets) ? h.sets : [];
    for (const s of sets) {
      const e = EX_BY_ID[s.exoId];
      if (!e) continue;
      // Only count a set as "productive" if it actually happened (reps>0 or
      // a timed hold with a duration). Skipped sets (reps=0 and no duration)
      // shouldn't pad the bar.
      const reps = +s.reps || 0;
      const dur = +s.durationSec || 0;
      if (reps <= 0 && dur <= 0) continue;
      const bucket = ts >= weekAgo ? thisWeek : lastWeek;
      for (const z of (e.z || [])) {
        bucket[z] = (bucket[z] || 0) + 1;
      }
    }
  }
  return { thisWeek, lastWeek };
}

function renderWeeklyVolume() {
  const el = document.getElementById('volumeList');
  if (!el) return;
  const { thisWeek, lastWeek } = computeWeeklyVolume();
  const totalThis = Object.values(thisWeek).reduce((a, b) => a + b, 0);
  if (totalThis === 0) {
    el.innerHTML = '<p class="mut">Pas encore de séries cette semaine. Fais une séance pour voir ton volume.</p>';
    return;
  }
  // Bar capped at 25 sets (past 20 = "over", showing overshoot visually).
  const CAP = 25;
  const rows = VOLUME_ZONES.map(z => {
    const count = thisWeek[z.key] || 0;
    const prev = lastWeek[z.key] || 0;
    const pct = Math.min(100, (count / CAP) * 100);
    let state = 'under';
    if (count >= 10 && count <= 20) state = 'ok';
    else if (count > 20) state = 'over';
    const delta = count - prev;
    let deltaHtml = '';
    if (delta !== 0) {
      const cls = delta > 0 ? 'up' : 'down';
      const sign = delta > 0 ? '+' : '';
      deltaHtml = `<span class="delta ${cls}">${sign}${delta} vs sem. préc.</span>`;
    }
    return `
      <div class="vol-row">
        <div class="vol-head">
          <span class="vol-name">${escapeHtml(z.label)}</span>
          <span class="vol-count"><strong>${count}</strong> séries${deltaHtml}</span>
        </div>
        <div class="vol-bar ${state}"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>`;
  }).join('');
  el.innerHTML = rows;
}

function labelFromScore(f) {
  if (f >= 80) return 'Excellent — on peut pousser.';
  if (f >= 65) return 'Bonne forme — progression contrôlée.';
  if (f >= 50) return 'Forme moyenne — on stabilise.';
  if (f >= 35) return 'Fatigue — séance plus légère.';
  return 'Très fatigué — deload / récup active.';
}

// Vrai si la dernière entrée d'historique date d'aujourd'hui (jour calendaire
// local). Sert à masquer la "prochaine séance" : juste après avoir fini, on
// préfère afficher un état de récup plutôt que de spoiler la séance suivante
// (qui sera générée au prochain réveil du planificateur).
function sessionDoneToday() {
  const h = S.history;
  if (!Array.isArray(h) || h.length === 0) return false;
  const last = h[h.length - 1];
  if (!last || !last.date) return false;
  // Comparaison sur date locale YYYY-MM-DD pour éviter les pièges TZ.
  const d = new Date(last.date);
  const todayISO = new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10) === todayISO;
}

// Pilote la bannière "séance d'aujourd'hui faite" et masque/réaffiche le
// bloc de preview de la prochaine séance. Idempotent.
function applyTodayDoneBanner() {
  const card = document.getElementById('nextSessionCard');
  if (!card) return;
  const banner = document.getElementById('todayDoneBanner');
  const preview = document.getElementById('nextSessionPreview');
  if (!banner || !preview) return;
  const showAnyway = card.dataset.showNextAnyway === '1';
  const done = sessionDoneToday();
  if (done && !showAnyway) {
    banner.classList.remove('hide');
    preview.classList.add('hide');
  } else {
    banner.classList.add('hide');
    preview.classList.remove('hide');
  }
}

// Bouton "Afficher quand même" — revient à l'affichage normal pour la
// session courante. La préférence n'est pas persistée : au prochain
// openHome, la bannière revient.
(function wireShowNextAnyway() {
  const btn = document.getElementById('showNextAnyway');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const card = document.getElementById('nextSessionCard');
    if (!card) return;
    card.dataset.showNextAnyway = '1';
    applyTodayDoneBanner();
  });
})();

function renderNext() {
  // Bandeau "fait aujourd'hui" en premier : si on cache la preview,
  // pas la peine de gaspiller du travail à remplir nextSessionBox.
  applyTodayDoneBanner();
  const s = S.currentSession;
  const box = document.getElementById('nextSessionBox');
  if (!s) { box.innerHTML = '<p class="mut">Pas encore de séance.</p>'; return; }
  const rows = s.exos.map((e, idx) => {
    const sw = supportsWeight(e.id);
    // Annotation 1 vs 2 haltères : ajoutée entre parenthèses si l'exo utilise
    // des haltères. "(×2 → 24 kg total)" pour les exos à 2 haltères avec poids
    // connu, juste "(haltère unique)" pour les exos à 1 haltère.
    let dbSuffix = '';
    if (sw && dbHandsFor(e.id) != null) {
      const h = dbHandsFor(e.id);
      if (h === 1) dbSuffix = ' (1 haltère)';
      else if (h === 2) dbSuffix = e.weight ? ` (×2 = ${e.weight * 2} kg total)` : ' (1 par main)';
    }
    const weightPart = (sw && e.weight) ? e.weight + 'kg' + dbSuffix + ' · ' : (sw ? '' : 'poids du corps · ');
    // Only surface the reason pill when it's actually meaningful:
    //  - weight exos: show progressive-overload hint
    //  - timed exos: show the tenue hint
    // Bodyweight / elastic / TRX / pull-up exos never show a charge-calibration hint.
    const showReason = e.reason && (e.timed || sw);
    const note = (S.notes && S.notes[e.id]) || '';
    // 1RM estimate — préfère le filtre bayésien (intervalle de confiance)
    // si dispo et avec assez de données, sinon retombe sur le best brut.
    let best = null, bestLow = null, bestHigh = null, bestBayes = false;
    if (sw) {
      if (window.Bayesian && S.history.length >= 4) {
        const st = ModelCache.kalmanState(e.id, { halfLifeDays: keyLiftHalfLifeFor() });
        if (st && st.n >= 3) {
          const ci = window.Bayesian.current1RM(st, 0.9);
          best = Math.round(ci.mu * 2) / 2;
          bestLow = Math.round(ci.low * 2) / 2;
          bestHigh = Math.round(ci.high * 2) / 2;
          bestBayes = true;
        }
      }
      if (best == null) best = best1RMFor(S.history, e.id);
    }
    const pctNow = (best && e.weight) ? Math.round((e.weight / best) * 100) : null;
    // Mode avancé (default) : "~98% de ton 1RM bayésien (98 kg, intervalle 95-101)"
    // Mode compact (opt-in)  : "~98% de ton 1RM (98 kg ± 3)"
    // Sémantique : advancedMode undefined ou true → avancé. false explicite → compact.
    const advanced = !S.profile || S.profile.advancedMode !== false;
    let oneRmHtml = '';
    if (best != null) {
      if (bestBayes && advanced) {
        oneRmHtml = `<div class="next-exo-1rm">~${pctNow}% de ton 1RM bayésien (${best}kg, intervalle ${bestLow}-${bestHigh})</div>`;
      } else if (bestBayes) {
        const margin = Math.round((bestHigh - best) * 2) / 2;
        oneRmHtml = `<div class="next-exo-1rm">~${pctNow}% de ton 1RM (${best}kg ± ${margin})</div>`;
      } else {
        oneRmHtml = `<div class="next-exo-1rm">~${pctNow}% de ton 1RM (${best}kg)</div>`;
      }
    }
    return `
    <div class="next-exo">
      <div style="flex:1;min-width:0">
        <div class="next-exo-name">
          <a href="#" class="lnk" data-exo="${escapeHtml(e.id)}">${escapeHtml(e.name)}</a>
          ${e.timed ? '<span class="pill">tenue</span>' : ''}
        </div>
        <div class="next-exo-meta">${e.sets}×${e.reps}${e.timed ? 's' : ''} · ${weightPart}repos ${e.rest}s</div>
        ${oneRmHtml}
        ${showReason ? `<div class="why">💡 ${escapeHtml(e.reason)}</div>` : ''}
        ${note ? `<div class="exo-note" data-exo="${escapeHtml(e.id)}">📝 ${escapeHtml(note)}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="next-exo-swap" data-idx="${idx}">🔄 Swap</button>
        <button class="next-exo-note" data-exo="${escapeHtml(e.id)}" data-name="${escapeHtml(e.name)}">📝 Note</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `<p class="mut" style="margin-top:0">${escapeHtml(s.title)}</p>${rows}
    <p class="mut mt8" style="font-size:12px">Clique sur un exo pour la technique, ou « Swap » pour remplacer.</p>`;
  box.querySelectorAll('a.lnk').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openExerciseDetail(a.dataset.exo, openHome);
    });
  });
  box.querySelectorAll('.next-exo-swap').forEach(btn => {
    btn.addEventListener('click', () => openSwapModal(+btn.dataset.idx));
  });
  box.querySelectorAll('.next-exo-note').forEach(btn => {
    btn.addEventListener('click', () => editExerciseNote(btn.dataset.exo, btn.dataset.name));
  });
  box.querySelectorAll('.exo-note').forEach(div => {
    div.addEventListener('click', () => {
      const eid = div.dataset.exo;
      const ex = (S.currentSession.exos || []).find(x => x.id === eid);
      editExerciseNote(eid, ex ? ex.name : eid);
    });
  });
}

// editExerciseNote — minimal prompt-based editor. We considered a modal but a
// 1-line form covers the common case (cue, weight memo). Empty input clears.
// Notes are capped at 200 chars to keep the next-exo card readable and to
// bound the JSON payload.
async function editExerciseNote(exoId, exoName) {
  if (!S.notes) S.notes = {};
  const before = S.notes[exoId] || '';
  const result = await openModal({
    title: `Note pour « ${escapeHtml(exoName)} »`,
    body: '<p>Vide la note pour la supprimer. Maximum 200 caractères.</p>',
    fields: [{
      name: 'note', label: 'Note', tag: 'textarea',
      value: before, required: false,
    }],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Enregistrer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const trimmed = (result.fields.note || '').trim().slice(0, 200);
  if (trimmed === '') delete S.notes[exoId];
  else S.notes[exoId] = trimmed;
  queueSave();
  renderNext();
}

function renderAdjustments() {
  const el = document.getElementById('adjustList');
  if (!S.adjustments || S.adjustments.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12h4l3-9 4 18 3-9h4"/>
          </svg>
        </div>
        <div class="empty-state-title">Pas encore d'ajustement</div>
        <div class="empty-state-msg">Tes ajustements apparaîtront ici après ta première séance — Coach adapte la suivante en fonction de ce que tu as ressenti.</div>
      </div>`;
    return;
  }
  el.innerHTML = S.adjustments.slice(-6).reverse()
    .map(a => `<p>• ${escapeHtml(a)}</p>`).join('');
}

document.getElementById('regenBtn').addEventListener('click', () => {
  S.currentSession = generateSession();
  queueSave();
  renderNext();
});

/* =================== TODAY-CONTEXT CHIPS (durée + gear + énergie) ===
 * Chips one-shot par jour : durée, lieu/gear, énergie déclarée.
 * Persisté en localStorage avec date-stamp — reset auto à minuit local.
 * Toute modif régénère immédiatement la séance pour refléter le contexte.
 * Pas envoyé au serveur (volontaire — c'est purement local au device). */

const TODAY_CTX_KEY = 'coach_today_ctx_v1';

// loadTodayCtx — applique sur S les overrides du jour stockés en localStorage.
// Si la date stockée n'est pas aujourd'hui, on ignore (et on nettoie).
function loadTodayCtx() {
  try {
    const raw = localStorage.getItem(TODAY_CTX_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) {
      localStorage.removeItem(TODAY_CTX_KEY);
      return;
    }
    if (data.duration !== undefined) S.todayDuration = data.duration;
    if (data.gear !== undefined)     S.todayGear     = data.gear;
    if (data.energy !== undefined)   S.todayEnergy   = data.energy;
  } catch (_) { /* localStorage indispo / data corrompue — on ignore */ }
}

// saveTodayCtx — flush en localStorage. Date-stampé pour expiration auto.
function saveTodayCtx() {
  try {
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      duration: S.todayDuration ?? null,
      gear: S.todayGear ?? null,
      energy: S.todayEnergy ?? null,
    };
    localStorage.setItem(TODAY_CTX_KEY, JSON.stringify(payload));
  } catch (_) { /* quota ou private mode — pas grave, juste pas de persistance */ }
}

// regenAndRender — regenère la séance et rafraîchit l'affichage. Appelée
// après chaque clic sur un chip de contexte.
function regenAndRender() {
  S.currentSession = generateSession();
  queueSave();
  renderNext();
}

// Helper générique pour wirer une rangée de chips où un seul est actif.
// onPick(value) reçoit la valeur du chip cliqué.
function wireSingleSelectChips(rowId, dataAttr, onPick) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      row.querySelectorAll('.chip').forEach(b => b.classList.remove('on'));
      c.classList.add('on');
      onPick(c.dataset[dataAttr]);
    });
  });
}

// Sync visuel : marque le chip correspondant à la valeur stockée.
function syncChipSelection(rowId, dataAttr, value) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.querySelectorAll('.chip').forEach(b => {
    b.classList.toggle('on', b.dataset[dataAttr] === value);
  });
}

// Wire les trois rangées + le bouton reset.
(function wireTodayContext() {
  loadTodayCtx();

  // Durée — 'auto' / '10' / '20' / '45' / '75' (string de l'attribut).
  wireSingleSelectChips('todayDuration', 'duration', (v) => {
    S.todayDuration = (v === 'auto') ? null : +v;
    saveTodayCtx();
    regenAndRender();
  });
  // Gear — 'default' / 'home' / 'travel' / 'light'.
  wireSingleSelectChips('gearToday', 'gear', (v) => {
    S.todayGear = (v === 'default') ? null : v;
    saveTodayCtx();
    regenAndRender();
  });
  // Énergie — 'low' / 'mid' / 'high'.
  wireSingleSelectChips('todayEnergy', 'energy', (v) => {
    S.todayEnergy = v;
    saveTodayCtx();
    regenAndRender();
  });

  // Bouton reset — efface les trois overrides + le localStorage.
  const reset = document.getElementById('todayResetBtn');
  if (reset) {
    reset.addEventListener('click', () => {
      S.todayDuration = null;
      S.todayGear = null;
      S.todayEnergy = null;
      try { localStorage.removeItem(TODAY_CTX_KEY); } catch (_) {}
      syncTodayChipsUI();
      regenAndRender();
    });
  }
  syncTodayChipsUI();
})();

// syncTodayChipsUI — met à jour visuellement les trois rangées d'après S.
function syncTodayChipsUI() {
  syncChipSelection('todayDuration', 'duration',
    (S.todayDuration === null || S.todayDuration === undefined) ? 'auto' : String(S.todayDuration));
  syncChipSelection('gearToday', 'gear', S.todayGear || 'default');
  syncChipSelection('todayEnergy', 'energy', S.todayEnergy || '');
}
document.getElementById('startBtn').addEventListener('click', () => openSession());
document.getElementById('guideBtn').addEventListener('click', () => openGuide());

/* =================== CALCULATRICE DE DISQUES ===================
 * Étant donné un poids cible, le poids de la barre, et un set de disques
 * disponibles, retourne la combinaison à charger PAR CÔTÉ. Algorithme
 * gourmand : on prend le plus gros disque qui rentre, on répète. Renvoie
 * { perSide: [...], total, gap } où gap est l'écart par rapport à la
 * cible (peut être négatif si on dépasse — ne devrait pas arriver avec
 * le greedy).
 */
const DEFAULT_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

function calcPlateLoad(targetKg, barKg, availableKg) {
  targetKg = Math.max(0, +targetKg || 0);
  barKg = Math.max(0, +barKg || 20);
  if (targetKg <= barKg) {
    return { perSide: [], total: barKg, gap: targetKg - barKg, barKg };
  }
  const perSideKg = (targetKg - barKg) / 2;
  // Trier descendant pour le greedy. On dédoublonne et on garde valides.
  const plates = (availableKg || DEFAULT_PLATES_KG)
    .map(p => +p).filter(p => p > 0).sort((a, b) => b - a);
  const out = [];
  let remaining = perSideKg;
  for (const p of plates) {
    while (remaining >= p - 0.001) {
      out.push(p);
      remaining -= p;
      // Garde-fou anti boucle infinie sur des disques trop gros.
      if (out.length > 20) break;
    }
    if (out.length > 20) break;
  }
  const loadedPerSide = out.reduce((s, p) => s + p, 0);
  return {
    perSide: out,
    total: barKg + 2 * loadedPerSide,
    gap: targetKg - (barKg + 2 * loadedPerSide),
    barKg,
  };
}

// openPlateCalc — ouvre une modale avec input poids cible, barre, et
// affichage live de la combinaison. Pré-rempli avec le poids du dernier
// exo en cours si dispo.
function openPlateCalc(prefillKg) {
  const initial = +prefillKg || (S.profile && S.profile.maxBarre / 2) || 60;
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="plateCalcT">
        <h2 id="plateCalcT" style="margin-top:0">⚙️ Calculatrice de disques</h2>
        <div class="field">
          <label for="plateTarget">Charge totale cible (kg)</label>
          <input type="number" id="plateTarget" min="0" step="2.5" value="${initial}">
        </div>
        <div class="field">
          <label for="plateBar">Poids de la barre (kg)</label>
          <input type="number" id="plateBar" min="0" step="0.5" value="20">
        </div>
        <div id="plateResult" style="background:var(--bg2);border:1px solid var(--line);
             border-radius:8px;padding:12px;margin-top:8px;font-size:14px"></div>
        <p class="mut" style="font-size:11px;margin-top:8px">
          Disques considérés : 25, 20, 15, 10, 5, 2,5, 1,25 kg.
          Le calcul est <em>par côté</em> : doublé pour le total chargé.
        </p>
        <div class="modal-actions">
          <button type="button" class="magenta" id="plateCalcClose">Fermer</button>
        </div>
      </div>`;
    function recalc() {
      const t = +back.querySelector('#plateTarget').value;
      const b = +back.querySelector('#plateBar').value;
      const r = calcPlateLoad(t, b);
      const result = back.querySelector('#plateResult');
      if (r.perSide.length === 0 && r.gap > 0) {
        result.innerHTML = `<strong>Cible ${t} kg trop légère.</strong> La barre seule pèse ${r.barKg} kg.`;
        return;
      }
      const breakdown = r.perSide.length > 0
        ? r.perSide.join(' + ') + ' kg'
        : 'aucun disque (barre seule)';
      const gapTxt = Math.abs(r.gap) < 0.01
        ? '<span style="color:var(--success,#5DD4A4)">✓ exactement</span>'
        : (r.gap > 0
            ? `<span style="color:var(--warn)">manque ${r.gap.toFixed(2)} kg</span>`
            : `<span style="color:var(--warn)">dépasse de ${(-r.gap).toFixed(2)} kg</span>`);
      result.innerHTML = `
        <div style="font-size:18px;margin-bottom:6px"><strong>${r.total} kg</strong> chargés &nbsp; ${gapTxt}</div>
        <div style="font-size:13px"><strong>Par côté :</strong> ${escapeHtml(breakdown)}</div>`;
    }
    function cleanup() {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(); }
    }
    document.body.appendChild(back);
    back.querySelector('#plateTarget').addEventListener('input', recalc);
    back.querySelector('#plateBar').addEventListener('input', recalc);
    back.querySelector('#plateCalcClose').addEventListener('click', () => { cleanup(); resolve(); });
    back.addEventListener('click', e => { if (e.target === back) { cleanup(); resolve(); } });
    document.addEventListener('keydown', onKey, true);
    recalc();
    back.querySelector('#plateTarget').focus();
    back.querySelector('#plateTarget').select();
  });
}

/* =================== SNACK WORKOUTS PICKER ===================
 * Ouvre une modale custom qui liste les snacks groupés par catégorie.
 * Click sur un snack → confirme s'il y a une séance en cours, puis
 * remplace currentSession par la version adaptée et lance directement
 * le viewer. Snacks vivent dans public/snacks.js (window.Snacks). */

function openSnackPicker() {
  if (!window.Snacks) {
    showToast('Snacks indisponibles', { variant: 'error', message: 'Module non chargé.' });
    return;
  }
  const cats = window.Snacks.CATEGORIES;
  const all = window.Snacks.SNACKS;
  const grouped = cats.map(cat => ({
    cat,
    items: all.filter(s => s.category === cat.id),
  })).filter(g => g.items.length > 0);

  const html = grouped.map(g => `
    <div style="margin-bottom:14px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);
                  margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--line)">
        ${escapeHtml(g.cat.label)}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${g.items.map(s => `
          <button type="button" class="snack-item" data-snack="${escapeHtml(s.id)}"
                  style="display:flex;align-items:center;gap:10px;padding:10px 12px;
                         background:var(--bg2);border:1px solid var(--line);border-radius:8px;
                         text-align:left;cursor:pointer;color:var(--fg);font:inherit;width:100%">
            <span style="flex:0 0 auto;background:var(--accent-tint,var(--bg));color:var(--accent);
                         padding:3px 8px;border-radius:6px;font-size:12px;font-weight:600">
              ${s.duration} min
            </span>
            <span style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:14px">${escapeHtml(s.name)}</div>
              <div style="font-size:12px;color:var(--mut);line-height:1.4">${escapeHtml(s.desc)}</div>
            </span>
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Modale custom — on intercepte les clicks sur les items pour résoudre
  // la promesse avec l'id du snack choisi (ou null si annulation).
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="snackPickTitle"
           style="max-height:80vh;display:flex;flex-direction:column">
        <h2 id="snackPickTitle" style="margin-top:0">🥪 Séance express</h2>
        <p class="mut" style="font-size:13px;margin:0 0 14px">
          Mini-routines de 4-15 min pour les fenêtres de temps imprévues.
          Pas trackées comme une séance complète — c'est juste pour bouger.
        </p>
        <div style="overflow-y:auto;flex:1;padding-right:4px">${html}</div>
        <div class="modal-actions" style="margin-top:10px">
          <button type="button" class="sec" id="snackCancel">Annuler</button>
        </div>
      </div>`;
    const trigger = document.activeElement;
    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (trigger && document.body.contains(trigger)) trigger.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }
    back.querySelector('#snackCancel').addEventListener('click', () => {
      cleanup(); resolve(null);
    });
    back.querySelectorAll('.snack-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.snack;
        cleanup();
        resolve(id);
      });
    });
    back.addEventListener('click', (e) => {
      if (e.target === back) { cleanup(); resolve(null); }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
  });
}

// launchSnack — workflow complet : ouvrir le picker → confirmer le remplacement
// d'une séance en cours → adapter le snack → assigner à currentSession →
// lancer le viewer. Le snack n'écrase pas le compteur PR (kind:'snack' fait
// office de marqueur).
async function launchSnack() {
  const id = await openSnackPicker();
  if (!id) return;
  if (S.currentSession && Array.isArray(S.currentSession.exos) && S.currentSession.exos.length > 0
      && (S.currentSession.sets || []).length > 0) {
    const ok = await openConfirm(
      'Remplacer la séance en cours ?',
      'Tu as déjà une séance entamée. La lancer en express l\'écrasera.',
      { confirmLabel: 'Lancer le snack', cancelLabel: 'Annuler' }
    );
    if (!ok) return;
  }
  const adapted = window.Snacks.adaptToSession(id);
  if (!adapted) {
    showToast('Erreur', { variant: 'error', message: 'Snack introuvable.' });
    return;
  }
  S.currentSession = adapted;
  queueSave();
  openSession();
}

const _snackBtn = document.getElementById('snackBtn');
if (_snackBtn) _snackBtn.addEventListener('click', launchSnack);

/* =================== LOG RÉTRO D'ACTIVITÉ HORS APP ===================
 * Pour les gens qui font du sport en dehors (cours collectif, course,
 * vélo, escalade, etc.) et veulent que ça compte dans la cible roulante
 * sans que ça pollue les PRs ou l'algo de progression.
 *
 * Stocké dans S.history avec kind:'external' et un type texte. Filtré
 * dans countPRs/detectPlateaus/computeStreak (déjà géré pour 'snack',
 * on ajoute 'external' aux exclusions).
 */
async function openExternalActivityLog() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await openModal({
    title: '📝 Activité hors app',
    body: `<p style="margin:0 0 8px;font-size:13px">
             Logge une séance ou une activité physique faite ailleurs.
             Ça comptera dans ta cible roulante mais n'impactera ni les PRs
             ni les ajustements automatiques.
           </p>`,
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: today, required: true },
      { name: 'kind', label: 'Type', type: 'text', placeholder: 'ex: course, yoga, foot, escalade', required: true },
      { name: 'duration', label: 'Durée (min)', type: 'number', placeholder: '60', required: true, inputmode: 'numeric' },
      { name: 'note', label: 'Note (facultatif)', type: 'text', placeholder: 'intensité, ressenti…' },
    ],
    buttons: [
      { label: 'Annuler', value: false },
      { label: 'Enregistrer', value: true, primary: true },
    ],
  });
  if (!result || result.value === false) return;
  const f = result.fields;
  const dateISO = f.date ? new Date(f.date).toISOString() : new Date().toISOString();
  const entry = {
    id: 'ext-' + Date.now(),
    date: dateISO,
    kind: 'external',
    externalKind: (f.kind || 'autre').slice(0, 60),
    durationMin: Math.max(1, +f.duration || 0),
    note: (f.note || '').slice(0, 280),
    sets: [],     // vide pour ne pas compter dans countPRs/volume
    rpe: null,
  };
  // Charge cardio réelle : si on a des données physio le MÊME jour (import
  // Strava / wearable), on attache kcal + FC moyenne à l'activité. Banister
  // sessionLoad les utilisera (TRIMP / kcal) au lieu du sRPE approximé.
  try {
    ensureBodyState();
    const day = dateISO.slice(0, 10);
    const phys = (S.body.physio || []).find(p => p && p.date === day);
    if (phys) {
      if (phys.activeEnergy > 0) entry.kcal = phys.activeEnergy;
      if (phys.avgHR > 0) entry.avgHR = phys.avgHR;
    }
  } catch (_) { /* enrichissement best-effort */ }
  S.history = Array.isArray(S.history) ? S.history.concat([entry]) : [entry];
  queueSave();
  showToast('Activité enregistrée', {
    variant: 'success',
    message: `${entry.externalKind} · ${entry.durationMin} min`,
  });
  // Refresh la home pour que le compteur cible se mette à jour.
  if (typeof openHome === 'function') openHome();
}

const _logExternalBtn = document.getElementById('logExternalBtn');
if (_logExternalBtn) _logExternalBtn.addEventListener('click', openExternalActivityLog);

const _plateCalcBtn = document.getElementById('plateCalcBtn');
if (_plateCalcBtn) {
  _plateCalcBtn.addEventListener('click', () => {
    // Pré-remplit avec le poids du premier exo chargé de la séance courante
    // s'il y en a un — réduit le tap pour le cas le plus courant.
    let prefill = null;
    const cs = S.currentSession;
    if (cs && Array.isArray(cs.exos)) {
      const w = cs.exos.find(e => e.weight && e.weight > 0);
      if (w) prefill = w.weight;
    }
    openPlateCalc(prefill);
  });
}

// Session mode toggle (straight / circuit).
function applyModeToggle() {
  const mode = (S.profile && S.profile.sessionMode === 'circuit') ? 'circuit' : 'straight';
  document.querySelectorAll('#modeToggle button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  const desc = document.getElementById('modeDesc');
  if (desc) {
    desc.textContent = mode === 'circuit'
      ? 'Une série de chaque exo à tour de rôle, puis on recommence.'
      : "Toutes les séries d'un exo avant de passer au suivant.";
  }
}
document.querySelectorAll('#modeToggle button').forEach(b => {
  b.addEventListener('click', () => {
    if (!S.profile) return;
    S.profile.sessionMode = b.dataset.mode;
    queueSave();
    applyModeToggle();
  });
});

/* =================== EXERCISE GUIDE =================== */
function openGuide() {
  show('viewGuide');
  const body = document.getElementById('guideBody');
  // Group by primary zone for easier browsing.
  const zoneLabels = {
    legs:'Jambes', chest:'Pectoraux', back:'Dos',
    shoulders:'Épaules', arms:'Bras', core:'Gainage / abdos',
  };
  const byZone = {};
  for (const e of EX) {
    const z = e.z[0];
    (byZone[z] ||= []).push(e);
  }
  const order = ['legs','chest','back','shoulders','arms','core'];
  body.innerHTML = order.filter(z => byZone[z]).map(z => {
    const list = byZone[z].map(e => {
      const illus = renderExoIllustration(e.id);
      return `
      <button type="button" class="exo-row" data-exo="${escapeHtml(e.id)}">
        ${illus ? `<div class="exo-illus" aria-hidden="true">${illus}</div>` : ''}
        <div class="exo-row-text">
          <div class="exo-name">${escapeHtml(e.n)}</div>
          <div class="mut" style="font-size:12px">${escapeHtml(e.desc)}</div>
        </div>
        <div class="exo-arrow" aria-hidden="true">›</div>
      </button>`;
    }).join('');
    return `<div class="card"><h2>${escapeHtml(zoneLabels[z] || z)}</h2>${list}</div>`;
  }).join('');
  body.querySelectorAll('.exo-row').forEach(row => {
    row.addEventListener('click', () => openExerciseDetail(row.dataset.exo, openGuide));
  });
}

// Where "← Retour" from the exercise detail should land. Set by caller.
let exoDetailReturn = null;
function openExerciseDetail(exoId, returnFn) {
  // Branche rééduc : exos préfixés par "reh-" vivent dans window.Rehab,
  // pas dans EX_BY_ID. On affiche un détail focalisé sur la technique,
  // les points-clés et le signal d'arrêt — pas d'historique de charge
  // (les exos rééduc ne tracent pas de PR).
  if (typeof exoId === 'string' && exoId.indexOf('reh-') === 0
      && window.Rehab && window.Rehab.EXERCISE_BY_ID) {
    const re = window.Rehab.EXERCISE_BY_ID[exoId];
    if (!re) return;
    exoDetailReturn = returnFn || openHome;
    show('viewExerciseDetail');
    const box = document.getElementById('exoDetailBody');
    const zone = (window.Rehab.ZONES.find(z => z.id === re.zone) || {}).label || re.zone;
    const phasesLabels = re.phases.map(pid =>
      (window.Rehab.PHASES.find(p => p.id === pid) || {}).label || pid).join(', ');
    box.innerHTML = `
      <h2 style="margin-top:0">${escapeHtml(re.n)}</h2>
      <p style="margin:0 0 8px">
        <span class="pill">🩹 ${escapeHtml(zone)}</span>
        <span class="pill">${escapeHtml(re.kind)}</span>
        <span class="pill">phases : ${escapeHtml(phasesLabels)}</span>
      </p>
      <p class="mut" style="font-size:13px;margin-top:0"><strong>Dose recommandée :</strong>
         ${escapeHtml(re.dose)} · matériel : ${escapeHtml(re.gear)}.</p>
      <h3 style="margin-top:18px">Comment</h3>
      <p>${escapeHtml(re.how)}</p>
      <h3>Points-clés</h3>
      <ul>${(re.cues || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
      <div style="background:var(--danger-tint,var(--bg2));border-left:3px solid var(--danger,var(--accent));
                  padding:10px 12px;border-radius:6px;margin-top:14px;font-size:14px">
        <strong>⚠️ Signal d'arrêt&nbsp;:</strong> ${escapeHtml(re.caution)}
      </div>`;
    return;
  }
  const e = EX_BY_ID[exoId];
  if (!e) return;
  exoDetailReturn = returnFn || openHome;
  show('viewExerciseDetail');
  const box = document.getElementById('exoDetailBody');

  // PR & progression history for this exo.
  const sets = [];
  for (const h of S.history) {
    for (const s of (h.sets || [])) {
      if (s.exoId === exoId) sets.push({...s, date: h.date, rpe: h.rpe});
    }
  }
  const prWeight = sets.reduce((m,s) => (s.weight && s.weight > (m?.weight||0)) ? s : m, null);
  const volumes = [];
  const byDate = {};
  for (const s of sets) {
    const d = s.date.slice(0,10);
    byDate[d] = (byDate[d] || 0) + ((s.weight || 0) * (s.reps || 0));
  }
  const dates = Object.keys(byDate).sort();
  dates.forEach(d => volumes.push(byDate[d]));

  const zoneLabels = {
    legs:'Jambes', chest:'Pectoraux', back:'Dos',
    shoulders:'Épaules', arms:'Bras', core:'Gainage / abdos',
  };
  const zoneTags = e.z.map(z => `<span class="pill">${escapeHtml(zoneLabels[z] || z)}</span>`).join(' ');
  const tipsList = e.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('');

  const historySection = sets.length === 0
    ? '<p class="mut">Pas encore fait cet exercice.</p>'
    : `<div class="row" style="gap:20px;flex-wrap:wrap">
         <div><div class="mut" style="font-size:11px">Séries totales</div><div class="stat">${sets.length}</div></div>
         <div><div class="mut" style="font-size:11px">Record poids</div><div class="stat">${prWeight ? prWeight.weight + 'kg × ' + prWeight.reps : '—'}</div></div>
         <div><div class="mut" style="font-size:11px">Dernière séance</div><div class="stat" style="font-size:14px">${escapeHtml(new Date(sets[sets.length-1].date).toLocaleDateString())}</div></div>
       </div>
       ${volumes.length >= 2 ? `<div class="mt10"><div class="mut" style="font-size:11px">Volume (charge × reps) par séance</div>${sparkline(volumes, {width:300, height:60, color:'#26408b'})}</div>` : ''}`;

  const heroIllus = renderExoIllustration(exoId);
  box.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(e.n)} ${e.timed ? '<span class="pill warn">tenue</span>' : ''}</h2>
      <div>${zoneTags}</div>
      ${heroIllus ? `<div class="exo-hero-illus mt10">${heroIllus}</div>` : ''}
      <p class="mut mt8">${escapeHtml(e.desc)}</p>
    </div>
    <div class="card">
      <h2>Comment bien le faire</h2>
      <p>${escapeHtml(e.how)}</p>
    </div>
    ${renderVideoCard(e)}
    <div class="card">
      <h2>Points clés</h2>
      <ul class="tip-list">${tipsList}</ul>
    </div>
    <div class="card">
      <h2>Ta progression</h2>
      ${historySection}
    </div>`;
  // Wire le placeholder YouTube après injection du HTML — handler one-shot
  // qui transforme le placeholder en iframe live au clic explicite.
  activateYouTubePlaceholder();
}

// Le guide s'ouvre depuis l'onglet Coach (refonte mobile) — le retour y revient.
document.getElementById('guideBackBtn').addEventListener('click', () => openCoach());
document.getElementById('exoBackBtn').addEventListener('click', () => {
  const fn = exoDetailReturn || openHome;
  exoDetailReturn = null;
  fn();
});

/* =================== SESSION =================== */
let live = null;

// Build the logging order. "straight" = all sets of exo1, then exo2...
// "circuit" = set 1 of every exo, then set 2 of every exo...
function buildOrder(session, mode) {
  const order = [];
  if (mode === 'circuit') {
    const maxSets = Math.max(...session.exos.map(e => e.sets));
    for (let s = 0; s < maxSets; s++) {
      for (let i = 0; i < session.exos.length; i++) {
        if (s < session.exos[i].sets) order.push({ exoIdx: i, setIdx: s });
      }
    }
  } else {
    session.exos.forEach((e, i) => {
      for (let s = 0; s < e.sets; s++) order.push({ exoIdx: i, setIdx: s });
    });
  }
  return order;
}

// Find the first tuple in live.order whose set hasn't been logged.
function currentTuple() {
  if (!live) return null;
  for (const t of live.order) {
    if (!live.sets.find(x => x.exoIdx === t.exoIdx && x.setIdx === t.setIdx)) return t;
  }
  return null;
}

function openSession() {
  if (!S.profile) { openOnboarding(); return; }
  if (!S.currentSession) { S.currentSession = generateSession(); queueSave(); }
  const mode = (S.profile && S.profile.sessionMode === 'circuit') ? 'circuit' : 'straight';
  live = { s: S.currentSession, mode, order: buildOrder(S.currentSession, mode), sets: [] };
  show('viewSession');
  renderSession();
}

function renderSession() {
  const s = live.s;
  const totalSets = s.exos.reduce((a, e) => a + e.sets, 0);
  const done = live.sets.length;
  const modeTag = live.mode === 'circuit' ? ' · Circuit' : '';

  document.getElementById('sessTitle').textContent = s.title + modeTag;
  document.getElementById('sessMeta').textContent =
    `${done}/${totalSets} séries · ${s.exos.length} exos${live.mode === 'circuit' ? ' · une série par exo, tour par tour' : ' · toutes les séries avant de passer'}`;
  document.getElementById('sessBar').style.width = Math.round(done * 100 / totalSets) + '%';

  const body = document.getElementById('sessBody');
  body.innerHTML = '';

  const t = currentTuple();
  if (t) {
    const e = s.exos[t.exoIdx];
    const lib = EX_BY_ID[e.id];
    const setNum = t.setIdx + 1;
    const showWeight = !e.timed && supportsWeight(e.id);
    // Unilatéral : on demande le côté travaillé. Default = alterne G/D
    // selon la parité de la série (1=G, 2=D, 3=G, ...), pour qu'au bout de
    // 4 séries chaque côté ait été fait 2× sans configuration manuelle.
    // L'utilisateur peut surcharger via les chips.
    const isUni = !!(lib && lib.unilateral);
    const defaultSide = (t.setIdx % 2 === 0) ? 'L' : 'R';

    const card = document.createElement('div');
    card.className = 'focus-card';
    const logOverallIdx = live.sets.length + 1;
    card.innerHTML = `
      <div class="focus-exo-label">SÉRIE ${logOverallIdx}/${totalSets} · Exo ${t.exoIdx + 1}/${s.exos.length}</div>
      <h2>
        <span>${escapeHtml(e.name)}${e.timed ? ' <span class="pill" style="vertical-align:middle">tenue</span>' : ''}${isUni ? ' <span class="pill" style="vertical-align:middle">unilatéral</span>' : ''}</span>
        <button class="info-btn" id="focusInfo">ℹ</button>
      </h2>
      ${lib ? `<div class="focus-exo-desc">${escapeHtml(lib.desc)}</div>` : ''}
      ${(S.notes && S.notes[e.id]) ? `<div class="focus-note">📝 ${escapeHtml(S.notes[e.id])}</div>` : ''}
      ${(t.setIdx === 0 && !e.timed && supportsWeight(e.id))
        ? renderWarmupHint(warmupSets(e.id, e.weight))
        : ''}
      <div class="focus-target">
        ${e.timed
          ? `Tiens ${e.reps}s · série ${setNum}/${e.sets}`
          : `${e.reps} reps${showWeight && e.weight ? ' @ ' + e.weight + 'kg' : ''} · série ${setNum}/${e.sets}`}
      </div>
      ${showWeight && dumbbellNote(e.id) ? `
        <div class="focus-target-sub mut" style="font-size:12px;text-align:center;margin-top:-4px">
          ${escapeHtml(dumbbellNote(e.id))}${dbHandsFor(e.id) === 2 && e.weight ? ` · total ${(e.weight * 2)} kg` : ''}
        </div>
      ` : ''}
      ${isUni ? `
        <!-- Sélecteur de côté pour les exos unilatéraux. Le côté est
             persisté dans le set record (side: 'L'|'R'|'B'), ce qui permet
             d'afficher après coup les déséquilibres G/D dans le bilan. -->
        <div class="focus-input" style="margin-top:6px">
          <label>Côté travaillé</label>
          <div class="chip-row" id="focusSideRow" role="radiogroup" aria-label="Côté">
            <button type="button" class="chip${defaultSide === 'L' ? ' on' : ''}" data-side="L" role="radio" aria-checked="${defaultSide === 'L'}">Gauche</button>
            <button type="button" class="chip${defaultSide === 'R' ? ' on' : ''}" data-side="R" role="radio" aria-checked="${defaultSide === 'R'}">Droite</button>
            <button type="button" class="chip" data-side="B" role="radio" aria-checked="false">2 côtés</button>
          </div>
        </div>
      ` : ''}
      ${e.timed ? '' : `
        <div class="focus-inputs ${showWeight ? '' : 'single'}">
          <div class="focus-input">
            <label for="focusReps">Reps réalisées</label>
            <div class="stepper">
              <button type="button" class="step-btn" data-step="-1" data-target="focusReps" aria-label="Diminuer les reps">−</button>
              <input type="number" inputmode="numeric" id="focusReps" value="${e.reps}" min="0" max="999">
              <button type="button" class="step-btn" data-step="1" data-target="focusReps" aria-label="Augmenter les reps">+</button>
            </div>
          </div>
          ${showWeight ? `
            <div class="focus-input">
              <label for="focusWeight">Charge (kg)</label>
              <div class="stepper">
                <button type="button" class="step-btn" data-step="-2.5" data-target="focusWeight" aria-label="Diminuer de 2.5 kg">−</button>
                <input type="number" inputmode="decimal" step="0.5" id="focusWeight" value="${e.weight ?? ''}" min="0">
                <button type="button" class="step-btn" data-step="2.5" data-target="focusWeight" aria-label="Augmenter de 2.5 kg">+</button>
              </div>
            </div>
          ` : ''}
        </div>
      `}
      <button class="focus-go" id="focusGo">${e.timed ? '▶ Go — démarre la tenue' : '✓ OK — enchaîner'}</button>
      <div class="mut" style="color:rgba(255,255,255,0.8);font-size:11px;text-align:center;margin-top:8px">
        Repos ${e.rest}s · test réaction + tap après chaque série
      </div>`;
    body.appendChild(card);
    card.querySelector('#focusInfo').addEventListener('click', () => {
      // Return to session when back is pressed.
      openExerciseDetail(e.id, () => { show('viewSession'); renderSession(); });
    });
    // Wire le sélecteur de côté (chips mutuellement exclusifs).
    const sideRow = card.querySelector('#focusSideRow');
    if (sideRow) {
      sideRow.querySelectorAll('.chip').forEach(c => {
        c.addEventListener('click', () => {
          sideRow.querySelectorAll('.chip').forEach(b => {
            b.classList.remove('on');
            b.setAttribute('aria-checked', 'false');
          });
          c.classList.add('on');
          c.setAttribute('aria-checked', 'true');
        });
      });
    }
    card.querySelector('#focusGo').addEventListener('click', () => logSet(t.exoIdx, t.setIdx));
  }

  // Progression compacte (refonte mobile) : bandeau horizontal scrollable
  // de chips au lieu d'une carte verticale — le bouton valider reste en
  // zone pouce sans scroller, et l'état des autres exos reste visible
  // d'un coup d'œil.
  const prog = document.createElement('div');
  prog.className = 'prog-strip';
  prog.setAttribute('aria-label', 'Progression des exercices');
  prog.innerHTML = s.exos.map((e, i) => {
    const logged = live.sets.filter(x => x.exoIdx === i).length;
    const cls = logged === e.sets ? 'done' : (t && i === t.exoIdx ? 'current' : '');
    const icon = logged === e.sets ? '✓' : (t && i === t.exoIdx ? '▸' : '');
    return `<span class="prog-chip ${cls}">${icon ? icon + ' ' : ''}${escapeHtml(e.name)} <b>${logged}/${e.sets}</b></span>`;
  }).join('');
  body.appendChild(prog);

  const allDone = (live.sets.length === totalSets);
  document.getElementById('sessEndBox').classList.toggle('hide', !allDone);
  if (allDone) {
    const trainedZones = new Set();
    // zoneSets : compte le volume réel par zone (en séries). Un exo qui
    // touche plusieurs zones (ex: SDT = back+legs) crédite chaque zone du
    // nombre de séries — c'est volontairement généreux, on veut que la zone
    // soit comptée comme travaillée, pas mesurer une "vraie" charge isolée.
    const zoneSets = {};
    for (const ex of s.exos) {
      const lib = EX_BY_ID[ex.id];
      for (const z of (lib && lib.z) || []) {
        trainedZones.add(z);
        zoneSets[z] = (zoneSets[z] || 0) + (ex.sets || 0);
      }
    }
    // Vrai programme d'étirements : durées en secondes, côté G/D, etc.
    // On stocke aussi le plan en mémoire (window._stretchPlan) pour que le
    // handler du bouton "Lancer" puisse y accéder sans recalculer.
    const plan = buildStretchProgram(Array.from(trainedZones), { zoneSets });
    window._stretchPlan = plan;
    const cd = document.getElementById('cooldownBox');
    if (cd) {
      if (plan.length === 0) {
        cd.innerHTML = '';
      } else {
        // Durée totale estimée pour cadrer l'attente utilisateur.
        const totalSec = plan.reduce((a, it) => a + (it.perSide ? it.dur * 2 : it.dur), 0);
        const mins = Math.round(totalSec / 60);
        const items = plan.map(s2 => {
          const durStr = s2.perSide ? `${s2.dur}s × 2 côtés` : `${s2.dur}s`;
          return `<li>
            <div class="cooldown-name"><strong>${escapeHtml(s2.name)}</strong> <span class="mut">— ${durStr}</span></div>
            <div class="cooldown-cue mut" style="font-size:12px">${escapeHtml(s2.cue)}</div>
          </li>`;
        }).join('');
        cd.innerHTML = `
          <p class="mut" style="font-size:12px;text-align:center;margin:0 0 8px">
            🧘 Programme d'étirement guidé · ~${mins} min · ${plan.length} postures
          </p>
          <ul class="cooldown-list">${items}</ul>
          <button id="startStretchBtn" class="ok w-full" style="margin-top:10px">
            ▶ Lancer le programme guidé
          </button>
          <p class="mut" style="font-size:11px;text-align:center;margin:6px 0 0">
            Chaque posture est chronométrée — change de côté quand l'app le demande.
          </p>`;
        // Wire le bouton. Au clic : runStretchProgram → retour à viewSession.
        const startBtn = document.getElementById('startStretchBtn');
        if (startBtn) {
          startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = '… en cours';
            try {
              await runStretchProgram(window._stretchPlan || []);
            } catch (_) {}
            // Retour à viewSession ; on marque le programme comme fait
            // pour éventuellement changer le texte du bouton.
            show('viewSession');
            const b = document.getElementById('startStretchBtn');
            if (b) {
              b.disabled = false;
              b.textContent = '✓ Refaire le programme';
              b.classList.remove('ok');
              b.classList.add('sec');
            }
          };
        }
      }
    }
  }
}

/* =================== PROGRAMME D'ÉTIREMENT POST-SÉANCE ===================
 *
 * v2 — vrai programme guidé (avant : simple liste de texte).
 *
 * Format de la librairie : par zone musculaire, une liste d'étirements
 * statiques avec :
 *   - name     : libellé court affiché en gros pendant le décompte
 *   - cue      : 1-2 phrases sur la position (placement, sensation à viser)
 *   - dur      : durée en secondes par côté (ou totale si bilateral)
 *   - perSide  : true → on enchaîne automatiquement gauche puis droite,
 *                false (défaut) → posture bilatérale, durée unique
 *
 * Pourquoi des durées en secondes (pas "30s/jambe" en string) ? Parce que
 * le runStretchProgram(list) chronomètre vraiment chaque posture — l'app
 * te dit "Tiens 40s côté gauche" et bipe quand c'est fini, puis enchaîne.
 * Ça remplace la liste passive précédente que personne ne suivait. */

// Chaque entrée porte aussi un champ optionnel `targets` : sous-muscles
// précis visés. Sert au moteur de sélection pour panacher dans une zone
// large (ex: legs = quads + ischios + mollets + adducteurs + glutes), au
// lieu d'empiler 3 stretches qui touchent le même muscle.
const STRETCH_LIB = {
  legs: [
    {
      name: 'Étirement quadriceps debout',
      cue: 'Debout, attrape un pied et tire-le vers la fesse, genoux côte à côte. Pousse les hanches en avant, contracte les fessiers. Tu dois sentir l\'avant de la cuisse.',
      dur: 35, perSide: true, targets: ['quads'],
    },
    {
      name: 'Couch stretch (canapé)',
      cue: 'Genou arrière au sol contre un mur (ou un canapé), tibia vertical. Genou avant à 90°, buste droit. Sens l\'étirement profond quadriceps + psoas de la jambe arrière. Tiens, change.',
      dur: 45, perSide: true, targets: ['quads', 'hipflex'],
    },
    {
      name: 'Pigeon allongé (figure 4)',
      cue: 'Allongé sur le dos, cheville d\'une jambe posée sur le genou opposé. Attrape l\'arrière de la cuisse au sol et tire vers la poitrine. Sensation dans la fesse / hanche.',
      dur: 45, perSide: true, targets: ['glutes'],
    },
    {
      name: 'Pigeon au sol',
      cue: 'Genou avant plié sur le côté (tibia perpendiculaire), jambe arrière tendue loin derrière. Buste vers l\'avant sur les coudes, respire profond. Stretch fessier + hanche externe.',
      dur: 50, perSide: true, targets: ['glutes'],
    },
    {
      name: 'Étirement ischios assis',
      cue: 'Assis, une jambe tendue devant toi, l\'autre pliée. Penche-toi vers la jambe tendue en gardant le dos droit, attrape le pied (ou le tibia). Sens l\'arrière de la cuisse.',
      dur: 40, perSide: true, targets: ['hamstrings'],
    },
    {
      name: 'Étirement ischios debout sangle',
      cue: 'Allongé sur le dos, jambe tendue vers le plafond, sangle (ou ceinture) sous la plante du pied. Tire doucement la jambe vers toi en gardant le genou tendu. Sens l\'arrière de la cuisse.',
      dur: 35, perSide: true, targets: ['hamstrings'],
    },
    {
      name: 'Étirement mollet contre mur',
      cue: 'Mains au mur, une jambe en avant pliée, l\'autre tendue loin derrière, talon AU SOL. Avance le bassin contre le mur. Tu dois sentir le mollet de la jambe arrière.',
      dur: 30, perSide: true, targets: ['calves'],
    },
    {
      name: 'Étirement soléaire (genou plié)',
      cue: 'Même position que mollet contre mur, mais cette fois plie le genou de la jambe arrière en gardant le talon au sol. Cible le soléaire (mollet profond) au lieu du gastrocnémien.',
      dur: 25, perSide: true, targets: ['calves'],
    },
    {
      name: 'Papillon (adducteurs)',
      cue: 'Assis, plantes des pieds collées, genoux ouverts. Tiens les chevilles, dos droit, penche-toi doucement vers l\'avant. Sens l\'intérieur des cuisses.',
      dur: 50, targets: ['adductors'],
    },
    {
      name: 'Frog stretch (grenouille)',
      cue: 'À quatre pattes, écarte progressivement les genoux le plus large possible, tibias dans l\'alignement. Pousse les hanches doucement vers l\'arrière. Adducteurs profonds.',
      dur: 45, targets: ['adductors'],
    },
  ],
  back: [
    {
      name: 'Cat-cow',
      cue: 'À quatre pattes, mains sous les épaules, genoux sous les hanches. Alterne lentement dos rond (expire) et dos creux (inspire). Respire profondément à chaque cycle.',
      dur: 60, targets: ['spine'],
    },
    {
      name: 'Twist allongé 90/90',
      cue: 'Allongé sur le dos, bras en croix. Genoux pliés, laisse-les tomber d\'un côté en gardant les épaules au sol. Regarde de l\'autre côté.',
      dur: 35, perSide: true, targets: ['spine', 'obliques'],
    },
    {
      name: 'Child\'s pose étendue',
      cue: 'À genoux, fesses sur les talons, genoux écartés. Bras tendus loin devant, front au sol. Respire dans le bas du dos.',
      dur: 60, targets: ['lats', 'lower-back'],
    },
    {
      name: 'Lat stretch à 4 pattes',
      cue: 'À quatre pattes, mains posées sur un meuble bas (banc, canapé) devant toi. Recule les fesses vers les talons, bras tendus. Tu dois sentir un grand étirement le long des lats et des aisselles.',
      dur: 40, perSide: true, targets: ['lats'],
    },
    {
      name: 'Suspension passive',
      cue: 'À une barre, prise pronation, bras tendus, pieds qui frôlent le sol. Relâche complètement les épaules, laisse pendre. Décompression vertébrale.',
      dur: 25, targets: ['lats', 'spine'],
    },
    {
      name: 'Thread the needle',
      cue: 'À quatre pattes, glisse un bras sous l\'autre, joue et épaule au sol. Garde les hanches au-dessus des genoux. Twist thoracique profond. Change de côté.',
      dur: 30, perSide: true, targets: ['spine', 'rear-delts'],
    },
    {
      name: 'Étirement lombaire knees-to-chest',
      cue: 'Allongé sur le dos, ramène les deux genoux contre la poitrine, bras autour des tibias. Berce doucement gauche-droite. Décompression lombaire.',
      dur: 40, targets: ['lower-back'],
    },
  ],
  chest: [
    {
      name: 'Doorway stretch (chambranle)',
      cue: 'Avant-bras contre le chambranle d\'une porte, coude à 90°. Avance un pied dans le passage et tourne légèrement le buste à l\'opposé. Sens l\'ouverture du pec.',
      dur: 35, perSide: true, targets: ['pec'],
    },
    {
      name: 'Étirement pec couché bras en T',
      cue: 'Allongé sur le ventre, bras en croix paume au sol. Pousse sur ton autre main pour rouler doucement sur le côté du bras tendu. Pec ouvert profond.',
      dur: 40, perSide: true, targets: ['pec'],
    },
    {
      name: 'Pec stretch coin (haut + bas)',
      cue: 'Face à un angle de mur. Pose les deux avant-bras sur les deux murs, coudes à hauteur d\'épaule. Avance un pied dans l\'angle pour creuser. Pour cibler le pec haut, baisse les coudes ; pour le pec bas, monte-les.',
      dur: 40, targets: ['pec'],
    },
    {
      name: 'Bras en candélabre allongé',
      cue: 'Allongé sur le dos, bras en candélabre (coudes à 90°, dos des mains au sol au-dessus de la tête). Laisse la gravité ouvrir poitrine + avant-épaule. Respire lentement.',
      dur: 50, targets: ['pec', 'anterior-delt'],
    },
  ],
  shoulders: [
    {
      name: 'Cross-body épaule',
      cue: 'Debout, tire un bras tendu devant la poitrine vers l\'épaule opposée, accroche-le avec l\'autre main au coude. Sens l\'arrière de l\'épaule s\'ouvrir.',
      dur: 30, perSide: true, targets: ['rear-delts'],
    },
    {
      name: 'Sleeper stretch (rotateurs)',
      cue: 'Allongé sur le côté, bras du dessous à 90° vers l\'avant. Avec l\'autre main, pousse doucement la main du bras au sol vers le bas. Stretch profond rotateurs internes.',
      dur: 30, perSide: true, targets: ['rotators'],
    },
    {
      name: 'Cercles d\'épaules + ouvertures',
      cue: 'Debout. 10 grands cercles épaules en arrière, lentement. Puis bras croisés devant → grande ouverture en arrière 5 fois. Mobilité dynamique.',
      dur: 40, targets: ['delts'],
    },
    {
      name: 'Étirement deltoïde postérieur (vache)',
      cue: 'Bras dans le dos, l\'un par-dessus (paume entre les omoplates), l\'autre par-dessous (paume vers le haut). Essaie d\'attraper tes doigts. Si tu n\'y arrives pas, sangle ou serviette.',
      dur: 30, perSide: true, targets: ['rear-delts', 'rotators'],
    },
  ],
  arms: [
    {
      name: 'Triceps overhead',
      cue: 'Bras levé, plie le coude pour amener la main entre les omoplates. Avec l\'autre main, tire doucement le coude vers la tête. Sens l\'arrière du bras.',
      dur: 30, perSide: true, targets: ['triceps'],
    },
    {
      name: 'Étirement biceps mur',
      cue: 'Debout dos au mur, place la paume contre le mur derrière toi, bras tendu, pouce vers le bas. Tourne le corps lentement vers l\'opposé. Sens le biceps + avant-bras.',
      dur: 30, perSide: true, targets: ['biceps'],
    },
    {
      name: 'Étirement avant-bras (fléchisseurs)',
      cue: 'Bras tendu devant, paume vers le haut. Avec l\'autre main, tire les doigts vers toi (poignet en hyperextension). Sens l\'intérieur de l\'avant-bras.',
      dur: 25, perSide: true, targets: ['forearm'],
    },
    {
      name: 'Étirement avant-bras (extenseurs)',
      cue: 'Bras tendu devant, paume vers le bas. Avec l\'autre main, plie le poignet vers le bas / vers toi. Sens l\'extérieur de l\'avant-bras.',
      dur: 25, perSide: true, targets: ['forearm'],
    },
  ],
  core: [
    {
      name: 'Cobra',
      cue: 'Allongé sur le ventre, mains sous les épaules. Pousse doucement le buste vers le haut en gardant le bassin au sol. Extension lombaire douce, étire le grand droit.',
      dur: 35, targets: ['abs', 'lower-back'],
    },
    {
      name: 'Twist assis vertébral',
      cue: 'Assis jambes tendues, plie une jambe et croise-la par-dessus l\'autre. Tourne le buste du côté de la jambe pliée, coude opposé contre le genou.',
      dur: 30, perSide: true, targets: ['obliques', 'spine'],
    },
    {
      name: 'Side bend debout',
      cue: 'Debout, bras tendu au-dessus de la tête, l\'autre le long du corps. Penche le buste sur le côté opposé au bras levé, sans avancer/reculer les hanches. Sens le grand oblique.',
      dur: 25, perSide: true, targets: ['obliques'],
    },
  ],
  // Hip flexors travaillent dur dès qu'on fait des squats / fentes / hip thrusts
  // — souvent raccourcis chez les sédentaires. Inséré automatiquement si la
  // séance a touché les jambes ou le core.
  hipflex: [
    {
      name: 'Étirement psoas en fente',
      cue: 'Position de fente basse, genou arrière au sol. Pousse les hanches en avant en gardant le buste vertical, contracte le fessier de la jambe arrière. Sens l\'avant de la hanche.',
      dur: 40, perSide: true, targets: ['hipflex'],
    },
    {
      name: 'Psoas avec bras levé',
      cue: 'Même position que l\'étirement psoas en fente, mais lève le bras du même côté que la jambe arrière au-dessus de la tête, et incline-toi vers l\'opposé. Stretch psoas + flanc.',
      dur: 35, perSide: true, targets: ['hipflex', 'obliques'],
    },
  ],
};

// Construit un programme d'étirements ciblé sur les muscles travaillés.
//
// API :
//   buildStretchProgram(zones)
//     → ancien appel, traite chaque zone comme "1 unité de volume"
//   buildStretchProgram(zones, { zoneSets: { legs: 9, chest: 6, ... } })
//     → préféré : utilise le décompte réel des séries par zone pour
//       allouer plus de stretches aux zones lourdement travaillées
//
// Garanties :
//   - chaque zone touchée reçoit AU MOINS 1 stretch (sauf si budget épuisé)
//   - on diversifie par sous-muscle : si une zone a 3 stretches mais 2
//     ciblent le même muscle (ex: quads), le 3e force un autre sous-muscle
//   - hip-flexor automatiquement ajouté si jambes/core travaillés (ils sont
//     systématiquement raccourcis chez les sédentaires)
//   - durée totale plafonnée à ~7 min (420s) par défaut pour rester réaliste
//
// L'ordre de sortie suit l'intensité décroissante : la zone la plus
// sollicitée en premier (rend le programme évident pour l'utilisateur).
function buildStretchProgram(zones, opts) {
  if (!Array.isArray(zones) || zones.length === 0) return [];
  const cfg = Object.assign({ maxSeconds: 420, maxItems: 7 }, opts || {});
  const zoneSets = (opts && opts.zoneSets) || {};
  const out = [];
  const seen = new Set();
  let budget = cfg.maxSeconds;

  const totalDur = (it) => (it.perSide ? it.dur * 2 : it.dur);

  // Volume par zone : si zoneSets fourni, on l'utilise ; sinon poids = 1.
  // On ordonne les zones par volume décroissant (les plus travaillées
  // passent en premier, donc reçoivent leur quota même si on doit couper).
  const orderedZones = zones.slice().sort((a, b) =>
    (zoneSets[b] || 1) - (zoneSets[a] || 1)
  );

  // Combien de stretches alloués par zone selon le volume.
  // Heuristique simple : <4 séries → 1, 4-7 → 2, ≥8 → 3.
  // Sans zoneSets : on retombe sur l'ancienne logique (heavily trained = 3).
  const heavilyTrained = zones.length <= 2 && Object.keys(zoneSets).length === 0;
  const quotaFor = (z) => {
    if (Object.keys(zoneSets).length === 0) return heavilyTrained ? 3 : 2;
    const v = zoneSets[z] || 0;
    if (v >= 8) return 3;
    if (v >= 4) return 2;
    return 1;
  };

  // Tente d'ajouter un stretch d'une zone donnée, en privilégiant les
  // sous-muscles pas encore couverts dans cette zone (variété).
  const targetsCoveredInZone = {};  // zone → Set des targets déjà servies
  function pushOne(z) {
    const items = STRETCH_LIB[z] || [];
    if (items.length === 0) return false;
    const covered = targetsCoveredInZone[z] || new Set();
    // Pass 1 : un stretch qui couvre une cible inédite. Pass 2 : n'importe lequel.
    for (const pass of [1, 2]) {
      for (const it of items) {
        if (seen.has(it.name)) continue;
        const d = totalDur(it);
        if (d > budget) continue;
        if (pass === 1 && it.targets && it.targets.every(t => covered.has(t))) continue;
        seen.add(it.name);
        if (it.targets) for (const t of it.targets) covered.add(t);
        targetsCoveredInZone[z] = covered;
        out.push(Object.assign({ zone: z }, it));
        budget -= d;
        return true;
      }
    }
    return false;
  }

  // Phase 1 — un stretch minimum par zone touchée (couverture).
  for (const z of orderedZones) {
    if (out.length >= cfg.maxItems || budget <= 0) break;
    pushOne(z);
  }

  // Phase 2 — round-robin pour atteindre le quota de chaque zone.
  // On boucle tant qu'au moins une zone a encore de la place et du contenu.
  let progressing = true;
  while (progressing && out.length < cfg.maxItems && budget > 0) {
    progressing = false;
    for (const z of orderedZones) {
      if (out.length >= cfg.maxItems || budget <= 0) break;
      const inZone = out.filter(x => x.zone === z).length;
      if (inZone >= quotaFor(z)) continue;
      if (pushOne(z)) progressing = true;
    }
  }

  // Bonus hip-flexor si la séance a sollicité jambes ou core (toujours
  // raccourcis chez les sédentaires).
  if ((zones.includes('legs') || zones.includes('core'))
      && out.length < cfg.maxItems) {
    pushOne('hipflex');
  }

  return out;
}

// Compat : ancienne API publique remplacée. cooldownFor() retournait
// l'ancien format { name, cue, dur:string }. On garde un shim pour que les
// éventuels appels externes (snacks, rééduc) ne pètent pas, en projetant la
// nouvelle shape vers l'ancienne — durée formatée en string.
function cooldownFor(zones) {
  return buildStretchProgram(zones, { maxItems: 3, maxSeconds: 180 }).map(s => ({
    name: s.name,
    cue: s.cue,
    dur: s.perSide ? `${s.dur}s/côté` : `${s.dur}s`,
  }));
}
document.getElementById('sessToQuestion').addEventListener('click', openQuestion);

// Pause de séance — sauvegarde l'état tel quel et retourne à la home.
// Au prochain boot/openHome, un banner propose la reprise. Pas de timer
// global qui tourne en arrière-plan : la pause est juste un signal de
// "je reprendrai plus tard".
const _sessPauseBtn = document.getElementById('sessPauseBtn');
if (_sessPauseBtn) {
  _sessPauseBtn.addEventListener('click', () => {
    if (!S.currentSession) return;
    S.currentSession.pausedAt = new Date().toISOString();
    queueSave();
    showToast('Séance en pause', {
      variant: 'info',
      message: 'Tu pourras la reprendre depuis l\'accueil.',
    });
    openHome();
  });
}

/* =================== AUDIO HELPERS ===================
 * v2 — audibilité renforcée et variété sonore.
 *
 * Constats v1 (retour utilisateur) :
 *   - les bips étaient trop faibles avec un téléphone en poche / sac
 *   - les sons étaient toujours identiques (lassitude, on n'entend plus)
 *
 * Stratégie v2 :
 *   - gain doublé (0.22 → 0.45 sur l'alarme, 0.12 → 0.28 sur les ticks)
 *   - chaque appel pioche dans une variété de timbres : square, sawtooth,
 *     triangle, et combinaisons à 2 oscillateurs pour un grain plus "riche"
 *   - mélodies courtes (3-4 notes) plutôt qu'un beep mono-fréquence
 *   - vibrations renforcées en parallèle (téléphone en poche)
 *   - reverb légère via un compresseur dynamique pour gagner en perceived loudness
 *
 * Les fonctions exposées gardent leur signature : playAlarmBeep, playTick,
 * playChime. Le set logging et le rest timer marchent sans changement. */

// Petit utilitaire interne : crée un contexte audio + une chaîne de sortie
// (gain master + compressor pour "épaissir" le son perçu).
function _newAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 1.0;
  // Compressor : remonte les sons faibles, écrête les pics. Sans lui, le
  // gain max possible avant clipping est trop bas pour être audible en gym.
  let out = master;
  try {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 30;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);
    out = master;
  } catch (_) {
    master.connect(ctx.destination);
  }
  return { ctx, dest: out };
}

// Une "voix" = oscillateur + gain ADSR. Plusieurs voix simultanées =
// son plus riche, perçu plus fort sans clipper.
function _voice(ctx, dest, type, freq, start, dur, peak) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + start + 0.01);
  g.gain.setValueAtTime(peak, ctx.currentTime + start + Math.max(0.02, dur - 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

// Palette de motifs d'alarme. À chaque appel on en pioche un — varié
// = on reste alerte au lieu de filtrer le bip de l'app comme du bruit ambiant.
const _ALARM_PATTERNS = [
  // Bip court rapide × 6 — l'urgence pure.
  { name: 'rapid',  beeps: 6, dur: 0.14, gap: 0.18, freq: 1000, type: 'square', detune: 7 },
  // Bip aigu × 4, plus lent — claxon.
  { name: 'horn',   beeps: 4, dur: 0.22, gap: 0.10, freq: 880,  type: 'sawtooth', detune: 0 },
  // Bip grave × 3 — alerte profonde.
  { name: 'deep',   beeps: 3, dur: 0.28, gap: 0.16, freq: 540,  type: 'square', detune: 0 },
  // Sirène montante (police) × 5.
  { name: 'siren',  beeps: 5, dur: 0.20, gap: 0.10, freq: 720,  type: 'triangle', sweep: 1.5 },
  // Cloche métallique × 4 (cluster harmonique).
  { name: 'bell',   beeps: 4, dur: 0.32, gap: 0.20, freq: 1200, type: 'sine', bell: true },
];

// Hard alarm : son fort, varié — utilisé pour le test réaction
// ("stop le bip") et la fin du timer d'effort. Pioche aléatoirement dans
// _ALARM_PATTERNS pour éviter la lassitude / désensibilisation.
function playAlarmBeep(audioCtxRef) {
  try {
    const { ctx, dest } = _newAudioCtx();
    audioCtxRef.ctx = ctx;
    const pat = _ALARM_PATTERNS[Math.floor(Math.random() * _ALARM_PATTERNS.length)];
    let t = 0;
    const peak = 0.45; // ~2× v1
    for (let i = 0; i < pat.beeps; i++) {
      const f = pat.sweep ? pat.freq * (1 + (i / pat.beeps) * pat.sweep) : pat.freq;
      _voice(ctx, dest, pat.type, f, t, pat.dur, peak);
      // Détune léger sur une 2e voix pour épaissir.
      if (pat.detune) _voice(ctx, dest, pat.type, f + pat.detune, t, pat.dur, peak * 0.7);
      // Pour la cloche : harmoniques 2× et 3× → couleur métallique.
      if (pat.bell) {
        _voice(ctx, dest, 'sine', f * 2.0, t, pat.dur * 0.8, peak * 0.5);
        _voice(ctx, dest, 'sine', f * 3.0, t, pat.dur * 0.6, peak * 0.3);
      }
      t += pat.dur + pat.gap;
    }
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, (t + 0.5) * 1000);
    // Vibration plus longue et marquée (téléphone en poche).
    if (navigator.vibrate) try { navigator.vibrate([300, 80, 300, 80, 300, 80, 300]); } catch (_) {}
  } catch (_) {}
}

// Tick de décompte : "3, 2, 1" avant la fin du repos. v2 — plus audible
// (gain × 2.3) et avec un léger contour harmonique pour distinguer
// nettement chaque tick (au lieu d'un blip mono-fréquence).
function playTick(freq = 1200) {
  try {
    const { ctx, dest } = _newAudioCtx();
    // 2 voix légèrement détunées = grain plus net + meilleure portée perçue.
    _voice(ctx, dest, 'square',   freq,      0, 0.10, 0.28);
    _voice(ctx, dest, 'triangle', freq * 2,  0, 0.08, 0.18);
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 250);
  } catch (_) {}
}

// Palette de chimes de fin de repos. Variation = on reste attentif.
const _CHIME_MELODIES = [
  // Quinte ascendante : 660 → 880 (v1, conservé).
  [{ f: 660, t: 0,    d: 0.32 }, { f: 880, t: 0.16, d: 0.45 }],
  // Arpège majeur do-mi-sol.
  [{ f: 523, t: 0,    d: 0.22 }, { f: 659, t: 0.14, d: 0.22 }, { f: 784, t: 0.28, d: 0.50 }],
  // Octave + quinte (cloche d'église miniature).
  [{ f: 523, t: 0,    d: 0.50 }, { f: 1046, t: 0.10, d: 0.45 }, { f: 1568, t: 0.22, d: 0.40 }],
  // Quarte descendante apaisante.
  [{ f: 880, t: 0,    d: 0.28 }, { f: 659, t: 0.20, d: 0.42 }],
  // Sol-do-mi-sol triomphal.
  [{ f: 392, t: 0,    d: 0.18 }, { f: 523, t: 0.14, d: 0.18 },
   { f: 659, t: 0.28, d: 0.18 }, { f: 784, t: 0.42, d: 0.45 }],
];

// Chime doux : fin de repos. v2 — choisi parmi 5 mélodies + gain renforcé.
function playChime() {
  try {
    const { ctx, dest } = _newAudioCtx();
    const mel = _CHIME_MELODIES[Math.floor(Math.random() * _CHIME_MELODIES.length)];
    const peak = 0.34; // ~1.9× v1
    let end = 0;
    for (const n of mel) {
      // Voix sinus principale + une harmonique douce pour la rondeur.
      _voice(ctx, dest, 'sine',     n.f,       n.t, n.d, peak);
      _voice(ctx, dest, 'triangle', n.f * 2.0, n.t, n.d * 0.7, peak * 0.25);
      end = Math.max(end, n.t + n.d);
    }
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, (end + 0.3) * 1000);
    if (navigator.vibrate) try { navigator.vibrate([180, 60, 120]); } catch (_) {}
  } catch (_) {}
}

function stopAudio(ref) {
  try { ref.ctx && ref.ctx.close(); } catch (_) {}
  ref.ctx = null;
  if (navigator.vibrate) try { navigator.vibrate(0); } catch (_) {}
}

/* =================== TIMER PRIMITIVES =================== */
// Each returns a Promise; resolve when user completes or skips.

// Countdown with beep at 0 → user presses STOP as fast as possible.
// resolve({reactionMs, held, dropped, reactionType}) where held = true if user
// went to the end, dropped = true if user bailed out before timer ended.
//
// reactionType :
//   'stop'  → mesure classique (téléphone à portée, on stoppe vite)
//   'getup' → exos au sol (gainage, hollow, superman, sideplank) : la
//             consigne devient « relève-toi puis tape ». reactionMs capture
//             alors le temps de récupération posturale, qui est en pratique
//             un meilleur proxy de la fatigue neuro/musculaire que le
//             simple temps de pression. Le champ reste reactionMs pour ne
//             pas casser les agrégats existants (aggReactionMs).
function runEffortTimer(e) {
  return new Promise(resolve => {
    show('viewTimer');
    const val = document.getElementById('timerVal');
    const label = document.getElementById('timerLabel');
    const hint = document.getElementById('timerHint');
    const card = document.getElementById('timerCard');
    const stopBtn = document.getElementById('timerStop');
    const skipBtn = document.getElementById('timerSkip');

    // Détection "exo au sol" : flag explicite sur la lib (id:'gainage',
    // 'hollow', 'sideplank', 'superman'). Pour les snacks/rééduc on retombe
    // sur le sens classique faute de métadonnée.
    const lib = (typeof EX_BY_ID !== 'undefined') ? EX_BY_ID[e.id] : null;
    const isFloor = !!(lib && lib.floor);
    const reactionType = isFloor ? 'getup' : 'stop';

    card.classList.remove('flash-red');
    label.textContent = `${e.name} — tiens !`;
    hint.textContent = isFloor
      ? 'Quand ça bip, relève-toi vite puis appuie.'
      : 'Quand ça bip, appuie vite sur STOP.';
    stopBtn.textContent = 'J\'ai lâché';
    stopBtn.className = 'sec w-full';
    stopBtn.style.padding = '18px'; stopBtn.style.fontSize = '18px';
    skipBtn.textContent = 'Passer';

    let left = e.reps;
    val.textContent = left;
    let beepAt = null;
    let interval = null;
    const audioRef = {ctx: null};

    const cleanup = () => {
      clearInterval(interval);
      stopAudio(audioRef);
      stopBtn.onclick = null;
      skipBtn.onclick = null;
    };

    interval = setInterval(() => {
      left--;
      val.textContent = Math.max(0, left);
      if (left <= 0) {
        clearInterval(interval);
        card.classList.add('flash-red');
        if (isFloor) {
          label.textContent = '⏰ DEBOUT !';
          val.textContent = 'BIP';
          hint.textContent = 'Relève-toi et tape dès que tu es debout.';
          stopBtn.textContent = 'Je suis debout';
        } else {
          label.textContent = '⏰ STOP !';
          val.textContent = 'BIP';
          hint.textContent = 'Appuie vite !';
          stopBtn.textContent = 'STOP';
        }
        stopBtn.className = 'ko w-full';
        beepAt = performance.now();
        playAlarmBeep(audioRef);
      }
    }, 1000);

    stopBtn.onclick = () => {
      if (beepAt === null) {
        // dropped early
        cleanup();
        resolve({reactionMs: null, held: false, dropped: true, heldSecs: e.reps - left, reactionType});
      } else {
        const r = performance.now() - beepAt;
        cleanup();
        resolve({reactionMs: Math.round(r), held: true, dropped: false, heldSecs: e.reps, reactionType});
      }
    };
    skipBtn.onclick = () => { cleanup(); resolve({reactionMs: null, held: false, dropped: false, heldSecs: 0, reactionType}); };
  });
}

// Random-delay beep → user stops = reactionMs. Post-effort fatigue measure.
function runReactTest() {
  return new Promise(resolve => {
    show('viewTimer');
    const val = document.getElementById('timerVal');
    const label = document.getElementById('timerLabel');
    const hint = document.getElementById('timerHint');
    const card = document.getElementById('timerCard');
    const stopBtn = document.getElementById('timerStop');
    const skipBtn = document.getElementById('timerSkip');

    card.classList.remove('flash-red');
    label.textContent = 'Test réaction';
    hint.textContent = 'Attends le bip puis STOP le plus vite possible.';
    val.textContent = '…';
    stopBtn.textContent = 'STOP';
    stopBtn.className = 'ko w-full';
    stopBtn.style.padding = '18px'; stopBtn.style.fontSize = '18px';
    skipBtn.textContent = 'Passer';

    const delay = 1200 + Math.random() * 2000;
    let beepAt = null;
    let beepTimeout = null;
    const audioRef = {ctx: null};

    const cleanup = () => {
      clearTimeout(beepTimeout);
      stopAudio(audioRef);
      stopBtn.onclick = null;
      skipBtn.onclick = null;
    };

    beepTimeout = setTimeout(() => {
      card.classList.add('flash-red');
      label.textContent = '⏰ STOP !';
      val.textContent = 'BIP';
      beepAt = performance.now();
      playAlarmBeep(audioRef);
    }, delay);

    stopBtn.onclick = () => {
      if (beepAt === null) {
        // Anti-cheat : stopped before the beep.
        hint.textContent = 'Trop tôt ! Attends le bip.';
        return;
      }
      const r = performance.now() - beepAt;
      cleanup();
      resolve({reactionMs: Math.round(r)});
    };
    skipBtn.onclick = () => { cleanup(); resolve({reactionMs: null}); };
  });
}

// Tap test: 3 taps after signal → tapMs of 3rd tap.
function runTapTest() {
  return new Promise(resolve => {
    show('viewTap');
    const z = document.getElementById('tapZone');
    const st = document.getElementById('tapStatus');
    const skipBtn = document.getElementById('tapSkip');
    z.classList.remove('active'); z.textContent = 'Prêt…'; st.textContent = 'Attends le signal';
    const state = { taps: [], startAt: 0, armed: false };

    const cleanup = () => {
      z.onclick = null;
      skipBtn.onclick = null;
      clearTimeout(armTimeout);
    };

    const delay = 800 + Math.random() * 1200;
    const armTimeout = setTimeout(() => {
      z.classList.add('active'); z.textContent = 'TAP !';
      st.textContent = 'Tape 3 fois le plus vite possible';
      state.armed = true;
      state.startAt = performance.now();
    }, delay);

    z.onclick = () => {
      if (!state.armed) {
        st.textContent = 'Trop tôt — attends que ça devienne jaune';
        return;
      }
      const t = performance.now() - state.startAt;
      state.taps.push(t);
      z.textContent = `TAP ${state.taps.length}/3`;
      if (state.taps.length >= 3) {
        cleanup();
        resolve({tapMs: Math.round(state.taps[2])});
      }
    };
    skipBtn.onclick = () => { cleanup(); resolve({tapMs: null}); };
  });
}

// Rest countdown — wall-clock driven, not a tick counter. A phone locking or
// the tab backgrounding used to freeze the old setInterval counter, so users
// would come back to "45s left" when their rest was actually done. We now
// compute `left` from Date.now() against a deadline every tick (or whenever
// the page regains visibility), which is drift-proof.
//
// Audio/haptic ladder:
//   - 10s warning tick
//   - 5s, 3s, 2s, 1s escalating ticks (rising pitch)
//   - 0s: chime + strong vibration (S-S-L pattern) + "Continuer" CTA
//   - +30s button adds time; "Passer" skips the rest of the wait
//
// Screen Wake Lock: request while resting so the phone doesn't dim during a
// 2-minute compound rest. Released on resolve. Silent fallback if the browser
// doesn't support it (older iOS Safari).
function runRestTimer(secs) {
  return new Promise(resolve => {
    show('viewTimer');
    const val = document.getElementById('timerVal');
    const label = document.getElementById('timerLabel');
    const hint = document.getElementById('timerHint');
    const card = document.getElementById('timerCard');
    const stopBtn = document.getElementById('timerStop');
    const skipBtn = document.getElementById('timerSkip');

    card.classList.remove('flash-red');
    card.classList.remove('flash-green');
    label.textContent = 'Repos';
    hint.textContent = 'Respire, mobilise, souffle.';
    val.textContent = secs;
    stopBtn.textContent = 'Passer le repos';
    stopBtn.className = 'sec w-full';
    stopBtn.style.padding = '18px'; stopBtn.style.fontSize = '18px';
    skipBtn.textContent = '+30s';

    let deadline = Date.now() + secs * 1000;
    let interval = null;
    let chimed = false;
    // Set of "seconds remaining" milestones we've already beeped at, so we
    // don't double-beep if a tick happens slightly late. Keyed by integer seconds.
    const tickedAt = new Set();
    let wakeLock = null;

    // Acquire a screen wake lock if available. Must be released before the
    // promise resolves so the screen can dim again.
    const acquireWakeLock = async () => {
      try {
        if (navigator.wakeLock && navigator.wakeLock.request) {
          wakeLock = await navigator.wakeLock.request('screen');
          // Re-acquire on visibility regain (browsers auto-release on hide).
          wakeLock.addEventListener && wakeLock.addEventListener('release', () => {});
        }
      } catch (_) { /* user denied / unsupported */ }
    };
    const releaseWakeLock = () => {
      if (wakeLock && wakeLock.release) {
        try { wakeLock.release(); } catch (_) {}
      }
      wakeLock = null;
    };
    acquireWakeLock();

    const onVis = () => {
      // When returning to the tab, re-request the lock (browsers drop it on hide).
      if (!document.hidden) {
        acquireWakeLock();
        render(); // force a repaint so "left" catches up visibly
      }
    };
    document.addEventListener('visibilitychange', onVis);

    const finish = () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
      releaseWakeLock();
      stopBtn.onclick = null;
      skipBtn.onclick = null;
      resolve();
    };

    const render = () => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      val.textContent = Math.max(0, left);

      // Warning ticks — escalating frequency for urgency. Each only fires once.
      if (left <= 10 && left > 0 && !tickedAt.has(left)) {
        if (left === 10) { tickedAt.add(10); playTick(900); }
        else if (left === 5) { tickedAt.add(5); playTick(1000); }
        else if (left === 3) { tickedAt.add(3); playTick(1100); }
        else if (left === 2) { tickedAt.add(2); playTick(1200); }
        else if (left === 1) { tickedAt.add(1); playTick(1300); }
      }

      if (left <= 0 && !chimed) {
        chimed = true;
        label.textContent = 'Prêt à continuer';
        hint.textContent = 'Appuie pour enchaîner.';
        stopBtn.textContent = '▶ Continuer';
        stopBtn.className = 'ok w-full';
        card.classList.add('flash-green');
        playChime();
        // Strong haptic on completion, distinct from the 10s warning.
        if (navigator.vibrate) try { navigator.vibrate([200, 80, 200, 80, 400]); } catch (_) {}
      }
    };

    // 200ms poll — cheap, and makes the "+30s" button feel snappier. The
    // wall-clock math keeps us accurate even under clock skew.
    interval = setInterval(render, 200);
    render();

    stopBtn.onclick = () => finish();
    skipBtn.onclick = () => {
      // Bump deadline forward by 30s. If we were already past 0, that reopens
      // the "counting down" state — clear chime flag & visual so re-finish works.
      deadline += 30 * 1000;
      if (chimed) {
        chimed = false;
        card.classList.remove('flash-green');
        label.textContent = 'Repos';
        hint.textContent = 'Temps ajouté. Repos prolongé.';
        stopBtn.textContent = 'Passer le repos';
        stopBtn.className = 'sec w-full';
        // Clear tickedAt for any milestone we'll cross again.
        tickedAt.clear();
      }
      render();
    };
  });
}

/* =================== PROGRAMME D'ÉTIREMENT (FLOW CHRONO) ===================
 *
 * Itère sur la liste de postures produite par buildStretchProgram.
 *
 * Pour chaque posture :
 *   - Si perSide : 2 phases (Gauche → Droite), chacune chronométrée dur sec
 *   - Sinon       : une seule phase chronométrée dur sec
 *
 * Pendant le décompte :
 *   - 5/3/2/1s : tick sonore (playTick)
 *   - 0s        : chime + bascule auto vers la phase ou la posture suivante
 *
 * Contrôles utilisateur :
 *   - "Passer" : skippe la phase en cours (et passe à la suivante)
 *   - "Arrêter" : abandonne le programme (résout la promise)
 *
 * UI : réutilise #viewTimer (label, val, hint, card, stopBtn, skipBtn) avec
 * un overlay en haut indiquant la progression "Étirement 3/5". Pas besoin
 * d'une vue dédiée — la séance est finie, ce flow remplace runRestTimer
 * dans le contexte cooldown.
 */
async function runStretchProgram(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  const total = list.length;

  // Étirement n°i, optionnellement côté (G/D). Résout { skipped, stopped }.
  const runOne = (item, idx, sideLabel) => new Promise(resolve => {
    show('viewTimer');
    const val = document.getElementById('timerVal');
    const label = document.getElementById('timerLabel');
    const hint = document.getElementById('timerHint');
    const card = document.getElementById('timerCard');
    const stopBtn = document.getElementById('timerStop');
    const skipBtn = document.getElementById('timerSkip');

    card.classList.remove('flash-red');
    card.classList.remove('flash-green');
    const sideStr = sideLabel ? ` · ${sideLabel}` : '';
    label.textContent = `🧘 ${item.name}${sideStr}`;
    hint.textContent = item.cue;
    val.textContent = item.dur;
    stopBtn.textContent = 'Passer';
    stopBtn.className = 'sec w-full';
    stopBtn.style.padding = '18px'; stopBtn.style.fontSize = '18px';
    skipBtn.textContent = 'Arrêter le programme';

    // Petit overlay de progression injecté dans timerLabel (pas un nouvel
    // élément DOM — on évite de modifier l'HTML). Format : "(3/7)".
    label.textContent = `🧘 (${idx + 1}/${total}) ${item.name}${sideStr}`;

    let deadline = Date.now() + item.dur * 1000;
    let interval = null;
    const tickedAt = new Set();
    let chimed = false;
    let wakeLock = null;

    const acquireWakeLock = async () => {
      try {
        if (navigator.wakeLock && navigator.wakeLock.request) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (_) {}
    };
    const releaseWakeLock = () => {
      if (wakeLock && wakeLock.release) {
        try { wakeLock.release(); } catch (_) {}
      }
      wakeLock = null;
    };
    acquireWakeLock();

    const onVis = () => {
      if (!document.hidden) { acquireWakeLock(); render(); }
    };
    document.addEventListener('visibilitychange', onVis);

    const cleanup = (result) => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
      releaseWakeLock();
      stopBtn.onclick = null;
      skipBtn.onclick = null;
      resolve(result);
    };

    const render = () => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      val.textContent = Math.max(0, left);

      if (left <= 5 && left > 0 && !tickedAt.has(left)) {
        tickedAt.add(left);
        playTick(900 + (5 - left) * 80);
      }
      if (left <= 0 && !chimed) {
        chimed = true;
        card.classList.add('flash-green');
        playChime();
        // Petit délai pour laisser le chime jouer avant d'enchaîner.
        setTimeout(() => cleanup({ skipped: false, stopped: false }), 350);
      }
    };

    interval = setInterval(render, 200);
    render();

    stopBtn.onclick = () => cleanup({ skipped: true, stopped: false });
    skipBtn.onclick = () => cleanup({ skipped: false, stopped: true });
  });

  // Itération sur les postures. Pour les unilatérales : G puis D.
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it.perSide) {
      const r1 = await runOne(it, i, 'Gauche');
      if (r1.stopped) return { stopped: true };
      // Petite pause de transition côté droit (1.2s) — déjà couvert par le
      // chime, donc on enchaîne directement.
      const r2 = await runOne(it, i, 'Droite');
      if (r2.stopped) return { stopped: true };
    } else {
      const r = await runOne(it, i, null);
      if (r.stopped) return { stopped: true };
    }
  }

  // Final : on flashe vert avec un message et un bouton retour.
  return await new Promise(resolve => {
    show('viewTimer');
    const val = document.getElementById('timerVal');
    const label = document.getElementById('timerLabel');
    const hint = document.getElementById('timerHint');
    const card = document.getElementById('timerCard');
    const stopBtn = document.getElementById('timerStop');
    const skipBtn = document.getElementById('timerSkip');
    card.classList.add('flash-green');
    label.textContent = '🌿 Programme terminé';
    hint.textContent = 'Bien joué. Hydrate-toi et passe au bilan.';
    val.textContent = '✓';
    stopBtn.textContent = 'Continuer';
    stopBtn.className = 'ok w-full';
    skipBtn.textContent = '';
    skipBtn.style.display = 'none';
    playChime();
    stopBtn.onclick = () => {
      stopBtn.onclick = null;
      skipBtn.style.display = '';
      resolve({ stopped: false });
    };
  });
}

/* =================== SET LOGGING (immersive flow) =================== */
// Called from the focus card. Drives: log inputs → reaction test → tap test → rest → advance.
async function logSet(i, k) {
  // Petite confirmation haptique : la série est validée. Sur Android le
  // double-tap se sent net, sur iOS la fonction est no-op (pas d'API
  // navigator.vibrate). Les autres confirmations passent par le toast.
  haptic(HAPTIC.set);
  const e = live.s.exos[i];
  let reps, weight, held = null, heldSecs = null, dropped = null, reactionMs = null, tapMs = null;
  // 'stop' (test classique) ou 'getup' (temps de se relever sur exo au sol).
  // Renseigné par runEffortTimer pour les exos timed avec lib.floor === true.
  let reactionType = null;

  // Capture du côté travaillé (exos unilatéraux). Lecture AVANT le timer
  // d'effort parce que le bouton focusSideRow disparaît dès qu'on bascule
  // sur viewTimer / viewTap.
  let side = null;
  const _lib = EX_BY_ID[e.id];
  if (_lib && _lib.unilateral) {
    const sel = document.querySelector('#focusSideRow .chip.on');
    side = sel ? sel.dataset.side : null;
  }

  if (e.timed) {
    // Timed exercise: beep at end of the effort → STOP = reaction under peak fatigue.
    const out = await runEffortTimer(e);
    held = out.held; heldSecs = out.heldSecs; dropped = out.dropped; reactionMs = out.reactionMs;
    reactionType = out.reactionType || 'stop';
    reps = heldSecs;
    weight = null;
  } else {
    // Focus inputs — weight only present if the exo supports it.
    const rEl = document.getElementById('focusReps');
    reps = rEl ? (+rEl.value || 0) : e.reps;
    const wEl = document.getElementById('focusWeight');
    if (wEl) {
      const v = wEl.value;
      weight = v === '' ? null : (+v || 0);
    } else {
      weight = null;
    }
    // Reaction test IMMEDIATELY after the effort — captures acute CNS fatigue.
    const out = await runReactTest();
    reactionMs = out.reactionMs;
    reactionType = 'stop';
  }

  // Tap test: second CNS/fine-motor check.
  const tapOut = await runTapTest();
  tapMs = tapOut.tapMs;

  const totalSets = live.s.exos.reduce((a, e) => a + e.sets, 0);
  const isLastOverall = (live.sets.length + 1 === totalSets);

  // Rest only if more work to do. Silent countdown, gentle chime.
  if (!isLastOverall) {
    await runRestTimer(e.rest);
  }

  const record = {
    exoId: e.id, exoIdx: i, setIdx: k,
    reps, weight,
    held, heldSecs, dropped,
    reactionMs, tapMs,
    // 'stop' = test classique post-effort, 'getup' = temps pour se relever
    // après un exo au sol (gainage etc.). Permet, dans l'analyse long terme,
    // de comparer reactionMs sur des bases homogènes.
    reactionType,
    // Côté travaillé pour les exos unilatéraux : 'L' (gauche), 'R' (droite),
    // 'B' (les deux). null pour les exos bilatéraux. Permet d'afficher après
    // coup les déséquilibres G/D dans le bilan.
    side,
  };
  live.sets.push(record);

  // ---- Propagation du poids modifié vers le prochain tour --------------
  // Si l'utilisateur a saisi une charge différente de ce que prévoyait la
  // séance, on patche `e.weight` pour que :
  //   - en mode circuit, le tour suivant de ce même exo affiche le poids
  //     ajusté (et non la valeur initiale obsolète),
  //   - en mode séries groupées, les séries suivantes du même exo héritent
  //     du nouveau poids,
  //   - en cas de pause/reprise, la session sauvegardée garde la trace.
  // On ne touche pas aux exos timed (pas de notion de charge).
  if (!e.timed && weight != null && weight !== e.weight) {
    e.weight = weight;
    // live.s === S.currentSession (référence) → la mutation est persistée
    // via queueSave côté questionnaire ou via le save périodique. On force
    // une sauvegarde immédiate ici pour ne pas perdre l'info si l'utilisateur
    // met la séance en pause juste après.
    queueSave();
  }

  // Détection d'anomalie bayésienne — non bloquante, juste un toast
  // informatif si le set sort de l'intervalle prédit (|z| > 2.5). On
  // construit un set synthétique avec date+rpe pour que detectAnomaly
  // puisse calculer la position attendue. RPE encore inconnu (saisi
  // au bilan) → on omet, le module utilise un défaut.
  if (window.Bayesian && weight && reps) {
    const synthSet = { exoId: e.id, weight, reps, date: new Date().toISOString() };
    const anomaly = window.Bayesian.detectAnomaly(synthSet, S.history, e.id);
    if (anomaly && anomaly.isAnomaly) {
      const dir = anomaly.direction === 'high' ? 'au-dessus' : 'en dessous';
      const variantClass = anomaly.direction === 'high' ? 'success' : 'info';
      showToast(
        anomaly.direction === 'high' ? '🎉 Set inhabituel — possible PR' : '⚠️ Set inhabituel',
        {
          variant: variantClass,
          message: `${weight}kg × ${reps} suggère un 1RM ~${anomaly.observed.toFixed(0)}kg, ` +
                   `${dir} de ta prédiction (~${anomaly.predicted.toFixed(0)}kg). ` +
                   (anomaly.direction === 'high'
                     ? 'Si c\'est confirmé, le modèle s\'ajustera après le bilan.'
                     : 'Charge inhabituellement basse — fatigue, technique, ou erreur de saisie ?'),
        }
      );
    }
  }

  show('viewSession');
  renderSession();
}

/* =================== END QUESTIONNAIRE =================== */
function openQuestion() {
  show('viewQuestion');
  wireChips('qPain');
  // Reset form state between sessions (chips were sticky + sliders kept last value).
  document.querySelectorAll('#qPain .chip').forEach(c => c.classList.remove('on'));
  // valuetext maps the numeric slider value to a phrase screen readers will
  // announce ("RPE 7 sur 10, dur") instead of just "7".
  const RPE_LABELS = {
    1:'très facile', 2:'facile', 3:'modéré', 4:'soutenu', 5:'soutenu',
    6:'dur', 7:'dur', 8:'très dur', 9:'maximal', 10:'au max',
  };
  const FIVE_LABELS = { 1:'très bas', 2:'bas', 3:'moyen', 4:'bon', 5:'excellent' };
  const setRange = (id, valId, def, max, labels, prefix) => {
    const r = document.getElementById(id), v = document.getElementById(valId);
    r.value = def; v.textContent = def;
    const min = +r.min || 0;
    const update = () => {
      v.textContent = r.value;
      const phrase = labels[+r.value] || '';
      r.setAttribute('aria-valuetext', `${prefix} ${r.value} sur ${max}${phrase ? ', ' + phrase : ''}`);
      // Set --pct for the WebKit slider track gradient. Firefox uses
      // ::-moz-range-progress instead so this is a no-op there.
      const pct = ((+r.value - min) / (max - min)) * 100;
      r.style.setProperty('--pct', pct + '%');
    };
    update();
    r.oninput = update;
  };
  setRange('qRpe',    'qRpeVal',    6, 10, RPE_LABELS,  'RPE');
  setRange('qEnergy', 'qEnergyVal', 3, 5,  FIVE_LABELS, 'énergie');
  setRange('qMood',   'qMoodVal',   3, 5,  FIVE_LABELS, 'humeur');
  document.getElementById('qNote').value = '';
  // RIR (Zourdos 2016) — slider optionnel, défaut -1 ("non renseigné").
  // Si rempli, écrase qRpe via Science.rirToRpe lors du submit.
  const qRir = document.getElementById('qRir');
  const qRirVal = document.getElementById('qRirVal');
  if (qRir && qRirVal) {
    qRir.value = -1; qRirVal.textContent = 'non renseigné';
    qRir.oninput = () => {
      const r = +qRir.value;
      if (r < 0) { qRirVal.textContent = 'non renseigné'; return; }
      const labels = ['échec (RPE 10)', '1 rep (RPE 9)', '2 reps (RPE 8)',
                      '3 reps (RPE 7)', '4 reps (RPE 6)', '5+ reps (RPE ≤6)'];
      qRirVal.textContent = `${r} → ${labels[r] || ''}`;
    };
  }
}

document.getElementById('qSubmit').addEventListener('click', () => {
  if (!live) { openHome(); return; } // guard: no live session to save bilan against
  let rpe = +document.getElementById('qRpe').value;
  const energy = +document.getElementById('qEnergy').value;
  const mood = +document.getElementById('qMood').value;
  const note = document.getElementById('qNote').value.trim().slice(0, 500);
  const pains = readChips('qPain');
  // RIR optionnel — si rempli (>=0), écrase le RPE via Science.rirToRpe.
  // On garde la valeur RIR aussi dans le record pour les analyses futures.
  let rir = null;
  const qRirEl = document.getElementById('qRir');
  if (qRirEl) {
    const rv = +qRirEl.value;
    if (rv >= 0 && window.Science && typeof window.Science.rirToRpe === 'function') {
      rir = rv;
      const derivedRpe = window.Science.rirToRpe(rv);
      if (derivedRpe != null) rpe = derivedRpe;
    }
  }
  const rec = {
    id: live.s.id, date: new Date().toISOString(), title: live.s.title,
    rotIdx: live.s.rotIdx,
    exos: live.s.exos.map(e => ({id:e.id, name:e.name, sets:e.sets, reps:e.reps, weight:e.weight, timed:!!e.timed})),
    sets: live.sets,
    rpe, rir, energy, mood, note, pains,
    aggReactionMs: avg(live.sets.map(s => s.reactionMs).filter(x => x != null)),
    aggTapMs: avg(live.sets.map(s => s.tapMs).filter(x => x != null)),
    formBefore: S.formScore,
  };
  const out = adapt(rec);
  rec.formAfter = out.newScore;
  S.history.push(rec);
  S.formScore = out.newScore;
  S.adjustments.push(...out.notes.map(n => `[${new Date().toLocaleDateString()}] ${n}`));
  if (S.profile) S.profile.painToday = pains;
  S.currentSession = null;
  live = null;
  queueSave();
  openHome();
});

const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;

/* =================== ADAPTATION =================== */
function adapt(rec) {
  const notes = [];
  let delta = 0;
  if (rec.rpe <= 3) { delta += 6; notes.push('RPE très bas → +volume/charge prévus.'); }
  else if (rec.rpe <= 5) { delta += 3; notes.push('Séance gérable → légère progression.'); }
  else if (rec.rpe <= 7) { /* neutre */ }
  else if (rec.rpe <= 8) { delta -= 3; notes.push('RPE élevé → on maintient sans pousser.'); }
  else { delta -= 7; notes.push('RPE très élevé → deload sur la prochaine.'); }

  if (rec.aggReactionMs != null) {
    if (rec.aggReactionMs < 350) { delta += 2; notes.push(`Réactions rapides (${rec.aggReactionMs}ms) → bonne fraîcheur.`); }
    else if (rec.aggReactionMs > 700) { delta -= 3; notes.push(`Réactions lentes (${rec.aggReactionMs}ms) → fatigue neuro.`); }
  }
  if (rec.aggTapMs != null) {
    if (rec.aggTapMs < 500) { delta += 2; notes.push(`Tap test rapide (${rec.aggTapMs}ms) → système nerveux OK.`); }
    else if (rec.aggTapMs > 1200) { delta -= 3; notes.push(`Tap test lent (${rec.aggTapMs}ms) → fatigue.`); }
  }
  if (rec.pains && rec.pains.length) {
    delta -= 4;
    notes.push(`Douleurs : ${rec.pains.join(', ')} → exos concernés retirés prochaine séance.`);
  }
  if (rec.energy <= 2) { delta -= 2; notes.push('Énergie basse → volume réduit.'); }
  if (rec.mood <= 2) { delta -= 1; }
  if (rec.energy >= 4 && rec.mood >= 4) { delta += 1; }

  const prev = S.formScore;
  const target = Math.max(0, Math.min(100, prev + delta));
  const newScore = Math.round(prev * 0.6 + target * 0.4);

  if (delta >= 4) notes.unshift('Prochaine séance : +1 rep et légère hausse de charge.');
  else if (delta >= 2) notes.unshift('Prochaine séance : +1 rep possible.');
  else if (delta <= -4) notes.unshift('Prochaine séance : deload (-20% de volume).');
  else if (delta <= -2) notes.unshift('Prochaine séance : stable + repos allongés.');
  else notes.unshift('Prochaine séance : identique, on consolide.');

  return { newScore, notes };
}

/* =================== SPARKLINE (SVG) =================== */
// Renders a minimal SVG line chart. Pure server-independent.
function sparkline(values, opts) {
  opts = Object.assign({width: 260, height: 54, color: '#26408b', fill: true}, opts || {});
  // SVG responsive : viewBox fixe + width:100% pour suivre la largeur réelle
  // du conteneur (card-mini fait 220px mais avec 14px de padding → ~192px
  // de contenu utile, donc l'ancien width="220" fixe débordait à droite).
  // max-width plafonne pour ne pas étirer au-delà des proportions voulues.
  const svgStyle = `display:block;width:100%;height:auto;max-width:${opts.width}px`;
  if (!values || values.length < 2) {
    return `<svg viewBox="0 0 ${opts.width} ${opts.height}" style="${svgStyle}"></svg>`;
  }
  const w = opts.width, h = opts.height, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const rng = max - min || 1;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - pad*2)) / Math.max(1, n - 1);
    const y = h - pad - ((v - min) / rng) * (h - pad*2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = opts.fill
    ? `<path d="${d} L${pts[pts.length-1][0].toFixed(1)},${h-pad} L${pts[0][0].toFixed(1)},${h-pad} Z" fill="${opts.color}" fill-opacity="0.15"/>`
    : '';
  const dots = pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="${opts.color}"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="${svgStyle}">
    ${area}
    <path d="${d}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

/* =================== BAR CHART (SVG) =================== */
// Minimal vertical bar chart with labels under each bar. `values` and `labels`
// must be the same length. If all values are 0 we still render an axis line.
function barchart(values, labels, opts) {
  opts = Object.assign({width: 300, height: 90, color: '#26408b', labelColor: '#8a93a8'}, opts || {});
  const w = opts.width, h = opts.height;
  const labelH = 14, pad = 4;
  const chartH = h - labelH - pad;
  const n = values.length || 1;
  const max = Math.max(1, ...values);
  const gap = 2;
  const barW = Math.max(2, (w - pad*2 - gap*(n-1)) / n);
  const bars = values.map((v, i) => {
    const x = pad + i * (barW + gap);
    const bh = v > 0 ? Math.max(1, (v / max) * chartH) : 0;
    const y = pad + (chartH - bh);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${opts.color}"/>`;
  }).join('');
  const axis = `<line x1="${pad}" y1="${(pad+chartH).toFixed(1)}" x2="${(w-pad).toFixed(1)}" y2="${(pad+chartH).toFixed(1)}" stroke="${opts.labelColor}" stroke-opacity="0.25" stroke-width="1"/>`;
  const txt = labels.map((lab, i) => {
    const cx = pad + i * (barW + gap) + barW/2;
    return `<text x="${cx.toFixed(1)}" y="${(h - 2).toFixed(1)}" text-anchor="middle" font-size="9" fill="${opts.labelColor}">${escapeHtml(lab)}</text>`;
  }).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;width:100%;height:auto;max-width:${w}px">
    ${axis}${bars}${txt}
  </svg>`;
}

/* =================== HISTORY AGGREGATION =================== */
// Bucket history sessions by day for the last `days` days (inclusive of today).
// Returns { labels: ['L','M',...], volumes: [..], sessions: [..], sets: [..] }.
function aggregateByDay(history, days) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const buckets = [];
  const dayNames = ['D','L','M','M','J','V','S'];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets.push({
      date: new Date(d),
      label: dayNames[d.getDay()],
      volume: 0,
      sets: 0,
      sessions: 0,
    });
  }
  for (const h of (history || [])) {
    const hd = new Date(h.date);
    hd.setHours(0,0,0,0);
    const diff = Math.round((today - hd) / 86400000);
    if (diff < 0 || diff >= days) continue;
    const idx = days - 1 - diff;
    const b = buckets[idx];
    b.sessions += 1;
    for (const s of (h.sets || [])) {
      b.sets += 1;
      b.volume += (s.weight || 0) * (s.reps || 0);
    }
  }
  return buckets;
}

// Bucket history by ISO-ish week for the last `weeks` weeks.
function aggregateByWeek(history, weeks) {
  const today = new Date();
  today.setHours(0,0,0,0);
  // Normalize to Monday-start: Sunday=0, shift so Monday=0.
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow);
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    buckets.push({
      start, end,
      label: `${start.getDate()}/${start.getMonth()+1}`,
      volume: 0,
      sets: 0,
      sessions: 0,
    });
  }
  for (const h of (history || [])) {
    const hd = new Date(h.date);
    for (let i = 0; i < buckets.length; i++) {
      if (hd >= buckets[i].start && hd < buckets[i].end) {
        buckets[i].sessions += 1;
        for (const s of (h.sets || [])) {
          buckets[i].sets += 1;
          buckets[i].volume += (s.weight || 0) * (s.reps || 0);
        }
        break;
      }
    }
  }
  return buckets;
}

// For a given exo, return chronological data points over the last `days` days:
// one entry per session with that exo, { date, weight, reps, heldSecs, score }.
function exoProgression(history, exoId, days) {
  const cutoff = new Date();
  cutoff.setHours(0,0,0,0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const rows = [];
  for (const h of (history || [])) {
    const hd = new Date(h.date);
    if (hd < cutoff) continue;
    const sets = (h.sets || []).filter(s => s.exoId === exoId);
    if (!sets.length) continue;
    const e = EX_BY_ID[exoId];
    if (!e) continue;
    if (e.timed) {
      const held = avg(sets.map(s => s.heldSecs).filter(x => x != null));
      if (held != null) rows.push({ date: hd, held, score: held });
    } else {
      const weights = sets.map(s => s.weight).filter(x => x != null);
      const reps = sets.map(s => s.reps).filter(x => x != null);
      const w = avg(weights);
      const r = avg(reps);
      if (w != null) rows.push({ date: hd, weight: w, reps: r, score: w * (r || 1) });
      else if (r != null) rows.push({ date: hd, reps: r, score: r });
    }
  }
  rows.sort((a,b) => a.date - b.date);
  return rows;
}

// Top exos by number of sets logged in the last `days` days.
function topExosInWindow(history, days, limit) {
  const cutoff = new Date();
  cutoff.setHours(0,0,0,0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const counts = {};
  for (const h of (history || [])) {
    const hd = new Date(h.date);
    if (hd < cutoff) continue;
    for (const s of (h.sets || [])) {
      if (!s.exoId) continue;
      counts[s.exoId] = (counts[s.exoId] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, n]) => ({ id, sets: n, name: (EX_BY_ID[id] && EX_BY_ID[id].n) || id }));
}

/* =================== PERSONAL RECORDS =================== */
function computePRs() {
  const prs = {};
  for (const h of S.history) {
    for (const s of (h.sets || [])) {
      if (!s.exoId) continue;
      const prev = prs[s.exoId];
      const e = EX_BY_ID[s.exoId];
      if (!e) continue;
      if (e.timed) {
        const held = s.heldSecs ?? s.reps ?? 0;
        if (!prev || held > (prev.held || 0)) {
          prs[s.exoId] = { name: e.n, timed: true, held, date: h.date };
        }
      } else if (s.weight) {
        const score = s.weight * (s.reps || 1);
        if (!prev || score > (prev.score || 0)) {
          prs[s.exoId] = { name: e.n, timed: false, weight: s.weight, reps: s.reps, score, date: h.date };
        }
      }
    }
  }
  return Object.values(prs).sort((a,b) => (b.score || b.held || 0) - (a.score || a.held || 0));
}

/* =================== HISTORY + PROGRESSION =================== */
function openHistory() {
  show('viewHistory');
  // accountEmail / settings were moved to viewOnboarding (Profil tab)
  // pour respecter la convention web/mobile (compte = sous Profil, pas
  // sous Historique). Plus rien à initialiser ici côté compte.
  renderWeekSummary();
  renderMonthSummary();
  renderProgressCharts();
  renderHistoryList();
}

function renderWeekSummary() {
  const el = document.getElementById('weekSummary');
  if (!el) return;
  if (!S.history || S.history.length === 0) {
    el.innerHTML = '<p class="mut">Pas encore de données. Fais quelques séances.</p>';
    return;
  }
  const days = aggregateByDay(S.history, 7);
  const totalVol = days.reduce((a,b) => a + b.volume, 0);
  const totalSets = days.reduce((a,b) => a + b.sets, 0);
  const totalSessions = days.reduce((a,b) => a + b.sessions, 0);
  const hasData = totalSets > 0 || totalSessions > 0;

  const volumes = days.map(d => d.volume);
  const labels = days.map(d => d.label);
  const chart = barchart(volumes, labels, {width: 320, height: 100, color: '#26408b'});

  // Per-day text fallback when no volume (bodyweight exos only)
  const setsChart = barchart(days.map(d => d.sets), labels, {width: 320, height: 80, color: '#4a6bb0'});

  const top = topExosInWindow(S.history, 7, 3);
  const topRows = top.map(t => {
    const prog = exoProgression(S.history, t.id, 7);
    if (prog.length < 2) {
      const last = prog[prog.length - 1];
      const lastTxt = last ? (last.weight != null ? `${last.weight}kg × ${Math.round(last.reps || 0)}` : `${Math.round(last.held || last.reps || 0)}${last.held != null ? 's' : ''}`) : '—';
      return `<tr><td>${escapeHtml(t.name)}</td><td>${t.sets} séries</td><td style="text-align:right">${escapeHtml(lastTxt)}</td></tr>`;
    }
    const vals = prog.map(p => p.score);
    const trend = vals[vals.length-1] > vals[0] ? '↑' : (vals[vals.length-1] < vals[0] ? '↓' : '→');
    return `<tr><td>${escapeHtml(t.name)}</td><td>${t.sets} séries ${trend}</td><td style="text-align:right;min-width:110px">${sparkline(vals, {width:100, height:24, color:'#e8954d', fill:false})}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="charts-grid">
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Séances</div>
        <div class="stat">${totalSessions}</div>
      </div>
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Séries</div>
        <div class="stat">${totalSets}</div>
      </div>
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Volume (kg×reps)</div>
        <div class="stat">${totalVol}</div>
      </div>
    </div>
    ${hasData ? `
      <div class="mt10">
        <div class="mut" style="font-size:12px;margin-bottom:4px">Volume par jour</div>
        ${chart}
      </div>
      ${totalVol === 0 ? `<div class="mt10">
        <div class="mut" style="font-size:12px;margin-bottom:4px">Séries par jour</div>
        ${setsChart}
      </div>` : ''}
      ${top.length ? `<div class="mt10">
        <div class="mut" style="font-size:12px;margin-bottom:4px">Top exos cette semaine</div>
        <table>${topRows}</table>
      </div>` : ''}
    ` : '<p class="mut mt10">Aucune séance sur les 7 derniers jours.</p>'}
  `;
}

function renderMonthSummary() {
  const el = document.getElementById('monthSummary');
  if (!el) return;
  if (!S.history || S.history.length === 0) {
    el.innerHTML = '<p class="mut">Pas encore de données.</p>';
    return;
  }
  const weeks = aggregateByWeek(S.history, 5);
  const totalVol = weeks.reduce((a,b) => a + b.volume, 0);
  const totalSets = weeks.reduce((a,b) => a + b.sets, 0);
  const totalSessions = weeks.reduce((a,b) => a + b.sessions, 0);
  const hasData = totalSets > 0 || totalSessions > 0;

  const volumes = weeks.map(w => w.volume);
  const wLabels = weeks.map(w => w.label);
  const chart = barchart(volumes, wLabels, {width: 320, height: 100, color: '#26408b'});

  const top = topExosInWindow(S.history, 30, 5);
  const topRows = top.map(t => {
    const prog = exoProgression(S.history, t.id, 30);
    if (prog.length < 2) {
      const last = prog[prog.length - 1];
      const lastTxt = last ? (last.weight != null ? `${last.weight}kg × ${Math.round(last.reps || 0)}` : `${Math.round(last.held || last.reps || 0)}${last.held != null ? 's' : ''}`) : '—';
      return `<tr><td>${escapeHtml(t.name)}</td><td>${t.sets} séries</td><td style="text-align:right">${escapeHtml(lastTxt)}</td></tr>`;
    }
    const vals = prog.map(p => p.score);
    const first = vals[0], last = vals[vals.length - 1];
    const pct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
    const trend = last > first ? `<span style="color:var(--success)">↑ +${pct}%</span>` : (last < first ? `<span style="color:var(--danger)">↓ ${pct}%</span>` : '→');
    return `<tr><td>${escapeHtml(t.name)}</td><td>${t.sets} séries ${trend}</td><td style="text-align:right;min-width:110px">${sparkline(vals, {width:100, height:24, color:'#e8954d', fill:false})}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="charts-grid">
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Séances</div>
        <div class="stat">${totalSessions}</div>
      </div>
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Séries</div>
        <div class="stat">${totalSets}</div>
      </div>
      <div class="card-mini">
        <div class="mut" style="font-size:11px">Volume (kg×reps)</div>
        <div class="stat">${totalVol}</div>
      </div>
    </div>
    ${hasData ? `
      <div class="mt10">
        <div class="mut" style="font-size:12px;margin-bottom:4px">Volume par semaine</div>
        ${chart}
      </div>
      ${top.length ? `<div class="mt10">
        <div class="mut" style="font-size:12px;margin-bottom:4px">Progression des exos les plus travaillés</div>
        <table>${topRows}</table>
      </div>` : ''}
    ` : '<p class="mut mt10">Aucune séance sur les 30 derniers jours.</p>'}
  `;
}

function renderProgressCharts() {
  const el = document.getElementById('progressCharts');
  if (!S.history || S.history.length === 0) {
    el.innerHTML = '<p class="mut">Pas encore de données. Fais quelques séances.</p>';
    return;
  }
  const h = S.history;
  const forme = h.map(x => x.formAfter ?? x.formBefore ?? 70);
  const reaction = h.map(x => x.aggReactionMs).filter(x => x != null);
  const tap = h.map(x => x.aggTapMs).filter(x => x != null);
  const rpe = h.map(x => x.rpe);
  const volume = h.map(x => {
    return (x.sets || []).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
  });

  const chart = (label, vals, color, unit) => {
    if (vals.length < 2) {
      return `<div class="card-mini"><div class="mut" style="font-size:11px">${label}</div>
              <div class="stat" style="font-size:14px">${vals.length ? vals[vals.length-1] + (unit||'') : '—'}</div>
              <div class="mut" style="font-size:11px">Données insuffisantes</div></div>`;
    }
    const last = vals[vals.length - 1];
    const first = vals[0];
    const trend = last > first ? '↑' : (last < first ? '↓' : '→');
    return `<div class="card-mini">
      <div class="mut" style="font-size:11px">${label}</div>
      <div class="row" style="align-items:baseline;gap:6px"><div class="stat">${last}${unit||''}</div>
        <div class="mut" style="font-size:12px">${trend}</div></div>
      ${sparkline(vals, {width: 220, height: 48, color})}
    </div>`;
  };

  const prs = computePRs();
  const prRows = prs.slice(0, 5).map(p => {
    const val = p.timed ? `${p.held}s` : `${p.weight}kg × ${p.reps}`;
    return `<tr><td>${escapeHtml(p.name)}</td><td style="text-align:right">${escapeHtml(val)}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="charts-grid">
      ${chart('Score de forme', forme, '#2d9b83', '')}
      ${chart('Réaction post-effort', reaction, '#e8954d', 'ms')}
      ${chart('Tap test', tap, '#4a6bb0', 'ms')}
      ${chart('RPE ressenti', rpe, '#d89b2c', '/10')}
      ${chart('Volume (kg×reps)', volume, '#26408b', '')}
    </div>
    ${prs.length ? `<div class="mt10"><div class="mut" style="font-size:12px;margin-bottom:4px">🏆 Records personnels (top 5)</div>
      <table>${prRows}</table></div>` : ''}
  `;
}

function renderHistoryList() {
  const el = document.getElementById('histBody');
  if (!S.history || S.history.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
        </div>
        <div class="empty-state-title">Aucune séance encore</div>
        <div class="empty-state-msg">Lance ta première séance — tu verras ici tout ton historique avec les charges, le RPE et les ajustements.</div>
        <button type="button" class="magenta" id="emptyStateStartBtn">Démarrer ma première séance</button>
      </div>`;
    const startBtn = document.getElementById('emptyStateStartBtn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const fab = document.getElementById('fabStart');
        if (fab) fab.click();
      });
    }
    return;
  }
  el.innerHTML = S.history.slice().reverse().map(h => {
    const d = new Date(h.date);
    const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const pillCls = h.rpe <= 5 ? 'ok' : h.rpe <= 7 ? 'warn' : 'ko';
    return `<details><summary>${escapeHtml(dateStr)} — ${escapeHtml(h.title)} <span class="pill ${pillCls}">RPE ${h.rpe}</span></summary>
      <p class="mut">Réaction moy : ${h.aggReactionMs ?? '—'}ms · Tap test : ${h.aggTapMs ?? '—'}ms · Énergie ${h.energy}/5 · Humeur ${h.mood}/5</p>
      ${h.pains && h.pains.length ? `<p class="mut">Douleurs : ${escapeHtml(h.pains.join(', '))}</p>` : ''}
      ${h.note ? `<p class="mut">Note : ${escapeHtml(h.note)}</p>` : ''}
      <table><tr><th>Exo</th><th>Séries</th><th>Charge moy</th></tr>
      ${h.exos.map(e => {
        const sets = h.sets.filter(s => s.exoId === e.id);
        const w = avg(sets.map(s => s.weight).filter(x => x != null));
        const heldAvg = avg(sets.map(s => s.heldSecs).filter(x => x != null));
        const display = e.timed
          ? (heldAvg != null ? heldAvg + 's' : '—')
          : (w != null ? w + 'kg' : '—');
        return `<tr><td>${escapeHtml(e.name)}</td><td>${sets.length}/${e.sets}</td><td>${display}</td></tr>`;
      }).join('')}</table></details>`;
  }).join('');
}

// "Recommencer le questionnaire" — vraie réinitialisation du profil
// d'entraînement (pas du compte). Demande confirmation, puis efface le
// profil + la séance courante + les ajustements pour repartir d'un état
// vierge. L'historique des séances passées est conservé.
document.getElementById('resetOnbBtn').addEventListener('click', async () => {
  const ok = await openConfirm(
    'Recommencer le questionnaire ?',
    'Ton profil d\'entraînement actuel sera effacé (objectifs, matériel, niveau). Ton historique de séances et ton compte ne sont pas touchés.',
    { confirmLabel: 'Recommencer', cancelLabel: 'Annuler', danger: true, critical: true }
  );
  if (!ok) return;
  S.profile = null;
  S.currentSession = null;
  S.adjustments = [];
  queueSave();
  showToast('Profil réinitialisé', { variant: 'info', message: 'Réponds au questionnaire pour générer un nouveau programme.' });
  openOnboarding();
});

// escapeHtml : voir core.js.

/* =================== BOOT =================== */
function setHeaderSub(txt) { document.getElementById('hdrSub').textContent = txt; }

async function bootAuthenticated() {
  setHeaderSub('Chargement des données…');
  // Skeleton home pendant le fetch — donne un signal visuel de "ça charge"
  // au lieu d'un écran vide. Une fois les data arrivées, openHome() remplit
  // ces mêmes containers, le skeleton est écrasé sans flash.
  paintHomeSkeleton();
  show('viewHome');
  try {
    const resp = await api('GET', '/api/data');
    if (resp.data && typeof resp.data === 'object') {
      S = {
        profile: resp.data.profile || null,
        history: Array.isArray(resp.data.history) ? resp.data.history : [],
        currentSession: resp.data.currentSession || null,
        formScore: typeof resp.data.formScore === 'number' ? resp.data.formScore : 70,
        adjustments: Array.isArray(resp.data.adjustments) ? resp.data.adjustments : [],
        notes: (resp.data.notes && typeof resp.data.notes === 'object') ? resp.data.notes : {},
        // Rehab mode state (mode rééducation). Persisted server-side via the
        // `rehab` whitelist key. Shape : { active, injuryDate, zones,
        // manualPhase, acceptedDisclaimerAt, acceptedDisclaimerVersion }.
        rehab: (resp.data.rehab && typeof resp.data.rehab === 'object') ? resp.data.rehab : null,
        // Suivi corporel — poids + mensurations.
        // Shape : { weights: [{date, kg}], measurements: [{date, waistCm,
        // hipsCm, bicepsLCm, bicepsRCm, thighCm}] }.
        body: (resp.data.body && typeof resp.data.body === 'object') ? resp.data.body : null,
        // Périodisation par blocs (Issurin). Shape : { startDate, focus }.
        // null si l'utilisateur n'a pas activé la périodisation.
        macrocycle: (resp.data.macrocycle && typeof resp.data.macrocycle === 'object') ? resp.data.macrocycle : null,
        // todayGear is intentionally NOT persisted — it's a one-session override.
        todayGear: null,
      };
      // Legacy cleanup: older generations stored the "Démarre léger" hint on
      // bodyweight / no-weight exos. Strip any reason that no longer makes sense.
      // Skip for rehab sessions — their `reason` field carries the rééduc dose
      // (ex: "3 × 30s"), pas un hint d'overload, et doit rester intact.
      if (S.currentSession && Array.isArray(S.currentSession.exos) && S.currentSession.kind !== 'rehab') {
        for (const ex of S.currentSession.exos) {
          if (!ex.timed && !supportsWeight(ex.id)) ex.reason = null;
        }
      }
      // If the stored session contains exos the user no longer has the gear
      // for (e.g. we tightened the `needs` filter), regenerate it. Skip for
      // rehab sessions — leur library d'exos vit dans window.Rehab, pas
      // EX_BY_ID, donc cette validation rejetterait à tort tous les rehab.
      if (S.currentSession && S.profile && Array.isArray(S.currentSession.exos)
          && S.currentSession.kind !== 'rehab') {
        const userGear = new Set(S.profile.gear || []);
        const stillValid = S.currentSession.exos.every(ex => {
          const lib = EX_BY_ID[ex.id];
          if (!lib) return false;
          if (lib.needs && !lib.needs.every(g => userGear.has(g))) return false;
          if (!lib.gear.some(g => userGear.has(g))) return false;
          return true;
        });
        if (!stillValid) {
          S.currentSession = null;
        }
      }
    }
  } catch (e) {
    console.warn('load data failed', e);
  }
  if (currentUserEmail) {
    const p = S.profile;
    setHeaderSub(p
      ? `${currentUserEmail} · ${p.freq}×/sem · ${p.duration}min`
      : `${currentUserEmail} — nouveau compte`);
  }
  if (!S.profile) openOnboarding();
  else openHome();

  // Auto-sync physio en arrière-plan : si une intégration Oura est active
  // et qu'on n'a pas synchronisé depuis 12h+, on déclenche un sync
  // silencieux. N'a pas besoin de bloquer le boot.
  setTimeout(maybeAutoSyncPhysio, 1500);
}

async function maybeAutoSyncPhysio() {
  try {
    const integ = await physioFetchIntegrations();
    if (!integ || !integ.oura || !integ.oura.enabled) return;
    const last = integ.oura.lastSync ? Date.parse(integ.oura.lastSync) : 0;
    const ageH = (Date.now() - last) / 3600000;
    if (ageH < 12) return;
    physioSync(true); // silent
  } catch (_) { /* silencieux */ }
}

async function boot() {
  setHeaderSub('…');
  await refreshCSRF();
  try {
    const me = await api('GET', '/api/me');
    if (me.user) {
      currentUserEmail = me.user.email;
      currentUserIsAdmin = !!me.user.isAdmin;
      setAdminLinkVisible(currentUserIsAdmin);
      // Same gate as the post-login path: if the user hasn't enrolled
      // 2FA yet (and the server requires it), force enrollment first.
      // Otherwise bootAuthenticated will try /api/data and 403.
      if (me.user.needsEnroll2FA) {
        const enrolled = await forceEnroll2FA();
        if (!enrolled) return;
      }
      // RGPD art. 9 consent gate. Same logic as the post-login path: refuse
      // to load data until the user has explicitly consented to the
      // current policy version. We re-fetch /api/me after 2FA enrollment
      // because that path may have updated the user state.
      let meAfter = me;
      if (me.user.needsEnroll2FA) {
        try { meAfter = await api('GET', '/api/me'); } catch (_) { meAfter = me; }
      }
      if (meAfter && meAfter.user &&
          (!meAfter.user.healthConsent || !meAfter.user.healthConsent.given)) {
        const consented = await forceHealthConsent();
        if (!consented) return;
      }
      // Cache the algo-opt-out flag so the home view can hide adjustments
      // when the user has objected to automated decisions (art. 22).
      currentUserAlgoOptOut = !!(meAfter && meAfter.user && meAfter.user.algoOptOut);
      await bootAuthenticated();
      return;
    }
  } catch (_) {}
  setAdminLinkVisible(false);
  setHeaderSub('non connecté');
  show('viewAuth');
  setAuthMode('login');
}

// i18n : applique les traductions sur le DOM tagué [data-i18n] avant le boot
// applicatif. Les nœuds non tagués gardent leur texte français en dur
// (migration incrémentale, zéro régression).
try { if (window.i18n) { window.i18n.applyI18n(document); document.documentElement.setAttribute('lang', window.i18n.getLang()); } } catch (_) {}

boot();

/* =================== PWA / SERVICE WORKER =================== */
// Moved from an inline <script> in index.html to keep CSP strict
// (`script-src 'self'`) — no inline blocks, no hash/nonce churn.
//
// The SW caches the app shell (HTML, JS, icon, manifest) cache-first so the
// app boots instantly even on flaky gym wifi. API calls still go to the
// network; offline responses return a synthetic { offline: true } payload
// the client detects and surfaces to the user.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('SW registration failed:', err));
  });
}
