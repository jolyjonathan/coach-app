# Architecture · Coach Adaptatif

Document technique détaillé. Pour le quickstart et les variables d'env, voir
[README.md](README.md).

## Diagramme de modules

```
                          ┌───────────────────────────┐
                          │   Reverse proxy (nginx)   │
                          │       TLS, gzip, etc.     │
                          └─────────────┬─────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │   Coach Adaptatif (Go)    │
                          │      net/http stdlib      │
                          └─┬───────────────────────┬─┘
                            │                       │
              ┌─────────────▼─────┐    ┌────────────▼──────────┐
              │   Static FS       │    │      JSON files        │
              │  /public/*        │    │  /data/users.json      │
              │                   │    │  /data/workouts/*.json │
              └─────────┬─────────┘    │  /data/admin-audit.log │
                        │              └────────────────────────┘
              ┌─────────▼─────────┐
              │   Frontend SPA    │
              │  app.js + modules │
              └─────────┬─────────┘
                        │
       ┌────────────────┼─────────────────────────────────┐
       │                │                                  │
   ┌───▼────┐      ┌────▼─────┐                       ┌────▼─────────┐
   │ rehab  │      │  snacks  │                       │  programming │
   │ 36 exos│      │ 13 mini  │                       │  Israetel +  │
   │  9 zones│     │ routines │                       │   Issurin    │
   └────────┘      └──────────┘                       └────┬─────────┘
                                                            │
                              ┌─────────────────┐           │
                              │   bayesian      │◄──────────┘
                              │  Kalman 2D 1RM  │ (qScale via responder)
                              └────┬────────────┘
                                   │
                              ┌────▼────────────┐
                              │   banister      │
                              │  fitness-fatigue│
                              │  + readiness    │
                              └────┬────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                │                                      │
        ┌───────▼──────────┐                  ┌────────▼─────────┐
        │  Manual physio   │                  │  Outbound APIs   │
        │  CSV import      │                  │  Oura → /v2/...  │
        │  Webhook push    │◄─────────────────│  (chiffré token) │
        └──────────────────┘                  └──────────────────┘
```

## Couche backend Go

### Fichiers et responsabilités

| Fichier | Lignes | Rôle |
|---------|--------|------|
| `main.go` | ~210 | Bootstrap, routing, lifecycle, signal handling |
| `auth.go` | ~750 | Users, sessions, login, register, change-pw, 2FA, consent, opt-out |
| `admin.go` | ~440 | Admin API CRUD users, audit log, rotation 12 mois |
| `data.go` | ~250 | Persistence data file utilisateur, whitelist keys, export RGPD |
| `physio.go` | ~450 | Intégrations Oura, webhook, Apple Health Auto Export |
| `session.go` | ~240 | Cookies session + CSRF |
| `middleware.go` | ~160 | Security headers (CSP), access log, body cap, recovery |
| `totp.go` | ~100 | RFC 6238 implémentation TOTP |
| `helpers.go` | ~80 | writeJSON, hashEmailForLog, encrypt/decrypt AES-GCM |

### Flux de requête typique (PUT /api/data)

```
Client → maxBody(1MiB) → secureHeaders → accessLog → recoverPanic →
  rateLimit("data", ...) → requireAuth (csrf + session) →
  require2FA (gate sur TOTPSecret) → handleSaveData (whitelist + atomic write)
```

### Concurrence

- Lecture des users : `usersMu` RWMutex.
- Écriture sessions : `sessionsMu` RWMutex.
- Écriture data file par user : `userFileLocks` (one mutex per uid via `sync.Map`).
- Audit log : `auditMu` mutex global (write rare).
- Rate limiter : `rlMu` mutex global, map en mémoire (perdu au restart).
- Tokens physio : `physioMu` global pour les writes sur User.PhysioTokens/LastSync.

Multi-instance (multiple replicas) n'est pas supporté en l'état :
- les sessions sont en mémoire,
- le rate limiter est local,
- le data file est sur disque local.

Pour scale horizontalement il faudrait migrer ces trois vers un store partagé
(Redis pour sessions + rate limit, S3/NFS/EFS pour data files).

### Persistance atomique

`writeJSONAtomic(path, v, mode)` :
1. Si fichier existant > 24h : copie en `.bak` (best-effort).
2. Écrit dans `path.tmp`.
3. `f.Sync()` pour flush disk.
4. `os.Rename(path.tmp, path)` — atomique sur même filesystem.

Le `.bak` quotidien permet une restauration manuelle si le data file est
corrompu côté client (write erroné qui efface l'historique). Une seule
génération de backup — pas de rotation N=7.

### Audit log et rotation

`/data/admin-audit.log` est NDJSON, chaque mutation admin écrit une ligne
sous mutex. Janitor goroutine `startAuditJanitor()` :
- Check immédiat au boot.
- Toutes les 24h, lit la première ligne du log et compare le timestamp à
  `auditMaxAge = 365 * 24h`.
- Si plus vieux : rename en `.archive-YYYYMMDD`, redémarre un fichier vide.

Les `.archive-*` ne sont pas auto-supprimés — l'opérateur décide. Conforme
aux recommandations CNIL pour les logs d'accès admin (12 mois).

## Couche frontend SPA

Pas de bundler. Les modules sont des `<script>` ordonnés dans `index.html` :

```html
<script src="/static/qrcode.js"></script>
<script src="/static/rehab.js"></script>
<script src="/static/snacks.js"></script>
<script src="/static/programming.js"></script>
<script src="/static/bayesian.js"></script>
<script src="/static/banister.js"></script>
<script src="/static/app.js"></script>
```

Chacun s'auto-encapsule dans une IIFE et expose un namespace sur `window`
(`window.Rehab`, `window.Snacks`, `window.Programming`, `window.Bayesian`,
`window.Banister`). `app.js` les consomme à la demande.

### State côté client

`let S = { profile, history, currentSession, formScore, adjustments,
notes, rehab, body, macrocycle, todayDuration, todayGear, todayEnergy }`

- `profile`, `history`, `currentSession`, `formScore`, `adjustments`,
  `notes`, `rehab`, `body`, `macrocycle` : persistés via `PUT /api/data`
  (whitelist top-level dans `data.go`).
- `todayDuration`, `todayGear`, `todayEnergy` : persistés en `localStorage`
  avec date-stamp (reset à minuit). Volontairement device-local.

### CSP et chargement de scripts

`script-src 'self'` interdit l'inline. Tous les modules sont des fichiers
séparés. Les iframes YouTube ne sont chargés qu'au clic explicite (lazy
load) pour ne pas leak l'IP utilisateur à Google sans intention.

## Modèles statistiques

### Niveau 1 : règles simples
- `modFromForm()` : ajuste sets/reps/repos par seuils sur `formScore`.
- `progressiveWeight()` : +2.5 / -2.5 kg selon RPE de la dernière fois.
- Generation : pickGroups rotation A/B/C/D + filter par gear/pain.

### Niveau 2 : Israetel + Issurin (`programming.js`)

#### Volume landmarks (Renaissance Periodization)
- MEV (Maintenance Effective Volume), MAV (Maximum Adaptive Volume range),
  MRV (Maximum Recoverable Volume) par groupe.
- Pondération par zone primaire (1.0) vs secondaire (0.5) — un squat compte
  1.0 jambes + 0.5 core.
- Personnalisation ±15% selon relation volume/RPE observée sur 4 semaines :
  haut volume + RPE bas → bump up ; volume nominal + RPE haut → shrink.

#### Block periodization (Issurin)
Cycle de 6 semaines : 3 sem accumulation (volume +20%, intensité -5%) →
1 sem transmutation (-25% / +5%) → 1 sem réalisation (-50% / +15%) →
1 sem deload (-50% / -30%).

`adaptiveBlockOverride(macrocycle, history, scheduled)` peut sauter une
phase :
- Accumulation, semaine ≥ 2, RPE 7j ≥ 8.5 → bascule en transmutation
- Transmutation, RPE 7j ≥ 9 → saute en deload
- Réalisation, RPE 7j ≥ 9.5 → deload anticipé
- Début de nouveau cycle (semaine 1) avec RPE 14j ≥ 8 → prolonge le deload

#### Movement taxonomy
PATTERN_MAP attribue un patron à chaque exoId : push horizontal/vertical,
pull horizontal/vertical, squat, hinge, lunge, anti-rotation, anti-extension,
carry, cardio, iso. `imbalanceReport(history, profile)` calcule trois ratios
et compare aux ranges adaptés au goal :

| Goal | Push/Pull H | Push/Pull V | Squat/Hinge |
|------|-------------|-------------|-------------|
| forme | 0.8-1.2 | 0.5-0.8 | 0.7-1.2 |
| hypertrophie | 0.8-1.2 | 0.5-0.8 | 0.7-1.2 |
| force | 0.7-1.4 | 0.4-1.0 | 0.4-1.8 |
| endurance | 0.6-1.5 | 0.4-1.0 | 0.5-1.5 |
| perte_gras | 0.6-1.5 | 0.4-1.0 | 0.5-1.5 |
| puissance | 0.6-1.5 | 0.4-1.0 | 0.4-1.8 |
| mobilite | 0.4-2.5 | 0.3-1.5 | 0.3-2.5 |
| debutant | 0.85-1.15 | 0.55-0.75 | 0.75-1.15 |
| competition | 0.4-2.5 | 0.3-1.5 | 0.3-2.5 |

Multi-goal : prend min(lo) et max(hi) sur chaque ratio (tolérance la plus
large). Goal inconnu : fallback sur `forme`, warning console.

#### Responder classification
Régression linéaire least-squares de l'estimation Epley du 1RM par exo
(key lifts dynamiques via `pickKeyLifts`). Confidence :
- ≥ 7 sem couvertes ET ≥ 2 exos → `'high'`
- ≥ 4 sem ET ≥ 1 exo → `'low'` (estimation préliminaire)
- sinon → `'unknown'`

Output : type ∈ {fast, moderate, slow, regressing}, slope kg/sem, advice.

`pickKeyLifts` utilise une décroissance exponentielle (half-life paramétrable
30/60/180j via `S.profile.keyLiftHalfLife`) plutôt qu'un cutoff strict — la
mémoire long-terme est préservée tout en privilégiant l'activité récente.

### Niveau 3 : Filtre de Kalman 2D (`bayesian.js`)

État caché par exercice : `x = [μ, β]` où μ = 1RM réel courant, β = pente
en kg/jour.

```
Prédiction :
  x_pred = F·x   où F = [[1, dt], [0, 1]]
  P_pred = F·P·F' + Q·dt   où Q = diag(Q_μ·qScale, Q_β·qScale)·dt

Mise à jour (avec inflation Huber pour robustesse aux outliers) :
  z = (y - μ) / sqrt(P_μ + R)
  R_eff = R · max(1, (|z|/2)²)        ← M-estimateur
  S = P_μ + R_eff
  K = [P_μ/S, P_μβ/S]
  x = x_pred + K·(y - μ_pred)
  P = (I - K·H)·P_pred
```

Constantes :
- `Q_MU = 0.09` kg²/jour (drift naturel du 1RM)
- `Q_BETA = 0.0001` (pente très stable)
- `qScale` ∈ {2.0, 1.0, 0.5, 1.5} selon responder (fast/moderate/slow/regressing)
- `R(reps, rpe)` : variance d'observation Epley adaptée à reps + RPE

Bruit d'observation R :
- 1-3 reps : R = 2.25 (σ ≈ 1.5 kg)
- 4-6 reps : R = 6.25
- 7-10 reps : R = 16
- 10+ reps : R = 49
- × 1.5 si RPE < 8, × 2.5 si RPE < 7

Forecast : `x_t+dt = x + β·dt`, variance qui croît en `Pμ + 2dt·Pμβ + dt²·Pβ + Qμ·dt`.

Détections :
- **Anomalie** : z-score > 2.5 sur set fraîchement loggé → toast.
- **Dérive lente** : β/sem < -0.2 ET (t-stat ≥ 1.5 OU β/sem < -0.4) → flag overtraining.

### Niveau 4 : Banister fitness-fatigue (`banister.js`)

Convention TrainingPeaks :
```
CTL(t) = (1/τ_F) · Σᵢ load_i · exp(-(t-tᵢ)/τ_F)    τ_F = 42 jours
ATL(t) = (1/τ_A) · Σᵢ load_i · exp(-(t-tᵢ)/τ_A)    τ_A = 7 jours
TSB(t) = CTL(t) - ATL(t)
```

`sessionLoad(h)` = sets × RPE pour les séances normales, durationMin × RPE
pour les externes (Foster sRPE), demi-charge pour les snacks.

Composite readiness 0-100 (substitué à formScore quand physio dispo) :
```
score = 50
       + 10 · z(HRV vs baseline 28j, capé ±1.5)
       - 10 · z(RHR vs baseline)         ← signe inversé : bas = mieux
       +  7 · z(sleep vs baseline)        ← fallback seuils si pas de baseline
       + {peak +10, fresh +5, train 0, fatigued -5, overload -10}
       + 0.3 · (formScore - 50)
       capé [0, 100]
```

`baseline(physio, key)` : moyenne et écart-type sur les 28 derniers jours,
exclut today. Min 5 valeurs pour être valide.

## Sécurité approfondie

### Headers (middleware.go)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains   (si HTTPS)
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), autoplay=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://i.ytimg.com;
  font-src 'self' data:;
  connect-src 'self';
  frame-src https://www.youtube-nocookie.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
```

### Auth flow

```
1. POST /api/login {email, password}
   → bcrypt.CompareHashAndPassword (constant-time vs dummyHash si user absent)
   → si user.TOTPSecret : retourne {need2fa: true} sans créer la session
2. POST /api/login {email, password, totpCode}
   → verifyTOTP(secret, code, window=±1 step de 30s)
   → createSession(uid) → setSessionCookie + setCSRFCookie
3. Routes protégées : requireAuth → require2FA → handler
   - requireAuth : valide sid cookie, check CSRF double-submit sur writes
   - require2FA : refuse si TOTPSecret vide et twofaRequired=true
```

Sessions : 30 jours max, persistées via `saveSessions()` au shutdown
(SIGTERM). Janitor purge les expirées toutes les 5 min. Stockées dans
`/data/sessions.json` (mode 0o600).

CSRF : double-submit cookie + header `X-CSRF-Token` sur toutes les
méthodes non-safe (POST, PUT, DELETE, PATCH). Cookie non-HttpOnly pour
que JS puisse le lire (sécurisé par SameSite=Strict).

### Chiffrement at-rest (helpers.go)

`encryptToken(plain)` :
- Génère un nonce 12 bytes via crypto/rand.
- Chiffre avec AES-256-GCM, clé dérivée de `COACH_TOKEN_KEY`.
- Format : `ENC:v1:` + base64url(nonce ‖ ciphertext+tag).

`decryptToken(stored)` :
- Si `stored` ne commence pas par `ENC:v1:`, retourne tel quel (legacy
  cleartext, retro-compat lors de la migration).
- Sinon décode base64, sépare nonce, déchiffre.

Si `COACH_TOKEN_KEY` n'est pas défini au boot et qu'au moins un user a un
token chiffré, l'app log un FATAL et refuse de démarrer (le service ne
peut pas servir si les tokens sont illisibles).

### RGPD

- Consentement art. 9 (données de santé) : `S.profile.healthConsent` versionné.
  Si `CurrentPrivacyVersion` change, l'utilisateur est re-prompté.
- Opt-out art. 22 : `S.profile.algoOptOut` masque les ajustements algorithmiques
  côté client et tag l'export. La donnée continue d'être calculée pour la
  continuité d'affichage mais n'est pas surfacée comme recommandation.
- Export art. 20 : `GET /api/export` retourne `{_export, account, workouts}`
  en JSON, incluant les métadonnées du compte.
- Effacement art. 17 : `POST /api/delete-account` supprime le data file,
  retire le user de `usersByID/usersByEm`, kill toutes les sessions.
- Audit : `admin-audit.log` ne contient que des hashes d'email
  (`hashEmailForLog`), pas les emails en clair.
- Mineurs : profil bloqué si âge < 15 (seuil français de consentement
  numérique).

## Tests

Tests Go dans `*_test.go` :
- `auth_test.go` : register, login, logout, change-password, gate 2FA, delete-account
- `admin_test.go` : CRUD users, autorisation, audit
- `data_test.go` : whitelist keys, anonymisation, atomic writes
- `session_test.go` : cookies, expiry, CSRF
- `middleware_test.go` : security headers, body cap
- `totp_test.go` : RFC 6238 vectors

Helpers dans `testhelpers_test.go` :
- `newTestServer(t)` : mux scoped à `t.TempDir()`, état réinitialisé
- `registerAndLogin(t, mux, email, pw)` : crée + auth + grant consent
- `mustGrantConsent(t, email)` : stamp HealthConsent direct sur le User
- `doJSON(t, mux, method, path, body, cookies, csrf)` : helper requête

Tests JS : check syntactique seulement (`node --check public/*.js`). Pas de
test runner JS embarqué — l'app n'a pas de bundle, donc pas de jest natif.
Les tests fonctionnels sont manuels via les écrans dev tools du browser.

## Déploiement

### Reverse proxy

L'app écoute en HTTP plain par défaut. Mettre derrière Caddy ou nginx pour
TLS, gzip, et headers HSTS de l'edge :

```
# nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Host $host;
}
```

Et set `COACH_TRUST_PROXY=1` pour que le rate limiter et l'audit log
loggent la vraie IP cliente (pas l'IP du proxy).

### Conteneur

`Dockerfile` :
- Multi-stage : `golang:1.22-alpine` builder → `gcr.io/distroless/static`
  pour l'image finale.
- Binaire statique (`CGO_ENABLED=0`).
- USER nonroot (uid 65532 sur distroless).
- Le frontend est embarqué dans l'image sous `/app/public`.
- Exposes 8080.

`docker-compose.yml` :
- Volume `coach_data:/data` pour la persistance.
- Healthcheck sur GET / (200).
- Variables d'env via `.env`.

### Backups

- Le `.bak` quotidien dans `/data/workouts/` couvre la corruption.
- Pour une vraie stratégie de backup, snapshoter le volume `/data`
  régulièrement (LVM, restic, borg, ZFS, ou snapshot du disque cloud).
- Tester la restauration au moins une fois.

## Évolutions futures (roadmap)

### Niveau 5 : modélisation avancée
- ML supervisé sur features (RPE, volume, charge, sommeil, fatigue) pour
  prédire la probabilité de PR au prochain set.
- Calibration EM des paramètres Banister par utilisateur (k1, k2 auto).
- LLM en assistant narratif (debrief hebdo) — mais avec consentement
  explicite, transfert hors UE encadré, et caveats hallucination.

### Multi-tenant
- Migrer sessions vers Redis (stickyless).
- Migrer rate limiter vers Redis.
- Data files vers S3/MinIO ou postgres + objet store.
- Chiffrement at-rest avec clé par tenant (KMS-managed).

### Intégrations OAuth full
Voir [INTEGRATIONS.md](INTEGRATIONS.md) pour Polar, Fitbit, Strava,
Withings, Whoop, Google Fit, Apple Health.
