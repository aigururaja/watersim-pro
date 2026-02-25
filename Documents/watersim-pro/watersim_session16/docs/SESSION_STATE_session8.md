# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Phase 5 — Frontend & UX Completions
## Current Session: Session 8
## Overall Progress: Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ | Phase 4 ✅ | Phase 5 (in progress)

---

## ✅ Completed Steps (Sessions 1–7)
See SESSION_STATE_session7.md for full detail through Session 7.

**Summary through Session 7:**
- Phase 1–4: Full backend + frontend, sim engine, RAS, denitrification, EBPR, cost model, permit templates, snapshots
- Session 7 (Steps 34–36): SettingsPage (permit templates UI), batch cost overlay, flowsheet snapshots UI

---

## ✅ Session 8 — Phase 5 (Steps 37–39)

### Step 37 — Cost Unit-Costs Editor UI

**Backend changes:**
- `backend/src/routes/projects.js` ← UPDATED
  - `PATCH /projects/:id` now also accepts `settings` JSONB deep-merge (||operator)
  - `GET  /projects/:id/unit-costs` — returns `{ defaults, overrides, effective }`
  - `PUT  /projects/:id/unit-costs` — replaces project overrides (engineer+ only); sanitises to known keys
  - `DELETE /projects/:id/unit-costs` — resets all overrides to global defaults
- `backend/src/routes/simulate.js` ← UPDATED
  - Simulate POST now auto-loads `project.settings.unitCosts` and merges with request-body `unitCosts`
  - Priority: global defaults → project overrides → per-request overrides

**Frontend changes:**
- `frontend/src/pages/SettingsPage.jsx` ← UPDATED
  - Added `UnitCostsTab` component (self-contained, ~200 lines above SettingsPage)
  - `UNIT_COST_FIELDS` array: 4 groups (Energy, Chemicals, Sludge, Labour/Capital), 13 fields with hints
  - Tab bar added: **📋 Permit Templates** | **💰 Cost Coefficients**
  - Cost tab: shows all 13 coefficients in 2-column card grid; amber highlight on overridden fields; inline revert-to-default ✕; save/reset buttons; dirty-state tracking
  - Operators see read-only view with lock notice
- `frontend/src/pages/ProjectPage.jsx` ← UPDATED
  - Added **⚙ Cost Settings** button in project header → `/projects/:id/settings`
- `frontend/src/pages/CanvasPage.jsx` ← UPDATED
  - Added **⚙** gear icon button in toolbar → `/projects/:id/settings`
- `frontend/src/App.jsx` ← UPDATED
  - Added route `/projects/:projectId/settings` → SettingsPage (passes projectId via useParams)

**API summary for unit-costs:**
```
GET    /api/v1/projects/:id/unit-costs
PUT    /api/v1/projects/:id/unit-costs     (engineer+)
DELETE /api/v1/projects/:id/unit-costs     (engineer+)
```

---

### Step 38 — Tertiary Treatment Models

#### UV Disinfection (`backend/src/simulation/models/uvDisinfection.js`) ← NEW
- **CT (fluence) model** for log-reduction of pathogens:
  - `fluence (mJ/cm²) = required × UVT_correction` where `UVT_correction = √(UVT/65)`
  - `log_reduction = fluence / k_inact`
- **Lamp sizing**: `lamp_count = ceil(Q_m3_h / lamp_Q_rating_m3_h)`
- **k_inact presets**: E. coli=19, Crypto=10, Giardia=82, Adenovirus=186 mJ/cm²
- **Parameters**: `target_log_reduction`, `UVT_pct`, `lamp_power_kW`, `lamp_Q_rating_m3_h`, `k_inact_mJ_cm2`
- **Outputs**: `effluent` (TSS/TN/TP unchanged; 2–4% BOD/COD photo-oxidation), `metrics` (fluence, lamp_count, energy_kWh_d, compliant)
- **Solver wiring**: `uv_disinfection → 'uv_disinfection'` model (was stub to chemical_dosing)

#### Granular Media Filter (`backend/src/simulation/models/granularFilter.js`) ← NEW
- **Kozeny-Carman clean-bed head loss** per layer (anthracite + sand):
  - `h_L = kozeny_k × ν × v_f × L / (g × d_e²)` where `kozeny_k = 180(1−ε)²/ε³`
  - Temperature-corrected kinematic viscosity polynomial
- **Clogging model**: `h_clogged = h_clean + 0.4 × TSS_load_kg/m²`; backwash flagged when `h > h_limit`
- **TSS removal**: logistic breakthrough model; 5% backwash flow; dual-media defaults (anthracite 0.45m + sand 0.30m)
- **Parameters**: `filter_type` (dual_media/sand), `HLR_m_h`, `TSS_removal_pct`, depths, grain sizes, porosities, `backwash_interval_h`
- **Outputs**: `filtrate`, `backwash` (high-strength), `metrics` (area, head losses, breakthrough, backwash_needed)
- **Solver wiring**: `sand_filter → 'granular_filter'` model (was stub to screen)

**Canvas node labels updated:**
- "Anaerobic Digester" → "Anaerobic Digester (ADM1-lite)"
- "UV Disinfection" → "UV Disinfection (CT model)"
- "Sand Filter" → "Granular Filter (dual/sand)"

**NodePropertiesPanel params added** for `uv_disinfection` and `sand_filter`.

**SummaryPanel** extended with UV/filter/digester unit-result cards (fluence, lamp count, head loss, backwash status, biogas yield).

---

### Step 39 — ADM1-lite Anaerobic Digestion (`backend/src/simulation/models/anaerobicDigester.js`) ← NEW

**Four-stage biochemical pathway (steady-state):**
1. **Hydrolysis**: `f_dest = 1 − exp(−k_hyd_eff × HRT)` capped at `COD_removal_pct`
2. **Acidogenesis + Acetogenesis**: `VFA = 0.85 × COD_hydrolysed`
3. **Methanogenesis**: `CH₄_COD = 0.70 × VFA_COD`; yield = 0.35 m³ CH₄/kg COD

**Temperature correction** (Arrhenius):
- Mesophilic (≤45°C): `θ^(T−35)`, θ=1.08, ref 35°C
- Thermophilic (>45°C): `1.7 × θ^(T−55)`, θ=1.06, ref 55°C
- Below 15°C: factor = 0.15 (severe inhibition)

**Nitrogen mineralisation**: `40–70%` of organic N → NH₄ during digestion (centrate NH₄ concern flagged when >500 mg/L + dewatering=true)

**Optional dewatering** (`dewatering: true`): splits digestate into:
- **Cake** at `cake_DS_pct` (default 22%)
- **Centrate** — high-strength return stream (elevated NH₄, ~80% of N)

**Biogas energy**: CH₄ × 10 kWh/m³ × 35% generator efficiency

**Stability checks**: warns on T<25°C, pH<6.8, HRT<10d, HRT<15d, low-COD influent

**Solver wiring**: `anaerobic_digester → 'anaerobic_digest'` model (was stub to thickener); `biogas` stored separately in `unitResults[nodeId].biogas`

**Parameters**: `HRT_d`, `temp_C`, `COD_removal_pct`, `pH_setpoint`, `biogas_CH4_frac`, `dewatering`, `cake_DS_pct`

---

## 🔲 Remaining Phase 5 Items

1. **Real-time collaboration** — WebSocket for multi-user canvas editing (biggest lift, save for last)
2. **Advanced EBPR** — full UCT/JHB configuration with multiple anaerobic/anoxic zones
3. ~~Cost unit-costs editor~~ — ✅ Done (Step 37)
4. ~~Tertiary treatment models~~ — ✅ Done (Step 38)
5. ~~ADM1-lite anaerobic digestion~~ — ✅ Done (Step 39)

---

## API Reference (as of Session 8) — additions to Session 7

```
GET    /api/v1/projects/:id/unit-costs            ← NEW
PUT    /api/v1/projects/:id/unit-costs            ← NEW (engineer+)
DELETE /api/v1/projects/:id/unit-costs            ← NEW (engineer+)
[all Session 7 routes unchanged]
```

---

## Tech Decisions Made (Session 8 additions)

| Decision | Choice | Rationale |
|---|---|---|
| **Unit-costs storage** | `projects.settings.unitCosts` JSONB | No migration needed; `settings` column already existed; deep-merge with `\|\|` operator |
| **UV fluence model** | CT approach with UVT correction | Industry standard (EPA UV guidance); UVT correction `√(UVT/65)` matches NWRI guidelines |
| **Granular filter** | Kozeny-Carman per layer + clogging factor | Well-validated for dual-media; gives head-loss vs. run-time profile |
| **Digester** | Steady-state ADM1 simplification, not full ODE | Full ADM1 requires stiff ODE solver (not practical in sync Node.js); SS gives accurate yields |
| **Biogas energy** | Stored in `unitResults[nodeId].biogas` | Separate from `metrics` to avoid breaking existing metrics display code |
| **Dewatering split** | Optional param in digester (not separate node) | Reduces canvas complexity; centrate returned as `filtrate` port |
| **Centrate warning** | NH₄ > 500 mg/L + dewatering=true | Centrate is a high-strength recycle stream that can overwhelm the liquid train |

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
├── backend/src/
│   ├── routes/
│   │   ├── projects.js                             ← UPDATED (unit-costs endpoints + settings PATCH)
│   │   └── simulate.js                             ← UPDATED (project unit-cost auto-load)
│   └── simulation/
│       ├── solver.js                               ← UPDATED (new models wired, biogas output)
│       └── models/
│           ├── uvDisinfection.js                   ← NEW  (UV CT fluence model)
│           ├── granularFilter.js                   ← NEW  (Kozeny-Carman head-loss)
│           └── anaerobicDigester.js                ← NEW  (ADM1-lite 4-stage)
└── frontend/src/
    ├── App.jsx                                     ← UPDATED (project settings route)
    ├── components/canvas/
    │   ├── UnitOpNode.jsx                          ← UPDATED (icons for new node types)
    │   └── UnitOpPalette.jsx                       ← UPDATED (node labels)
    └── pages/
        ├── SettingsPage.jsx                        ← UPDATED (UnitCostsTab, tab bar)
        ├── ProjectPage.jsx                         ← UPDATED (⚙ Cost Settings button)
        └── CanvasPage.jsx                          ← UPDATED (⚙ toolbar btn, UV/filter/digester results, ADM1 params)
```

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Phase 5 is in progress. SESSION_STATE_session8.md documents everything. We are starting Session 9: [choose from remaining Phase 5 items: advanced EBPR UCT/JHB, real-time collaboration WebSocket, or another item]."
