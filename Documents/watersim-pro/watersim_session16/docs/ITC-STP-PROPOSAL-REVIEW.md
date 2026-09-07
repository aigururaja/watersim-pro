# ITC Sewage Treatment Plant — proposal review

> How the application maps onto *Project Proposal v2* (Client **ITC** · Contractor
> **Safekrite** · Sub-contractor **Infercon Automation**), and every place that
> document disagrees with itself.
>
> Everything below is produced by the app, not written by hand. The tables are
> generated from `backend/src/plants/itcStp/`, and the review section is the
> output of `plant.review()` — the same list served at `GET /api/v1/plant/review`
> and rendered on **/plant → Review**. If a figure here looks wrong, the fix is a
> code change, not an edit to this file.

---

## 1. What was transcribed, and where it lives

| Proposal | Module | Serves |
|---|---|---|
| Slides 4–15 — the eleven process tables and the Pump & Valve list | `plants/itcStp/processes.js` | Device list, per-row printed I/O |
| Slides 16–20 — costing, architectures, overall options | `plants/itcStp/proposal.js` | Every quoted figure, verbatim |
| Slides 22–24 — the control narrative | `plants/itcStp/narrative.js` | Ten sequences, timings, setpoints |
| Slide 3 — the schematic | `plants/itcStp/flowsheet.js` | `canvas_data` for the canvas and solver |
| *derived* | `plants/itcStp/ioSchedule.js` | Tag list, four-way I/O reconciliation |
| *derived* | `plants/itcStp/costing.js` | Every total recomputed from its line items |

Two rules held throughout:

* **Nothing was corrected in place.** Where the proposal prints a number, that
  number is stored exactly as printed and a *separate* derivation is compared
  against it. The app never silently substitutes what it thinks is right.
* **Every assumption is marked.** Flowsheet nodes carry `data.source` (the slide
  a value came from) and `data.assumption` (where the proposal states nothing and
  a value had to be chosen). Both appear on the node in the canvas.

---

## 2. The plant

| | |
|---|---|
| Design flow | **675 KLD** — 100 kitchen + 475 sewage + 100 laundry |
| Process areas | 11 |
| Treatment | Grease trap → equalisation → 2 × SBR → filtration (ACF/MGF/micron) → softening + ultrafiltration |
| Product waters | Cooling tower · irrigation · flushing |
| Waste exports | Dewatered cake · softener regeneration reject |
| Wired signals | **339** — 214 DI, 108 DO, 17 AI |

The plant has three influents and five boundaries. That exposed a real
limitation in the solver, now fixed: `summary.influent` and `summary.effluent`
previously read only the **first** inlet and the **first** outlet, so this plant
would have reported one seventh of its influent and graded whichever outlet
happened to be authored first. Influent is now the mix of every inlet, and
effluent the mix of every **graded** outlet — a new `discharge_type` on the
outlet model keeps a 180,000 mg/L cake out of the discharge quality figure.

---

## 3. I/O — counted four ways

The proposal states its I/O count four times and the four disagree:

| Count | DI | DO | AI | Where |
|---|---:|---:|---:|---|
| What the listed devices need | **214** | **108** | **17** | derived from the equipment list |
| Process tables | 210 | 116 | 17 | slides 4–14 |
| Pump & Valve list | 212 | 116 | 18 | slide 15 |
| Panel capacity quoted | 240 | 160 | 24 | slides 17–19 |

The good news: the quoted four-node panel set fits, with 26 DI, 52 DO and 7 AI
spare against the derived count. The bad news is that a panel order placed
against the wrong one of these columns is wrong by tens of points, which is why
**/plant → I/O schedule** shows all four side by side rather than picking one.

Derived counts use one signal per physical point:

| Device | DI | DO |
|---|---:|---:|
| On/off valve (butterfly, ball, air) | 2 — open + close limit switch | 1 — open/close command |
| Pump, dosing pump, agitator, blower | 2 — run + trip | 1 — start/stop |
| Decanter VFD | 2 — run + trip | 2 — start/stop + fwd/rev |
| Level switch | 1 — high level | — |
| Level transmitter / flow meter / pH | — | — (1 AI each) |

Device quantities, listed against priced:

| Family | On the equipment list | Priced (slide 16) |
|---|---:|---:|
| Valves | **73** | 58 |
| Pumps, blowers, agitators, decanters | **33** | 26 |
| Tank level instruments | 11 | **12** |
| Flow meters & pH analyser | **8** | 7 |

---

## 4. The control narrative, multiplied out

The proposal states the SBR phase durations and the feed pump duty but never
multiplies them together. Doing so is the difference between a plant that meets
its duty and one that backs up daily:

```
cycle    = 1.5 fill + 2.0 aerate + 1.0 settle + 0.75 decant = 5.25 h
cycles   = 24 / 5.25                                        = 4.57 per day
per fill = 43 m³/hr × 1.5 h                                 = 64.5 m³
capacity = 64.5 × 4.57 × 2 reactors                         = 589.7 m³/d
design                                                       = 675   m³/d
                                                     SHORT BY  85.3  m³/d
```

Either the fill extends to **1.72 h** or the feed pump rises to **49.2 m³/hr**.
Otherwise the equalisation tank accumulates 85 m³ every day.

The ultrafiltration cycle does reconcile: 20 min production + 1 min backwash =
68.6 cycles/day, 228.6 m³/d produced against 17.1 m³/d of backwash returning to
EQT — **92.5 % recovery**.

---

## 5. Commercial — every total rebuilt from its line items

The four monitoring-and-control totals reconcile **exactly**:

| Option | Valve strategy | From line items | Quoted |
|---|---|---:|---:|
| 1 — Siemens SCADA & Controller | New electrical actuator | ₹56,00,880 | ₹56,00,880 ✓ |
| 1 — Siemens SCADA & Controller | Retrofit electrical actuator | ₹42,30,880 | ₹42,30,880 ✓ |
| 2 — IOT nodes & ICMES | New electrical actuator | ₹52,70,880 | ₹52,70,880 ✓ |
| 2 — IOT nodes & ICMES | Retrofit electrical actuator | ₹39,00,880 | ₹39,00,880 ✓ |

The two monitoring-only totals do not:

| Option | From line items | Quoted | Difference |
|---|---:|---:|---:|
| 1 — monitoring only | ₹25,25,000 | ₹25,55,000 | ₹30,000 unattributed |
| 2 — monitoring only | ₹23,75,000 | ₹27,25,000 | ₹3,50,000 unattributed |

And the **pneumatic actuator option is priced in full on slide 16 (₹21,85,880)
and then absent from the decision table on slide 20**. The app prices it anyway:

| Option | Pneumatic total |
|---|---:|
| 1 — Siemens SCADA & Controller | ₹52,40,880 |
| 2 — IOT nodes & ICMES | ₹49,10,880 |

Both are cheaper than the new-electrical column that *is* offered.

---

## 6. Every finding

27 findings — 11 high severity, 16 medium. Live at **/plant → Review** and at
`GET /api/v1/plant/review`.

| # | Severity | Area | Finding | This app derives | The proposal states | Source |
|---|---|---|---|---|---|---|
| 1 | high | Commercial | Valves — 73 on the equipment list, 58 priced | 73 | 58 | Slides 4–15 against slide 16 |
| 2 | high | Commercial | Pumps, blowers, agitators & decanters — 33 on the equipment list, 26 priced | 33 | 26 | Slides 4–15 against slide 16 |
| 3 | high | Commercial | Flow meters & pH analyser — 8 on the equipment list, 7 priced | 8 | 7 | Slides 4–15 against slide 16 |
| 4 | high | Commercial | Option 1 · Monitoring only — quoted total does not equal the sum of its parts | ₹25,25,000 | ₹25,55,000 | Slide 20 against slides 16–19 |
| 5 | high | Commercial | Option 2 · Monitoring only — quoted total does not equal the sum of its parts | ₹23,75,000 | ₹27,25,000 | Slide 20 against slides 16–19 |
| 6 | high | FFP | Filter Feed AI count differs between the process table and the Pump & Valve list | 3 | 3 on slide 8, 4 on slide 15 | Slides 8 and 15 |
| 7 | high | FFP | Chlorine is dosed to a band that nothing measures | The narrative closes the INT-WT dosing loop on residual chlorine at 0.5–1 ppm, but the plant's only analyser is a pH meter | Slide 23 step IV.2 | Slides 8, 9 and 23 |
| 8 | high | R | The stated SBR cycle cannot pass the design flow | 589.7 m³/d | 675 m³/d design influent | Slides 4, 5 and 22 |
| 9 | high | RFP | Reactor Feed DI count does not match the listed devices | 12 | 8 | Slide 5 |
| 10 | high | Scope | No treated-water quality requirement appears anywhere | A reuse TEMPLATE is applied so the plant can be graded at all | No limit, target or standard is named on any slide | Slides 1–25 |
| 11 | high | SHT | Sludge Process DI count differs between the process table and the Pump & Valve list | 8 | 8 on slide 7, 10 on slide 15 | Slides 7 and 15 |
| 12 | medium | ACF | ACF/MGF DO count does not match the listed devices | 13 | 14 | Slide 9 |
| 13 | medium | Commercial | Tank level instruments — 11 listed, 12 priced | 11 | 12 | Slides 4–15 against slide 16 |
| 14 | medium | Commercial | 2 priced combinations never reach the overall option table | ₹52,40,880 and ₹49,10,880 | Absent from slide 20 | Slide 16 option 3 against slide 20 |
| 15 | medium | FFP | Filter Feed DO count does not match the listed devices | 10 | 13 | Slide 8 |
| 16 | medium | FFP | IV.2 — chlorine dosing loop has no measurement to close on | No residual-chlorine analyser is scheduled | "dosing happens between 0.5 ppm and 1 ppm" | Slide 23 |
| 17 | medium | FWTP | Flushing DO count does not match the listed devices | 7 | 8 | Slide 13 |
| 18 | medium | FWTP | IX.1 — no pressure transmitter scheduled for this header | — | "Depending on the pressure the FWTP is automatically controlled" | Slide 24 |
| 19 | medium | HWTP | VIII.1 — no pressure transmitter scheduled for this header | — | "Depending on the pressure the HWTP is automatically controlled" | Slide 24 |
| 20 | medium | Process | The plant has no phosphorus removal step | P reaches the reuse lines at close to influent concentration | No chemical P removal, EBPR zone or dosing appears anywhere | Slides 4–14 |
| 21 | medium | R | Reactor DO count does not match the listed devices | 21 | 22 | Slide 6 |
| 22 | medium | R | II.1 — the start permissive names the wrong tank | The reactor is fed from EQT, not INT-WT | "Depend upon the level of INT-WT Reactor will ON" | Slide 22 |
| 23 | medium | R | II.12 — "Decay" reads as "decant" | The decanter lowers, draws for 45 min, then reverses to park | "Then Decay will be ON for 45 mins" | Slide 22 |
| 24 | medium | SFP | Softener Feed DO count does not match the listed devices | 12 | 13 | Slide 10 |
| 25 | medium | SHT | III.2 — MLSS is a concentration, not a percentage | Read as a settled-sludge volume (SV30) of 30–50 % it is workable; read literally it is not measurable with the listed instruments | "MLSS should be 30% to 50%" | Slide 22 |
| 26 | medium | SWTP | Soft Water DO count does not match the listed devices | 7 | 8 | Slide 14 |
| 27 | medium | SWTP | X.1 — no pressure transmitter scheduled for this header | — | "Depending on the pressure the SWTP is automatically controlled" | Slide 24 |

---

## 7. What to ask the client

The findings above sort into five questions worth putting to ITC and Safekrite
before anything is ordered:

1. **Which I/O count is the contract?** 210, 212 or 214 DI. The panels fit either
   way, but the price and the terminal schedule do not.
2. **Which valve quantity is the contract?** 73 valves appear across the process
   tables; 58 are priced for both monitoring and actuation. That is 15 valves of
   feedback sensors, actuators, cable and installation.
3. **What is the treated-water specification?** Nothing in the document states
   one, and three reuse lines feed a cooling tower, irrigation and flushing —
   each with different requirements.
4. **Is the SBR cycle final?** As written it passes 590 of 675 m³/d.
5. **Should the pneumatic option be on the table?** It is fully costed, cheaper
   than the electrical option that is offered, and never presented.

---

## 8. Reproducing any of this

```bash
npm run db:migrate && npm run db:seed   # creates the ITC org, flowsheet and alarm rules
npm run dev                             # then open /plant

# Or read it straight from the API:
GET /api/v1/plant                 # identity, process areas, headline counts
GET /api/v1/plant/io-schedule     # 339 signals, filterable, with all four totals
GET /api/v1/plant/io-schedule.csv # the same list for a panel builder
GET /api/v1/plant/narrative       # the ten sequences with cycle arithmetic
GET /api/v1/plant/costing         # every total rebuilt from its line items
GET /api/v1/plant/review          # the 27 findings above
GET /api/v1/plant/flowsheet       # the schematic as canvas_data
GET /api/v1/plant/flow-diagram    # the PFD layout model + stream table + mermaid
GET /api/v1/plant/flow-diagram.svg # the PFD as one standalone sheet

# Regenerate the flow documents after any change to the flowsheet:
npm run plant:flow                # writes docs/ITC-STP-FLOW.md + docs/itc-stp-pfd.svg
```

Tests: `backend/src/__tests__/itcPlant.test.js` (43) pins the transcription and
every finding by id; `plantApi.test.js` (15) pins the API contract;
`itcDiagram.test.js` (34) pins the flow diagram's fidelity to the model, its
geometry and its output; `frontend/src/test/plantPage.test.jsx` (26) pins the UI.
