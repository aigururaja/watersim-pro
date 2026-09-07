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
               │                                    └─ SQLite file /opt/watersim/data/watersim.db
               └─ /metrics is NOT proxied (scrape 127.0.0.1:4000/metrics locally)
```

One process does everything the compose stack spreads over five containers:
the API, the WebSocket server, the PLC poller, the historian roll-ups, the
alarm sweep, the notification worker and the digital-twin loop all run inside
`src/server.js`, and the database is a single SQLite file it opens itself
(`node:sqlite`, built into Node 22). There is nothing else to schedule except
backups and TLS renewal, and no database server to run.

How this differs from the container runbook:

| | Docker / k8s | This runbook |
|---|---|---|
| Frontend | nginx container serves the image's `dist` | host nginx serves `/var/www/watersim` |
| Backend | `ghcr.io/…/watersim-backend` image | `node` 22, managed by systemd |
| Database | `postgres:16-alpine` container | one SQLite file under `/opt/watersim/data` (PostgreSQL still works: Appendix A) |
| Python | baked into the backend image | a venv at `/opt/watersim/venv`, pointed to by `PYTHON_BIN` |
| TLS | `scripts/init-tls.sh` + certbot sidecar | `certbot` package + its systemd timer |
| Config | `.env.prod` read by compose | `/etc/watersim/backend.env` read by systemd |

## 2. Server specification

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS (ships Python 3.12) |
| vCPU | 1 | 2 — each simulation run is a worker thread; keep `SIMULATION_MAX_CONCURRENT` ≤ vCPUs |
| RAM | 2 GB | 4 GB. Build the frontend elsewhere if the box has less than 4 GB: the Vite build transiently needs ~2 GB |
| Disk | 20 GB SSD | 40 GB — the historian writes ~1 GB/day of raw samples at a 2 s poll over 340 tags |
| Swap | 1 GB | 2 GB |

Inbound ports: **22, 80, 443** only. The backend listens on `0.0.0.0:4000`
(hardcoded in `src/server.js`); the firewall in §11 keeps it off the internet.

A **DNS A record for your domain must already point at this server** before
§12 — Let's Encrypt validates over HTTP on port 80.

Node: the SQLite driver uses `node:sqlite`, which needs **Node 22.13 or
newer** (Node 22 LTS or 24). The repo's CI still pins 20 for the Postgres path;
`package.json` declares `>=18`. Install Node 22 LTS.

## 3. Base packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git gnupg nginx ufw rsync \
  python3 python3-venv python3-pip certbot

# Node.js 22 LTS from NodeSource (Ubuntu's own nodejs package is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version && npm --version            # v22.x, npm 10.x
```

On a server that already runs another Node app on the distro's `/usr/bin/node`,
do not replace it: unpack the official Node 22 tarball into a private
directory instead (`curl -fsSL https://nodejs.org/dist/v22.x.y/node-v22.x.y-linux-x64.tar.xz | sudo tar -xJ --strip-components=1 -C /opt/watersim/node`)
and use `/opt/watersim/node/bin/node` everywhere this runbook says `node`.

No database package is needed. (For PostgreSQL instead, see Appendix A.)

## 4. Service user and directories

```bash
sudo useradd --system --create-home --home-dir /opt/watersim --shell /usr/sbin/nologin watersim
sudo install -d -o watersim -g watersim -m 700 /opt/watersim/data      # the SQLite file
sudo install -d -o root -g root -m 755 /var/www/watersim               # frontend build
sudo install -d -o root -g watersim -m 750 /etc/watersim               # env file
sudo install -d -o watersim -g watersim -m 750 /var/backups/watersim   # backups
```

`watersim` owns the checkout, the venv and the database, runs the API, and
can read (not write) `/etc/watersim/backend.env`. It has no login shell; every
command below that must run as it uses `sudo -u watersim -H …`, which needs
no shell.

## 5. The database

The backend opens `DATABASE_URL=sqlite:<path>` on start, creates the file if
it is missing, and keeps it in WAL mode (`watersim.db`, `watersim.db-wal`,
`watersim.db-shm` side by side — back up all three or, better, use the
`VACUUM INTO` copy in §14). Everything the application needs — NOW(),
UUID defaults, `REGEXP` for the phone-number check — is registered by the
driver at open, so the file must always be written through the application;
another tool can read it freely.

Rules that follow from one process owning one file:

- **One backend process per file.** systemd's `Restart=always` gives you that.
  Never run a second copy (a dev server, a one-off script that keeps running)
  against the production file at the same time.
- The directory, not just the file, must be writable by `watersim`: WAL mode
  creates the `-wal` and `-shm` files next to it.
- Do not open the production file as `root` while the service runs: the
  side files it creates would then belong to root and the service loses write
  access. Use `sudo -u watersim -H watersim-node …` for one-off commands (§9).

Migrations (`src/db/migrations_sqlite/`, the same ids as the Postgres set) and
the seed run through the same helper. A rollback on SQLite is "stop the
service, restore the last backup" — the `down` scripts exist but cannot drop
columns.

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
sudo -u watersim -H git clone <your-repo-url> /opt/watersim/repo
# The application lives in a subdirectory of the repository; keep a stable path to it:
sudo ln -sfn /opt/watersim/repo/Documents/watersim-pro/watersim_session16 /opt/watersim/app
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

On a small server, build the frontend on your workstation instead (same two
`VITE_` variables), pack `frontend/dist` and upload it:
`tar -czf dist.tgz -C frontend/dist . && scp dist.tgz server:/tmp/` then
`sudo tar -xzf /tmp/dist.tgz -C /var/www/watersim`.

**Building from Git Bash on Windows:** prefix the build with
`MSYS_NO_PATHCONV=1`. Git Bash rewrites an environment value that looks like
a POSIX path, so `VITE_API_BASE=/api/v1` reaches Vite as
`C:/Program Files/Git/api/v1`, the bundle's axios base becomes that string,
and every API call fails in the browser before it is sent ("Login failed"
with nothing in the server log). Check the result before uploading:
`grep -c 'Program Files' frontend/dist/assets/index-*.js` must print 0.

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

# ── Database — one SQLite file, owned by the service user (see §5) ───────────
DATABASE_URL=sqlite:/opt/watersim/data/watersim.db

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
SIMULATION_MAX_CONCURRENT=2
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
# Email: a Gmail account with an app password is enough (§8.1)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="WaterSim Pro <no-reply@${DOMAIN}>"
# WhatsApp through Meta's Cloud API — the CRM's business account (§8.1)
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_DEFAULT_COUNTRY_CODE=91
WHATSAPP_TEMPLATES={"*":"watersim_alert"}
WHATSAPP_TEMPLATE_LANG=en_US
WHATSAPP_VERIFY_TOKEN=$(openssl rand -hex 16)
WHATSAPP_APP_SECRET=
# Twilio instead: WHATSAPP_PROVIDER=twilio and the three TWILIO_* values
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

### 8.1 WhatsApp (Meta Cloud API) and Gmail

WaterSim sends WhatsApp through the WhatsApp Business Account the enterprise
CRM already uses, so nothing new is registered with Meta. From the CRM's
`.env` copy `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (a permanent
system-user token with `whatsapp_business_messaging` and
`whatsapp_business_management`) and `WHATSAPP_BUSINESS_ACCOUNT_ID` into
`/etc/watersim/backend.env`. Then, in the Meta App Dashboard → WhatsApp →
Configuration:

1. **Webhook.** Callback URL `https://${DOMAIN}/api/v1/webhooks/whatsapp`,
   verify token = `WHATSAPP_VERIFY_TOKEN`, subscribed to the **messages**
   field. Meta calls the URL once to verify (the backend echoes the
   challenge) and from then on posts delivery receipts — sent → delivered →
   read, or failed with a reason — which appear against each message under
   Settings → Notifications → Recent deliveries. A Meta app has one callback
   URL: if the CRM owns it, leave it there; messages still send, only the
   receipts stay with the CRM.
2. **App secret** (App settings → Basic) into `WHATSAPP_APP_SECRET`, so every
   webhook body is checked against its `X-Hub-Signature-256`.
3. **Template.** Meta delivers plain text only to a person who wrote to the
   number in the last 24 hours; every alarm outside that window needs an
   approved template. Create one UTILITY template named `watersim_alert`
   (language en_US) whose body is `*{{1}}*` on the first line and `{{2}}` on
   the second (sample values: "Alarm: TSS high" / "TSS 50 exceeded max 30 ·
   Flowsheet: ITC STP"). When Meta shows it APPROVED, set
   `WHATSAPP_TEMPLATES={"*":"watersim_alert"}` and restart. Per-event
   templates use the event type as the key (`"alarm.":"watersim_alarm"`);
   every template must take exactly two body parameters. Settings →
   Notifications → "Check Meta templates" lists the account's templates with
   their status.
4. **Each person.** Settings → Notifications → WhatsApp number (a 10-digit
   Indian number is accepted and stored as +91…), then send "hi" once to the
   plant's WhatsApp number from that phone: that verifies the number and
   opens the 24-hour window, so "Send test" works before the template is
   approved.

**Email.** A Gmail account sends with an app password (Google account →
Security → 2-Step Verification → App passwords): `SMTP_USER` is the address,
`SMTP_PASS` the 16-character app password; `SMTP_HOST` may stay empty for
Gmail. Gmail rewrites the sender to the account itself, so `SMTP_FROM` only
matters on a domain of your own (with SPF/DKIM, or it lands in spam).

One real message per channel from the server, without a browser (the §9
helper loads the environment file):

```bash
node scripts/notify-live-test.js --email you@example.com --phone +919876543210 --pick-template
```

## 9. Migrate, seed, and a helper for one-off commands

Every one-off command (migrations, seeds, `sync-cmms-assets.js`) must run as
`watersim`, inside `backend/`, with the production environment loaded — never
as root (§5). Save this helper once:

```bash
sudo tee /usr/local/bin/watersim-node >/dev/null <<'EOS'
#!/usr/bin/env bash
# Run `node <args>` inside backend/ with /etc/watersim/backend.env loaded.
# Usage: sudo -u watersim -H watersim-node src/db/migrate.js status
set -euo pipefail
set -a; . /etc/watersim/backend.env; set +a
export PATH=/opt/watersim/node/bin:$PATH          # private Node 22, if you installed one
cd /opt/watersim/app/backend
exec node --disable-warning=ExperimentalWarning "$@"
EOS
sudo chmod 755 /usr/local/bin/watersim-node
```

Then:

```bash
sudo -u watersim -H watersim-node src/db/migrate.js up       # 001 … 015
sudo -u watersim -H watersim-node src/db/migrate.js status   # nothing pending
```

Seeding is optional. It creates the demo organisation, three users and the
ITC STP flowsheet with its permit template, tag registry and alarm rules. The
seed users have **published passwords** (`admin@watersim.dev` / `Admin1234!`,
printed by the seed), so on a client-facing server either skip the seed and
create the first admin through the app, or seed and change every password
before the box is reachable:

```bash
sudo -u watersim -H watersim-node src/seeds/index.js
```

## 10. systemd unit for the backend

```bash
sudo tee /etc/systemd/system/watersim-backend.service >/dev/null <<'UNIT'
[Unit]
Description=WaterSim Pro API (Node.js)
Documentation=file:///opt/watersim/app/docs/RUNBOOK-deploy-ubuntu.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=watersim
Group=watersim
WorkingDirectory=/opt/watersim/app/backend
EnvironmentFile=/etc/watersim/backend.env
# node:sqlite still prints an "experimental" banner on Node 22
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
# server.js drains on SIGTERM (WS close frames, HTTP, database) and force-exits after 10 s
KillSignal=SIGTERM
TimeoutStopSec=20
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=watersim-backend

# Hardening — the process writes only its database (/opt) and matplotlib's cache (/tmp)
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

With a private Node install, set `ExecStart=/opt/watersim/node/bin/node src/server.js`
and add `Environment=PATH=/opt/watersim/node/bin:/usr/local/bin:/usr/bin:/bin`.

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

On a server whose nginx already hosts other sites with `certbot --nginx`, do
the same as those sites: drop the site file below (HTTP block only) into
`/etc/nginx/sites-enabled/<domain>.conf`, reload, then
`sudo certbot --nginx -d "$DOMAIN" --redirect` lets certbot add the TLS
listeners itself.

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
sudo ss -ltnp | grep -E ':(80|443|4000)\b'   # 4000 on 0.0.0.0 but blocked by ufw (§11)
sudo ls -l /opt/watersim/data/                # watersim.db(-wal,-shm) owned by watersim
```

Then in a browser: log in, open a flowsheet, and confirm in the developer
tools' Network tab that `wss://<domain>/ws/flowsheets/<id>` reaches status
101. Export a PDF and an Excel report from a project — those two exercise the
Python venv. On the PLC page the OPC UA / S7 / EtherNet/IP protocols should
read "available" rather than "stub".

## 14. Backups

The SQLite file is the only state. Copying it while the service writes is not
safe (WAL); `VACUUM INTO` produces a consistent single-file copy without
stopping anything, and the service user can do it through the same Node the
service runs on:

```bash
sudo tee /usr/local/bin/watersim-backup >/dev/null <<'EOS'
#!/usr/bin/env bash
# Consistent copy of the SQLite database (VACUUM INTO), gzipped, pruned after RETENTION_DAYS.
# Run as the service user:  sudo -u watersim -H /usr/local/bin/watersim-backup
set -euo pipefail
DIR=/var/backups/watersim
KEEP="${RETENTION_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/watersim-$TS.db"
set -a; . /etc/watersim/backend.env; set +a
SRC="${DATABASE_URL#sqlite:}"
export PATH=/opt/watersim/node/bin:$PATH
rm -f "$DIR"/*.partial
# The schema's CHECK constraints call REGEXP, which SQLite only knows once a
# connection registers it (the application does); VACUUM INTO re-reads the
# schema, so the backup connection must register it as well.
node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  db.function("regexp", { deterministic: true }, (re, s) =>
    (re == null || s == null ? null : (new RegExp(String(re)).test(String(s)) ? 1 : 0)));
  db.exec("VACUUM INTO " + "\x27" + process.argv[2].replace(/\x27/g, "\x27\x27") + "\x27");
  db.close();
' "$SRC" "$OUT.partial"
mv "$OUT.partial" "$OUT"
gzip -f "$OUT"
find "$DIR" -name 'watersim-*.db.gz' -mtime +"$KEEP" -print -delete
echo "$(date '+%F %T') wrote $(du -h "$OUT.gz" | cut -f1) $OUT.gz"
EOS
sudo chmod 755 /usr/local/bin/watersim-backup

sudo -u watersim -H /usr/local/bin/watersim-backup        # run once now
( sudo crontab -l 2>/dev/null; \
  echo '30 2 * * * sudo -u watersim -H /usr/local/bin/watersim-backup >> /var/backups/watersim/backup.log 2>&1' ) \
  | sudo crontab -
```

Copy `/var/backups/watersim/` off the machine from the same cron (`rclone`,
`rsync` to another host, object storage). A dump on the same disk does not
survive the disk.

**Restore** (destructive — replaces the database):

```bash
sudo systemctl stop watersim-backend
sudo -u watersim -H bash -c 'gunzip -c /var/backups/watersim/watersim-YYYYMMDD-HHMMSS.db.gz > /opt/watersim/data/watersim.db.restore'
sudo -u watersim -H rm -f /opt/watersim/data/watersim.db /opt/watersim/data/watersim.db-wal /opt/watersim/data/watersim.db-shm
sudo -u watersim -H mv /opt/watersim/data/watersim.db.restore /opt/watersim/data/watersim.db
sudo systemctl start watersim-backend
```

Rehearse this once before you need it.

## 15. Updating to a new version

Same order as the first install: frontend build, publish `dist`, backend
install, migrate, restart. Save it as a script so every update is identical:

```bash
sudo tee /usr/local/bin/watersim-update >/dev/null <<'EOS'
#!/usr/bin/env bash
# Update WaterSim Pro from git. Usage: sudo DOMAIN=app.example.com watersim-update [git-ref]
set -euo pipefail
: "${DOMAIN:?set DOMAIN=<public hostname>}"
REPO=/opt/watersim/repo
APP=/opt/watersim/app
REF="${1:-}"
export PATH=/opt/watersim/node/bin:$PATH

# git runs as the checkout's owner — root would trip git's "dubious ownership" check
sudo -u watersim -H git -C "$REPO" fetch --all --tags
if [[ -n "$REF" ]]; then sudo -u watersim -H git -C "$REPO" checkout --detach "$REF"
else                    sudo -u watersim -H git -C "$REPO" pull --ff-only; fi
echo "deploying $(sudo -u watersim -H git -C "$REPO" rev-parse --short HEAD)"

cd "$APP"
sudo -u watersim -H npm ci --workspace=frontend --ignore-scripts
sudo -u watersim -H env VITE_API_BASE=/api/v1 VITE_WS_URL="wss://$DOMAIN" \
  npm run build --workspace=frontend
sudo -u watersim -H npm ci --workspace=backend --omit=dev --ignore-scripts
sudo -u watersim -H /opt/watersim/venv/bin/pip install -q -r backend/requirements-plc.txt

sudo -u watersim -H /usr/local/bin/watersim-backup
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
sudo DOMAIN=app.example.com watersim-update             # latest on the current branch
sudo DOMAIN=app.example.com watersim-update v1.4.0      # or a tag / commit
```

The script backs up before migrating. Migrations run while the old process is
still serving; they are additive.

**Rollback:** `sudo DOMAIN=… watersim-update <previous-commit>`, then restore
the backup taken just before the migration (§14) if the schema changed.

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Boot exits: `JWT_SECRET must be at least 32 characters` / `Missing required env var … CORS_ORIGIN` | fix `/etc/watersim/backend.env`; `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` are mandatory in production |
| `/health` returns 503 `degraded`; log says `attempt to write a readonly database` or `unable to open database file` | `/opt/watersim/data` (the directory, not just the file) is not writable by `watersim`, or a root-owned `-wal`/`-shm` file is sitting next to it (§5). `chown -R watersim:watersim /opt/watersim/data` |
| `database is locked` in the log | a second process has the file open for writing — a dev server, a stray one-off script, or a backup made by copying instead of `VACUUM INTO`. One backend per file |
| `no such function: uuid_generate_v4` / `REGEXP` | the file was written through something other than the application (sqlite3 CLI); the driver registers those functions at open. Write only through `watersim-node` or the service |
| `ExperimentalWarning: SQLite is an experimental feature` in the journal | harmless on Node 22; `NODE_OPTIONS=--disable-warning=ExperimentalWarning` in the unit silences it |
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
| Disk filling up | historian raw samples: lower `HISTORIAN_RAW_RETENTION_DAYS`; check `du -sh /opt/watersim/data /var/backups/watersim` |

---

## Appendix A — Using PostgreSQL instead

The backend still speaks PostgreSQL: point `DATABASE_URL` at a `postgres://`
URL (or set `DB_CLIENT=pg`) and `src/db/pool.js` selects the `pg` driver and
`src/db/migrations/`. The docker-compose and Kubernetes deployments do this.
On a bare Ubuntu server:

```bash
sudo apt-get install -y postgresql postgresql-contrib     # 24.04 ships 16; 22.04 needs the PGDG repo for 16
DB_PASS="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE watersim LOGIN PASSWORD '${DB_PASS}';
CREATE DATABASE watersim_prod OWNER watersim;
\c watersim_prod
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
```

Then in `/etc/watersim/backend.env`:

```
DATABASE_URL=postgres://watersim:<DB_PASS>@127.0.0.1:5432/watersim_prod?sslmode=disable
```

**Why `sslmode=disable`.** `backend/src/db/pg.js` turns on TLS with
certificate verification whenever `NODE_ENV=production`. Ubuntu's PostgreSQL
has `ssl = on` with a self-signed "snakeoil" certificate, which verification
rejects. The connection string wins over the pool default, so this is the
right setting for a loopback database; use TLS again if the database moves to
another host. Add `After=postgresql.service` to the unit, run the migrations
and seed exactly as in §9, and back up with `pg_dump --format=custom` as the
`postgres` user instead of §14's script.
