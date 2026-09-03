#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WaterSim Pro — First-time TLS bootstrap (docker compose deployment)
#
# Usage:   ./scripts/init-tls.sh <domain> <email>
# Example: ./scripts/init-tls.sh app.watersim.example.com ops@example.com
#
# WHY: nginx (the `proxy` service) requires the certificate files at startup,
# but certbot's webroot renewal needs nginx running to answer the ACME
# challenge — a first-boot deadlock. This script breaks it by running certbot
# in STANDALONE mode (its own temporary web server on port 80) BEFORE the
# proxy ever starts. Run it exactly once per host, then:
#
#   docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d
#
# The long-running `certbot` service then handles renewals via webroot, and
# nginx serves /.well-known/acme-challenge/ from the shared volume.
#
# Requires: docker; port 80 free (stop the proxy first if it's running);
#           DNS for <domain> already pointing at this host.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
CERT_DIR="./nginx/certs"

log()  { echo "[init-tls] $*"; }
fail() { echo "[init-tls] ERROR: $*" >&2; exit 1; }

[[ -n "$DOMAIN" && -n "$EMAIL" ]] || fail "usage: ./scripts/init-tls.sh <domain> <email>"
command -v docker > /dev/null     || fail "docker not found"

if [[ -f "$CERT_DIR/live/$DOMAIN/fullchain.pem" ]]; then
  log "Certificate for $DOMAIN already exists at $CERT_DIR/live/$DOMAIN — nothing to do."
  log "For renewals, run the certbot service: docker compose --profile tls up -d"
  exit 0
fi

# Port 80 must be free for certbot's standalone challenge server
if docker ps --format '{{.Names}}' | grep -q '^watersim-proxy$'; then
  fail "watersim-proxy is running and holds port 80. Stop it first: docker compose --env-file .env.prod -f docker-compose.prod.yml stop proxy"
fi

mkdir -p "$CERT_DIR"

log "Requesting certificate for $DOMAIN (certbot standalone)..."
docker run --rm \
  -p 80:80 \
  -v "$(pwd)/nginx/certs:/etc/letsencrypt" \
  certbot/certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

[[ -f "$CERT_DIR/live/$DOMAIN/fullchain.pem" ]] || fail "certbot finished but $CERT_DIR/live/$DOMAIN/fullchain.pem is missing"

log "Certificate issued: $CERT_DIR/live/$DOMAIN/"
log "Now start the full stack (incl. the renewal sidecar):"
log "  docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d"
