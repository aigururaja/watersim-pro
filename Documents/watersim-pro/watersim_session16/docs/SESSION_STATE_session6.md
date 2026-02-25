# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Phase 4 — Advanced Process Models
## Current Session: Session 6
## Overall Progress: Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ | Phase 4 ✅ COMPLETE

---

## ✅ Completed Steps

### Sessions 1–5 (see SESSION_STATE_session5.md for full detail)
- Phase 1: Monorepo, DB schema, auth, RBAC, frontend shell, canvas shell
- Phase 2: Simulation engine, RAS recycle fixed-point solver, denitrification (pre-anoxic zone)
- Phase 3: RAS recycle, denitrification, CSV/JSON export, dynamic simulation, flowsheet batch comparison

---

### Session 6 — Phase 4: Advanced Process Models

#### Step 29 — Cost Estimation Model (`backend/src/simulation/costEstimator.js`) ← NEW FILE
- `estimateCosts(simResults, unitCosts)` — estimates annual OPEX from a steady-state simulation result
- **Five cost categories:**
  | Category | Basis |
  |---|---|
  | Energy | O2 demand (kWh/kgO2) from aeration basin metrics + pumping allowance |
  | Chemicals | Coagulant × Q, polymer × WAS flow, disinfectant × Q |
  | Sludge disposal | Biomass production from unit metrics → dry tonnes × tipping fee |
  | Labour | Staff count = max(2, round(Q_MLD / 5)) × salary |
  | Maintenance | 2% of parametric capex estimate |
- `DEFAULT_UNIT_COSTS` — all 13 configurable coefficients exported (electricity, chemical unit prices, etc.)
- Returns: `{ energy, chemicals, sludge, labour, maintenance, total_USD_yr, cost_per_m3_treated_USD, unitCostsUsed }`
- Exported: `estimateCosts`, `DEFAULT_UNIT_COSTS`

#### Step 29 — Simulate Route Updated (`backend/src/routes/simulate.js`) ← UPDATED
- **`POST /simulate` (steady_state)** now:
  - Accepts optional `unitCosts` body field (object, merged over `DEFAULT_UNIT_COSTS`)
  - Calls `estimateCosts()` after solver; result attached as `results.costBreakdown`
  - `results.permitLimitsUsed` also returned (from org template or null)
- **`GET /simulate/default-unit-costs`** ← NEW endpoint: returns `DEFAULT_UNIT_COSTS`
- Permit template loaded from `permit_templates` table for the org; gracefully falls back if table doesn't exist

#### Step 29 — SummaryPanel Updated (`frontend/src/pages/CanvasPage.jsx`) ← UPDATED
- **Cost Estimation Overlay** added to SummaryPanel (rendered when `costBreakdown` present):
  - Two headline KPI cards: Total Annual Cost ($/yr) and Cost per m³ Treated ($/m³)
  - Expandable category breakdown table (Energy / Chemicals / Sludge / Labour / Maintenance)
  - `Show detail / Hide detail` toggle button
  - Energy kWh/yr and staff count shown in footnote

#### Step 30 — EBPR Luxury Uptake Model (`backend/src/simulation/models/aerationBasin.js`) ← UPDATED
- New `ebpr` mode (default `false`) adds an **anaerobic selector** zone before the aerobic zone:
  - **Anaerobic zone**: PAOs consume VFA (fraction of COD), releasing poly-P into solution
    - `VFA_COD_fraction` (default 0.15) → fraction of COD available as VFA
    - Stoichiometric P release: ~0.5 g P per g COD (VFA) consumed
  - **Aerobic zone**: PAOs take up P via luxury uptake (Monod kinetics over HRT × PAO mass)
    - `ebpr_uptake_rate` (g P/g VSS·d, default 0.15)
    - `PAO_fraction` (default 0.30 — fraction of MLVSS that are PAOs)
    - Effluent TP floor at 0.2 mg/L residual
- EBPR metrics added to unit results: `VFA_consumed_mg_L`, `P_released_mg_L`, `P_uptake_mg_L`, `TP_effluent_mg_L`, `X_PAO_mg_L`
- EBPR can be combined with denitrification (anaerobic → anoxic → aerobic)
- New `aerationBasin.js` parameters:
  | Param | Default |
  |---|---|
  | `ebpr` | `false` |
  | `anaerobic_fraction` | 0.20 |
  | `ebpr_uptake_rate` | 0.15 (g P/g VSS·d) |
  | `Y_PAO` | 0.65 |
  | `PAO_fraction` | 0.30 |
  | `VFA_COD_fraction` | 0.15 |
- **Property panel** (CanvasPage) updated with EBPR fields for `activated_sludge` and `membrane_bioreactor` node types

#### Step 31 — Chemical Dosing Node (`backend/src/simulation/models/chemicalDosing.js`) ← NEW FILE
- Standalone unit operation with `solve(inputs, params)` interface
- **Four chemical families:**
  | type | Effect |
  |---|---|
  | `alum` | TP removal (0.23 mg/L TP per mg/L alum) + floc TSS increase |
  | `ferric_chloride` / `fecl3` | TP removal (0.17 mg/L TP per mg/L FeCl3) + heavier floc |
  | `polymer` | No bulk change — floc conditioning only |
  | `naoh` | pH raise (+0.01 per mg/L; or `target_pH` override) |
  | `h2so4` | pH lower (−0.008 per mg/L; or `target_pH` override) |
  | `naocl` / `hypochlorite` | BOD −8%, TSS −2% |
- Metrics: `chemical_type`, `dose_mg_L`, `dose_kg_d`, `sludge_kg_d`, `TP_in_mg_L`, `TP_out_mg_L`, `TP_removal_pct`, `pH_in`, `pH_out`
- `CHEMICAL_COEFFICIENTS` exported for reference/testing
- **Registered in solver** (`solver.js`): `chemical_dosing` key in `MODELS`
- **Palette type mappings** added: `chemical_dosing`, `coagulant_dosing`, `polymer_dosing`, `ph_adjustment`, `chlorination`, `uv_disinfection` → all route to `chemical_dosing`
- **Palette** (`UnitOpPalette.jsx`): new "Chemical Dosing" category with 5 node types
- **Property panel** (`CanvasPage.jsx`): property fields for all 5 chemical dosing node types

#### Step 32 — Permit Templates (`backend/migrations/002_permit_templates.sql` + routes) ← NEW
- **DB migration** `002_permit_templates.sql`:
  - `permit_templates` table: `id`, `organisation_id`, `created_by`, `name`, `description`, `is_active`, `permit_limits` (JSONB), timestamps
  - Index on `(organisation_id, is_active)` for fast active template lookup
  - Trigger for `updated_at`
  - Seeds "Default (US EPA Secondary)" template for `demo-org` (BOD 30, TSS 30, TN 10, TP 1, NH4 5)
- **REST API** `backend/src/routes/permitTemplates.js` ← NEW:
  - `GET    /permit-templates`             — list org templates
  - `POST   /permit-templates`             — create (admin/engineer)
  - `GET    /permit-templates/:id`         — get single
  - `PATCH  /permit-templates/:id`         — update limits/name (admin/engineer)
  - `DELETE /permit-templates/:id`         — delete (admin only)
  - `POST   /permit-templates/:id/activate` — set active for org (admin/engineer)
  - Role enforcement: operators read-only; delete admin-only
  - `sanitizeLimits()` — validates/coerces permit_limits JSONB keys
- **Outlet model** (`models/outlet.js`) ← UPDATED:
  - `permitLimits` param merges over `DEFAULT_LIMITS` (BOD 30, TSS 30, TN 10, TP 1, NH4 5, NO3 null, pH 6–9)
  - All parameters individually nullable (null = not regulated)
  - `limits_applied` included in metrics for transparency
  - Exports `DEFAULT_LIMITS`
- **Solver** (`solver.js`) ← UPDATED:
  - `runSteadyState(canvasData, config)` now accepts `config.permitLimits`
  - Injects `permitLimits` into params for all outlet-type nodes automatically
- **Server** (`server.js`): `GET/POST /api/v1/permit-templates` registered

#### Step 33 — Phase 4 Tests (`backend/src/__tests__/simulation.test.js`) ← UPDATED
New test suites appended (Session 6 section):

**Cost Estimator unit tests (no DB):**
- `DEFAULT_UNIT_COSTS` has expected keys
- `estimateCosts` returns positive total for a linear flowsheet
- All 5 categories present in result
- Energy cost scales with O2 demand (larger plant → higher cost)
- Custom `unitCosts` override defaults
- Labour staff count scales with Q

**EBPR model unit tests (no DB):**
- EBPR removes significantly more TP than conventional
- EBPR metrics present when enabled (VFA_consumed, P_released, P_uptake, TP_effluent)
- EBPR off by default
- Higher `PAO_fraction` yields lower effluent TP
- EBPR + denitrification combined mode works

**Chemical Dosing model unit tests (no DB):**
- Alum dosing removes TP
- FeCl3 produces heavier floc (higher TSS) than alum
- NaOH raises pH
- H₂SO₄ lowers pH
- `target_pH` override bypasses dose-based pH
- NaOCl reduces BOD
- Polymer has no bulk stream change
- `dose_kg_d` scales with Q

**Permit Templates API integration tests:**
- GET / returns 200 for authenticated user
- POST creates template (admin ✓, engineer ✓, operator 403)
- GET /:id returns template
- PATCH updates permit_limits
- POST /:id/activate sets is_active
- DELETE removes template (admin ✓, engineer 403)
- DELETE non-existent 404

**Outlet model permit limits unit tests (no DB):**
- `DEFAULT_LIMITS` keys present
- Flags violations with default limits
- Compliant with clean effluent
- Custom limits override defaults
- NO3 limit applied when configured
- `limits_applied` in metrics

**Simulate API — cost breakdown integration tests:**
- steady_state returns `costBreakdown` in results
- Custom `unitCosts` reflected in cost model (expensive > cheap energy)
- GET /default-unit-costs returns default coefficients
- Dynamic mode does NOT include costBreakdown (steady_state only)

**JSON export version test:**
- JSON export still at `export_version: '1.1'`

**Test helpers** (`helpers.js`) ← UPDATED:
- Added: `createTestUser(email, password, role?)`, `loginAs(user)`, `makeProject(agent, name)`, `makeFlowsheet(agent, projectId, name, canvasData)`
- These were referenced since Session 5 but not yet implemented in helpers.js

---

## 🔲 Suggested Phase 5 Items

1. **Permit Templates UI** — frontend page for admins/engineers to create/edit/activate permit templates (currently backend-only)
2. **Cost overlay in batch comparison** — show cost per scenario in the ScenariosPanel bar chart
3. **Flowsheet snapshots UI** — list/restore named canvas snapshots in ProjectPage
4. **Real-time collaboration** — WebSocket for multi-user canvas editing
5. **Anaerobic digestion model** — dedicated ADM1-lite model for sludge digestion (currently mapped to thickener)
6. **Tertiary treatment** — UV disinfection CT model, granular media filter head-loss model
7. **Advanced EBPR** — full UCT/JHB configuration (multiple anaerobic/anoxic zones with internal recycles)

---

## API Reference (as of Session 6)

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
POST   /api/v1/auth/logout-all
GET    /api/v1/auth/me

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
DELETE /api/v1/projects/:id

GET    /api/v1/projects/:projectId/flowsheets
POST   /api/v1/projects/:projectId/flowsheets
GET    /api/v1/projects/:projectId/flowsheets/:id
PATCH  /api/v1/projects/:projectId/flowsheets/:id
DELETE /api/v1/projects/:projectId/flowsheets/:id
POST   /api/v1/projects/:projectId/flowsheets/:id/snapshot

POST   /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate            (steady_state OR dynamic)
POST   /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/batch
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/default-profile
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/default-unit-costs  ← NEW
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/export/csv
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/export/json

GET    /api/v1/permit-templates                   ← NEW
POST   /api/v1/permit-templates                   ← NEW
GET    /api/v1/permit-templates/:id               ← NEW
PATCH  /api/v1/permit-templates/:id               ← NEW
DELETE /api/v1/permit-templates/:id               ← NEW
POST   /api/v1/permit-templates/:id/activate      ← NEW

GET    /health
```

---

## Simulation Engine Architecture (Session 6)

```
POST /simulate mode=steady_state
  → loadPermitTemplate(orgId)          — fetch active org permit template
  → runSteadyState(canvasData, { nodeParams, permitLimits })
      → augmentedParams: injects permitLimits into outlet node params
      → [solver passes as before]
      → outlet.solve({ permitLimits }) — uses org limits instead of hardcoded
  → estimateCosts(results, unitCosts)  ← NEW
  → return { streamResults, unitResults, summary, costBreakdown, permitLimitsUsed }

Chemical Dosing node (chemical_dosing / coagulant_dosing / polymer_dosing / ph_adjustment / chlorination):
  → chemicalDosing.solve(inputs, { chemical_type, dose_mg_L, target_pH })

Aeration Basin EBPR:
  → aerationBasin.solve(inputs, { ebpr: true, PAO_fraction, ... })
      → anaerobic selector: VFA uptake → P release
      → [existing anoxic/aerobic zones]
      → aerobic luxury P uptake: X_PAO × ebpr_uptake_rate × HRT_d
```

---

## Stream Parameters (unchanged)

| Parameter | Description | Units |
|---|---|---|
| Q | Volumetric flow | m³/d |
| TSS | Total suspended solids | mg/L |
| BOD | 5-day BOD | mg/L |
| COD | Chemical oxygen demand | mg/L |
| TN | Total nitrogen | mg/L |
| NH4 | Ammonia-nitrogen | mg/L |
| NO3 | Nitrate-nitrogen | mg/L |
| NO2 | Nitrite-nitrogen | mg/L |
| TP | Total phosphorus | mg/L |
| DO | Dissolved oxygen | mg/L |
| pH | pH | — |
| temp | Temperature | °C |

---

## Tech Decisions Made (Session 6 additions)

| Decision | Choice | Rationale |
|---|---|---|
| **Cost model** | **Five-category parametric OPEX model** | Appropriate fidelity for conceptual design; all coefficients user-overridable |
| **EBPR** | **Simplified luxury uptake (empirical Monod)** | Full ASM2d overkill for steady-state; this gives realistic TP removal vs. PAO fraction |
| **Chemical dosing** | **Empirical stoichiometric coefficients** | No need for full coagulation chemistry; matches Metcalf & Eddy simplifed approach |
| **Permit templates** | **JSONB in DB, org-scoped, one active at a time** | Flexible schema, multi-tenant safe, trivially extensible |
| **permitLimits injection** | **Injected into outlet node params by solver** | Zero changes to outlet node's public API; fully transparent to caller |

---

## Dev Credentials (unchanged)
| User | Email | Password | Role |
|---|---|---|---|
| Ada Admin | admin@watersim.dev | Admin1234! | admin |
| Eddie Engineer | engineer@watersim.dev | Engineer1! | engineer |
| Olivia Operator | operator@watersim.dev | Operator1! | operator |
| Org slug | `demo-org` | — | — |

---

## Files Modified This Session
```
watersim/
├── backend/
│   ├── migrations/
│   │   └── 002_permit_templates.sql          ← NEW (permit_templates table + demo seed)
│   └── src/
│       ├── simulation/
│       │   ├── costEstimator.js              ← NEW (5-category OPEX model)
│       │   ├── models/
│       │   │   ├── aerationBasin.js          ← UPDATED (EBPR luxury uptake)
│       │   │   ├── chemicalDosing.js         ← NEW (alum/FeCl3/polymer/NaOH/H2SO4/NaOCl)
│       │   │   └── outlet.js                 ← UPDATED (configurable permit limits)
│       │   └── solver.js                     ← UPDATED (permitLimits injection, chem dosing model)
│       ├── routes/
│       │   ├── permitTemplates.js            ← NEW (CRUD + /activate)
│       │   └── simulate.js                   ← UPDATED (unitCosts, costBreakdown, /default-unit-costs)
│       ├── server.js                         ← UPDATED (permit-templates route registered)
│       └── __tests__/
│           ├── helpers.js                    ← UPDATED (createTestUser, loginAs, makeProject, makeFlowsheet)
│           └── simulation.test.js            ← UPDATED (Phase 4 test suites)
└── frontend/
    └── src/
        ├── components/canvas/
        │   └── UnitOpPalette.jsx             ← UPDATED (Chemical Dosing category)
        └── pages/
            └── CanvasPage.jsx               ← UPDATED (costBreakdown prop, SummaryPanel cost overlay,
                                                          EBPR fields, chemical dosing property panels,
                                                          React default import)
```

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Phases 1–4 are complete. SESSION_STATE_session6.md documents everything. We are starting Session 7: Phase 5 — [pick from: Permit Templates UI frontend, cost overlay in batch comparison, flowsheet snapshots UI, real-time collaboration WebSocket, anaerobic digestion ADM1-lite model, or tertiary treatment models]."
