# Backups & restauration — Coach Adaptatif

Depuis la migration MariaDB, **toutes les données utilisateur vivent dans le volume `db_data`**. Le service `db-backup` (inclus dans les deux compose) les sauvegarde automatiquement. Ce document est le runbook : fonctionnement, restauration, copie hors-machine.

## Fonctionnement

Le service `db-backup` (image MariaDB, script `scripts/db-backup.sh`) fait chaque nuit à `BACKUP_HOUR` UTC (défaut 03h) :

1. `mariadb-dump --single-transaction` → snapshot cohérent sans bloquer l'app ;
2. gzip + checksum sha256, chiffrement AES-256 optionnel (`BACKUP_PASSPHRASE`) ;
3. archive tar des artefacts fichiers (journaux d'audit, ratelimit) du volume `coach_data` ;
4. rétention : `RETENTION_DAILY` quotidiens (défaut 7) + `RETENTION_WEEKLY` hebdomadaires du dimanche (défaut 4) ;
5. healthcheck Docker : le conteneur passe **unhealthy si le dernier dump réussi a plus de 26 h** — visible dans `docker compose ps`.

Configuration dans `.env` : `BACKUP_HOUR`, `RETENTION_DAILY`, `RETENTION_WEEKLY`, `BACKUP_PASSPHRASE` (chiffrement fortement recommandé : les dumps contiennent les hash bcrypt et les secrets chiffrés).

Dump manuel immédiat :

```bash
docker compose run --rm db-backup once
```

Lister les backups :

```bash
docker compose exec db-backup ls -lh /backups/daily /backups/weekly
```

## Restauration

⚠️ **Toujours arrêter l'app d'abord** — elle tient les users/sessions en mémoire et réécrirait des données fraîches par-dessus la restauration.

```bash
# 1. Stopper l'app (la base reste up)
docker compose stop coach-app

# 2. Restaurer (le checksum est vérifié automatiquement s'il est présent)
docker compose exec db-backup bash /scripts/db-backup.sh restore /backups/daily/coach-YYYYMMDD-HHMMSS.sql.gz
#   (fichier .enc : BACKUP_PASSPHRASE doit être défini dans .env)

# 3. Relancer l'app
docker compose up -d coach-app
```

Restaurer sur une machine neuve : `git pull` + `.env` reconstitué (**COACH_TOKEN_KEY et BACKUP_PASSPHRASE sont indispensables** — sans elles, TOTP/tokens et dumps chiffrés sont irrécupérables) → `docker compose up -d db` → copier le dump dans le volume (`docker compose cp dump.sql.gz db-backup:/backups/daily/`) → étapes 2-3.

## Test de restauration périodique

Un backup jamais restauré n'existe pas. Une fois par trimestre :

```bash
docker compose exec db mariadb -uroot -p"$DB_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS coach_restoretest"
docker compose exec db-backup bash -c 'gunzip < /backups/daily/<dernier>.sql.gz | mariadb -h db -ucoach -p"$DB_PASSWORD" coach_restoretest'
docker compose exec db mariadb -uroot -p"$DB_ROOT_PASSWORD" -e "SELECT COUNT(*) FROM coach_restoretest.users; DROP DATABASE coach_restoretest"
```

Le count doit correspondre au nombre de comptes. (Dump chiffré : déchiffrer avec `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000` avant le gunzip.)

## Copie hors-machine (fortement recommandé)

Les dumps restent sur le même disque que la base : un disque mort emporte les deux. Le volume `db_backups` peut être bind-monté sur un chemin host (voir commentaire dans docker-compose.yml) puis synchronisé, p. ex. :

```bash
# rclone vers n'importe quel stockage (S3, B2, Drive, SFTP…)
rclone sync /var/lib/coach-app/backups remote:coach-backups
# ou simple rsync vers une seconde machine
rsync -az --delete /var/lib/coach-app/backups/ backup-host:/srv/coach-backups/
```

À mettre en cron sur le host (l'app n'a pas besoin de connaître le remote — et ne doit pas : moins de credentials dans le conteneur).

## RGPD — rétention et effacement

L'effacement d'un compte (art. 17) est immédiat en base mais persiste dans les dumps jusqu'à expiration de la rétention, soit au plus `RETENTION_WEEKLY` semaines (défaut 4). C'est admis par les autorités de contrôle dès lors que c'est documenté et borné — cette page fait foi ; reporter la mention dans la politique de confidentialité si l'instance sert des tiers.
