# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Phase 6 — Production Hardening & Deployment
## Current Session: Session 11
## Overall Progress: Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ | Phase 4 ✅ | Phase 5 ✅ | Phase 6 ✅

---

## ✅ Completed Steps (Sessions 1–10)
See SESSION_STATE_session10.md for full detail through Session 10.

**Summary through Session 10:**
- Phase 1–4: Full backend + frontend, sim engine, RAS, denitrification, EBPR, cost model, permit templates, snapshots
- Session 7 (Steps 34–36): SettingsPage permit templates UI, batch cost overlay, flowsheet snapshots UI
- Session 8 (Steps 37–39): Unit-costs editor UI, UV/granular filter tertiary models, ADM1-lite anaerobic digester
- Session 9 (Step 40): Advanced EBPR — UCT and JHB multi-zone configurations
- Session 10 (Step 41): Real-time collaboration via WebSocket (useCollaboration hook, PresenceAvatars, RemoteCursors, SimBanner)

---

## ✅ Session 11 — Phase 6 (Steps 42–49)

### Phase 6 Overview — Production Hardening & Deployment

Complete production infrastructure: multi-stage Dockerfiles, Nginx reverse proxy, production docker-compose with TLS, versioned database migration runner, GitHub Actions CI/CD pipeline, Kubernetes manifests (with HPA), and security hardening (Helmet CSP, env validation, DB pool hardening).

---

### Step 42 — Production Dockerfiles (multi-stage)

#### `backend/Dockerfile.prod`
Two-stage build:
- **Stage `deps`**: `npm ci --omit=dev` on `node:20-alpine`. Installs `dumb-init` for PID 1 signal handling.
- **Stage `release`**: Copies only `node_modules` + `src`. Creates non-root user `nodeapp` (uid 1001). Runs as that user. Entry: `dumb-init -- node src/server.js`.

#### `frontend/Dockerfile.prod`
Two-stage build:
- **Stage `builder`**: Full `npm ci` + `vite build`. Accepts `VITE_API_BASE` and `VITE_WS_URL` as `ARG`s injected at build time.
- **Stage `release`**: `nginx:1.27-alpine`. Copies `nginx/frontend.conf` and `dist/` output. Runs as `nginx` user (uid 101).

---

### Step 43 — Nginx Configuration

#### `nginx/frontend.conf` (embedded in frontend container)
- Serves Vite static build from `/usr/share/nginx/html`
- Caches hashed assets with `Cache-Control: public, immutable` (1 year)
- SPA fallback: all non-file paths → `index.html`
- Proxies `/api/` → `http://backend:4000` (120s timeout)
- Proxies `/ws/` → `http://backend:4000` with `Upgrade`/`Connection` headers (3600s timeout for long-lived WS connections)
- Proxies `/health` → backend health check

#### `nginx/proxy.conf` (standalone TLS-terminating proxy)
- HTTP → HTTPS redirect (port 80 → 443)
- TLS 1.2/1.3 only; ECDHE ciphers
- HSTS header (31536000s, includeSubDomains)
- Proxies to `frontend:80` for all paths, `backend:4000` for `/ws/`
- Certbot ACME challenge path served from `/var/www/certbot`

---

### Step 44 — Production docker-compose

#### `docker-compose.prod.yml`
Services:
- **`postgres`**: postgres:16 alpine; internal network only (no port exposure); healthcheck with `pg_isready`
- **`migrate`**: same backend image; runs `node src/db/migrate.js up`; `depends_on: postgres healthy`; `restart: "no"` (one-shot)
- **`backend`**: `depends_on: migrate:completed_successfully`; internal network; CPU/memory resource limits; healthcheck via `/health`
- **`frontend`**: pre-built Nginx image with Vite static; internal + public network
- **`proxy`**: `nginx:1.27-alpine` with `proxy.conf`; exposes ports 80/443; mounts Certbot certs volume; public network
- **`certbot`**: optional (`profiles: [tls]`); auto-renews certs every 12h

Networks:
- `internal` (bridge, `internal: true`) — DB, backend, frontend — no direct internet
- `public` (bridge) — frontend, proxy only

#### `.env.prod.example`
All required vars documented: `POSTGRES_DB/USER/PASSWORD`, `JWT_SECRET`, `PUBLIC_HOST`, `CORS_ORIGIN`, pool settings.

---

### Step 45 — Versioned Migration Runner

**Replaced** `backend/src/db/migrate.js` with a proper versioned runner.

#### Architecture
- Tracks applied migrations in `schema_migrations` table (created on first run)
- Migrations live in `backend/src/db/migrations/*.js`
- Each file exports `{ id: string, up: string, down: string }`
- Files executed in lexicographic sort order

#### Commands
| Command | Action |
|---|---|
| `node src/db/migrate.js up` | Apply all pending migrations (default) |
| `node src/db/migrate.js down` | Roll back most recent applied migration |
| `node src/db/migrate.js down:all` | Roll back ALL migrations |
| `node src/db/migrate.js status` | Print applied/pending table |

#### Migration files created
- `backend/src/db/migrations/001_initial_schema.js` — full foundation schema wrapped as JS module
- `backend/src/db/migrations/002_permit_templates.js` — permit templates table + demo seed

---

### Step 46 — GitHub Actions CI/CD

#### `.github/workflows/ci.yml` — runs on push/PR to `main`/`develop`
Jobs:
1. **`lint-backend`** — `npm ci` + `npm audit`
2. **`test-backend`** — Jest with real Postgres service container; runs `migrate up` before tests; uploads coverage artifact
3. **`lint-frontend`** — `npm ci` + `npm audit`
4. **`test-frontend`** — Vitest (`--run`)
5. **`build-images`** — `docker buildx build` for both images (no push; confirms Dockerfile correctness); uses GHA layer cache

#### `.github/workflows/cd.yml` — runs on push to `main`
Jobs:
1. **`push-images`**:
   - Logs into GHCR with `GITHUB_TOKEN`
   - Tags images with short SHA + `latest`
   - Builds and pushes `watersim-backend` and `watersim-frontend` to GHCR
   - Injects `VITE_API_BASE` and `VITE_WS_URL` as build args
2. **`deploy`** (environment: `production`):
   - SSH to server via `appleboy/ssh-action`
   - Writes `.env.prod` from GitHub Secrets
   - Pulls new images, runs migrations, does rolling update
   - Smoke-tests `/health` endpoint

Required GitHub Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, `PUBLIC_HOST`, `POSTGRES_DB/USER/PASSWORD`, `JWT_SECRET`, `CORS_ORIGIN`

---

### Step 47 — Kubernetes Manifests

All files in `k8s/`, applied via `kubectl apply -k k8s/`.

| File | Resource(s) |
|---|---|
| `namespace.yaml` | Namespace `watersim` |
| `configmap.yaml` | ConfigMap `watersim-config` — non-secret env vars |
| `secret.example.yaml` | Template for `secret.yaml` (gitignored) |
| `postgres.yaml` | StatefulSet + headless Service; 20Gi PVC |
| `backend.yaml` | Deployment (2 replicas) + ClusterIP Service + HPA (2–8 pods, CPU 65% / mem 80%) |
| `frontend.yaml` | Deployment (2 replicas) + ClusterIP Service |
| `ingress.yaml` | nginx-ingress Ingress; TLS via cert-manager; routes `/ws/` → backend, `/api/` → backend, `/` → frontend |
| `kustomization.yaml` | Kustomize entry point |

**Security posture:**
- All containers run as non-root
- Backend: `readOnlyRootFilesystem: true`, all capabilities dropped
- Backend init container runs `migrate up` before main pod starts
- DB pod on internal network only; no NodePort/LoadBalancer
- Secrets via `secretKeyRef`, never in ConfigMap

---

### Step 48 — Security Hardening

#### `backend/src/server.js` changes
- **Env validation on startup**: throws if `JWT_SECRET`, `DATABASE_URL`, or `CORS_ORIGIN` missing in production; throws if `JWT_SECRET` < 32 chars
- **Helmet CSP**: explicit `contentSecurityPolicy` directives; `upgrade-insecure-requests` only in production; HSTS only in production
- **Rate limiter key**: uses `req.ip` (real IP via `trust proxy: 1`)
- **Health endpoint**: returns richer info including `uptime`, `responseTimeMs`, `dbServerTime`; skipped from Morgan access log
- **Morgan**: health check path excluded from access logs
- **Graceful shutdown**: `server.close()` with 10s forced fallback; `unref()` on timeout so it doesn't block event loop
- **Process error handlers**: `uncaughtException` and `unhandledRejection` logged instead of silent crash

#### `backend/src/db/pool.js` changes
- Supports `DATABASE_URL` (production) or individual `DB_HOST/PORT/NAME/USER/PASSWORD` vars
- SSL: auto-enabled in production; `rejectUnauthorized: true` by default; opt-out with `DB_SSL_REJECT_UNAUTHORIZED=false`
- Slow query warning logged at >3000ms
- Pool connect event logged in debug mode

---

### Step 49 — Supporting Files

- `.gitignore`: root-level; explicitly ignores `.env.prod`, `.env.staging`, `k8s/secret.yaml`
- `scripts/deploy.sh`: bash deploy script with validation, pull, migrate, rolling update, health check, image prune
- `.env.prod.example`: documented template for all production env vars

---

## 📁 New/Modified Files Summary (Session 11)

```
watersim/
├── .gitignore                                ← NEW
├── .env.prod.example                         ← NEW
├── docker-compose.prod.yml                   ← NEW
├── scripts/
│   └── deploy.sh                             ← NEW
├── nginx/
│   ├── frontend.conf                         ← NEW (embedded in frontend image)
│   └── proxy.conf                            ← NEW (standalone TLS proxy)
├── k8s/
│   ├── kustomization.yaml                    ← NEW
│   ├── namespace.yaml                        ← NEW
│   ├── configmap.yaml                        ← NEW
│   ├── secret.example.yaml                   ← NEW
│   ├── postgres.yaml                         ← NEW
│   ├── backend.yaml                          ← NEW
│   ├── frontend.yaml                         ← NEW
│   └── ingress.yaml                          ← NEW
├── .github/workflows/
│   ├── ci.yml                                ← NEW
│   └── cd.yml                                ← NEW
├── backend/
│   ├── Dockerfile.prod                       ← NEW
│   ├── src/
│   │   ├── server.js                         ← UPDATED (CSP, env validation, graceful shutdown)
│   │   └── db/
│   │       ├── pool.js                       ← UPDATED (DATABASE_URL, SSL, slow query log)
│   │       ├── migrate.js                    ← REPLACED (versioned runner)
│   │       └── migrations/
│   │           ├── 001_initial_schema.js     ← NEW
│   │           └── 002_permit_templates.js   ← NEW
└── frontend/
    └── Dockerfile.prod                       ← NEW
```

---

## 🔧 First-Time Production Setup Checklist

```bash
# 1. Clone repo and copy env template
cp .env.prod.example .env.prod
# Edit .env.prod — fill in all CHANGE_ME values

# 2. Generate a strong JWT secret
openssl rand -hex 32

# 3. Start services
docker compose -f docker-compose.prod.yml up -d

# 4. Check migration status
docker compose -f docker-compose.prod.yml run --rm backend node src/db/migrate.js status

# 5. Seed demo data (optional)
docker compose -f docker-compose.prod.yml run --rm backend node src/seeds/index.js

# 6. Verify health
curl https://app.watersim.example.com/health | jq .
```

---

## Tech Decisions Made (Session 11 additions)

| Decision | Choice | Rationale |
|---|---|---|
| **Migration tracking** | `schema_migrations` table | Standard pattern; idempotent; supports up/down/status; no extra deps |
| **Migration format** | JS modules with `{ id, up, down }` | Keeps SQL inline but allows pre/post JS logic if needed |
| **Frontend build** | Vite `dist` in Nginx alpine | ~10MB image vs ~400MB Node image; serves at native Nginx speed |
| **WS proxy timeout** | 3600s in Nginx | Allows long-lived collaboration sessions without disconnection |
| **DB internal-only network** | Docker `internal: true` bridge | DB unreachable from host even if port accidentally exposed |
| **HSTS prod-only** | `IS_PROD` gate on Helmet | Avoids HSTS being cached during local dev (breaks HTTP dev server) |
| **CSP `connectSrc` wss:** | Broad WS allowance | WebSocket URL varies by env; can tighten to specific domain per env |
| **HPA thresholds** | CPU 65% / Mem 80% | Standard for Node.js: low CPU ceiling avoids p99 latency degradation |
| **Init container migrations** | K8s init container pattern | Guarantees DB schema is up-to-date before any API pod accepts traffic |
| **Certbot profile** | `profiles: [tls]` | Opt-in; teams using external cert management don't run an unnecessary container |

---

## API Reference (unchanged from Session 10)

**REST:** All endpoints at `https://host/api/v1/...` (unchanged)  
**WebSocket:** `wss://host/ws/flowsheets/:flowsheetId?token=<JWT>`

---

## Dev Credentials (unchanged)
| User | Email | Password | Role |
|---|---|---|---|
| Ada Admin | admin@watersim.dev | Admin1234! | admin |
| Eddie Engineer | engineer@watersim.dev | Engineer1! | engineer |
| Olivia Operator | operator@watersim.dev | Operator1! | operator |
| Org slug | `demo-org` | — | — |

---

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. All Phase 6 items are complete. SESSION_STATE_session11.md documents everything. We are starting Session 12: [describe next task]."

---

## ✅ Step 50 — Reporting & PDF Export (Session 11 addendum)

### Overview

Full report viewer and professional PDF export for completed simulation runs.
Engineers can review a rich formatted report in the browser, then download a multi-page PDF
suitable for regulatory submissions or client presentations.

### Files Added / Modified

```
watersim/
├── backend/
│   ├── Dockerfile.prod                       ← UPDATED (added Python3 + reportlab + matplotlib)
│   └── src/
│       ├── server.js                         ← UPDATED (mounted reportRoutes)
│       ├── reports/
│       │   ├── pdfGenerator.js               ← NEW — Node.js wrapper; spawns Python script
│       │   └── pdf_report.py                 ← NEW — ReportLab + Matplotlib PDF generator
│       └── routes/
│           └── reports.js                    ← NEW — GET /:runId/report + /:runId/report/pdf
└── frontend/
    └── src/
        ├── App.jsx                           ← UPDATED (added /simulate/:runId/report route)
        ├── hooks/
        │   └── useReport.js                  ← NEW — fetches report JSON + downloadPdf()
        └── pages/
            └── ReportPage.jsx                ← NEW — full report viewer UI
```

### Backend: `reports.js`

Mounted at: `GET /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report`
and: `GET .../report/pdf`

Both routes:
- Verify JWT auth (inherited from server-level middleware)
- Verify the run belongs to the calling user's organisation
- Only work on `status = 'completed'` runs

The **JSON endpoint** (`/report`) returns a `buildReportData()` object with all data the
frontend needs to render the report without additional fetches.

The **PDF endpoint** (`/report/pdf`) calls `generatePdf(reportData)` which spawns
`python3 pdf_report.py`, pipes JSON in via stdin, receives PDF bytes from stdout, then
streams the file with `Content-Disposition: attachment`.

### Backend: `pdf_report.py`

Multi-page A4 PDF via ReportLab Platypus. Pages:
1. **Cover page** — project/flowsheet metadata, compliance status badge
2. **Table of Contents**
3. **Executive Summary** — KPI table (flow, removals, OPEX), violation summary
4. **Influent & Effluent Quality** — full parameter table + grouped bar chart (matplotlib)
5. **Unit Operation Performance** (steady-state) or **24h Diurnal Charts** (dynamic)
6. **Operating Cost Estimate** — per-category tables + pie chart (matplotlib)
7. **Process Stream Results** — all edge concentrations
8. **Appendix** — node parameter configuration

All pages include branded header bar (blue, "WaterSim Pro"), page number footer, and HSTS.
Charts are rendered by matplotlib to PNG buffers embedded inline.

### Frontend: `ReportPage.jsx`

Route: `/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report`

Sections:
- **Sticky header** with back button and "Export PDF" button (downloads via `useReport.downloadPdf()`)
- **Cover card** — project/run metadata + compliance banner (green/red/amber)
- **KPI strip** — 5 highlight cards (influent Q, effluent Q, BOD removal %, TN removal %, unit cost)
- **Influent & Effluent Quality** — full table with compliance badge per parameter
- **Annual OPEX** — horizontal cost bars + total cost card + unit cost grid
- **Unit Operation Performance** — per-node metrics grids (2-column layout)
- **Dynamic hourly profile** table (if dynamic run)
- **Process Streams** — all edges with concentrations
- **Configuration Appendix** — node params table; collapsible

### Frontend: `useReport.js`

```js
const { data, loading, error, downloadPdf } = useReport(projectId, flowsheetId, runId);
```

`downloadPdf()` — fetches the PDF endpoint with the auth bearer token,
creates an object URL, triggers a `<a download>` click, then revokes the URL.

### Access point

In `SummaryPanel` (CanvasPage), after a simulation completes, the Export section
now shows a prominent "📊 View Full Report & Export PDF" button above the CSV/JSON links.

### API endpoints added

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/v1/projects/:pId/flowsheets/:fId/simulate/:runId/report` | JWT | JSON report data |
| GET | `/api/v1/projects/:pId/flowsheets/:fId/simulate/:runId/report/pdf` | JWT | PDF download |

### Dependencies

Backend runtime: `python3`, `reportlab>=4.2`, `matplotlib`, `numpy`
(all pre-installed in `Dockerfile.prod`; for local dev: `pip install reportlab matplotlib`)
