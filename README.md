# Coach Adaptatif

Application web auto-hébergée d'entraînement musculaire adaptatif. Backend
Go monolithique, frontend SPA vanilla JS sans build step. Stockage fichiers
JSON sur disque, pas de base de données.

## Vue d'ensemble

L'app génère des séances d'entraînement personnalisées selon le profil de
l'utilisateur (objectifs, matériel disponible, niveau, douleurs déclarées),
ajuste les charges et le volume en temps réel via un ensemble de modules
statistiques, et trace la progression long terme. Couvre cinq niveaux de
sophistication — du générateur de séances de base jusqu'à un coach
adaptatif qui modélise la physiologie de l'utilisateur en bayésien.

Conçue pour un usage personnel ou un cercle restreint (auto-hébergement),
avec inscription fermée par défaut (admin-bootstrappé). Conformité RGPD
implémentée nativement (consentement explicite données de santé, droits
art. 15-22, audit log avec rotation 12 mois).

## Stack technique

- **Backend** : Go 1.21+, `net/http` standard library uniquement (sauf
  `golang.org/x/crypto/bcrypt`). Pas de framework, pas d'ORM. Mono-binaire.
- **Frontend** : HTML/CSS/JS vanilla. Aucun bundler, aucun npm. Service
  worker pour mode hors-ligne basique. PWA installable.
- **Stockage** : fichiers JSON sur disque. `users.json` pour l'index des
  comptes, un fichier par utilisateur pour les données d'entraînement.
- **Auth** : email + mot de passe bcrypt cost 12, sessions cookie opaque
  HttpOnly + SameSite=Strict, double-submit CSRF, 2FA TOTP obligatoire
  par défaut.

## Structure du repo

```
coach-app/
├── main.go              Bootstrap, routing HTTP, lifecycle
├── auth.go              Users, sessions, login, register, change-pw, 2FA
├── admin.go             Admin API (CRUD users), audit log, rotation 12 mois
├── data.go              Persistence du data file utilisateur (whitelist keys)
├── physio.go            Intégrations physio (Oura API, webhook générique)
├── session.go           Cookies session + CSRF
├── middleware.go        Security headers, CSP, access log, body cap
├── totp.go              Implémentation TOTP RFC 6238
├── helpers.go           writeJSON, readJSON, hashEmailForLog, encrypt/decrypt
├── public/              Frontend statique servi par /static/
│   ├── index.html       SPA principale
│   ├── admin.html       SPA admin
│   ├── privacy.html     Politique de confidentialité (FR + EN)
│   ├── app.js           Logique principale (~5400 lignes)
│   ├── rehab.js         Module rééducation (lib exos, génération séances)
│   ├── snacks.js        Mini-routines 5-15 min
│   ├── programming.js   Israetel + Issurin (volume landmarks, blocks, taxonomy)
│   ├── bayesian.js      Filtre Kalman 2D pour 1RM avec CI
│   ├── banister.js      Modèle fitness-fatigue + composite readiness
│   ├── privacy.js       Toggle FR/EN sur la politique
│   ├── admin.js         SPA admin
│   ├── qrcode.js        Vendored QR generator (pour 2FA enrollment)
│   ├── sw.js            Service worker
│   ├── icon.svg, manifest.json
│   └── tests/           Tests JS (manuels)
├── data/                Volume persistant (créé au runtime)
│   ├── users.json
│   ├── workouts/{userId}.json
│   ├── admin-audit.log
│   └── *.bak            Backups quotidiens automatiques
├── *_test.go            Tests Go
├── deploy/              Unit systemd, nginx config exemple
├── Dockerfile, docker-compose.yml, .dockerignore, .env.example
├── ARCHITECTURE.md      Détail des modules et modèles
├── INTEGRATIONS.md      Pattern OAuth + runbook intégrations phase 2
└── go.mod, go.sum
```

## Setup local

```bash
# Cloner et builder
git clone <repo>
cd coach-app
go build .

# Premier lancement : bootstrap admin
COACH_ADMIN_EMAIL=admin@exemple.fr \
COACH_ADMIN_PASSWORD='Secret-fort-1234' \
COACH_TOKEN_KEY=$(openssl rand -hex 32) \
COACH_LISTEN=127.0.0.1:8080 \
./coach-app

# L'admin est créé au démarrage. À l'arrêt, retire les env vars admin
# (sinon son mot de passe est réécrit à chaque restart). Garde
# COACH_TOKEN_KEY entre les redémarrages — sinon les tokens API
# deviennent illisibles.
```

Ouvrir `http://localhost:8080`, se connecter en admin, créer des comptes
utilisateurs depuis `/admin`. La 2FA est demandée à la première connexion
de chaque user.

## Variables d'environnement

| Variable | Default | Usage |
|----------|---------|-------|
| `COACH_LISTEN` | `127.0.0.1:8080` | Adresse d'écoute HTTP |
| `COACH_DATA` | `./data` | Répertoire data (à monter en volume en prod) |
| `COACH_PUBLIC` | `./public` | Frontend statique |
| `COACH_TRUST_PROXY` | `0` | Si `1`, lit `X-Forwarded-For` (mettre à 1 derrière nginx/Cloudflare) |
| `COACH_ALLOW_REGISTRATION` | `0` | Si `1`, ouvre `/api/register` au public |
| `COACH_2FA_REQUIRED` | `1` | Si `0`, désactive l'obligation 2FA |
| `COACH_ADMIN_EMAIL` | — | Bootstrap : crée/promeut cet email en admin |
| `COACH_ADMIN_PASSWORD` | — | Mot de passe associé (rotated à chaque restart) |
| `COACH_TOKEN_KEY` | — | **Critique.** Hex 32 bytes pour chiffrement at-rest des tokens API (Oura, etc.). Génère-la une fois et garde-la — si tu la perds, les tokens chiffrés deviennent illisibles. `openssl rand -hex 32` |

## Endpoints REST

### Auth (publics, rate-limited)
- `POST /api/register` — création de compte (fermé par défaut)
- `POST /api/login` — login + 2FA
- `POST /api/logout`
- `GET  /api/me` — état utilisateur (consentement, 2FA, etc.)
- `GET  /api/csrf` — refresh du CSRF token

### Données utilisateur (auth + 2FA)
- `GET    /api/data` — lit le data file
- `PUT    /api/data` — write (whitelist top-level keys)
- `GET    /api/export` — export RGPD complet (JSON)
- `POST   /api/delete-account` — droit à l'effacement (art. 17)
- `POST   /api/consent` — enregistre consentement art. 9 (données de santé)
- `POST   /api/algo-optout` — opposition art. 22 (décision automatisée)

### Sécurité
- `POST   /api/change-password`
- `GET    /api/2fa/status`
- `POST   /api/2fa/setup`, `verify`, `disable`

### Intégrations physio (auth + 2FA)
- `GET    /api/physio/integrations` — statut (sans tokens)
- `POST   /api/physio/integrations/oura` — set token Oura
- `DELETE /api/physio/integrations/oura`
- `POST   /api/physio/integrations/webhook` — génère/rotate secret
- `DELETE /api/physio/integrations/webhook`
- `POST   /api/physio/sync` — fetch toutes les intégrations actives

### Webhook push (sans auth, validé par secret URL)
- `POST   /api/physio/webhook/{uid}/{secret}`
  - Body : objet ou array `{date, hrv, sleep, rhr}`
  - **Format Apple Health Auto Export** : `{ data: { metrics: [...] } }` également supporté

### Admin (auth + 2FA + admin flag)
- `GET    /api/admin/users` — liste tous les comptes
- `POST   /api/admin/users` — création (le seul chemin de création hors register)
- `POST   /api/admin/users/{id}/password`, `admin`, `revoke-sessions`
- `DELETE /api/admin/users/{id}`
- `GET    /api/admin/users/{id}/data` — lecture du data file (debug)

### Static
- `GET /static/*` — assets (JS, CSS, images)
- `GET /privacy` — politique de confidentialité publique
- `GET /admin` — SPA admin
- `GET /` — SPA principale

## Schéma de données

### `users.json` (index global, mode 0o600)
```json
[
  {
    "id": "abc123...",
    "emailLower": "user@example.com",
    "passwordHash": "$2a$12$...",
    "createdAt": "2026-04-30T10:00:00Z",
    "isAdmin": false,
    "totpSecret": "BASE32...",
    "healthConsent": { "consentedAt": "2026-04-30T...", "version": "1.0" },
    "algoOptOut": false,
    "physioTokens": { "oura": "ENC:v1:base64..." },
    "physioWebhookSecret": "abc123...",
    "physioLastSync": { "oura": "2026-04-30T..." }
  }
]
```

### `workouts/{userId}.json` (data file, mode 0o600)
Structure libre, validée par whitelist top-level dans `data.go` :
```json
{
  "profile": { "age", "weight", "height", "sex", "level", "goals", "gear",
               "freq", "duration", "advancedMode", "keyLiftHalfLife", "..." },
  "history": [
    { "date", "rpe", "sets": [...], "kind?": "snack" | "external" }
  ],
  "currentSession": { "exos": [...], "sets": [...], "pausedAt?" },
  "formScore": 70,
  "adjustments": [],
  "notes": {},
  "rehab": { "active", "injuryDate", "zones", "manualPhase",
             "acceptedDisclaimerAt", "acceptedDisclaimerVersion" },
  "body": {
    "weights": [ { "date", "kg" } ],
    "measurements": [ { "date", "waistCm", "hipsCm", "bicepsLCm", "bicepsRCm", "thighCm" } ],
    "physio":  [ { "date", "hrv", "sleep", "rhr" } ]
  },
  "macrocycle": { "startDate", "focus" }
}
```

### `admin-audit.log` (NDJSON, mode 0o600)
Une ligne JSON par mutation admin. Format :
```json
{"ts":"2026-04-30T10:00:00Z","actor":"admin@...","actorId":"...","action":"create_user","targetId":"...","ip":"127.0.0.1","note":"emailHash=abc12345@example.com admin=false"}
```
Rotation auto à 12 mois (renommé en `.archive-YYYYMMDD`).

## Modules frontend

### `app.js` (orchestrateur principal)
Routage des vues, génération de séance, viewer de session, bilan, history,
intégrations physio. Lit les autres modules via `window.X`.

### `rehab.js`
Bibliothèque de 36 exos rééduc (9 zones × phases aiguë/sub-aiguë/retour).
`Rehab.computePhase`, `Rehab.generateSession`, disclaimer médical versionné.

### `snacks.js`
13 mini-routines de 4-15 min (mobilité, force express, gainage, cardio,
full body, récup) référençant les exos existants.

### `programming.js` — Niveau 2 (Israetel + Issurin)
- **Volume landmarks** : MEV/MAV/MRV par groupe musculaire, personnalisés
  selon la relation volume/RPE observée (×0.85 à ×1.15).
- **Block periodization** : cycle 6 semaines (3 acc + transmu + real + deload),
  adaptatif selon RPE récent.
- **Movement taxonomy** : push/pull horizontal/vertical, squat, hinge, lunge,
  anti-rotation, anti-extension, carry. Détection de déséquilibres avec
  ranges adaptés à 9 objectifs (force, hypertrophie, endurance, perte_gras,
  forme, puissance, mobilite, debutant, competition).
- **Responder classification** : fast / moderate / slow / regressing avec
  niveau de confidence high/low.
- `pickKeyLifts` à pondération exponentielle (half-life paramétrable
  30/60/180j).

### `bayesian.js` — Niveau 3 (Filtre Kalman 2D)
Local linear trend model (état = [μ, β]) par exercice. Estimation 1RM
avec intervalle de confiance, forecast 90 jours, détection d'anomalie
(z-score > 2.5), détection de dérive lente (β négative significative).
Filtre robuste M-estimateur Huber (résiste aux outliers).

### `banister.js` — Niveau 4 (Fitness-Fatigue)
- **CTL** (fitness, EWMA 42j) — base à long terme
- **ATL** (fatigue, EWMA 7j) — accumulation court terme
- **TSB** = CTL - ATL — Training Stress Balance
- **Composite readiness** : score 0-100 intégrant HRV, sommeil, FC repos,
  TSB et formScore déclaratif. Substitué automatiquement à formScore dans
  `modFromForm` quand des données physio récentes sont disponibles.
- **Parser CSV** + format Apple Health Auto Export.

## Sécurité

- **HTTPS** : forcé via HSTS si présent. À mettre derrière nginx/Caddy en prod.
- **Headers** : CSP stricte (`script-src 'self'`), X-Frame-Options DENY,
  X-Content-Type-Options nosniff, Referrer-Policy strict-origin, etc.
- **Auth** :
  - bcrypt cost 12 sur les passwords
  - 2FA TOTP obligatoire par défaut
  - sessions HttpOnly + SameSite=Strict + Secure
  - CSRF double-submit sur tous les writes
  - Rate limiting par IP sur les endpoints sensibles
- **Tokens API** : chiffrement at-rest AES-GCM avec clé `COACH_TOKEN_KEY`.
  Format stocké : `ENC:v1:base64(nonce|ciphertext|tag)`.
- **Audit** : journal NDJSON pour toutes les mutations admin. Rotation 12 mois.
- **Logs systemd** : emails hashés (sha256 prefix 8 chars + domaine en clair).
- **RGPD** :
  - politique publique à `/privacy` (FR + EN)
  - consentement explicite données de santé (art. 9)
  - opt-out décision automatisée (art. 22)
  - droits art. 15-22 implémentés (export, rectification, effacement, opposition)
  - garde-fou âge < 15 ans
  - lazy-load YouTube (consentement implicite préservé)

## Déploiement

### Bare metal / VPS
```bash
# Build
GOOS=linux GOARCH=amd64 go build -o coach-app .

# Déploiement
sudo useradd -r -s /usr/sbin/nologin coach
sudo mkdir -p /var/lib/coach-app/data /opt/coach-app
sudo cp coach-app /opt/coach-app/
sudo cp -r public /opt/coach-app/
sudo chown -R coach:coach /var/lib/coach-app
```

Voir `deploy/coach.service` pour le unit systemd type.

### Docker / Conteneur

Déploiement minimal, sans reverse proxy. L'app écoute en HTTP direct sur
le port exposé du host — adapté à un usage local, LAN, ou derrière un
VPN/tunnel (Tailscale, Cloudflare Tunnel...).

```bash
# 1. Configure le .env
cp .env.example .env
echo "COACH_TOKEN_KEY=$(openssl rand -hex 32)"         >> .env
echo "COACH_ADMIN_EMAIL=admin@exemple.fr"              >> .env
echo "COACH_ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env

# 2. Lance
docker compose up -d

# 3. Récupère les creds admin dans les logs
docker compose logs coach-app | grep -i admin

# 4. Ouvre http://<ip-du-host>:8080 (ou COACH_PORT si redéfini)
```

Une fois l'admin créé, retire `COACH_ADMIN_EMAIL` et `COACH_ADMIN_PASSWORD`
du `.env` et `docker compose up -d` à nouveau (sinon le password est
réécrit à chaque restart).

**Personnaliser le port** : `COACH_PORT=9000` dans `.env` → expose sur 9000.
Pour ne binder que sur localhost (typiquement si tu rajoutes un reverse
proxy plus tard) : `COACH_PORT=127.0.0.1:8080`.

**HTTPS** : pas géré nativement. Pour exposer publiquement avec TLS, mets
un reverse proxy devant (nginx, Caddy, Traefik) et passe `COACH_TRUST_PROXY=1`
dans `.env`. Pour un accès distant sécurisé sans gérer de certif, un
tunnel type Cloudflare Tunnel ou Tailscale Funnel fait le job.

### Production / exposition Internet — checklist sécurité

**Avant** d'exposer l'app sur Internet public, valider :

1. **TLS obligatoire** — credentials, cookies de session, codes 2FA et
   données de santé passent en clair sans HTTPS. Options :
   - Reverse proxy (Caddy automatise Let's Encrypt) :
     ```caddyfile
     coach.exemple.com {
       reverse_proxy 127.0.0.1:8080
     }
     ```
     Mettre `COACH_PORT=127.0.0.1:8080` dans `.env` et `COACH_TRUST_PROXY=1`.
   - Tunnel chiffré : Cloudflare Tunnel, Tailscale Funnel, ngrok TLS.
   - Pas de TLS natif Go intégré pour l'instant.

2. **Secrets hors environnement** — pattern `_FILE` supporté pour éviter que
   `COACH_TOKEN_KEY`, `COACH_ADMIN_PASSWORD`, `STRAVA_CLIENT_SECRET` etc.
   apparaissent dans `docker inspect` ou `/proc/PID/environ`. Exemple avec
   Docker secrets ou bind-mount tmpfs :
   ```yaml
   environment:
     COACH_TOKEN_KEY_FILE: /run/secrets/coach_token_key
   secrets:
     - coach_token_key
   ```
   Le binaire lit `COACH_TOKEN_KEY_FILE` en priorité sur `COACH_TOKEN_KEY`.

3. **Pin des images Docker par digest** — `docker:1.22-alpine` et
   `gcr.io/distroless/static-debian12:nonroot` sont des tags mutables.
   Lancer `./scripts/pin-images.sh` une fois par mois (et avant chaque
   release) pour figer les digests SHA256 — protège contre une compromission
   en amont du registry.

4. **Retirer les vars admin** après le premier boot : `COACH_ADMIN_EMAIL`
   et `COACH_ADMIN_PASSWORD` du `.env`. Le serveur pose une sentinelle
   `data/.admin-bootstrap-done` après le premier passage et n'écrasera plus
   le password aux restarts suivants (même si tu oublies les vars).

5. **Audit log** : `data/auth-audit.log` (JSON Lines) trace login / logout /
   change password / 2FA setup-verify-disable. À surveiller post-incident.
   Pas de rotation auto pour l'instant — utiliser `logrotate` côté hôte.

6. **CSP report-uri** : les violations CSP sont loggées dans la sortie standard
   (chercher `CSP-VIOLATION`). Une remontée en production indique une XSS
   tentée ou une dépendance frontend ajoutée mal whitelistée.

L'image finale est `gcr.io/distroless/static`. Le binaire est statique
(CGO_ENABLED=0). Le volume `coach_data:/data` persiste entre redémarrages.

## Développement

### Tests
```bash
go test ./...                 # backend
node --check public/*.js      # frontend syntax
```

### Lint
```bash
go vet ./...
gofmt -l .                   # devrait rien retourner
```

### Architecture
Voir [ARCHITECTURE.md](ARCHITECTURE.md) pour le détail des modules,
modèles statistiques, et flux de données.

### Intégrations OAuth
Voir [INTEGRATIONS.md](INTEGRATIONS.md) pour le pattern et la marche à
suivre pour ajouter Polar / Fitbit / Strava / Withings / Whoop.

## Licence

Tout droits réservés (auto-hébergement personnel pour l'instant).
