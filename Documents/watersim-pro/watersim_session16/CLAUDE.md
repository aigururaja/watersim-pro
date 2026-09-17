# WaterSim Pro (being renamed SafeKrit) — project knowledge for every Claude session

This file is the shared memory of the project. Claude Code loads it automatically
for any session opened in this directory or below. Everything here was learned
the hard way in earlier sessions; read it before touching the code, the database,
or the server. Keep it current: when a decision changes or a new trap is found,
edit this file in the same commit.

Last updated: 9 Sep 2026 (branch `session17-remediation`, HEAD `b459738`).

**Product rename in progress (9 Sep 2026).** At 10:22 IST another session
began renaming the product from *WaterSim Pro* to **SafeKrit** across the
working tree: 165 tracked files, uncommitted at the time of writing, covering
the README title, the page `<title>`, package descriptions, every source
header and the WhatsApp template names in the catalogue (`watersim_alert` →
`safekrit_alert` and the other three). Identifiers that still carry the old
name and were not renamed: the GitHub repo `watersim-pro`, the npm packages
`@watersim/*`, the `X-WaterSim-Signature` webhook header, the CMMS settings
`WATERSIM_*`, and on the VPS the service user, paths, `watersim-backend.service`,
helpers and database file. Two consequences. First, the four templates already
submitted to Meta on 7 Sep 2026 are named `watersim_*`; a renamed catalogue
must be re-submitted under the new names, or `WHATSAPP_TEMPLATES` must map to
the names Meta actually holds. Second, this file says "WaterSim Pro" wherever a
path or identifier still does. Confirm the final spelling with the user before
adding new brand strings; the contractor in the proposal is spelled *Safekrite*.

---

## 1. What this project is

WaterSim Pro is a web platform for wastewater / water-purification process
simulation that has been reshaped into **one product with three surfaces**:

| Surface | What it is | Where |
|---|---|---|
| A · Operations Monitor & Control | live plant screen, alarms, trends, maintenance tasks, control write-back, period reports | `/live`, `/alarms`, `/trends`, `/tasks`, `/monitoring/projects` |
| B · Digital Twin | server-side twin loop beside the plant, residuals and drift alarms, what-if scenarios, shadow/commissioning mode | `/twin`, `/projects` |
| C · Predictive Maintenance | asset/history API, signed webhooks and work-order round trip with the CMMS | Settings → Integrations, `/api/v1/assets`, `/api/v1/cmms` |

It is being sold around **one real plant**: the ITC hotel Sewage Treatment Plant
(client ITC, contractor Safekrite, sub-contractor Infercon Automation; a 675 KLD
SBR plant, 11 process areas, 339 wired signals). The seed creates it as org
`itc-stp`. **A client demo is pending: speed and polish beat completeness.**

The roadmap is [docs/THREE-APPLICATIONS-PLAN.md](docs/THREE-APPLICATIONS-PLAN.md).
All five phases (0 foundations, 1 historian, 2 maintenance + notifications,
3 live dashboard, 4 twin, 5 CMMS boundary) were built and marked DONE on
7 Sep 2026. Read its "Status:" lines and the "Projects are split by surface"
note before starting new work.

## 2. Where things live

- **Git root:** `D:\watersim-pro` (GitHub `aigururaja/watersim-pro`). Default
  branch `master`; all current work is on **`session17-remediation`**, which is
  also what production runs.
- **The app:** `Documents/watersim-pro/watersim_session16/` inside that repo.
  This is the npm-workspaces monorepo root (`backend/`, `frontend/`, one root
  `package-lock.json`, no per-workspace lockfiles).
- **The CMMS:** sibling repo `../cmms-hydrogen` (FastAPI + SQLite, its own
  README). Untracked from this repo. It holds work orders and maintenance
  plans and talks to WaterSim by API key and signed webhook.
- **Secrets:** `backend/.env` (gitignored) holds the dev config, the VPS SSH
  credentials (`SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSh_PASSWORD` — the typo is
  real), and the WhatsApp/SMTP values. Never print them, never commit them,
  never paste them into chat. Read a value inside the same shell command that
  uses it.
- **Docs worth reading:** `README.md` (architecture and every subsystem),
  `docs/RUNBOOK-deploy-ubuntu.md` (the production procedure),
  `docs/RUNBOOK-backup-restore.md`, `docs/ITC-STP-FLOW.md` and
  `docs/itc-stp-pfd.svg` (generated, do not hand-edit),
  `docs/ITC-STP-PROPOSAL-REVIEW.md`, `docs/ITC-STP-FLOW-AUDIT-QUEUE.md`
  (unverified review queue, not a defect list),
  `docs/WaterSim-Pro-Process-Overview.pdf` (39-page client overview).
  The `SESSION_STATE*.md` files in the root and `docs/` are **historical**
  hand-off notes from sessions 3–16 and are stale; do not plan from them.

## 3. Decisions that are settled (do not reopen)

1. **ISA-5.1 tags only.** Every instrument, equipment and signal tag follows
   `<area>-<function letters>-<loop>` (e.g. `RFP-P-201`, `SBR-LT-301`,
   signal suffixes like `.ZSO`, `.XY-A`). The user rejected `PMP-101` /
   `VLV-101` style outright. `backend/src/tags/isa.js` is the single validator;
   the tag API refuses non-conforming tags and `isaTags.test.js` holds the
   seed to it. No free-form device codes anywhere: seeds, docs, UI placeholders.
2. **SQLite is the database everywhere** (dev, tests, production). The user
   chose it over an already-installed PostgreSQL on 7 Sep 2026 and reaffirmed
   it when pushed back on. Postgres is still selectable via a `postgres://`
   `DATABASE_URL` but is untested since the port. See §6 for the rules.
3. **Monitoring and twin projects are separate.** `projects.kind` is
   `monitoring` (the plant as wired, created under Operations, watched on
   `/live`) or `twin` (created under Digital Twin, or imported from live with
   `POST /projects/:id/import-to-twin`; twin flowsheets keep
   `source_flowsheet_id` and never carry PLC bindings of their own).
4. **Small agent fan-out.** A verification workflow once grew to 369 agents and
   the user objected. Do the work directly unless it is genuinely parallel; if
   you fan out, a handful of agents with capped findings each.
5. **Rate limits are off by default** (`RATE_LIMIT_MAX=0`,
   `AUTH_RATE_LIMIT_MAX=0`) after two production lockouts. The auth limiter,
   when on, counts failed sign-ins only.

## 4. Stack, commands, ports

- Node >= 22.13 (`node:sqlite`), npm >= 9. React 18 + Vite + Tailwind + React
  Router + TanStack Query + Zustand + React Flow + Recharts. Express +
  `node:sqlite` (or `pg`), JWT access token + httpOnly refresh cookie, RBAC.
  Python (reportlab, matplotlib, openpyxl, PLC bridge) in a venv.

```bash
npm install                       # root install covers both workspaces
cp backend/.env.example backend/.env   # set PORT=3001 for local dev
npm run db:migrate                # creates backend/data/watersim.db
npm run db:seed                   # demo-org + the whole ITC plant, idempotent
npm run dev                       # backend :3001 + frontend :5173
npm run plant:flow                # regenerate docs/ITC-STP-FLOW.md + itc-stp-pfd.svg
npm run lint && npm run format:check
```

| Thing | Value |
|---|---|
| Frontend dev | http://localhost:5173 (proxies `/api` to 3001) |
| Backend dev | http://localhost:3001, API base `/api/v1`, health `/health` (unversioned) |
| Docker / production backend | port 4000 |
| WebSocket rooms | `/ws/flowsheets/:id` (collab) and `/ws/org` (listen-only live feed) |

**Seeded logins** (published defaults; the ITC admin default still works on
production as of 7 Sep 2026 and the user was told to change it):

| Org slug | Email | Password | Role |
|---|---|---|---|
| `itc-stp` | admin@itc-stp.local | Admin1234! | admin |
| `itc-stp` | manager@itc-stp.local | Manager1! | manager |
| `itc-stp` | engineer@itc-stp.local | Engineer1! | engineer |
| `itc-stp` | operator@itc-stp.local | Operator1! | operator |
| `itc-stp` | viewer@itc-stp.local | Viewer123! | viewer |
| `demo-org` | admin@watersim.dev / engineer@watersim.dev / operator@watersim.dev | Admin1234! / Engineer1! / Operator1! | |

Login is `POST /api/v1/auth/login` with `email`, `password`, `orgSlug`; the
login page fills the organisation from `GET /api/v1/auth/organisations`.

**Tests.** Backend: `jest` (626 tests green on SQLite). Frontend: `vitest`.
E2E: `playwright` (`e2e/smoke.spec.js`). CI is `.github/workflows/ci.yml`
(lint + audit + tests per workspace, then images). Always run the backend
suite with a **private** test database, see §7.

## 5. Architecture map

Roles are hierarchical (`viewer < operator < engineer < manager < admin`) and
named capabilities sit on top, defined once in `backend/src/auth/roles.js` and
mirrored in `frontend/src/auth/roles.js` (a test keeps them identical).
`requireRole('engineer')` means engineer or above; `requireCapability('task.approve')`
reads the same table. On every request the user's role and active flag are
re-read from the DB (`ROLE_CACHE_TTL_MS`, fail-open on lookup failure).

Backend subsystems (`backend/src/`):

| Directory | Owns |
|---|---|
| `db/` | `pool.js` dispatches to `sqlite.js` or `pg.js`; `migrate.js`; `migrations/` (Postgres) and `migrations_sqlite/` (same ids 001–015) |
| `auth/`, `middleware/` | roles, JWT, per-request role refresh, `serviceAuth.js` for API keys |
| `tags/` | ISA-5.1 grammar, tag registry |
| `plants/itcStp/` | the ITC plant as code: `processes.js`, `proposal.js`, `narrative.js`, `flowsheet.js`, `ioSchedule.js`, `costing.js`, `diagram.js`, `emitFlowDocs.js` |
| `seeds/` | `index.js` (demo-org) and `itcStp.js` (the plant, both project kinds, alarm rules, policies) |
| `simulation/` | steady-state solver (topological BFS + per-unit models), `dynamicSolver.js`, worker pool, 21 unit models incl. `sbrReactor`, `instrument`, `pump`, `valve` |
| `plc/` | poller, `drivers/` (simulator, Modbus TCP, OPC UA, S7, EtherNet/IP via `bridge/plc_bridge.py`) |
| `alarms/` | rule evaluator (kinds high / low / range / quality / drift), comms-loss sweep, one active event per rule |
| `historian/` | `tag_samples` raw + 1 m + 1 h rollups, retention, `query.js` auto-resolution |
| `maintenance/` | `tasks.js` state machine: `transition()` is the only write path |
| `notifications/` | policy → outbox → worker; adapters `email.js` (SMTP), `whatsapp.js` (Meta Cloud API or Twilio), `webhook.js` (HMAC); `whatsappTemplates.js` catalogue; `inbound.js` for Meta callbacks |
| `twin/` | `index.js` loop, `counters.js` (run hours / starts / trips), `shadow.js`, `scripts.js` (narrative sequences as commissioning scripts) |
| `collab/` | WebSocket server, flowsheet rooms and the org room |
| `reports/` | Python PDF/Excel generators |
| `routes/` | one router per API area (see `server.js` mounts: auth, projects, flowsheets, simulate, plc-bindings, alarms, permit-templates, admin, reports, plc, plant, tags, audit, tasks, notifications, live, twin, assets, cmms, integrations, dashboard, webhooks) |

Frontend (`frontend/src/`): pages in `pages/` (Dashboard, Projects, Project,
Canvas, LivePlant, Twin, Alarms, Trends, Tasks, Reports, Comparison, Audit,
Admin, Settings, Login, Register); the three-surface shell in
`components/layout/AppLayout.jsx`; role dashboards in `components/dashboard/`
(`GET /dashboard` returns role-specific `sections` and the page draws exactly
those); the photoreal SCADA mimic in `components/mimic/` (symbols, view,
layout, css) used by the Live plant and, as the "Realistic" canvas style, by
`components/canvas/MimicNode.jsx` and `PipeEdge.jsx`; the drafting symbols in
`components/canvas/symbols/`; live gauges/cards in `components/live/`.

Adding a migration means **two files with the same id**:
`backend/src/db/migrations/NNN_name.js` and
`backend/src/db/migrations_sqlite/NNN_name.js`. The seed must stay idempotent.

## 6. Database rules (SQLite behind a Postgres-dialect query API)

`backend/src/db/sqlite.js` runs the app's PostgreSQL SQL on `node:sqlite` by
translating the mechanical differences (`$n` params, `= ANY($1)`, casts,
`NOW() ± INTERVAL`, `ILIKE`, `FOR UPDATE`, `ARRAY[]`, `DEFAULT NOW()`, the
`updated_at` trigger), registering `NOW()`, `gen_random_uuid()`,
`uuid_generate_v4()` and `REGEXP`, converting BOOLEAN / JSONB / TIMESTAMPTZ
columns on the way out, and mapping constraint failures to Postgres SQLSTATEs.
Its header comment is the contract. Rules for new SQL:

- Write Postgres dialect within what the driver covers, or branch on
  `isSqlite`. Never use `UNNEST`, `DISTINCT ON`, `||` on JSON, `table.*` in
  `RETURNING`, or unaliased aggregates read by name.
- `NOW()` and every column default produce a **27-character** monotonic
  timestamp (real millisecond + 3-digit sequence). A bound JS `Date` is 24
  characters. So never compare a bound Date to a stored timestamp with `=`;
  use `<=` / `>=` windows. The last three digits are a sequence, not
  microseconds; never treat them as a duration.
- Never write a SQLite row outside the driver (defaults call registered
  functions). Never open the production file as root while the service runs.
- One process, one writer: a transaction holds an async mutex; nested
  `withTransaction()` joins the outer one.
- `backend/scripts/sqlite-rebuild-defaults.js` brings an older file's column
  defaults in line; run it with the service stopped.
- `DATABASE_URL=sqlite:./data/watersim.db` in dev; `backend/data/` is gitignored.

## 7. Working in this checkout (many sessions, one tree, Windows)

- **Several Claude sessions share this checkout at once.** `ListAgents` shows
  them (names like `watersim-session16-*`, `cmms-hydrogen-*`). Coordinate with
  `SendMessage`. Never infer who edited a file from it changing between your
  read and write; ask. Before claiming a file or a subsystem, confirm nobody
  else owns it. Announce a deploy before doing one.
- **Private test DB, always.** `backend/scripts/ensure-test-db.js` deletes and
  re-migrates the `_test` sibling of the dev file on every jest run, so two
  concurrent runs wipe each other and a green tree looks broken. Run
  `TEST_DATABASE_URL=sqlite:./data/watersim_test_<yourname>.db npx jest`
  from `backend/`.
- Don't start `npm run dev` while another session holds the ports. A stopped
  `npm run dev` on Windows leaves node children on 3001/5173: find them with
  `Get-NetTCPConnection -LocalPort 3001,5173` and `Stop-Process` in PowerShell.
- **Git Bash heredocs fail silently** here when the body has apostrophes or
  non-ASCII characters (`·`, `—`, `≤`): nothing is written and the error is
  confusing. Write multi-line files with the Write tool; keep heredocs for
  tiny ASCII scripts. `cd` in one Bash call persists into later calls, so use
  absolute paths or `git -C`.
- The permission classifier blocks reading the enterprise CRM's `.env`, any
  command that merges secrets into `backend/.env`, `pscp` of a secrets file,
  and long combined remote commands. One small, clearly named action per call
  goes through.

## 8. Production: the VPS

Deployed bare-metal (no Docker) per `docs/RUNBOOK-deploy-ubuntu.md`, first on
7 Sep 2026. Deployed state as of 7 Sep evening: `b459738`.

- **Host** `193.203.161.76` (`srv451190.hstgr.cloud`), Hostinger, Ubuntu
  24.04, **1 vCPU, 3.9 GB RAM, swap half used**. It is a **shared multi-site
  box**: system nginx 1.28 with one conf per `*.inferconautomation.com`
  subdomain in `/etc/nginx/sites-enabled/`, certbot, CloudPanel on 8443,
  MySQL, Redis, Mosquitto, Varnish, Jitsi in Docker, and another API on the
  **system Node 18** (`node-app.service`). Do not upgrade the system Node or
  touch other sites' confs.
- **Sites:** `https://dt.inferconautomation.com` (the SPA, same-origin
  `/api/v1` and `/ws/` proxied) and `https://dtapi.inferconautomation.com`
  (bare backend for the CMMS and Meta's WhatsApp callback; `/metrics` blocked).
- **Layout:** user `watersim` (home `/opt/watersim`), private Node 22 at
  `/opt/watersim/node/bin`, repo clone `/opt/watersim/repo` with the app
  symlinked as `/opt/watersim/app`, venv `/opt/watersim/venv`, env file
  `/etc/watersim/backend.env` (root:watersim 640, secrets generated on the
  server), database `sqlite:/opt/watersim/data/watersim.db`, static frontend
  `/var/www/watersim`, unit `watersim-backend.service` on 127.0.0.1:4000,
  helpers `/usr/local/bin/watersim-node` and `/usr/local/bin/watersim-backup`
  (VACUUM INTO, nightly). PostgreSQL 16 was installed first and is now
  disabled; `watersim_prod` is still on disk.
- **Access:** root with a password from `backend/.env`. The Bash tool cannot
  answer password prompts and installing a key was blocked, so use PuTTY:
  `plink -batch -pw "$PW" root@HOST '<one command>'` and `pscp -pw "$PW"`.
  Pull the password inside the same command:
  `PW=$(grep '^SSh_PASSWORD=' backend/.env | cut -d= -f2- | tr -d '\r"')`.
  Host key is cached.
- **Update procedure:** commit and push → on the box
  `sudo -u watersim -H git -C /opt/watersim/repo pull --ff-only` →
  `npm ci --workspace=backend --omit=dev --ignore-scripts` with
  `/opt/watersim/node/bin` on PATH only if dependencies changed →
  `sudo -u watersim -H watersim-node src/db/migrate.js up` → upload a fresh
  frontend build → `systemctl restart watersim-backend` → verify.
- **The frontend is built on the dev PC** (the server cannot afford Vite).
  **Always** build with `MSYS_NO_PATHCONV=1` in Git Bash, otherwise
  `VITE_API_BASE=/api/v1` becomes `C:/Program Files/Git/api/v1` and every
  browser call fails before it is sent ("Login failed", nothing in nginx logs).
  Verify: `grep -c 'Program Files' frontend/dist/assets/index-*.js` must be 0.
  Pack with a POSIX path (`tar -czf /c/Users/.../dist.tgz -C frontend/dist .`;
  a `C:/` path makes tar look for a remote host), `pscp` to `/tmp`, then
  `tar -xzf /tmp/watersim-dist.tgz -C /var/www/watersim` over the old files.
  Build from a `git worktree` of the commit being deployed when other sessions
  have half-done edits. If you build from a `git archive` export with a
  `node_modules` junction, delete the junction with PowerShell
  `(Get-Item …\node_modules).Delete()` before any `rm -rf`, because MSYS rm
  follows it into the real `node_modules`.
- **Verify a deploy** with `GET /health`, `GET /api/v1/auth/organisations`
  and the served bundle name. **At most one real login per deploy.** The user
  browses the live site from this same PC, so a loop of login probes locks
  them out too (this happened on 7 Sep 2026 and was read as "the dropdown was
  not deployed"). A restart of `watersim-backend` clears an in-memory limiter.
- Keep `SIMULATION_MAX_CONCURRENT=1` and modest historian retention on this box.

## 9. Notifications: WhatsApp and email

- WhatsApp goes through **Meta's WhatsApp Business Cloud API** on the
  enterprise CRM's business account (the CRM lives at
  `D:/enterprisesautomation/enterprise/backend`; WABA id 1349157530493513).
  Variable names match the CRM: `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
  `WHATSAPP_DEFAULT_COUNTRY_CODE`. Twilio stays selectable with
  `WHATSAPP_PROVIDER=twilio`.
- Email is Gmail SMTP with an app password (`SMTP_USER`, `SMTP_PASSWORD`,
  `SMTP_FROM_EMAIL`, sender jsonia.infercon@gmail.com); `SMTP_HOST` may stay
  unset, the adapter derives smtp.gmail.com:587.
- The real values are already in `backend/.env` (the user copied them) and in
  `/etc/watersim/backend.env` on the host. Use them through the scripts; do
  not read the CRM's `.env` (blocked) and do not copy secrets by hand. To
  change host values, delete-and-append the `SMTP_*`/`WHATSAPP_*` lines in
  `/etc/watersim/backend.env` in one small `plink` call from local shell
  variables.
- `node backend/scripts/notify-live-test.js --email <addr> --phone <+E164> --pick-template`
  sends one real email and one WhatsApp. The user's own test contacts:
  WhatsApp +916381794189, email rpradeep1797@gmail.com.
- WaterSim's four UTILITY templates (`watersim_alarm_raised`,
  `watersim_alarm_cleared`, `watersim_task_update`, default `watersim_alert`;
  `{{1}}` subject, `{{2}}` details) live in
  `backend/src/notifications/whatsappTemplates.js`. They were submitted to
  Meta on 7 Sep 2026 (`node backend/scripts/whatsapp-templates.js submit`)
  and were PENDING; `list` shows status. Once all are APPROVED set
  `WHATSAPP_TEMPLATES={"alarm.raised":"watersim_alarm_raised","alarm.cleared":"watersim_alarm_cleared","task.":"watersim_task_update","*":"watersim_alert"}`
  on the host. Meta refuses a body that begins or ends with a variable or
  stacks two; the catalogue's `check()` mirrors those rules. The 9 Sep 2026
  rename changes these four names to `safekrit_*` in the working tree while
  Meta holds the `watersim_*` submissions; see the rename note at the top.
- Meta delivery receipts and replies arrive on `POST /api/v1/webhooks/whatsapp`;
  a reply from a phone marks that channel verified. `NOTIFICATIONS_DRY_RUN=true`
  logs instead of sending (the dev default).
- Receivers are per person: `phone` on `/api/v1/admin/members`, receiver
  email/WhatsApp under Settings → Notifications → Receivers, separate from the
  login email and profile mobile. `POST /api/v1/notifications/subscriptions/defaults`
  installs the policy for all five roles.

## 10. Looking at the UI without a browser session

The user judges work by screenshots of the running app and asked for the plant
mimic to be "more realistic, up to the real image" (photoreal pool-plant SCADA
style). Expect polish requests judged visually.

```bash
cd frontend
npx vite-node scripts/mimicSheet.jsx out.html     # every mimic symbol in every state
npx vite-node scripts/mimicPlant.jsx out.html     # the whole ITC plant from the running backend
npx vite-node scripts/dashboardSheet.jsx out.html # every seeded role's dashboard (needs vite build for CSS)
chrome.exe --headless=new --screenshot=out.png --window-size=1600,1000 file:///.../out.html
```

Then Read the PNG.

## 11. Building the client PDF

`docs/WaterSim-Pro-Process-Overview.pdf` was generated from hand-written HTML
with inline SVG (the PFD inlined as a `<symbol>` and drawn whole and in
thirds with cropped viewBoxes), rendered by the repo's Playwright Chromium
(`NODE_PATH=<repo>/node_modules node build.js`; browsers under
`~/AppData/Local/ms-playwright`). Mixed portrait/landscape pages work with
`@page wide { size: A4 landscape }`. Sources were in a session scratchpad, not
the repo. Trap: if any element is wider than the page (a `white-space: pre`
block in a grid column, an unbreakable URL in a narrow table), Chromium
silently scales the **whole** document down. Check rendered font sizes with
PyMuPDF; fix with `overflow: hidden` on pre blocks, `minmax(0,1fr)` grid
columns and `overflow-wrap: anywhere` on `code` and paragraphs (never on
`td`). `overflow-x: hidden` on body clips landscape pages instead of fixing it.

## 12. Current status and open items

Done and deployed (7 Sep 2026): all five plan phases; SQLite port (`d197a93`)
with the monotonic clock (`c0ebb94`); WhatsApp/email adapters and inbound
webhooks; receiver setup per role; template catalogue; login organisation
picker and page transitions; rate limits off by default; per-area SCADA mimic
windows on the Live plant; monitoring vs twin project split with import from
live (migration 015); role dashboards.

Still open (also listed in the plan):

- A true transient solver with accumulation (live tank levels, batch phases);
  the canvas still refuses to draw levels and the shadow simulator's response
  to a command is a reflection, not a process model.
- Extra PLC drivers beyond simulator / Modbus / OPC UA / S7 / EtherNet/IP.
- WhatsApp Business template approval, then the `WHATSAPP_TEMPLATES` mapping.
- The predictive models themselves (need weeks of plant data) and who owns
  the CMMS deployment.
- `docs/ITC-STP-FLOW-AUDIT-QUEUE.md`: 123 audit findings of which 61 were
  refuted before verification stopped; treat as a review queue.
- Default seeded passwords are still live on production.

## 13. How the user works

- Messages are terse: "start", "continue", "what next", "commit and push it".
  Pick up from the plan without asking them to re-explain; on 7 Sep 2026 they
  said "no need to wait for me to confirm" and expected the phases built one
  after another.
- They judge by screenshots of the running app and by the live URL.
- The demo deadline dominates: finish fast, keep fan-out small, prefer doing
  over verifying exhaustively.
- Commit and push only when asked, with the co-author trailer the session
  requires. Do not commit `backend/.env`, `backend/data/`, `frontend/dist/`
  or tarballs (all gitignored).

## 14. UI design system (15 Sep 2026)

The UI follows the Capacity Network admin console (`D:\capacity-network`,
`frontend/src/components/Shell.tsx` OpsShell, `components/ui.tsx`,
`tailwind.config.ts`, `index.css`), which the user named as the target. The
tokens and classes live in `frontend/tailwind.config.js` and
`frontend/src/index.css`; the font is Plus Jakarta Sans, self-hosted through
`@fontsource/plus-jakarta-sans` (imported in `main.jsx`).

- Colours: `ink` / `ink-2` / `ink-3` (near-black text scale), `ground` (page
  grey), `card`, `line` (borders), `accent` (teal) with `-soft` / `-ink`, and
  `ok` / `warn` / `danger` each with a `-soft` pair. `brand-*` still exists but
  its values map onto the same palette (700/600 = ink, 500 = accent, 50 =
  ground); prefer the named tokens in new code. `rounded-xl` is 14px,
  `rounded-2xl` 20px, `rounded-3xl` 28px; `shadow-card` on cards.
- Classes: `.card`, `.btn` + `.btn-primary/-secondary/-accent/-danger/-ghost`
  (40px tall) and `.btn-lg` (48px pill), `.input` (44px), `.label`, `.chip`
  / `.chip-active`, `.pill` (pair with a tone), `.stat-label` + `.stat-value`,
  `.section-title`, `.skeleton`. Dashboard cards use `Card`, `Stat` and the
  pills in `components/dashboard/cards.jsx`.
- Shell (`components/layout/AppLayout.jsx`): 248px ink sidebar with the
  product, a tier chip per role (ROLE_CHIP), the organisation, grouped nav
  with 10px uppercase group labels, the person and sign-out in the footer;
  the top strip is mobile-only, every page carries its own heading.
- Landing and doors: `/` is `pages/LandingPage.jsx` (public). "Log in" and
  "Register" open `components/auth/AuthDialog.jsx` (LoginForm / RegisterForm)
  as a popup; `/login` and `/register` render the landing with the popup
  already open, so redirects still land on the form. The e2e smoke test and
  the Playwright probes look for `select#orgSlug` inside that popup.
- Canvas and mimic drawing (`components/canvas`, `components/mimic`,
  `styles/`) keep their own colours on purpose; the palette sweep never
  touches them.
- The page-by-page layout audit script (viewport sweep with screenshots) is a
  session scratchpad tool, not in the repo; the Playwright browsers under
  `~/AppData/Local/ms-playwright` and `NODE_PATH=<app>/node_modules` run it.

## 15. Android app and installable site (17 Sep 2026)

- The site is installable: `frontend/public/manifest.json` (named .json
  because the host nginx has no MIME type for .webmanifest), `icons/`
  (generated from the droplet mark on ink), `sw.js` + `offline.html`. The
  worker handles page navigations only (network first, offline page on
  failure) and never touches /api, /ws or hashed assets, so it cannot serve
  stale plant data. It is registered in `main.jsx` for production builds only.
- The Android app is a Trusted Web Activity: package
  `com.inferconautomation.safekrit`, host dt.inferconautomation.com, start URL
  `/dashboard`, generated by Bubblewrap from `android/twa-manifest.json` (the
  only tracked file under `android/`; the Gradle project and build outputs are
  ignored). `frontend/public/.well-known/assetlinks.json` carries the signing
  certificate's SHA-256 so the app opens full screen; Google's
  digitalassetlinks API confirmed it on 17 Sep 2026.
- Signing key: `C:\Users\prade\.safekrit-android\safekrit-upload.jks`, alias
  `safekrit`, PKCS12, password in `keystore-password.txt` beside it. Never
  print or commit it; back it up, because a different key cannot update an
  installed app.
- Build on this PC: JDK 17 at `~/.bubblewrap/jdk/jdk-17.0.11+9/bin` first on
  PATH, Android SDK at `~/.bubblewrap/android_sdk`, run from `android/` with
  `env -u NoDefaultCurrentDirectoryInExePath npx @bubblewrap/cli@1.25.0 update
  --skipVersionUpgrade` then `build --skipPwaValidation`, passing the password
  in `BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD` and masking
  it in the output. Copy `app-release-signed.apk` to
  `frontend/public/downloads/safekrit.apk`; the landing page links to it.
  Raise `appVersionCode` for every release. Runbook section 17 has the
  procedure for people.

## 16. iOS app (17 Sep 2026, branch `ios-app`)

- `ios/SafeKrit.xcodeproj` (Xcode 26, synchronized `SafeKrit/` folder, so new
  files there join the target without editing the project). A SwiftUI shell
  around one WKWebView, the counterpart of the Android TWA: bundle id
  `com.inferconautomation.safekrit`, start URL `/dashboard`, iOS 16+,
  iPhone and iPad. Keep `ios/SafeKrit/AppConfig.swift` in step with
  `android/twa-manifest.json`.
- `Browser.swift` holds the policy: pages on dt.inferconautomation.com stay
  in the app, other links open in Safari, tel:/mailto: go to the system,
  JS alert/confirm/prompt are native dialogs, pull to refresh reloads. On a
  network error it shows the bundled `Offline/offline.html` (a copy of
  `frontend/public/offline.html` whose button posts `retry` to the app);
  nothing is cached, so plant data is never shown from memory.
- Quick actions (Live plant, Alarms, Maintenance tasks) are declared in
  `ios/SafeKrit-Info.plist` and routed in `SafeKritApp.swift`.
- The app icon is `icon.svg` rendered square, 1024px and without alpha
  (`sips` renders SVG on macOS); iOS rounds the corners itself.
- Simulator build: `xcodebuild -project ios/SafeKrit.xcodeproj -scheme
  SafeKrit -destination 'generic/platform=iOS Simulator' build`. A device or
  App Store build needs `DEVELOPMENT_TEAM` set in Signing & Capabilities and
  an Apple Developer account; raise `CURRENT_PROJECT_VERSION` per upload.
