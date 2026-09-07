# RUNBOOK — Traditional deployment on Ubuntu (no Docker)

Audience: anyone standing up WaterSim Pro on a single Ubuntu server with
system packages, systemd and nginx — no containers, no Kubernetes.
Last updated: 2026-09-07.

The Docker and Kubernetes procedures live in `RUNBOOK-deploy.md`. This runbook
is self-contained; you do not need that one to follow it.

---

## 1. What you end up with

```
Internet ──► nginx :80/:443 (TLS via certbot)
               │  /            static files      /var/www/watersim  (Vite build)
               │  /api/  /ws/  /health  ───────► node src/server.js  127.0.0.1:4000
               │                                  systemd unit watersim-backend
               │                                  user watersim, /opt/watersim/app/backend
               │                                    ├─ Python venv /opt/watersim/venv
               │                                    │    PDF/Excel reports, PLC bridge
               │                                    └─ PostgreSQL 16  127.0.0.1:5432
               └─ /metrics is NOT proxied (scrape 127.0.0.1:4000/metrics locally)
```

One process does everything the compose stack spreads over five containers:
the API, the WebSocket server, the PLC poller, the historian roll-ups, the
alarm sweep, the notification worker and the digital-twin loop all run inside
`src/server.js`. There is nothing else to schedule except backups and TLS
renewal.

How this differs from the container runbook:

| | Docker / k8s | This runbook |
|---|---|---|
| Frontend | nginx container serves the image's `dist` | host nginx serves `/var/www/watersim` |
| Backend | `ghcr.io/…/watersim-backend` image | `node` from NodeSource, managed by systemd |
| Database | `postgres:16-alpine`, no TLS | Ubuntu's `postgresql-16` on loopback, `sslmode=disable` (see §5) |
| Python | baked into the backend image | a venv at `/opt/watersim/venv`, pointed to by `PYTHON_BIN` |
| TLS | `scripts/init-tls.sh` + certbot sidecar | `certbot` package + its systemd timer |
| Config | `.env.prod` read by compose | `/etc/watersim/backend.env` read by systemd |

## 2. Server specification

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS (ships PostgreSQL 16 and Python 3.12) |
| vCPU | 2 | 4 — each simulation run is a worker thread; keep `SIMULATION_MAX_CONCURRENT` ≤ vCPUs |
| RAM | 4 GB | 8 GB — the Vite build transiently needs ~2 GB on top of the running stack |
| Disk | 40 GB SSD | 80 GB — the historian writes ~1 GB/day of raw samples at a 2 s poll over 340 tags |
| Swap | 2 GB | 2 GB — so a build cannot OOM-kill Postgres |

Inbound ports: **22, 80, 443** only. The backend listens on `0.0.0.0:4000`
(hardcoded in `src/server.js`); the firewall in §11 keeps it off the internet.

A **DNS A record for your domain must already point at this server** before
§12 — Let's Encrypt validates over HTTP on port 80.

Runtime versions used below. The repo's CI and Dockerfiles pin Node 20 and the
dev machines run Node 24; `package.json` declares `>=18`. Node 20 left LTS
support in April 2026, so install **Node 22 LTS**.

## 3. Base packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git gnupg nginx ufw rsync \
  python3 python3-venv python3-pip certbot

# Node.js 22 LTS from NodeSource (Ubuntu's own nodejs package is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version && npm --version            # v22.x, npm 10.x

# PostgreSQL 16
# Ubuntu 24.04: the distro package IS 16
sudo apt-get install -y postgresql postgresql-contrib
# Ubuntu 22.04 ships 14 — use the PGDG repo instead of the line above:
#   sudo install -d /usr/share/postgresql-common/pgdg
#   sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
#     https://www.postgresql.org/media/keys/ACCC4CF8.asc
#   echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
#     https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
#     | sudo tee /etc/apt/sources.list.d/pgdg.list
#   sudo apt-get update && sudo apt-get install -y postgresql-16
psql --version                              # 16.x
```

## 4. Service user and directories

```bash
sudo useradd --system --create-home --home-dir /opt/watersim --shell /usr/sbin/nologin watersim
sudo install -d -o root -g root -m 755 /var/www/watersim         # frontend build
sudo install -d -o root -g watersim -m 750 /etc/watersim         # env file
sudo install -d -o postgres -g postgres -m 750 /var/backups/watersim
```

`watersim` owns the checkout and the venv, runs the API, and can read (not
write) `/etc/watersim/backend.env`. It has no login shell; every command
below that must run as it uses `sudo -u watersim -H …`, which needs no shell.

## 5. PostgreSQL

```bash
DB_PASS="$(openssl rand -hex 24)"          # hex only — safe inside a URL
echo "$DB_PASS"                            # keep this for §8

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE watersim LOGIN PASSWORD '${DB_PASS}';
CREATE DATABASE watersim_prod OWNER watersim;
\c watersim_prod
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
```

The first migration creates both extensions itself, and on PostgreSQL 13+
they are "trusted" so the database owner may do that. Creating them here as
`postgres` removes the doubt.

Ubuntu's PostgreSQL listens on `127.0.0.1` only and accepts password auth from
loopback out of the box (`host all all 127.0.0.1/32 scram-sha-256` in
`pg_hba.conf`) — nothing to change.

**Why `sslmode=disable` in the URL.** `backend/src/db/pool.js` turns on TLS
with certificate verification whenever `NODE_ENV=production`. Ubuntu's
PostgreSQL has `ssl = on` with a self-signed "snakeoil" certificate, which
verification rejects, and turning verification off still costs a TLS
handshake per connection to `127.0.0.1`. Appending `?sslmode=disable` to
`DATABASE_URL` overrides the pool's setting (the connection string wins) and
is the right call for a loopback database. Use TLS again if you ever move the
database to another host.

Optional tuning for a 4–8 GB box, in
`/etc/postgresql/16/main/conf.d/watersim.conf` (create it; `conf.d` is
included by default):

```ini
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 16MB
maintenance_work_mem = 256MB
```

then `sudo systemctl restart postgresql`.

## 6. Python virtual environment

PDF reports use reportlab + matplotlib + numpy, Excel exports use openpyxl,
and the PLC bridge uses asyncua / python-snap7 / pycomm3. The backend spawns
whatever `PYTHON_BIN` names, so put all of it in one venv owned by the
service user. (Ubuntu 23.04+ refuses system-wide `pip install`; a venv is the
supported route anyway.)

```bash
sudo -u watersim -H python3 -m venv /opt/watersim/venv
sudo -u watersim -H /opt/watersim/venv/bin/pip install --upgrade pip
sudo -u watersim -H /opt/watersim/venv/bin/pip install \
  reportlab==4.2.5 openpyxl==3.1.5 matplotlib numpy
```

The PLC driver packages come from the repo's pin file, so install them after
the checkout in §7:

```bash
sudo -u watersim -H /opt/watersim/venv/bin/pip install \
  -r /opt/watersim/app/backend/requirements-plc.txt
sudo -u watersim -H /opt/watersim/venv/bin/python -c \
  'import reportlab, matplotlib, numpy, openpyxl, asyncua, snap7, pycomm3; print("python deps ok")'
```

The PLC packages are optional: without them the backend still runs and the
PLC page lists those protocols as stubs with a reason. Reports are not
optional — PDF and Excel export fail without reportlab/matplotlib/openpyxl.

## 7. Code, frontend build, backend dependencies

```bash
sudo -u watersim -H git clone <your-repo-url> /opt/watersim/app
cd /opt/watersim/app
```

Now the two installs. This is an npm-workspaces monorepo with one root
lockfile and one hoisted `node_modules`, and **`npm ci` wipes `node_modules`
before installing**. So build the frontend first (it needs dev dependencies:
Vite, Tailwind), copy the output out, and only then install the backend's
production dependencies.

```bash
export DOMAIN=app.example.com                          # your real hostname

# 1. Frontend: full install of the frontend workspace, then build.
#    Both VITE_ variables are baked in at build time.
#    VITE_WS_URL is the bare origin — the hooks append /ws/flowsheets/… and
#    /ws/org themselves (frontend/src/hooks/useCollaboration.js, useOrgLive.js).
sudo -u watersim -H npm ci --workspace=frontend --ignore-scripts
sudo -u watersim -H env VITE_API_BASE=/api/v1 VITE_WS_URL="wss://$DOMAIN" \
  npm run build --workspace=frontend
sudo rsync -a --delete frontend/dist/ /var/www/watersim/

# 2. Backend: production dependencies only (no native modules, so scripts are not needed)
sudo -u watersim -H npm ci --workspace=backend --omit=dev --ignore-scripts

# 3. PLC bridge Python packages (pinned in the repo)
sudo -u watersim -H /opt/watersim/venv/bin/pip install -r backend/requirements-plc.txt
```

Do not leave a `backend/.env` from a dev checkout on the server. `dotenv`
loads it from the working directory; it cannot override variables systemd
already set, but it can silently supply ones you forgot.

## 8. Backend environment file

`/etc/watersim/backend.env` is the bare-metal equivalent of `.env.prod`.
Everything below is read by `src/server.js`, `src/config/index.js` or one of
the workers; `.env.prod.example` documents each block in more depth.

```bash
JWT="$(openssl rand -hex 32)"
sudo tee /etc/watersim/backend.env >/dev/null <<ENV
# ── Server ───────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=4000
API_VERSION=v1
LOG_LEVEL=info

# ── Origin (CORS + links in notifications) ───────────────────────────────────
CORS_ORIGIN=https://${DOMAIN}
APP_URL=https://${DOMAIN}

# ── Database — loopback, no TLS (see §5) ─────────────────────────────────────
DATABASE_URL=postgres://watersim:${DB_PASS}@127.0.0.1:5432/watersim_prod?sslmode=disable
DB_POOL_MIN=2
DB_POOL_MAX=20
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=5000

# ── JWT (≥ 32 chars, enforced at boot) ───────────────────────────────────────
JWT_SECRET=${JWT}
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ── Live role check / security / rate limits ─────────────────────────────────
ROLE_CACHE_TTL_MS=30000
ROLE_LOOKUP_TIMEOUT_MS=500
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
AUTH_RATE_LIMIT_MAX=10

# ── Simulation engine (worker threads — keep ≤ vCPUs) ────────────────────────
SIMULATION_MAX_CONCURRENT=4
SIMULATION_TIMEOUT_MS=60000

# ── Python (reports + PLC bridge) ────────────────────────────────────────────
PYTHON_BIN=/opt/watersim/venv/bin/python
PY_REPORT_TIMEOUT_MS=30000
MPLCONFIGDIR=/tmp/mpl

# ── PLC integration ──────────────────────────────────────────────────────────
PLC_ALLOW_LOCAL_HOSTS=false
PLC_BRIDGE_MAX_CHILDREN=4

# ── Historian ────────────────────────────────────────────────────────────────
HISTORIAN_RAW_RETENTION_DAYS=30
HISTORIAN_1M_RETENTION_DAYS=730
HISTORIAN_1H_RETENTION_DAYS=3650
HISTORIAN_ROLLUP_INTERVAL_MS=60000
ALARM_QUALITY_SWEEP_MS=5000

# ── Notifications ────────────────────────────────────────────────────────────
NOTIFICATIONS_DRY_RUN=false
NOTIFICATIONS_WORKER_INTERVAL_MS=5000
NOTIFICATIONS_MAX_ATTEMPTS=8
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="WaterSim Pro <no-reply@${DOMAIN}>"
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=+14155238886
NOTIFY_TZ=Asia/Kolkata

# ── Digital twin ─────────────────────────────────────────────────────────────
TWIN_TICK_MS=5000
TWIN_MEASUREMENT_FRESH_MS=300000

# ── CMMS boundary ────────────────────────────────────────────────────────────
WEBHOOK_ALLOW_LOCAL_HOSTS=false
WEBHOOK_TIMEOUT_MS=10000
CMMS_URL=http://cmms.internal:8000
CMMS_API_KEY=
ENV
sudo chown root:watersim /etc/watersim/backend.env
sudo chmod 640 /etc/watersim/backend.env
```

`MPLCONFIGDIR` gives matplotlib a writable cache under the unit's private
`/tmp` (the same trick `k8s/backend.yaml` uses). Leave `PLC_ALLOW_LOCAL_HOSTS`
and `WEBHOOK_ALLOW_LOCAL_HOSTS` off unless the server sits on an isolated OT
network — both open an SSRF surface.

## 9. Migrate, seed, and a helper for one-off commands

Every one-off command (migrations, seeds, `sync-cmms-assets.js`) must run as
`watersim`, inside `backend/`, with the production environment loaded. Save
this helper once:

```bash
sudo tee /usr/local/bin/watersim-node >/dev/null <<'EOS'
#!/usr/bin/env bash
# Run `node <args>` inside backend/ with /etc/watersim/backend.env loaded.
# Usage: sudo -u watersim -H watersim-node src/db/migrate.js status
set -euo pipefail
set -a; . /etc/watersim/backend.env; set +a
cd /opt/watersim/app/backend
exec node "$@"
EOS
sudo chmod 755 /usr/local/bin/watersim-node
```

Then:

```bash
sudo -u watersim -H watersim-node src/db/migrate.js up       # 001 … 015
sudo -u watersim -H watersim-node src/db/migrate.js status   # nothing pending
```

Seeding is optional. It creates the demo organisation, three users and the
ITC STP flowsheet with its permit template and alarm rules. The seed users
have **published passwords** (`admin@watersim.dev` / `Admin1234!`, printed by
the seed), so on a client-facing server either skip the seed and create the
first admin through the app, or seed and change every password before the
box is reachable:

```bash
sudo -u watersim -H watersim-node src/seeds/index.js
```

## 10. systemd unit for the backend

```bash
sudo tee /etc/systemd/system/watersim-backend.service >/dev/null <<'UNIT'
[Unit]
Description=WaterSim Pro API (Node.js)
Documentation=file:///opt/watersim/app/docs/RUNBOOK-deploy-ubuntu.md
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=watersim
Group=watersim
WorkingDirectory=/opt/watersim/app/backend
EnvironmentFile=/etc/watersim/backend.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
# server.js drains on SIGTERM (WS close frames, HTTP, pg pool) and force-exits after 10 s
KillSignal=SIGTERM
TimeoutStopSec=20
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=watersim-backend

# Hardening — the process writes nothing to disk except matplotlib's cache in /tmp
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now watersim-backend
sudo systemctl status watersim-backend --no-pager
curl -fsS http://127.0.0.1:4000/health      # {"status":"healthy","db":"connected",…}
```

Logs are JSON lines in the journal:

```bash
journalctl -u watersim-backend -f
journalctl -u watersim-backend --since "1 hour ago" | grep -i error
```

## 11. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Port 4000 stays closed; nginx reaches it over loopback. Outbound stays open
for SMTP, Twilio, CMMS webhooks and PLCs.

## 12. nginx and TLS

### 12.1 Bootstrap site (HTTP only) and the certificate

nginx must already answer on port 80 for the ACME challenge, and the final
config needs the certificate files to exist, so start with a minimal HTTP
site:

```bash
sudo tee /etc/nginx/sites-available/watersim >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    root /var/www/watersim;
    location / { try_files \$uri \$uri/ /index.html; }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/watersim /etc/nginx/sites-enabled/watersim
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/watersim -d "$DOMAIN" \
  --email ops@example.com --agree-tos --non-interactive \
  --deploy-hook "systemctl reload nginx"
sudo ls /etc/letsencrypt/live/"$DOMAIN"/       # fullchain.pem privkey.pem
```

The `certbot` package installs `certbot.timer`, which runs `certbot renew`
twice a day with the same webroot and deploy hook. Check it with
`systemctl list-timers certbot.timer` and rehearse with
`sudo certbot renew --dry-run`.

### 12.2 Final site

This mirrors `nginx/frontend.conf` + `nginx/proxy.conf` from the repo, with
two additions those files lack: `client_max_body_size` (Express accepts JSON
up to 5 MB; nginx's 1 MB default would return 413 on a large flowsheet save)
and a no-cache rule for `index.html` so a deploy is picked up on the next
page load. `expires` is used instead of `add_header` inside locations so the
security headers set at server level are inherited everywhere.

```bash
sudo tee /etc/nginx/sites-available/watersim >/dev/null <<NGINX
upstream watersim_api {
    server 127.0.0.1:4000;
    keepalive 32;
}

# HTTP: ACME challenge, everything else → HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ { root /var/www/watersim; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options          "SAMEORIGIN"    always;
    add_header X-Content-Type-Options   "nosniff"       always;
    add_header Referrer-Policy          "strict-origin" always;

    client_max_body_size 10m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # ── React SPA (Vite build) ──────────────────────────────────────────────
    root  /var/www/watersim;
    index index.html;

    location ~* \.(js|css|woff2?|ttf|eot|svg|ico|png|jpg|webp)\$ {
        expires 1y;                      # Vite filenames carry a content hash
        try_files \$uri =404;
    }
    location = /index.html { expires -1; }          # Cache-Control: no-cache
    location / { try_files \$uri \$uri/ /index.html; }

    # ── API ─────────────────────────────────────────────────────────────────
    location /api/ {
        proxy_pass         http://watersim_api;
        proxy_http_version 1.1;
        proxy_set_header   Connection        "";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    # ── WebSocket: /ws/flowsheets/<id> and /ws/org ──────────────────────────
    location /ws/ {
        proxy_pass         http://watersim_api;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    # ── Readiness probe (DB check, cached 5 s server-side) ──────────────────
    location = /health { proxy_pass http://watersim_api/health; }

    # /metrics is deliberately NOT proxied. Scrape http://127.0.0.1:4000/metrics
    # from the host; it is unauthenticated and outside the rate limiter.
}
NGINX
sudo nginx -t && sudo systemctl reload nginx
```

The backend sets `trust proxy` to 1 and keys its rate limiters on the client
IP, so the `X-Forwarded-For` header above is required, not cosmetic.

## 13. Verify

```bash
curl -fsS https://$DOMAIN/health | python3 -m json.tool     # status healthy, db connected
curl -o /dev/null -sw '%{http_code}\n' https://$DOMAIN/api/v1/plant   # 401 = route mounted
curl -o /dev/null -sw '%{http_code}\n' https://$DOMAIN/some/spa/route # 200 = SPA fallback
curl -sI https://$DOMAIN/ | grep -i strict-transport                   # HSTS present
sudo ss -ltnp | grep -E ':(80|443|4000|5432)\b'   # 5432 on 127.0.0.1; 4000 on 0.0.0.0 but blocked by ufw (§11)
```

Then in a browser: log in, open a flowsheet, and confirm in the developer
tools' Network tab that `wss://<domain>/ws/flowsheets/<id>` reaches status
101. Export a PDF and an Excel report from a project — those two exercise the
Python venv. On the PLC page the OPC UA / S7 / EtherNet/IP protocols should
read "available" rather than "stub".

## 14. Backups

PostgreSQL is the only state. `scripts/backup.sh` in the repo is written for
compose; this is its bare-metal twin, run as the `postgres` user (peer auth,
no password needed):

```bash
sudo tee /usr/local/bin/watersim-backup >/dev/null <<'EOS'
#!/usr/bin/env bash
# Nightly pg_dump (custom format) of watersim_prod, pruned after RETENTION_DAYS.
set -euo pipefail
DIR=/var/backups/watersim
KEEP="${RETENTION_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/watersim-$TS.dump"
pg_dump --format=custom -d watersim_prod > "$OUT.partial"
mv "$OUT.partial" "$OUT"
[[ -s "$OUT" ]] || { echo "empty dump: $OUT" >&2; exit 1; }
find "$DIR" -name 'watersim-*.dump' -mtime +"$KEEP" -print -delete
echo "$(date '+%F %T') wrote $(du -h "$OUT" | cut -f1) $OUT"
EOS
sudo chmod 755 /usr/local/bin/watersim-backup

sudo -u postgres /usr/local/bin/watersim-backup            # run once now
( sudo -u postgres crontab -l 2>/dev/null; \
  echo '30 2 * * * /usr/local/bin/watersim-backup >> /var/backups/watersim/backup.log 2>&1' ) \
  | sudo -u postgres crontab -
```

Copy `/var/backups/watersim/` off the machine from the same cron (`rclone`,
`rsync` to another host, object storage). A dump on the same disk does not
survive the disk.

**Restore** (destructive — replaces the database):

```bash
sudo systemctl stop watersim-backend
sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = 'watersim_prod' AND pid <> pg_backend_pid();"
sudo -u postgres dropdb watersim_prod
sudo -u postgres createdb -O watersim watersim_prod
sudo -u postgres pg_restore -d watersim_prod --no-owner --role=watersim --exit-on-error \
  /var/backups/watersim/watersim-YYYYMMDD-HHMMSS.dump
sudo systemctl start watersim-backend
```

Rehearse this once on a fresh database before you need it.

## 15. Updating to a new version

Same order as the first install: frontend build, publish `dist`, backend
install, migrate, restart. Save it as a script so every update is identical:

```bash
sudo tee /usr/local/bin/watersim-update >/dev/null <<'EOS'
#!/usr/bin/env bash
# Update WaterSim Pro from git. Usage: sudo DOMAIN=app.example.com watersim-update [git-ref]
set -euo pipefail
: "${DOMAIN:?set DOMAIN=<public hostname>}"
APP=/opt/watersim/app
REF="${1:-}"
cd "$APP"

# git runs as the checkout's owner — root would trip git's "dubious ownership" check
sudo -u watersim -H git fetch --all --tags
if [[ -n "$REF" ]]; then sudo -u watersim -H git checkout --detach "$REF"
else                    sudo -u watersim -H git pull --ff-only; fi
echo "deploying $(sudo -u watersim -H git rev-parse --short HEAD)"

sudo -u watersim -H npm ci --workspace=frontend --ignore-scripts
sudo -u watersim -H env VITE_API_BASE=/api/v1 VITE_WS_URL="wss://$DOMAIN" \
  npm run build --workspace=frontend
sudo -u watersim -H npm ci --workspace=backend --omit=dev --ignore-scripts
sudo -u watersim -H /opt/watersim/venv/bin/pip install -q -r backend/requirements-plc.txt

sudo -u watersim -H /usr/local/bin/watersim-node src/db/migrate.js up
rsync -a --delete frontend/dist/ /var/www/watersim/
systemctl restart watersim-backend

for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/health" | grep -q '"status":"healthy"'; then
    echo "healthy after ${i}x2s"; exit 0
  fi
  sleep 2
done
echo "backend did not become healthy — journalctl -u watersim-backend -n 100" >&2
exit 1
EOS
sudo chmod 755 /usr/local/bin/watersim-update
```

```bash
sudo -u postgres /usr/local/bin/watersim-backup         # always back up first
sudo DOMAIN=app.example.com watersim-update             # latest on the current branch
sudo DOMAIN=app.example.com watersim-update v1.4.0      # or a tag / commit
```

Migrations run while the old process is still serving; they are additive and
the compose flow does the same.

**Rollback:** `sudo DOMAIN=… watersim-update <previous-commit>`. Migrations
are forward-only — rolling back past a schema change needs
`sudo -u watersim -H watersim-node src/db/migrate.js down` first (one
migration per call), or a restore from §14.

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Boot log: `The server does not support SSL connections` or `self signed certificate` | `DATABASE_URL` lacks `?sslmode=disable` (§5) |
| Boot exits: `JWT_SECRET must be at least 32 characters` / `Missing required env var … CORS_ORIGIN` | fix `/etc/watersim/backend.env`; `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` are mandatory in production |
| `/health` returns 503 `degraded` | Postgres down or wrong credentials: `sudo -u postgres psql -c '\du'`, `journalctl -u postgresql` |
| Saving a large flowsheet → 413 | `client_max_body_size` missing from the nginx site (§12.2) |
| WebSocket never reaches 101; console shows `wss://…/ws/ws/…` | frontend was built with `VITE_WS_URL` ending in `/ws`; rebuild with the bare origin (§7) |
| WebSocket 400/502 | nginx `/ws/` location lacks the `Upgrade`/`Connection` headers |
| PDF/Excel export 500; log says `Failed to spawn … python` | `PYTHON_BIN` wrong or venv missing packages (§6); test with the one-line import check |
| PLC protocols listed as "stub" | `requirements-plc.txt` not installed into the venv; the reason is shown on the PLC page |
| Everyone gets 429 at once | nginx not sending `X-Forwarded-For`, so all clients share one IP in the rate limiter |
| A route you know exists returns 404 after an update | backend not restarted after `git pull`; `systemctl restart watersim-backend` |
| Browser shows the old UI after an update | `index.html` cached; the `expires -1` rule in §12.2 prevents it going forward, hard-refresh once |
| `npm ci` fails with lockfile errors | run it from `/opt/watersim/app` (repo root) with `--workspace=…`, never inside `backend/` or `frontend/` |
| `certbot renew --dry-run` fails | port 80 blocked, or the HTTP server block lost its `/.well-known/acme-challenge/` location |
| Disk filling up | historian raw partitions: lower `HISTORIAN_RAW_RETENTION_DAYS`; check `du -sh /var/lib/postgresql /var/backups/watersim` |
