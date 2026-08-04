/* Coach Adaptatif — service worker.
 *
 * Three-cache strategy:
 *  - "shell" : static files (HTML, JS, CSS inline in HTML, manifest, icons).
 *    Cache-first — we want the app to open instantly and work offline in the
 *    gym where wifi is bad. The SHELL_VERSION bust forces a clean re-download
 *    on deploy (change the constant and the old cache is wiped on activate).
 *
 *  - "data"  : GET responses for /api/me and /api/data. Network-first with
 *    cache fallback so the app keeps working when the user is offline. We
 *    intentionally don't cache /api/csrf (token must be fresh — using a stale
 *    token would 403 every write) and we don't cache list-style endpoints
 *    like physio integrations (unbounded growth). Cached /api/me is
 *    invalidated by the client on logout (caches.delete on the data cache)
 *    so a logged-out user can't see the previous user's identity offline.
 *
 *  - Other /api/* : NOT cached. Writes (POST/PUT/DELETE) always pass through.
 *    Reads that aren't /api/me or /api/data go through network and return a
 *    synthetic 503 {offline:true} on failure (the existing client behavior).
 *
 * On offline cache hits we add an X-Coach-Stale: 1 response header so the
 * api() helper knows to keep the offline banner up even though the response
 * is technically a 200.
 *
 * We deliberately do NOT intercept POST/PUT/DELETE. Writes always go to the
 * network; failure propagates to the client which surfaces a toast.
 */

// Bump à v4 : ajout de /static/app.css extrait de index.html (audit M-02).
// L'ancienne cache v3 servait l'index.html qui contenait le CSS inline →
// l'écraser pour que tout le monde récupère le nouveau bundle HTML+CSS séparé.
// Bump à v7 : découpage modularité (core.js, exercises-data.js,
// gamification.js extraits d'app.js ; qrcode.js désormais chargé à la
// demande mais conservé dans le shell pour l'enrôlement 2FA hors-ligne).
// Bump à v8 : ajout de blockreview.js (bilan de fin de bloc Issurin).
const SHELL_VERSION = 'coach-shell-v10';
const DATA_VERSION  = 'coach-data-v1';

// Tous les JS et CSS chargés par index.html doivent être ici, sinon offline
// foire à la première visite avant que la cache opportuniste ait eu le temps
// de les chopper. Liste à garder synchro avec les <link> et <script src> du HTML.
const SHELL_ASSETS = [
  '/',
  '/static/app.css',
  '/static/i18n.js',
  '/static/core.js',
  '/static/exercises-data.js',
  '/static/gamification.js',
  '/static/app.js',
  // qrcode.js n'est plus chargé au boot (lazy via ensureQRCodeLib) mais
  // reste précaché pour que l'enrôlement 2FA fonctionne hors-ligne.
  '/static/qrcode.js',
  '/static/rehab.js',
  '/static/snacks.js',
  '/static/programming.js',
  '/static/bayesian.js',
  '/static/banister.js',
  '/static/science.js',
  '/static/cycle.js',
  '/static/blockreview.js',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  // Precache the shell. We call skipWaiting so the new SW takes control on the
  // next load instead of waiting for all tabs to close.
  event.waitUntil(
    caches.open(SHELL_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Purge old shell caches when we bump SHELL_VERSION. On garde les caches
  // de data (DATA_VERSION) — bumper SHELL_VERSION ne doit pas faire perdre
  // à l'utilisateur sa copie offline de /api/data.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('coach-shell-') && k !== SHELL_VERSION)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Le client envoie ce message au logout pour purger les caches user-scoped.
// Évite qu'un utilisateur déconnecté qui passe offline voie l'identité +
// les data du précédent utilisateur de la machine.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-data-cache') {
    event.waitUntil(caches.delete(DATA_VERSION));
  }
});

// isCacheableData : true pour les GETs qu'on veut conserver afin de
// supporter le mode offline. /api/csrf est volontairement exclu — un
// token expiré rejetterait toute écriture avec un 403, pire UX qu'une
// boucle "online uniquement".
function isCacheableData(pathname) {
  return pathname === '/api/me' || pathname === '/api/data';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // We only handle GET. Writes pass through untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (YouTube embed, etc.) → let the browser handle directly.
  if (url.origin !== self.location.origin) return;

  // API calls
  if (url.pathname.startsWith('/api/')) {
    if (isCacheableData(url.pathname)) {
      // Network-first avec fallback cache. Dès qu'on a une réponse réseau
      // 200, on la met en cache pour la prochaine fois ; si le réseau échoue
      // ou renvoie autre chose qu'un 200, on tente le cache.
      event.respondWith(
        fetch(req).then((resp) => {
          if (resp && resp.ok && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(DATA_VERSION).then((cache) => cache.put(req, copy));
          }
          return resp;
        }).catch(() => caches.match(req).then((cached) => {
          if (cached) {
            // Renvoie une copie de la réponse cachée avec un header marqueur
            // que le client utilise pour garder la bannière offline visible.
            // Response est immuable, on doit cloner avec de nouveaux headers.
            return cached.clone().blob().then((body) => {
              const headers = new Headers(cached.headers);
              headers.set('X-Coach-Stale', '1');
              return new Response(body, {
                status: cached.status,
                statusText: cached.statusText,
                headers,
              });
            });
          }
          // Aucun cache disponible — fallback sur le 503 offline générique
          // pour que la bannière apparaisse et que le client distingue
          // "pas de données" de "données stale".
          return new Response(
            JSON.stringify({ error: 'offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }))
      );
      return;
    }
    // Autres endpoints API : network-only, fallback 503 générique.
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: 'offline', offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // Admin SPA and its assets: network-first with shell fallback. Admin is
  // lower-traffic, we'd rather hit the network but survive offline.
  if (url.pathname === '/admin' || url.pathname.startsWith('/static/admin')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((c) => c || Response.error()))
    );
    return;
  }

  // Shell (HTML, JS, manifest, icon) → cache-first, update in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchAndUpdate = fetch(req).then((resp) => {
        // Only cache successful same-origin basic responses.
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(SHELL_VERSION).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => cached || Response.error());
      return cached || fetchAndUpdate;
    })
  );
});
