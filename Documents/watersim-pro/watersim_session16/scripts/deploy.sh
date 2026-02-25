#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WaterSim Pro — Production Deploy Script
# Usage: ./scripts/deploy.sh [--env staging|production]
#
# Requires: docker compose v2, .env.prod on the server
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-production}"
COMPOSE_FILE="docker-compose.prod.yml"

log()  { echo "[deploy] $(date '+%H:%M:%S') $*"; }
fail() { echo "[deploy] ✗ $*" >&2; exit 1; }

# ── Validation ────────────────────────────────────────────────────────────────
[[ -f ".env.prod" ]]          || fail ".env.prod not found. Copy from .env.prod.example"
[[ -f "$COMPOSE_FILE" ]]      || fail "$COMPOSE_FILE not found"
command -v docker > /dev/null  || fail "docker not found"

log "Starting $ENV deployment..."

# ── Pull latest images ────────────────────────────────────────────────────────
log "Pulling images..."
docker compose -f "$COMPOSE_FILE" pull backend frontend

# ── Run migrations ────────────────────────────────────────────────────────────
log "Running database migrations..."
docker compose -f "$COMPOSE_FILE" run --rm migrate

# ── Rolling update (zero downtime) ───────────────────────────────────────────
log "Updating containers..."
docker compose -f "$COMPOSE_FILE" up -d \
  --no-deps \
  --remove-orphans \
  backend frontend proxy

# ── Health check ─────────────────────────────────────────────────────────────
log "Waiting for health check..."
sleep 10
HEALTH_URL="http://localhost/health"
STATUS=$(curl -sf "$HEALTH_URL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unreachable")
if [[ "$STATUS" == "healthy" ]]; then
  log "✓ Health check passed"
else
  fail "Health check failed (status: $STATUS). Check logs: docker compose -f $COMPOSE_FILE logs backend"
fi

# ── Prune old images ──────────────────────────────────────────────────────────
log "Pruning dangling images..."
docker image prune -f

log "✓ Deploy complete"
