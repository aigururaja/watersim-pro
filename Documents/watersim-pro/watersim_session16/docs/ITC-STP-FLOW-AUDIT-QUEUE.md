# ITC STP — outstanding flow-audit findings

> **Tag names in this file predate the ISA-5.1 conformance pass.** Since it was
> generated: `R-DEC-301` → `R-M-301`, `SHT-BV-301` → `SHT-XV-301`,
> `R-AV-301` → `R-XV-311`, `ACF-BV-611` → `ACF-XV-611`, `SOF-BV-701` → `SOF-XV-701`,
> and every discrete-output suffix `XC`/`XR` → `XY` (`XY-A`/`XY-B` on the decanter
> drives). The findings themselves are unaffected.

> Raised by a 10-lens audit of the flow against the proposal schematic and the
> control narrative. **Not yet verified** — the adversarial verification pass was
> stopped part-way (see the note at the end), and of the 89 verdicts that did
> return, 61 of 123 findings were refuted. Treat this as a review queue, not a
> defect list: read each one against the schematic before acting.

Four were fixed before the demo and are **not** listed here: the chlorine skids
modelled as alum, the two reactor alarms that could never fire, the EQT alarm on
a setpoint, and an instrument citing a tag that exists nowhere.

## High severity (23)

### SHT-P-401, the sludge discharge pump, exists as a priced device but has no node — SHT feeds the poly dosing skid directly

- **kind** missing_node
- **found** processes.js:177 lists `{ tag: 'SHT-P-401', qty: 1, name: 'Sludge discharge pump', kind: 'pump', printed: { DI: 2, DO: 1 } }` and processes.js:172 gives its duty ('Discharge 2 m³/hr @ 35 m (Roto)'). flowsheet.js:353 wires `edge('e_sht_poly', 'sht', 'poly_dose')` — nothing between the tank and the dosing point. A cross-check of every device tag against every `data.tags` array on the flowsheet found SHT-P-401 completely orphaned (the only other orphans are SHT-BV-301, ACF-BV-611, SFP-XV-711). The existing test at backend/src/__tests__/itcPlant.test.js:286 only checks node tags ⊆ device tags, never the reverse, so the omission is invisible to the suite. The solved sheet therefore shows 13.29 m³/d of WAS arriving at the poly skid with no motive device, while every other transfer in the plant (ELP, RFP, FFP, SFP, STP, UFFP, UFBP) is drawn pump-by-pump.
- **proposal says** Schematic slide 3: 'SHT -> screw/discharge pump -> POLY DOSING -> CENTRIFUGAL'. Slide 7 Sludge Process spec names the discharge pump at 2 m³/hr @ 35 m (Roto) and its Controls-Involved row carries 2 DI + 1 DO.
- **suggested fix** Add `node('sht_p', 'pump', 'SHT-P-401 — Sludge discharge pump', V(2560, 470), { area: 'SHT', tags: ['SHT-P-401'], source: 'Slide 7 — 2 m³/hr @ 35 m, Roto', params: { running: 1, speed_pct: 100, capacity_m3_d: 48, head_m: 35 } })`, re-target `e_sht_poly` to `sht_p` and add `edge('e_shtp_poly', 'sht_p', 'poly_dose')`. Verified in memory: the sheet still converges with no new warnings. Note while doing it that the 2 m³/hr discharge pump is twice the 1 m³/hr Hiller centrifuge it feeds, so the node's duty is worth a `note` about throttled/intermittent running.

### The centrifuge's water DRAIN is not represented — drain and centrate are collapsed into a single stream to EQT

- **kind** missing_node
- **found** processes.js:169 states the Sludge Process outputs as three: `['Water drain', 'Solid discharge', 'Centrate to EQT']`. The flowsheet gives the centrifuge only two outlets: flowsheet.js:355 `e_cent_solids` (role 'thickened') and flowsheet.js:356 `e_cent_eqt` (role 'filtrate', recycle). Solved, 100 % of the 13.05 m³/d filtrate returns to EQT and no drain boundary exists — `r.summary.boundaries` contains no drain, so the water leaving the plant at that point is counted as recycle instead. The two are physically different destinations on the drawing (DRAIN leaves the plant, the EQT line comes back into it), so the sheet both misses a boundary and over-states EQT recycle load.
- **proposal says** Schematic slide 3: the centrifuge has BOTH a 'DISCHARGE' (solids) and a 'DRAIN' (water) leg, plus a separate line back to EQT. Slide 7's process table lists the same three outputs.
- **suggested fix** Add `node('drain_out', 'outlet', 'Water drain', V(3010, 400), { area: 'SHT', source: 'Slide 7 — water drain', params: { discharge_type: 'reject' } })` and split the filtrate between it and EQT. Do NOT add a second `role: 'filtrate'` edge — I tested it and the solver hands the full port stream to every role-matched edge (both `e_cent_eqt` and a new drain edge each received 13.05 m³/d against a 13.05 m³/d filtrate, duplicating mass, solver.js:426). Instead drop the role from `e_cent_eqt`, add a plain `edge('e_cent_drain', 'centrifuge', 'drain_out', { label: 'Drain' })`, and put `splitRatios` on the centrifuge params with a `data.assumption` saying the drain/centrate share is not stated in the proposal. Verified in memory: converges clean, 0 unrouted.

### The SHT supernatant insert and its 50 mm overflow are not on the sheet — the tank's entire contents go to the centrifuge

- **kind** missing_edge
- **found** `sht` (flowsheet.js:153) is an `equalisation_tank`, whose model returns only `{ effluent, metrics }` (backend/src/simulation/models/equalisationTank.js), and it has exactly one outgoing edge (flowsheet.js:353). Solved, all 13.29 m³/d of WAS at 3 500 mg/L goes to poly dosing and on to the centrifuge — the machine is rated 1 m³/hr (24 m³/d), so the sheet implies 13.3 h/d of centrifuge running on unthickened 0.35 % sludge. A supernatant draw-off is precisely what makes the 1 m³/hr Hiller duty work, and it is drawn on the schematic. The SHT overflow is likewise absent, whereas the same feature elsewhere IS modelled (the Sintex overflow to FWT is `e_sintex_fwt`, flowsheet.js:399).
- **proposal says** Schematic slide 3: SHT is drawn 'which has a SUPRANATANT INSERT and a 50 mm UPVC overflow'. Slide 7 Sludge Process, pipe spec 'UPVC 50 mm'.
- **suggested fix** Preferred: change `sht` to `opType: 'sludge_thickener'` (already in PALETTE_TYPE_MAP → the thickener model, solver.js:74) with `type: 'gravity'`, so `thickened` feeds SHT-P-401 and `filtrate` becomes the supernatant returned to EQT with a genuinely clarified TSS. Lighter alternative that keeps the level-transmitter duty on an equalisation tank: add `edge('e_sht_super', 'sht', 'eqt', { recycle: true, label: 'Supernatant to EQT' })` and `splitRatios` on the sht params (marked as an assumption) — but flag in a `note` that both legs then leave at the same 3 500 mg/L, since the equalisation model has no clarified port. I tested the split variant in memory: converges, supernatant 7.1 m³/d, no new warnings.

### None of the three bar chambers on the drawing exist as nodes — every influent enters the plant unscreened

- **kind** missing_node
- **found** NODES[] contains no screen/screening node anywhere: the ELP-area nodes are exactly in_kitchen, ogt, in_sewage, in_laundry, ct, elp_v_in, elp_p, elp_v_out, eqt (verified by filtering NODES on data.area === 'ELP'). The edges go straight from each inlet to the next vessel — e_kitchen_ogt (in_kitchen -> ogt), e_sewage_eqt (in_sewage -> eqt), e_laundry_ct (in_laundry -> ct) — so raw sewage at TSS 260 mg/L, kitchen at 500 and laundry at 150 reach the OGT, EQT and CT with no solids removal step. The app already supports this unit fully: solver.js PALETTE_TYPE_MAP maps `screening`/`screen` -> models/screen.js (5 % TSS on 'coarse', plus a `screenings` output), frontend/src/components/canvas/symbols/screening.jsx exists and index.js gives it the abbreviation 'SCR', and reports/plainLanguage.js labels it 'Bar Screen'. Running models/screen.js on the three inlet streams as authored gives 2.5 + 6.2 + 0.8 = 9.5 kg/d of screenings that the flow currently carries forward into the OGT, CT and SBR instead of raking off.
- **proposal says** Slide 3 draws a bar chamber as the first item on all three influent lines, with sizes and quantities printed on each: KITCHEN 100 KLD -> 'LxB 400x500MM, MOC SS304, QTY 2nos'; SEWAGE 475 KLD -> '600x1000MM SS304, 2nos' -> 150mm UPVC -> EQT; LAUNDRY 100 KLD -> '400x500MM SS304, 2nos' -> CT. proposal.js INFLUENT records pretreatment: 'Bar chamber' for the sewage stream. narrative.js section I 'Input water' step 2 — 'Filter to be cleaned periodically' — is the maintenance instruction for exactly these chambers, and is currently mapped to devices: [].
- **suggested fix** Add three nodes with opType 'screening' (params { screenType: 'coarse' }, area 'ELP', source 'Slide 3 — bar chamber, SS304, 2 nos'), sized per the drawing: 'Kitchen bar chamber (2 × 400 × 500 mm)' between in_kitchen and ogt, 'Sewage bar chamber (2 × 600 × 1000 mm)' between in_sewage and eqt, 'Laundry bar chamber (2 × 400 × 500 mm)' between in_laundry and ct. Re-point e_kitchen_ogt / e_sewage_eqt / e_laundry_ct to run through them, keeping the '150 mm UPVC' label on the sewage-chamber -> eqt leg. Add one outlet node (e.g. 'screenings_out', opType 'outlet', params { discharge_type: 'solids' }) and three role:'screenings' edges into it, otherwise the three new nodes add three more unrouted boundary losses.

### The micron filter's backwash is computed but has no edge, so it leaves the plant as a boundary loss instead of returning to EQT

- **kind** unrouted_stream
- **found** backend/src/plants/itcStp/flowsheet.js has no edge whose source is 'mf' other than e_mf_ufv (forward). The `mf` node is opType 'micron_filter' -> PALETTE_TYPE_MAP -> 'pressure_filter', and models/pressureFilter.js always returns a `backwash` stream (backwash_interval_h 168, backwash_m3_per_wash 0.5 -> 0.071 m3/d). Running the sheet (node -e runSteadyState(buildFlowsheet(), {nodeParams:buildNodeParams()})) prints: "Unrouted side stream 'backwash' from mf (Q=0.07 m3/d) - counted as a plant-boundary loss" and summary.unroutedLosses carries {node:'mf', stream:'backwash', Q_m3_d:0.071, TSS_kg_d:1.471}. The two sibling filters do have this edge: e_acf_bw and e_mgf_bw both go 'acf'/'mgf' -> 'eqt' with role 'backwash', recycle true.
- **proposal says** processes.js process 8 (slide 11) spec.pipe = 'UPVC 50 mm · CPVC 80 mm micro-filter backwash' and outputs include 'Backwash to EQT'; the slide-3 schematic draws micro-filter backwash piping in the UF block alongside the ACF/MGF 'BACKWASH TO EQT' lines. The proposal has no drain or reject destination in this area, so nothing in the document sends this water off-plant.
- **suggested fix** Add edge('e_mf_bw', 'mf', 'eqt', { role: 'backwash', recycle: true, label: 'Micron filter backwash to EQT' }) to EDGES, mirroring e_acf_bw / e_mgf_bw. This removes the unrouted-loss warning and returns the 1.47 kg/d of captured TSS to the balance.

### The UF module has no backwash stream to EQT — the solids it retains are dropped at the plant boundary while the UFBP returns clean permeate

- **kind** missing_edge
- **found** The `uf` node is opType 'uf_membrane', which PALETTE_TYPE_MAP resolves to the 'screen' model. models/screen.js emits only `effluent` and `screenings` — no backwash and no permeate/concentrate. `uf` has exactly one outgoing edge (e_uf_sintex, plain forward), so the solve reports "Unrouted side stream 'screenings' from uf (Q=0.00 m3/d)" with unroutedLosses {node:'uf', stream:'screenings', Q_m3_d:0.004, TSS_kg_d:0.785}. The only path from this area to EQT is e_ufbp_eqt, which carries the UFBP pump's pass-through of Sintex water: Q=15.13 m3/d at TSS 9.1 mg/L — i.e. product-quality permeate, carrying none of the 0.785 kg/d the membrane took out.
- **proposal says** Slide-3 schematic: the UF module carries a 'BACKWASH TO EQT' arrow off the membrane itself. Narrative section VII step 10 (narrative.js, slide 24): 'The Backwash Valve is then opened, and the water is directed to the EQT.' cycleAnalysis().uf also asserts backwashReturnsTo: 'EQT'. The backwash that reaches EQT is the water pushed back through the membrane, so it must carry the retained solids.
- **suggested fix** Add edge('e_uf_bw', 'uf', 'eqt', { role: 'screenings', recycle: true, label: 'UF backwash to EQT' }) — 'screenings' is the only side stream the screen model produces and PORT_ALIASES maps it, so the retained solids return to EQT instead of vanishing. Keep e_ufbp_eqt as the backwash water carrier, or note on the `uf` node that the sheet splits the backwash into a water leg (UFBP) and a solids leg (UF).

### The SOF → IRR-WT line drawn on the schematic is not in the flow — the softener has only two outlets instead of three

- **kind** missing_edge
- **found** backend/src/plants/itcStp/flowsheet.js: the only edges leaving `sof` are `e_sof_swt` (line 381, plain forward → swt) and `e_sof_reject` (line 382, role 'concentrate' → reject_out). Verified by walking the graph: `sof | in: sfp_p | out: swt, reject_out[concentrate]`. Nothing anywhere in EDGES has source 'sof' and target 'irr_wt'. A solved run gives irr_wt 180.1 m³/d, fed only by `e_ffpvo_garden` (FFP bypass) and `e_ph_irr` (pH-analyser split) — zero from the softener.
- **proposal says** Slide 3 draws the SOF with three take-offs: PERMEATE, 'BACKWASH TO IRR-WT' and 'REGENERATION TO REJECT'. processes.js line ~245 (process 7, softener_feed) lists outputs: ['Soft water tank (SWT)', 'Overflow to IRR-WT', 'Regeneration to reject'] — three, not two. narrative.js section VI step 7: 'When the SWT reaches its full level, the excess or overflow water is automatically redirected from the SOF to the IRR-WT', interlock 'SWT at high level', devices ['SWT-LT-1101','SOF-BV-701'].
- **suggested fix** Add `edge('e_sof_irr', 'sof', 'irr_wt', { label: 'Backwash / SWT-high overflow to IRR-WT' })` next to e_sof_swt. Because the softener model emits no `backwash` port (backend/src/simulation/models/waterSoftener.js returns only { effluent, concentrate }), a role edge would resolve to zero flow and warn — so make it a second PLAIN forward edge and add `splitRatios` to the sof params (e.g. [0.9, 0.1] for swt / irr_wt), otherwise the solver's 'No splitRatios provided for sof with 2 outlets' warning fires and the existing test 'leaves no plain forward split without an explicit ratio' fails. Mark the ratio with data.assumption, since the proposal states no overflow share.

### The INT-WT chlorine dosing node is computed as an alum coagulant, and silently removes phosphorus

- **kind** wrong_param
- **found** `cl_dose` sets `chemical_type: 'chlorine'` (flowsheet.js:180). `CHEMICAL_COEFFICIENTS` in backend/src/simulation/models/chemicalDosing.js has no `chlorine` key — only alum, ferric_chloride, fecl3, polymer, naoh, h2so4, naocl, hypochlorite — and the lookup is `CHEMICAL_COEFFICIENTS[chemType] || CHEMICAL_COEFFICIENTS.alum`, so it falls through to alum with no warning. Solved metrics for cl_dose: `{"chemical_type":"chlorine","dose_mg_L":1,"dose_kg_d":0.6,"sludge_kg_d":0.1,"TP_in_mg_L":8.4,"TP_out_mg_L":8.17,"TP_removal_pct":2.7}` and TSS rises 20.0 → 20.3 mg/L across the node (edge e_int_cl vs e_cl_ffpv) from the alum floc term. None of the naocl BOD/TSS trim is applied. `swt_cl` carries the same 'chlorine' value and the same fallback (TSS 1.8 → 1.9).
- **proposal says** Slide 23 narrative IV.2, transcribed in narrative.js: 'Liquid chlorine dosing happens between 0.5 ppm and 1 ppm.' The plant's own review finding `quality.no_p_removal` in index.js states 'No chemical P removal, no EBPR zone and no alum or ferric dosing appears in any process area' — the solved sheet contradicts it by reporting 2.7 % TP removal and 0.1 kg/d of chemical sludge at this node.
- **suggested fix** Set `cl_dose.params.chemical_type = 'naocl'` (or 'hypochlorite'), which is the key the model actually recognises for chlorination; apply the same to `swt_cl`. Optionally add `chlorine` and `hypo` as aliases in CHEMICAL_COEFFICIENTS so the palette word cannot silently degrade to alum.

### ACF and MGF are wired in series (ACF → MGF); the schematic shows two equal vessels in parallel on a common frontal header

- **kind** wrong_route
- **found** Edge `e_acf_mgf` ('acf' → 'mgf') puts the whole ACF/MGF leg through both vessels in line. The two vessel diameters only make sense in parallel: at the FFP's stated 43 m³/hr duty split 50/50, pressureFilter computes ACF at HLR 10.05 m/h against its rated 10 m/h and MGF at 12.17 against its rated 12 — both within 2 % of rating, no warning, derate 99 %. The same 43 m³/hr in series gives ACF HLR 20.11 (derate 50 %, warning 'Filter is passing 43.0 m³/hr against a 25 m³/hr rating') and MGF HLR 24.19 (derate 50 %). processes.js gives each vessel its own five-valve frontal set (ACF-XV-601 qty 5, MGF-XV-601 qty 5) and each its own backwash to EQT, which is the parallel signature, not a series train. In series the order is also backwards: the carbon bed (55 % TSS removal) is asked to catch the solids the multigrade bed (80 %) exists to catch, and the sand bed then sits on water the ACF has dechlorinated to 0.05 ppm.
- **proposal says** Slide 3 schematic: 'ACF (blue vessel, DIA 1650mm … FLOW 25m³/hr) and MGF (blue, DIA 1500mm … 25m³/hr) sit side by side on FRONTAL PIPING 80mm CPVC. Each has BACKWASH TO EQT at the bottom.' Slide 8 draws one leg labelled 'TO ACF & MGF FILTER'. Narrative V.1 (slide 23): 'From these filter tanks, the water flows to the pH' — plural vessels discharging to one outlet.
- **suggested fix** Delete `e_acf_mgf`. Feed both vessels from `ft_acf` — add `edge('e_ftacf_mgf','ft_acf','mgf')` alongside the existing `e_ftacf_acf`, and put `splitRatios: [0.5, 0.5]` on `ft_acf.params`. Merge both outlets at the analyser: keep `e_mgf_ph` and add `edge('e_acf_ph','acf','at_601')`. The two backwash edges to EQT stay as they are.

### `sbr_reactor` is not in the canvas's aeration family, so the air blowers can never be linked to R1/R2 and the reactors' O2 demand never sets the blower reference

- **kind** missing_tag
- **found** frontend/src/components/canvas/liveStore.js:157 — `AERATION_TYPES = ['activated_sludge','uct_reactor','jhb_reactor','membrane_bioreactor']`. `resolveType` (line 152) only applies LEGACY_TYPE_ALIASES (`preliminary`, `granular_filter`), so `sbr_reactor` stays `sbr_reactor` and is never in the AERATION set. Two consequences on this plant: (a) computeDerived (line 339-340) links a blower only when the other end of an edge is an AERATION type, so `blowers` reports `servedCount: 0` and blower.jsx renders it dashed slate, rotor parked, `data-unlinked="true"`, with the UNLINKED chip; (b) computeRefs (line 281) ratchets `O2ref` only over AERATION nodes, so O2ref stays at its floor of 1 while r1 and r2 each compute `O2_demand_kg_d: 112.6` (225 kg O2/d total). Adding the air-header edges alone does NOT fix this — I added `blowers → r1` and `blowers → r2` edges and the type test still excludes them.
- **proposal says** Slide 3 schematic: a 125 mm SS-304 air header runs from the AIR BLOWERS (475 m³/hr @ 0.55 kg/cm², Beta, qty 3, 2W+1SB) through 100 mm / 25 mm SS-304 drops and pneumatic valves into each reactor. Slide 6 / processes.js area 'R' lists R-B-301 (3 air blowers) and R-AV-301 (3 aeration air valves) as reactor-process devices. Narrative II.6/II.7/II.10 drive the blowers off the reactor cycle.
- **suggested fix** Add `'sbr_reactor'` to `AERATION_TYPES` in frontend/src/components/canvas/liveStore.js:157. The SBR model already emits `O2_demand_kg_d` from `aerationBasin` (it delegates the biology verbatim), so both the O2ref ratchet and the blower `O2_served` sum work unchanged once the type is in the set.

### R1 and R2 carry no working volume and no assumption for one, so the reactor size is silently back-derived by the aeration model at 462 m³ each

- **kind** wrong_param
- **found** flowsheet.js:124-143 — r1/r2 params list reactors, fill/aerate/settle/decant hours, feed_pump_m3_h, decant_TSS, SRT, MLSS, DO, denitrification, anoxic_fraction, temp — but no `volume_m3`. sbrReactor DEFAULTS.volume_m3 = 0, which is passed straight to aerationBasin; with volume ≤ 0 aerationBasin sizes the basin from sludge production and SRT (models/aerationBasin.js:93-99). Solved result: `volume_m3: 462, HRT_h: 37.57, sludge_inventory_kg: 1617` per reactor — 924 m³ of reactor for a 675 KLD plant, against `volume_per_fill_m3: 64.5`, i.e. a 14 % volumetric exchange ratio, which no SBR runs at. Every other vessel on the sheet has an explicit volume (eqt 225, int_wt 150, sht 25, swt/irr_wt/fwt 100, ct 5, sintex 1, ogt 0.1); R1/R2 are the only ones without.
- **proposal says** The flowsheet's own header contract (flowsheet.js:19-21) names the tanks whose volumes are unstated and therefore assumed — "EQT, INT-WT, SHT, IRR-WT, FWT and SWT" — and R1/R2 are absent from that list even though slide 6 (processes.js, area 'R', spec.tanks: 'Reactor tanks R1 and R2') gives no dimensions either. Slide 22 states the cycle that fixes the batch volume: 43 m³/hr × 1.5 h fill = 64.5 m³ decanted per cycle.
- **suggested fix** Add `volume_m3` to r1 and r2 params with a `data.assumption` in the same style as the other tanks, e.g. `volume_m3: 215` (64.5 m³ exchange at a 30 % decant fraction — the conventional SBR basis) and note that the proposal states no reactor dimensions. That also makes `HRT_h` and `sludge_inventory_kg` meaningful instead of artefacts of a continuous-basin sizing correlation.

### The two 'critical' reactor cycle-capacity alarms watch a static parameter equal to their own limit, so they cannot fire on the backlog the flow is computing right now

- **kind** diagram_gap
- **found** backend/src/seeds/itcStp.js:50-59 seeds `R1/R2 cycle capacity exceeded — feed backing up (slide 22)` as `targetType: 'param', paramKey: 'fill_h', min: 1.5, severity: 'critical'`. fill_h is authored at exactly 1.5 (flowsheet.js:129/139); the evaluator's breach test is strict (`value < Number(rule.min_value)`, alarms/evaluator.js:59-61), and `param` targets read `ctx.nodeParams[nodeId][paramKey]` — a static config value, never a solved metric. So the rule is permanently normal. Meanwhile the solved sheet reports `backlog_m3_d: 62.2` and `capacity_utilisation_pct: 121.1` on BOTH reactors, and the solver emits 'SBR cycle can pass 295 m³/d — 62 m³/d of feed has no cycle slot' twice. alarms/validTargets.js only admits numeric keys of a model's DEFAULTS plus Stream fields, and `backlog_m3_d` / `capacity_utilisation_pct` are metrics, not DEFAULTS keys — so no legal alarm target exists for the condition these rules are named after.
- **proposal says** narrative.js raises `narrative.sbr.capacity` at HIGH severity — the stated 1.5/2/1/0.75 h cycle passes 589.7 m³/d against 675 KLD design influent (slides 4, 5 and 22). That is the plant's top process finding, and the seed's own header says rules are only created 'on targets the flowsheet genuinely exposes'.
- **suggested fix** Add a `metric` targetType to backend/src/alarms/validTargets.js (targets drawn from `unitResults[nodeId].metrics` numeric keys, resolved the same way params are) and retarget the two seeded rules onto `r1/r2 · capacity_utilisation_pct` with `max: 100`, or `backlog_m3_d` with `max: 0`. Leaving the fill_h rule as-is is fine as a config-drift guard, but rename it so it does not claim to detect feed backing up.

### The softener outlet flow meter SOF-FT-701 — one of the 7 scheduled flow-meter AI points — has no instrument node anywhere on the flow

- **kind** missing_node
- **found** `buildTagList()` yields 17 AI rows; the 7 flow_meter rows are RFP-FT-201.FT, FFP-FT-501/1.FT, FFP-FT-501/2.FT, SOF-FT-701.FT, HWT-FT-901.FT, FWT-FT-1001.FT, SWT-FT-1101.FT. D:\watersim-pro\Documents\watersim-pro\watersim_session16\backend\src\plants\itcStp\flowsheet.js contains exactly seven opType:'instrument' nodes — ft_201, ft_acf, at_601, ft_swt, ft_irr, ft_mf, ft_fwt — i.e. six flow meters plus one pH. SOF-FT-701 appears only as a string in the `sof` node's data.tags (['SOF-BV-701','SOF-FT-701']); waterSoftener.js has no `measurement`/`range_min`/`range_max` parameter and emits no reading, so nothing on the sheet measures softener flow. Telling detail: six flow meters is exactly the PRICED count on slide 16 (proposal.js PRICED_QUANTITIES.flow_ph = 7, detail 'Flow meter 6, pH sensor 1'), not the 8 the process tables list — so the flowsheet has silently adopted the under-priced count that ioSchedule.reconcile() itself raises as finding `qty.flow_ph` ('8 on the equipment list, 7 priced').
- **proposal says** processes.js process 7 'Softener Feed Process' (slide 10) lists device { tag: 'SOF-FT-701', qty: 1, name: 'Softener outlet flow meter', kind: 'flow_meter', printed: { AI: 1 } } and spec.meters: 'Softener flow'. The schematic shows SOF with a PERMEATE line out to SWT.
- **suggested fix** Add an instrument node on the softener permeate line and split the existing edge: node('ft_sof', 'instrument', 'FT-701 — Softener outlet flow', V(4200, 30), { area: 'SFP', tags: ['SOF-FT-701'], source: 'Slide 10 — softener outlet flow meter (1 AI)', params: { measurement: 'flow', range_min: 0, range_max: 600, tag: 'SOF-FT-701' } }) — 600 m³/d spans the softener's stated 20 m³/hr rating. Then replace edge('e_sof_swt','sof','swt') with edge('e_sof_ftsof','sof','ft_sof') and edge('e_ftsof_swt','ft_sof','swt'), leaving the `concentrate` regeneration-reject edge untouched. If the intent really is to draw only the priced six, say so in a data.note on `sof` rather than leaving the tag dangling.

### ft_acf reports itself as tag 'FFP-FT-502', a tag that exists in no process table and in none of the 339 derived signals

- **kind** wrong_param
- **found** flowsheet.js line 198: `params: { measurement: 'flow', range_min: 0, range_max: 600, tag: 'FFP-FT-502' }`. A repo-wide grep for FFP-FT-502 returns exactly one hit — that line. processes.js process 5 has a single flow-meter row { tag: 'FFP-FT-501', qty: 2, name: 'Micron filter + ACF/MGF flow meters' }, so ioSchedule expands it to FFP-FT-501/1.FT and FFP-FT-501/2.FT and there is no 502. Running the solver, ft_acf's metrics come back as {reading: 317.032, tag: 'FFP-FT-502'} — the value a SCADA/PLC binding would key on resolves to no I/O point. The existing regression test at D:\watersim-pro\Documents\watersim-pro\watersim_session16\backend\src\__tests__\itcPlant.test.js:286 ('only cites device tags that exist in the equipment list') checks data.tags only and never looks at params.tag, so this passes CI.
- **proposal says** processes.js slide 8 device row FFP-FT-501 qty 2; the node's own data.tags correctly says ['FFP-FT-501'], so params.tag contradicts the same node's tag list.
- **suggested fix** In flowsheet.js line 198 set `tag: 'FFP-FT-501/2'` (and correspondingly line 277 on ft_mf to `tag: 'FFP-FT-501/1'`) so each meter names the unit tag ioSchedule actually emits; at minimum set ft_acf's params.tag to 'FFP-FT-501' to match its own data.tags. Extend the itcPlant test to check `params.tag` against the buildTagList deviceTag/unit-tag set as well as data.tags.

### The softener's overflow / backwash to IRR-WT is absent — SOF has only two outlets where the proposal names three

- **kind** missing_edge
- **found** processes.js process 7 (Softener Feed, slide 10) declares outputs: ['Soft water tank (SWT)', 'Overflow to IRR-WT', 'Regeneration to reject']. flowsheet.js has exactly two edges out of `sof`: e_sof_swt (plain -> swt) and e_sof_reject (role 'concentrate' -> reject_out). There is no sof -> irr_wt edge anywhere in EDGES. Solved flows: e_sof_swt Q=178.22, e_sof_reject Q=5.40, so 100 % of soft water goes to the cooling tower and nothing can be diverted.
- **proposal says** Narrative section VI step 7 (slide 23), verbatim: 'When the SWT reaches its full level, the excess or overflow water is automatically redirected from the SOF to the IRR-WT.' The slide-3 schematic labels the SOF outlets 'PERMEATE' and 'BACKWASH TO IRR-WT & REGENERATION TO REJECT'. processes.js process 7 lists it as a named output.
- **suggested fix** Add `edge('e_sof_irr', 'sof', 'irr_wt', { label: 'SWT high-level overflow to IRR-WT' })` and give `sof` a splitRatios param on its two plain outlets (e_sof_swt, e_sof_irr) — otherwise the solver will warn and split 50/50. The SWT-LT-1101 high-level interlock named in VI.7 is the divert permissive, so a documented assumption ratio (e.g. [0.9, 0.1]) belongs in sof.data.assumption.

### 124.4 m³/d — 18 % of the influent — leaves the mass balance at R1/R2 with no boundary and no unroutedLosses entry

- **kind** unrouted_stream
- **found** Measured: influent 675.00 m³/d, sum of summary.boundaries 550.48, summary.unroutedLosses 0.147 → 124.37 m³/d unaccounted. Per-node balance shows r1 and r2 each take 357.05 and emit 294.86 (288.21 decant + 6.65 WAS), losing 62.19 each. sbrReactor.js line ~102 does `Q_treated = Math.min(Q_in, capacity)` and the backlog is discarded — it is warned in text ('62 m³/d of feed has no cycle slot') but never becomes a Stream, so it appears in neither summary.unroutedLosses nor summary.boundaries. A printed PFD drawn from this data would show an EQT that cannot balance.
- **proposal says** proposal.js DESIGN_FLOW_KLD = 675 (100 + 475 + 100). narrative.js cycleAnalysis() already computes the SBR passes only 589.7 m³/d and raises narrative.sbr.capacity at high severity — but it computes the shortfall as 85.3 m³/d against the raw 675 KLD, whereas the flowsheet actually feeds the reactors 714.10 m³/d because the four recycle returns (centrate 13.05, ACF backwash 6.00, MGF backwash 5.00, UFBP 15.13 = 39.18 m³/d) are added at EQT. The real shortfall is 124.4 m³/d, 46 % larger than the narrative states.
- **suggested fix** Two parts. (a) Give the surplus a named boundary so the sheet closes: add an `outlet` node (e.g. `eqt_overflow`, discharge_type 'reject', label 'EQT overflow / tankered out') fed from `eqt` and give `eqt` splitRatios across its two plain outlets, with the ratio recorded in eqt.data.assumption. (b) Correct narrative.cycleAnalysis() to compute the shortfall against the recycle-loaded reactor feed (714 m³/d), not the raw 675 KLD design flow — the recycle load is what pushes requiredFeedPump_m3_h past the stated 43 m³/hr.

### The SHT sludge discharge pump (SHT-P-401) has no node — the sludge holding tank feeds the poly dosing skid directly

- **kind** missing_node
- **found** The unused-tag command returns SHT-P-401 among four uncited tags. In flowsheet.js the sludge train is sht (l.153) → poly_dose (l.158) → centrifuge (l.162) via `edge('e_sht_poly','sht','poly_dose')` (l.353) — no pump node between the tank and the dosing skid. poly_dose cites SHT-P-411, centrifuge cites SHT-P-421 and SHT-XV-401, sht cites only SHT-LT-401. Nothing carries SHT-P-401, so its 3 signals (SHT-P-401.XS / .XA / .XC) are 3 of the 27 rows in the 339-signal tag list with no node to bind to.
- **proposal says** processes.js process 4 (slide 7) lists `{ tag: 'SHT-P-401', qty: 1, name: 'Sludge discharge pump', kind: 'pump' }` and its spec names the duty: 'Discharge 2 m³/hr @ 35 m (Roto)'. The slide-3 schematic draws SHT → screw/discharge pump → POLY DOSING → CENTRIFUGAL.
- **suggested fix** Insert node('sht_p','pump','SHT — Sludge discharge pump', V(2560,470), { area:'SHT', tags:['SHT-P-401'], source:'Slide 7 — 2 m³/hr @ 35 m, Roto', params:{ running:1, speed_pct:100, capacity_m3_d:48, head_m:35 } }) and rewire e_sht_poly as sht → sht_p → poly_dose. 48 m³/d is 2 m³/hr × 24, matching the printed duty; the current SHT feed is 13.3 m³/d so nothing is throttled.

### The softener's stated overflow to IRR-WT is not routed — SOF has only SWT and reject outlets

- **kind** missing_edge
- **found** flowsheet.js gives sof exactly two outgoing edges: `edge('e_sof_swt','sof','swt')` (l.381) and `edge('e_sof_reject','sof','reject_out',{role:'concentrate'})` (l.382). swt has one outgoing edge, to swt_cl (l.383). No edge anywhere targets irr_wt from sof or swt — grep of EDGES shows irr_wt is fed only by e_ffpvo_garden (from ffp_v_out) and e_ph_irr (from at_601). Consequence: in the solved sheet SWT takes 178.2 m³/d with nowhere to go on high level, so the SWT high-level interlock has no modelled destination.
- **proposal says** processes.js process 7 (slide 10) lists softener_feed outputs as ['Soft water tank (SWT)', 'Overflow to IRR-WT', 'Regeneration to reject'] — three, of which the flow has two. narrative.js section VI step 7 states verbatim: 'When the SWT reaches its full level, the excess or overflow water is automatically redirected from the SOF to the IRR-WT.' The slide-3 schematic labels SOF 'BACKWASH TO IRR-WT & REGENERATION TO REJECT'.
- **suggested fix** Add `edge('e_sof_irr','sof','irr_wt',{ label:'Overflow to IRR-WT on SWT high level' })` (or from swt if the overflow is taken off the tank) and put a splitRatios on sof — e.g. params.splitRatios:[0.9,0.1] with a data.assumption noting the proposal states no share — so the solver does not fall back to an even 50/50 split across the two plain outlets.

### Edges carry no service class; the renderer infers one and gets 4 of the 12 non-water lines wrong

- **kind** diagram_gap
- **found** backend/src/plants/itcStp/flowsheet.js: edge() only ever writes streamType / role / isRecycle / label. Distribution over the 60 edges: streamType 'stream' ×53, was ×2, thickened ×1, filtrate ×1, backwash ×2, concentrate ×1. frontend/src/components/canvas/StreamEdge.jsx serviceOf() classifies with `if (data?.isRecycle || (data?.streamType && data.streamType !== 'stream')) return 'recycle'` — so every role-bearing edge collapses to the amber recycle class, gets the reversed midspan ISA triangle and a label reading 'RAS: n m³/d'. Running the sheet and applying serviceOf gives: 48 water, 7 recycle, 3 sludge, 1 chemical, 1 dead. Mis-classed: e_r1_stp and e_r2_stp (WAS 6.7 m³/d at 3500 mg/L, a forward sludge line to the STP pump — drawn backwards as recycle), e_cent_solids (0.25 m³/d of 180,000 mg/L cake to the skip — drawn as recycle AND dead, so the cake export prints as a 1 px grey dashed line labelled 'RAS: 0 m³/d'), e_sof_reject (5.4 m³/d regeneration reject to a boundary — drawn as a backwards recycle). SERVICES.air is unreachable (its only trigger is srcOp === 'blower' and the blowers node has zero edges) and SERVICES.permeate is unreachable (it needs TSS < 5 and e_uf_sintex solves at TSS 9.1). Net result: 48 of 60 lines print in one identical mid-blue, so raw 260 mg/L sewage (e_sewage_eqt) and finished flush water (e_ft_flush) are the same line on the page.
- **proposal says** The schematic distinguishes raw influent, decant, sludge, backwash, air (125 mm SS-304 header), chemical dosing and product-water headers as separate services; processes.js spec.pipe names a different material and size per service (UPVC raw/sludge, CPVC 80 mm frontal, SS-304 air).
- **suggested fix** Add an explicit `service` to the edge() opts and to edge.data, with the ITC service set {raw, treated, sludge, air, chemical, backwash, permeate, reject, recycle}, and make StreamEdge.serviceOf() read `data.service` first and only fall back to the current inference. Set service:'sludge' on e_r1_stp/e_r2_stp/e_stpv_stpp/e_stpp_sht/e_sht_poly/e_poly_cent/e_cent_solids, service:'reject' on e_sof_reject, service:'backwash' on e_acf_bw/e_mgf_bw, service:'permeate' on e_uf_sintex, service:'raw' on e_kitchen_ogt/e_sewage_eqt/e_laundry_ct/e_ct_elpv.

### Only 3 of 60 streams carry a pipe size, and it is buried in a free-text label the renderer never draws

- **kind** diagram_gap
- **found** Of the 60 edges, 13 have data.label and only 3 of those contain a size: e_ogt_eqt '150 mm UPVC', e_sewage_eqt '150 mm UPVC', e_elpvo_eqt '65 mm UPVC'. 44 edges have neither a label nor a role. There is no `size_mm`, `dn`, `material` or `spec` field anywhere in edge.data (the only keys used across all 60 edges are streamType, label, role, isRecycle). Worse, `data.label` is dead data: grepping frontend/src/components/canvas shows data.label read only in UnitOpNode (node title) and symbols/inlet.jsx (SVG <title>); StreamEdge renders only `Q: n m³/d` or `RAS: n m³/d`, so even the three authored sizes never reach the page.
- **proposal says** The schematic labels almost every run: 150 mm UPVC (OGT→EQT, sewage→EQT), 50 mm UPVC (CT→ELP), 65 mm UPVC (ELP→EQT), 100 mm UPVC (RFP discharge) with a REDUCER 3"×2" at the flow meter, 80 mm UPVC (STP→SHT), 50 mm UPVC (SHT overflow), 100 mm overflow (R1/R2 decant→INT-WT), 80 mm CPVC to the micron filter and to ACF & MGF, 80 mm CPVC frontal piping and micro-filter backwash, 50 mm CPVC (UF permeate→Sintex), 25 mm tanker take-off, 125/100/25 mm SS-304 air. processes.js repeats them per area in spec.pipe ('UPVC 50 mm', 'UPVC 100 mm', 'UPVC 80 mm', 'CPVC 80 mm frontal piping', 'UPVC 50 mm · CPVC 80 mm micro-filter backwash').
- **suggested fix** Extend edge() with `size_mm` and `material` (and an optional `note` for the 3"×2" reducers on e_rfpvo_ft and the FFP legs), populate from processes.js spec.pipe per area and from the schematic run labels, and render them as a second line under the flow tag in StreamEdge's EdgeLabelRenderer block. Start with the runs the proposal states outright: e_ct_elpv 50/UPVC, e_rfpp_rfpvo and e_rfpvo_ft 100/UPVC, e_stpp_sht 80/UPVC, e_r1_int and e_r2_int 100, e_int_cl 100/UPVC, e_ffpvo_acf and e_ffpvo_mf 80/CPVC, e_ftacf_acf→e_mgf_ph 80/CPVC, e_uf_sintex 50/CPVC.

### None of the three bar chambers exist, so 475 KLD of raw sewage enters EQT unscreened

- **kind** missing_node
- **found** flowsheet.js wires in_kitchen → ogt, in_sewage → eqt and in_laundry → ct directly. No node has opType 'screen'/'screening' anywhere (opType census: inlet 3, oil_grease_trap 1, equalisation_tank 8, valve 9, pump 10, instrument 7, blower 1, sbr_reactor 2, polymer_dosing 1, sludge_centrifuge 1, outlet 5, chlorination 2, activated_carbon_filter 1, multigrade_filter 1, water_softener 1, micron_filter 1, uf_membrane 1). The sewage stream reaches EQT carrying its full authored TSS of 260 mg/L with no screenings removed and no screenings export drawn.
- **proposal says** Schematic slide 3 draws a bar chamber on each of the three influents with dimensions and MOC: kitchen 400×500 mm SS304 qty 2, sewage 600×1000 mm SS304 qty 2, laundry 400×500 mm SS304 qty 2. Narrative I.2 ('Filter to be cleaned periodically', marked as a manual task) is about them. Related: the CT node derives its 5 m³ working volume from 'CT 600 × 1000 mm', but on the schematic 600×1000 mm is the *sewage* bar chamber, not the laundry collection tank — worth settling when the chambers are added.
- **suggested fix** Add three `screen` nodes ahead of their receivers — bar_kitchen (in_kitchen → bar_kitchen → ogt), bar_sewage (in_sewage → bar_sewage → eqt), bar_laundry (in_laundry → bar_laundry → ct) — each with params { screenType: 'coarse' }, data.area 'ELP', an assumption noting the bar spacing is not stated, and a `screenings` role edge to a shared screenings-skip outlet. Record the 400×500 / 600×1000 mm footprints and MOC SS304 in the node params so the PFD block can print them.

### The softener's backwash / overflow line to IRR-WT is drawn by the proposal three times and wired nowhere

- **kind** missing_edge
- **found** sof has exactly two outgoing edges: e_sof_swt (plain forward, 178.2 m³/d to SWT) and e_sof_reject (role 'concentrate', 5.4 m³/d to reject_out). There is no sof → irr_wt edge. IRR-WT is fed only by e_ffpvo_garden (the FFP bypass) and e_ph_irr (40 % off the pH analyser), so the SWT-full interlock has nowhere to divert to and SWT would simply overflow.
- **proposal says** Three independent statements: (a) the schematic — 'SOF has PERMEATE out, BACKWASH TO IRR-WT & REGENERATION TO REJECT'; (b) processes.js process 7 (softener_feed, slide 10) outputs: ['Soft water tank (SWT)', 'Overflow to IRR-WT', 'Regeneration to reject']; (c) narrative.js section VI step 7, slide 23 — 'When the SWT reaches its full level, the excess or overflow water is automatically redirected from the SOF to the IRR-WT', interlock 'SWT at high level', devices SWT-LT-1101 + SOF-BV-701.
- **suggested fix** Add edge('e_sof_irr', 'sof', 'irr_wt', { label: 'Backwash / overflow to IRR-WT' }) and, because that makes sof a two-plain-outlet node, add splitRatios to sof.params with an assumption noting the proposal states no diversion fraction — otherwise the solver warns and splits 50/50, and the itcPlant.test.js assertion 'leaves no plain forward split without an explicit ratio' fails.

### The four EQT return lines are drawn as straight chords through 4–9 equipment cards each, with no routing field to fix it

- **kind** diagram_gap
- **found** StreamEdge uses getStraightPath (deliberately, per its own header comment) from the source's right handle to the target's left handle, and edge.data has no waypoint/lane field. Intersecting each recycle's straight segment against the 168×116 px node cards: e_acf_bw (2390 px) passes through rfp_v_in, rfp_p, rfp_v_out, ft_201, r1, int_wt, cl_dose, ft_acf; e_mgf_bw (2570 px) through those plus acf — 9 cards; e_cent_eqt (2027 px) through rfp_v_in, rfp_p, r2, sht, poly_dose; e_ufbp_eqt (3140 px) through rfp_v_in, rfp_p, r2, centrifuge. Every one of them re-enters EQT from the right at its left handle, so the line also doubles back over itself at the tank.
- **proposal says** The schematic keeps its returns clear of the process band — the ACF/MGF 'BACKWASH TO EQT' drops out of the bottom of each vessel, and the centrate and UF backwash return along the bottom of the drawing. A single-page PFD is only legible if the recycles run in a reserved lane.
- **suggested fix** Add an optional `waypoints: [{x,y}, …]` to the edge() opts and have StreamEdge build a polyline through them when present (keeping getStraightPath for edges without waypoints, so no existing sheet re-routes). The lowest node on this sheet is ufbp at y 560 (bottom 676), so route all four returns down to a common y ≈ 730 return header and back up into EQT: e.g. e_acf_bw waypoints [{x:3284,y:730},{x:1064,y:730}].

## Medium severity (59)

### The polymer dosing node has no chemical_type, so it is solved as alum and removes 6 % of the phosphorus in the sludge line

- **kind** wrong_param
- **found** `poly_dose` params are `{ dose_mg_L: 4 }` only (flowsheet.js:158-161). chemicalDosing's DEFAULTS set `chemical_type: 'alum'`, and the solved metrics come back `{"chemical_type":"alum","dose_kg_d":0.1,"TP_in_mg_L":15,"TP_out_mg_L":14.08,"TP_removal_pct":6.1}` with TSS lifted 3500 → 3501 by phantom Al(OH)₃ floc. The model already supports the right chemical — CHEMICAL_COEFFICIENTS.polymer is `{ TP_removal_per_mg_L: 0, TSS_increase_per_mg_L: 0 }` (backend/src/simulation/models/chemicalDosing.js) — and the sheet's other two dosing nodes DO set the type (`chemical_type: 'chlorine'` on cl_dose and swt_cl). This also contradicts the plant's own published finding `quality.no_p_removal` (index.js), which states 'no alum or ferric dosing appears in any process area' while the solver is quietly running alum coagulation in the sludge train.
- **proposal says** Slide 7: the device is 'SHT-P-411 — Poly dosing pump', Milton 0–30 lph with a 500 L tank; it is polymer conditioning ahead of a decanter centrifuge, not a coagulant.
- **suggested fix** Add `chemical_type: 'polymer'` to the poly_dose params. Verified in memory: metrics become `{"chemical_type":"polymer","TP_removal_pct":0}` and the spurious TSS gain disappears.

### Only the STP inlet valves are on the sheet — STP-XV-301 is a set of four covering inlet AND outlet

- **kind** missing_node
- **found** processes.js:149 lists `{ tag: 'STP-XV-301', qty: 4, name: 'STP PP & SP inlet + outlet valves' }`, but the flowsheet has a single node `stp_v_in` labelled 'STP inlet valves (2)' (flowsheet.js:146) and goes straight `stp_p → sht` (flowsheet.js:352). Two of the four actuated valves — 4 DI and 2 DO on the schedule — have no position on the flow. Every other pump set in the sheet models both groups: elp_v_in/elp_v_out, rfp_v_in/rfp_v_out, ffp_v_in/ffp_v_out.
- **proposal says** Schematic slide 3: 'R1/R2 -> STP sludge transfer pump set (2 pumps, in/out valves) -> 80 mm UPVC -> SHT'. Slide 6 device row STP-XV-301, qty 4, 'inlet + outlet valves'.
- **suggested fix** Add `node('stp_v_out', 'valve', 'STP outlet valves (2)', V(2370, 470), { area: 'R', tags: ['STP-XV-301'], source: 'Slide 6', params: { open: 1, opening_pct: 100 } })`, re-target `e_stpp_sht` to it and add `edge('e_stpvo_sht', 'stp_v_out', 'sht', { label: '80 mm UPVC' })`.

### SHT-BV-301, the two sludge tank ball valves, appear on no node

- **kind** missing_tag
- **found** processes.js:152 lists `{ tag: 'SHT-BV-301', qty: 2, name: 'Sludge tank ball valves', kind: 'ball_valve', printed: { DI: 4, DO: 2 } }` in the Reactor Process area. A full cross-check of device tags against flowsheet `data.tags` shows SHT-BV-301 cited nowhere — the `sht` node carries only `['SHT-LT-401']` (flowsheet.js:154). Four DI and two DO in the I/O schedule have no corresponding position on the flowsheet, so a PLC binding built from the canvas cannot place them.
- **proposal says** Slide 6 Reactor Process device table, SHT-BV-301 qty 2; the schematic shows the sludge line into and out of SHT valved.
- **suggested fix** Either add the two ball valves as a node on the SHT connections (e.g. `node('sht_bv', 'valve', 'SHT ball valves (2)', …, { area: 'R', tags: ['SHT-BV-301'], params: { open: 1, opening_pct: 100 } })` between `stp_v_out` and `sht`), or, if they are the SHT isolation pair, add `'SHT-BV-301'` to the `sht` node's tags so the schedule at least resolves to a vessel.

### SHT-XV-401 (sludge outlet valve) is parked on the centrifuge node, two units downstream of where it sits

- **kind** missing_tag
- **found** flowsheet.js:163 gives the centrifuge `tags: ['SHT-P-421', 'SHT-XV-401']`. SHT-XV-401 is named 'Sludge outlet valve' (processes.js:180) — it is the valve on the SHT outlet feeding the discharge pump, not a device on the centrifuge skid. It was evidently parked there because no node exists between SHT and the poly skid (see the SHT-P-401 finding). Anything that renders equipment from `data.tags` — the canvas, the PLC binding, a printed PFD — will draw the sludge outlet valve at the dewatering machine.
- **proposal says** Slide 7 device table: SHT-XV-401 'Sludge outlet valve', 1 off, in the Sludge Process area whose input is 'Sludge holding tank (SHT)'; the schematic valves the SHT outlet ahead of the discharge pump.
- **suggested fix** When adding `sht_p`, move `'SHT-XV-401'` off the centrifuge onto a valve node (or onto `sht_p` itself) between `sht` and the discharge pump, leaving the centrifuge with `tags: ['SHT-P-421']`.

### The grease the OGT skims has no destination — it leaves the flowsheet as an unaccounted boundary loss

- **kind** unrouted_stream
- **found** models/oilGreaseTrap.js returns { effluent, screenings, metrics } and its header states the skimmed grease 'leaves as a `screenings` stream — the solver already knows that role — so the trap's collection duty appears on the canvas instead of vanishing'. But EDGES[] has exactly one edge leaving ogt, e_ogt_eqt, which is a plain forward (effluent) edge; there is no role:'screenings' edge from ogt. Running runSteadyState(buildFlowsheet(), { nodeParams: buildNodeParams() }) produces the warning "Unrouted side stream 'screenings' from ogt (Q=0.07 m³/d) — counted as a plant-boundary loss" and summary.unroutedLosses carries { node: 'ogt', stream: 'screenings', Q_m3_d: 0.072, TSS_kg_d: 10.875, BOD_kg_d: 0.174 }. The ogt metrics also report fog_removed_kg_d 6.38 and days_between_cleanout 0.4 with nowhere for that material to go. The comparable solids stream on the sludge train is routed properly: e_cent_solids carries role 'thickened' into the solids_out outlet node.
- **proposal says** Slide 3 draws the OGT as a collected-grease vessel on the kitchen line (dark red, before the 150 mm UPVC run to EQT); grease removal is a real, recurring plant output that the material balance and any printed PFD must show a destination for, exactly as 'DISCHARGE (solids)' is drawn off the centrifuge.
- **suggested fix** Add an outlet node — e.g. node('grease_out', 'outlet', 'Skimmed grease to skip', V(230, 150), { area: 'ELP', source: 'Slide 3 — OGT grease collection', params: { discharge_type: 'solids' } }) — and edge('e_ogt_grease', 'ogt', 'grease_out', { role: 'screenings', label: 'Skimmed grease' }). If the bar chambers of finding 1 are added, point their screenings at the same outlet and rename it 'Screenings & grease to skip'.

### CT working volume of 5 m³ contradicts the derivation its own data.assumption states (600 × 1000 mm at 1 m depth is 0.6 m³)

- **kind** wrong_param
- **found** flowsheet.js lines 75-79: the ct node's assumption reads 'Working volume derived from the stated footprint at 1 m depth' with source 'Slide 4 — CT 600 × 1000 mm', yet params.volume_m3 is 5. 0.6 m × 1.0 m × 1.0 m = 0.6 m³, not 5 — a factor of 8.3. The sibling node proves the intended arithmetic is literal: ogt states 400 × 500 mm at an assumed 0.5 m depth and carries volume_m3 0.1, which is exactly 0.4 × 0.5 × 0.5. The value is load-bearing: equalisationTank.js turns it into usable_volume_m3 3.5, HRT_h 1.2 and the run warning 'ct: Only 0.6 h of surge capacity at a peak factor of 2.5 — the high-level switch trips within the hour'. At the derivation the assumption actually states, the same numbers become 0.42 m³ usable and roughly 6 minutes of holdup ahead of a 5 m³/hr pump.
- **proposal says** processes.js feed_water spec.tanks — 'OGT 400×500 mm · CT 600×1000 mm · EQT 400×500 mm' — is the only dimension the proposal gives for the CT, and it is what the assumption field cites.
- **suggested fix** Make the two agree. Either set params.volume_m3 to 0.6 (the stated footprint at 1 m depth) and let the surge warning stand as the real finding, or keep 5 m³ and rewrite the assumption to say what 5 m³ actually is — e.g. 'the footprint on slide 4 gives only 0.6 m³, too small to be a collection tank ahead of a 5 m³/hr pump; 5 m³ (1 h of the 100 KLD laundry flow) is assumed instead'.

### OGT and CT volumes are derived from figures the schematic labels as bar-chamber footprints, not vessel sizes

- **kind** wrong_param
- **found** processes.js feed_water spec.tanks prints three figures in order — OGT 400×500, CT 600×1000, EQT 400×500 — and the schematic prints the same three figures in the same order as the three bar chambers: kitchen 400×500 SS304, sewage 600×1000 SS304, laundry 400×500 SS304. The flowsheet already rejects the third one on sight (the eqt node ignores '400 × 500 mm' and assumes 225 m³), which is the reductio: the row cannot be tank sizes. It nevertheless takes the first two at face value — ogt volume_m3 0.1 from 400×500, ct volume from 600×1000 — and the consequences are material in the solve: ogt reports HRT_min 1.4 against rated_HRT_min 20, derate_pct 30, fog_removal_pct 25.5 (against the 85 % clean-trap figure the node itself sets) and days_between_cleanout 0.4, with the run warning 'ogt: Retention time is 1.4 min against a 20 min design'. The ogt node's assumption field documents the depth guess (0.5 m) but not the attribution — it reads the 400 × 500 as the trap's own footprint.
- **proposal says** Slide 3 puts 400×500 SS304 on the kitchen BAR CHAMBER, upstream of the OGT, and 600×1000 SS304 on the SEWAGE bar chamber — which is not on the CT's line at all (the CT sits on the laundry line, behind the 400×500 laundry chamber). On that reading the proposal states no working volume for either the OGT or the CT.
- **suggested fix** Move the three footprints onto the bar-chamber nodes added in finding 1 (400×500 kitchen, 600×1000 sewage, 400×500 laundry, all SS304, 2 nos), and restate the ogt and ct assumptions as 'the proposal states no working volume for this vessel; X m³ is assumed to give a workable HRT' — sizing the OGT for its own rated_HRT_min of 20 min at 100 KLD (about 1.4 m³) rather than leaving it derated to 30 % capture.

### UFBP is the only pump with a stated duty whose capacity_m3_d is left at 0 (unlimited), contradicting the 15 m3/hr nameplate

- **kind** wrong_param
- **found** flowsheet.js line 303: ufbp params { running:1, speed_pct:100, capacity_m3_d: 0, head_m: 15 } against source 'Slide 11 — 15 m3/hr @ 15 m, Grundfos, qty 2'. Every other stated-duty pump in the sheet converts the nameplate: elp_p 5 m3/hr->120, rfp_p 43->1032, stp_p 10->240, ffp_p 43->1032, sfp_p 43->1032, uffp 10->240. models/pump.js treats capacity_m3_d 0 as unlimited (Q_delivered = Q_in x speed/100) and CanvasPage.jsx labels the field 'Capacity m3/d (0=∞)', so the canvas shows the UFBP as an uncapped pump and it can never raise a blocked_Q warning however large the Sintex draw becomes. Only swtp/hwtp/fwtp share the 0, and for those the proposal states no duty at all.
- **proposal says** processes.js process 8, slide 11: pumps 'UFFP 10 m3/hr @ 25 m Grundfos qty 2 (1W + 1SB) · UFBP 15 m3/hr @ 15 m Grundfos qty 2'. The head (15 m) was taken from that same sentence; the capacity was not.
- **suggested fix** Set ufbp params.capacity_m3_d: 360 (15 m3/hr x 24 h), matching the sheet's own convention. It does not change today's balance (the Sintex split hands it 15.1 m3/d) but it makes the nameplate printable and makes an over-draw visible as blocked flow.

### The UFBP backwash branch is drawn with no inlet/outlet valves, and all four UF-XV-801 valves are attributed to the UFFP leg

- **kind** missing_node
- **found** The only valve node in the UF area is uf_v_in, labelled 'UFFP inlet valves (4)' with tags ['UF-XV-801'] (flowsheet.js line 284). UF-XV-811 is hung on the `ufbp` pump node's tags rather than on any valve node, so neither the UFFP discharge nor the Sintex->UFBP->EQT path carries a valve. Consequence, verified by re-solving with p.uf_v_in.open = 0: e_uf_sintex, e_sintex_fwt, e_sintex_ufbp, e_ufbp_eqt and e_ft_flush all go to 0.00 m3/d — closing the UFFP inlet valves also shuts the backwash draw, so the narrative's backwash step cannot be represented. Compare the sheet's convention elsewhere: ELP, RFP, FFP and SFP each get separate *_v_in and *_v_out nodes.
- **proposal says** processes.js process 8 (slide 11): UF-XV-801 qty 4 'UFFP & UFBP inlet valves' and UF-XV-811 qty 4 'UFFP & UFBP outlet valves' — both rows explicitly cover two pump sets. Narrative VII.6 stops the UFFP and closes UF-XV-801/811 on the feed side, then VII.7 opens UF-XV-801/811 on the UFBP side; the schematic draws the UFBP as '2 pumps + valves' exactly like every other pump set.
- **suggested fix** Split uf_v_in into uffp_v_in (2 valves, tag UF-XV-801) and uffp_v_out (2 valves, tag UF-XV-811) on mf->uffp->uf, and add ufbp_v_in (2, UF-XV-801) between sintex and ufbp plus ufbp_v_out (2, UF-XV-811) between ufbp and eqt, so the four scheduled valves of each row sit on the leg they actually isolate.

### The micron filter's assumed 300 mm housing cannot pass its assumed 20 m3/hr rating — it runs permanently pinned at the model's 40 % derate floor, silently

- **kind** wrong_param
- **found** mf params diameter_mm 300 + rated_flow_m3_h 20. models/pressureFilter.js computes area = 0.07 m2, HLR = 118.92 m/h against MEDIA.micron.rated_HLR_m_h = 20, so derate = max(0.4, 20/118.92) = 0.40 and TSS removal falls from 90 % to 36 % (solved metrics: HLR_m_h 118.92, derate_pct 40, TSS_removal_pct 36). No warning is raised, because the model's only warning tests Q/24 (8.4 m3/hr) against rated_flow_m3_h (20). A 300 mm housing at the media's own 20 m/h rating is 1.4 m3/hr, not 20 — the two assumed numbers are 14x apart. Re-running the same feed at diameter_mm 1130 gives HLR 8.38, derate 100 %, TSS removal 90 %.
- **proposal says** The proposal states no cartridge size, but it does state the duty of the line the vessel sits on: slide 11 UFFP is 10 m3/hr and the sheet sends 201.75 m3/d (8.4 m3/hr) down this leg. A vessel labelled '20 m3/hr' in its own params must be able to pass 8.4 m3/hr without derating.
- **suggested fix** Make the two assumed numbers consistent: either diameter_mm ≈ 1130 (1.0 m2 at 20 m/h = 20 m3/hr), or keep 300 mm and set rated_flow_m3_h: 1.4 and add a cartridge/vessel count. Update the assumption text to say which. Optionally note that the 40 % floor is being hit, since nothing warns.

### The UF node's params are just { screenType: 'micro' } — the 20 min / 1 min cycle it cites and the 92.5 % recovery it implies exist nowhere on the node

- **kind** diagram_gap
- **found** flowsheet.js line 291-294: node('uf', 'uf_membrane', ...) with source 'Slide 24 — 20 min production, 1 min flush backwash' but params { screenType: 'micro' } and no assumption field. No flux, membrane area, rated flow, recovery or cycle time is recorded. The recovery lives only as sintex splitRatios [0.925, 0.075]; narrative.cycleAnalysis().uf independently returns produced 228.6 m3/d, backwash 17.1 m3/d, recoveryPct 92.5. Compare r1/r2, which do carry their narrative cycle on the node (fill_h 1.5, aerate_h 2.0, settle_h 1.0, decant_h 0.75).
- **proposal says** Slide 24 section VII.5 states the production/backwash cycle; slide 11 states UFFP 10 m3/hr @ 25 m and UFBP 15 m3/hr @ 15 m. A printed PFD or equipment schedule for the UF skid needs a duty figure and a recovery; neither is on the unit that has them.
- **suggested fix** Add to uf.params: production_min: 20, backwash_min: 1, rated_flow_m3_h: 10, recovery_pct: 92.5 (with a note that the screen model ignores them and the recovery is applied at the Sintex split), so the cycle and the split cannot drift apart when either is edited.

### SFP outlet valves (SFP-XV-711, qty 3) exist on no node — the only pump set in the plant drawn with an inlet valve group but no outlet valve group

- **kind** missing_node
- **found** Cross-checking every device tag in processes.js against every node's data.tags leaves four orphans, one of them SFP-XV-711 ('PP, SP & outlet valves', qty 3, 6 DI / 4 DO printed). The flowsheet has sfp_v_in (SFP-XV-701) at line 215 and then goes straight sfp_v_in → sfp_p → sof (edges e_sfpv_sfpp, e_sfpp_sof, lines 379-380). Every comparable set is drawn with both halves: elp_v_in/elp_v_out, rfp_v_in/rfp_v_out, ffp_v_in/ffp_v_out.
- **proposal says** processes.js process 7 (slide 10) lists SFP-XV-701 and SFP-XV-711 as separate device rows. narrative.js section VI step 1 — 'The inlet and outlet of the Primary Pump (SFP) are switched ON', devices ['SFP-XV-701','SFP-XV-711'] — and step 5 closes both again. The narrative cannot be commissioned against the sheet because half the valves it drives are not on it.
- **suggested fix** Add `node('sfp_v_out', 'valve', 'SFP outlet valves (3)', V(4020, 30), { area: 'SFP', tags: ['SFP-XV-711'], source: 'Slide 10 — PP, SP & outlet valves', params: { open: 1, opening_pct: 100 } })` and re-wire e_sfpp_sof as sfp_p → sfp_v_out → sof (two edges), matching the elp/rfp/ffp pattern.

### The 1000 L brine tank and its agitator appear only in free text — no node, no parameter, nothing to check 135 kg/d of salt against

- **kind** missing_node
- **found** grep for 'brine' and 'agitator' across the plant module returns only prose: flowsheet.js line 16 (header), line 223 (sof's `source` string '… brine tank 1000 L'), narrative.js VI.6 note, processes.js spec strings, and the waterSoftener model's doc comment. The sof node's params are { resin_litres, capacity_g_per_L, feed_hardness_ppm, product_hardness_ppm, salt_g_per_L, regen_water_m3, rated_flow_m3_h } — no brine tank volume. The agitator is folded into the SFP-P-701 pump group tag on the sfp_p node, so it has no symbol of its own either. A solved run reports salt_per_regen_kg 75, salt_kg_d 134.96 and regenerations_per_day 1.8 with no vessel capacity to test them against (a 1000 L tank holds roughly 2 regenerations of saturated brine, so the make-up duty is tight and unverifiable from the data).
- **proposal says** Slide 3 draws the BRINE TANK (CAP 1000 Ltr, MAKE SINTEX/EQV) with an AGITATOR beside it as distinct equipment next to the SOF. processes.js process 7 spec.vessels: '… brine tank 1000 L Sintex' and spec.pumps: '… · agitator'; SFP-P-701 is qty 3 precisely because the agitator is the third driven item. The flowsheet header claims 'the Sintex and brine tank capacities' are among the values 'Stated by the proposal' and carried, but the brine capacity is carried nowhere as data (the 1000 L Sintex tank that IS a node, `sintex`, is the UF permeate tank, a different vessel).
- **suggested fix** Either add `brine_tank_m3: 1.0` (and `salt_storage_kg`) to the sof params so the softener's salt/regen-water metrics can be graded against the stated vessel, or add a small equipment node for the brine tank + agitator carrying tags ['SFP-P-701'] and params { volume_m3: 1.0 }, sourced 'Slide 10 — brine tank 1000 L Sintex with agitator'. At minimum the capacity must exist as a number, not only inside a `source` sentence.

### swt_cl is dosed as `chemical_type: 'chlorine'`, which no model recognises — it silently computes alum coagulation and is priced as a coagulant

- **kind** wrong_param
- **found** flowsheet.js line 238: params { chemical_type: 'chlorine', dose_mg_L: 0.5 }. chemicalDosing.js line 90 does `CHEMICAL_COEFFICIENTS[chemType] || CHEMICAL_COEFFICIENTS.alum`; the recognised disinfectant keys are 'naocl' and 'hypochlorite' — 'chlorine' is in neither the coefficient map nor the DEFAULTS comment. A solved run returns for swt_cl: TP_in 8.17 → TP_out 8.06, TP_removal_pct 1.4, sludge_kg_d 0 — i.e. phosphorus precipitation on a soft-water chlorination point, and it is why the cooling-tower water (TP 8.06) differs from the irrigation water (TP 8.17) for no physical reason. costEstimator.js then emits 'No unit price defined for dosing chemical chlorine — priced as coagulant (0.3 $/kg)'.
- **proposal says** Slide 3 draws a CI DOSING skid (0–12 LPH, Milton Roy, 200 L tank) on the SWT header, and processes.js process 11 lists it as the Cl dosing pump in SWT-P-1101; narrative section X and the slide-14 spec both describe chlorination, not coagulation. Nothing in the proposal doses alum anywhere in the plant.
- **suggested fix** Set `chemical_type: 'naocl'` (or 'hypochlorite') on swt_cl, and on cl_dose at line 180 for the same reason. Both then use the disinfection coefficients and the disinfectant price key instead of alum. While editing, consider carrying the stated skid data (`tank_litres: 200`, `pump_range_lph: [0, 12]`) as params — today they exist only in the node's `source` string.

### The FFP 'bypass to garden' is routed into IRR-WT, so unfiltered water is blended into the irrigation tank and counted by the irrigation water meter

- **kind** wrong_route
- **found** flowsheet.js line 365: `edge('e_ffpvo_garden', 'ffp_v_out', 'irr_wt', { label: 'Bypass to garden' })`. That leg is 10 % of the FFP discharge (splitRatios [0.55, 0.35, 0.10] on ffp_v_out) = 57.6 m³/d in a solved run, drawn from the FFP outlet header — upstream of ACF and MGF, so it has had chlorine but no filtration. It lands in irr_wt (total 180.1 m³/d) and therefore passes hwtp and ft_irr (HWT-FT-901 reads 180.06 m³/d) on its way to the irrigation outlet.
- **proposal says** Slide 3 draws the FFP outlet as three separate legs — '80mm CPVC → TO MICRON FILTER', 'BYPASS UPVC → TO GARDEN', '80mm CPVC → TO ACF & MGF FILTER' — with TO GARDEN as a terminal arrow, while IRR-WT is fed separately by an OVERFLOW from ACF/MGF. narrative.js V.2 names exactly three destinations off the filters: 'SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT' — the garden bypass is not one of them. The garden take-off has its own valve group in the ACF area (processes.js ACF-BV-611, 'Ball valve to EQT + BF valve to garden'), which is itself on no node.
- **suggested fix** Either terminate the bypass at its own boundary — add `node('garden_out', 'outlet', 'Garden bypass', …, { area: 'FFP', params: { discharge_type: 'water' } })` and re-target e_ffpvo_garden to it, so unfiltered water is graded as its own product stream rather than diluted into the metered irrigation supply — or, if blending into IRR-WT is intended, say so in a data.assumption on ffp_v_out (its current assumption covers only the 55/35/10 ratio, not the destination) and note that HWT-FT-901 then measures filtered + unfiltered water.

### The DP/DPSP dosing skid drawn at IRR-WT is represented nowhere — not on the flowsheet, not in the device list

- **kind** missing_node
- **found** grep -rni 'dpsp' across the repository returns no hit at all. irr_wt's only connections are two inflows (ffp_v_out, at_601) and one outflow (hwtp); there is no dosing node anywhere on the irrigation line, while both other product waters do have one (cl_dose on the INT-WT line, swt_cl on the SWT line).
- **proposal says** Slide 3 shows a DP/DPSP dosing skid beside IRR-WT, and DPSP is one of the orange equipment labels on the drawing (OGT, ELP, CT, EQT, RFP, R1, R2, STP, SHT, EQT2, FFP, INT-WT, ACF, MGF, SOF, SFP, SINTEX, SWTP, SWT, FWTP, FWT, UFBP, UF, UFFP, DPSP, HWTP, IRR-WT). Twenty-six of those twenty-seven labels resolve to a node; DPSP is the one that does not.
- **suggested fix** Add a dosing node on the IRR-WT line — e.g. `node('dp_dose', 'chemical_dosing', 'DP/DPSP dosing skid', V(3840, 250), { area: 'HWTP', source: 'Slide 3 — DP/DPSP dosing skid at IRR-WT', assumption: 'The proposal labels the skid but states no chemical, dose or tank size.', params: { chemical_type: 'naocl', dose_mg_L: 0.5 } })` between irr_wt and hwtp. If the skid is genuinely out of scope, record that on irr_wt as a note, because as it stands the drawing shows a device the plant model does not know exists — and it has no row in the I/O schedule either, so it is also unpriced if it is instrumented.

### ACF-BV-611 — the valve group that routes the filtered-water outlet — has no node anywhere on the sheet

- **kind** missing_node
- **found** Cross-checking every device tag in processes.js against every `data.tags` entry in flowsheet.js leaves four unrepresented devices: SHT-BV-301, SHT-P-401, SFP-XV-711 and ACF-BV-611. ACF-BV-611 is 'Ball valve to EQT + BF valve to garden', qty 3, printed 6 DI / 4 DO on slide 9 — ten wired points, all present in the 339-row tag list (ACF-BV-611/1..3), bound to no node. Every other valve group in this train does have a node: ELP-XV-101/111, RFP-XV-201/211, FFP-XV-501/511, ACF-XV-601 and MGF-XV-601 (on the filter nodes), SFP-XV-701, UF-XV-801/811/821. The two backwash-to-EQT lines and the garden take-off therefore have no valve on the canvas to bind, alarm or interlock.
- **proposal says** processes.js area 6 (slide 9) lists ACF-BV-611 'Ball valve to EQT + BF valve to garden' qty 3 among the ACF/MGF devices, and area 6 outputs are 'Softener system', 'Backwash to EQT', 'Bypass to garden'. Narrative V.2 (slide 23) names ACF-BV-611 as the device that effects the three-way split off the filters.
- **suggested fix** Add `node('acf_bv_out','valve','ACF/MGF outlet & backwash valves (3)', V(3560, 190), { area:'ACF', tags:['ACF-BV-611'], source:'Slide 9 — ball valves to EQT + butterfly valve to garden', params:{ open:1, opening_pct:100 } })` on the filtered-water header, and route the two backwash edges and the garden/tanker take-off through it.

### The micron filter's backwash has no edge and is written off as a plant-boundary loss

- **kind** unrouted_stream
- **found** The solver run reports `Unrouted side stream 'backwash' from mf (Q=0.07 m³/d) — counted as a plant-boundary loss`, and summary.unroutedLosses carries `{node:'mf', stream:'backwash', Q_m3_d:0.071, TSS_kg_d:1.471}`. pressureFilter.js always emits a `backwash` output; ACF and MGF both have theirs wired (`e_acf_bw` 6.00 m³/d, `e_mgf_bw` 5.00 m³/d, role 'backwash', recycle). The micron filter on the same header has no such edge, so 1.47 kg TSS/d leaves the balance at the boundary instead of returning to EQT.
- **proposal says** processes.js area 8 (slide 11) spec: `pipe: 'UPVC 50 mm · CPVC 80 mm micro-filter backwash'`. Slide 3 schematic shows '80mm CPVC/Micro Filter Backwash piping' at the UF skid with a 'BACKWASH TO EQT' arrow. The proposal pipes this stream; the flow does not carry it.
- **suggested fix** Add `edge('e_mf_bw','mf','eqt',{ role:'backwash', recycle:true, label:'Micron filter backwash to EQT' })` alongside the existing ACF and MGF backwash edges.

### The ACF/MGF flow meter carries instrument tag FFP-FT-502, which exists nowhere in the equipment list or the 339-signal schedule

- **kind** missing_tag
- **found** `ft_acf` has `tags: ['FFP-FT-501']` but `params: { … tag: 'FFP-FT-502' }` (flowsheet.js:197-198). processes.js has exactly one row — `FFP-FT-501` qty 2, 'Micron filter + ACF/MGF flow meters' — and ioSchedule.buildTagList() expands qty>1 as `<tag>/<unit>`, producing `FFP-FT-501/1.FT` and `FFP-FT-501/2.FT`. Grepping the whole backend and frontend for 'FFP-FT-502' returns only that one flowsheet line. Anything reading the instrument's own `params.tag` (PLC bindings, instrument.js metrics, which report `tag: 'FFP-FT-502'`) names a signal that is not in the schedule. The existing test 'only cites device tags that exist in the equipment list' in itcPlant.test.js checks `data.tags` only, so it does not catch this. Separately, `ft_mf.params.tag = 'FFP-FT-501'` is the shared *device* tag, so neither of the two meters is uniquely identified.
- **proposal says** Slide 8 prints two flow meters in the FFP area (2 AI) under one row, FFP-FT-501 qty 2; the I/O schedule derives FFP-FT-501/1 and FFP-FT-501/2 from it.
- **suggested fix** Set `ft_mf.params.tag = 'FFP-FT-501/1'` and `ft_acf.params.tag = 'FFP-FT-501/2'`, matching buildTagList's unit-tag format, and extend the itcPlant test to check `params.tag` as well as `data.tags`.

### Both FFP leg flow meters are ranged to 25 m³/hr while the pump feeding them is rated 43 m³/hr

- **kind** wrong_param
- **found** `ft_acf` and `ft_mf` both carry `range_min: 0, range_max: 600` (m³/d = 25 m³/hr). `ffp_p` is `capacity_m3_d: 1032` (43 m³/hr, Johnson, slide 8) and each leg has its own isolation valve in the FFP-XV-511 group of four. With the micron leg or the bypass shut — a normal operating case, and the reason those valves are actuated — the whole 1032 m³/d goes down one leg and the meter saturates; instrument.js then flags `out_of_range` and the reading is meaningless. Even with all three legs open at full pump duty the ACF/MGF meter sits at 0.55 × 1032 = 568 m³/d, 95 % of span. Compare `ft_201` on the identical 43 m³/hr RFP, correctly ranged 0–1200 m³/d (50 m³/hr, ≈1.2× duty).
- **proposal says** Slide 8 — FFP 43 m³/hr @ 8 m Johnson, with the meters on the two filter legs downstream of the four outlet valves. A transmitter span must cover the duty of the pump that can drive it.
- **suggested fix** Set `range_max: 1200` on both `ft_acf` and `ft_mf`, matching FT-201 and the 1032 m³/d pump they measure.

### The micron-filter/UF leg is dosed to 1 ppm chlorine but the sheet reports 0 ppm reaching the membranes

- **kind** wrong_param
- **found** Chlorine is dosed at `cl_dose` upstream of `ffp_v_in`, so all three FFP legs carry it. `acf` correctly declares `chlorine_in_ppm: 1.0` and its metrics show `chlorine_out_ppm: 0.05` (95 % dechlorination on carbon). `mf` declares no `chlorine_in_ppm`, so it takes the DEFAULTS value 0 and its metrics report `chlorine_in_ppm: 0, chlorine_out_ppm: 0, dechlorination_pct: 0` — while the water it actually passes (201.75 m³/d off `e_ffpvo_mf`) was dosed to 1 ppm and nothing on that leg removes it. pressureFilter.js's own header says as much: 'the plant doses chlorine into INT-WT upstream and then feeds UF membranes downstream — carbon is what protects the membranes from the chlorine the plant just added.' As routed, the carbon is on the other leg.
- **proposal says** Slide 23 narrative IV.2 doses chlorine at INT-WT to 0.5–1 ppm; slide 8 draws the micron-filter leg off the same FFP header; slide 11 puts UF membranes on it.
- **suggested fix** Set `mf.params.chlorine_in_ppm = 1.0` so the sheet shows the free chlorine actually reaching the UF membranes, and either add a dechlorination step on that leg or record it as an open item (see the UF-feed routing finding).

### The narrative gives the ACF/MGF outlet three destinations including the UF feed; the flow gives it two and takes UF off the raw FFP header instead

- **kind** wrong_route
- **found** `at_601` has exactly two outgoing edges — `e_ph_sfp` (60 %, 183.6 m³/d to the softener) and `e_ph_irr` (40 %, 122.4 m³/d to irrigation). The UF leg is taken upstream, at `ffp_v_out` → `ft_mf` → `mf`, so the micron filter receives unfiltered chlorinated INT-WT water at TSS 20.3 mg/L rather than the 1.8 mg/L the ACF/MGF outlet actually delivers. No node on this leg carries a `note` recording the divergence, though the file uses `note` for exactly this kind of proposal-internal contradiction on `blowers`, `cl_dose`, `swtp`, `hwtp`, `fwtp` and `ufbp`.
- **proposal says** Narrative V.2 (slide 23): 'The three processes from ACF and MGF filter are: SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT.' Narrative VII.1 (slide 24): 'Water from ACF and MGF filter flows into UF.' The slide-3 schematic contradicts both by drawing the micron-filter leg off the FFP outlet header — a divergence the sheet resolves silently in the schematic's favour.
- **suggested fix** Keep the schematic route, but add `note: 'Narrative V.2 and VII.1 feed the UF line from the ACF/MGF outlet; the slide-3 schematic takes it off the FFP header. The schematic is followed here — this is why the UF leg is unfiltered and still chlorinated.'` to the `mf` node. If the narrative is authoritative, re-source `e_ffpvo_mf` from `at_601` and make its split three ways.

### The surplus-water-to-tanker take-off on the filtered water header is not on the sheet

- **kind** missing_node
- **found** The filtered-water header downstream of ACF/MGF has only two consumers in the flow (softener 60 %, irrigation 40 %). There is no node with `discharge_type` for a tanker export, and the run's boundary set is water ×3 (irrigation, flush, cooling tower) + solids ×1 + reject ×1 — a tanker export would be a fourth water boundary and never appears in the water balance or in the graded outlet count.
- **proposal says** Slide 3 schematic, on the ACF/MGF frontal piping: 'There is an EXCESS/SURPLUS SUPPLY WATER TO TANKER 25mm take-off.' It is a drawn export from the plant that the flow does not represent.
- **suggested fix** Add `node('tanker_out','outlet','Surplus supply water to tanker', V(3750, 130), { area:'ACF', source:'Slide 3 — 25 mm surplus supply take-off to tanker', params:{ discharge_type:'water' } })`, an edge from the filtered-water header, and extend `at_601.params.splitRatios` to three legs with the tanker share marked as an assumption.

### The plant's only analyser is wired to the MGF outlet; the schematic puts it on the ACF outlet line

- **kind** wrong_route
- **found** `at_601` (tag ACF-AT-601, the single pH analyser in the whole 339-signal schedule) has one incoming edge, `e_mgf_ph` from `mgf`. With ACF → MGF in series the analyser therefore sits one vessel downstream of the carbon bed and never sees the ACF outlet — the point where the sheet computes the 95 % dechlorination (chlorine_out 0.05 ppm) that is the carbon bed's whole purpose. The device also lives in the ACF area (`ACF-AT-601`, slide 9), not a separate MGF area.
- **proposal says** Slide 3 schematic: 'A pH analyser box sits on the ACF outlet line.' Narrative V.1 (slide 23): 'From these filter tanks, the water flows to the pH' — the analyser reads the combined discharge of both vessels.
- **suggested fix** Once ACF and MGF are put in parallel, feed `at_601` from both vessels (`e_acf_ph` + `e_mgf_ph`) so it reads the combined outlet header, which is the line the schematic draws it on. If the series arrangement is retained for any reason, move the analyser between `acf` and `mgf` to match the drawing.

### The 125 mm SS-304 air header from the blowers to R1 and R2 is not on the sheet — the blowers node has no edges at all

- **kind** missing_edge
- **found** flowsheet.js:118-123 defines `blowers` and no edge in EDGES (lines 325-405) names it as source or target. The node's `note` says 'Carries air, not water, so it has no stream connection', but the canvas's own blower symbol contradicts that contract: frontend/src/components/canvas/symbols/blower.jsx links by edge in EITHER direction and explicitly refuses to turn without one ('With NO adjacent aeration node the rotor DOES NOT TURN … reports data-unlinked="true"'). I verified the fix is safe: adding `blowers → r1` and `blowers → r2` edges with `splitRatios: [0.5, 0.5]` on the blowers node leaves the run converged, degraded=false, influent 675.0 m³/d, effluent TSS 6.30 unchanged, r1/r2 Q_in 357 each, and produces no new solver warnings (blower resolves to `passthrough` via PALETTE_TYPE_MAP.blower = null, and a Q=0 stream mixes harmlessly).
- **proposal says** Slide 3: 'Above them runs a 125mm SS-304 air header from AIR BLOWERS … through 100mm SS-304 / 25mm SS-304 drops and pneumatic valves into each reactor.' Narrative II.6 'R1 tank corresponding valve open and then blower open' and II.10 'Switch ON the R2 Air Blower Valve and Pneumatic Valve then blower will run' both tie a specific blower to a specific reactor.
- **suggested fix** Add `edge('e_bl_r1', 'blowers', 'r1', { label: '125 mm SS-304 air header' })` and `edge('e_bl_r2', 'blowers', 'r2', { label: '125 mm SS-304 air header' })`, and give the blowers node `params: { splitRatios: [0.5, 0.5] }` so the two plain forward outlets do not trip the 'No splitRatios provided' warning the test suite asserts against (itcPlant.test.js:332). Pair with the AERATION_TYPES fix or the blower still renders UNLINKED.

### The air blowers carry no duty at all — 475 m³/hr @ 0.55 kg/cm² and the 2W+1SB count exist only as prose in `source`

- **kind** diagram_gap
- **found** flowsheet.js:118-123: `node('blowers', 'blower', 'Air blowers ×3 (2W + 1SB)', …, { area:'R', tags:['R-B-301','R-AV-301'], source:'Slide 6 — 475 m³/hr @ 0.55 kg/cm², Beta, qty 3', note:…, params: {} })`. Empty params. Every other item of rotating equipment on the sheet carries its stated duty in params (elp_p 120 m³/d @ 8 m, rfp_p 1032 @ 8 m, stp_p 240 @ 8 m, uffp 240 @ 25 m, ufbp head 15; the filters carry diameter_mm and rated_flow_m3_h). The reactors compute `O2_demand_kg_d: 112.6` each (225 kg/d total), and there is nothing in the data to compare that against the 950 m³/hr of installed working air.
- **proposal says** Slide 6 (processes.js area 'R', spec.blowers): '475 m³/hr @ 0.55 kg/cm², Beta, qty 3 (2W + 1SB)'. The schematic prints the same figures on the blower set. A printed PFD/equipment schedule needs air flow, discharge pressure, unit count and duty/standby split.
- **suggested fix** Add `params: { air_flow_m3_h: 475, discharge_kg_cm2: 0.55, units: 3, duty_units: 2, standby_units: 1 }`. `blower` resolves to passthrough so these are inert to the solver, but they are what the node card, the equipment schedule and the PFD print, and they let the 225 kg O2/d demand be checked against installed air.

### The sludge transfer pump set's outlet valves are missing — stp_p discharges straight into SHT although STP-XV-301 is a 4-valve inlet+outlet group

- **kind** missing_node
- **found** processes.js area 'R': `{ tag: 'STP-XV-301', qty: 4, name: 'STP PP & SP inlet + outlet valves', printed: { DI: 8, DO: 4 } }`. flowsheet.js has one node for it — `node('stp_v_in', 'valve', 'STP inlet valves (2)', …, { tags: ['STP-XV-301'] })` at line 146 — and edge `e_stpp_sht` (line 352) runs stp_p → sht directly. So a node labelled '(2)' claims a tag covering 4 valves and the other two are nowhere on the sheet. Every other pump set on the reactor-feed side is drawn with both groups: elp_v_in/elp_v_out, rfp_v_in/rfp_v_out, ffp_v_in/ffp_v_out.
- **proposal says** Slide 3: 'R1/R2 -> STP sludge transfer pump set (2 pumps, in/out valves; CAP 10m3/hr@8m JOHNSON 2(1W+1SB)) -> 80mm UPVC -> SHT'. Slide 6 prices 8 DI / 4 DO for the group, i.e. four actuated valves.
- **suggested fix** Add `node('stp_v_out', 'valve', 'STP outlet valves (2)', V(2370, 470), { area: 'R', tags: ['STP-XV-301'], source: 'Slide 6', params: { open: 1, opening_pct: 100 } })`, retarget `e_stpp_sht` to stp_v_out and add `edge('e_stpvo_sht', 'stp_v_out', 'sht', { label: '80 mm UPVC' })`. Relabel stp_v_in to match the split of the 4-valve group.

### The pneumatic inlet valves into R1 and R2 are not on the sheet — FT-201 feeds the reactors directly and carries the split that those valves perform

- **kind** missing_node
- **found** flowsheet.js:341-342 — `edge('e_ft_r1','ft_201','r1')` and `edge('e_ft_r2','ft_201','r2')` go straight from the flow meter into the reactors, with `splitRatios: [0.5, 0.5]` living on the ft_201 *instrument* node (line 114). R-XV-301 ('R1 & R2 inlet valves', qty 2, 4 DI / 2 DO) exists only as a tag string on r1 and r2 (lines 125, 135). Every other actuated valve group in the sheet is a `valve` node: elp_v_in, elp_v_out, rfp_v_in, rfp_v_out, ffp_v_in, ffp_v_out, sfp_v_in, uf_v_in, stp_v_in.
- **proposal says** Slide 3: '… -> 100mm UPVC -> a flow meter (M in a box) -> REDUCER 3"x2" -> pneumatic valves -> R1 and R2'. The valve group is drawn downstream of the meter, and it is the device that alternates the fill. Narrative II.9 'Open the Reactor (R2) input and output valve' drives R-XV-301 as a discrete sequence step.
- **suggested fix** Add `node('r_v_in', 'valve', 'R1 / R2 inlet valves (2)', V(1800, 190), { area: 'R', tags: ['R-XV-301'], source: 'Slide 6 — R1 & R2 inlet valves', assumption: <the existing 50/50 alternation note>, params: { open: 1, opening_pct: 100, splitRatios: [0.5, 0.5] } })`, rewire ft_201 → r_v_in → r1 / r2, and move `splitRatios` off ft_201 onto it so the split sits on the device that makes it.

### R1 and R2 cite the reactor level transmitters (R-LT-301) but hold no level setpoints, so the decant-stop / top-water levels the SBR sequence runs on exist nowhere

- **kind** wrong_param
- **found** flowsheet.js:124-143 — r1/r2 tag `R-LT-301` and carry cycle times, but no `low_level_pct` / `high_level_pct` (or top-water / bottom-water level). Every other tank node on the sheet carries them: eqt (15/90), ct (20/90), sht (10/85), int_wt (20/90), swt/irr_wt/fwt (20/90), sintex (25/90). Those setpoints are a live surface: frontend/src/components/canvas/symbols/equalisation_tank.jsx:61-62 draws them as hairlines and CanvasPage.jsx:241-242 edits them, and seeds/itcStp.js:45-48 alarms on eqt's. The reactors' 2 AI of level (R-LT-301, printed 0 DI / 0 DO / 2 AI on slide 6) therefore have nothing to be compared against.
- **proposal says** Slide 6 lists `R-LT-301, qty 2, 'R1 + R2 level transmitters'` and slide 6's meters row is 'R1 + R2 tank level'. Narrative II.12 'Then Decay [decant] will be ON for 45 mins and goes down' is a level-terminated move: the decanter lowers to a bottom-water level the LT reports.
- **suggested fix** Add level setpoints to r1/r2 params (e.g. `top_water_level_pct: 100`, `decant_stop_pct` / `bottom_water_level_pct: 70` consistent with the decant volume, plus `low_level_pct` / `high_level_pct` in the sheet's existing convention) with a `data.assumption` noting the proposal states no reactor levels. Without them the R-LT-301 signals are scheduled and priced but unusable.

### The reactor feed pump is rated on a 24-hour basis (1032 m³/d) although the narrative starts and stops it inside every cycle — it can only run 13.7 h/day

- **kind** wrong_param
- **found** flowsheet.js:104-107 — `rfp_p` params `capacity_m3_d: 1032` (= 43 × 24) with no duty-cycle or run-hours field, and the pump model has none either (models/pump.js DEFAULTS: running, speed_pct, capacity_m3_d, head_m, pump_efficiency). Solved: `Q_delivered_m3_d: 714.1`, `energy_kWh_d: 23.9`, `blocked_Q_m3_d: 0` — the pump never limits. But the stated sequence runs it 1.5 h per fill × 2 reactors × 4.571 cycles/day = 13.71 h/day, i.e. at most 43 × 13.71 = 589.7 m³/d and ≈13.7 kWh/d. The sheet therefore shows the RFP passing 714 m³/d and burning 24 h of energy, and the shortfall surfaces downstream as 62.2 m³/d of SBR backlog on each reactor instead of at the pump that causes it.
- **proposal says** Slide 5 states the pump as 43 m³/hr @ 8 m, 1W+1SB. Narrative II.3-II.5 (slide 22): 'After 15 sec Primary Pump will be switched ON' → 'The filling takes place for 1.5 hours then the pump will be switched OFF' → 'After 15 sec switch OFF the two control valves.' narrative.js cycleAnalysis() already computes the 589.7 m³/d that duty cycle permits.
- **suggested fix** Either add a duty field the model can use (`run_hours_per_day: 13.7`, or `duty_pct: 57`) or set `capacity_m3_d: 590` with a `data.assumption` reading 'the RFP is a batch feed pump: 43 m³/hr for 1.5 h per fill, 9.14 fills/day across both reactors = 13.7 running hours'. Either way the node stops asserting a 24-hour duty the sequence forbids.

### R-LT-301/1 and /2 are the only two of the nine level AI points with neither an instrument node nor a level parameter — r1/r2 carry no volume and no level band

- **kind** missing_tag
- **found** r1 and r2 cite ['R-XV-301','R-LT-301','R-DEC-301'] in data.tags, but their params are cycle/biology only — reactors, fill_h, aerate_h, settle_h, decant_h, feed_pump_m3_h, decant_TSS_mg_L, SRT_d, MLSS_mg_L, DO_set_mg_L, denitrification, anoxic_fraction, temp. No volume_m3, no low_level_pct, no high_level_pct. sbrReactor.js DEFAULTS does accept `volume_m3` (default 0) and forwards it to aerationBasin, and metrics.sludge_inventory_kg falls back to `basin.metrics.volume_m3` — so the solved r1 volume_m3 = 462 m³ is a back-calculation from SRT 15 d and MLSS 3500 mg/L, not the vessel the proposal built. Solved r1 metrics contain no `level_instrument` key, whereas every equalisation_tank node (eqt 225 m³, int_wt 150, sht 25, sintex 1, irr_wt 100, fwt 100, swt 100, ct 5) reports 'Level transmitter (continuous)' or 'Level switch (high only)' off its own volume + low/high setpoints. The reactors' data.assumption fields cover only MLSS and SRT, so the missing volume is not a documented assumption.
- **proposal says** processes.js process 3 (slide 6) lists { tag: 'R-LT-301', qty: 2, name: 'R1 + R2 level transmitters', kind: 'level_tx', printed: { AI: 2 } } and spec.meters: 'R1 + R2 tank level'. narrative.js section II drives the cycle off level and volume — II.4 'filling takes place for 1.5 hours then the pump will be switched OFF', II.12 decant for 45 min — and the schematic draws R1/R2 as tanks each with an OVERFLOW.
- **suggested fix** Add to both r1 and r2 params an explicit vessel: `volume_m3` (the fill is 43 m³/hr × 1.5 h = 64.5 m³ per cycle, so ~130 m³ working volume covers a fill plus the settled blanket) plus `low_level_pct` (decant-stop / bottom water level) and `high_level_pct` (fill-stop / top water level), and add a data.assumption line saying the reactor working volume and level band are not stated in the proposal and were sized from the 64.5 m³ fill. That gives R-LT-301 a band to report against and gives a printed PFD the reactor TWL/BWL it needs.

### Micron-filter backwash is dropped at the boundary when the proposal pipes it back to EQT

- **kind** unrouted_stream
- **found** Solver warning: "Unrouted side stream 'backwash' from mf (Q=0.07 m³/d) — counted as a plant-boundary loss"; unroutedLosses entry Q_m3_d 0.071, TSS_kg_d 1.471. `mf` is opType 'micron_filter' -> pressure_filter, which emits {effluent, backwash}; only the plain effluent edge e_mf_ufv exists. The two sibling filters on the same header already do it right: e_acf_bw and e_mgf_bw both carry role 'backwash' to eqt with recycle:true.
- **proposal says** processes.js process 8 (UF feed, slide 11) spec.pipe = 'UPVC 50 mm · CPVC 80 mm micro-filter backwash' — the micro-filter backwash line is explicitly in scope — and process 8 outputs = ['Sintex tank 1000 L → FWT', 'Backwash to EQT']. The slide-3 schematic shows the 80 mm CPVC 'Micro Filter Backwash' piping tied into the same BACKWASH TO EQT header as the UF.
- **suggested fix** Add `edge('e_mf_bw', 'mf', 'eqt', { role: 'backwash', recycle: true, label: 'Micron filter backwash to EQT' })`, matching e_acf_bw / e_mgf_bw exactly. The 'backwash' role already resolves to the pressure_filter model's `backwash` port, so no model change is needed.

### The UF's retained solids are dropped at the boundary; the modelled backwash loop carries clean permeate around the membrane instead of through it

- **kind** unrouted_stream
- **found** Solver warning: "Unrouted side stream 'screenings' from uf (Q=0.00 m³/d)"; unroutedLosses entry Q_m3_d 0.004, TSS_kg_d 0.785, BOD_kg_d 0.049. `uf` is opType 'uf_membrane', which PALETTE_TYPE_MAP resolves to the `screen` model emitting {effluent, screenings}; only the plain edge e_uf_sintex is drawn. The backwash return is modelled as sintex -> ufbp -> eqt (e_sintex_ufbp Q=15.13, e_ufbp_eqt Q=15.13) — a path that never touches the `uf` node, so the 0.785 kg/d of solids the UF actually removes never reaches EQT.
- **proposal says** Narrative section VII step 10 (slide 24): 'The Backwash Valve is then opened, and the water is directed to the EQT.' Steps VII.7–VII.9 have the UFBP push water back through the module before that valve opens. processes.js process 8 output 'Backwash to EQT'; narrative.cycleAnalysis().uf.backwashReturnsTo === 'EQT'.
- **suggested fix** Add `edge('e_uf_bw', 'uf', 'eqt', { role: 'screenings', recycle: true, label: 'UF reject to EQT (narrative VII.10)' })` so the retained solids return with the backwash rather than vanishing. The 'screenings' role already maps to the screen model's `screenings` port.

### The centrifuge has no 'Water drain' boundary — 100 % of the centrate is recycled where the proposal splits it

- **kind** missing_node
- **found** processes.js process 4 (Sludge, slide 7) declares outputs: ['Water drain', 'Solid discharge', 'Centrate to EQT'] — three boundaries. flowsheet.js gives `centrifuge` two edges: e_cent_solids (role 'thickened' -> solids_out, Q=0.25) and e_cent_eqt (role 'filtrate' -> eqt, Q=13.05). There is no drain outlet node in NODES; summary.boundaries lists five, and outlet.js's own header comment repeats 'The ITC works ends in five'.
- **proposal says** processes.js process 4 outputs list, transcribed from slide 7. The slide-3 schematic draws CENTRIFUGAL with three take-offs: DISCHARGE (solids), DRAIN (water), and a line back to EQT.
- **suggested fix** Add `node('cent_drain', 'outlet', 'Centrifuge water drain', V(3010, 400), { area: 'SHT', source: 'Slide 7 — water drain', params: { discharge_type: 'reject' } })` and split the centrate: keep e_cent_eqt at role 'filtrate' and add a second filtrate-role edge to cent_drain, with the split recorded as a data.assumption on `centrifuge` (the proposal does not state the share).

### Trapped grease leaves the works as a warning line, not as a declared boundary — 10.9 kg TSS/d is outside summary.boundaries

- **kind** missing_node
- **found** Solver warning: "Unrouted side stream 'screenings' from ogt (Q=0.07 m³/d)"; unroutedLosses entry TSS_kg_d 10.875, BOD_kg_d 0.174, at 150,000 mg/L. oilGreaseTrap.js computes `days_between_cleanout` (0.4 d here) — i.e. the model itself treats this as a hauled export on a cleanout cycle, exactly like the centrifuge cake, which does get a named outlet (`solids_out`, discharge_type 'solids'). summary.boundaries therefore reports five boundaries for a works that has six.
- **proposal says** proposal.js INFLUENT lists the kitchen stream's pretreatment as 'Oil & grease trap (OGT)'; narrative section I step 2 (slide 22) 'Filter to be cleaned periodically' with the note 'Manual task — no I/O point is allocated for it' — so removal is by hauling, i.e. a plant boundary, not a routed stream. The honest answer here IS a boundary loss; what is missing is the boundary node.
- **suggested fix** Add `node('grease_out', 'outlet', 'FOG & scum to disposal', V(230, -60), { area: 'ELP', source: 'Slide 4 — OGT manual cleanout', params: { discharge_type: 'solids' } })` and `edge('e_ogt_grease', 'ogt', 'grease_out', { role: 'screenings', label: 'Trapped FOG to skip' })`. It stays ungraded (discharge_type 'solids') but appears by name in summary.boundaries and in a printed mass balance.

### The sewage influent's bar chamber is not on the sheet — 475 KLD enters EQT with no screening step and no screenings boundary

- **kind** missing_node
- **found** proposal.js INFLUENT: `{ stream: 'Sewage influent', kld: 475, pretreatment: 'Bar chamber' }`. flowsheet.js wires it straight through: `edge('e_sewage_eqt', 'in_sewage', 'eqt', { label: '150 mm UPVC' })`. Nothing between them. The kitchen and laundry streams do get their transcribed pretreatment (ogt, ct); the sewage stream — 70 % of the design flow and the one carrying rag and plastics — gets none. No node in NODES has opType 'screening' or 'screen'.
- **proposal says** proposal.js INFLUENT table (transcribed from the schematic and slide 4) names 'Bar chamber' as the sewage stream's pretreatment. The slide-3 schematic draws it as 600 × 1000 MM, MOC SS304, QTY 2 nos.
- **suggested fix** Add `node('bar_sewage', 'screening', 'Bar chamber — sewage', V(230, 190), { area: 'ELP', source: 'Slide 4 / schematic — 600 × 1000 mm SS304, 2 nos', params: { screenType: 'coarse' } })`, rewire e_sewage_eqt as in_sewage -> bar_sewage -> eqt, and route its `screenings` output to the same disposal outlet as the OGT grease so the screenings load is a declared boundary rather than a dropped side stream.

### ACF and MGF are wired in series and the pH analyser sits after the MGF; the proposal draws them in parallel on a common frontal header with the analyser on the ACF outlet

- **kind** wrong_route
- **found** flowsheet.js: `edge('e_ffpvo_acf','ffp_v_out','ft_acf')`, `edge('e_ftacf_acf','ft_acf','acf')`, `edge('e_acf_mgf','acf','mgf')`, `edge('e_mgf_ph','mgf','at_601')` — a single chain. Solved: acf takes 317.03 m³/d (13.2 m³/hr) and mgf takes 311.03 (12.96 m³/hr), i.e. both vessels see the full leg flow. In series the pair's capacity is the smaller of the two ratings, 25 m³/hr, against an FFP rated 43 m³/hr; in parallel the pair is rated 50 m³/hr, which is what matches the feed pump. No node carries a data.assumption recording the series choice.
- **proposal says** processes.js process 6 spec.vessels: 'ACF Ø1650 mm · MGF Ø1500 mm · HOS 1500 mm · 25 m³/hr each' with spec.pipe 'CPVC 80 mm frontal piping'. Narrative section V step 1 (slide 23): 'From these filter tanks, the water flows to the pH' — plural, both discharging to the analyser. The slide-3 schematic shows them side by side on the shared 80 mm CPVC frontal piping with the pH analyser box on the ACF outlet line.
- **suggested fix** Split ft_acf to both vessels in parallel (`e_ftacf_acf` -> acf, `e_ftacf_mgf` -> mgf, splitRatios on ft_acf) and merge both outlets into at_601 (`e_acf_ph`, `e_mgf_ph`), keeping both backwash-to-EQT edges as they are. If the series arrangement is deliberate, it must be recorded in acf.data.assumption together with the resulting 25 m³/hr pair rating — and the analyser moved to the ACF outlet per the schematic.

### The sludge holding tank has no supernatant decant — all 13.29 m³/d goes to the 1 m³/hr centrifuge, and its two ball valves have no node

- **kind** missing_edge
- **found** flowsheet.js gives `sht` a single outgoing edge, e_sht_poly (Q=13.29 m³/d at TSS 3500). Nothing decants. Cross-check of processes.js device tags against flowsheet node tags shows SHT-BV-301 ('Sludge tank ball valves', qty 2, process 3) resolves to no node — the two valves that work the supernatant/overflow line are unrepresented, as is SHT-P-401 ('Sludge discharge pump', 2 m³/hr @ 35 m Roto, process 4), which should sit between sht and poly_dose.
- **proposal says** The slide-3 schematic draws SHT with a SUPRANATANT INSERT and a 50 mm UPVC overflow. processes.js process 3 lists SHT-BV-301 qty 2 and process 4 lists SHT-P-401 with its own duty; both are priced in the I/O schedule but appear nowhere on the sheet.
- **suggested fix** Add `edge('e_sht_super', 'sht', 'eqt', { recycle: true, label: 'SHT supernatant / 50 mm overflow to EQT' })` with splitRatios on `sht` (documented as an assumption — the proposal gives no share), and insert `node('sht_p', 'pump', 'SHT — Sludge discharge pump', ..., { tags: ['SHT-P-401'], params: { running: 1, capacity_m3_d: 48, head_m: 35 } })` between sht and poly_dose so the stated 2 m³/hr @ 35 m duty lives on the sludge line.

### SFP-XV-711 (softener feed pump outlet valves, qty 3) has no node — the SFP is the only pump set drawn without an outlet valve group

- **kind** missing_node
- **found** SFP-XV-711 is one of the four uncited tags (9 orphan signals: 3 × ZSO/ZSC/XC). flowsheet.js has sfp_v_in (l.215, tags ['SFP-XV-701']) → sfp_p (l.218) → sof (l.222) via e_sfpv_sfpp / e_sfpp_sof (l.379-380), with no outlet-valve node. Every other pump set follows the in-valve/pump/out-valve pattern: elp_v_in/elp_p/elp_v_out, rfp_v_in/rfp_p/rfp_v_out, ffp_v_in/ffp_p/ffp_v_out.
- **proposal says** processes.js process 7 (slide 10): `{ tag:'SFP-XV-711', qty:3, name:'PP, SP & outlet valves', kind:'butterfly_valve' }`. narrative.js VI.1 ('The inlet and outlet of the Primary Pump (SFP) are switched ON', devices ['SFP-XV-701','SFP-XV-711']) and VI.5 both drive it. The schematic shows SFP as '2 pumps + valves'.
- **suggested fix** Add node('sfp_v_out','valve','SFP outlet valves (3)', V(4020,30), { area:'SFP', tags:['SFP-XV-711'], source:'Slide 10', params:{ open:1, opening_pct:100 } }) and re-point e_sfpp_sof to run sfp_p → sfp_v_out → sof.

### ACF-BV-611 — the ball valve to EQT plus the BF valve to garden — is cited by no node, although the flow draws all three streams it operates

- **kind** missing_tag
- **found** ACF-BV-611 (qty 3, 9 orphan signals) is uncited. In the ACF area, acf cites only ACF-XV-601 (l.201), mgf only MGF-XV-601 (l.205), at_601 only ACF-AT-601 (l.209). Yet the flow already draws exactly the three lines this valve group operates: e_acf_bw and e_mgf_bw (acf/mgf → eqt, role 'backwash', l.371-372) and e_ph_irr (at_601 → irr_wt, l.376). So the streams are present but the valve that routes them is nowhere on the sheet.
- **proposal says** processes.js process 6 (slide 9): `{ tag:'ACF-BV-611', qty:3, name:'Ball valve to EQT + BF valve to garden', kind:'ball_valve' }`. narrative.js section V step 2 attributes the three-way routing to it: 'The three processes from ACF and MGF filter are: SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT', devices ['ACF-BV-611'].
- **suggested fix** Either add tags:['ACF-BV-611'] to at_601 (which is the node that already performs the split, and note the two backwash ball valves are folded in), or — cleaner for a printed PFD — add a node('acf_bv','valve','ACF/MGF routing & backwash ball valves (3)', tags:['ACF-BV-611']) downstream of at_601 that carries the splitRatios currently sitting on the pH instrument.

### SHT-BV-301, the two sludge-tank ball valves, is cited by no node

- **kind** missing_tag
- **found** SHT-BV-301 (qty 2, 6 orphan signals) is uncited. The sht node (l.153-157) carries tags:['SHT-LT-401'] only; stp_v_in carries STP-XV-301, centrifuge carries SHT-XV-401. No sibling node picks up SHT-BV-301, so it is genuinely absent rather than folded in.
- **proposal says** processes.js process 3 (slide 6): `{ tag:'SHT-BV-301', qty:2, name:'Sludge tank ball valves', kind:'ball_valve', printed:{DI:4,DO:2} }`. The slide-3 schematic shows the SHT with a supernatant insert and a 50 mm UPVC overflow — the two isolation points these ball valves operate.
- **suggested fix** Add tags:['SHT-BV-301'] to the sht node (with a note that the two ball valves are the tank's draw-off and overflow isolations), or draw them as a valve node between sht and the discharge pump.

### The micron filter's backwash is produced but not routed — it leaves as an unnamed plant-boundary loss while ACF and MGF backwash both return to EQT

- **kind** unrouted_stream
- **found** Running the sheet through runSteadyState raises: "Unrouted side stream 'backwash' from mf (Q=0.07 m³/d) — counted as a plant-boundary loss", with 1.471 kg/d TSS in summary.unroutedLosses. flowsheet.js gives mf exactly one outgoing edge, e_mf_ufv (l.395), with no role. acf and mgf each have their backwash edge to EQT (e_acf_bw l.371, e_mgf_bw l.372), so the pattern exists and mf is the exception. pressureFilter.js states in its own header that backwash 'returns to EQT and is reported as a `backwash` stream so the solver can route it and the plant balance closes'.
- **proposal says** processes.js process 8 (slide 11) spec: pipe: 'UPVC 50 mm · CPVC 80 mm micro-filter backwash'. The slide-3 schematic shows '80mm CPVC/Micro Filter Backwash piping' on the UF skid.
- **suggested fix** Add `edge('e_mf_bw','mf','eqt',{ role:'backwash', recycle:true, label:'Micron filter backwash to EQT' })`, mirroring e_acf_bw / e_mgf_bw.

### ft_acf binds to PLC tag 'FFP-FT-502', which exists nowhere in the 339-signal schedule

- **kind** wrong_param
- **found** flowsheet.js l.196-199: ft_acf has tags:['FFP-FT-501'] but params.tag:'FFP-FT-502'. ioSchedule.buildTagList() contains no FFP-FT-502 row at all; because FFP-FT-501 has qty 2 the two meters expand to 'FFP-FT-501/1.FT' and 'FFP-FT-501/2.FT'. ft_mf (l.275-278) sets params.tag:'FFP-FT-501', which is the bare device tag, not a signal row, and does not distinguish it from the other unit. So of the plant's two FFP flow meters, one binds to a non-existent tag and the other binds ambiguously — the only two instrument nodes in the sheet where params.tag fails to resolve (ft_201→RFP-FT-201, at_601→ACF-AT-601, ft_swt→SWT-FT-1101, ft_irr→HWT-FT-901, ft_fwt→FWT-FT-1001 all resolve).
- **proposal says** processes.js process 5 (slide 8): `{ tag:'FFP-FT-501', qty:2, name:'Micron filter + ACF/MGF flow meters' }` — one row, two units. ioSchedule.js's own tag convention is '<device tag>/<n>.<abbrev>' for qty > 1.
- **suggested fix** Set ft_mf params.tag:'FFP-FT-501/1.FT' and ft_acf params.tag:'FFP-FT-501/2.FT' (slide 8 lists the micron meter first), so both instrument nodes bind to real rows in the I/O schedule.

### None of the three inlet bar chambers is on the flow — raw sewage, kitchen and laundry all enter their tanks unscreened

- **kind** missing_node
- **found** flowsheet.js wires the influents straight into vessels: e_kitchen_ogt (in_kitchen → ogt, l.327), e_sewage_eqt (in_sewage → eqt, l.329) and e_laundry_ct (in_laundry → ct, l.330). There is no node of opType 'screening'/'screen' anywhere in NODES — the only node that resolves to models/screen.js is `uf` (uf_membrane → screen). The result is that 260 mg/L TSS sewage reaches EQT with no gross-solids removal modelled and the plant's screenings stream does not exist.
- **proposal says** proposal.js INFLUENT names the pretreatment explicitly: `{ stream:'Sewage influent', kld:475, pretreatment:'Bar chamber' }`. The slide-3 schematic draws three, with MOC and quantity: kitchen 400×500 mm SS304 qty 2, sewage 600×1000 mm SS304 qty 2, laundry 400×500 mm SS304 qty 2. narrative.js I.2 ('Filter to be cleaned periodically') is the manual task attached to them.
- **suggested fix** Add three screen nodes — e.g. node('bc_sewage','screening','Bar chamber — sewage (600 × 1000 mm SS304, 2 nos)', { area:'ELP', source:'Slide 3 schematic', assumption:'No removal efficiency is stated; the coarse-screen default is used', params:{ screenType:'coarse' } }) and the two 400 × 500 mm equivalents — inserted ahead of eqt, ogt and ct, each with a `screenings` edge to a screenings-disposal outlet so the solids do not vanish as an unnamed boundary loss.

### The micron filter carries chlorine_in_ppm 0 while the ACF on the same dosed header carries 1.0 — the sheet shows no chlorine reaching the UF membranes

- **kind** wrong_param
- **found** Both legs come off the same node: e_ffpvo_acf and e_ffpvo_mf both leave ffp_v_out (l.363-364), which is downstream of cl_dose (dose_mg_L 1.0, l.177-181). acf sets chlorine_in_ppm:1.0 (l.202); mf sets no chlorine_in_ppm (l.282), so pressureFilter defaults it to 0. Solved metrics confirm: acf {chlorine_in_ppm:1, chlorine_out_ppm:0.05, dechlorination_pct:95} vs mf {chlorine_in_ppm:0, chlorine_out_ppm:0}. Since the UF line branches upstream of the carbon, the membranes really do see the full 1 ppm, but the sheet reports zero.
- **proposal says** narrative.js IV.2 doses INT-WT to 0.5–1 ppm, and IV.4 states 'The pumped water is split into two lines. One line is directed to ACF & MGF filter and the other line is directed to Micron filter' — i.e. both lines carry the dosed water. pressureFilter.js's own header calls this out: 'the plant doses chlorine into INT-WT upstream and then feeds UF membranes downstream — carbon is what protects the membranes from the chlorine the plant just added.'
- **suggested fix** Set mf params.chlorine_in_ppm: 1.0 to match acf, so the sheet reports the residual actually arriving at the UF (micron media has chlorine_removal_pct 0, so it will read 1.0 ppm out) and the missing membrane protection becomes visible instead of silently reading zero.

### ACF is wired ahead of MGF, which puts the pH analyser on the MGF outlet rather than the ACF outlet the schematic draws it on

- **kind** wrong_route
- **found** flowsheet.js l.368-370: e_ftacf_acf (ft_acf → acf), e_acf_mgf (acf → mgf), e_mgf_ph (mgf → at_601). So the carbon bed takes the raw filter-feed solids first and the pH analyser sits on the multigrade outlet. Solved metrics show the consequence: acf removes 3.53 kg/d of solids ahead of mgf's 2.27 kg/d, i.e. the carbon is doing the bulk turbidity duty. No data.assumption on acf, mgf or at_601 records that an order had to be chosen.
- **proposal says** The slide-3 schematic places the pH analyser box on the ACF OUTLET line, which makes the ACF the last vessel in the train; it also shows both vessels side by side on a common 80 mm CPVC frontal header, each rated 25 m³/hr. processes.js slide 9 lists both at '25 m³/hr each'.
- **suggested fix** Reverse the pair to ft_acf → mgf → acf → at_601 (move chlorine_in_ppm:1.0 onto whichever vessel is first and keep the carbon last so its 95 % dechlorination applies to the final line), or — if the header is genuinely parallel — split ft_acf 50/50 into acf and mgf with splitRatios and merge both into at_601, and add a data.assumption on ft_acf saying which reading was taken.

### UFBP carries capacity_m3_d 0 (unlimited) despite a stated 15 m³/hr duty that the sheet itself uses elsewhere

- **kind** wrong_param
- **found** flowsheet.js l.300-304: ufbp has source 'Slide 11 — 15 m³/hr @ 15 m, Grundfos, qty 2' and head_m:15, but capacity_m3_d:0. models/pump.js documents 0 as 'unlimited'. Every other pump with a stated duty carries it: elp_p 120 (5 m³/hr), rfp_p 1032 (43), stp_p 240 (10), ffp_p 1032 (43), sfp_p 1032 (43), uffp 240 (10). The 15 m³/hr figure is not missing from the sheet — the sintex node's own assumption (l.297) computes its 0.925/0.075 split from '1 min of UFBP at 15 m³/hr against 20 min of UFFP at 10 m³/hr', and narrative.js UF_CYCLE sets backwashPump_m3_h: 15.
- **proposal says** processes.js process 8 (slide 11) spec: 'UFBP 15 m³/hr @ 15 m Grundfos qty 2'; the slide-3 schematic labels UFBP 'CAP 15m³/hr.@15m GRUNDFOS QTY 2'.
- **suggested fix** Set ufbp params.capacity_m3_d: 360 (15 × 24). This leaves the solved 15.1 m³/d backwash draw unaffected but makes the pump's stated rating checkable, consistently with the other six duty-rated pumps. (swtp/hwtp/fwtp keeping 0 is correct — the proposal states no duty for those.)

### The SHT supernatant insert and 50 mm overflow are drawn but have no path — all 13.3 m³/d entering SHT is pushed through the poly dosing skid and the 1 m³/hr centrifuge

- **kind** missing_edge
- **found** sht (l.153) has exactly one outgoing edge, e_sht_poly (l.353). Solved flows: stp_p → sht at 13.3 m³/d and sht → poly_dose at 13.3 m³/d, i.e. every litre of thin waste sludge is dewatered rather than the supernatant being decanted back first. The sht node has no assumption field noting the decision.
- **proposal says** The slide-3 schematic shows the SHT with a SUPRANATANT INSERT and a 50 mm UPVC overflow, i.e. a decant device plus an overflow. processes.js pairs it with `SHT-BV-301` (qty 2 sludge tank ball valves), which are the isolations those two lines need.
- **suggested fix** Add `edge('e_sht_super','sht','eqt',{ recycle:true, label:'Supernatant / 50 mm overflow to EQT' })` and put splitRatios on sht (a documented assumption — the schematic does not print the split), so the centrifuge is fed thickened underflow at something near its 1 m³/hr Hiller rating instead of the whole tank contents.

### The micron filter's backwash line is named in the proposal's pipe spec but has no edge; the solver books it as a boundary loss

- **kind** unrouted_stream
- **found** Running the sheet: "Unrouted side stream 'backwash' from mf (Q=0.07 m³/d) — counted as a plant-boundary loss", and summary.unroutedLosses carries { node:'mf', stream:'backwash', Q_m3_d:0.071, TSS_kg_d:1.471 }. mf's only outgoing edge is e_mf_ufv (plain forward to uf_v_in); pressureFilter.js always returns a `backwash` port alongside `effluent`. ACF and MGF both have their backwash routed (e_acf_bw, e_mgf_bw with role 'backwash'), so the omission is specific to the micron filter.
- **proposal says** processes.js process 8 (uf_feed, slide 11) spec.pipe: 'UPVC 50 mm · CPVC 80 mm micro-filter backwash'. The schematic annotates the UF area with '80mm CPVC/Micro Filter Backwash piping' and shows a BACKWASH TO EQT arrow on that block.
- **suggested fix** Add edge('e_mf_bw', 'mf', 'eqt', { role: 'backwash', recycle: true, label: 'Micron filter backwash to EQT' }), matching the ACF/MGF pattern, and give it size_mm 80 / material CPVC once the pipe-size field exists.

### Skimmed grease from the OGT and the UF's retained solids leave the plant with no line drawn

- **kind** unrouted_stream
- **found** Solver warnings: "Unrouted side stream 'screenings' from ogt (Q=0.07 m³/d)" and "Unrouted side stream 'screenings' from uf (Q=0.00 m³/d)". The OGT loss is not trivial in mass — unroutedLosses records 10.875 kg TSS/d, 0.174 kg BOD/d leaving the boundary with no destination. oilGreaseTrap.js documents that port explicitly ('The skimmed grease leaves as a `screenings` stream'); ogt's only outgoing edge is e_ogt_eqt. uf (opType uf_membrane → screen model) likewise emits screenings that nothing consumes.
- **proposal says** The schematic draws the OGT as a discrete dark-red vessel on the kitchen line whose whole purpose is capturing grease for manual removal; the node itself carries grease_capacity_m3 0.03 and the model already warns 'Trap fills in 0.4 day(s)'. A PFD must show where 10.9 kg/d of skimmed FOG goes.
- **suggested fix** Add an outlet node grease_out (params { discharge_type: 'solids' }, area 'ELP', near V(230,-110)) and edge('e_ogt_grease','ogt','grease_out',{ role:'screenings', label:'Skimmed grease to skip' }). For the UF, either route its screenings into the same backwash return to EQT or state in the uf node's data.note that the screen model's screenings port is a modelling artefact of the UF membrane and is intentionally a boundary term.

### The sludge process has three outputs in the proposal and two on the sheet; the SHT supernatant line is absent entirely

- **kind** missing_edge
- **found** centrifuge has exactly two outgoing edges — e_cent_solids (role 'thickened' → solids_out) and e_cent_eqt (role 'filtrate', recycle → eqt). sht has one outgoing edge, e_sht_poly. There is no drain outlet and no supernatant return.
- **proposal says** processes.js process 4 (sludge, slide 7) outputs: ['Water drain', 'Solid discharge', 'Centrate to EQT'] — three, and the schematic likewise shows the centrifuge going to DISCHARGE (solids) and DRAIN (water) *and* a separate line back to EQT. The schematic also gives SHT a 'SUPRANATANT INSERT' and a 50 mm UPVC overflow, which is how a sludge holding tank decants clear liquor back to the head of works.
- **suggested fix** Either add a drain outlet node (params { discharge_type: 'water' }) fed from the centrifuge and split the filtrate between it and EQT with splitRatios on the centrifuge, or record in the centrifuge node's data.note that 'Water drain' and 'Centrate to EQT' are the same line on slide 7. Separately, add edge('e_sht_super','sht','eqt',{ recycle:true, label:'Supernatant to EQT, 50 mm UPVC' }) plus splitRatios on sht.params, since the supernatant insert is drawn.

### The blower node has zero edges, so the aeration air header the schematic draws cannot appear on the sheet at all

- **kind** missing_edge
- **found** Degree count over all 60 edges: `blowers` is the only node with in-degree 0 and out-degree 0. The renderer already has an air service (SERVICES.air, cyan, dash '1 4') whose only trigger is serviceOf's `if (src === 'blower') return 'air'` — with no blower edge in existence, that class can never render on this sheet. The three aeration air valves (R-AV-301, qty 3) are folded onto the blowers node's tags rather than drawn as valve nodes, unlike every other actuated valve group on the sheet.
- **proposal says** The schematic draws a 125 mm SS-304 air header from the AIR BLOWERS (475 m³/hr @ 0.55 kg/cm², Beta, qty 3, 2W+1SB) running above R1 and R2, with 100 mm SS-304 and 25 mm SS-304 drops through pneumatic valves into each reactor. Narrative II.6 and II.10 sequence those valves ('R1 tank corresponding valve open and then blower open').
- **suggested fix** Add edges blowers → r1 and blowers → r2 carrying an explicit non-material service (e.g. `service: 'air'`, `utility: true`), and have the solver skip utility-flagged edges when building edgesByTarget so they never enter the mass balance — the blowers node's existing data.note explains why it has no *water* connection, but that reasoning does not cover the air lines a PFD has to print. Give them size_mm 100 / 25 and material SS-304.

### The three chemical skids sit in-line on the main header, so a 13 m³/d sludge line prints as a chemical line

- **kind** wrong_route
- **found** cl_dose, poly_dose and swt_cl are each wired as a pass-through unit op on the main run: int_wt → cl_dose → ffp_v_in, sht → poly_dose → centrifuge, swt → swt_cl → swtp. Applying StreamEdge.serviceOf, e_poly_cent classifies as 'chemical' (purple, dash-dot 6 2 1 2) because its source opType 'polymer_dosing' is in DOSING_TYPES — while actually carrying 13.3 m³/d at 3501 mg/L, i.e. the entire sludge feed to the centrifuge. e_cl_ffpv escapes only by accident: opType 'chlorination' is not in liveStore's DOSING_TYPES and is not aliased by resolveType, so the 576 m³/d chlorinated header prints as plain water and the chlorine injection itself gets no chemical line anywhere on the sheet.
- **proposal says** The schematic draws all three as skids beside the vessel they serve — 'a CL DOSING skid above it [INT-WT]', 'SHT -> screw/discharge pump -> POLY DOSING -> CENTRIFUGAL', 'SWT with a CI DOSING skid above it on an 80mm CPVC header' — each with its own tank capacity (500 L poly, 200 L Cl at INT-WT, 200 L Cl at SWT) and dosing pump range (0–30 lph, 0–12 lph).
- **suggested fix** Model each skid as a side injection rather than a series element: keep the main line intact (int_wt → ffp_v_in, sht → centrifuge, swt → swtp) and add a chemical branch edge from the dosing node into the receiving node carrying `service: 'chemical'`. If in-line is kept for solver reasons, at minimum add 'chlorination' to liveStore's DOSING_TYPES so the class is applied consistently, and carry the dosing tank volume (500 L / 200 L / 200 L) in each node's params so the skid block can print it.

### Make, duty/standby split and vessel geometry exist only inside the free-text data.source string, and data.tags is never rendered

- **kind** diagram_gap
- **found** All 10 pump nodes hold their duty as capacity_m3_d + head_m; the make and the 1W+1SB configuration survive only in prose, e.g. elp_p source 'Slide 4 — 5 m³/hr @ 8 m, Johnson, 1W + 1SB', ufbp 'Slide 11 — 15 m³/hr @ 15 m, Grundfos, qty 2'. Nothing structured records manufacturer, quantity, or duty/standby. The softener's stated Ø1000 mm appears only in sof.data.source — sof.params has no diameter_mm at all (acf 1650 and mgf 1500 do). HOS 1500 mm, shell 6/8 mm and dish end 8 mm are stated on slides 9 and 10 for ACF, MGF and SOF and are carried nowhere. And grepping frontend/src/components/canvas shows UnitOpNode renders only data.label (line 300) — data.tags is on 46 of 55 nodes and never printed, so no ISA tag appears beside any block.
- **proposal says** Slides 4–14 state each pump's capacity, head, make and 1W+1SB split, and each vessel's diameter, HOS, shell and dish-end thickness. The schematic prints them inside the equipment callouts (CAP 43m3/hr@8m MAKE JOHNSON QTY 2 (1W+1SB); DIA 1650mm HOS 1500mm SHELL 8mm DISHEND 8mm FLOW 25m^3/hr).
- **suggested fix** Add a structured `duty` object to node.data — { make, qty, config: '1W+1SB', rated_m3_h, head_m } for pumps and { diameter_mm, hos_mm, shell_mm, dishend_mm, rated_m3_h, moc } for vessels — populated from the same slide text already sitting in data.source, and render `data.tags[0]` plus a one-line duty string in UnitOpNode's footer. Add diameter_mm 1000 to sof.params while doing it.

### Four device tags — 10 devices, 20 DI and 11 DO — appear in the equipment list but on no block of the flowsheet

- **kind** missing_tag
- **found** Cross-checking every data.tags entry against processes.js: 52 of the 56 device tags are placed, 4 are not — SHT-BV-301 (qty 2, 'Sludge tank ball valves', slide 6), SHT-P-401 (qty 1, 'Sludge discharge pump', slide 7), ACF-BV-611 (qty 3, 'Ball valve to EQT + BF valve to garden', slide 9), SFP-XV-711 (qty 3, 'PP, SP & outlet valves', slide 10). No node cites any of them, so an engineer reading the PFD cannot find the equipment those 31 wired points belong to. The itcPlant.test.js assertion only checks the reverse direction ('only cites device tags that exist in the equipment list'), so nothing catches this.
- **proposal says** processes.js transcribes all four from the proposal's own Controls Involved tables. SHT-P-401 is also drawn: the schematic shows 'SHT -> screw/discharge pump -> POLY DOSING', so the sludge discharge pump is a physical block the sheet omits between sht and poly_dose. ACF-BV-611's 'ball valve to EQT' is the backwash return valve on e_acf_bw/e_mgf_bw and its 'BF valve to garden' is a second garden route off the filtered-water header.
- **suggested fix** Add a pump node sht_p between sht and poly_dose tagged ['SHT-P-401'] (source 'Slide 7 — discharge 2 m³/hr @ 35 m, Roto'), attach SHT-BV-301 to the sht node's tags, attach SFP-XV-711 to a new sfp_v_out valve node between sfp_p and sof (matching the inlet/outlet valve pattern used in ELP, RFP and FFP), and attach ACF-BV-611 to a valve node on the backwash return or to at_601. Then add a test asserting the forward direction — every processes.js device tag lands on at least one node.

### No stream numbers anywhere, so a PFD cannot key a stream table to the lines it draws

- **kind** diagram_gap
- **found** The complete set of keys used across all 60 edges' data is [streamType, label, role, isRecycle]. There is no streamNo/tag field, and edge ids ('e_ffpvo_acf') are internal identifiers, not drawable stream numbers. The solver already returns a full per-edge stream table (streamResults keyed by edge id, with Q, TSS, BOD, COD, TN, NH4, TP, pH, temp on each) — the only missing link is the printed number that ties a balloon on the drawing to a row in that table.
- **proposal says** This is the one convention every printed PFD relies on and the proposal has no equivalent of; the schematic annotates lines with sizes rather than numbers, so the numbering has to be authored here.
- **suggested fix** Add `streamNo` to the edge() opts and number the 60 edges in solve order (the solver's kahnOrder already gives a stable topological sequence), then render it as a small balloon at midspan in StreamEdge and emit the same number as a column in the CSV/JSON export at /simulate/:runId/export — which is what turns the existing streamResults into the stream table beside the drawing.

### Every node carries data.area but the geometry supports lane bands in neither axis, and nothing renders the area anyway

- **kind** diagram_gap
- **found** All 55 nodes have data.area (11 distinct values, matching the 11 proposal areas). Bounding boxes: ELP x40–980 y40–340, RFP x1170–1710 y190, R x1710–2280 y30–470, FFP x2100–3020 y90–330, SHT x2460–3010 y470–540, ACF x3200–3560 y90, UF x3200–3930 y330–560, SFP x3750–4110 y30–190, HWTP x3750–4290 y250, FWTP x4110–4650 y420, SWTP x4290–5010 y30. Horizontal bands are impossible — R (y30–470) overlaps ELP, FFP, SHT and UF. Vertical bands are impossible too — RFP's extent (1170→1878 with the 168 px card) overlaps R, FFP overlaps both R and SHT, ACF overlaps UF, SFP overlaps UF and HWTP. And UnitOpNode never reads data.area, so no band, header or colour is drawn from it today.
- **proposal says** The proposal is organised as eleven numbered process areas (slides 4–14) and ioSchedule.js maps each area to one of the four PLC panel nodes; a printed PFD of this plant is expected to show those areas as lanes with the panel assignment in the lane header.
- **suggested fix** Either commit to horizontal lanes — assign each area a y band (ELP 0–200, RFP 220–360, R 380–620, SHT 640–820, FFP 840–1020, ACF/UF/SFP/HWTP/FWTP/SWTP below) and re-lay the positions so no two areas share a band — or add an explicit `lane` field per node plus a lane-band layer in CanvasPage that draws the band, the area code and ioSchedule.NODE_OF_AREA's panel name. Do it before the recycle waypoints are authored, since the return lane depends on the final vertical extent.

### Two equipment cards physically overlap by 56 px on the printed sheet

- **kind** diagram_gap
- **found** Node cards are 168 × 116 px (frontend/src/components/canvas/UnitOpNode.jsx styles: --ws-card-w 168px, --ws-card-h 116px). reject_out sits at (4110,190) and ft_irr at (4110,250) — identical x, 60 px apart in y, so the two boxes overlap 168 × 56 px and the regeneration-reject block covers the top half of the irrigation water meter. It is the only collision on the sheet; every other row keeps a 12 px horizontal gutter at the 180 px pitch.
- **proposal says** The schematic keeps the softener's REGENERATION TO REJECT drop clear of the irrigation header running below it; the two are unrelated services in different process areas (SFP and HWTP).
- **suggested fix** Move reject_out from V(4110,190) to V(4290,160) or drop it below the softener at V(4110,150) with the irrigation row pushed to y 300 — anything giving ≥ 130 px of vertical clearance from ft_irr. Adding a bounding-box collision assertion to backend/src/__tests__/itcPlant.test.js alongside the existing 'references only nodes that exist' test would keep it from recurring.

### The UF backwash pump's stated 15 m³/hr duty is not in its params, so the model treats it as unlimited

- **kind** wrong_param
- **found** ufbp params are { running:1, speed_pct:100, capacity_m3_d:0, head_m:15 } while its data.source reads 'Slide 11 — 15 m³/hr @ 15 m, Grundfos, qty 2'. pump.js documents capacity_m3_d '0 = unlimited' and computes Q_delivered = Q_in × speed/100 when capacity is 0 — so the pump cannot limit and reports Q_delivered 15.1 m³/d simply because that is what the Sintex split hands it. The 15 m³/hr figure is used elsewhere in the codebase (narrative.js UF_CYCLE.backwashPump_m3_h = 15, and the sintex splitRatios assumption '1 min of UFBP at 15 m³/hr against 20 min of UFFP at 10 m³/hr'), so the number is known — it is just not on the node. Contrast uffp, whose stated 10 m³/hr is correctly carried as capacity_m3_d 240.
- **proposal says** Slide 11 and the schematic both state UFBP CAP 15 m³/hr @ 15 m, GRUNDFOS, QTY 2. swtp, hwtp and fwtp legitimately hold capacity_m3_d 0 because the proposal states no capacity for them ('Grundfos, qty 3'); ufbp is the one pump with a stated duty that is not carried.
- **suggested fix** Set ufbp.params.capacity_m3_d to 360 (15 m³/hr × 24), matching the uffp pattern. If the intent is that the pump only runs 1 minute in 21, encode that as an explicit duty-cycle note rather than as an unlimited capacity, so the PFD block can print '15 m³/hr @ 15 m, 1 min in 21'.

## Low severity (36)

### The Hiller decanter centrifuge is parameterised as a DAF thickener and carries no hydraulic rating for its stated 1 m³/hr duty

- **kind** wrong_param  ·  raised independently by 4 auditors
- **found** flowsheet.js `centrifuge` params: `{ type: 'DAF', target_TSS_mg_L: 180000, capture_pct: 95 }`. sludgeThickener.js TYPE_DEFAULTS.DAF sets SLR_kg_m2_d 120 (a flotation loading rate), which drives metrics.area_m2 — a meaningless number for a decanter bowl — and metrics.type is reported as 'DAF' on every screen and report that reads the unit. There is no rated_flow / capacity param, so nothing checks the feed (13.29 m³/d) against the 24 m³/d the machine is rated for; if the sludge rate ever exceeded it the sheet would not notice.
- **proposal says** processes.js process 4 spec.pumps: 'Centrifuge 1 m³/hr (Hiller)'; device SHT-P-421 'Centrifuge (decanter centrifugal)'. flowsheet.js's own source string reads 'Slide 7 — Hiller, 1 m³/hr'. The slide-3 schematic labels the unit CENTRIFUGAL, CAP 1 M³/hr, MAKE HILLER.
- **suggested fix** Set `type: 'gravity'` (which is TYPE_PARAM_DEFAULTS' own default for sludge_centrifuge and gives an SLR that is at least not a flotation figure) or, better, record the real machine: keep the explicit target_TSS_mg_L 180000 / capture_pct 95 and add `rated_flow_m3_h: 1` plus a data.assumption noting that the thickener model is standing in for a decanter centrifuge and that SLR-derived area is not meaningful for it.

### SOF-FT-701, the softener outlet flow meter, is the only one of the plant's seven flow meters without an instrument node

- **kind** missing_node  ·  raised independently by 2 auditors
- **found** SOF-FT-701 is cited on the sof node (l.223, tags:['SOF-BV-701','SOF-FT-701']) so it is not orphaned, but it has no node of its own and therefore no measurement/range_min/range_max/tag params. All six other meters do: ft_201, ft_acf, ft_mf, ft_swt, ft_irr, ft_fwt. Its schedule row SOF-FT-701.FT exists in buildTagList() with nothing on the canvas to bind to.
- **proposal says** processes.js process 7 (slide 10): `{ tag:'SOF-FT-701', qty:1, name:'Softener outlet flow meter', kind:'flow_meter' }`, and the slide-10 spec lists meters: 'Softener flow'.
- **suggested fix** Add node('ft_sof','instrument','FT — Softener outlet flow', between sof and swt, { area:'SFP', tags:['SOF-FT-701'], source:'Slide 10 — softener flow meter (1 AI)', params:{ measurement:'flow', range_min:0, range_max:600, tag:'SOF-FT-701' } }) and re-point e_sof_swt through it.

### The 25 mm 'excess/surplus supply water to tanker' take-off on the filtered-water line has no node or boundary

- **kind** missing_node  ·  raised independently by 2 auditors
- **found** summary.boundaries lists exactly five outlets (solids_out, reject_out, cooling_tower, irrigation, flush_out). No node in NODES has 'tanker' in its label, and no edge leaves ft_acf / acf / mgf / at_601 other than the two filtered-water splits and the two backwash returns. With the ACF/MGF leg carrying 306 m³/d and every drop committed to the softener or irrigation, the sheet has no way to represent surplus being carted off site.
- **proposal says** The slide-3 schematic draws an 'EXCESS/SURPLUS SUPPLY WATER TO TANKER' 25 mm take-off on the ACF/MGF filtered-water line.
- **suggested fix** Add `node('tanker_out', 'outlet', 'Surplus water to tanker', ..., { area: 'ACF', source: 'Slide 3 schematic — 25 mm surplus take-off', params: { discharge_type: 'water' } })` fed from `at_601`, extending at_601's splitRatios to three entries with the surplus share recorded as a data.assumption (the proposal states no share). If it is intended to be normally closed, a zero-ratio edge still puts the boundary on a printed PFD.

### The centrifuge's stated 1 m³/hr duty exists only in the node label — there is no capacity field to check the feed against

- **kind** diagram_gap
- **found** The centrifuge params are `{ type, target_TSS_mg_L, capture_pct }` (flowsheet.js:164); the 1 m³/hr Hiller rating appears only in the label text and `source` string. Every other rated vessel in the sheet carries the duty as a parameter — acf/mgf `rated_flow_m3_h: 25`, mf `rated_flow_m3_h: 20`, sof `rated_flow_m3_h: 20`, and every pump carries `capacity_m3_d`. Solved, the centrifuge sees 13.29 m³/d against a 24 m³/d machine (≈13.3 h/d of running) and nothing in the sheet states, checks or reports that.
- **proposal says** Slide 7 spec line: 'Centrifuge 1 m³/hr (Hiller)'.
- **suggested fix** Add `rated_flow_m3_h: 1` to the centrifuge params (and, if the drain/supernatant fixes land, a `note` giving the resulting daily run hours), so a printed PFD and the node card show the machine's stated duty next to its computed load.

### The poly dosing node states neither the 0–30 lph pump range nor the 500 L tank, and its 4 mg/L dose is an unmarked assumption

- **kind** diagram_gap
- **found** `poly_dose` params are `{ dose_mg_L: 4 }` (flowsheet.js:160) with `source: 'Slide 7 — Milton dosing pump, 500 L tank'` and no `assumption` field. The proposal states the pump range and tank volume but never a dose, so 4 mg/L is a chosen placeholder presented as sourced — the exact distinction the file header (flowsheet.js:8-21) says must be visible on the node. The stated capacities appear in no param, so a printed PFD generated from the sheet cannot label the dosing skid.
- **proposal says** Slide 3 schematic: 'POLY DOSING (CAP 0-30 lph, MILTON, QTY 1, TANK CAP 500 ltrs)'; processes.js:172 repeats 'Dosing 0–30 lph (Milton)' and processes.js:173 'poly dosing tank 500 L'.
- **suggested fix** Add `pump_capacity_lph: 30` and `tank_volume_L: 500` to the poly_dose params, and an `assumption` such as 'Polymer dose is not stated; 4 mg/L on the sludge feed (≈1 kg per tonne dry solids) is used', matching how EQT, SHT, INT-WT and the filter splits are already documented.

### The CT → ELP suction line carries no size label, though every other line in the feed-water area does

- **kind** missing_tag
- **found** edge('e_ct_elpv', 'ct', 'elp_v_in') is authored with no opts, so its data is just { streamType: 'stream' } — no label. Its three siblings on the same drawing all carry theirs: e_ogt_eqt '150 mm UPVC', e_sewage_eqt '150 mm UPVC', e_elpvo_eqt '65 mm UPVC'. The ELP line is therefore the only one on the sheet where a printed PFD would show a pump suction with no size on it.
- **proposal says** Slide 3 draws 'CT -> 50mm UPVC -> ELP pump set' and processes.js feed_water spec.pipe records the area's line as 'UPVC 50 mm', which is that suction leg (the 65 mm on the discharge side is already labelled).
- **suggested fix** edge('e_ct_elpv', 'ct', 'elp_v_in', { label: '50 mm UPVC' }).

### The transcribed influent table records a bar chamber only on the sewage line, so kitchen and laundry pretreatment reads as OGT/CT alone

- **kind** diagram_gap
- **found** proposal.js INFLUENT (lines 185-189) is [{ 'Kitchen influent', 100, pretreatment: 'Oil & grease trap (OGT)' }, { 'Sewage influent', 475, pretreatment: 'Bar chamber' }, { 'Laundry influent', 100, pretreatment: 'Collection tank (CT)' }]. This object is re-exported verbatim as IDENTITY.influent in index.js and shown on the plant page, so the one place a reader looks up 'what pretreats each stream' says two of the three lines have no screening. It is also the only mention of a bar chamber in the whole plant module (a grep for 'bar chamber' across backend/src/plants returns this single hit), which is very likely why the flowsheet omits all three.
- **proposal says** Slide 3 draws a bar chamber ahead of the OGT on the kitchen line and ahead of the CT on the laundry line, each 400×500 mm SS304, 2 nos — the same first-stage screening the sewage line gets.
- **suggested fix** Record the full train per stream, e.g. pretreatment: 'Bar chamber (2 × 400 × 500 mm SS304) → oil & grease trap (OGT)' for kitchen, 'Bar chamber (2 × 600 × 1000 mm SS304)' for sewage, and 'Bar chamber (2 × 400 × 500 mm SS304) → collection tank (CT)' for laundry.

### FWTP carries a 25 m head and unlimited capacity that slide 13 never states, with no data.assumption to say so

- **kind** wrong_param
- **found** flowsheet.js line 310-314: fwtp source is 'Slide 13 — Grundfos, qty 3' and params are { running:1, speed_pct:100, capacity_m3_d: 0, head_m: 25 } with a `note` about the missing pressure transmitter but no `assumption`. processes.js process 10 spec.pumps is just 'Grundfos, qty 3' — no head, no capacity. The 25 m head is load-bearing: models/pump.js turns it into the solved metrics power_kW 0.81 and energy_kWh_d 19.6 for this pump.
- **proposal says** The flowsheet header states the rule for this sheet: 'data.assumption where the proposal does NOT state a value and one had to be chosen … an engineer opening this sheet must be able to tell the plant's stated design from a placeholder, at a glance, on the node itself.' Head is not stated on slide 13.
- **suggested fix** Add assumption: 'Head and capacity are not stated on slide 13; 25 m is assumed for a building flush-water header and the pump is left uncapped.' to the fwtp node (the same wording applies to swtp and hwtp).

### The narrative feeds the UF line from ACF/MGF while the flow feeds it from the FFP outlet — the divergence is resolved silently, with no review note

- **kind** diagram_gap
- **found** EDGES route e_ffpvo_mf: 'ffp_v_out' -> 'ft_mf' -> 'mf' -> UF, i.e. the micron/UF leg is one of the three FFP outlet splits ([0.55, 0.35, 0.10]). narrative.js section VII step 1 reads 'Water from ACF and MGF filter flows into UF' and section V step 2 reads 'The three processes from ACF and MGF filter are: SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT'. Neither step carries a `review:` field, unlike the comparable contradictions that do (II.1 INT-WT vs EQT, III.2 MLSS as a percentage), so narrativeFindings() never surfaces it and review() shows nothing.
- **proposal says** The slide-3 schematic and narrative IV.4 ('The pumped water is split into two lines. One line is directed to ACF & MGF filter and the other line is directed to Micron filter') support the flowsheet's routing; sections V.2 and VII.1 of the same document contradict it. The flow picks one reading without recording that it did.
- **suggested fix** Add a review note on narrative section 'uf' step 1 (and/or a `note` on the `mf` node) saying the UF line is taken off the FFP outlet header per slide 3 and step IV.4, and that VII.1/V.2 read as a transcription slip — so the choice appears in review() like the other narrative divergences.

### No edge on the micron/UF/flush line carries the pipe size the proposal states, though three influent edges do

- **kind** diagram_gap
- **found** Of the 13 edges from e_ffpvo_mf through e_ft_flush, only e_uf_sintex ('Permeate'), e_sintex_ufbp ('Backwash draw') and e_ufbp_eqt ('Spent backwash to EQT') carry any data.label, and none names a size. The sheet does print sizes elsewhere: e_ogt_eqt and e_sewage_eqt are labelled '150 mm UPVC' and e_elpvo_eqt '65 mm UPVC', so a PFD rendering data.label prints line sizes for the influent and nothing for the whole flush-water train.
- **proposal says** Slide-3 schematic: 'UF permeate -> 50mm CPVC -> SINTEX TANK 1000L' and '80mm CPVC -> TO MICRON FILTER'. processes.js process 8 spec.pipe = 'UPVC 50 mm · CPVC 80 mm micro-filter backwash'; process 10 spec.pipe = '100 mm'.
- **suggested fix** Label the stated lines: e_ffpvo_mf '80 mm CPVC', e_mf_ufv / e_ufv_uffp '50 mm UPVC', e_uf_sintex '50 mm CPVC', the new micron backwash edge '80 mm CPVC', and e_fwt_fwtp / e_fwtp_ft '100 mm'.

### swtp / hwtp / fwtp carry head_m: 25 and capacity 0 although the proposal states no duty for these pumps, and the head is what the reported energy is computed from

- **kind** wrong_param
- **found** flowsheet.js lines 243, 263, 313: all three transfer pumps have `{ running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 25 }`. Their `source` strings are 'Slide 14 — Grundfos, qty 3', 'Slide 12 — Grundfos' and 'Slide 13 — Grundfos, qty 3' — no flow, no head. Each node carries a `note` about the missing pressure transmitter but no `assumption` field. The pump model turns head straight into reported numbers: swtp power_kW 0.78 / energy_kWh_d 18.7 and hwtp 0.79 / 18.9 in a solved run, and those feed the cost estimator's pumping energy. Contrast ufbp, whose head_m 15 IS stated on slide 11, and elp/rfp/ffp/sfp whose 8 m heads are stated.
- **proposal says** flowsheet.js's own header contract: 'Each node carries data.source, naming the slide its parameters were read from, and data.assumption where the proposal does NOT state a value and one had to be chosen … an engineer opening this sheet must be able to tell the plant's stated design from a placeholder, at a glance'. Slides 12, 13 and 14 name only the make and quantity.
- **suggested fix** Add to each of the three nodes: `assumption: 'Neither duty nor head is stated for the Grundfos transfer set; 25 m is assumed for the building header, and capacity is left unlimited so the tank sets the flow.'` — the same treatment the unstated tank volumes already get one line above.

### The softener's stated vessel geometry (Ø1000 × HOS 1500) exists only inside a source sentence, so nothing can print or check it

- **kind** diagram_gap
- **found** sof params (flowsheet.js line 225) contain no diameter: { resin_litres, capacity_g_per_L, feed_hardness_ppm, product_hardness_ppm, salt_g_per_L, regen_water_m3, rated_flow_m3_h }. Every other pressure vessel on the sheet carries its diameter as data — acf diameter_mm 1650, mgf 1500, mf 300 — and pressureFilter.js uses it (`area = π D² / 4 from diameter_mm`, HLR_m_h = Q/24/area). waterSoftener.js takes no diameter, so the Ø1000 figure has nowhere to live and the softener is the one filtration vessel whose loading rate cannot be reported (at its stated 20 m³/hr rating a Ø1000 vessel runs at 25.5 m/hr, which is exactly the number a reviewer would want to see).
- **proposal says** Slide 3 and processes.js process 7 spec.vessels: 'SOF Ø1000 mm · HOS 1500 mm · shell 6 mm · dish end 8 mm · 20 m³/hr'. The dimensions are stated design, not assumption, and an equipment schedule or printed PFD prints them.
- **suggested fix** Add `diameter_mm: 1000` (and, if the model is extended, `hos_mm: 1500`) to the sof params so the stated geometry is machine-readable like the ACF and MGF, and optionally report a service velocity metric from it in waterSoftener.js.

### The softener bypass valve is tagged but the bypass stream it exists to open is not on the sheet

- **kind** missing_edge
- **found** sof cites tags ['SOF-BV-701','SOF-FT-701'] (line 223), and SOF-BV-701 is qty 4, named 'Softener ball valves + bypass valve'. The graph has no path from sfp_p or at_601 to swt that goes around sof — the softener is the only route to the soft water tank, so with SOF isolated the SWT and the cooling tower go to zero flow in the model.
- **proposal says** processes.js process 7 (slide 10) explicitly names a bypass valve in the SOF-BV-701 group. Elsewhere on the sheet a bypass valve does get a stream — ffp_v_out is labelled '(4, incl. bypass)' and carries e_ffpvo_garden.
- **suggested fix** If the bypass is a real operating line, add `edge('e_sof_bypass', 'sfp_v_in', 'swt', { label: 'Softener bypass' })` (with the corresponding splitRatios and an assumption, since no bypass share is stated). If it is a manual maintenance line only, say so in a note on the sof node so the tag's fourth valve is accounted for.

### ACF/MGF nodes lack the vessel geometry the proposal states, and the backwash duty they do carry has no assumption marker

- **kind** diagram_gap
- **found** `acf.params` and `mgf.params` carry only `diameter_mm`. HOS 1500 mm (both), shell 8 mm (ACF) / 6 mm (MGF) and dish end 8 mm — all stated on slide 9 and transcribed into processes.js area 6 spec — appear nowhere on the nodes, so the sheet cannot print a vessel schedule or compute bed volume / EBCT for the carbon. Conversely `backwash_interval_h: 24`, `backwash_m3_per_wash: 6` (ACF) and `5` (MGF) and `chlorine_in_ppm: 1.0` are values the proposal never states, and neither node carries an `assumption` field — while flowsheet.js's own header promises one 'where the proposal does NOT state a value and one had to be chosen'. Those three numbers set the 11.0 m³/d of backwash the sheet returns to EQT and the 95 % dechlorination it reports.
- **proposal says** processes.js area 6 spec (slide 9): 'ACF Ø1650 mm · MGF Ø1500 mm · HOS 1500 mm · shell 6 mm · dish end 8 mm · 25 m³/hr each'. flowsheet.js header: 'Each node carries data.source … and data.assumption where the proposal does NOT state a value.'
- **suggested fix** Add `hos_mm: 1500`, `shell_mm: 8` / `6`, `dish_end_mm: 8` to the two nodes, and an `assumption` on each: 'Backwash interval and volume are not stated; 24 h and 6 m³ (ACF) / 5 m³ (MGF) per wash are used. Inlet residual of 1.0 ppm is the top of the narrative's dosing band.'

### The three FFP outlet legs and the INT-WT suction carry no pipe size, though the schematic dimensions every one of them

- **kind** diagram_gap
- **found** `e_int_cl`, `e_cl_ffpv`, `e_ffpv_ffpp`, `e_ffpp_ffpvo`, `e_ffpvo_acf` and `e_ffpvo_mf` carry no `label` at all; `e_ffpvo_garden` carries only 'Bypass to garden'. The `edge()` helper supports a label and the file already uses it for exactly this on the influent side — '150 mm UPVC' on `e_ogt_eqt` and `e_sewage_eqt`, '65 mm UPVC' on `e_elpvo_eqt` — so the convention exists and stops at this split.
- **proposal says** Slide 3 schematic: 'INT-WT -> 100mm -> FFP filter feed pump set … with REDUCER 3"x2" on two legs: 80mm CPVC -> TO MICRON FILTER, BYPASS UPVC -> TO GARDEN, 80mm CPVC -> TO ACF & MGF FILTER'. processes.js area 5 spec: `pipe: 'UPVC 100 mm'`; area 6: `pipe: 'CPVC 80 mm frontal piping'`. A printed PFD needs the size on the line.
- **suggested fix** Label the edges: `e_int_cl` / `e_cl_ffpv` '100 mm UPVC', `e_ffpvo_acf` '80 mm CPVC (3"×2" reducer)', `e_ffpvo_mf` '80 mm CPVC (3"×2" reducer)', `e_ffpvo_garden` 'UPVC bypass to garden'.

### The INT-WT chlorine skid's stated capacity and tank volume are on no node

- **kind** diagram_gap
- **found** `cl_dose.params` is `{ chemical_type, dose_mg_L: 1.0 }` only. Neither the dosing pump capacity nor the tank volume appears anywhere on the node, and its `source` cites slide 23 (the narrative) but not slide 8, where the skid is specified. The sheet computes `dose_kg_d: 0.6` at this node (576.4 m³/d × 1 mg/L), which as 5 % hypochlorite is ≈12 L/d ≈ 0.5 lph — comfortably inside the stated 0–12 lph band, but nothing on the sheet lets a reviewer make that check. The equivalent SWT skid at least names its duty in the node label, 'SWT Cl₂ dosing (0–12 LPH)'.
- **proposal says** processes.js area 5 (slide 8) spec: `tanks: 'INT-WT · Cl dosing tank 200 L (Milton Roy 0–12 lph)'`.
- **suggested fix** Add `pump_capacity_lph_max: 12`, `tank_volume_L: 200`, `make: 'Milton Roy'` to `cl_dose.params`, and cite slide 8 alongside slide 23 in `source`.

### The micron filter's two assumed numbers cannot coexist, so the model pins it at its 40 % derate floor on every run

- **kind** wrong_param
- **found** `mf.assumption` reads 'a 300 mm housing at 20 m³/hr is used', and the params are `diameter_mm: 300, rated_flow_m3_h: 20`. 300 mm gives 0.071 m², so 20 m³/hr is 283 m/h against the micron media's rated 20 m/h in pressureFilter.js. Even at the sheet's actual 8.4 m³/hr the metrics come back `HLR_m_h: 118.92, derate_pct: 40, TSS_removal_pct: 36` — the derate floor — instead of the media's 90 % clean-bed figure. The UF feed is therefore shown at 13.0 mg/L TSS instead of ≈2, and the flush water reaches `flush_out` at 9.1 mg/L against the app's own 10 mg/L reuse template (REUSE_CRITERIA in index.js). The `assumption` field documents the choice of size; it does not document that the two chosen values contradict each other under the model, or that the filter is permanently derated as a result.
- **proposal says** Slide 8 draws a micron filter ahead of the UF membranes without stating its size, so a size had to be chosen — but the chosen pair must be self-consistent for the computed removal on this leg to mean anything.
- **suggested fix** Size the housing to the assumed duty: 20 m³/hr at the media's 20 m/h rating needs ≈1.0 m², i.e. `diameter_mm: 1130`. Alternatively keep the 300 mm housing and drop `rated_flow_m3_h` to the ≈1.4 m³/hr it actually supports, and say in the assumption which of the two was chosen and why.

### SHT-BV-301, the two sludge-tank ball valves in the reactor process, sit on no node in the flowsheet

- **kind** missing_tag
- **found** Cross-checking every device tag in processes.js against `NODES[].data.tags`, SHT-BV-301 (area 'R', qty 2, 'Sludge tank ball valves', printed 4 DI / 2 DO) is the only reactor-area device with no node. The sht node (flowsheet.js:153) tags only SHT-LT-401. Every other area-'R' and area-'RFP' tag resolves (R-XV-301, R-P-301, STP-XV-301, R-AV-301, R-B-301, R-LT-301, R-DEC-301, RFP-XV-201, RFP-P-201, RFP-XV-211, RFP-FT-201).
- **proposal says** Slide 6 lists SHT-BV-301 in the Reactor Process controls table at qty 2. Slide 3 draws the SHT with a supranatant insert and a 50 mm UPVC overflow, both valved.
- **suggested fix** Add the tag to the sht node (`tags: ['SHT-LT-401', 'SHT-BV-301']`) or, if the valves are the inlet/overflow isolations, draw them as a small `valve` node on the SHT inlet so the 6 signals have a place on the sheet.

### The reactor feed, decant and sludge-transfer lines carry no pipe size, although the sheet labels pipe sizes on the influent lines

- **kind** diagram_gap
- **found** flowsheet.js labels `e_ogt_eqt` and `e_sewage_eqt` '150 mm UPVC' and `e_elpvo_eqt` '65 mm UPVC' (lines 328-334), but `e_eqt_rfpv` … `e_ft_r1` / `e_ft_r2` (lines 337-342), `e_r1_int` / `e_r2_int` (345-346, labelled only 'Decant') and `e_r1_stp` / `e_r2_stp` / `e_stpp_sht` (349-352) carry none. The `edge()` helper already supports `label`, so the field exists and is simply unfilled on this dimension's lines.
- **proposal says** Slide 3 dimensions all of them: RFP discharge '100mm UPVC' with a 'REDUCER 3"x2"' before the reactor valves; the decant as 'OVERFLOW 100mm' to INT-WT; the sludge transfer as '80mm UPVC' to SHT. Slide 5 spec.pipe = 'UPVC 100 mm' and slide 6 spec.pipe = 'UPVC 80 mm' confirm both.
- **suggested fix** Label `e_rfpvo_ft` / `e_ft_r1` / `e_ft_r2` '100 mm UPVC' (and note the 3"×2" reducer on the reactor-valve node), `e_r1_int` / `e_r2_int` 'Decant — 100 mm overflow', and `e_stpp_sht` '80 mm UPVC'.

### The decanter's duty is nowhere in the data — the 45-minute decant implies 86 m³/hr per reactor, twice the fill rate, and nothing states it

- **kind** diagram_gap
- **found** r1/r2 carry `decant_h: 0.75` and the tag R-DEC-301 (flowsheet.js:125-131), but no decant volume, decanter draw rate or weir length; the sbrReactor model has no such parameter either (DEFAULTS: reactors, fill_h, aerate_h, settle_h, decant_h, feed_pump_m3_h, decant_TSS_mg_L, SRT_d, MLSS_mg_L, DO_set_mg_L, volume_m3, denitrification, anoxic_fraction, temp). The implied duty falls straight out of the solved metrics: `volume_per_fill_m3: 64.5` drawn off in 0.75 h = 86.0 m³/hr per reactor, i.e. 2× the 43 m³/hr feed. In a 100 mm decant line that is ≈3.0 m/s, above the usual UPVC design band — so it is the hydraulically binding number in the whole reactor area and it appears nowhere.
- **proposal says** Slide 6 lists R-DEC-301 as 'R1 + R2 decanters with VFD' at 2 DI / 2 DO (start/stop plus fwd/rev — a speed-controlled travelling weir). Narrative II.12 gives it a 45-minute stroke and a reverse; slide 3 draws the decant on a 100 mm overflow to INT-WT.
- **suggested fix** Add `decant_rate_m3_h: 86` (or `decant_volume_m3: 64.5`) to r1/r2 params with a `data.assumption` noting it is derived from the stated fill volume and decant time, not printed in the proposal — it is the field a PFD needs to size the decanter drive and the 100 mm overflow.

### ft_swt is spanned 0–400 m³/d (16.7 m³/hr), below the 20 m³/hr rating of the softener that is the only stated duty feeding it

- **kind** wrong_param
- **found** flowsheet.js ft_swt: `range_min: 0, range_max: 400`. The `sof` node's stated rating is `rated_flow_m3_h: 20` (slide 10, 'FLOW RATE 20 m³/Hr') = 480 m³/d, and the whole SOF → SWT → SWTP → ft_swt → cooling tower path is in series, so at the softener's rated throughput the meter reads 480 against a 400 span and instrument.js raises 'Flow meter reading 480.00 m³/d is outside its 0–400 calibrated span — the loop is saturated'. Every other meter has headroom over the duty feeding it: ft_201 1200 vs RFP 1032 m³/d; ft_acf 600 vs ACF 25 m³/hr = 600; ft_mf 600 vs MF 20 m³/hr = 480; ft_fwt 400 vs UFFP 10 m³/hr = 240; ft_irr 400 vs a 330 m³/d maximum (10 % bypass of 1032 plus 40 % of a 568 m³/d ACF leg). At the current 675 KLD balance ft_swt reads 178.2 (44.6 % of span), so the fault is latent, not visible in today's solve.
- **proposal says** Slide 10 states the softener flow rate as 20 m³/hr; slide 14 puts the soft-water meter between SWTP and the cooling tower on that same water.
- **suggested fix** Raise ft_swt's `range_max` from 400 to 600 in flowsheet.js so the span covers the softener's stated 480 m³/d rating with headroom, matching the convention used on ft_acf/ft_mf.

### Only one of the two scheduled OGT-LSH-101 level switches is represented — ct declares has_level_switch, ogt cannot

- **kind** missing_tag
- **found** ioSchedule emits two DI rows, OGT-LSH-101/1.LSH and OGT-LSH-101/2.LSH, for the qty-2 device 'OGT + CT high-level switches'. The `ct` node sets `has_level_switch: 1` and equalisationTank.js reports metrics.level_instrument = 'Level switch (high only)'. The `ogt` node cites the same tag but is an oil_grease_trap; oilGreaseTrap.js DEFAULTS is { volume_m3, rated_HRT_min, fog_in_mg_L, fog_removal_pct, TSS_removal_pct, grease_capacity_m3 } with no level or switch parameter at all, and the solved ogt metrics have no level_instrument field. So the OGT half of the device is a tag string with nothing behind it, while the CT half is modelled.
- **proposal says** processes.js process 1 (slide 4): { tag: 'OGT-LSH-101', qty: 2, name: 'OGT + CT high-level switches', kind: 'level_switch', printed: { DI: 2 } }, with the note 'two switches are wired'. narrative.js I.4 'Monitor the EQT and check the status of OGT and CT' interlocks on both.
- **suggested fix** Either add a `has_level_switch` / `high_level_pct` parameter to oilGreaseTrap.js and set `has_level_switch: 1` on the `ogt` node so the model reports the switch the way equalisationTank does, or (minimum) add `has_level_switch: 1` plus a data.note on `ogt` recording that the trap's high-level switch is wired but not modelled, so a printed PFD shows both switches.

### The sludge-transfer interlock has no AI point and, unlike the plant's other three unmeasured loops, no note on the node that would use it

- **kind** diagram_gap
- **found** narrative.js section III step 2 interlocks the sludge transfer on 'MLSS should be 30% to 50%' with setpoints mlss_low_pct 30 / mlss_high_pct 50, and its own `review` says 'no MLSS analyser appears in the I/O schedule'. Confirmed: the 17 AI points are 9 level_tx + 7 flow_meter + 1 ph_analyser; there is no solids/turbidity/MLSS analyser anywhere. The flowsheet's established convention is to record such a gap in data.note on the node that would close the loop — cl_dose carries 'No residual-chlorine analyser is scheduled anywhere in the proposal, so this loop has nothing to close on as specified', and swtp, hwtp and fwtp each carry 'The narrative controls this pump on header pressure, but no pressure transmitter is scheduled for this area.' None of stp_v_in, stp_p, sht, r1 or r2 carries the equivalent note, so this is the one unmeasured loop the sheet does not disclose in place.
- **proposal says** narrative.js section III (slide 22) makes the STP sludge-transfer start permissive a measured sludge concentration; processes.js process 4 (slide 7) schedules only SHT-LT-401 (level) for that area.
- **suggested fix** Add a data.note to `stp_p` (or to `sht`) in flowsheet.js along the lines of: 'Narrative III.2 starts this transfer on a 30–50 % sludge band, but no MLSS or settled-sludge analyser is scheduled — the only AI in this area is SHT-LT-401 level, so the interlock has no measurement to close on as specified.' This matches the treatment already given to the chlorine and header-pressure loops.

### UFBP is left at capacity_m3_d: 0 (unlimited) although the proposal states 15 m³/hr — the only stated-duty pump on the sheet without its rating

- **kind** wrong_param
- **found** flowsheet.js `ufbp` params: `{ running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 15 }` with source 'Slide 11 — 15 m³/hr @ 15 m, Grundfos, qty 2'. pump.js documents `capacity_m3_d 0 = unlimited`. Every other pump whose duty the proposal states carries it: elp_p 120, rfp_p 1032, stp_p 240, ffp_p 1032, sfp_p 1032, uffp 240. Only swtp/hwtp/fwtp are legitimately 0 — the proposal gives them no duty, only 'Grundfos qty 3'. The head (15 m) was transcribed but the flow (15 m³/hr = 360 m³/d) was not.
- **proposal says** processes.js process 8 spec.pumps: 'UFFP 10 m³/hr @ 25 m Grundfos qty 2 (1W + 1SB) · UFBP 15 m³/hr @ 15 m Grundfos qty 2'. narrative.js UF_CYCLE.backwashPump_m3_h = 15.
- **suggested fix** Set `capacity_m3_d: 360` on `ufbp`. It does not change today's answer (the sintex split delivers only 15.13 m³/d) but it makes the node able to flag an over-duty backwash and gives a printed PFD/BOQ the rating it needs; leaving it at 0 silently means 'unlimited' on a line the proposal explicitly rates.

### The FFP garden bypass is piped into IRR-WT rather than to garden, blending 57.6 m³/d of unfiltered water into the irrigation boundary

- **kind** wrong_route
- **found** `edge('e_ffpvo_garden', 'ffp_v_out', 'irr_wt', { label: 'Bypass to garden' })` — the label says garden, the target is the tank. Solved Q=57.64 m³/d at TSS 20 mg/L (post-chlorination INT-WT water that has seen neither the ACF/MGF nor the pH analyser), against 122.41 m³/d of filtered water at TSS 2 arriving on e_ph_irr. The irrigation boundary consequently leaves at TSS 8 mg/L rather than 2, and 32 % of the irrigation flow is unfiltered. Neither ffp_v_out nor irr_wt carries a data.assumption recording this routing choice (ffp_v_out's assumption covers only the 55/35/10 split magnitudes).
- **proposal says** The slide-3 schematic shows the FFP's third leg as 'BYPASS UPVC -> TO GARDEN', a direct take-off, not a feed into IRR-WT; processes.js process 5 lists the output as 'Garden bypass', separate from the IRR-WT line that process 6/narrative V.2 route from ACF & MGF.
- **suggested fix** Either terminate the bypass at its own boundary — `node('garden_out','outlet','Garden bypass', ..., { params: { discharge_type: 'water' } })` — matching the schematic, or keep it feeding irr_wt and add a data.assumption on ffp_v_out saying the bypass is taken to be tanked rather than piped direct, and noting that it dilutes the irrigation boundary from TSS 2 to TSS 8 mg/L.

### The two lines the proposal calls 'permeate' carry the models' plain effluent with no role, and neither model emits a permeate port

- **kind** missing_tag
- **found** `edge('e_uf_sintex','uf','sintex',{ label: 'Permeate' })` has a label but no role; `edge('e_sof_swt','sof','swt')` has neither. PORT_ALIASES maps permeate -> 'permeate', but `uf` (opType 'uf_membrane' -> screen model) emits only {effluent, screenings} and `sof` (water_softener -> softener model) only {effluent, concentrate}. Verified by dumping unitResults[...].outputs for both nodes. So promoting either label to a role would trip the solver's 'requests stream permeate but produces no such output ... using zero flow' path and silently zero the flush-water and soft-water trains.
- **proposal says** The slide-3 schematic labels the SOF outlet 'PERMEATE' and the UF outlet as permeate to the 50 mm CPVC / Sintex tank line; processes.js process 8 output 'Sintex tank 1000 L → FWT'.
- **suggested fix** Leave the edges roleless (the primary-effluent behaviour is correct) but make it explicit and safe: drop or requalify the 'Permeate' label on e_uf_sintex, or add a note on `uf` and `sof` recording that the model's primary `effluent` port is the proposal's permeate, so a later edit does not convert the label into a role. Alternatively add a `permeate` alias output to the screen and softener models so the proposal's own stream names are addressable.

### The UF module's own retained solids leave as a boundary loss — the schematic's 'BACKWASH TO EQT' arrow off the UF has no edge

- **kind** unrouted_stream
- **found** runSteadyState warns: "Unrouted side stream 'screenings' from uf (Q=0.00 m³/d) — counted as a plant-boundary loss", carrying 0.785 kg/d TSS. The uf node (l.291-294) has one outgoing edge, e_uf_sintex (l.398, permeate). The backwash return that does exist, e_ufbp_eqt (l.401), leaves ufbp — it carries clean Sintex water at 15.1 m³/d with none of the solids the membrane retained, so the mass is dropped at the plant boundary rather than returned.
- **proposal says** The slide-3 schematic draws FEED and BACKWASH TO EQT arrows on the UF module itself. narrative.js VII.10: 'The Backwash Valve is then opened, and the water is directed to the EQT.' processes.js process 8 outputs include 'Backwash to EQT'.
- **suggested fix** Route the UF's own reject with `edge('e_uf_bw','uf','eqt',{ role:'screenings', recycle:true, label:'UF backwash solids to EQT' })`, or re-wire the backwash line as sintex → ufbp → uf → eqt so the returning water actually picks the retained solids up on its way.

### The micron filter's assumed Ø300 mm housing and 20 m³/hr rating cannot both hold — it runs permanently derated to 40 % with the model's overload warning suppressed

- **kind** wrong_param
- **found** mf (l.279-283) sets diameter_mm:300 and rated_flow_m3_h:20. Ø300 gives 0.0707 m²; pressureFilter.js rates micron media at rated_HLR_m_h 20, so 20 m³/hr through that housing would be 283 m/h — 14× the media rating. Solved metrics: mf {HLR_m_h: 118.92, rated_HLR_m_h: 20, derate_pct: 40, TSS_removal_pct: 36} at only 8.4 m³/hr. Because the model's warning at pressureFilter.js l.138-142 fires on Q/24 > rated_flow_m3_h (8.4 < 20), the derate is never reported — the filter silently runs at the 40 % floor.
- **proposal says** The node's own data.assumption documents that the cartridge size is not stated, but the two chosen numbers contradict each other rather than jointly describing one vessel. The schematic and processes.js (slide 8/11) name a micron filter ahead of the UF membranes with no size printed.
- **suggested fix** Make the two assumed values consistent: at the modelled 8.4 m³/hr and the micron media's 20 m/h rating the housing needs ~0.42 m² (Ø ≈ 750 mm), so either diameter_mm: 750 with rated_flow_m3_h: 20, or keep Ø300 and set rated_flow_m3_h: 1.4 so the model's own overload warning fires.

### The DP/DPSP dosing skid at IRR-WT is drawn on the schematic but absent from the flow

- **kind** missing_node
- **found** irr_wt (l.255-259) has one outgoing edge straight to hwtp (e_irr_hwtp, l.389) and no dosing node. The other two tanks with a dosing skid on the schematic both have one: int_wt → cl_dose (l.359) and swt → swt_cl (l.383).
- **proposal says** The slide-3 schematic shows a DP/DPSP dosing skid beside IRR-WT and lists DPSP among the orange equipment labels. (Note there is no matching device tag in processes.js, so this is an unpriced item as well as an undrawn one — worth confirming with the vendor before it is added.)
- **suggested fix** Add a chemical_dosing node between irr_wt and hwtp carrying tags:[] and a data.assumption recording that the schematic shows a DPSP skid for which the proposal prices no I/O, so the reviewer can see the scope question rather than losing it.

### The grease the OGT captures has no outlet node — 10.9 kg/d of TSS leaves as an unnamed boundary loss

- **kind** unrouted_stream
- **found** runSteadyState warns: "Unrouted side stream 'screenings' from ogt (Q=0.07 m³/d) — counted as a plant-boundary loss"; summary.unroutedLosses records 10.875 kg/d TSS and 0.174 kg/d BOD with no destination. ogt (l.60) has one outgoing edge, e_ogt_eqt (l.328). By contrast the centrifuge's cake does get a named destination, solids_out (l.166). The ogt model also reports days_between_cleanout: 0.4 and warns the trap fills in under half a day, so this is a real operational export.
- **proposal says** The slide-3 schematic draws the OGT as a discrete vessel whose captured FOG is removed; proposal.js INFLUENT names it as the kitchen line's pretreatment. A printed PFD needs a labelled destination for it in the same way the centrifuge cake has one.
- **suggested fix** Add node('fog_out','outlet','FOG to disposal', { area:'ELP', source:'Slide 4 — OGT manual skim', params:{ discharge_type:'solids' } }) and `edge('e_ogt_fog','ogt','fog_out',{ role:'screenings', label:'Skimmed FOG' })`.

### The sludge area's stated 'Water drain' output is not represented — the centrifuge has only cake and centrate-to-EQT

- **kind** missing_edge
- **found** centrifuge has exactly two outgoing edges: e_cent_solids (role 'thickened' → solids_out, l.355) and e_cent_eqt (role 'filtrate', recycle → eqt, l.356). No drain outlet exists anywhere in NODES.
- **proposal says** processes.js process 4 (slide 7) lists three outputs: ['Water drain', 'Solid discharge', 'Centrate to EQT']. The slide-3 schematic likewise shows DISCHARGE (solids), DRAIN (water) and a separate line back to EQT — three destinations, of which the flow draws two.
- **suggested fix** Either add a drain outlet node fed off the centrifuge (splitting the filtrate between drain and EQT with a documented assumption), or add a data.assumption on the centrifuge node stating that 'Water drain' and 'Centrate to EQT' were read as the same line — right now the sheet neither draws the third output nor records the decision.

### STP-XV-301 covers four valves (inlet and outlet) but only one inlet-valve node exists, so the sludge transfer pump has no outlet valve group

- **kind** missing_node
- **found** stp_v_in (l.146-148) is labelled 'STP inlet valves (2)' and cites STP-XV-301, whose processes.js entry is qty 4, 'STP PP & SP inlet + outlet valves'. The pump discharges straight to the tank: e_stpp_sht (l.352). The tag is cited so nothing is orphaned, but of the four other pump sets three draw both valve groups (ELP, RFP, FFP).
- **proposal says** processes.js process 3 (slide 6): `{ tag:'STP-XV-301', qty:4, name:'STP PP & SP inlet + outlet valves' }`. The schematic shows the STP set as '2 pumps, in/out valves'.
- **suggested fix** Add node('stp_v_out','valve','STP outlet valves (2)', tags:['STP-XV-301']) between stp_p and sht, so the two nodes together account for the qty-4 row, or amend stp_v_in's label to say it stands for all four.

### The narrative feeds the UF from the ACF/MGF outlet and the schematic feeds it from the FFP manifold; the flow picks one and records no note

- **kind** diagram_gap
- **found** flowsheet.js routes the UF line off ffp_v_out: e_ffpvo_mf (l.364) → ft_mf → mf → uf_v_in → uffp → uf. ffp_v_out's data.assumption covers only the 55/35/10 split ratio, not the choice of source. Neither mf, uf_v_in nor uffp carries a note about the conflict, although narrative.js flags comparable contradictions elsewhere with a `review` field (e.g. II.1, IV.2, III.2).
- **proposal says** narrative.js V.2 ('SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT') and VII.1 ('Water from ACF and MGF filter flows into UF') both put the UF downstream of the filters, while IV.4 ('the pumped water is split into two lines... the other line is directed to Micron filter') and the slide-3 schematic put it on a separate FFP leg. The choice matters: taking it off the FFP manifold means no carbon bed between the 1 ppm chlorine dose and the UF membranes.
- **suggested fix** Add a data.assumption on ffp_v_out (or mf) recording that slide 8/the schematic was followed over narrative VII.1, and note the consequence — the UF feed is not dechlorinated — so the contradiction surfaces on the review page rather than being silently resolved.

### Several values the proposal never states carry no data.assumption, against the file's own stated convention

- **kind** diagram_gap
- **found** A scan of NODES for chosen values without an assumption field returns: swtp, hwtp and fwtp each with head_m: 25 (the proposal gives Grundfos qty 3 and no head anywhere for these three transfer pumps, and head_m drives the reported power_kW / energy_kWh_d); poly_dose dose_mg_L: 4; swt_cl dose_mg_L: 0.5 (no narrative section sets an SWT chlorine setpoint — the 0.5–1 ppm band in IV.2 is the INT-WT loop); centrifuge capture_pct: 95 and target_TSS_mg_L: 180000. Every other duty-bearing pump's head is stated on its slide (elp/rfp/stp/ffp/sfp 8 m, uffp 25 m, ufbp 15 m).
- **proposal says** flowsheet.js's own header contract: 'Each node carries `data.source` ... and `data.assumption` where the proposal does NOT state a value and one had to be chosen ... an engineer opening this sheet must be able to tell the plant's stated design from a placeholder, at a glance, on the node itself.' These five values are placeholders presented as stated design.
- **suggested fix** Add data.assumption to swtp/hwtp/fwtp ('No head is quoted for the Grundfos transfer sets; 25 m is assumed and drives the reported pump power'), to poly_dose and swt_cl (dose not stated; only the 0–30 lph and 0–12 LPH pump ranges are), and to centrifuge (18 % cake at 95 % capture are typical decanter figures, not slide-7 values).

### The tanker take-off and the IRR-WT dosing skid are drawn on the schematic and appear nowhere on the sheet

- **kind** missing_node
- **found** The sheet has five boundaries (solids_out, reject_out, cooling_tower, irrigation, flush_out) — no tanker export. Searching all 55 nodes and all 56 device tags finds no DP or DPSP node or tag; processes.js process 9 (horticulture) lists only HWT-XV-901, HWT-P-901, HWT-XV-911, IRR-LT-901, HWT-FT-901, with no dosing pump.
- **proposal says** The schematic annotates the ACF/MGF outlet with an 'EXCESS/SURPLUS SUPPLY WATER TO TANKER' 25 mm take-off, and shows a 'DP/DPSP dosing skid' beside IRR-WT; DPSP is one of the orange equipment labels on slide 3, alongside HWTP and IRR-WT.
- **suggested fix** Add an outlet node tanker_out (params { discharge_type: 'water' }, area 'ACF') fed from at_601 with a third split ratio, and add a dosing node dpsp on the IRR-WT line tagged with whatever DPSP tag the equipment list gains. If the tanker take-off is intentionally excluded as an occasional manual draw-off, say so in an at_601 data.note — right now its absence is silent, and it is the only labelled boundary on the schematic that the flow does not reach.

### The pH analyser sits after the MGF, not on the ACF outlet, and nothing records whether the two filters are in series or parallel

- **kind** wrong_route
- **found** The sheet wires ft_acf → acf → mgf → at_601, i.e. the two vessels in series with the analyser downstream of both, and the whole 317 m³/d passes each (ACF at 13.2 m³/hr, MGF at 13.0 m³/hr — both inside their 25 m³/hr ratings, so nothing warns). at_601 also carries the 60/40 split to the softener and irrigation, so its position determines where the split is taken. There is no field on either node recording the arrangement.
- **proposal says** The schematic places ACF and MGF 'side by side on FRONTAL PIPING 80mm CPVC', each with its own five-valve frontal set (ACF-XV-601 qty 5, MGF-XV-601 qty 5) and its own BACKWASH TO EQT, and states 'A pH analyser box sits on the ACF outlet line' — which the series wiring contradicts, since on this sheet the ACF outlet is the MGF inlet. Each vessel is separately rated 25 m³/hr, which reads as a duty pair rather than a train.
- **suggested fix** Settle the arrangement with the client and record it: if series, move at_601 between acf and mgf to match 'on the ACF outlet line' and carry the split downstream on mgf instead; if parallel, feed both from ft_acf with splitRatios and merge into at_601. Either way add an `arrangement: 'series' | 'parallel'` note on the acf/mgf nodes so the PFD does not have to infer it from edge order.

---

## Why this list is unverified

The audit ran 10 auditors in parallel, then sent every finding to 3 adversarial
refuters. Nothing capped the findings per auditor, so 123 findings became **369
verify agents** — far more than the job needed. It was stopped at 99 agents to
free the machine for the client demo.

Of the 89 verdicts that did return, **61 refuted and 28 upheld** — a 69 %
refutation rate, which says the auditors were far too permissive and most of
this list will not survive scrutiny. Re-running the verification should cap each
auditor at its 3 strongest findings (10 x 3 x 3 = 90 agents, a quarter of the cost).

