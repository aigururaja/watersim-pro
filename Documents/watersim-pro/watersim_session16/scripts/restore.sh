#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WaterSim Pro — Database restore (docker compose deployment)
#
# Usage:   ./scripts/restore.sh <path-to-dump>
# Example: ./scripts/restore.sh backups/watersim-20260903-023000.dump
#
# ⚠ DESTRUCTIVE: drops and recreates the application database, then restores
# the given pg_dump custom-format file into it. Asks for explicit confirmation
# (type the database name) before touching anything.
#
# Recommended: stop the API first so nothing writes mid-restore:
#   docker compose --env-file .env.prod -f docker-compose.prod.yml stop backend
# ...and start it again afterwards:
#   docker compose --env-file .env.prod -f docker-compose.prod.yml start backend
#
# Env overrides: COMPOSE_FILE, ENV_FILE
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
DUMP="${1:-}"

log()  { echo "[restore] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
fail() { echo "[restore] ERROR: $*" >&2; exit 1; }

[[ -n "$DUMP" ]]         || fail "usage: ./scripts/restore.sh <path-to-dump>"
[[ -f "$DUMP" ]]         || fail "dump file not found: $DUMP"
[[ -f "$ENV_FILE" ]]     || fail "$ENV_FILE not found (run from the deploy directory)"
[[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE not found"
command -v docker > /dev/null || fail "docker not found"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
[[ -n "$POSTGRES_DB" && -n "$POSTGRES_USER" ]] || fail "POSTGRES_DB / POSTGRES_USER missing from $ENV_FILE"

echo
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │  DESTRUCTIVE RESTORE                                         │"
echo "  └──────────────────────────────────────────────────────────────┘"
echo "  Database : $POSTGRES_DB"
echo "  Dump     : $DUMP ($(du -h "$DUMP" | cut -f1))"
echo
echo "  This DROPS the '$POSTGRES_DB' database and replaces it with the dump."
echo "  All data written since the dump was taken will be LOST."
echo
read -r -p "  Type the database name ('$POSTGRES_DB') to continue: " CONFIRM
[[ "$CONFIRM" == "$POSTGRES_DB" ]] || fail "confirmation did not match — aborting, nothing was changed"

log "Terminating open connections to $POSTGRES_DB..."
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();"

log "Dropping and recreating $POSTGRES_DB..."
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";"
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"

log "Restoring $DUMP..."
compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --role="$POSTGRES_USER" --exit-on-error < "$DUMP"

log "Sanity check — table count:"
compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"

log "Restore complete. Restart the API if you stopped it:"
log "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE start backend"
