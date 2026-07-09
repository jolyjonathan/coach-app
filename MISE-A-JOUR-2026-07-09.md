# Mise à jour du 2026-07-09 — notes de déploiement

Tout s'applique en une commande une fois le pull fait sur la prod :

```bash
git pull
docker compose up -d --build     # (ou -f docker-compose.tls.yml)
```

Aucune variable `.env` nouvelle n'est **requise**. Deux sont **recommandées** :

```bash
# Chiffrement des dumps de backup (fortement recommandé — à générer UNE fois
# et à conserver avec COACH_TOKEN_KEY) :
printf 'BACKUP_PASSPHRASE=%s\n' "$(openssl rand -hex 24)" >> .env
```

## Ce que ce déploiement apporte

**Backups automatiques (nouveau service `db-backup`)** — dump MariaDB chaque nuit à 03h UTC, rétention 7 quotidiens + 4 hebdo, checksum, archive des journaux d'audit, healthcheck rouge si le dernier dump a plus de 26 h. Vérifier après le premier boot :

```bash
docker compose run --rm db-backup once     # dump immédiat de contrôle
docker compose ps                          # db-backup doit être healthy
```

Runbook complet (restauration, copie hors-machine, test trimestriel) : `BACKUPS.md`. **Pense à mettre en place la synchro hors-machine** — les dumps restent sur le même disque que la base.

**Toolchain & supply-chain** — Go 1.22 → 1.26.5 (1.22 ne recevait plus de correctifs sécurité), dépendances à jour (x/crypto 0.24 → 0.54, driver MySQL 1.8.1 → 1.10), toutes les images épinglées tag + digest SHA256 (golang, distroless, mariadb 12.3.2, caddy). `mariadb:lts` résolvait déjà vers 12.3.2 → aucun changement de version de base en pratique.

**Durcissement du service db** — limites mémoire (512 Mo), `no-new-privileges`, réglages adaptés au self-hosted (`buffer pool 128M`, `max_connections=50`, `performance_schema OFF`).

**Rotation de clé** — sous-commande `--rotate-key` pour changer `COACH_TOKEN_KEY` sans perdre TOTP/tokens (procédure dans `SECURITY.md`).

**CI** — job `govulncheck` bloquant (vulnérabilités Go atteignables), Dependabot étendu aux deps e2e, images CI épinglées.

**Compression HTTP** — les statiques sont maintenant gzippés en mode HTTP direct (app.js ~380 Ko → ~120 Ko). Derrière Caddy, rien ne change (le middleware détecte le contenu déjà encodé). Les réponses `/api/` ne sont volontairement jamais compressées (BREACH).

**Écritures DB ciblées (sessions)** — login/logout/prolongation écrivent une ligne au lieu de réécrire toute la table ; une session est durable en base avant que le cookie ne parte.

**Bilan de fin de bloc (nouvelle carte Tendances → Insights)** — synthèse du bloc Issurin : adhérence, volume par zone, Δ1RM Kalman par key lift avec IC, ΔCTL, corrélation TSB↔HRV (Plews 2013), recommandation motivée pour le bloc suivant (drift → deload anticipé). Module pur `public/blockreview.js`, 7 tests ajoutés (`node public/tests/run-tests.js` → 129 verts).

**Monitoring (optionnel)** — `docker-compose.monitoring.yml` (Uptime Kuma) : sondes app + backup, notifications ntfy/mail. Voir l'en-tête du fichier.

## Vérifications post-déploiement (2 min)

```bash
docker compose ps                                  # tous healthy
curl -sI -H 'Accept-Encoding: gzip' http://localhost:8080/static/app.js | grep -i content-encoding   # → gzip
docker compose logs coach-app | tail -5            # "backend stockage : MariaDB"
docker compose run --rm db-backup once             # premier dump OK
```

## Reste au backlog (voir PLAN-AMELIORATION-2026-07-09.md)

Chantiers de fond non inclus ici (à faire en sessions dédiées, code métier lourd) : découpage d'app.js en vues (§1.4) + purge CSP `style-src-attr` (§1.5), App struct Go (§1.6), Web Push (§6.1), passkeys (§3.3), normalisation progressive du blob workouts (§4.2), e2e étendus (§5.2).
