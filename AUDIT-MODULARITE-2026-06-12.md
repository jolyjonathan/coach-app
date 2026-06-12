# Audit modularité & efficacité — Coach Adaptatif

**Date :** 12 juin 2026
**Périmètre :** backend Go (6 561 lignes, 15 fichiers), frontend JS (15 080 lignes, 9 fichiers), mesures chiffrées à l'appui.

---

## Verdict rapide

L'architecture a **deux visages**. Les modules scientifiques JS (`banister`, `bayesian`, `science`, `programming`, `rehab`, `snacks`) sont exemplaires : purs, sans dépendance, testables, interfaces claires via `window.X`. Le backend Go est correctement découpé par domaine mais vit dans un seul package avec 22 variables globales. Et au milieu trône **`app.js` : 8 851 lignes**, un god-file qui concentre 30 sections, 263 `getElementById`, 338 accès à l'état global `S` et 65 `innerHTML`.

L'efficacité est **bonne pour l'échelle visée** (auto-hébergé, quelques utilisateurs) avec deux vraies réserves : la stratégie « réécrire tout le fichier JSON à chaque mutation » côté Go, et des recalculs de modèles redondants à chaque rendu côté client.

---

## 1. Modularité — Backend Go

### Ce qui fonctionne

Le découpage **par fichier-domaine** est lisible et discipliné : `auth.go` (1 115 l), `physio.go` (1 049 l), `strava.go` (885 l), `admin.go`, `session.go`, `data.go`, `middleware.go`, `totp.go`, `helpers.go`. Chaque fichier a un en-tête qui documente son contrat, ses endpoints et sa posture sécurité. Les helpers (`writeJSONAtomic`, `encryptToken`, `getenvOrFile`, `hashEmailForLog`) sont de vraies primitives réutilisées partout. Le TOTP fait main (~140 lignes stdlib) est un bon arbitrage supply-chain.

### Les limites structurelles

**G1 — Un seul package, zéro interface.** Tout est `package main`. Aucune frontière compilée n'empêche `strava.go` de toucher `usersByID` directement (il le fait). Conséquences concrètes : impossible de tester un domaine isolément, impossible de réutiliser le store ailleurs, et le graphe de dépendances réel n'est visible nulle part.

**G2 — 22 variables globales protégées par 7 mutex.** `usersByID/usersByEm/usersMu`, `sessions/sessionsMu`, `rlMap/rlMu`, `totpLastUsed`, `pending2FA`, `stravaPendingStates`, `stravaAthleteIndex`, `loginFails`… C'est cohérent et correctement verrouillé (les copies sous RLock sont rigoureuses), mais c'est la raison directe pour laquelle **les tests ne peuvent pas tourner en `-parallel`** (le commentaire de `testhelpers_test.go` l'admet) et pour laquelle on a dû ajouter un reset de 6 maps dans le harnais (audit précédent, B3).

**G3 — Couplage croisé entre domaines.** `strava.go` et `physio.go` écrivent tous deux dans `User.PhysioTokens` sous le duo `physioMu`+`usersMu` (ordre d'acquisition à maintenir à la main — un futur contributeur qui inverse l'ordre crée un deadlock). `mergePhysioIntoData` (physio) est appelé par strava ; `stravaStatusForUser` (strava) est appelé par physio. Ces deux fichiers sont en réalité un seul module « intégrations » non déclaré.

### Recommandation Go (sans casser le mono-binaire)

Le mono-binaire est un choix produit assumé — il ne faut pas le sacrifier. La cible raisonnable est une **struct d'application injectée** plutôt qu'un éclatement en packages :

```go
type App struct {
    Users    *UserStore     // encapsule usersByID/usersByEm/usersMu + save
    Sessions *SessionStore
    RateLim  *RateLimiter
    ...
}
func (a *App) handleLogin(w, r) { ... }
```

Gains : tests parallélisables (un `App` neuf par test, plus de reset de globals), frontières explicites, et le couple physio/strava peut devenir un `IntegrationsService` avec un seul mutex. Effort : mécanique mais volumineux (~2-3 jours) ; à faire avant que le fichier `auth.go` ne dépasse 1 500 lignes, pas après.

---

## 2. Modularité — Frontend

### Ce qui fonctionne (et qu'il faut protéger)

Les 6 modules scientifiques sont la meilleure partie du codebase : IIFE pures, zéro DOM, zéro dépendance, export unique sur `window`, testables en VM Node (104 tests). La séparation `admin.js` (398 l) / `app.js` est saine. Le choix « pas de framework, pas de bundler » est cohérent avec la philosophie du projet.

### Le problème : app.js, 8 851 lignes

**F1 — God-file assumé mais devenu ingérable.** 30 sections (`API CLIENT`, `MODAL`, `AUTH FLOW`, `EXERCISE LIBRARY`, `PROGRAM GENERATOR`, `GAMIFICATION`, `HOME`, `SESSION`…), des fonctions de 100 à 430 lignes (`renderSession` 430 l, `renderScienceCard` 322 l, `renderInsights` 304 l). Le coût n'est pas théorique : chaque modification impose de naviguer un fichier de 404 Ko, et les conflits de merge y sont maximaux.

**F2 — Duplication app.js ↔ admin.js.** `api()` (client fetch + CSRF + gestion erreurs) et `escapeHtml`/`esc` sont implémentés deux fois, avec de légères divergences (la version admin ne gère pas l'offline). Toute correction de sécurité sur l'un doit être reportée à la main sur l'autre.

**F3 — Données dans le code.** La bibliothèque d'exercices (~330 lignes de structures dans la section `EXERCISE LIBRARY`) est du **contenu**, pas de la logique. Embarquée dans app.js, elle est invisible aux non-développeurs et gonfle le fichier le plus chaud du projet.

**F4 — État global muté partout.** `S` est lu/écrit en 338 points, le contrat « quelles fonctions mutent quoi » n'existe que par convention (`queueSave()` après mutation). Ça marche grâce à la discipline des commentaires, mais c'est le terrain classique des régressions silencieuses.

### Recommandation frontend (sans bundler)

Découper app.js en **fichiers IIFE chargés en séquence**, exactement le pattern déjà éprouvé des modules scientifiques — zéro build step, CSP inchangée :

| Fichier cible | Contenu | ~lignes |
|---|---|---|
| `core.js` | api(), escapeHtml, toast, modal, haptic — partagé avec admin.html | 600 |
| `exercises-data.js` | bibliothèque d'exercices (données pures) | 350 |
| `session-engine.js` | generateSession, logSet, ordre, swap, étirements | 1 200 |
| `views-home.js`, `views-trends.js`, `views-profile.js` | renderers par onglet | ~3×900 |
| `app.js` (résiduel) | boot, routing, auth flow | 1 500 |

Points d'attention : mettre à jour `SHELL_ASSETS` du service worker et l'épilogue du harnais de test (`run-tests.js` ré-expose les symboles top-level — il devra charger les nouveaux fichiers dans l'ordre). Découpage faisable par fichier, incrémental, shippable à chaque étape.

---

## 3. Efficacité — Backend Go

### Mesures

L'empreinte revendiquée (200 Mo RAM, mono-binaire) est tenue : maps en mémoire O(1) sur les chemins chauds, `bcrypt` borné par le rate-limit, sliding session throttlé à 1 write-lock/heure/session. Bien.

### E1 — Réécriture intégrale du JSON à chaque mutation (le vrai sujet)

`saveUsers()` est appelé depuis **23 sites**, et chaque appel sérialise et réécrit **tous** les utilisateurs (`writeJSONAtomic` : tmp + fsync + rename). Idem `saveSessions()` à chaque login/logout/expiration. 28 de ces appels sont des `go save…()` — **une goroutine par sauvegarde, sans coalescing** : trois mutations rapprochées = trois réécritures complètes concurrentes du même fichier (sérialisées par le rename atomique, mais le travail est fait trois fois).

À 5 utilisateurs c'est invisible. À 200 utilisateurs avec webhooks physio actifs, ça devient des dizaines de réécritures/minute d'un fichier qui grossit linéairement. **Fix simple et suffisant** : un flusher unique avec dirty-flag (`markUsersDirty()` → goroutine qui flush au plus toutes les 2 s + au shutdown). C'est exactement le pattern déjà utilisé pour `rateLimitSnapshotter` — il suffit de le généraliser. Une base SQLite serait l'étape d'après, mais elle n'est pas nécessaire tant que le flusher tient.

### E2 — Lecture/parse du data file utilisateur par requête

`GET /api/data` relit et re-parse le JSON complet (jusqu'à 512 Ko) à chaque appel ; le webhook physio fait lecture + merge + réécriture par batch. Acceptable (1 lecture/boot d'app client, cache SW côté client), mais le `json.Unmarshal` vers `any` suivi d'un ré-encode est du travail pur de validation. Optimisation disponible si besoin : valider une fois puis servir les octets bruts avec un ETag (304 gratuits — le client SW sait déjà les exploiter).

### E3 — Micro-points

Corrects en l'état : un seul `http.Client` partagé pour l'outbound (réutilisation des connexions), `MaxBytesReader` partout, janitors avec ticker plutôt que polling agressif. Seule scorie : `viewOfUser` fait un `os.Stat` par utilisateur dans `handleAdminListUsers` — O(n) syscalls sur la liste admin, négligeable en deçà de quelques milliers de comptes.

---

## 4. Efficacité — Frontend

### Mesures de transfert

| Ressource | Brut | Gzip |
|---|---|---|
| app.js | 404 K | **124 K** |
| app.css | 72 K | 18 K |
| index.html | 60 K | 15 K |
| qrcode.js | 56 K | 12 K |

124 K gzip de JS pour une app de cette richesse reste raisonnable (un bundle React de base dépasse ça avant la première ligne métier). Deux gains faciles : **qrcode.js est chargé à chaque visite alors qu'il ne sert qu'à l'enrôlement 2FA** (~une fois par utilisateur, 12 K gzip économisables en le chargeant dynamiquement) ; et le découpage F1 ci-dessus rendra le cache du SW plus granulaire (modifier une vue n'invalidera plus 404 K).

### E4 — Recalculs de modèles redondants à chaque rendu (le vrai sujet)

À l'ouverture de l'onglet Tendances, le coût se cumule :

- `renderLoadRiskBlock` (deload advisor) exécute `Bayesian.computeState` pour ≤ 6 key lifts ;
- `renderMiniCharts` refait `computeState` pour les mêmes lifts (forecasts) ;
- chaque `computeState` avec l'ajustement fatigue appelle `Banister.computeAll` pour chaque jour distinct d'observation — O(jours × historique) ;
- `trajectory(42, 1)` = 43 appels `computeAll`, `bestTestWindow` = 15 de plus.

Pour 2-3 ans d'historique (~600 entrées), l'ensemble reste sous ~100 ms sur desktop, mais sur un téléphone milieu de gamme on approche la frame perceptible, **et le travail est fait deux fois** (advisor + forecasts). Le remède existe déjà dans le codebase : la mémoïsation par clé `(history.length, lastDate)` introduite pour `getCalibration`. L'étendre en un petit `ModelCache` partagé (states Kalman par exo, computeAll du jour, monotony/acwr) éliminerait la redondance sans changer une ligne d'API.

### E5 — Rendu DOM

`innerHTML` par carte (65 sites) : remplacement intégral à chaque rendu. À cette échelle c'est le bon choix (pas de VDOM, pas de diffing à maintenir) — aucun listener n'est perdu grâce à la délégation document-level (steppers, chips). Les deux seuls points coûteux sont les SVG reconstruits par chaîne à chaque rendu (mini-charts, heatmap 112 cases) — invisible en pratique, à laisser tel quel.

---

## 5. Plan d'action priorisé

| # | Action | Effort | Gain |
|---|---|---|---|
| 1 | **Flusher dirty-flag** pour saveUsers/saveSessions (généraliser le pattern rateLimitSnapshotter) | ½ j | Efficacité disque ×N, plus de goroutine-par-save |
| 2 | **ModelCache frontend** clé `(length, lastDate)` pour computeState/computeAll partagés entre advisor et forecasts | ½ j | Tendances ~2× plus rapide sur mobile, code dédupliqué |
| 3 | **core.js partagé** app/admin (api, escapeHtml, toast) — supprime la duplication F2 | ½ j | Une seule implémentation de sécurité client |
| 4 | **exercises-data.js** : sortir la bibliothèque d'exercices des 8 851 lignes | ½ j | app.js −350 l, contenu éditable isolément |
| 5 | **qrcode.js en chargement dynamique** (enrôlement 2FA uniquement) | ¼ j | −12 K gzip au boot pour 100 % des visites |
| 6 | Découpage app.js en fichiers IIFE par vue (F1) — incrémental | 2-3 j | Maintenabilité, cache SW granulaire, merges sereins |
| 7 | `App struct` Go injectée dans les handlers (G1/G2) | 2-3 j | Tests parallèles, frontières compilées |
| 8 | ETag sur GET /api/data (E2) | ¼ j | 304 gratuits, surtout utile en 4G |

Les actions 1 à 5 tiennent dans une journée et demie et capturent l'essentiel du gain. 6 et 7 sont des chantiers de fond à planifier ; 8 est un bonus.

---

## Ce qu'il ne faut PAS faire

Introduire un framework ou un bundler (la philosophie « frontend sans framework, déployable en une commande » est un vrai différenciateur et le pattern IIFE couvre le besoin) ; migrer vers une base de données tant que le flusher suffit (le JSON sur disque est auditable, sauvegardable par rsync, et conforme à la promesse self-hosted) ; éclater le Go en micro-packages cosmétiques sans passer par l'App struct (on perdrait la simplicité sans gagner la testabilité).
