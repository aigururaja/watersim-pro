# WaterSim Pro

> Web-Based Wastewater & Water Purification Process Simulation Platform

## Stack
- **Frontend:** React 18 + Vite + Tailwind CSS + React Router + TanStack Query + Zustand
- **Backend:** Node.js + Express + PostgreSQL
- **Auth:** JWT (access token) + httpOnly cookie (refresh token) + RBAC
- **Repo layout:** npm workspaces monorepo — a **single root `package-lock.json`** covers both
  workspaces (`backend`, `frontend`); there are no per-workspace lockfiles.

## Quick Start

### Prerequisites
- Node.js >= 18
- PostgreSQL >= 14
- npm >= 9

### Setup
```bash
# 1. Install dependencies (root install covers both workspaces)
npm install

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your DB credentials and JWT secret
# (set PORT=3001 for local dev — the frontend dev proxy expects it)

# 3. Create database
createdb watersim_dev

# 4. Apply versioned migrations (backend/src/db/migrations/*.js)
npm run db:migrate

# 5. Seed demo data (optional)
npm run db:seed

# 6. Start dev servers (both frontend + backend)
npm run dev
```

### Docker (dev stack)
```bash
docker compose up            # postgres + one-shot migrate + backend (nodemon) + frontend (Vite)
docker compose run --rm backend npm run seed
```

### Ports & URLs
| Service          | Local dev (`npm run dev`)     | Docker compose (dev)        |
|------------------|-------------------------------|-----------------------------|
| Frontend         | http://localhost:5173         | http://localhost:3000       |
| Backend API base | http://localhost:3001/api/v1  | http://localhost:4000/api/v1 |
| Health check     | http://localhost:3001/health  | http://localhost:4000/health |

Notes:
- The backend dev port comes from `backend/.env` (`PORT=3001`); containers run on 4000.
- The health endpoint is **`/health`** (unversioned, unauthenticated) — not `/api/health`.
- All API routes live under **`/api/v1`** (`API_VERSION` env var).

## Project Structure
```
watersim/
├── backend/
│   └── src/
│       ├── config/        # Environment config
│       ├── controllers/   # Route handlers
│       ├── db/            # PostgreSQL pool, query helpers,
│       │   └── migrations/  # versioned JS migrations (npm run db:migrate)
│       ├── middleware/    # Auth, RBAC, error handling
│       ├── models/        # DB query functions
│       ├── reports/       # PDF/Excel generators (Python: reportlab, matplotlib, openpyxl)
│       ├── routes/        # Express routers
│       ├── seeds/         # Demo data (npm run db:seed)
│       ├── utils/         # Logger, JWT helpers
│       └── server.js
├── frontend/
│   ├── src/
│   │   ├── components/    # Reusable UI (canvas, layout, shared)
│   │   ├── context/       # React context (Auth)
│   │   ├── hooks/         # Custom hooks
│   │   ├── pages/         # Page components
│   │   ├── services/      # API service layer
│   │   └── utils/
│   └── index.html
├── k8s/                   # Kubernetes manifests (kustomize)
├── nginx/                 # Frontend + reverse-proxy nginx configs
├── scripts/               # deploy / backup / restore / TLS bootstrap
└── docs/                  # Runbooks
```

## Auth Flow
1. Register: `POST /api/v1/auth/register` (creates org + admin user)
2. Login: `POST /api/v1/auth/login` → access token (JSON) + refresh token (httpOnly cookie)
3. All protected requests: `Authorization: Bearer <accessToken>`
4. Refresh: `POST /api/v1/auth/refresh` → new access token + rotated refresh cookie
5. Logout: `POST /api/v1/auth/logout`

## Roles
Roles are **hierarchical** (`viewer < operator < engineer < admin`): each role
inherits everything below it. A route guarded with `requireRole('engineer')`
accepts engineers **and** admins.

| Role      | Adds on top of the previous role |
|-----------|----------------------------------|
| viewer    | Read-only access to projects, flowsheets, and reports in their organisation |
| operator  | Run simulations on existing flowsheets |
| engineer  | Create/edit/delete projects and flowsheets, edit unit costs, view org stats & member list |
| admin     | Full access: user management and all `/api/v1/admin` endpoints |

## Deployment
Two supported production modes — see **`docs/RUNBOOK-deploy.md`** for the full procedure
(CI/CD image flow, tag pinning, rollback) and **`docs/RUNBOOK-backup-restore.md`** for
backups and the restore drill.

- **Docker Compose:** `docker-compose.prod.yml` runs pre-built GHCR images
  (pushed by `.github/workflows/cd.yml`); `scripts/deploy.sh` performs
  pull → migrate → rolling update → health check with automatic rollback.
  First-time TLS bootstrap: `scripts/init-tls.sh`.
- **Kubernetes:** `kubectl apply -k k8s/` (secrets from `k8s/secret.example.yaml`,
  migrations via `k8s/migrate-job.yaml` before each rollout, nightly `pg_dump`
  CronJob in `k8s/backup-cronjob.yaml`).

All Docker builds (dev and prod) use the **repo root as build context** because of the
single workspace lockfile — e.g. `docker build -f backend/Dockerfile.prod .`
