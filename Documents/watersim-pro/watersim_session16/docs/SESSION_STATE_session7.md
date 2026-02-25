# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Phase 5 — Frontend & UX Completions
## Current Session: Session 7
## Overall Progress: Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ | Phase 4 ✅ | Phase 5 (in progress)

---

## ✅ Completed Steps (Sessions 1–6)
See SESSION_STATE_session6.md for full detail through Phase 4.

**Summary:**
- Phase 1: Monorepo, DB schema, auth, RBAC, frontend shell, canvas shell
- Phase 2: Simulation engine, RAS recycle fixed-point solver, denitrification
- Phase 3: RAS recycle, denitrification, CSV/JSON export, dynamic simulation, flowsheet batch comparison
- Phase 4: Cost estimation model, EBPR luxury uptake, chemical dosing node, permit templates backend

---

## ✅ Session 7 — Phase 5 (Steps 34–36)

### Step 34 — Permit Templates UI (`frontend/src/pages/SettingsPage.jsx`) ← NEW FILE
Full settings/permit management page wired to the 6 permit template endpoints built in Session 6.

**Features:**
- **Template card grid** — shows all org templates with:
  - Left border highlight (green = active, gray = inactive)
  - `ACTIVE` badge on the current template
  - Chip row showing BOD / TSS / TN / TP / NH₄ / NO₃ / pH limit values at a glance
  - Expandable detail table with all 8 parameters + regulatory status
  - **Activate** button (admin/engineer only) — sets the template as active for all simulations
  - **Edit** button → opens full edit modal
  - **Delete** button (admin only) — disabled on active template, confirm dialog
- **Create / Edit modal:**
  - Name + description fields
  - 2-column limits grid for all 8 parameters (BOD, TSS, TN, TP, NH₄, NO₃, pH min, pH max)
  - Blank = not regulated (null in DB)
  - **Quick preset buttons:** "EPA Secondary", "Nutrient Removal", "Advanced Treatment" — one-click fill
- **Role permissions table** — inline reference for admin/engineer/operator capabilities
- **Toast notifications** — bottom-right, auto-dismiss 3.5 s
- Role enforcement: admins can create/edit/delete/activate; engineers can create/edit/activate; operators read-only
- API calls: `GET /permit-templates`, `POST`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/activate`

**Routing:** `/settings` and `/settings/permits` both map to `SettingsPage`

**App.jsx updated:** `SettingsPage` imported and routed (previously was a stub pointing to DashboardPage)

---

### Step 35 — Cost Overlay in Batch Comparison (`frontend/src/pages/CanvasPage.jsx`) ← UPDATED
Extended `ScenariosPanel` to surface cost data from `costBreakdown` returned per scenario.

**Chart enhancement:**
- `COMPARE_PARAMS` now has 8 options grouped into two `<optgroup>`:
  - *Effluent Quality*: BOD, TN, NH₄, NO₃, TP (existing, now each has a `color` field)
  - *Cost & Energy*: Annual Cost ($/k/yr), Cost per m³ ($), Energy (MWh/yr)
- Each cost param has its own bar color (amber, purple, green) and a custom `fmt` formatter (e.g. `$42k`, `$0.312`)
- Tooltip uses `fmt` function for proper cost-aware labeling
- 10px advisory note shown below chart when a cost param is selected

**New Cost Comparison table:**
- Rendered below "Permit Status" when ANY scenario has `costBreakdown` data
- Yellow-tinted header row (`#FEF9C3`)
- Columns: Scenario | $/yr | $/m³ | Energy | Chemicals | Sludge
- Color-coded scenario left border (same 6-color scheme as effluent table)
- Alternating row background (`#FEFCE8` tint for odd rows)
- Italic footnote: "All figures USD/yr. Costs are parametric OPEX estimates only."

---

### Step 36 — Flowsheet Snapshots UI ← UPDATED (ProjectPage + CanvasPage)

#### `frontend/src/pages/ProjectPage.jsx` ← REWRITTEN
Complete redesign with tabbed interface:

**Tabs:**
- **Flowsheets tab** (default): shows `is_snapshot = false` rows
  - Hover reveals 📸 (snapshot) and 🗑 (delete) action icons
  - Card is click-to-open
  - "Open →" hint appears on hover
- **Snapshots tab**: shows `is_snapshot = true` rows
  - Each card has green left border + "SNAP" badge
  - **↩ Restore as Flowsheet** button — GETs snapshot detail, POSTs new flowsheet with same `canvas_data`, then navigates to it
  - 🗑 Delete button with confirmation
  - Empty state explains how to create snapshots
  - **Quick snapshot bar** (when live flowsheets exist) — one-click `POST .../snapshot` trigger per flowsheet

**Tab badges** show live count of each category.

**Snapshot modal** (triggered from either tab or hover icons):
- Pre-fills name with `"{flowsheet} — {today's date}"`
- Calls `POST /projects/:projectId/flowsheets/:flowsheetId/snapshot`
- Shows source flowsheet name and version in green info banner
- Toast on success; error alert on failure

**Toast system** — same pattern as SettingsPage.

#### `frontend/src/pages/CanvasPage.jsx` ← UPDATED
- **📸 snapshot button** added to toolbar (teal, between Save and Simulate)
- Disabled when canvas is empty (`nodes.length === 0`)
- Opens inline snapshot modal with:
  - Pre-filled name: `"{flowsheet.name} — {today's date}"`
  - `POST /projects/${projectId}/flowsheets/${flowsheetId}/snapshot`
  - Green toast on success (auto-dismiss 3 s)
- New state: `showSnapModal`, `snapName`, `snapping`, `snapToast`
- New handler: `takeSnapshot()`

---

## 🔲 Remaining Phase 5 Items

1. **Anaerobic digestion ADM1-lite** — dedicated model for sludge digestion (mapped to thickener placeholder)
2. **Tertiary treatment** — UV disinfection CT model, granular media filter head-loss model
3. **Real-time collaboration** — WebSocket for multi-user canvas editing (biggest lift)
4. **Advanced EBPR** — full UCT/JHB configuration with multiple anaerobic/anoxic zones
5. **Cost unit-costs editor** — UI to override the 13 cost coefficients per project (currently API only)

---

## API Reference (as of Session 7) — unchanged from Session 6

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
POST   /api/v1/projects/:projectId/flowsheets/:id/snapshot          ← used by Snapshots UI

POST   /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate
POST   /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/batch
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/default-profile
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/default-unit-costs
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/export/csv
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/export/json

GET    /api/v1/permit-templates
POST   /api/v1/permit-templates
GET    /api/v1/permit-templates/:id
PATCH  /api/v1/permit-templates/:id
DELETE /api/v1/permit-templates/:id
POST   /api/v1/permit-templates/:id/activate

GET    /health
```

---

## Tech Decisions Made (Session 7 additions)

| Decision | Choice | Rationale |
|---|---|---|
| **Settings page scope** | **Permit templates only (for now)** | Single-responsibility page; extend with cost unit-costs editor next session |
| **Snapshot restore** | **GET detail → POST new flowsheet** | No dedicated restore endpoint needed; reuses existing flowsheet creation |
| **Cost chart grouping** | **`<optgroup>` in select** | Clean UX separation of quality vs. cost metrics without adding tabs |
| **Quick preset limits** | **Three hardcoded presets** | Covers 95% of US/EU cases; easily extensible array |
| **CanvasPage snap button** | **Teal 📸 icon button in toolbar** | Minimal toolbar footprint; tooltip explains it |

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
└── frontend/
    └── src/
        ├── App.jsx                          ← UPDATED (SettingsPage import + route)
        └── pages/
            ├── SettingsPage.jsx             ← NEW  (permit templates CRUD UI)
            ├── ProjectPage.jsx              ← REWRITTEN (tabs: Flowsheets + Snapshots)
            └── CanvasPage.jsx               ← UPDATED (📸 snap button, cost chart, cost table)
```

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Phase 5 is in progress. SESSION_STATE_session7.md documents everything. We are starting Session 8: [choose from remaining Phase 5 items: ADM1-lite anaerobic digestion, tertiary treatment models (UV CT + granular filter), cost unit-costs editor UI, real-time collaboration WebSocket, or advanced EBPR UCT/JHB]."
