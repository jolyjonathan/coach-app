#!/usr/bin/env bash
# =============================================================
# Coach Adaptatif — backup/restore MariaDB (service db-backup)
# =============================================================
# Tourne DANS le conteneur db-backup (image mariadb, voir docker-compose.yml).
# Modes :
#   daemon           boucle : dump quotidien à BACKUP_HOUR + rétention (défaut)
#   once             un dump immédiat puis exit (docker compose run --rm db-backup once)
#   check            healthcheck : exit 1 si le dernier dump réussi a > 26 h
#   restore <file>   restaure un dump (⚠️ ARRÊTER coach-app d'abord — voir BACKUPS.md)
#
# Env (tous optionnels sauf DB_PASSWORD) :
#   DB_HOST=db  DB_NAME=coach  DB_USER=coach  DB_PASSWORD=…
#   BACKUP_DIR=/backups        répertoire de sortie (volume db_backups)
#   BACKUP_HOUR=03             heure UTC du dump quotidien (00-23)
#   RETENTION_DAILY=7          nb de dumps quotidiens conservés
#   RETENTION_WEEKLY=4         nb de dumps hebdomadaires (dimanche) conservés
#   BACKUP_PASSPHRASE=…        si défini : chiffrement AES-256-CBC (openssl,
#                              PBKDF2 200k itérations). Fichiers en .enc.
#   DATA_DIR=/coach-data       si monté (ro) : tar des journaux d'audit &
#                              artefacts fichiers, joints au backup du jour.
#
# RGPD : la rétention borne le délai d'effacement effectif d'un compte
# supprimé (art. 17) à RETENTION_WEEKLY semaines. Documenté dans BACKUPS.md.
# =============================================================
set -euo pipefail

DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-coach}"
DB_USER="${DB_USER:-coach}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_HOUR="${BACKUP_HOUR:-03}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"
DATA_DIR="${DATA_DIR:-/coach-data}"
STAMP_FILE="$BACKUP_DIR/.last-success"

log() { printf '%s [db-backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }

encrypt_cmd() {
  # stdin → stdout. Chiffre si BACKUP_PASSPHRASE est défini, sinon passthrough.
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE
  else
    cat
  fi
}

decrypt_cmd() {
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE
  else
    cat
  fi
}

do_backup() {
  : "${DB_PASSWORD:?DB_PASSWORD requis}"
  local now day ext base tmp
  now="$(date -u +%Y%m%d-%H%M%S)"
  day="$(date -u +%u)" # 1=lundi … 7=dimanche
  ext="sql.gz"; [ -n "${BACKUP_PASSPHRASE:-}" ] && ext="sql.gz.enc"
  mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

  base="$BACKUP_DIR/daily/coach-$now.$ext"
  tmp="$base.tmp"
  log "dump de $DB_NAME@$DB_HOST → $base"
  # --single-transaction : snapshot cohérent InnoDB sans lock des écritures.
  # --quick : streaming ligne à ligne (pas de buffering RAM du dump complet).
  mariadb-dump -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" \
    --single-transaction --quick --triggers "$DB_NAME" \
    | gzip -6 | encrypt_cmd > "$tmp"
  # Refus des dumps suspects (vide ou quasi) plutôt qu'un faux sentiment de sécurité.
  if [ "$(stat -c%s "$tmp")" -lt 1024 ]; then
    rm -f "$tmp"; log "ERREUR : dump anormalement petit, non conservé"; return 1
  fi
  mv "$tmp" "$base"
  sha256sum "$base" > "$base.sha256"

  # Artefacts fichiers (journaux d'audit, ratelimit) si le volume est monté.
  if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    tar -C "$DATA_DIR" -czf - . | encrypt_cmd > "$BACKUP_DIR/daily/files-$now.tar.gz${BACKUP_PASSPHRASE:+.enc}"
  fi

  # Copie hebdomadaire le dimanche (GFS simplifié).
  if [ "$day" = "7" ]; then
    cp "$base" "$BACKUP_DIR/weekly/" && cp "$base.sha256" "$BACKUP_DIR/weekly/"
  fi

  # Rétention : on garde les N plus récents de chaque tiroir.
  prune "$BACKUP_DIR/daily"  "$RETENTION_DAILY"
  prune "$BACKUP_DIR/weekly" "$RETENTION_WEEKLY"

  date -u +%s > "$STAMP_FILE"
  log "backup OK ($(du -h "$base" | cut -f1))"
}

prune() {
  # Garde les $2 fichiers coach-* les plus récents de $1 (+ leurs .sha256 et
  # les archives files-* du même jour).
  local dir="$1" keep="$2"
  ls -1t "$dir"/coach-* 2>/dev/null | grep -v '\.sha256$' | tail -n "+$((keep + 1))" | while read -r f; do
    rm -f "$f" "$f.sha256"
    # files-<même timestamp>
    local ts; ts="$(basename "$f" | sed -E 's/^coach-([0-9-]+)\..*$/\1/')"
    rm -f "$dir/files-$ts."*
  done
}

do_check() {
  [ -f "$STAMP_FILE" ] || { echo "aucun backup réussi"; exit 1; }
  local age=$(( $(date -u +%s) - $(cat "$STAMP_FILE") ))
  if [ "$age" -gt $(( 26 * 3600 )) ]; then
    echo "dernier backup il y a ${age}s (> 26 h)"; exit 1
  fi
  echo "ok (dernier backup il y a $(( age / 3600 )) h)"
}

do_restore() {
  : "${DB_PASSWORD:?DB_PASSWORD requis}"
  local f="$1"
  [ -f "$f" ] || { log "fichier introuvable : $f"; exit 1; }
  if [ -f "$f.sha256" ]; then
    (cd "$(dirname "$f")" && sha256sum -c "$(basename "$f").sha256") || { log "CHECKSUM INVALIDE — restauration refusée"; exit 1; }
  fi
  log "⚠️  restauration de $f dans $DB_NAME@$DB_HOST — coach-app doit être ARRÊTÉ"
  case "$f" in
    *.enc) decrypt_cmd < "$f" | gunzip ;;
    *)     gunzip < "$f" ;;
  esac | mariadb -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"
  log "restauration terminée. Relancer : docker compose up -d coach-app"
}

daemon() {
  log "démarrage — dump quotidien à ${BACKUP_HOUR}h UTC, rétention ${RETENTION_DAILY}j + ${RETENTION_WEEKLY} sem."
  [ -n "${BACKUP_PASSPHRASE:-}" ] && log "chiffrement des dumps : ACTIVÉ" || log "chiffrement des dumps : désactivé (BACKUP_PASSPHRASE non défini)"
  # Rattrapage au boot : si aucun dump < 24 h, on dumpe tout de suite.
  if [ ! -f "$STAMP_FILE" ] || [ $(( $(date -u +%s) - $(cat "$STAMP_FILE") )) -gt $(( 24 * 3600 )) ]; then
    do_backup || log "backup de rattrapage échoué (retry au prochain créneau)"
  fi
  while true; do
    # Secondes jusqu'au prochain BACKUP_HOUR:00 UTC.
    local_now=$(date -u +%s)
    next=$(date -u -d "today ${BACKUP_HOUR}:00" +%s)
    [ "$next" -le "$local_now" ] && next=$(date -u -d "tomorrow ${BACKUP_HOUR}:00" +%s)
    sleep $(( next - local_now ))
    do_backup || log "backup planifié échoué (healthcheck passera au rouge sous 26 h)"
  done
}

case "${1:-daemon}" in
  daemon)  daemon ;;
  once)    do_backup ;;
  check)   do_check ;;
  restore) shift; do_restore "${1:?usage: restore <fichier>}" ;;
  *) echo "usage: $0 [daemon|once|check|restore <fichier>]"; exit 2 ;;
esac
