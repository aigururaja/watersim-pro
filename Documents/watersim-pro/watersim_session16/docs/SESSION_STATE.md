# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Phase 2 — Simulation Engine
## Current Session: Session 3
## Overall Progress: Phase 1 ✅ Complete | Phase 2 ✅ Complete

---

## ✅ Completed Steps

### Session 1 — Base Foundation
- Monorepo scaffold, DB schema, backend core, auth, RBAC, frontend shell, canvas shell

### Session 2 — Projects, Flowsheets, Seed, Tests, Docker
- Projects CRUD, Flowsheets CRUD, Seed data, Backend tests, Docker Compose
- **Simulation engine partially scaffolded** (models written, route written but not wired)

### Session 3 — Simulation Engine (Phase 2)

#### Step 14 — Mount Simulate Route
- `backend/src/server.js` — mounted simulate route at `/api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate`

#### Step 15 — Fix Solver: Palette Type Mapping
- `backend/src/simulation/solver.js` — **updated**
  - Added `PALETTE_TYPE_MAP` — maps palette `opType` values (e.g. `activated_sludge`) → solver model keys (e.g. `aeration`)
  - New `resolveNodeType(node)` function — uses `node.data.opType` first, then falls back to node ID parsing
  - Fixed `SOURCE_TYPES` detection to use `resolveNodeType`
  - `unitResults` now includes `paletteType` field
  - Pass-through nodes (pump, blower, tank) handled gracefully

#### Step 16 — Frontend: Simulate Button + Results Overlay
- `frontend/src/pages/CanvasPage.jsx` — **major rewrite**
  - Toolbar: Save + **▶ Simulate** + Clear Results + 📊 Summary buttons
  - **Custom StreamEdge** — shows `Q: X m³/d` label on edges after simulation
  - **Param editor panel** — click any node to configure its parameters (SRT, MLSS, flows, etc.)
    - Full param definitions for: inlet, screening, grit_removal, primary_clarifier, activated_sludge, secondary_clarifier, membrane_bioreactor, ro_membrane, thickener, anaerobic_digester
  - **Summary panel** — permit compliance badge, violations table, influent/effluent quality table, warnings
  - Per-node simulation metrics shown in param panel after run
  - Error banner for simulation failures

#### Step 17 — Frontend: UnitOpNode + UnitOpPalette Updates
- `frontend/src/components/canvas/UnitOpNode.jsx` — added colors for `inlet`, `outlet`, `screening`, `grit_removal`, `thickener`
- `frontend/src/components/canvas/UnitOpPalette.jsx` — added **"Flow Boundaries"** category with Inlet and Outlet nodes

#### Step 18 — Seed Data Fix
- `backend/src/seeds/index.js` — updated demo flowsheet "Main Treatment Train" to use correct opTypes:
  - Full 7-node linear train: `inlet → screening → grit_removal → primary_clarifier → activated_sludge → secondary_clarifier → outlet`
  - All edges typed as `stream` edges
  - Inlet pre-configured with typical municipal wastewater quality

---

## 🔲 Next Steps (Session 4 — Phase 3: Advanced Features)

### Phase 3 Scope:
1. **Denitrification** — anoxic zone extension to aeration basin model (pre-anoxic selector)
2. **Recycle streams** — RAS loop from secondary clarifier back to aeration (fixed-point iteration in solver)
3. **Dynamic simulation** — time-series input loading patterns, diurnal variation
4. **Results export** — CSV/PDF export of simulation results
5. **Flowsheet comparison** — run multiple scenarios side-by-side
6. **Phase 3 tests** — integration tests hitting the simulate API

---

## API Reference (as of Session 3)

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

POST   /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate   ← NEW
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate   ← NEW (list runs)
GET    /api/v1/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId  ← NEW

GET    /health
```

---

## Simulation Engine Architecture

```
POST /simulate
  → loads canvas_data from flowsheets table
  → INSERT simulation_runs (status='running')
  → runSteadyState(canvasData, { nodeParams })
      → buildGraph(nodes, edges)  — adjacency maps
      → BFS topological order from source nodes
      → for each node in order:
          resolveNodeType(node)   — opType → model key via PALETTE_TYPE_MAP
          MODELS[type].solve(inputs, params)
          distribute outputs to outgoing edges
      → returns { streamResults, unitResults, summary, warnings }
  → UPDATE simulation_runs (status='completed', results=JSON)
  → return { run_id, status, results, warnings }
```

### Solver Model Keys vs Palette opTypes

| Palette opType | Solver Model Key | Model File |
|---|---|---|
| `inlet` | `inlet` | models/inlet.js |
| `outlet` | `outlet` | models/outlet.js |
| `screening` | `screen` | models/screen.js |
| `grit_removal` | `grit` | models/grit.js |
| `primary_clarifier` | `prim_clarifier` | models/primaryClarifier.js |
| `activated_sludge` | `aeration` | models/aerationBasin.js |
| `membrane_bioreactor` | `aeration` | models/aerationBasin.js (simplified) |
| `secondary_clarifier` | `sec_clarifier` | models/secondaryClarifier.js |
| `ro_membrane` | `ro` | models/roMembrane.js |
| `thickener`, `anaerobic_digester` | `thickener` | models/sludgeThickener.js |
| `pump`, `blower`, `tank` | `passthrough` | — (pass-through) |

---

## Tech Decisions Made
| Decision | Choice | Rationale |
|---|---|---|
| Monorepo | npm workspaces | Simple, no extra tooling |
| Auth | JWT access + httpOnly refresh cookie | Security best practice |
| JWT payload | `{ sub, org, role }` | Standard JWT claims |
| Password hashing | bcrypt 12 rounds | Industry standard |
| Refresh token storage | Hashed SHA-256 in DB | Never store raw tokens |
| ORM | None — raw pg queries | Full SQL control |
| State | React Context + TanStack Query | Appropriate scale |
| Canvas | React Flow (reactflow) | Mature, actively maintained |
| Tests | Jest + supertest | Standard Node test stack |
| Container | Docker Compose + postgres:16 | Reproducible dev env |
| Solver | Topological BFS + per-node models | Extensible, unit-testable |
| Sim persistence | simulation_runs table (JSONB results) | Full audit trail |

---

## Dev Credentials (after seed)
| User | Email | Password | Role |
|---|---|---|---|
| Ada Admin | admin@watersim.dev | Admin1234! | admin |
| Eddie Engineer | engineer@watersim.dev | Engineer1! | engineer |
| Olivia Operator | operator@watersim.dev | Operator1! | operator |
| Org slug | `demo-org` | — | — |

---

## Files Created/Modified This Session
```
watersim/
└── backend/
    └── src/
        ├── server.js                           ← UPDATED (simulate route mounted)
        └── simulation/
            └── solver.js                       ← UPDATED (PALETTE_TYPE_MAP, resolveNodeType)
└── frontend/
    └── src/
        ├── pages/
        │   └── CanvasPage.jsx                  ← MAJOR REWRITE (simulate UI, param editor, results overlay)
        └── components/canvas/
            ├── UnitOpNode.jsx                  ← UPDATED (inlet/outlet/grit colors)
            └── UnitOpPalette.jsx               ← UPDATED (Flow Boundaries category)
└── backend/src/seeds/index.js                  ← UPDATED (correct opTypes in demo flowsheet)
```

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Phase 1 (foundation) and Phase 2 (simulation engine) are complete. The SESSION_STATE.md documents everything. We are starting Session 4: Phase 3 — Advanced Features (denitrification, recycle loops, dynamic simulation, results export). Please read the state file and continue."
