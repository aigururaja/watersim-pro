# WaterSim Pro

> Web-Based Wastewater & Water Purification Process Simulation Platform

## The ITC sewage treatment plant

The platform ships with the **ITC STP** (Client ITC · Contractor Safekrite ·
Sub-contractor Infercon Automation) modelled end to end from *Project Proposal
v2*: all eleven process areas, 339 wired signals, the ten-section control
narrative, and every commercial table.

Open **`/plant`** for the plant definition, the **process flow diagram**, the I/O
schedule, the control sequences, the costing, and a review of **27 places the
proposal disagrees with itself** — including a valve count that differs by 15
between the equipment list and the price, and an SBR cycle that passes 590 of the
plant's 675 KLD design flow.

- **[`docs/ITC-STP-FLOW.md`](docs/ITC-STP-FLOW.md)** — the process flow diagram and
  the full stream table. Both are *generated* (`npm run plant:flow`) from
  `backend/src/plants/itcStp/flowsheet.js`, so the drawing cannot drift from the
  model; [`docs/itc-stp-pfd.svg`](docs/itc-stp-pfd.svg) is the printable sheet.
- **[`docs/ITC-STP-PROPOSAL-REVIEW.md`](docs/ITC-STP-PROPOSAL-REVIEW.md)** — the
  full proposal review.
- **[`docs/THREE-APPLICATIONS-PLAN.md`](docs/THREE-APPLICATIONS-PLAN.md)** — the
  gap map and phased plan for the three applications the platform is growing
  into: Operations Monitor & Control, Digital Twin, Predictive Maintenance.

`npm run db:seed` creates the plant as a working project (org `itc-stp`) with the
full flowsheet, a reuse permit template and alarm rules taken from the control
narrative's own setpoints — and, imported from it, the plant's twin project.

## A dashboard per role
`GET /dashboard` is the home screen for whoever logged in, assembled by role
(`backend/src/routes/dashboard.js`): a viewer's plant overview, an operator's
console (active alarms, tripped and stopped drives, the tasks on their desk,
live readings), an engineer's desk (their tasks, the twin and its drift, PLC
health, run hours and trips, projects and recent runs), a manager's overview
(approvals and overdue tasks, alarm load and time-to-acknowledge, noisy rules,
notification delivery, the team) and the administrator's page (users and
logins, API keys and webhooks, deliveries, PLC connections, the twin, the
audit trail, system health). The response names its `sections` in order and
the page draws exactly those, so a role never sees a card it has no capability
for. Alarm and task events on the organisation socket refresh it; PLC updates
move the readings in place.

## Monitoring projects and twin projects
A project has a `kind`. A **monitoring** project is the plant as built and
wired — its flowsheet, tags and PLC points — created under Operations →
Projects (`/monitoring/projects`) and watched on the Live plant screen. A
**twin** project is a model to run beside the plant, or a design study, created
under Digital Twin → Projects (`/projects`) or **imported from live**
(`POST /projects/:id/import-to-twin`): the flowsheets are copied and each keeps
`source_flowsheet_id`, so the twin loop reads the plant's measurements, drift
rules and instrument tags through the link and never carries bindings of its
own. The canvas editor draws the same machines and pipes as the Live plant (the
*Realistic* style); the drafting symbols are one click away (*Drawing*).

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
│       ├── plants/        # Real plant definitions
│       │   └── itcStp/      # ITC STP: processes, proposal, narrative,
│       │                    # flowsheet, I/O schedule, costing, review
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
Roles are **hierarchical** (`viewer < operator < engineer < manager < admin`): each role
inherits everything below it. A route guarded with `requireRole('engineer')`
accepts engineers, managers **and** admins.

| Role      | Adds on top of the previous role |
|-----------|----------------------------------|
| viewer    | Read-only access to dashboards, projects, flowsheets, reports, tasks and the twin |
| operator  | Run simulations and what-if scenarios, acknowledge alarms, raise maintenance tasks |
| engineer  | Create/edit/delete projects and flowsheets, edit alarm rules and tags, be assigned and complete tasks, view org stats & member list |
| manager   | Approve maintenance tasks, acknowledge critical alarms, set notification policy |
| admin     | Full access: user management, PLC connections, the audit trail, all `/api/v1/admin` endpoints |

Named **capabilities** sit on top of the hierarchy (`backend/src/auth/roles.js`,
mirrored in `frontend/src/auth/roles.js` and kept identical by a test): a route
guarded with `requireCapability('task.approve')` admits managers and admins, and
the shell uses the same table to decide which of the three surfaces
(Operations, Digital Twin, Maintenance) and admin links to draw.

## Historian and trends
Every PLC sample the poller reads is appended to `tag_samples` (partitioned by
month) and rolled into 1-minute and 1-hour buckets by an in-process job. The
Trends page (`/trends`) reads any tag over any window through
`GET /api/v1/tags/history`, which picks the resolution from the span (raw up
to 3 h, then 1 m, 15 m, 1 h, 1 d) and completes a window from raw samples the
rollup has not reached yet. `POST /api/v1/reports/period` turns the same
window into CSV, Excel or PDF. Retention is set per level with
`HISTORIAN_RAW_RETENTION_DAYS`, `HISTORIAN_1M_RETENTION_DAYS` and
`HISTORIAN_1H_RETENTION_DAYS`; raw partitions past retention are dropped
whole. Alarm rules are one limit each (`kind` high / low / range) so a
critical HIGH and a warning LOW can share a target, and a `quality` rule
raises the comms-loss alarm when a bound point has had no good sample for
`stale_after_s` seconds. Requires Postgres 14 or newer.

## CMMS boundary
Another system reaches WaterSim Pro with a scoped API key (Settings →
Integrations, shown once): `GET /api/v1/assets[…]` describes every equipment
loop as an asset with its points, history, counters and events, and
`POST /api/v1/cmms/work-orders/:externalId/status` lets a work order closed in
the CMMS close the task here. Outbound, every alarm, task, drift and daily
counters event is delivered to registered webhooks with an HMAC signature
(`X-WaterSim-Signature`), retried and dead-lettered from the notification
outbox. `scripts/sync-cmms-assets.js` seeds the CMMS's asset register from the
tag registry; the matching receiver, work orders and maintenance plans live in
the `cmms-hydrogen` repository.

## Digital twin
`/twin` runs the process model beside the plant on the server: every enabled
flowsheet is re-solved on its cadence with the live PLC measurements merged
into its parameters, and each instrument's residual (measured minus modelled)
is recorded with a z-score against its own history; an alarm rule of kind
`drift` raises when |z| passes its limit. What-if scenarios start from the
twin's live state and are never saved as runs. A PLC connection can be put
into **shadow mode** (`PUT /api/v1/twin/connections/:id/mode`), where writes
and reads use the simulator instead of the device and a command is reflected
onto its status contacts; the ITC control narrative's sequences can then be
played as commissioning scripts. Leaving shadow mode needs a manager.
Equipment counters (run hours, starts, trips per drive per day) are derived
from the historian for predictive maintenance.

## Live plant screen
`/live` is the operations screen: every process area with gauges for its
bound analogue points and the canvas's equipment symbols drawn in their
measured state (a pump runs because its XS contact says so), the active
alarms with acknowledgement, the health of every PLC connection, the
maintenance load, and pinned trends. It cold-starts from
`GET /api/v1/live/snapshot` and stays current on the organisation-wide,
listen-only WebSocket room `/ws/org`, which carries every `plc:update`,
`alarm:event`, `task:event` and `notification`. Start/Stop and Open/Close on
a card write to the drive's command binding through the audited PLC write
endpoint after an explicit confirmation (operator and above).

## Maintenance workflow and notifications
An alarm rule can carry a task policy (`createTask`, `taskAssigneeRole`,
`taskRequiresApproval`, `taskDueWithinH`); when such a rule raises, the
evaluator opens a maintenance task and assigns it to the least-loaded holder
of the role. Tasks move only through `POST /api/v1/tasks/:id/transition`
(`assign`, `start`, `complete`, `approve`, `reject`, `cancel`, `reopen`,
`acknowledge`), each step gated by capability, written to `task_transitions`
and to the audit trail. Managers approve or reject completed work and
acknowledge critical alarms' tasks. Notifications are policy-driven
(`/api/v1/notifications/subscriptions`: role or user × event type × minimum
severity → channels), queued in `notification_outbox` and sent by an
in-process worker over SMTP (`SMTP_*`) and Twilio WhatsApp (`TWILIO_*`), with
retries, dead-lettering and a manager-side retry; `NOTIFICATIONS_DRY_RUN=true`
logs instead of sending. The Tasks board is at `/tasks`; personal channels
and the organisation's policy are under Settings → Notifications.

On every authenticated request the user's **current** role and active flag are
re-read from the database (cached `ROLE_CACHE_TTL_MS`, default 30 s) and
override the role in the access token, so a demotion bites within the cache
window and a deactivation bites on the next request. If the lookup fails or
exceeds `ROLE_LOOKUP_TIMEOUT_MS` the request proceeds on the token's role
(fail-open) — a deleted user's token therefore stays usable for up to one TTL.

## Deployment
Three supported production modes — see **`docs/RUNBOOK-deploy.md`** for the full procedure
(CI/CD image flow, tag pinning, rollback) and **`docs/RUNBOOK-backup-restore.md`** for
backups and the restore drill.

- **Docker Compose:** `docker-compose.prod.yml` runs pre-built GHCR images
  (pushed by `.github/workflows/cd.yml`); `scripts/deploy.sh` performs
  pull → migrate → rolling update → health check with automatic rollback.
  First-time TLS bootstrap: `scripts/init-tls.sh`.
- **Kubernetes:** `kubectl apply -k k8s/` (secrets from `k8s/secret.example.yaml`,
  migrations via `k8s/migrate-job.yaml` before each rollout, nightly `pg_dump`
  CronJob in `k8s/backup-cronjob.yaml`).
- **Ubuntu server, no Docker:** `docs/RUNBOOK-deploy-ubuntu.md` — Node under systemd,
  nginx serving the Vite build and proxying `/api/`, `/ws/`, `/health` to
  `127.0.0.1:4000`, PostgreSQL on loopback, Python in a venv, certbot for TLS.

All Docker builds (dev and prod) use the **repo root as build context** because of the
single workspace lockfile — e.g. `docker build -f backend/Dockerfile.prod .`
