# Plan d'infrastructure — jjoly.eu multi-apps sur k3s

**Date :** 2026-07-15
**Objectif :** passer d'un seul docker-compose (coach-app sur jjoly.eu) à une plateforme
multi-apps sur k3s : `jjoly.eu` (site statique), `coach.jjoly.eu`, `fridge.jjoly.eu` (plus tard),
avec CI/CD complet, staging et monitoring — le tout sur le VPS actuel (2-4 Go), extensible
en multi-serveurs sans réécriture.

---

## 1. Décisions actées

| Sujet | Décision |
|---|---|
| Orchestration | **k3s** mono-nœud, prêt pour l'ajout de nœuds |
| Repos | **Multi-repos** : 1 repo par app + 1 repo `infra` (source GitOps) |
| Déploiement | **Flux CD** (GitOps, ~150-200 Mo — choisi plutôt qu'Argo CD, trop lourd ici) |
| Secrets | **SOPS + age**, chiffrés dans le repo infra, déchiffrés par Flux |
| Staging | Namespace `staging` dans le même cluster, éteint hors usage |
| DNS | `coach.jjoly.eu` pour coach, `jjoly.eu` libéré pour le site statique ; entrées DNS individuelles, certs HTTP-01 |
| Bases | **1 DB par app** (coach-db, fridge-db…), partagée par toutes les répliques de l'app |
| Monitoring | **Révisé (1,8 Go)** : pas de stack in-cluster — metrics-server (`kubectl top`) + uptime externe (UptimeRobot ou équivalent). VictoriaMetrics/Grafana reportés à un futur upgrade RAM |
| Migration données | Dump/restore MariaDB (données perso uniquement, downtime indifférent) |
| RAM | **1,8 Go mesuré (`free -h` du 2026-07-15) — variante ultra-minimale assumée** : swap obligatoire, staging éphémère, risque OOM documenté (§5) |

---

## 2. Architecture cible

```
                    Internet
                       │
              DNS : jjoly.eu ─── A ──→ IP VPS
                    coach.jjoly.eu ─ A ──→ IP VPS
                    staging.coach.jjoly.eu ─ A ──→ IP VPS
                       │
┌──────────────────────┼─────────────────────────────────┐
│ VPS (k3s)            ▼                                  │
│   Traefik (ingress intégré k3s) + cert-manager          │
│   ├── jjoly.eu          → ns prod    : site (nginx)     │
│   ├── coach.jjoly.eu    → ns prod    : coach-app ×N ──┐ │
│   ├── fridge.jjoly.eu   → ns prod    : fridge (futur) │ │
│   └── staging.coach.…   → ns staging : coach-app ──┐  │ │
│                                                     │  │ │
│   ns prod    : coach-db (MariaDB, 1 seule) ◄────────┼──┘ │
│   ns staging : coach-db-staging (allégée)  ◄────────┘    │
│   ns flux-system : Flux (GitOps)                         │
│   ns monitoring  : VictoriaMetrics + Grafana             │
│   CronJob backups → dump quotidien → volume + off-site   │
└──────────────────────────────────────────────────────────┘
```

**Répartition / scaling :** chaque app est un `Deployment` avec N répliques derrière un
`Service` (load balancing interne automatique). Multi-serveur plus tard = `k3s agent` sur
le nouveau nœud + un label ; les DB restent mono-instance (1 par app), les apps stateless
se répartissent sur les nœuds. Rien à réécrire.

---

## 3. Découpage des repos

```
jjoly-infra/                  ← source de vérité GitOps (Flux pointe ici)
├── clusters/prod/            ← Kustomizations Flux, ordre d'application
├── infrastructure/           ← traefik config, cert-manager, monitoring, sops
├── apps/
│   ├── coach/{base,prod,staging}/   ← Deployment, Service, Ingress, DB, PVC
│   └── site/{base,prod}/
└── secrets/                  ← *.enc.yaml chiffrés SOPS

coach-app/    ← code Go actuel (nettoyé : le déploiement part dans jjoly-infra)
jjoly-site/   ← site statique (HTML/CSS ou générateur type Hugo)
fridge-app/   ← futur
```

Chaque repo d'app garde : code, Dockerfile, tests, CI de build. Le repo infra possède
tout ce qui touche au cluster. Les fichiers compose/Caddyfile de coach-app seront
archivés une fois la migration validée.

---

## 4. Pipeline CI/CD

**Repo app (ex. coach-app), sur push main :**
1. Tests + lint (`go vet`, `golangci-lint`) + `go test ./...`
2. Build image multi-stage → tag `sha-<commit>` + `vX.Y.Z` sur tag git
3. Scan vulnérabilités (Trivy) — bloquant sur CRITICAL
4. Push → **GHCR** (`ghcr.io/<user>/coach-app`)

**Déploiement (Flux, côté cluster) :**
- Flux **image automation** surveille GHCR : nouveau tag `sha-*` → commit auto dans
  `jjoly-infra` (staging d'abord) → déployé en ~1 min.
- **Promotion prod** : PR (ou commit manuel) qui recopie le tag validé en staging vers
  `apps/coach/prod`. Rollback = `git revert`.

Zéro SSH dans le flux nominal. Le cluster *tire*, la CI ne pousse jamais vers le serveur.

---

## 5. Budget RAM — variante ultra-minimale (1,8 Go mesuré, choix assumé)

`free -h` du 2026-07-15 : **1,8 Go total, 0 swap**. En dessous du seuil recommandé pour
k3s ; on procède quand même, avec les coupes suivantes.

| Composant | RAM estimée |
|---|---|
| OS de base (sshd, journald…) | ~200 Mo |
| k3s (server SQLite + kubelet + Traefik + CoreDNS + metrics-server) | ~750 Mo |
| Flux **réduit à 2 contrôleurs** (source + kustomize) | ~110 Mo |
| cert-manager (requests abaissés) | ~90 Mo |
| coach-db (MariaDB, buffer pool **64 Mo**, max-connections 25) | ~220 Mo |
| coach-app (limite 128 Mo) | ~100 Mo |
| site statique (nginx-alpine) | ~15 Mo |
| **Total permanent** | **~1,5 Go / 1,8 Go** |

**Ce qui est coupé et pourquoi :**
- **Swap 2 Go + zram obligatoires** (aucun swap actuellement) : c'est l'amortisseur
  anti-OOM. kubelet lancé avec `fail-swap-on=false`.
- **Pas de VictoriaMetrics/Grafana** : metrics-server (`kubectl top`) + uptime externe
  gratuit. Réintroduits le jour d'un upgrade RAM.
- **Flux sans helm/notification/image-automation controllers** (−~70 Mo) : la CI commite
  le tag d'image dans le repo infra à la place de l'image automation. Les charts Helm
  (cert-manager) passent par le contrôleur Helm **intégré à k3s** (job one-shot, 0 Mo résident).
- **Staging éphémère** : namespace présent mais tout à 0 réplique ; on le réveille pour
  valider (`kubectl scale`), on le rendort après. Jamais staging + pic prod en même temps.
- **Cohabitation impossible** : l'actuel compose consomme déjà ~1,3 Go → l'installation
  k3s se fait APRÈS l'arrêt de l'ancien stack (migration séquentielle, voir §8 révisé).

**Risques assumés** : un pic (gros import, plusieurs certs simultanés, `docker pull`
d'images lourdes) peut swapper fort ou OOM-kill un pod. Les `resources.limits` stricts
partout + swap limitent la casse. Premier réflexe si instabilité chronique : upgrade RAM
(le cluster est déjà prêt, rien à refaire).

---

## 6. TLS, sécurité, conformité

- **cert-manager** + Let's Encrypt HTTP-01 par ingress (pas de wildcard → pas de token
  API registrar à protéger). Renouvellement auto.
- Les gardes actuelles de coach-app sont **transposées en k8s** : `readOnlyRootFilesystem`,
  `runAsNonRoot`, `capabilities.drop: ALL`, `no-new-privileges` → `securityContext` ;
  limites CPU/RAM → `resources` ; healthcheck binaire → `livenessProbe`/`readinessProbe`.
- **NetworkPolicies** : coach-db accessible uniquement depuis les pods coach-app ;
  staging isolé de prod. (Équivalent des réseaux compose isolés — à ne pas oublier,
  par défaut k8s laisse tout passer.)
- `COACH_TRUST_PROXY=1` (Traefik devant) ; RGPD inchangé : tout reste auto-hébergé,
  les volumes d'audit et de données suivent en PVC.

## 7. Backups

Le script `db-backup.sh` devient un **CronJob** k8s par DB (03h UTC, dump
`--single-transaction`, checksum, chiffrement passphrase, rétention 7j/4sem — logique
conservée). Nouveau : ajout d'une **synchro off-site** (rclone vers un stockage S3/Storage
Box) — aujourd'hui les dumps restent sur la machine, c'est le point faible actuel.
Backup aussi de la clé age SOPS (hors serveur !) et d'un snapshot etcd k3s hebdo.

---

## 8. Plan de migration (ordre d'exécution)

⚠️ **Révisé pour 1,8 Go : pas de cohabitation compose + k3s.** Le downtime étant
acceptable (données perso uniquement), la migration est **séquentielle** : on sauvegarde,
on éteint l'ancien, on monte le nouveau, on restaure. Prévoir une fenêtre de 2-3 h.

**Phase 0 — Préparation (prod intouchée)**
1. Créer les repos `jjoly-infra`, `jjoly-site` ; générer la clé age (backup hors serveur)
2. DNS : ajouter `coach.jjoly.eu` et `staging.coach.jjoly.eu` → IP VPS (TTL bas, 300 s)
3. CI coach-app : build+scan+push GHCR opérationnelle — **l'image doit être sur GHCR
   avant d'éteindre quoi que ce soit** (plus de build sur le serveur, jamais)
4. Chiffrer les secrets (SOPS) dans jjoly-infra ; préparer swap + zram sur le VPS

**Phase 1 — Bascule (fenêtre de downtime)**
5. Dump MariaDB frais (`docker compose run --rm db-backup once`) + copie du dump ET
   du volume coach_data **hors du serveur** (scp local) — double filet
6. `docker compose down` (Caddy compris) — libère RAM et ports 80/443
7. Installer k3s ; bootstrap Flux (2 contrôleurs) sur `jjoly-infra` → cert-manager,
   namespaces, site, coach se déploient seuls depuis Git
8. Créer le secret age dans le cluster ; vérifier le déchiffrement SOPS

**Phase 2 — Données et vérification**
9. Restore du dump dans coach-db (ns prod) ; `--verify` via le binaire
10. Smoke test complet : login, 2FA, séance, historique ; certs Let's Encrypt émis
11. `jjoly.eu` → site statique ; `coach.jjoly.eu` → coach-app
12. **Mettre à jour la redirect URI Strava** (`STRAVA_REDIRECT_URI`, webhook URL) vers
    coach.jjoly.eu — sinon l'OAuth casse silencieusement
13. Redirection `jjoly.eu/app/* → coach.jjoly.eu` (middleware Traefik) pour les favoris

**Phase 3 — Consolidation**
14. Vérifier backups CronJob + off-site (test de restauration !)
15. Archiver compose/Caddyfile dans coach-app ; documenter le runbook (install nœud,
    rollback, restauration, ajout d'une app)
16. Garder les volumes Docker de l'ancien stack intacts 2 semaines avant nettoyage
    (`docker volume ls` — ne PAS `down -v` ni `prune` avant validation)

**Rollback pendant la fenêtre** : à tout moment avant l'étape 16, `k3s-uninstall.sh`
+ `docker compose up -d` restaure l'existant en ~5 min (les volumes sont intacts).

**Plus tard** : fridge.jjoly.eu = copier le pattern `apps/coach/` dans jjoly-infra +
nouveau repo d'app ; multi-serveur = `k3s agent` + labels.

---

## 9. Points de vigilance

- **1,8 Go de RAM** : le risque n°1. Swap + zram AVANT l'installation de k3s, limits
  partout, jamais de build d'image sur le serveur. Si OOM récurrents → upgrade RAM.
- **Redirect URI Strava** : la casse la plus probable de la migration (étape 12).
- **NetworkPolicies** dès le départ, pas « plus tard ».
- **Clé age SOPS** : sa perte = secrets illisibles ; backup hors serveur immédiat.
- **Mono-nœud = pas de HA** : k3s ne rend pas magiquement résilient ; l'intérêt ici est
  le pipeline, l'isolation par namespace et l'extensibilité — pas la haute dispo.
- Distroless + `--healthcheck` binaire : déjà compatible probes k8s, rien à changer côté Go.
