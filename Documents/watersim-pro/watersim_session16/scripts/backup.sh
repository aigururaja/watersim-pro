#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WaterSim Pro — Database backup (docker compose deployment)
#
# Usage:   ./scripts/backup.sh [output-dir]        (default: ./backups)
# Cron:    30 2 * * * cd /srv/watersim && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# Writes a timestamped pg_dump (custom format, pg_restore-compatible) via
# `docker compose exec postgres`, then prunes dumps older than RETENTION_DAYS
# (default 14). Restore with ./scripts/restore.sh <dump-file>.
#
# Env overrides: COMPOSE_FILE, ENV_FILE, RETENTION_DAYS
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
BACKUP_DIR="${1:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

log()  { echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]]     || fail "$ENV_FILE not found (run from the deploy directory)"
[[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE not found"
command -v docker > /dev/null || fail "docker not found"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# DB name/user come from .env.prod (same values the postgres container uses)
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
[[ -n "$POSTGRES_DB" && -n "$POSTGRES_USER" ]] || fail "POSTGRES_DB / POSTGRES_USER missing from $ENV_FILE"

mkdir -p "$BACKUP_DIR"

TS="$(date '+%Y%m%d-%H%M%S')"
OUT="$BACKUP_DIR/watersim-${TS}.dump"

log "Dumping ${POSTGRES_DB} -> ${OUT}"
# -Fc: custom format (compressed, selective restore via pg_restore)
compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "${OUT}.partial"
mv "${OUT}.partial" "${OUT}"

[[ -s "$OUT" ]] || fail "dump is empty: $OUT"
log "Wrote $(du -h "$OUT" | cut -f1) to $OUT"

log "Pruning dumps older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name 'watersim-*.dump' -mtime +"$RETENTION_DAYS" -print -delete
rm -f "$BACKUP_DIR"/*.partial

log "Current backups:"
ls -lh "$BACKUP_DIR" | grep 'watersim-' || true
log "Done"
