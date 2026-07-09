# Plan d'amélioration complet — Coach Adaptatif

**Date :** 9 juillet 2026
**Base :** relecture du code au 9 juillet + vérification de l'état des audits du 11-12 juin et des propositions.

---

## 0. État des lieux — ce qui est DÉJÀ réglé (vérifié dans le code)

Inutile d'y revenir, c'est fait et tracé :

| Item | Preuve |
|---|---|
| B1-B3 tests Go, CI verte | CI complète : Go+MariaDB, tests JS, e2e Playwright, smoke Docker |
| S1 secret webhook masqué dans les logs | `middleware.go:83` `[REDACTED]` |
| S2 cap bcrypt 72 octets | `auth.go:186` |
| S3 lockout par compte | `loginFails` par emailLower, `auth.go:408` |
| F1 + A1 : échelles unifiées + TRIMP réel via FC | `banister.js:41-88` |
| F2 code mort Oura retiré | `physio.go:175` |
| Strava `delete` + deauthorization | `strava.go:615-623` |
| A2 Epley+Mayhew+Lombardi, A3 calibration τ, A4 drift→bloc, A5 anomalie | présents dans `bayesian.js`/`banister.js`/`app.js` |
| Migration MariaDB (lift & shift) + `--import`/`--verify` | `sqlstore.go`, compose 2 services |
| ETag /api/data, ModelCache, storeFlusher, qrcode.js lazy, exercises-data.js extrait | vérifiés |
| Cookies `__Host-`, CSP stricte (sauf style-attr), distroless read-only, /metrics Prometheus | vérifiés |

Le plan ci-dessous porte donc sur **ce qui reste** et **ce qui vient après**. Priorités : 🔴 à faire d'abord · 🟠 important · 🟡 quand le temps le permet.

---

## 1. Correctifs & dette immédiate

### 🔴 1.1 Nettoyer le dossier de travail
Le repo local contient ~12 fichiers parasites : `*.go.<digits>` (backups d'éditeur : `auth.go.852013…`, `main.go.377179…`, etc.), le binaire `coach` (10 Mo), `coach-go-tmp-umask`, `.DS_Store`, `e2e/test-results/`. Ignorés par git ou pas, ils polluent les greps, les diffs d'audit et le contexte de tout outil. Supprimer + compléter `.gitignore` (`*.go.[0-9]*`, `.DS_Store`, `e2e/test-results/`, `e2e/node_modules/`). Effort : 15 min.

### 🔴 1.2 Mettre à jour la toolchain et les dépendances
`go.mod` : `go 1.22` — plus supportée depuis début 2025 (plus de correctifs sécurité stdlib, dont `net/http` et `crypto`). `golang.org/x/crypto v0.24.0` date de mi-2024. Passer à la dernière Go stable, `go get -u` des 3 deps, revalider la CI (image builder `golang:1.22-alpine` du Dockerfile à bumper aussi). Effort : ½ j avec la revalidation.

### 🟠 1.3 Épingler les images
`mariadb:lts` (compose + 3 jobs CI) est un tag mutable — le commentaire du compose le dit lui-même. Épingler une version précise, idéalement par digest ; `scripts/pin-images.sh` existe depuis l'audit M-01, il reste à l'exécuter et committer le résultat. Même chose pour `golang:*-alpine` et `distroless/static-debian12:nonroot`.

### 🟠 1.4 Chantier app.js (action 6 de l'audit modularité — toujours pas faite)
`app.js` = 380 Ko. `core.js` n'a que 1,6 Ko (l'extraction partagée app/admin est embryonnaire). Le plan de découpage IIFE par vue de l'audit du 12 juin reste valable tel quel : `session-engine.js`, `views-home.js`, `views-trends.js`, `views-profile.js`, `app.js` résiduel (boot/routing/auth). Incrémental, shippable à chaque étape, penser `SHELL_ASSETS` du SW et l'ordre de chargement de `run-tests.js`. Effort : 2-3 j. **À faire avant** le chantier CSP (1.5) car c'est l'occasion de convertir les `style="…"` en classes.

### 🟡 1.5 Éliminer `style-src-attr 'unsafe-inline'` (S5/M-02, dernier résidu CSP)
~380 attributs `style` générés. À traiter vue par vue pendant le découpage 1.4 : classes utilitaires pour les cas répétitifs, custom properties (`style` → `class` + `--w:42%` n'est pas possible sans attr — utiliser des paliers ou `<div class="bar" data-w>` + CSS) pour les largeurs dynamiques. Quand le compte tombe à 0, retirer la directive.

### 🟡 1.6 App struct Go (G1/G2 — reporté depuis juin)
Toujours `package main` + globals (les nouveaux `dbUsersWriteMu`/`dbSessWriteMu` en ont rajouté). La recommandation de juin tient : `type App struct { Users, Sessions, RateLim, DB… }` injectée dans les handlers, sans éclatement en packages. Gains : tests parallèles, fin des resets de maps dans le harnais. Effort : 2-3 j. À planifier avant que `auth.go` (39 Ko) ne grossisse encore.

---

## 2. Serveur, infra & ops

### 🔴 2.1 Sauvegardes MariaDB — LE gap critique post-migration
Avant : `users.json` + `.bak`, sauvegardable par rsync. Aujourd'hui : **toutes les données vivent dans un volume InnoDB et rien dans le compose ne les sauvegarde.** Un `down -v` accidentel, une corruption de volume ou un disque mort = perte totale.

À mettre en place :
- Service sidecar de dump : conteneur cron minimal qui exécute `mariadb-dump --single-transaction` vers un volume/bind dédié, quotidien, rétention 7 j + 4 hebdo.
- Chiffrement des dumps (`age` ou `gpg`) — ils contiennent bcrypt, TOTP chiffrés, tokens : les traiter comme les données elles-mêmes.
- Copie hors-machine (rclone vers un stockage tiers, ou simple rsync vers un second host).
- **Runbook de restauration testé** : un backup jamais restauré n'existe pas. Ajouter un test de restore périodique (même manuel, trimestriel).
- Cohérence RGPD art. 17 : documenter que l'effacement d'un compte devient effectif dans les dumps à expiration de la rétention (7-30 j) — c'est admis par les CNIL si documenté. Effort total : 1-1,5 j.

### 🟠 2.2 Borner et régler MariaDB
Le service `db` n'a **ni `deploy.resources.limits` ni configuration** : MariaDB par défaut peut consommer plusieurs centaines de Mo (buffer pool 128 Mo + threads + temp). La promesse « 200 Mo de RAM » du pitch ne couvre plus la stack réelle. Ajouter des limits (ex. 512 Mo) et un fichier de conf minimal (`innodb_buffer_pool_size` adapté, `max_connections` réduit — l'app n'a qu'un pool). Optionnel : `skip-name-resolve`, `performance_schema=OFF` pour la RAM.

### 🟠 2.3 Durcir le service db comme l'app
Le conteneur `coach-app` est exemplaire (read-only, cap_drop, no-new-privileges) ; `db` n'a rien de tout ça. Ajouter `security_opt: no-new-privileges`, `cap_drop` avec le minimum requis, et un réseau compose explicite à deux tiers si un reverse proxy est ajouté (proxy ↔ app ↔ db, le proxy ne voyant jamais db).

### 🟠 2.4 Supervision & alerting
`/api/admin/metrics` (Prometheus) existe mais rien ne le consomme. Proposition proportionnée au self-hosted :
- Uptime Kuma (ou Gatus) en conteneur optionnel `docker-compose.monitoring.yml` : ping `/healthz`, alerte ntfy/webhook.
- Si l'utilisateur a déjà Prometheus/Grafana : documenter le scrape (auth admin requise — prévoir un token de scrape dédié plutôt que session admin).
- Alertes minimales : app down, db down, disque > 85 %, échec du dump quotidien (2.1).

### 🟡 2.5 Compression HTTP en mode direct
En mode « sans reverse proxy » (défaut du compose), Go ne compresse pas : `app.js` part en 380 Ko au lieu de ~120. Soit un middleware gzip/zstd (~40 lignes stdlib-adjacent), soit documenter clairement que le mode direct est pour LAN et que l'exposition publique passe par Caddy (qui compresse). Le découpage 1.4 réduit aussi ce coût.

### 🟡 2.6 Logs structurés
`log.Printf` texte partout. Passer à `log/slog` (stdlib, zéro dépendance) en JSON : les logs deviennent requêtables (`docker logs | jq`), et ça prépare l'expédition vers Loki/journald proprement. Mécanique : ~½ j.

### 🟡 2.7 Divers ops
- `docker-publish.yml` : vérifier la signature/attestation de l'image publiée (cosign ou provenance GitHub).
- HSTS `preload` si domaine dédié (déjà noté en juin, toujours ouvert).
- Documenter la mise à jour MariaDB (mysql_upgrade auto de l'image, mais politique de bump à écrire).

---

## 3. Sécurité

### 🟠 3.1 Rotation de COACH_TOKEN_KEY (chemin v2 toujours absent)
L'enveloppe `ENC:v1:` est versionnée mais aucune procédure de rotation n'existe — une fuite de la clé aujourd'hui impose un script à la main. Implémenter une sous-commande `--rotate-key` : lit `COACH_TOKEN_KEY_OLD` + `COACH_TOKEN_KEY`, ré-encrypte `totp_secret`, `physio_tokens`, `recovery_codes` en transaction, écrit `ENC:v2:` (ou reste v1, le versionnage servant au format et non à la clé). Documenter dans SECURITY.md. Effort : 1 j avec tests.

### 🟠 3.2 Secrets Docker plutôt que variables d'environnement
`COACH_TOKEN_KEY`, `DB_PASSWORD`, `STRAVA_CLIENT_SECRET` transitent en env (visibles via `docker inspect` et `/proc/1/environ`). `getenvOrFile` existe déjà côté Go : ajouter les variantes `*_FILE` dans le compose avec `secrets:` et documenter. Effort : ½ j.

### 🟡 3.3 WebAuthn/Passkeys en second facteur alternatif
TOTP est solide mais phishable ; les passkeys ne le sont pas. C'est LA montée en gamme auth cohérente avec le public exigeant du projet. Coût : dépendance `github.com/go-webauthn/webauthn` (arbitrage supply-chain à assumer — première vraie dépendance non-stdlib avec le driver SQL), table `credentials`, UI d'enrôlement. Effort : 3-4 j. À faire après 1.6 (App struct) pour ne pas rajouter de globals.

### 🟡 3.4 CI sécurité
Manquent au workflow :
- `govulncheck ./...` (vulnérabilités Go connues — gratuit, 5 lignes de YAML) — **à ajouter dès maintenant**, d'autant plus critique avec Go 1.22 obsolète ;
- `staticcheck` ou `golangci-lint` (qualité + bugs) ;
- scan Trivy de l'image dans `docker-publish.yml` ;
- `gitleaks` (secrets committés) ;
- Dependabot/Renovate sur go.mod, actions GitHub et `e2e/package.json`.
Effort total : ½ j.

### 🟡 3.5 Intégrité des journaux d'audit
`auth-audit.log`/`admin-audit.log` sont en JSON Lines simple : un attaquant root peut les réécrire. Chaînage de hash (chaque ligne inclut `sha256(ligne précédente)`) = falsification détectable à coût quasi nul. Optionnel, mais aligné avec le positionnement conformité.

### 🟡 3.6 Rate-limit sur le webhook physio
Vérifier qu'un `POST /api/physio/webhook/{uid}/{secret}` avec secret invalide est compté/limité par IP (brute-force du secret 32-hex est irréaliste, mais le flood du endpoint mérite le même budget que `/api/login`).

---

## 4. Base de données — étape 2 après le lift & shift

### 🟠 4.1 Remplacer les snapshots DELETE+INSERT par des écritures ciblées
`sqlstore.go` l'assume : chaque save users/sessions **réécrit toute la table** en transaction. C'était le bon choix pour migrer sans toucher les call sites, mais sous MariaDB c'est du travail inutile et un point de contention (`dbUsersWriteMu`). Étape 2 : `saveUser(u)` / `deleteSession(sid)` en UPSERT/DELETE unitaires aux call sites de mutation (ils sont identifiés — 23 sites). Le storeFlusher peut alors disparaître pour users/sessions. Effort : 1-2 j. Prérequis naturel : 1.6 (App struct) pour le faire proprement.

### 🟡 4.2 Normalisation progressive du blob workouts
Conformément au plan de ESTIMATION-MIGRATION-SQL.md : extraire d'abord `body.physio` (le webhook merge ligne à ligne au lieu de lire/réécrire 512 Ko) puis `history` (pagination des tendances côté serveur, requêtes admin). Déclencheur : taille du blob ou besoin réel de requêtes — pas avant.

### 🟡 4.3 Audit logs en table
Optionnel : déplacer les deux journaux d'audit en tables (rotation par `DELETE WHERE ts < …`, requêtable pour les demandes art. 15). Les fichiers marchent ; c'est une simplification ops, pas une urgence.

---

## 5. Qualité, tests & CI

### 🟠 5.1 Couverture Go des deux plus gros fichiers
Toujours vrai depuis juin : `strava.go` (30 Ko) et `physio.go` (32 Ko) sont les moins testés (`strava_test.go` = 1,7 Ko, `physio_test.go` = 3,5 Ko). Cibles prioritaires : `parseAppleHealthAutoExport` (formats variables), `mergePhysioIntoData` (cap 2000, idempotence), le parsing d'events webhook Strava (create/update/delete/deauth), le refresh de token expiré.

### 🟠 5.2 Étendre les e2e Playwright
`smoke.spec.js` couvre le boot. Ajouter les parcours à forte valeur : enrôlement 2FA complet (secret → TOTP calculé en test → codes de récupération), log d'une séance avec sets + RPE, swap d'exercice sur douleur déclarée, offline (SW) → reconnexion → sync. Ce sont les parcours dont la régression serait invisible aux tests unitaires.

### 🟡 5.3 Seuil de couverture
`coverage.out` est uploadé mais rien ne casse si la couverture chute. Un gate simple (`go tool cover -func` + seuil ~70 % sur les fichiers touchés) ou Codecov.

### 🟡 5.4 Tests des modules JS restants
`run-tests.js` couvre les 6 modules scientifiques. `gamification.js` (11 Ko), `cycle.js`, `i18n.js` n'ont rien. Faible risque, mais gamification touche la motivation utilisateur — une régression de streak fâche.

### 🟡 5.5 Accessibilité — la passe manuelle
L'audit a11y du 12 juin s'arrête aux ~30 % automatisables et le dit lui-même : passage VoiceOver/NVDA + clavier seul requis avant ouverture grand public. Ajouter éventuellement `@axe-core/playwright` dans les e2e pour le régressif automatique.

---

## 6. Fonctionnalités — dans la philosophie du projet

Chaque proposition garde la ligne : modèle validé, invisible, pourquoi sourcé, zéro dépendance cloud.

### 🟠 6.1 Notifications Web Push self-hosted
La PWA existe (SW, manifest) mais ne peut rien rappeler. Web Push avec VAPID est 100 % self-hosted (pas de Firebase) : rappel de séance planifiée, alerte deload proposé par le drift Kalman (A4 est branché — mais l'utilisateur ne le voit que s'il ouvre l'app), rappel de saisie readiness le matin. Backend : ~200 lignes Go + une lib ECDH ou implémentation stdlib. C'est la feature qui transforme le coach de « consulté » en « proactif ». Effort : 2-3 j.

### 🟠 6.2 Bilan de fin de bloc (mesocycle review)
À la clôture d'un bloc Issurin : rapport généré — tonnage par groupe vs MEV/MAV/MRV, delta 1RM Kalman avec IC début/fin de bloc, adhérence (séances faites/planifiées), corrélation TSB↔readiness du bloc, et la recommandation motivée pour le bloc suivant. Toutes les données et modèles existent ; c'est un travail de synthèse + rendu. Forte valeur perçue, zéro science nouvelle. Effort : 2 j.

### 🟡 6.3 Filtre matériel / mode voyage
Le swap engine sait déjà remplacer un exercice (douleur). Généraliser en filtre d'équipement disponible (« haltères seulement », « poids du corps », « hôtel ») : la séance du jour est régénérée dans la même intention de bloc avec le matériel déclaré. `exercises-data.js` doit porter un champ `equipment` par exercice. Effort : 1-2 j.

### 🟡 6.4 Export lisible (CSV) en plus de l'export RGPD JSON
L'export art. 20 est un blob JSON. Un export CSV par domaine (history à une ligne par set, physio à une ligne par jour) rend les données exploitables dans un tableur — cohérent avec le public data-driven. Effort : ½ j.

### 🟡 6.5 Connecteurs additionnels
Oura + Strava + Apple Health (AHAE) couvrent déjà beaucoup. Candidats par ordre de demande probable : **Garmin** (Health API — dossier développeur requis), **intervals.icu** (API simple, publique, gratuite — bon rapport effort/valeur pour les hybrides muscu+endurance), Polar AccessLink. Architecture physio_tokens/webhook déjà généralisée : coût marginal par connecteur ~2-3 j.

### 🟡 6.6 Gestion de conflit multi-appareils
ETag + If-Match protègent contre l'écrasement, mais que voit l'utilisateur en cas de 412 (séance loggée sur téléphone ET tablette hors-ligne) ? Vérifier le parcours et, si besoin, un merge simple côté client (union des sets par timestamp) plutôt qu'un « recharge et perds ». Effort : selon l'existant, 1-2 j.

### 🟡 6.7 Compléter l'i18n
`i18n.js` = 5 Ko pour une app de 380 Ko : la couverture est nécessairement partielle. Si l'anglais est un objectif (audience self-hosted internationale sur GitHub), inventorier les chaînes en dur dans app.js pendant le découpage 1.4 — c'est le moment ou jamais.

---

## 7. RGPD & conformité (compléments)

- 🟠 **Politique de rétention des backups** (cf. 2.1) : à écrire dans privacy.html — délai d'effacement effectif dans les dumps.
- 🟡 Registre des traitements minimal (modèle CNIL) dans le repo — utile aux self-hosters européens qui l'exposent à des tiers.
- 🟡 L'export art. 20 doit inclure les données physio ingérées (à vérifier) et les logs d'audit concernant l'utilisateur (art. 15).

---

## 8. Roadmap proposée

| Phase | Contenu | Effort |
|---|---|---|
| **P0 — cette semaine** | 1.1 nettoyage · 1.2 Go/deps à jour · 3.4 govulncheck+Dependabot · 2.1 **backups MariaDB** | ~2,5 j |
| **P1 — ce mois** | 1.3 pin images · 2.2/2.3 durcir db · 3.1 rotation clé · 3.2 secrets · 2.4 alerting · 5.1 tests strava/physio | ~5 j |
| **P2 — chantiers de fond** | 1.4 découpage app.js (+1.5 CSP +6.7 i18n dans la foulée) · 1.6 App struct · 4.1 écritures ciblées | ~7-9 j |
| **P3 — produit** | 6.1 Web Push · 6.2 bilan de bloc · 5.2 e2e étendus | ~6 j |
| **P4 — au fil de l'eau** | 6.3-6.6 features · 3.3 passkeys · 4.2 normalisation · 5.3-5.5 · 3.5-3.6 | opportuniste |

**Le point unique à retenir : les sauvegardes MariaDB (2.1).** Toute la valeur du projet — historique, calibrations, confiance de l'utilisateur — vit désormais dans un volume Docker que rien ne sauvegarde. Tout le reste peut attendre une semaine ; pas ça.

## Ce qu'il ne faut toujours PAS faire

Inchangé depuis juin : pas de framework front, pas de bundler, pas d'éclatement du Go en micro-packages. S'y ajoute : ne pas re-migrer vers SQLite/Postgres — MariaDB est en place et testée en CI, le coût d'un second déménagement dépasserait ses bénéfices ; assumer le choix et le fiabiliser (backups, limits, pinning).
