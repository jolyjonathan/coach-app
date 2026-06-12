/* =============================================================
 * Coach Adaptatif — core.js
 * =============================================================
 * Primitives PARTAGÉES entre l'app principale (app.js) et la SPA admin
 * (admin.js). Extrait lors de l'audit modularité (action 3) : ces trois
 * fonctions étaient dupliquées dans les deux fichiers, avec le risque
 * classique de la duplication sécurité — un correctif appliqué d'un côté
 * et oublié de l'autre.
 *
 *   - getCookie    : lecture de cookie, regex-échappée
 *   - csrfToken    : source UNIQUE de vérité pour les noms de cookies
 *                    CSRF (__Host- sur HTTPS, legacy sur HTTP) — c'est le
 *                    point que tout durcissement futur doit modifier
 *   - escapeHtml   : échappement XSS — l'implémentation canonique
 *
 * Script classique (pas de module ES) : symboles partagés via la portée
 * globale. DOIT être chargé avant app.js / admin.js.
 * ============================================================= */
'use strict';

function getCookie(name) {
  const m = document.cookie.match('(^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)');
  return m ? decodeURIComponent(m[2]) : null;
}

// csrfToken — lit le token CSRF double-submit. Préfère le cookie __Host-
// (durcissement HTTPS, audit M-03), retombe sur le nom legacy en HTTP.
function csrfToken() {
  return getCookie('__Host-coach_csrf') || getCookie('coach_csrf');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
