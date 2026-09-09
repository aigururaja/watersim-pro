# SafeKrit — the three applications: gap map and build plan

> **A** Operations Monitor & Control · **B** Digital Twin · **C** Predictive Maintenance
>
> Basis: a six-subsystem inventory of this codebase (PLC, alarms, live canvas,
> history/reports, RBAC, simulation engine) read against the three application
> briefs. Every "exists" below cites the code; every "missing" names what to
> build on. Nothing in it is from the README.

---

## 1. The decision: one product, three surfaces

The three applications share almost all of their substance. A pump's ISA tag is
the same tag whether an operator watches it, a twin models it, or a CMMS raises
a work order on it. So:

- **One codebase, one database, one login.** Three top-level *surfaces* in the
  navigation, each gated by role capability.
- **A shared core** that every surface reads and that must be built **first**:
  tag registry · historian · notifications · roles · audit.
- **C spans two systems.** The CMMS "hydrogen" project (`../cmms-hydrogen`) is
  an asset register today, not a predictive-maintenance engine; the condition
  data prediction needs can only come from this side. This side owns the
  *boundary* and the data feed — and keeps both off the critical path of A and B.

| Surface | Owns | Reuses |
|---|---|---|
| **A · Ops M&C** | live plant dashboard · alarm config · trends · maintenance-task workflow · control write-back · period reports | PLC layer · alarm engine · symbols/animation · WS transport · RBAC · reports pipeline |
| **B · Digital Twin** | server-side twin loop · model-vs-measured residuals · what-if branching from live state · shadow/commissioning mode · degradation counters | solver · dynamic solver · scenario batch · worker pool · ITC plant model · canvas |
| **C · Predictive Maint.** | outbound event contract · asset/history read API · service auth · inbound work-order status | tag registry · historian · maintenance tasks · notifications |

---

## 2. What already exists — and is production-grade

The inventory rated 104 capabilities. The ones that matter for scoping:

| Area | Exists today | Maturity |
|---|---|---|
| PLC | Modbus TCP (Node, dependency-free) · Simulator · OPC UA + Siemens S7 (Python bridge) · EtherNet/IP Logix (unverified on hardware) · poll loop with quality/backoff · SSRF guard · connection + binding APIs with RBAC, secret masking, audit · `POST …/write` (operator+, **no UI calls it**) | production / working |
| Alarms | HIGH **and** LOW on one rule (`min_value`/`max_value`) · evaluation from **both** simulation runs and live PLC samples · event state machine active→cleared, dedupe on re-breach · ack (operator+, audited) · org history, CSV, PDF · WS fan-out to the flowsheet room · canvas rings and chips · target validation derived from the canvas (no free-text targets) | production |
| Live canvas | `liveStore` frame with referential stability · 35 symbol types with **value-driven** animation and explicit refusals · motion gating ("values always, motion only live") · WS rooms per flowsheet · a browser-side twin loop (PLC → params → 800 ms re-simulate) | production |
| History | simulation runs (cursor-paged) · saved reports · PDF/Excel via hardened Python runner · 24 h dynamic series **per run** · alarm event history | production / working |
| RBAC | linear `viewer < operator < engineer < admin`, fail-closed · JWT + rotating refresh cookie · audit log, 37 call sites (**write-only**, no API) · `project_members` table exists but is dormant | production |
| Engine | steady-state solver (recycle-iterating, mass-honest) · pseudo-transient dynamic · batch scenarios · worker pool with cap and timeout · ITC reference plant with ISA tags, I/O schedule, control narrative | production / working |

---

## 3. Gap map

Status: **exists** · **partial** · **missing** · **external**. Size: S ≤ 2 days · M ≤ 1 week · L 2–3 weeks · XL 4+ weeks. "Build on" is the code it must extend, not replace.

### A · Operations Monitor & Control

| Requirement | Status | Detail | Size | Build on |
|---|---|---|---|---|
| Real-time monitoring against the PLC's ISA tags | **partial** | Bindings key on `(node_id, param_key)` + a driver address. There is **no first-class tag entity**: nothing to name `RFP-FT-201` as a thing that alarms, trends and tasks all reference. The ITC schedule has 339 such tags but only as a static template. | M | `plc_bindings`, `ioSchedule.buildTagList()` |
| PLC configuration for all PLC types | **partial** | Four real protocols + simulator, descriptor-driven UI. Missing: Mitsubishi (MC), Omron (FINS), Modbus RTU/serial, DNP3/IEC 60870; EtherNet/IP not proven on hardware. | XL total; **M per protocol** | `plc/registry.js` driver contract, Python bridge |
| Live dashboard — realistic animations, live status and values | **partial** | Animation exists only **inside the flowsheet canvas**, and PLC values reach it only by re-running the simulation. No plant-wide dashboard view; no tiles/gauges; WS rooms are per-flowsheet, so no plant-wide socket. | L | `liveStore.setFrame`, symbol registry, `wsServer` rooms |
| Alarm config per parameter, HIGH and LOW | **partial** | Both limits exist but on **one rule with one severity**; `uq_alarm_rules_target` forbids a second rule per target, so HIGH-critical + LOW-warning is impossible. No comms-loss / stale-quality alarm. Single-active-per-rule is SELECT-then-INSERT with no transaction. | M | `008_alarms.js`, `alarms/evaluator.js` |
| Trends and historical reports | **missing** | **No historian.** The poller overwrites `last_value` and discards the sample. No time-series table, no retention, no rollups, no trend API, no time-axis chart. Every report builder takes a simulation run, not a period. | L | `plc/poller.js`, `reports/pySpawn.js`, `LiveChartsDock` |
| Alarm → maintenance task → engineer → manager approval/ack | **missing** | No task entity, no assignment, no approval state machine, **no `manager` role**. `alarm_events` has ack columns only. | XL | `alarm_events.acknowledged_*`, `auditLog`, RBAC hierarchy |
| Notifications — email and WhatsApp | **missing** | No transport of any kind: no mail/SMS/webhook dependency, no outbox, no phone column on `users`. The only fan-out is the WS room to browsers currently open. | L | `wsServer.broadcastToRoom` (as the third channel) |
| Roles and responsibilities per role | **partial** | One org-wide role gates everything. No `manager`, no capability vocabulary, no per-application access, no assignment scoping (`project_members` dormant). Role is re-checked only at `/auth/refresh` — a demoted user keeps rights for up to 15 min. | M | `middleware/auth.js`, `001` enum, `AdminPage` |
| Control from the dashboard | **partial** | `POST …/write` exists and is authorised, but no UI calls it; canvas toggles change *model* params, not the PLC. | M | `plcBindings.js` write, `PLCLiveChip` |
| Audit / "who did what" reporting | **partial** | Writer only; no read API, no page, no CSV; poller/evaluator actions cannot be audited (need an Express `req`). | S | `utils/audit.js` |

### B · Digital Twin

| Requirement | Status | Detail | Size | Build on |
|---|---|---|---|---|
| Live virtual model updating continuously from PLC data | **partial** | The loop exists — **in the browser**, only while a tab has Live mode on. No server-side twin: nothing solves when nobody is watching, nothing persists, no helper merges `plc_bindings.last_value` into `nodeParams` on the server. | L | `runner.js` pool, `simulate.js` preview path, `applyPlcToParams` |
| Model vs measured (the core of a twin) | **missing** | No comparison anywhere. The instrument model reports a *modelled* reading; the PLC reports a *measured* one; nothing subtracts them. | L | `models/instrument.js` `reading`, tag registry |
| What-if scenarios without touching equipment | **partial** | Batch scenarios run only against the saved canvas and cannot be seeded from live state; previews are never persisted; a `write` binding always hits the real device. | M | `POST /simulate/batch`, `plcApply` toggle |
| Virtual commissioning | **missing** | The simulator driver (sine/random/step) is not driven by the process model, so a control sequence cannot be exercised against a responding plant. | XL | `drivers/simulator.js`, `narrative.js` timelines, SBR model |
| Live levels / batch phases / inventories | **missing** | The steady-state solver has no accumulation term; the canvas *deliberately refuses* to draw tank levels. A twin with a clock needs a true transient solver. | XL | `dynamicSolver.js`, `equalisationTank.js` |
| Predicts maintenance from degradation | **missing** | No run-hours, starts, trips, or per-equipment KPIs; no sample history to learn from. | L (counters) / XL (models) | historian, `XS`/`XA` transitions |

### C · Predictive Maintenance

The CMMS "hydrogen" project is now beside this repo (`../cmms-hydrogen`), so
this row is no longer blind. Read against its code and its database:

| | |
|---|---|
| **What it is** | FastAPI 0.115 + SQLAlchemy 2, SQLite by default (`Database_URL`), JWT HS256 15-min tokens (`python-jose`), OTP-by-email login, roles `SUPER_ADMIN / ADMIN / MANAGER / USER` |
| **What it has** | An **asset register**: `assets` (`asset_code` is the natural key, `custom_fields` JSON), `sub_assets`, lookups (status, type, make, model, manufacturer, vendor), parts inventory (`products → parts → subparts`), departments and stores. Guarded CRUD under `/api/v1/{assets,subassets,inventory,departments,users}`. |
| **What it does not have** | **No work orders. No maintenance schedules. No condition or history data. No predictive logic.** Every table is empty except one user and one department. Two commits, both "Initial commit", 2025-11-10. |

| Requirement | Status | Detail | Size | Build on |
|---|---|---|---|---|
| "Get predictive maintenance from the CMMS" | **missing — on both sides** | There is nothing to get. The CMMS is an asset register; the *inputs* to predictive maintenance (run-hours, starts, trips, residuals, alarm history) can only come from **here** (Phase 1 historian, Phase 4 counters and residuals). The CMMS needs work-order tables before it can hold the *outputs*. | L here · M there | historian, `equipment_counters`, `twin_residuals`, `maintenance_tasks` |
| Shared asset identity | **partial** | Both sides have a natural key — the CMMS's `asset_code`, this side's ISA tag. Map them 1:1 (`RFP-P-201` *is* the asset code) and carry the SafeKrit tag id in the CMMS's existing `custom_fields`, so neither schema changes. | S | tag registry (Phase 0), `assets.custom_fields` |
| Service-to-service auth | **missing** | Both sides issue only 15-minute human JWTs, with different secrets. Neither has API keys. | S each side | `api_keys` (Phase 5), CMMS `require_role` |
| Events across the boundary | **missing** | No webhook, queue or outbox on either side; the CMMS has an SMTP client for OTP only. | M | Phase 2 outbox |

---

## 4. Phases — ordered by dependency, then demo value

Every phase leaves the suite green and ships behind the existing migration
runner. Sizes are effort, not calendar.

### Phase 0 — Foundations (M) · *everything else depends on this*

**Status: DONE (7 Sep 2026).** Migrations `009_manager_role`, `010_tag_registry`; `backend/src/auth/roles.js` (+ client mirror and parity test); `backend/src/tags/isa.js` validator; `GET/POST/PATCH/DELETE /api/v1/tags`, `POST /tags/seed/itc-stp`; `GET /api/v1/audit`, `/audit/export.csv`, `/audit/actions`; per-request role refresh in `middleware/auth.js` (`ROLE_CACHE_TTL_MS`, `ROLE_LOOKUP_TIMEOUT_MS`); `auditSystem()` for poller/evaluator rows; Audit page at `/audit`; three-surface shell in `AppLayout.jsx`; seed adds `manager@itc-stp.local` and all 339 ITC signals to the registry. Deviations from the plan below: the capability map covers every verb, not only the new ones; deactivation is refused at the middleware (401) rather than only by the last-admin guard; a deleted user's token stays usable for up to one cache TTL (fail-open on a missing row — see README § Roles). Trends, Scenarios and Tasks are placed in the nav pointing at their nearest existing page, badged with the phase that delivers them.

**Goal:** the things every surface needs and nothing can fake: a tag, a manager, an audit trail you can read.

Deliverables
- **Tag registry.** `tags` table — one row per ISA loop tag (`RFP-FT-201`) with `organisation_id`, `flowsheet_id`, `node_id`, `param_key`, `kind`, `area`, `eng_unit`, `range_min/max`, `description`. `plc_bindings.tag_id` (nullable FK, backfilled). Seeded from the ITC I/O schedule (339 signals → 62 device tags). Alarm rules and events gain `tag_id`. `isaTags.test.js` becomes the registry's validator.
- **`manager` role.** Enum, `ROLE_HIERARCHY`, `VALID_ROLES`, frontend `ROLES` — all four in one migration (the inventory names this as the thing that breaks invites when out of sync). Position: `viewer < operator < engineer < manager < admin`. Plus a **capability map** for the new verbs only (`task.approve`, `control.write`, `twin.commission`, `cmms.read`) so non-linear rules have a home without touching `requireRole`.
- **Per-request role check.** Re-read `role`/`is_active` on authenticated requests (cached 30 s) so a demotion takes effect before the next refresh.
- **Audit read API.** `GET /audit` (admin), filters, CSV; `auditLog` accepts a system actor so the poller and evaluator can write.
- **Application shell.** Three surfaces in the nav, gated by capability; per-user default surface.

Tables `tags` · Endpoints `GET/POST/PATCH /tags`, `GET /tags/:tag`, `GET /audit`, `GET /audit.csv`
Risks: the linear hierarchy makes `manager ⊇ engineer` — a manager can edit process models. If that is wrong for ITC, the capability map has to carry a *deny*, which is more work. **Open question 5.**

### Phase 1 — Historian and trends (L) · *the data every later phase learns from*

**Status: DONE (7 Sep 2026).** Migration `011_historian`: `tag_samples` (monthly RANGE partitions, `ensure_tag_sample_partitions()`), `tag_samples_1m` / `tag_samples_1h`, `historian_jobs`; `backend/src/historian/` (batched write path from the poller, rollup job with watermarks, retention by dropping partitions, registry linkage) and `historian/query.js` (auto resolution, raw tail past the watermark, wide CSV); `GET /tags/history[.csv]`, `GET /tags/:id/history[.csv]`, `GET /tags/:id/latest`, binding state on `GET /tags`; `POST /reports/period` (CSV in Node, PDF/Excel via `period_report.py`); Trends page at `/trends` with pin-to-dashboard; `alarm_rules.kind` (high / low / range / quality) with the unique index on (target, kind), `stale_after_s`, the comms-loss sweep (`alarms/qualitySweep.js`) and the one-active-event-per-rule partial unique index; the instrument model's `measured` parameter (measured beats modelled, residual reported). The ITC seed now binds the built-in simulator to 28 points so history fills from the first poll, and adds a comms-loss rule on RFP-FT-201. Deviations: the alarm dialog keeps one pair of limit boxes — the server settles high/low/range from which are filled — plus a "comms loss" kind; there is no separate `agg=` on the JSON API (every point carries avg/min/max/last), only on the CSV. Retention env: `HISTORIAN_RAW_RETENTION_DAYS` (30), `HISTORIAN_1M_RETENTION_DAYS` (730), `HISTORIAN_1H_RETENTION_DAYS` (3650). Postgres ≥ 14 is now required (`date_bin`); the compose file pins 16.

**Goal:** never discard a sample again.

Deliverables
- `tag_samples (tag_id, ts, value, quality)` — **native Postgres partitioning by month**, BRIN on `ts`; the poller appends in one batched insert per tick.
- Rollups `tag_samples_1m`, `tag_samples_1h` (avg/min/max/last/count) by an in-process job on the pattern of the stale-run reaper. Retention via `RAW_RETENTION_DAYS`, `ROLLUP_RETENTION_DAYS`.
- `GET /tags/:id/history?from&to&bucket=raw|1m|1h&agg=` — server-side bucketing, never raw rows to the browser for a 30-day window.
- **Trends page** — multi-tag time-axis chart (recharts, already a dependency), range picker, CSV export, pin-to-dashboard.
- **Comms-loss alarm** — rule type `quality` (stale > N s, bad quality) in the evaluator; the only alarm that fires when the PLC *stops* talking.
- Alarm hardening from the gap map: one rule per **limit** (drop the target-uniqueness to `(target, kind)` so HIGH-critical and LOW-warning coexist); wrap single-active-per-rule in a transaction.
- **Period reports** — a report builder that takes `(tags[], from, to)` instead of a run, into the existing PDF/Excel Python runner.

Tables `tag_samples` (partitioned), `tag_samples_1m`, `tag_samples_1h` · Endpoints history + period-report exports
Risks: write amplification on a 1 s poll across 339 tags is ~30 M rows/day at raw resolution — the rollup job and retention are not optional. Partition creation must be automated ahead of time.

### Phase 2 — Maintenance workflow and notifications (XL) · *the demo centrepiece for A*

**Status: DONE (7 Sep 2026).** Migration `012_maintenance`: `maintenance_tasks` (one per alarm event, `WO-00001` numbering), `task_transitions`, `task_comments`, `notification_channels`, `notification_subscriptions`, `notification_outbox`, `users.phone_e164`, and the per-rule policy columns on `alarm_rules` (`create_task`, `task_assignee_role`, `task_requires_approval`, `task_due_within_h`, `task_priority`; existing critical rules switched on). `backend/src/maintenance/tasks.js` is the state machine — `transition()` is the only write path, in one transaction with the transitions row and the audit row; least-loaded auto-assignment by role; manager acknowledgement recorded separately from approval; no-approval rules close on completion. The evaluator raises the task and the `alarm.raised` / `alarm.cleared` notifications on the state machine's transitions; `POST /alarms/events/:id/task` is the same path taken by a person. `backend/src/notifications/`: `emit()` resolves (role | user) × event × severity policy to outbox rows, one per person per channel, deduplicated; the worker drains with exponential backoff, dead-letters permanent errors, and a manager can retry; adapters: SMTP via nodemailer, WhatsApp via Twilio over fetch, plus the flowsheet WebSocket room; `NOTIFICATIONS_DRY_RUN` for demos. APIs: `/api/v1/tasks` (list, detail with allowed actions, create, edit, transition, comments, assignees) and `/api/v1/notifications` (me, channels, test, events, subscriptions, outbox, retry). UI: Tasks board at `/tasks` with the detail panel, "Task" on every alarm event, the task policy in the alarm rule dialog, the Notifications tab in Settings. The ITC seed sets the policy on every critical and warning rule, gives the manager/engineer/operator phone numbers, and installs seven policy rows. Answers taken for open questions 3 and 8: critical rules auto-create by default (warnings opt-in, all editable per rule); acknowledgement and approval are separate acts, both recorded. Not done: an approved SafeKrit template on the business account (external; `WHATSAPP_TEMPLATES` maps it when it is). Since 7 Sep 2026 (evening) WhatsApp goes through Meta's Cloud API on the CRM's business account (Twilio kept as an option), Meta's delivery receipts land on the outbox row through `POST /api/v1/webhooks/whatsapp`, and a reply from the phone marks the channel verified.

**Goal:** an alarm becomes a task, a task reaches a person, and a manager signs it off — with the trail to prove it.

Deliverables
- `maintenance_tasks` — `source_event_id` → `alarm_events`, `tag_id`, `title`, `priority`, `state`, `assigned_to`, `due_at`, `approved_by/at`, `acknowledged_by/at`, `closed_at`. `task_transitions` records every state change with actor. `task_comments`.
- **State machine:** `open → assigned → in_progress → completed → approved | rejected → in_progress`. Critical alarms additionally require manager **acknowledgement** at creation. Transitions are the only write path and every one is audited.
- **Per-rule policy:** `create_task`, `assignee_role`, `requires_approval`, `due_within_h` on `alarm_rules` — so the evaluator raises the task, not a person.
- **Notifications.** `notification_channels (user_id, channel, address, verified)`, `notification_subscriptions (role|user × event_type × min_severity)`, `notification_outbox (channel, to, template, payload, state, attempts, next_attempt_at, sent_at, error)`. An in-process worker with exponential backoff drains it. Adapter interface: **email via SMTP (nodemailer)**, **WhatsApp via Twilio's WhatsApp API** (Meta Cloud API as the alternative — see open question 2), and the existing WS room as the third channel. `users.phone_e164`.
- UI: Tasks board and detail; approve/reject/ack for managers; "Create task" on an alarm event; notification preferences under Settings.

Tables `maintenance_tasks`, `task_transitions`, `task_comments`, `notification_channels`, `notification_subscriptions`, `notification_outbox` · Endpoints `POST /alarms/events/:id/task`, `GET/POST/PATCH /tasks`, `POST /tasks/:id/transition`, `GET/PUT /me/notifications`, `POST /notifications/test`
Risks: WhatsApp Business verification has a lead time measured in weeks and needs approved message templates — start it in Phase 0. Email deliverability needs SPF/DKIM on the sending domain.

### Phase 3 — Live operations dashboard (L)

**Status: DONE (7 Sep 2026).** Organisation-wide WebSocket room at `/ws/org` (listen-only; `broadcastToOrg()` in `collab/wsServer.js`) fed by the poller (`plc:update`, now carrying `tagId` and `flowsheetId`), the evaluator (`alarm:event`), the task state machine (`task:event`) and the notification fan-out (`notification`); the flowsheet rooms are untouched. `GET /api/v1/live/snapshot` (`routes/live.js`) assembles areas, bound tags with last values, equipment cards from XS/XA/ZSO/ZSC contacts with their run-command binding, active alarms with counts, per-connection comms health and task counts. The live plant screen at `/live` draws each area with gauges for analogue points and the canvas's own equipment symbols in their MEASURED state (`components/live/EquipmentCard.jsx`: run/stop and open/closed drive the symbol state directly, rates stay at the symbol's full duty because no speed feedback exists — the "measured" source is printed on the card), an alarm strip with acknowledgement, a comms bar, task counts, and pinned trends from the Trends page. Control write-back: Start/Stop and Open/Close go through the existing audited `POST …/plc-bindings/:id/write` after `components/live/ControlDialog.jsx` (capability `control.write`, operator and above). The ITC seed now binds each drive's run status and run command to the same simulator register, so a Start from the screen reads back as running on the next poll. Deviations: the room is per organisation rather than per "plant" (the plant is the organisation's bound tags); two-person confirmation for critical tags is a single explicit acknowledgement in the dialog (the audit row names the person).

**Goal:** the screen on the wall.

Deliverables
- **Plant-wide WS room** (`/ws/plants/:id`) fanning out `plc:update` and `alarm:event` for every bound tag; the flowsheet rooms stay for the canvas.
- **Dashboard page:** tiles per process area, gauges per tag, equipment cards reusing the existing symbols, alarm strip, comms-status bar, pinned trends.
- **PLC-direct animation source.** Run/stop and open/closed from `XS`/`ZSO`/`ZSC` are *measured states* and may drive symbol **state** directly, without a simulation round-trip. **Rates** still need a computed metric — the value-driven rules and every refusal in `symbolsLane*.test.jsx` stand.
- **Control write-back UI:** start/stop and open/close from the card, confirm dialog, capability `control.write`, audited, optional two-person confirm for tags flagged critical.

Endpoints plant room upgrade path, `GET /plants/:id/live` snapshot · Risks: a state-driven symbol and a simulation-driven symbol on the same sheet must agree on which source wins — settle it as "measured beats modelled" and show the source on the card.

### Phase 4 — Digital twin (XL)

**Status: DONE (7 Sep 2026)** — except the deferred transient solver, as planned. Migration `013_twin`: `twin_config`, `twin_state`, `twin_residuals`, `twin_residual_stats`, `equipment_counters`, `plc_connections.mode` (live | shadow), alarm kind `drift`. `backend/src/twin/index.js` is the server loop: on each twin's cadence it merges every good, recent PLC sample into the node parameters (measured beats modelled), solves through the worker pool, subtracts the model's own instrument reading from the transmitter's, keeps a Welford spread per instrument and judges each residual's z against it, raises `drift` rules through the ordinary alarm state machine (so drift is acknowledged, tasked and notified like any alarm), persists a compact `twin_state` and broadcasts `twin:state`. `twin/counters.js` derives run hours, starts and trips per drive per day from XS/XA transitions in the historian. `twin/shadow.js` + `plc_connections.mode`: in shadow, the poller reads and the write route writes the simulator's register namespace for that connection, and a command write is reflected onto the loop's XS / ZSO / ZSC contacts — the first "plant that responds"; entering shadow is an engineer's act (`twin.commission`), leaving it a manager's (`task.approve`), both audited and broadcast (`twin:mode`). `twin/scripts.js` turns the ITC control narrative's sequences into commissioning scripts that play (at a chosen speed-up) only against shadow connections, broadcasting `twin:script`. API `/api/v1/twin` (list, detail, configure, solve, residuals, scenarios, counters, scripts, runs, connection mode); what-if scenarios are seeded from the twin's live parameters and never persisted. Twin page at `/twin`. The ITC seed enables the twin on the plant flowsheet at 30 s with a drift rule on RFP-FT-201. Deferred, as the plan says: a true transient solver with accumulation (live tank levels, batch phases) — the canvas still refuses to draw levels, and the simulator's response to a command is a reflection, not a process model.

**Goal:** the model runs beside the plant, on the server, and says where they disagree.

Deliverables
- **Server twin loop.** `twin_config (flowsheet_id, enabled, cadence_s)`; a service that merges tag values (or 1-minute rollups) into `nodeParams`, solves through the existing worker pool on the cadence, persists a compact `twin_state`, broadcasts. It runs whether or not a browser is open.
- **Residuals.** `twin_residuals (tag_id, ts, modelled, measured, residual, z)` for every instrument tag; **drift alarms** on `|z|`. This is the twin's actual product.
- **What-if from live.** `POST /twin/:flowsheetId/scenarios` seeded from the current twin state; compare against the live baseline; never persisted as a run unless asked.
- **Shadow / commissioning mode.** `plc_connections.mode: live | shadow` — in shadow, every write routes to the simulator driver, and the simulator is **driven by the process model** so a sequence gets a plant that responds. The ITC control narrative timelines (`narrative.timeline`) become the first commissioning scripts.
- **Degradation counters.** `equipment_counters (tag_id, day, run_hours, starts, trips)` derived from `XS`/`XA` transitions in the historian — the feed Predictive Maintenance needs.
- *Deferred:* a true transient solver with accumulation (live tank levels, batch phases). The canvas's refusal to draw levels is correct until that exists, and it is a separate, XL piece of work.

Tables `twin_config`, `twin_state`, `twin_residuals`, `equipment_counters` · Endpoints `GET/PUT /twin/:flowsheetId`, `GET /twin/:flowsheetId/residuals`, `POST /twin/:flowsheetId/scenarios`
Risks: residual thresholds need real plant data to tune — expect false drift alarms for the first weeks. Shadow mode must be impossible to leave accidentally: a banner, an audit entry, and a manager capability to switch back.

### Phase 5 — CMMS boundary (M–L) · *now against a known system*

**Status: DONE (7 Sep 2026), both halves.** *This side* — migration `014_cmms`: `api_keys` (SHA-256 of a `wsk_<prefix>_<secret>` key shown once, scoped `assets:read`, `history:read`, `counters:read`, `events:read`, `workorders:write`), `webhook_endpoints` (HMAC secret shown once, event-type subscriptions, delivery health), `maintenance_tasks.external_system/external_ref`. `middleware/serviceAuth.js` (constant-time key check, synthetic `service` principal that never gains a person's capabilities). Read API `/api/v1/assets` (loops as assets, units as sub-assets, points with live state, history, counters, events, keyset-paged, `apiVersion`). Inbound `/api/v1/cmms/work-orders/:externalId/status` turns a work-order status into a task transition by the system actor `cmms` (closed → approved). Outbound: every emitted event is queued to matching webhooks on the Phase 2 outbox and delivered by `adapters/webhook.js` with `X-WaterSim-Signature` (HMAC-SHA256 over `timestamp.body`), retried, dead-lettered on refusal; loopback/private URLs refused unless `WEBHOOK_ALLOW_LOCAL_HOSTS`. `equipment.counters.daily` is emitted once a day per organisation. Admin API and Settings → Integrations tab (keys, webhooks, test, rotate, deliveries). `scripts/sync-cmms-assets.js` seeds the CMMS register from the tag registry. *CMMS side* (`../cmms-hydrogen`, uncommitted): `work_orders` and `maintenance_plans` tables, `X-API-Key` guard (`WATERSIM_API_KEYS`), `POST /api/v1/integrations/watersim/webhook` (signature check, `task.created` → work order, `task.approved/cancelled` → close/cancel, daily counters onto `assets.custom_fields`), `POST /api/v1/integrations/assets/upsert`, and `PATCH /api/v1/work-orders/{id}/status` reporting back to SafeKrit. As the plan says, predictive maintenance itself is a later product on top of `equipment_counters`, `twin_residuals` and the CMMS's work-order history; both feeds now exist. Open: who owns the CMMS deployment, and whether it moves to the same Postgres (open question 6).

The CMMS is an asset register with no maintenance model yet, so this phase has a
half on each side. **This side** exports the condition data predictive
maintenance needs; **the CMMS side** gains the work-order tables to receive it.
Neither is on the other's critical path: Phases 0–4 stand without the CMMS, and
the CMMS keeps working as a register without us.

Deliverables
- **Service auth.** `api_keys (org, name, hash, scopes[], expires_at)`, separate JWT audience `watersim-service`; keys never displayed twice.
- **Outbound events.** `webhook_endpoints (org, url, secret, event_types[])` draining through the Phase-2 outbox with HMAC signatures: `alarm.raised/cleared`, `task.created/transitioned`, `twin.drift`, `equipment.counters.daily`.
- **Read API.** `GET /assets` (tag registry with equipment metadata), `GET /assets/:tag/history`, `GET /assets/:tag/counters`, `GET /assets/:tag/events` — all keyset-paged, all versioned.
- **Inbound.** `POST /cmms/work-orders/:externalId/status` → task transition, so a work order closed in the CMMS closes the task here.
- **Asset identity = ISA tag = `asset_code`.** One row in the CMMS's `assets` per equipment tag (`RFP-P-201`), sub-assets for units (`/1`, `/2`); the SafeKrit `tag_id` goes in `assets.custom_fields.watersim_tag_id`. A one-off sync script seeds the CMMS from the tag registry — its lookup tables (type, make, model, vendor) are exactly the proposal's equipment schedule (Johnson, Grundfos, Beta, Milton Roy, Hiller).
- **CMMS side (their repo):** `work_orders` (asset_id, source, external_ref → our task id, status, assigned_to, due, closed), `maintenance_plans`, and an API-key guard beside `require_role`. `POST /api/v1/work-orders` inbound from our outbox; `PATCH …/status` outbound to our `/cmms/work-orders/:externalId/status`. Two-way, both authenticated by key.
- **Predictive maintenance itself** is a *later* product on top of both: it consumes `equipment_counters` and `twin_residuals` (Phase 4) plus work-order history (CMMS). It should not be promised until Phase 4 has produced a few weeks of real data to model.

---

### Where this leaves the three applications (7 Sep 2026)

| Application | Delivered | Not yet |
|---|---|---|
| **A · Operations Monitor & Control** | tag registry, historian and trends, HIGH/LOW/range/comms-loss alarms, alarm → task → approval with manager acknowledgement, email/WhatsApp/in-app notifications, roles and audit, live plant screen with measured symbols and control write-back | Mitsubishi / Omron / DNP3 drivers; MQTT; two-person control confirmation |
| **B · Digital Twin** | server twin loop, model-vs-measured residuals with drift alarms, what-if from the live state, shadow mode with a responding plant, commissioning scripts from the narrative, degradation counters | a transient solver with accumulation (live levels, batch phases) |
| **C · Predictive Maintenance** | the data feeds (counters, residuals, alarm and task history), the asset identity, the signed event boundary, the CMMS's work-order model and run-hour plans | the predictive models themselves, which need weeks of real plant data |

**A dashboard per role (7 Sep 2026).** `GET /dashboard` (`backend/src/routes/dashboard.js`) assembles the home screen for the role that logged in — viewer, operator, engineer, manager, admin each get their own ordered `sections`, drawn by `frontend/src/components/dashboard/`. The plant strip (PLC points, drives, valves, alarms, tasks) is common; what follows is the role's work: alarms and drives and the tasks on their desk for an operator; the twin, PLC health, run hours, projects and runs for an engineer; approvals, alarm load and time-to-acknowledge, noisy rules, deliveries and the team for a manager; users, integrations, deliveries, PLC, twin, audit and system health for an admin.

**Projects are split by surface (7 Sep 2026, after the phases).** A project now has a `kind`: `monitoring` (the plant as built and wired — flowsheet, tags, PLC points; created under Operations → Projects, opened at `/monitoring/projects/…`, watched on the Live plant screen) or `twin` (a model to run beside it, or a design study; created under Digital Twin → Projects at `/projects/…`). A twin is **imported from live** (`POST /projects/:id/import-to-twin`): the flowsheets are copied and each keeps `source_flowsheet_id`, so the twin loop reads the plant's PLC measurements, drift rules and instrument tags through that link and never carries bindings of its own. The ITC seed creates both — *ITC STP — Monitoring & Control* and, imported from it, *ITC STP — Digital twin*, which is where the twin config now lives (migration 015). The canvas editor draws the same machines and pipes as the Live plant (the `Realistic` style, `components/canvas/MimicNode.jsx` and `PipeEdge.jsx`, driven by the sheet's control params and simulation results); the drafting symbols remain one click away (`Drawing`).

## 5. Roles and responsibilities

| | viewer | operator | engineer | **manager** | admin | service key |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View dashboards, trends, tasks, twin | ✓ | ✓ | ✓ | ✓ | ✓ | scoped |
| Acknowledge alarms | | ✓ | ✓ | ✓ | ✓ | |
| Control write (start/stop, open/close) | | ✓ confirm | ✓ | ✓ | ✓ | |
| Create task from alarm | | ✓ | ✓ | ✓ | ✓ | |
| Be assigned / complete a task | | | ✓ | ✓ | ✓ | |
| **Approve / reject task · ack critical** | | | | **✓** | ✓ | |
| Edit flowsheets, alarm rules, tags, bindings | | | ✓ | ✓* | ✓ | |
| Run what-if scenarios | | ✓ | ✓ | ✓ | ✓ | |
| Enter / leave commissioning (shadow) mode | | | ✓ | ✓ | ✓ | |
| Notification policy for the org | | | | ✓ | ✓ | |
| PLC connections, users, API keys | | | | | ✓ | |
| CMMS read / work-order status | | | | | | ✓ |

\* by hierarchy inheritance — see open question 5.

---

## 6. What must not be rebuilt

The inventory named these as load-bearing; a phase that breaks one is rejected.

- **Value-driven animation.** A motion *rate* is driven only by a plant-computed metric; refusals (tank level, EQ level, digester gasholder) are asserted as *absence* in `symbolsLane*.test.jsx`.
- **`liveStore` contracts.** Referential stability of snapshots; `setFrame` is the only write path; nothing from the live layer is ever written into `node.data`.
- **Alarm target validation.** No free-text target can reach `POST /alarm-rules` (`alarmRuleDialog.test.jsx`); targets derive from the canvas.
- **Evaluator hot path never throws** — `simulate.js` and `poller.js` depend on it.
- **RBAC matrix** in `rbac.test.js`, and the four role lists that must move together.
- **Solver invariants** — mass balance, recycle convergence, `preview:true` persists nothing, `MAX_NODES` rejection before spawning a worker.
- **Driver contract** in `plc/README.md` and `err.connectionLost` semantics.
- **Root-context Docker builds and the single lockfile.**

---

## 7. Open questions — answers change what gets built

1. **Which PLCs are actually on the ITC site?** The proposal's architecture is Siemens (S7 is working) or IOT nodes (protocol unstated). EtherNet/IP is unproven on hardware. Every additional vendor is ~M.
2. ~~**WhatsApp provider.** Twilio WhatsApp API is fastest to integrate; Meta Cloud API is cheaper at volume. Both need Business verification and pre-approved templates — **weeks of lead time; start now.**~~ **Answered (7 Sep 2026):** Meta's Cloud API on the WhatsApp Business Account Infercon already registered for the enterprise CRM — same phone number id, token and variable names, no second verification. Twilio remains as `WHATSAPP_PROVIDER=twilio`. Still external: an approved two-parameter UTILITY template (`safekrit_alert`) before alarms reach anyone outside a 24-hour reply window.
3. **Which alarms auto-create tasks, and which severities need manager approval?** Everything, or critical only? This sets the per-rule policy defaults.
4. **History retention.** Raw for 30 days and 1-minute rollups for 2 years is the usual answer; the disk sizing in the deploy runbook changes with it.
5. **May a manager edit process models?** The linear hierarchy says yes. If managers must be *barred* from engineering edits, Phase 0 needs deny-capabilities.
6. ~~The CMMS hydrogen project — access.~~ **Answered:** it is at `../cmms-hydrogen`. It is an asset register with no maintenance model; Phase 5 is rewritten above. The open part is *ownership*: who adds work orders to the CMMS, and does it run beside this stack (same Postgres) or stay separate on SQLite?
7. **What must be demonstrable, and when?** Phases 0–2 are the Ops M&C story; if the next demo is soon, Phase 3's dashboard is the most visible thing to pull forward.
8. **Is manager acknowledgement a separate step from approval?** (approve → engineer works → manager acknowledges completion) or the same act? This changes the task state machine's transitions.
9. **May operators write to physical PLC tags from the dashboard at all**, or must every control action go through an approved task? This decides whether `control.write` exists below `manager`.
10. **Single backend instance or HA?** The poller and WS rooms are single-instance by design (module-level state). Horizontal scaling means poller ownership and a shared pub/sub — a phase of its own.
11. **Sensors outside the PLC?** If IoT gateways (LoRaWAN / MQTT) are expected, MQTT/Sparkplug becomes the first new driver rather than a stretch item.
12. **Must the ITC SBR/UF sequences be executable in virtual commissioning for the demo**, or is a steady-state twin enough? The first needs the Phase 4 sequence executor; the second does not.

Resolved since the inventory: **tag naming is ISA-5.1 only** — no second convention.

---

## 8. Reconciliation with the independent synthesis

The plan above was written from the six inventories; the workflow's own
synthesizer then produced a second plan blind to this one. They agree on the
shape (one product, three surfaces, shared core first), on the shared core's
five members, on the dependency order, and on keeping the CMMS off the critical
path. Two differences, both adopted here:

- **Granularity.** The synthesizer splits Phase 2 into *field-grade alarm
  semantics* (per-direction severity, HIHI/LOLO, deadband, on-delay, comm-loss)
  and *notifications + tasks*. That split is right — the alarm semantics can
  ship and be demonstrated before a single task exists. Read Phase 1's "alarm
  hardening" line and Phase 2 as separable deliverables.
- **A parallel PLC track.** Protocol coverage ("all types of PLCs") and PLC-layer
  hardening (config encryption at rest, deadband and batch reads, CI coverage for
  the Python bridge) do not depend on Phases 0–4 and should run alongside them,
  paced by open question 1.

Its full output — 25 gap rows, 9 phases, 11 questions and a detailed CMMS
contract — is retained in the session record; nothing in it contradicts a
decision above.

## 9. Sequencing summary

```
0 Foundations   tags · manager role · audit API · app shell        ──┐
1 Historian     samples · rollups · trends · comms-loss · period reports │  A
2 Maintenance   tasks · approvals · email + WhatsApp outbox          │
3 Dashboard     plant-wide live view · PLC-direct state · control   ──┘
4 Digital twin  server loop · residuals · what-if from live · shadow      B
5 CMMS boundary asset_code = ISA tag · keys · webhooks · work orders     C
  PLC track     protocols by site · encryption at rest · bridge CI  (parallel)
```

Phases 0 → 1 → 2 are strictly sequential (each needs the last). 3 needs 0 and 1.
4 needs 1. 5 needs 0, 1, 2. Phases 3 and 4 can run in parallel once 1 lands.
