#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WaterSim Pro — Production Deploy Script (image-pull based, with rollback)
#
# Usage:  IMAGE_TAG=<sha-or-latest> ./scripts/deploy.sh
#         (IMAGE_TAG / IMAGE_ORG may also come from .env.prod; exported env
#          vars take precedence over --env-file values in compose interpolation)
#
# Behaviour:
#   1. Records the currently deployed tag to .deploy/previous_tag BEFORE switching.
#   2. Pulls images from GHCR (never rebuilds on the host).
#   3. Runs migrations, then rolls services.
#   4. Health-checks /health with a retry loop (30 × 2s).
#   5. On failure, automatically rolls back to the previously deployed tag.
#
# Requires: docker compose v2, .env.prod on the server
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
STATE_DIR=".deploy"
CURRENT_TAG_FILE="$STATE_DIR/current_tag"
PREVIOUS_TAG_FILE="$STATE_DIR/previous_tag"

HEALTH_RETRIES=30
HEALTH_INTERVAL=2

log()  { echo "[deploy] $(date '+%H:%M:%S') $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ── Validation ────────────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]]          || fail "$ENV_FILE not found. Copy from .env.prod.example"
[[ -f "$COMPOSE_FILE" ]]      || fail "$COMPOSE_FILE not found"
command -v docker > /dev/null || fail "docker not found"

mkdir -p "$STATE_DIR"

# ── Resolve target tag ────────────────────────────────────────────────────────
# Priority: exported IMAGE_TAG > IMAGE_TAG in .env.prod > latest
if [[ -z "${IMAGE_TAG:-}" ]]; then
  IMAGE_TAG="$(grep -E '^IMAGE_TAG=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
fi
IMAGE_TAG="${IMAGE_TAG:-latest}"
export IMAGE_TAG

PREVIOUS_TAG=""
[[ -f "$CURRENT_TAG_FILE" ]] && PREVIOUS_TAG="$(cat "$CURRENT_TAG_FILE")"

log "Target tag:   $IMAGE_TAG"
log "Previous tag: ${PREVIOUS_TAG:-<none recorded>}"

# ── Health check with retries ─────────────────────────────────────────────────
# Hits the backend container directly (avoids TLS / proxy-redirect concerns).
wait_healthy() {
  local attempt
  for (( attempt=1; attempt<=HEALTH_RETRIES; attempt++ )); do
    if compose exec -T backend wget -qO- http://localhost:4000/health 2>/dev/null \
        | grep -q '"status":"healthy"'; then
      log "Health check passed (attempt $attempt/$HEALTH_RETRIES)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# ── Deploy one tag: pull → migrate → up ──────────────────────────────────────
deploy_tag() {
  local tag="$1"
  export IMAGE_TAG="$tag"

  log "Pulling images (tag: $tag)..."
  compose pull migrate backend frontend

  log "Running database migrations..."
  compose run --rm migrate

  log "Updating containers..."
  compose up -d --no-deps --remove-orphans backend frontend proxy
}

# ── Record previous tag BEFORE switching ─────────────────────────────────────
if [[ -n "$PREVIOUS_TAG" ]]; then
  echo "$PREVIOUS_TAG" > "$PREVIOUS_TAG_FILE"
fi

log "Starting deployment..."
deploy_tag "$IMAGE_TAG"

log "Waiting for health check..."
if wait_healthy; then
  echo "$IMAGE_TAG" > "$CURRENT_TAG_FILE"
  log "Pruning dangling images..."
  docker image prune -f > /dev/null
  log "Deploy complete (tag: $IMAGE_TAG)"
  exit 0
fi

# ── Rollback ──────────────────────────────────────────────────────────────────
log "Health check FAILED for tag $IMAGE_TAG"
compose logs --tail=100 backend || true

if [[ -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$IMAGE_TAG" ]]; then
  log "Rolling back to previous tag: $PREVIOUS_TAG"
  deploy_tag "$PREVIOUS_TAG"
  if wait_healthy; then
    echo "$PREVIOUS_TAG" > "$CURRENT_TAG_FILE"
    fail "Deploy of $IMAGE_TAG failed — rolled back to $PREVIOUS_TAG (healthy)."
  else
    fail "Deploy of $IMAGE_TAG failed AND rollback to $PREVIOUS_TAG is unhealthy. Manual intervention required."
  fi
else
  fail "Deploy of $IMAGE_TAG failed and no previous tag is recorded — cannot roll back automatically."
fi
