# RUNBOOK — Deployment (CI/CD, images, rollback)

Audience: anyone deploying WaterSim Pro or debugging a failed deploy.
Last updated: 2026-09-03.

---

## 1. Big picture

```
push to main
   │
   ├─ ci.yml   lint/audit → tests (Postgres service) → docker build smoke test
   │
   └─ cd.yml   build & push images to GHCR ──► SSH to prod host
                 ghcr.io/<org>/watersim-backend:<short-sha> + :latest
                 ghcr.io/<org>/watersim-frontend:<short-sha> + :latest
                                              │
                                              ▼
                              scripts/deploy.sh on the host:
                              pull → migrate → up → health check (30×2s)
                              └─ on failure: automatic rollback to the
                                 previously deployed tag
```

Key invariants:

- **One lockfile.** This is an npm-workspaces monorepo; only the root
  `package-lock.json` exists. Every `npm ci` runs at the repo root (optionally
  `--workspace=backend|frontend`), and **every Docker build context is the repo
  root** (`docker build -f backend/Dockerfile.prod .`).
- **The prod host never builds from source.** `docker-compose.prod.yml` declares
  `image: ghcr.io/${IMAGE_ORG}/watersim-*:${IMAGE_TAG}`; the `build:` blocks are a
  local-development fallback only.
- **Tags are pinned.** CD writes `IMAGE_ORG` and `IMAGE_TAG` (the short commit
  SHA) into `.env.prod` on the host, and every compose invocation uses
  `--env-file .env.prod` so the interpolations resolve.

## 2. CI (`.github/workflows/ci.yml`)

| Job | What it does |
|---|---|
| lint-backend / lint-frontend | root `npm ci --workspace=…` + `npm audit` (ESLint arrives in a later pass) |
| test-backend | Jest against a real Postgres 16 service container; runs `node src/db/migrate.js up` first |
| test-frontend | Vitest (`npm test --workspace=frontend -- --run`) |
| build-images | `docker buildx` of both prod Dockerfiles from the **root context**, no push |

All jobs cache npm against the root `package-lock.json`.

## 3. CD (`.github/workflows/cd.yml`)

1. **push-images** — builds `backend/Dockerfile.prod` and `frontend/Dockerfile.prod`
   with `context: .`, pushes `<short-sha>` and `latest` tags to GHCR. The frontend
   bakes `VITE_API_BASE=/api/v1` and `VITE_WS_URL=wss://$PUBLIC_HOST/ws`.
2. **deploy** — SSH to the host and:
   - minimal checkout of **only** `docker-compose.prod.yml`, `nginx/`, `scripts/`
     (`git checkout --force origin/main -- <paths>` — no `git reset --hard`, no
     on-host source builds);
   - regenerates `.env.prod` from GitHub secrets **plus** `IMAGE_ORG`/`IMAGE_TAG`;
   - runs `IMAGE_TAG=<short-sha> bash scripts/deploy.sh`;
   - a runner-side smoke test retries `https://$PUBLIC_HOST/health` 30×2s.

First-time host setup (once): clone the repo to `$DEPLOY_PATH`, install docker
compose v2, run `scripts/init-tls.sh <domain> <email>` (see §6), then let CD run.

## 4. What `scripts/deploy.sh` does

```
.deploy/current_tag   ← tag currently serving traffic
.deploy/previous_tag  ← tag before that (rollback target)
```

1. Resolves the target tag (`$IMAGE_TAG` env > `IMAGE_TAG=` in `.env.prod` > `latest`).
2. **Records the previously deployed tag** to `.deploy/previous_tag` *before switching*.
3. `docker compose --env-file .env.prod -f docker-compose.prod.yml pull migrate backend frontend`
4. `… run --rm migrate` (versioned migrations, `node src/db/migrate.js up`)
5. `… up -d --no-deps backend frontend proxy`
6. Health check: `exec backend wget http://localhost:4000/health`, **30 attempts × 2 s**,
   expecting `"status":"healthy"`.
7. On success: writes the new tag to `.deploy/current_tag`, prunes dangling images.
8. On failure: **automatically redeploys `.deploy/previous_tag`** (pull → migrate →
   up → health check) and exits non-zero either way.

## 5. Manual rollback

```bash
ssh deploy@<host>
cd /srv/watersim                     # $DEPLOY_PATH
cat .deploy/current_tag .deploy/previous_tag
IMAGE_TAG=<known-good-sha> bash scripts/deploy.sh
```

Any previously pushed short-SHA tag in GHCR is a valid target. Note: migrations
are forward-only (`down` exists but is not run automatically) — rolling back to
an image that predates a schema migration needs a manual
`docker compose … run --rm backend node src/db/migrate.js down` first, or a
DB restore (see RUNBOOK-backup-restore.md).

## 6. TLS bootstrap (compose mode) — avoiding the first-boot deadlock

nginx (`proxy`) needs the cert files at startup, while certbot's webroot
renewal needs nginx running — so a brand-new host deadlocks. The bootstrap
path is **certbot standalone before nginx ever starts**:

```bash
./scripts/init-tls.sh app.example.com ops@example.com   # once per host
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d
```

The `certbot` service (profile `tls`) then renews via webroot every 12 h.
Reload the proxy after a renewal if needed: `docker compose … exec proxy nginx -s reload`.

## 7. Kubernetes deploys (`k8s/`)

```bash
# 0. once: create the secret (never committed)
cp k8s/secret.example.yaml k8s/secret.yaml   # fill base64 values
kubectl apply -f k8s/secret.yaml

# 1. pin the image tag (kustomization.yaml images: block)
cd k8s && kustomize edit set image \
  ghcr.io/YOUR_ORG/watersim-backend=ghcr.io/<org>/watersim-backend:<tag> \
  ghcr.io/YOUR_ORG/watersim-frontend=ghcr.io/<org>/watersim-frontend:<tag>
cd ..

# 2. MIGRATIONS FIRST — the Job must complete BEFORE the rollout.
#    (Jobs are immutable → delete-then-apply; it is deliberately not in
#     kustomization.yaml. Set the same image tag inside migrate-job.yaml.)
kubectl -n watersim delete job watersim-migrate --ignore-not-found
kubectl apply -f k8s/migrate-job.yaml
kubectl -n watersim wait --for=condition=complete job/watersim-migrate --timeout=300s

# 3. roll everything else
kubectl apply -k k8s/
kubectl -n watersim rollout status deploy/backend deploy/frontend
```

Rollback: `kubectl -n watersim rollout undo deploy/backend` (and/or re-pin the
previous tag and re-apply). Remember the migration caveat from §5.

Notable manifest facts:
- Migrations run **only** via `k8s/migrate-job.yaml` — there is no init
  container, so HPA scale-ups don't re-run (or race) migrations.
- Backend pods have `readOnlyRootFilesystem` with an emptyDir at `/tmp` and
  `MPLCONFIGDIR=/tmp/mpl` — required by the Python report generators.
- PDBs keep ≥1 backend and ≥1 frontend pod during drains (`k8s/pdb.yaml`).
- Default-deny ingress NetworkPolicy; only ingress-controller → frontend/backend,
  frontend → backend, and backend/migrate/pg-backup → postgres are allowed
  (`k8s/networkpolicy.yaml` — adjust the ingress-nginx namespace label if yours differs).
- All pod specs set `automountServiceAccountToken: false`.

## 8. Common failures

| Symptom | Likely cause / fix |
|---|---|
| `npm ci` fails in a Dockerfile with lockfile errors | Build was run with the wrong context — context must be the **repo root**, not `backend/` or `frontend/` |
| Prod host rebuilt images from source | `.env.prod` missing `IMAGE_ORG`/`IMAGE_TAG`, or compose invoked without `--env-file .env.prod` |
| Deploy health check loops then rolls back | `docker compose … logs backend`; commonest causes: bad `DATABASE_URL`, failed migration |
| Excel export 500s in prod | backend image must include `openpyxl` (installed in `backend/Dockerfile.prod` pip line) |
| PDF export fails on k8s only | `/tmp` emptyDir or `MPLCONFIGDIR` removed from `k8s/backend.yaml` |
| `kubectl apply -f k8s/migrate-job.yaml` → "field is immutable" | Delete the old Job first (step 2 above) |
| `docker compose pull` → "repository does not exist" | `.env.prod` missing `IMAGE_ORG`/`IMAGE_TAG`. If you have no registry, build on the host instead — §9 |
| `proxy` container restart-loops on a fresh host | `nginx/proxy.conf` still names the example domain in its `ssl_certificate` paths — §9.3 |
| Backend serves an old route as 404 after a deploy | The container is running the previous image. `build` then `up -d --force-recreate backend`; a plain `restart` reuses it |
| Backend exits at boot: "JWT_SECRET must be at least 32 characters" | `openssl rand -hex 32`; the check is enforced in production only |

---

## 9. Fresh Ubuntu server, no CI — build on the host

Sections 1–5 assume GitHub Actions builds images and pushes them to GHCR. If you
are standing up a single server for a client and have no CI, build on the host
instead. `scripts/deploy.sh` is **pull-only** and will not help here — use the
compose commands below directly.

### 9.1 Server specification

Sized from the `mem_limit` / `cpus` declared per service in
`docker-compose.prod.yml` (postgres 1 GB/1.0, backend 512 MB/1.0, frontend
128 MB/0.5, proxy 64 MB/0.25 — 1.7 GB and 2.75 vCPU of limits), plus headroom
for Ubuntu, the Docker daemon and the build itself.

| | Building on the host | Pulling prebuilt images |
|---|---|---|
| **OS** | Ubuntu 22.04 LTS or 24.04 LTS (x86-64) | same |
| **vCPU** | 4 | 2 |
| **RAM** | **8 GB** — the Vite build and `npm ci` transiently need ~2 GB on top of the running stack | 4 GB |
| **Disk** | **80 GB** SSD — images ≈ 1.5 GB (the backend image carries Python, numpy and matplotlib), build cache 2–3 GB, the rest is Postgres data and backups | 40 GB |
| **Swap** | 2 GB, so a build cannot OOM-kill Postgres | optional |

`SIMULATION_MAX_CONCURRENT` (default 4) is the number of simulation worker
threads. Keep it at or below the vCPUs you actually gave the box, or runs queue
and the 60 s wall-clock timeout starts firing on work that was only waiting.

Inbound ports: **80** and **443** only. Postgres and the backend sit on an
`internal: true` Docker network and are never published.

### 9.2 Prerequisites

```bash
# Docker Engine + compose v2 from Docker's own repo (Ubuntu's docker.io is older)
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER" && newgrp docker      # log out/in for this to stick

docker compose version                                 # must print v2.x

# Firewall
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

A **DNS A record for your domain must already point at this host** before
TLS bootstrap — Let's Encrypt validates over HTTP on port 80.

### 9.3 Deploy

```bash
git clone <your-repo-url> /srv/watersim && cd /srv/watersim

cp .env.prod.example .env.prod
# EDIT .env.prod — at minimum:
#   PUBLIC_HOST / CORS_ORIGIN  your real domain
#   POSTGRES_PASSWORD          openssl rand -base64 32
#   JWT_SECRET                 openssl rand -hex 32     (≥32 chars, enforced at boot)
#   IMAGE_ORG                  any name — it only labels the locally built image
#   IMAGE_TAG                  local
chmod 600 .env.prod

# nginx/proxy.conf hardcodes dt.inferconautomation.com in FOUR places — two
# `server_name` lines and the two `ssl_certificate` paths. It is a mounted file,
# not templated, so compose will not substitute PUBLIC_HOST for you. Miss this
# and the proxy container crash-loops looking for certs under
# /etc/letsencrypt/live/dt.inferconautomation.com/ that certbot never issued.
sed -i 's/dt\.inferconautomation\.com/app.example.com/g' nginx/proxy.conf   # only when deploying under another domain
grep -n 'server_name\|ssl_certificate' nginx/proxy.conf     # confirm all four

# TLS FIRST — nginx will not start without certs, and certbot's webroot renewal
# needs nginx running. init-tls.sh breaks that deadlock with standalone mode.
# Run once, with port 80 free.
./scripts/init-tls.sh app.example.com ops@example.com

# Build both images ON THE HOST (context is the repo root — this matters)
docker compose --env-file .env.prod -f docker-compose.prod.yml build

# Migrate, then start everything including the cert renewer
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d

# Optional: seed the demo org and the ITC plant (creates the flowsheet,
# the reuse permit template and the alarm rules)
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm backend node src/seeds/index.js
```

### 9.4 Verify

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps      # all healthy
curl -fsS https://app.example.com/health | jq                          # status: healthy, db: connected
curl -o /dev/null -w '%{http_code}\n' https://app.example.com/api/v1/plant   # 401 = mounted (200 needs a token)
```

A **404** on a route you know exists means the container is running older code —
rebuild and recreate, do not restart:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml build backend
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate backend
```

### 9.5 Updating later

```bash
cd /srv/watersim && git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml build
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
docker image prune -f
```

Back up before every update — `./scripts/backup.sh`, and rehearse the restore
once (`docs/RUNBOOK-backup-restore.md`). An untested backup is not a backup.
