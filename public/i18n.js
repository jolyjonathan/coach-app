/* =============================================================
 * Coach Adaptatif — i18n.js
 * =============================================================
 * Fondation d'internationalisation. L'app est née 100% en français, en dur
 * dans le HTML/JS. Plutôt qu'une réécriture big-bang de 8000 lignes, on pose
 * le MÉCANISME maintenant et on migre les chaînes par lot.
 *
 * API :
 *   t('key', { name: 'Jo' })   → chaîne traduite, interpolation {name}
 *   setLang('en')              → bascule + persiste en localStorage
 *   getLang()                  → 'fr' | 'en' (auto-détecté au 1er lancement)
 *   applyI18n(root)            → traduit tous les [data-i18n] / [data-i18n-attr]
 *
 * Convention DOM (migration incrémentale) :
 *   <span data-i18n="home.greeting">Salut</span>
 *   <input data-i18n-attr="placeholder:form.email_ph">
 * applyI18n() est appelée au boot ; les nœuds non tagués gardent leur texte
 * français en dur (aucune régression pendant la migration).
 *
 * Fallback : clé absente dans la langue active → français → la clé elle-même.
 * Scripts classiques, portée globale, chargé tôt (avant app.js).
 * ============================================================= */
(function () {
  'use strict';

  // Dictionnaires. On démarre avec un socle représentatif (nav, actions
  // communes, états) — assez pour valider la chaîne complète et servir de
  // gabarit. Chaque lot de migration ajoute ses clés ici.
  const DICT = {
    fr: {
      'nav.today': 'Aujourd\'hui',
      'nav.trends': 'Tendances',
      'nav.coach': 'Coach',
      'nav.profile': 'Profil',
      'action.start': 'Démarrer',
      'action.cancel': 'Annuler',
      'action.save': 'Enregistrer',
      'action.confirm': 'Confirmer',
      'action.close': 'Fermer',
      'action.back': 'Retour',
      'state.offline': 'Hors ligne — les modifications seront synchronisées au retour du réseau.',
      'state.loading': 'Chargement…',
      'home.greeting': 'Salut',
      'home.today_session': 'Séance du jour',
      'session.validate_set': 'Valider la série',
      'session.rest': 'Repos',
      'trends.charge': 'Charge',
      'trends.force': 'Force',
      'trends.activity': 'Activité',
      'twofa.recovery_title': 'Codes de récupération',
      'twofa.recovery_noted': 'Je les ai notés',
    },
    en: {
      'nav.today': 'Today',
      'nav.trends': 'Trends',
      'nav.coach': 'Coach',
      'nav.profile': 'Profile',
      'action.start': 'Start',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'action.confirm': 'Confirm',
      'action.close': 'Close',
      'action.back': 'Back',
      'state.offline': 'Offline — changes will sync when the network is back.',
      'state.loading': 'Loading…',
      'home.greeting': 'Hi',
      'home.today_session': 'Today\'s session',
      'session.validate_set': 'Log set',
      'session.rest': 'Rest',
      'trends.charge': 'Load',
      'trends.force': 'Strength',
      'trends.activity': 'Activity',
      'twofa.recovery_title': 'Recovery codes',
      'twofa.recovery_noted': 'I\'ve saved them',
    },
  };

  const LS_KEY = 'coach_lang';
  let lang = detectLang();

  function detectLang() {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && DICT[saved]) return saved;
    } catch (_) { /* localStorage indispo */ }
    // Défensif : navigator peut être absent (VM de test, SSR).
    let code = 'fr';
    try {
      if (typeof navigator !== 'undefined' && navigator.language) {
        code = navigator.language.slice(0, 2).toLowerCase();
      }
    } catch (_) {}
    return DICT[code] ? code : 'fr';
  }

  function getLang() { return lang; }

  function setLang(l) {
    if (!DICT[l]) return;
    lang = l;
    try { localStorage.setItem(LS_KEY, l); } catch (_) {}
    try {
      applyI18n(document);
      document.documentElement.setAttribute('lang', l);
    } catch (_) { /* pas de DOM (VM de test) */ }
  }

  // t — traduit + interpole {placeholders}. Fallback fr → clé.
  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]);
    if (s == null) s = (DICT.fr && DICT.fr[key]);
    if (s == null) return key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    }
    return s;
  }

  // applyI18n — traduit le DOM tagué. Idempotent.
  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      // Format "attr:key" (un ou plusieurs séparés par ;).
      el.getAttribute('data-i18n-attr').split(';').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
  }

  window.i18n = { t, getLang, setLang, applyI18n, langs: Object.keys(DICT) };
  // Raccourci global pratique pour les call sites JS.
  window.t = t;
})();
