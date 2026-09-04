/**
 * WaterSim Pro — in-app explanation content.
 *
 * Single source of truth for every ⓘ affordance in the app: the node info modal
 * (canvas + params panel header), the per-parameter InfoTip rows, and the
 * Simulation Output metric rows.
 *
 * Accuracy contract
 * ─────────────────
 * Every `how` sentence and every `effect` sentence describes what the backend
 * models in backend/src/simulation/models/*.js ACTUALLY compute — the numbers,
 * coefficients and formulas below are read straight from those files (screen.js
 * REMOVAL_BY_TYPE, grit.js chamber types, primaryClarifier.js SOR curve,
 * aerationBasin.js Monod/SRT/EBPR logic, secondaryClarifier.js solids flux,
 * granularFilter.js Kozeny-Carman, uvDisinfection.js fluence, roMembrane.js
 * recovery, anaerobicDigester.js ADM1-lite, chemicalDosing.js coefficients,
 * pump.js and valve.js flow logic). Where a node reuses another model, or is a
 * solver passthrough, `how` says so plainly rather than inventing physics.
 *
 * Voice: matches backend/src/reports/plainLanguage.js (OP_EXPLANATIONS +
 * GLOSSARY) — everyday analogy first, engineering detail second, no filler.
 */

/**
 * OP_INFO[opType] = { title, tagline, what, how, watchFor }
 *   what     — everyday language + a concrete analogy
 *   how      — the real engineering this simulator computes
 *   watchFor — the operational trap
 * Covers every type in UnitOpPalette's PALETTE, plus `thickener`, which has
 * PARAM_DEFS entries and a canvas colour but is not on the palette.
 */
export const OP_INFO = {
  // ── Flow boundaries ────────────────────────────────────────────────────────
  inlet: {
    title: 'Inlet (Source)',
    tagline: 'The front door — where the raw wastewater arrives and is measured.',
    what: "This is where the town's dirty water enters the plant. Think of it as the delivery bay: nothing is treated here, you simply declare what turns up — how much water per day and how dirty it is. Every tank downstream is sized against these numbers, so the inlet is the most consequential node on the canvas.",
    how: 'The inlet performs no transformation: it emits the parameters you type as a Stream (Q in m³/d, plus BOD, COD, TSS, TN, NH₄, TP in mg/L, pH, and temperature in °C) and reports Q_in. The built-in defaults are typical municipal sewage — 10,000 m³/d at 200 mg/L BOD, 400 mg/L COD, 250 mg/L TSS, 45 mg/L TN, 35 mg/L NH₄, 8 mg/L TP, pH 7.2, 20 °C.',
    watchFor: 'Every auto-sized basin, clarifier area and cost figure scales from this flow, so an inlet Q that is ten times too big silently inflates the whole design. Temperature matters as much as strength: the biology is corrected with θ = 1.07 per °C, so a winter 10 °C run gives very different ammonia results from the same plant at 20 °C.',
    animation: 'Nothing inside the inlet flag moves — there is no equipment here to animate. What the inlet does drive is the whole sheet: its flow sets the Qref that every edge pulse on the canvas is timed against, so raising Q here speeds the lines up everywhere downstream.',
  },
  outlet: {
    title: 'Outlet (Discharge)',
    tagline: 'The exit referee — grades the finished water against the permit.',
    what: 'The final pipe to the river. Nothing is treated here; the outlet simply checks the water you produced against the legal discharge permit and reports pass or fail, naming every limit that was broken. It is the scoreboard for the whole flowsheet.',
    how: 'The stream passes through unchanged and is compared item by item against the permit — by default BOD ≤ 30, TSS ≤ 30, TN ≤ 10, TP ≤ 1 and NH₄ ≤ 5 mg/L with pH between 6.0 and 9.0, or your organisation permit template when one is set. Each breach is recorded in permit_violations with its value, limit and unit, and `compliant` is true only when that list is empty.',
    watchFor: 'A flowsheet with no outlet produces no compliance verdict at all — the run looks fine because nothing was ever graded. Compare Q_out with the inlet Q too: a large shortfall means water is leaving as unrouted sludge, or being blocked by a closed valve or stopped pump upstream.',
    animation: 'The compliance stamp lands ONCE, on the tick where the effluent becomes compliant, and is then completely still. A permit breach draws a red ring and up to three violation chips, and those render whenever results exist — live or not, and in print. A violation must survive a screenshot; only the 1.0 s blink is live-only.',
  },

  // ── Flow control ───────────────────────────────────────────────────────────
  pump: {
    title: 'Pump',
    tagline: 'Moves water on; switch it off and the train downstream goes dry.',
    what: 'A transfer pump on the pipe. Running it passes the water along; switching it off stops the flow completely, so every unit after it sees an empty pipe — exactly what happens on a real works when you stop the feed pump to a treatment train. The speed dial behaves like a variable-speed drive.',
    how: 'Q_delivered is 0 when OFF; min(Q_in, capacity_m3_d × speed_pct/100) when a capacity is set; otherwise Q_in × speed_pct/100. Whatever it cannot pass is reported as blocked_Q_m3_d with a warning, because the steady-state solver has no upstream storage. Power is hydraulic — 9.81 × Q[m³/s] × head_m ÷ 0.65 wire-to-water efficiency — and energy_kWh_d is that power × 24.',
    watchFor: 'A pump left OFF is the single most common reason an entire downstream train reports zeros. Setting speed_pct below 100 with no capacity throttles the flow itself: the shortfall does not queue up upstream, it simply vanishes as blocked_Q_m3_d and quietly breaks the plant mass balance.',
    animation: 'The impeller turns at the speed you set: period = 1.5 − 1.22 × (speed_pct ÷ 100) seconds, clamped to 0.28–1.6 s. This is one of only two places a setpoint is allowed to drive a rate, because the VFD setpoint IS the rotation rate being drawn. The rim arc shows power_kW and never moves, and a blocked discharge throbs amber. Switched off, the impeller parks at 12° behind a de-energised hatch, so a still frame still reads as stopped.',
  },
  valve: {
    title: 'Valve',
    tagline: 'A tap on the pipe — open, throttled, or shut.',
    what: 'An isolation or throttling valve. Fully open lets everything through, part-open passes that fraction, and closed stops the flow dead. Nothing about the water changes as it goes past — only how much of it continues.',
    how: 'Linear characteristic: Q_out = 0 when CLOSED, otherwise Q_in × opening_pct/100. The status metric reads OPEN, THROTTLED or CLOSED, and whatever does not pass appears as blocked_Q_m3_d with a warning. Composition (BOD, TSS, nutrients, pH, temperature) is carried through untouched.',
    watchFor: 'Throttling in a steady-state model destroys the blocked flow rather than backing it up, so a valve at 50 % simply halves everything downstream. Put one part-open on a RAS line and you starve the aeration basin of returned biomass without any obvious warning in the effluent numbers.',
    animation: 'The disc swings to 90 − 0.9 × opening_pct degrees and the throat fill width is the opening percentage — both readable with motion switched off, in print and at half scale. A throttled valve chatters. The disc travel is a 220 ms transition rather than a loop, so it runs outside live view too: a teleporting valve disc is worse than a moving one.',
  },

  // ── Preliminary ────────────────────────────────────────────────────────────
  screening: {
    title: 'Screening (Bar Screen)',
    tagline: 'The giant sieve that catches rags, wipes and plastic.',
    what: 'Bars or a mesh across the incoming channel rake out the coarse rubbish — rags, wipes, sticks, plastic — before it wraps itself around pump impellers. It is a strainer, not a treatment step: the dissolved pollution flows straight through.',
    how: 'Removal is a fixed fraction set by screen type — coarse takes 5 % TSS / 3 % BOD / 3 % COD, fine 15 / 10 / 8 %, micro 30 / 20 / 15 %. The captured mass leaves on a small screenings stream at 200,000 mg/L (about 20 % dry solids), and the forward concentrations are flow-corrected so removed mass equals screenings mass exactly. screenings_kg_d = Q × TSS × removal ÷ 1000.',
    watchFor: 'Head loss is reported for the hydraulic profile but is not applied — it never throttles flow in this model. Reaching for the micro setting to improve the TSS numbers is not realistic on raw sewage either: a microscreen blinds within minutes on rag-laden influent.',
    animation: 'Rake speed comes from screenings_kg_d, NOT from headloss_m. headloss_m is a verbatim echo of the value you typed, so a rake driven by it would be permanently inert. The skip fill and the blinding shading are static encoders derived from your setpoints, and the rake parks at the bottom of the rack when there is nothing to lift.',
  },
  grit_removal: {
    title: 'Grit Removal',
    tagline: 'A sand trap that drops out grit before it sandpapers the machinery.',
    what: 'The water is slowed or swirled just enough that dense mineral grains — sand, gravel, eggshell, coffee grounds — sink out, while the lighter organic matter stays suspended and carries on to be treated. It exists to protect pumps, pipes and digesters from abrasion.',
    how: 'Removal is a fixed fraction per chamber type: horizontal 10 % TSS, vortex 12 %, aerated 15 %, each with only 2–3 % BOD/COD removal. The chamber is sized from the retention time you set — chamber_volume_m3 = (Q ÷ 1440) × HRT_min — and grit_removed_kg_d = Q × TSS × removal ÷ 1000. Flow is conserved: the grit leaves as a mass, not as a stream.',
    watchFor: 'HRT_min only sizes the chamber here — it does not change how much grit is caught, so a longer retention time buys you a bigger tank and identical removal. Real chambers run 2–5 minutes at peak flow; anything under 2 minutes is a design red flag even though the model still reports full removal.',
    animation: 'The rake turns from the computed solids flow and the surface ripple from throughput. Neither HRT_min nor the chamber type drives any rate: those are setpoints you typed, not numbers the model computed. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },

  // ── Primary ────────────────────────────────────────────────────────────────
  primary_clarifier: {
    title: 'Primary Clarifier',
    tagline: 'A big calm tank where gravity pulls the heavy solids down.',
    what: 'A wide, quiet tank where the water slows almost to a standstill, so anything heavier than water drifts to the floor and is scraped off as primary sludge. Taking that load out here means the expensive biological stage behind it has far less work to do.',
    how: 'A surface-overflow-rate model: area_m2 = Q ÷ SOR, volume = area × depth, HRT_h = volume ÷ Q × 24. TSS removal follows the fitted curve η = 65/(40 + SOR) + 0.25, clamped to 30–70 % — about 65 % at SOR 30, 60 % at 40 and 50 % at 60. BOD removal is 55 % of the TSS removal and COD 90 % of that, with 2 % of TN and 5 % of TP leaving with the particulates. Sludge flow is the removed solids divided by the underflow strength: sludge_Q = TSS_removed ÷ (sludge_TSS/1000).',
    watchFor: 'Pushing SOR much above 50 m³/m²/d shrinks the tank and the removal together — cheap on paper, until the aeration basin has to absorb the load you did not settle. A low sludge_TSS is the other trap: sludge_Q is subtracted from the forward flow, so a watery underflow quietly steals water from the effluent.',
    animation: 'Rake speed comes from sludge_Q_m3_d, NOT from SOR_m3_m2_d — SOR is a verbatim echo of your own setpoint, so a rake driven by it would never move however you tuned it. The blanket band is the sludge share of the flow split, which is computed. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },

  // ── Secondary (biological) ─────────────────────────────────────────────────
  activated_sludge: {
    title: 'Activated Sludge (Aeration Basin)',
    tagline: 'The microbe zoo — billions of bacteria eat the dissolved pollution.',
    what: 'A tank of water thick with hungry bacteria, kept supplied with air by blowers. The bugs eat the dissolved organic waste, and if they are given long enough to breed they also convert toxic ammonia into nitrate. A surplus of bugs is wasted off every day as WAS so the population stays balanced.',
    how: 'Monod kinetics on a completely-mixed reactor, temperature-corrected with θ = 1.07. Effluent BOD = Ks(1 + kd·SRT) / (SRT(Y·µ − kd) − 1). Nitrification only proceeds once SRT exceeds 1.5 × the minimum aerobic SRT (1/µ_NH4); below that, ammonia breaks through in proportion. Biomass P_x = Q·ΔBOD·Y/(1 + kd·SRT) sets WAS_m3_d = P_x·1000/MLSS and, when volume_m3 is 0, sizes the basin as P_x·SRT/MLVSS with MLVSS = 0.8 × MLSS. Oxygen demand = 1.5·ΔBOD − 1.42·biomass + 4.33·NH₄ nitrified. Turning on denitrification adds a pre-anoxic zone; ebpr_config switches to a simple selector, or the full UCT or JHB layout.',
    watchFor: 'SRT is the master dial: below roughly 5 days at 20 °C — and considerably longer in winter — the nitrifiers wash out faster than they grow and ammonia breaks straight through to the effluent. Raising MLSS to shrink the basin just moves the problem: the solids load lands on the secondary clarifier, which is where a real plant fails first.',
    animation: 'Bubble columns come from O2_demand_kg_d ÷ volume_m3 — a plant-derived number, so raising the influent BOD makes the basin bubble harder without you touching a single parameter on the basin itself. Cyan bubbles mean the model reports nitrification. Mixed-liquor density shows your MLSS setpoint, not a simulated solids concentration. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  secondary_clarifier: {
    title: 'Secondary Clarifier',
    tagline: 'Settles the microbes back out and returns them to work as RAS.',
    what: 'The final settling tank. Microbe soup from the aeration basin flows in, the bugs clump together and sink, clear water spills over the weir, and the settled blanket is pumped back to the aeration tank to keep the workforce staffed. Without this return, the microbes would all wash away within a day.',
    how: 'A simplified solids-flux (state point) model. area_m2 = Q ÷ SOR, and RAS_Q = Q_in × R/(1 + R) so that at convergence the recycle ratio against plant influent equals the RAS_ratio you set. Effluent TSS is the target you enter, capped at the incoming MLSS; every remaining solid is forced into the RAS by mass balance, so RAS_TSS = (solids in − solids out)·1000/RAS_Q. Solids loading SLR = solids_in ÷ area, and warnings fire above 6 kg/m²/d, above SOR 24, or above 12,000 mg/L RAS TSS.',
    watchFor: 'RAS_TSS is a mass-balance result, not a setting — raising the RAS ratio returns more sludge but thins it, and the model warns when the thickening falls below your target. SOR above about 24 m³/m²/d or SLR above 6 kg/m²/d means the blanket rises and solids wash over the weir in real life, which a steady-state model will not show you as failing effluent.',
    animation: 'Blanket height indicates solids loading (MLSS × surface overflow rate). It is a design-loading indicator, not a simulated blanket depth, and it does not respond to flow. Rake speed comes from RAS_Q_m3_d, which is computed, not from SOR. Edit SOR and the rake will not change speed — that is correct. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  membrane_bioreactor: {
    title: 'Membrane Bioreactor (MBR)',
    tagline: 'An aeration basin with membranes instead of a settling tank.',
    what: 'The same microbe tank as activated sludge, except the clean water is drawn out through fine membranes rather than being left to settle. Because nothing depends on the sludge settling well, the tank can be run far thicker and no secondary clarifier is needed.',
    how: 'This node runs the same aeration-basin model as activated sludge — Monod kinetics, temperature correction, SRT-driven nitrification, biomass yield and oxygen demand — with the same SRT / MLSS / DO / denitrification / EBPR controls. The membrane separation itself is not modelled: there is no flux, transmembrane-pressure or fouling calculation, and no separate permeate stage, so the node reports effluent TSS at the basin MLSS.',
    watchFor: 'Because the membrane is not simulated, the TSS leaving this node is mixed liquor, not the near-zero solids a real MBR produces — read it that way, and do not hang a secondary clarifier behind it expecting the conventional layout. Real MBRs run 8,000–12,000 mg/L MLSS, and both aeration demand and fouling risk climb with it.',
    animation: 'Bubble columns come from O2_demand_kg_d ÷ volume_m3 — a plant-derived number, so raising the influent BOD makes the basin bubble harder without you touching a single parameter on the basin itself. Cyan bubbles mean the model reports nitrification. Mixed-liquor density shows your MLSS setpoint, not a simulated solids concentration. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  uct_reactor: {
    title: 'UCT Reactor (EBPR)',
    tagline: 'Anaerobic → anoxic → aerobic, arranged to keep nitrate off the P-bugs.',
    what: 'A three-zone biological tank that strips phosphorus as well as nitrogen. Phosphorus-hoarding bacteria must first go hungry in an air-free, nitrate-free zone before they will over-eat phosphorus later in the aerated zone. The University of Cape Town layout protects that first zone by sending the returned sludge into the anoxic zone instead, and recycling nitrate-free liquor back to the anaerobic zone.',
    how: 'RAS enters the anoxic zone, where its nitrate is denitrified against influent BOD (at most BOD ÷ 3.5 mg NO₃-N, floored by the kinetic limit). Residual nitrate reaching the anaerobic zone suppresses VFA uptake by a factor 1 − (NO₃ − 1)/20, down to 0.2. VFA available = COD × VFA_COD_fraction × that suppression, and phosphorus released is half the VFA. Aerobic P uptake is capped at X_PAO × ebpr_uptake_rate × (aerobic volume ÷ Q), where X_PAO = 0.8 × MLSS × PAO_fraction. Zone volumes are the total basin split by anaerobic_fraction, uct_anoxic_fraction and the aerobic remainder.',
    watchFor: 'Nitrate leaking into the anaerobic zone is what kills EBPR: above 2 mg/L the model raises a suppression warning and phosphorus removal collapses. UCT needs a long SRT (8 days minimum on this node) to nitrify, but a very long SRT starves the PAOs of readily-biodegradable COD — watch TP_effluent whenever you raise SRT.',
    animation: 'The anaerobic and anoxic zones deliberately carry NO bubbles — only a slow mixer sweep — while the aerobic zone bubbles from O2_demand_kg_d ÷ volume_m3. Mixed-liquor density shows your MLSS setpoint, not a simulated solids concentration. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  jhb_reactor: {
    title: 'JHB Reactor (EBPR)',
    tagline: 'A pre-anoxic zone strips nitrate from the RAS before the P-bugs meet it.',
    what: 'The Johannesburg layout solves the same problem as UCT with a different trick: instead of re-routing the recycle, it puts a small anoxic tank on the return sludge line to burn off its nitrate before that sludge reaches the phosphorus bacteria. The train runs pre-anoxic → anaerobic → main anoxic → aerobic.',
    how: 'Returned sludge is denitrified in a pre-anoxic zone sized by jhb_preanoxic_fraction, with the BOD available approximated as influent BOD × fraction × 5. Residual nitrate then suppresses VFA uptake by 1 − (NO₃ − 1)/15, down to 0.3, and JHB earns a 1.15 VFA bonus over UCT because its anaerobic zone is better protected. The main anoxic zone denitrifies the mixed-liquor recycle, and aerobic phosphorus uptake uses the same X_PAO × ebpr_uptake_rate × (aerobic volume ÷ Q) cap.',
    watchFor: 'The pre-anoxic zone is small — typically 5–10 % of the volume — but it is doing all the RAS denitrification; undersize it and nitrate reaches the anaerobic zone, tripping the suppression warning above 1.5 mg/L. All four zone fractions come out of one total volume, so pushing them up leaves too little aerated volume and ammonia rises.',
    animation: 'The pre-anoxic, anaerobic and main anoxic zones deliberately carry NO bubbles — only a slow mixer sweep — while the aerobic zone bubbles from O2_demand_kg_d ÷ volume_m3. Mixed-liquor density shows your MLSS setpoint, not a simulated solids concentration. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  anaerobic_digester: {
    title: 'Anaerobic Digester (ADM1-lite)',
    tagline: 'A sealed, heated tank that rots sludge down into burnable biogas.',
    what: 'A warm, sealed tank with no air in it. A relay team of bacteria breaks the sludge down in stages, and the end product is methane — gas that can run a generator and pay part of the plant energy bill. The sludge shrinks, stops smelling, and becomes safer to spread or landfill.',
    how: 'A steady-state simplification of IWA ADM1 keeping the four-stage pathway. Destruction = min(1 − e^(−k_eff·HRT), COD_removal_pct/100), where k_eff = k_hyd × an Arrhenius factor (θ = 1.08 around a 35 °C mesophilic reference, a 1.7× step with θ = 1.06 around 55 °C thermophilic, and 0.15 below 15 °C). 80 % of the feed COD is treated as particulate; 85 % of the hydrolysed COD becomes VFAs and 70 % of that becomes methane at 0.35 m³ CH₄ per kg COD destroyed. Biogas energy assumes 10 kWh/m³ CH₄ at 35 % generator efficiency. Organic nitrogen is mineralised to ammonia in proportion to destruction.',
    watchFor: 'Below 10 days HRT the methanogens wash out and the model warns; below 25 °C methanogenesis is severely inhibited. Feed this node thickened sludge, not clarified water — under 10,000 mg/L COD it warns that the feed looks like a liquid stream. With dewatering on, the ammonia-rich centrate is a genuine return load your mainstream biology has to absorb.',
    animation: 'Gas production is a rate, not a stored volume, so the gasholder cover does not move. Production is shown by the bubbles, the take-off pulses and the readout. Bubble and mixer rates both come from biogas.volume_m3_d; an unstable digester mixes 2.5× slower and turns amber. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },

  // ── Tertiary ───────────────────────────────────────────────────────────────
  uv_disinfection: {
    title: 'UV Disinfection (CT model)',
    tagline: 'Ultraviolet light kills the surviving germs, with no chemicals added.',
    what: 'The water flows in a thin layer past ultraviolet lamps. The light scrambles the DNA of any bacteria, viruses or parasites still present so they cannot reproduce. Nothing is added and nothing is left behind — but the light has to reach the germs, so cloudy water shields them.',
    how: 'A dose (fluence) model. required_fluence = target_log_reduction × k_inact, and the delivered fluence is scaled for optical clarity by √(UVT/65), so the achieved log reduction = delivered ÷ k_inact and `compliant` is true when the deficit is under 0.05 log. Lamp count = ceil(Q_m3_h ÷ lamp_Q_rating_m3_h) and energy_kWh_d = lamps × lamp_power_kW × 24. Solids, nitrogen and phosphorus pass through untouched; only 2–4 % of BOD is lost to photo-oxidation.',
    watchFor: 'UV removes no solids at all — in a real system particles shield organisms from the light, and this dose model does not penalise that, so always polish upstream first. k_inact is organism-specific: 19 mJ/cm² for E. coli, 10 for Cryptosporidium, 82 for Giardia and about 186 for adenovirus, so a system sized on coliforms is nowhere near enough for viruses.',
    animation: 'Lamp brightness shows dose adequacy from your UV transmittance setpoint. It does not change with flow; the number of lamp sleeves does. The sleeve count is genuinely flow-driven (lamp_count = ceil(Q_m3_h ÷ lamp rating)). The breathe is a fixed 1.8 s — a powered indicator, not a rate — and when the reactor is not compliant it goes red and stops breathing entirely: a dark reactor is the correct picture for a UV not achieving dose.',
  },
  chlorination: {
    title: 'Chlorination',
    tagline: 'A measured dose of chlorine kills what is left, and keeps working in the pipe.',
    what: 'Sodium hypochlorite — essentially liquid bleach — is metered into the water. It kills the germs that survived treatment and leaves a residual that carries on working downstream. Cheap and reliable, but it reacts with anything organic that is left.',
    how: 'This node runs the chemical-dosing model with the hypochlorite coefficients: BOD drops 8 %, COD 6.4 % (0.8 × the BOD fraction) and TSS 2 %, while dose_kg_d = Q × dose_mg_L ÷ 1000. The germ kill itself is not computed as a CT calculation here — the dose you set drives the reported chemical consumption and that small oxidation credit, not a log-reduction number.',
    watchFor: 'Do not read a disinfection performance figure out of this node, because there is not one — use the UV node when you need a log-reduction result. In practice chlorine demand rises with ammonia and organics, and over-dosing forms disinfection by-products, so the dose you enter should follow the residual you are targeting.',
    animation: 'The dosing quill drips at a rate taken from dose_kg_d, which is computed from flow — not from dose_mg_L, which is a verbatim echo of your setpoint. The serpentine basin ripples with throughput. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  sand_filter: {
    title: 'Granular Filter (dual media / sand)',
    tagline: 'A deep bed of anthracite and sand strains out the last fine particles.',
    what: 'Water trickles down through coarse anthracite over fine sand. Particles far too small to settle get trapped in the pores of the bed. Once the bed clogs it has to be backwashed clean, which is why a slice of the flow comes back out dirty.',
    how: 'Area = Q_m3_h ÷ HLR. Clean-bed head loss uses Kozeny-Carman per layer with k = 180(1 − ε)²/ε³, a temperature-dependent kinematic viscosity, and grain sizes of 1.4 mm anthracite over 0.5 mm sand. Clogging adds 0.4 m of head per kg/m² of TSS deposited during the run, and backwash_needed trips once that exceeds the 2.5 m limit. Effective TSS removal is your target degraded by breakthrough: target × (1 − 0.15 × load/capacity). BOD follows the solids at 45 %, COD at 30 %, TP at 20 %; backwash takes 5 % of the flow and carries the captured mass.',
    watchFor: 'Loading much above 15 m/h shortens runs sharply — head loss is linear in velocity, so the backwash interval you set quietly becomes unachievable. On a high-TSS feed the run time fails before the effluent does, so read h_clogged_m and backwash_needed, not just the removal percentage.',
    animation: 'This is the one genuinely simulated rising level in the engine: the freeboard surface climbs as h_clogged_m grows with the influent TSS, and recedes when you clean the feed up. When backwash_needed trips, the ring turns amber and the internal pulses reverse and run upward. The bed shading is the solids load on the media.',
  },

  // ── Chemical dosing ────────────────────────────────────────────────────────
  chemical_dosing: {
    title: 'Chemical Dosing',
    tagline: 'Meters a treatment chemical into the stream.',
    what: 'A dosing pump adds a chemical to the water at a set concentration. Depending on which chemical you pick it locks phosphorus into particles, shifts the pH, or oxidises organics. This is the general-purpose version of the more specific dosing nodes.',
    how: 'Per-chemical coefficients are applied per mg/L dosed: alum removes 0.23 mg/L TP and adds 0.26 mg/L of floc TSS; ferric chloride removes 0.17 and adds 0.40; NaOH shifts pH by +0.01 and H₂SO₄ by −0.008 (or jumps straight to target_pH when you set one); hypochlorite trims BOD 8 % and TSS 2 %; polymer changes nothing in the bulk stream. Reported are dose_kg_d = Q × dose ÷ 1000, the chemical sludge produced, and TP in and out with a removal percentage.',
    watchFor: 'Coagulant dosing raises TSS on purpose — the phosphorus becomes floc that a clarifier or filter downstream still has to remove, so dosing with nothing behind it makes the effluent worse, not better. TP removal also saturates at the phosphorus actually present, so dose beyond that point only makes sludge and cost.',
    animation: 'The droplet falls at a rate taken from dose_kg_d — computed from flow × dose — and NOT from dose_mg_L, which is a verbatim echo of the number you typed and would never change. At zero dose no droplet is drawn at all and the stinger is capped grey.',
  },
  coagulant_dosing: {
    title: 'Coagulant Dosing (Alum / FeCl₃)',
    tagline: 'Metal salt that snaps phosphorus out of solution and clumps the fines.',
    what: 'Alum or ferric chloride is mixed into the water. The metal grabs dissolved phosphorus and forms a hydroxide floc that also sweeps up the tiny particles which would never settle on their own. Everything then has to be settled or filtered out further down the train.',
    how: 'The same chemical-dosing engine, restricted to the two coagulants. Alum removes 0.23 mg P per mg/L dosed and creates 0.26 mg/L of floc TSS; ferric chloride removes 0.17 mg P and creates 0.40 mg/L TSS — which is why iron makes more sludge per unit of phosphorus removed. TP removal is capped at the phosphorus actually in the stream, and the chemical solids produced are reported as sludge_kg_d.',
    watchFor: 'The TSS added here is real and must be removed downstream: place a clarifier or filter after the dose or the coagulant makes your effluent solids worse. Typical municipal doses are 20–100 mg/L, and note this model does not consume alkalinity or depress pH, which a real metal-salt dose certainly does.',
    animation: 'The droplet falls at a rate taken from dose_kg_d — computed from flow × dose — and NOT from dose_mg_L, which is a verbatim echo of the number you typed. At zero dose no droplet is drawn at all.',
  },
  polymer_dosing: {
    title: 'Polymer Dosing',
    tagline: 'A sticky long-chain polymer that glues fine flocs into heavy clumps.',
    what: 'A polymer is added so that small particles bridge together into large, strong flocs that settle or dewater far more easily. It removes nothing by itself — it makes the next physical step work properly.',
    how: 'Deliberately neutral in this model: polymer carries zero TP removal and zero TSS change, so the stream leaves exactly as it arrived. What the node does give you is the consumption figure dose_kg_d = Q × dose_mg_L ÷ 1000, which feeds the chemicals line of the cost estimate.',
    watchFor: 'Do not expect this node to move any water-quality number — if the effluent did not improve, that is the model behaving correctly, not a broken run. Its value here is chemical cost, plus the standing assumption that the clarifier or dewatering step behind it performs at its rated capture.',
    animation: 'The droplet falls at a rate taken from dose_kg_d, computed from flow × dose. Nothing else on this node moves, because the model changes nothing else in the stream — the animation is as neutral as the chemistry.',
  },
  ph_adjustment: {
    title: 'pH Adjustment',
    tagline: 'Caustic or acid to bring the water back toward neutral.',
    what: 'Adds sodium hydroxide to raise the pH or sulphuric acid to lower it. Biology and coagulation both work in a narrow pH band, and permits normally demand a discharge between 6 and 9, so this is the trim valve on the plant chemistry.',
    how: 'Two paths. Leave target_pH empty and the dose drives the shift linearly — +0.01 pH per mg/L NaOH, −0.008 pH per mg/L H₂SO₄, clamped to 0–14. Set target_pH and the effluent pH is forced to that value regardless of dose, while dose_kg_d still reports what you asked for. No alkalinity or carbonate buffering chemistry is tracked.',
    watchFor: 'The linear approximation assumes weakly buffered water; a real wastewater with high alkalinity needs far more caustic than these numbers suggest. Using target_pH makes the outlet pH check pass by construction, so treat it as a design intent, not as evidence that the dose is sufficient.',
    animation: 'The droplet falls at a rate taken from dose_kg_d, and the receiving liquid takes its hue from pH_out on a litmus ramp — pH_out is computed, so it is allowed to drive an encoder. A shift of more than 1.5 pH units turns the node amber.',
  },

  // ── Water purification ─────────────────────────────────────────────────────
  coagulation: {
    title: 'Coagulation / Flocculation',
    tagline: 'Rapid mix, then a gentle stir, so tiny particles grow big enough to settle.',
    what: 'The classic two-part step in drinking-water and tertiary treatment: dose a coagulant with violent mixing to destabilise the particles, then stir slowly so they collide and grow into visible flocs. Big flocs settle out; the colloids they came from never would.',
    how: 'This node runs the chemical-dosing model, so mixing energy, G-value and floc growth time are not simulated — what you get is the chemistry: TP removal and floc TSS production per mg/L of the coagulant you select, plus the consumption in kg/d. Set chemical type and dose exactly as for coagulant dosing.',
    watchFor: 'Because mixing is not modelled, this node cannot tell you whether a floc would actually form; in practice a rapid mix of under about 30 seconds at high G followed by 20–30 minutes of gentle flocculation is what makes the chemistry work. As with any coagulant, the solids it creates need a settling or filtration step behind them.',
    animation: 'The paddle flocculator turns from the computed dose_kg_d and the floc stipple thickens with it. Mixing energy and G-value are not simulated, so nothing here claims to show floc growth — only chemical throughput. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
  ro_membrane: {
    title: 'RO Membrane',
    tagline: 'High pressure forces water through a film almost nothing else crosses.',
    what: 'Reverse osmosis squeezes water through a membrane so fine that dissolved salts, nutrients and organics are left behind. You get a very pure permeate stream and a smaller, much saltier concentrate stream that still has to go somewhere.',
    how: 'Split by recovery: permeate Q = Q_in × recovery_pct/100, concentrate takes the rest, and the reject concentration factor is 1/(1 − recovery). Rejections are applied per species — 99 % BOD, 98 % TP, 85 % TN and NH₄, 100 % TSS — with salt_rejection reported as the TDS performance figure. Energy is estimated at 0.5 kWh per m³ of permeate, scaled by pressure_bar/15.',
    watchFor: 'Recovery is the dangerous dial: at 90 % the concentration factor is 10, which in a real plant means scaling and fouling long before this model complains. Remember the concentrate is a real stream too — leave it unrouted and that water and its whole pollutant load simply leave the flowsheet.',
    animation: 'The gauge needle swings to −120° + 240° × (pressure_bar ÷ 80) as a 500 ms transition, and the shimmer opacity follows recovery_pct — both are setpoint echoes, so both are static encoders rather than rates. The recovery split animates itself for free: the permeate and concentrate lines take their pulse rates from their own edge flows, so one vessel visibly feeds two different speeds.',
  },
  uf_membrane: {
    title: 'UF Membrane',
    tagline: 'An ultra-fine strainer that catches particles and most microorganisms.',
    what: 'Ultrafiltration pushes water through pores far smaller than a hair, holding back suspended solids, bacteria and larger organics while dissolved salts pass straight through. It is a physical barrier, so unlike settling it does not care how well the sludge flocculates.',
    how: 'In this simulator the UF node reuses the screen model, so removal is the fixed screen fractions rather than a flux or transmembrane-pressure calculation — on the default coarse setting that is only 5 % TSS, 3 % BOD and 3 % COD. The captured solids leave on a small concentrated side stream and the forward stream is flow-corrected so mass balances exactly.',
    watchFor: 'This is the roughest approximation in the palette: a real UF removes essentially all suspended solids, so do not read the default 5 % as a UF result. Treat this node as a placeholder holding the hydraulic position and cost of a UF skid, and take quality numbers from a granular filter or RO node instead.',
    animation: 'The shimmer sweeps at a fixed rate and the fibre bundle is static. Because this node reuses the screen model there is no flux, transmembrane pressure or fouling number to drive anything, and the drawing does not pretend otherwise.',
  },
  gac_adsorption: {
    title: 'GAC Adsorption',
    tagline: 'A carbon bed that soaks up dissolved organics like a sponge.',
    what: 'Water passes through granular activated carbon, whose enormous internal surface area holds on to dissolved organic molecules — taste, odour, colour, micropollutants. Eventually the carbon fills up and has to be regenerated or replaced.',
    how: 'This node also reuses the screen model, so there is no adsorption isotherm, no breakthrough curve and no empty-bed contact time in this simulator: removal is the fixed screen fraction applied to TSS, BOD and COD. The default coarse setting gives 5 % TSS and 3 % BOD/COD, and choosing a finer setting is the only way to raise it.',
    watchFor: 'Nothing here tracks carbon exhaustion, so the node happily reports the same removal for ever — a real GAC bed breaks through on the compounds you care about long before any solids number moves. Use it to hold the position and cost of a carbon stage, not to prove a treatment target.',
    animation: 'Nothing inside the carbon bed moves. This node reuses the screen model, so there is no adsorption isotherm, no breakthrough curve and no bed-exhaustion state — inventing a saturation front would be a lie shaped exactly like a measurement.',
  },

  // ── Utilities ──────────────────────────────────────────────────────────────
  blower: {
    title: 'Blower',
    tagline: 'The air compressor that feeds bubbles to the aeration tank.',
    what: 'A blower pushes air down into the diffusers on the floor of the aeration basin so the microbes can breathe. On a real works it is usually the single largest electricity consumer, often around half the site energy bill.',
    how: 'The blower is a passthrough node in the solver: the stream flows through unchanged, and no air flow, pressure or shaft power is calculated here. Aeration energy is derived instead inside the aeration basin from O2_demand_kg_d, which the cost model converts into blower kW using the kWh-per-kg-O₂ factor.',
    watchFor: 'Adding or deleting a blower node changes nothing in the results or the energy figures — on this canvas it is documentation. To change aeration energy, change what drives oxygen demand: influent BOD, the ammonia load, the SRT and the DO setpoint on the basin itself.',
    animation: 'Rotor speed is derived from the O₂ demand of the aeration basins this blower serves — the simulator has no blower model, so this indicates duty, not a measured RPM. With no aeration basin connected, the rotor does not turn.',
  },
  tank: {
    title: 'Storage Tank',
    tagline: 'A buffer that evens out surges so the plant sees a steady flow.',
    what: 'A holding or equalisation tank absorbs the morning and evening peaks so everything downstream sees a flatter, steadier flow. That is what lets a plant be sized for the average day rather than the worst hour.',
    how: 'Like the blower, the tank is a passthrough in this solver: flow and composition leave exactly as they arrived. Nothing is stored, because the steady-state solver has no time dimension in which storage would mean anything, so a volume would have no effect even if you could enter one.',
    watchFor: 'Do not reach for this node to smooth a peak — it does not buffer, in steady state or in the dynamic run. If you need to limit the flow reaching a downstream unit, use a pump capacity or a valve opening, and remember that whatever is held back is reported as blocked flow rather than stored for later.',
    animation: "This unit passes flow through unchanged. WaterSim has no tank level model — nothing inside this vessel is simulated. What you see instead is the canvas-wide \"not simulated\" language: a 45° hatch and a DASHED operating-level line, because a solid surface line is a promise that a number backs it. If you set volume_m3 the footer prints Q_in ÷ volume_m3 as turnovers per day — a number, never a level. Only this node's inlet and outlet edges move.",
  },

  // ── Not on the palette, but reachable from saved flowsheets ────────────────
  thickener: {
    title: 'Sludge Thickener',
    tagline: 'Squeezes water out of sludge so there is far less of it to handle.',
    what: 'Thin sludge from the clarifiers is concentrated — by gravity, or by floating it up with fine air bubbles — so the digester or the tanker deals with a fraction of the volume. Nothing is destroyed here; water is simply separated off and sent back to the works.',
    how: 'Area = solids_in ÷ SLR (80 kg/m²/d gravity, 120 DAF). Captured solids = solids_in × capture (95 % gravity, 98 % DAF), and the thickened flow is those solids divided by the target concentration (60,000 mg/L gravity, 45,000 DAF). Particulate BOD, COD, TN and TP follow the same capture split by mass balance, while soluble species leave at the influent concentration in both streams.',
    watchFor: 'Solids that escape capture leave in the filtrate, which normally returns to the head of the works — even a 95 % capture on a heavy sludge is a genuine recycle load. Raising the target concentration shrinks the thickened flow, but a gravity thickener realistically tops out around 6 % dry solids.',
    animation: 'The rake turns from thickened_Q_m3_d, which is computed, and the underflow band is the captured-solids fraction. The target concentration you type is a setpoint and drives nothing that moves. Vessels fill once when live view starts. This is a view transition, not a filling simulation — process basins in service are always full.',
  },
};

/**
 * PARAM_INFO — keyed "opType.paramKey" first, then a bare "paramKey" global
 * fallback. Every key in CanvasPage's PARAM_DEFS resolves through paramInfo().
 *
 * Shape: { meaning, unit, typical, effect }
 *   effect — what raising or lowering it does to the simulation results.
 */
export const PARAM_INFO = {
  // ── Influent quality (inlet) ───────────────────────────────────────────────
  Q: {
    meaning: 'Design flow of wastewater arriving at the plant — the number every downstream tank area and volume is sized from.',
    unit: 'm³/d',
    typical: '1,000–100,000 m³/d for a municipal works; the 10,000 m³/d default is roughly a town of 50,000 people.',
    effect: 'Raising Q enlarges every auto-sized tank, area and energy figure in direct proportion, and raises the loading rate (SOR, SLR, HLR) on any unit whose size you have fixed by hand.',
  },
  BOD: {
    meaning: 'Biochemical oxygen demand — the biodegradable organic strength of the water, and therefore the food supply for the bacteria.',
    unit: 'mg/L',
    typical: 'Raw municipal sewage 110–400 mg/L; 200 mg/L is the model default.',
    effect: 'More BOD grows more biomass, demands more oxygen and makes more sludge. It is also the carbon that denitrification and EBPR run on, so too little BOD caps how much nitrogen and phosphorus you can remove.',
  },
  COD: {
    meaning: 'Chemical oxygen demand — everything in the water that can be chemically oxidised, biodegradable or not.',
    unit: 'mg/L',
    typical: 'Usually 1.8–2.5 × the BOD; the default is 400 mg/L against 200 mg/L BOD.',
    effect: 'The EBPR models take their volatile fatty acids from COD (VFA = COD × VFA_COD_fraction), so raising COD directly improves phosphorus removal in the UCT and JHB nodes. It barely moves a conventional aerobic result.',
  },
  TSS: {
    meaning: 'Total suspended solids — the particles carried in the water; the visible cloudiness.',
    unit: 'mg/L',
    typical: 'Raw sewage 100–350 mg/L; 250 mg/L default.',
    effect: 'Screenings, grit and primary sludge production are all mass = Q × TSS × removal, so they scale directly with it. It also shortens granular-filter runs, because head loss builds with the solids deposited.',
  },
  TN: {
    meaning: 'Total nitrogen — every form combined: ammonia, nitrate, nitrite and organically bound nitrogen.',
    unit: 'mg/L',
    typical: '25–70 mg/L raw municipal; 45 mg/L default.',
    effect: 'Higher TN means more nitrogen to nitrify and then denitrify. If the anoxic capacity or the BOD to drive it falls short, the surplus appears as NO3_effluent and the outlet TN limit fails.',
  },
  NH4: {
    meaning: 'Ammonia nitrogen — the sharp-smelling, fish-toxic fraction of nitrogen, and the substrate the nitrifiers feed on.',
    unit: 'mg/L',
    typical: '20–50 mg/L raw municipal; 35 mg/L default, about 75 % of TN.',
    effect: 'Each kg of nitrified nitrogen costs 4.33 kg of oxygen and produces nitrate for the anoxic zone to remove. If SRT is too short to nitrify, the extra ammonia passes straight through to NH4_effluent.',
  },
  TP: {
    meaning: 'Total phosphorus — from detergents, food and urine; the nutrient that most often limits algae in fresh water.',
    unit: 'mg/L',
    typical: '4–12 mg/L raw municipal; 8 mg/L default.',
    effect: 'More phosphorus needs more coagulant (0.23 mg P per mg/L of alum) or more biological uptake capacity. Beyond what the PAOs or the dose can take, the surplus lands in TP_effluent against a typical 1 mg/L permit.',
  },
  pH: {
    meaning: 'Acidity or alkalinity of the influent on the 0–14 scale, where 7 is neutral.',
    unit: 'pH units',
    typical: '6.8–7.6 for domestic sewage; 7.2 default.',
    effect: 'Carried through the train with small shifts (the aeration basin drops it 0.1–0.15, the RO concentrate gains 0.3) and checked at the outlet against the 6.0–9.0 permit window. It does not alter reaction rates in these models.',
  },
  temp: {
    meaning: 'Wastewater temperature, which sets the speed of every biological reaction in the plant.',
    unit: '°C',
    typical: '10–15 °C in winter, 18–25 °C in summer; 20 °C default.',
    effect: 'Rates are temperature-corrected with θ = 1.07 per °C, so dropping from 20 to 12 °C roughly halves the nitrifier growth rate and can push ammonia through at an SRT that worked all summer.',
  },

  // ── Pump ───────────────────────────────────────────────────────────────────
  running: {
    meaning: 'Pump on/off state, written as numeric 1/0 so a PLC tag can drive it directly.',
    unit: '1 = ON, 0 = OFF',
    typical: 'ON in normal operation; switch it off to model a stopped train.',
    effect: 'Switching it off sets Q_delivered to zero, so every unit downstream sees an empty stream and the whole inflow is reported as blocked_Q_m3_d with a warning.',
  },
  speed_pct: {
    meaning: 'Variable-speed-drive setting, as a percentage of nominal pump speed.',
    unit: '%',
    typical: '70–100 %; below about 60 % most centrifugal pumps lose too much head to be useful.',
    effect: 'Delivered flow scales linearly with it. With no capacity set, dropping to 50 % halves the flow continuing downstream — and the remainder is destroyed as blocked flow, not queued upstream.',
  },
  capacity_m3_d: {
    meaning: 'Rated pump capacity at 100 % speed. Zero means unlimited, so the pump simply passes whatever arrives.',
    unit: 'm³/d',
    typical: 'Set it to the real duty point, or leave 0 while you are still sizing the train.',
    effect: 'When set, delivered flow is capped at capacity × speed/100 and anything above it becomes blocked_Q_m3_d. When 0, the speed setting alone scales the flow.',
  },
  head_m: {
    meaning: 'Total dynamic head the pump works against — the static lift plus friction losses.',
    unit: 'm',
    typical: '5–15 m for transfer or RAS duty; 30 m and up for a long force main.',
    effect: 'Power is 9.81 × Q[m³/s] × head ÷ 0.65 efficiency, so head only moves the energy and cost figures. It never limits the flow in this model.',
  },

  // ── Valve ──────────────────────────────────────────────────────────────────
  open: {
    meaning: 'Valve open/closed state, numeric 1/0 so a PLC tag can drive it directly.',
    unit: '1 = OPEN, 0 = CLOSED',
    typical: 'OPEN in normal operation; closed to isolate a train.',
    effect: 'Closing it sets Q_out to zero and everything downstream goes dry; the full inflow is reported as blocked_Q_m3_d with a warning.',
  },
  opening_pct: {
    meaning: 'Valve position, applied here as a linear characteristic.',
    unit: '% open',
    typical: '100 % for isolation duty; part-open only when you are deliberately throttling.',
    effect: 'Q_out = Q_in × opening/100, so 40 % open passes 40 % of the flow and discards the rest as blocked flow. On a RAS line that starves the aeration basin of returned biomass.',
  },

  // ── Screening ──────────────────────────────────────────────────────────────
  screenType: {
    meaning: 'Screen aperture class, which selects the removal fractions used by the model.',
    unit: 'coarse | fine | micro',
    typical: 'coarse (roughly 20–50 mm bars) at the works inlet, fine ahead of an MBR.',
    effect: 'coarse removes 5 % TSS / 3 % BOD / 3 % COD, fine 15 / 10 / 8 %, micro 30 / 20 / 15 %. Nothing else in the model changes with it.',
  },
  headloss_m: {
    meaning: 'Design head loss across the screen, reported for the hydraulic profile.',
    unit: 'm',
    typical: '0.15 m clean, rising to about 0.5 m before raking.',
    effect: 'Reported only: it appears in the metrics and does not throttle flow or alter removal anywhere in the simulation.',
  },

  // ── Grit removal ───────────────────────────────────────────────────────────
  chamberType: {
    meaning: 'Grit chamber geometry, which selects the removal fractions used by the model.',
    unit: 'vortex | aerated | horizontal',
    typical: 'vortex on a modern works; aerated where scum removal is wanted as well.',
    effect: 'horizontal removes 10 % TSS, vortex 12 %, aerated 15 %, each with 2–3 % BOD/COD. The choice does not alter the chamber volume.',
  },
  HRT_min: {
    meaning: 'Hydraulic retention time in the grit chamber, used to size it.',
    unit: 'minutes',
    typical: '2–5 minutes at peak flow; 3 minutes default.',
    effect: 'It sets chamber_volume_m3 = (Q ÷ 1440) × HRT_min and nothing else — grit removal is fixed by chamber type, so a longer retention time gives a bigger tank and identical removal.',
  },

  // ── Clarifiers ─────────────────────────────────────────────────────────────
  SOR_m3_m2_d: {
    meaning: 'Surface overflow rate — flow divided by tank surface area; the upward velocity a settling particle has to beat.',
    unit: 'm³/m²/d',
    typical: '30–50 for primary clarifiers, 16–24 for secondary clarifiers.',
    effect: 'area_m2 = Q ÷ SOR, so raising it shrinks the tank and raises the solids loading on it.',
  },
  'primary_clarifier.SOR_m3_m2_d': {
    meaning: 'Surface overflow rate — flow divided by tank surface area. In a primary clarifier it sets both the tank size and the removal efficiency.',
    unit: 'm³/m²/d',
    typical: '30–50 m³/m²/d at average flow; 40 default.',
    effect: 'area_m2 = Q ÷ SOR, and removal follows η = 65/(40 + SOR) + 0.25 clamped to 30–70 % — about 65 % TSS at SOR 30, 60 % at 40, 50 % at 60. Raising it shrinks the tank and the removal together.',
  },
  'secondary_clarifier.SOR_m3_m2_d': {
    meaning: 'Surface overflow rate — flow divided by tank surface area. In a final clarifier it sets the tank size and the solids loading rate.',
    unit: 'm³/m²/d',
    typical: '16–24 m³/m²/d; 16 default, and 24 is the design limit this model warns above.',
    effect: 'area_m2 = Q ÷ SOR, so raising it shrinks the tank and pushes SLR up. It does not change the effluent TSS the model reports (that is your target), so above 24 the only signal you get is a warning.',
  },
  depth_m: {
    meaning: 'Side water depth of the clarifier, which turns the surface area into a volume.',
    unit: 'm',
    typical: '3.0–4.5 m for a primary clarifier; 3.5 m default.',
    effect: 'volume = area × depth and HRT_h = volume ÷ Q × 24, so depth changes the residence time, the reported volume and the capital cost — but not the removal efficiency in this model.',
  },
  sludge_TSS: {
    meaning: 'Concentration of the primary sludge drawn off the clarifier floor.',
    unit: 'mg/L',
    typical: '20,000–60,000 mg/L, i.e. 2–6 % dry solids; 25,000 default.',
    effect: 'sludge_Q = removed solids ÷ (sludge_TSS/1000), and that flow is subtracted from the forward stream. Halving this value doubles the water leaving as sludge and takes it out of the effluent.',
  },
  RAS_ratio: {
    meaning: 'Return activated sludge flow as a multiple of the plant influent flow.',
    unit: '× Q influent',
    typical: '0.5–1.0; 0.5 default.',
    effect: 'RAS_Q = Q_in × R/(1 + R) at the clarifier, so at convergence the ratio against plant influent is exactly R. A higher ratio returns more biomass but thins it — RAS_TSS is derived by mass balance and falls as R rises.',
  },
  TSS_effluent: {
    meaning: 'Target suspended solids leaving over the clarifier weir.',
    unit: 'mg/L',
    typical: '10–20 mg/L for a well-settling sludge; 12 default.',
    effect: 'This is an assumption, not an outcome: the model sets effluent TSS to this value (capped at the incoming MLSS) and forces every remaining solid into the RAS. Lowering it therefore thickens the RAS rather than proving better settling.',
  },

  // ── Biological reactors ────────────────────────────────────────────────────
  SRT_d: {
    meaning: 'Solids retention time, or sludge age — how many days the average microbe stays in the system before being wasted. The master dial of the biology.',
    unit: 'days',
    typical: '5–8 d for BOD removal only, 10–15 d for reliable nitrification, 15–25 d in cold weather or for EBPR.',
    effect: 'Raising SRT lowers effluent BOD and ammonia and wastes less sludge per day, but grows the basin (volume ∝ P_x × SRT). Below 1.5 × the minimum aerobic SRT the model switches to partial nitrification and ammonia breaks through.',
  },
  MLSS_mg_L: {
    meaning: 'Mixed liquor suspended solids — how densely packed the microbe soup in the basin is.',
    unit: 'mg/L',
    typical: '2,500–4,000 for conventional activated sludge; 3,000 default.',
    effect: 'A higher MLSS packs the same biomass into a smaller basin (volume = P_x × SRT ÷ MLVSS, MLVSS = 0.8 × MLSS) and shrinks WAS_m3_d — but it loads the secondary clarifier harder, and SLR rises in step.',
  },
  'membrane_bioreactor.MLSS_mg_L': {
    meaning: 'Mixed liquor suspended solids in the membrane tank — how thick the microbe soup is.',
    unit: 'mg/L',
    typical: '8,000–12,000 mg/L for an MBR, far higher than the 2,500–4,000 a settling clarifier can handle.',
    effect: 'A higher MLSS shrinks the required basin volume and the daily WAS flow. Because the membrane is not modelled here, it also raises the effluent TSS this node reports, which is basin MLSS rather than a filtered value.',
  },
  DO_set_mg_L: {
    meaning: 'Dissolved oxygen setpoint the blowers hold in the aerated zone.',
    unit: 'mg/L',
    typical: '1.5–2.5 mg/L; 2.0 default.',
    effect: 'It is carried onto the effluent stream and frames the aeration control story, but the kinetics here are not DO-limited — changing it does not change the BOD or ammonia results this model computes.',
  },
  volume_m3: {
    meaning: 'Reactor volume. Leave it at 0 to let the model size the basin from the biology.',
    unit: 'm³',
    typical: 'Leave 0 while designing; enter a value to test an existing tank.',
    effect: 'At 0 the volume is computed as P_x × 1000 × SRT ÷ MLVSS, then divided by the aerobic fraction so the zone splits still fit. Entering a value fixes the volume and lets HRT_h tell you whether it is adequate.',
  },
  denitrification: {
    meaning: 'Whether an anoxic zone is placed ahead of the aerated zone so bacteria can breathe nitrate and release nitrogen gas.',
    unit: 'true | false',
    typical: 'true wherever a total-nitrogen limit applies.',
    effect: 'When true, nitrate in the feed is reduced against the available BOD (at most BOD ÷ 3.5 mg NO₃-N) before aeration, lowering NO3_effluent and TN and consuming BOD that would otherwise have needed oxygen.',
  },
  anoxic_fraction: {
    meaning: 'Share of the basin volume kept unaerated for denitrification.',
    unit: 'fraction of total volume',
    typical: '0.20–0.35; 0.30 default.',
    effect: 'It reserves volume for nitrate removal, so with a fixed total volume a larger anoxic fraction leaves less aerated volume for nitrification. When the model auto-sizes, the aerobic share must stay above 5 %.',
  },
  ebpr_config: {
    meaning: 'Which enhanced biological phosphorus removal layout the reactor runs.',
    unit: 'none | simple | uct | jhb',
    typical: 'none unless a phosphorus limit applies; uct or jhb for reliable biological P removal.',
    effect: 'none uses the plain aerobic path; simple adds an anaerobic selector that releases 0.5 mg P per mg of VFA for later luxury uptake; uct and jhb switch to the full multi-zone models with nitrate protection and mixed-liquor recycle.',
  },
  anaerobic_fraction: {
    meaning: 'Share of volume held completely air-free and nitrate-free, where the phosphorus bacteria take up VFAs and release phosphate.',
    unit: 'fraction of total volume',
    typical: '0.10–0.20 for UCT and JHB; 0.15 default.',
    effect: 'It sets the anaerobic zone volume in the split. Too small and the PAOs cannot take up enough VFA to over-eat phosphorus later; it also eats into the aerated volume available for nitrification.',
  },
  PAO_fraction: {
    meaning: 'Share of the volatile biomass assumed to be phosphorus-accumulating organisms.',
    unit: 'fraction of MLVSS',
    typical: '0.20–0.40 in a well-run EBPR plant; 0.30 default.',
    effect: 'X_PAO = 0.8 × MLSS × PAO_fraction, and the aerobic uptake cap is X_PAO × ebpr_uptake_rate × (aerobic volume ÷ Q). Raising it raises phosphorus removal capacity directly, until the influent phosphorus runs out.',
  },
  uct_anoxic_fraction: {
    meaning: 'Share of the volume in the main anoxic zone, which denitrifies the mixed-liquor recycle.',
    unit: 'fraction of total volume',
    typical: 'UCT 0.20–0.35, JHB 0.20–0.30; 0.25 default.',
    effect: 'A larger main anoxic zone removes more nitrate from the recycle, which in UCT also means less nitrate reaching the anaerobic zone and less suppression of phosphorus release — at the cost of aerated volume.',
  },
  MLR_ratio: {
    meaning: 'Mixed liquor recycle flow, as a multiple of plant influent, pumped from the aerated zone back to the anoxic zone.',
    unit: '× Q influent',
    typical: 'UCT 2–4, JHB 1.5–2.5; 3.0 default.',
    effect: 'A higher ratio delivers more nitrate to the anoxic zone for denitrification, but carries oxygen back with it and costs pumping energy. The model flags when the recycled nitrate load exceeds the BOD available to reduce it.',
  },
  jhb_preanoxic_fraction: {
    meaning: 'Share of volume in the small pre-anoxic tank on the return sludge line, where RAS nitrate is destroyed before the sludge meets the anaerobic zone.',
    unit: 'fraction of total volume',
    typical: '0.05–0.10; 0.08 default.',
    effect: 'Larger means more complete RAS denitrification and a cleaner anaerobic zone (available BOD is approximated as influent BOD × fraction × 5). Too small and nitrate slips through, tripping the suppression warning above 1.5 mg/L and cutting phosphorus removal.',
  },
  VFA_COD_fraction: {
    meaning: 'Fraction of influent COD that is readily biodegradable volatile fatty acids — the only food the phosphorus bacteria can use in the anaerobic zone.',
    unit: 'fraction of COD',
    typical: '0.10–0.20 for municipal sewage; 0.15 default. Fermenting primary sludge pushes it higher.',
    effect: 'VFA available = COD × this fraction × the nitrate suppression factor, and phosphorus released is half the VFA — making it the single biggest lever on how much phosphorus the EBPR zones can ultimately remove.',
  },
  ebpr_uptake_rate: {
    meaning: 'Specific rate at which phosphorus-accumulating organisms take phosphate back up in the aerated zone.',
    unit: 'g P per g VSS per day',
    typical: '0.10–0.20; 0.15 default.',
    effect: 'It sets the aerobic uptake cap X_PAO × rate × (aerobic volume ÷ Q). Set below the phosphorus actually released and TP_effluent rises; set above it and the extra capacity buys nothing.',
  },

  // ── Chemical dosing ────────────────────────────────────────────────────────
  chemical_type: {
    meaning: 'Which chemical the dosing pump meters in — it selects the whole coefficient set applied to the stream.',
    unit: 'chemical name',
    typical: 'Match it to the duty: a coagulant for phosphorus, caustic or acid for pH, hypochlorite for disinfection.',
    effect: 'Each chemical behaves differently: coagulants remove TP and add floc TSS, NaOH and H₂SO₄ shift pH, hypochlorite trims BOD and TSS, and polymer changes nothing in the bulk stream.',
  },
  'coagulant_dosing.chemical_type': {
    meaning: 'Which metal salt is dosed — alum or ferric chloride.',
    unit: 'alum | ferric_chloride',
    typical: 'Alum where sludge volume matters; ferric where sulphide control or a wider pH window is wanted.',
    effect: 'Alum removes 0.23 mg P and adds 0.26 mg/L floc TSS per mg/L dosed; ferric chloride removes 0.17 mg P and adds 0.40 mg/L TSS — so ferric makes noticeably more sludge for the same phosphorus removed.',
  },
  'polymer_dosing.chemical_type': {
    meaning: 'The conditioning chemical — polymer is the only option on this node.',
    unit: 'polymer',
    typical: 'Cationic polymer for sludge conditioning and dewatering.',
    effect: 'Polymer carries zero removal coefficients in this model, so selecting it changes no stream value; only the reported dose in kg/d, and therefore the chemical cost, moves.',
  },
  'ph_adjustment.chemical_type': {
    meaning: 'Whether you are dosing alkali to raise pH or acid to lower it.',
    unit: 'naoh | h2so4',
    typical: 'NaOH after nitrification (which consumes alkalinity); H₂SO₄ where a stream arrives alkaline.',
    effect: 'NaOH shifts pH by +0.01 per mg/L dosed, H₂SO₄ by −0.008 per mg/L, clamped to the 0–14 range — unless target_pH is set, which overrides the calculation entirely.',
  },
  'chlorination.chemical_type': {
    meaning: 'The hypochlorite product being dosed for disinfection.',
    unit: 'naocl | hypochlorite',
    typical: 'Sodium hypochlorite solution is the usual choice for a municipal works.',
    effect: 'Both options select the same coefficients: 8 % BOD reduction, 6.4 % COD and 2 % TSS. No log reduction is computed on this node.',
  },
  dose_mg_L: {
    meaning: 'Chemical dose applied to the stream.',
    unit: 'mg/L',
    typical: 'Alum 20–100, ferric 20–120, polymer 2–10, hypochlorite 5–20 mg/L as Cl₂.',
    effect: 'The effect is linear in the dose until the target species runs out — TP removal saturates at the phosphorus actually present, after which extra dose only adds floc solids, sludge and cost. dose_kg_d = Q × dose ÷ 1000.',
  },
  'coagulant_dosing.dose_mg_L': {
    meaning: 'Coagulant dose applied to the stream.',
    unit: 'mg/L',
    typical: '20–100 mg/L alum, 20–120 mg/L ferric chloride, depending on the phosphorus to be removed.',
    effect: 'TP removed = dose × 0.23 (alum) or 0.17 (ferric), capped at the phosphorus present, while TSS rises by dose × 0.26 or 0.40 as floc. Past the saturation point extra dose makes only sludge and cost.',
  },
  'polymer_dosing.dose_mg_L': {
    meaning: 'Polymer dose applied to the stream.',
    unit: 'mg/L',
    typical: '2–10 mg/L for sludge conditioning; 1–3 mg/L as a filter aid.',
    effect: 'No stream value changes with it in this model. It drives dose_kg_d = Q × dose ÷ 1000, which feeds the chemical line of the cost estimate.',
  },
  'ph_adjustment.dose_mg_L': {
    meaning: 'Dose of caustic or acid applied to the stream.',
    unit: 'mg/L',
    typical: '10–100 mg/L NaOH is a common trim on a nitrifying plant.',
    effect: 'Each mg/L shifts pH by +0.01 (NaOH) or −0.008 (H₂SO₄). If target_pH is set, the dose no longer drives pH at all — it is still reported for cost, but the effluent pH is forced to your target.',
  },
  'chlorination.dose_mg_L': {
    meaning: 'Applied chlorine dose, expressed as Cl₂.',
    unit: 'mg/L',
    typical: '5–20 mg/L on secondary effluent, depending on chlorine demand.',
    effect: 'It sets dose_kg_d = Q × dose ÷ 1000 for the cost estimate. The BOD, COD and TSS credits are fixed fractions and do not scale with the dose, and no log reduction is computed here.',
  },
  target_pH: {
    meaning: 'Optional pH to force the effluent to, overriding the dose-based calculation.',
    unit: 'pH units',
    typical: 'Leave blank to let the dose drive the pH; 6.5–7.5 when trimming for biology.',
    effect: 'When set, the effluent pH becomes exactly this value regardless of the dose (which is still reported for cost). Leave it empty if you want to find out whether the dose you chose is actually enough.',
  },

  // ── RO membrane ────────────────────────────────────────────────────────────
  recovery_pct: {
    meaning: 'Percentage of the feed water that leaves as clean permeate; the rest becomes concentrate.',
    unit: '%',
    typical: '70–85 % for brackish-water RO; 75 % default.',
    effect: 'Permeate flow scales with it, but the reject concentration factor is 1/(1 − recovery) — going from 75 % to 90 % takes the concentrate from 4× to 10× strength, and in a real plant that is where scaling starts.',
  },
  salt_rejection: {
    meaning: 'Fraction of dissolved salt the membrane holds back.',
    unit: 'fraction 0–1',
    typical: '0.97–0.995 for a modern brackish-water element; 0.97 default.',
    effect: 'It is reported as the TDS performance figure. The permeate quality the model actually computes uses the separate species rejections — 99 % BOD, 98 % TP, 85 % TN and NH₄, 100 % TSS.',
  },
  pressure_bar: {
    meaning: 'Feed pressure applied across the membrane.',
    unit: 'bar',
    typical: '10–20 bar brackish, 55–70 bar seawater; 15 bar default.',
    effect: 'Energy scales linearly: energy_kWh_d = permeate × 0.5 × pressure/15. It does not change recovery or rejection in this model, so it is a cost lever rather than a performance one.',
  },

  // ── Thickener ──────────────────────────────────────────────────────────────
  thickened_TSS_mg_L: {
    meaning: 'Target solids concentration of the thickened sludge leaving the unit.',
    unit: 'mg/L',
    typical: 'Gravity 50,000–70,000 (5–7 % dry solids); DAF 40,000–50,000.',
    effect: 'The thickened flow is the captured solids divided by this concentration, so a higher target gives a smaller, thicker sludge stream to the digester and leaves more water in the filtrate returned to the works.',
  },
  solids_capture: {
    meaning: 'Fraction of the incoming solids the thickener actually captures; whatever escapes leaves in the filtrate.',
    unit: 'fraction 0–1',
    typical: '0.95 for a gravity thickener, 0.98 for DAF.',
    effect: 'Captured solids = solids in × this value, and the particulate BOD, COD, TN and TP follow the same split. Every point lost returns to the head of the works in the filtrate as a real recycle load.',
  },

  // ── UV disinfection ────────────────────────────────────────────────────────
  target_log_reduction: {
    meaning: 'How many log10 steps of pathogen inactivation the UV system is sized to deliver.',
    unit: 'log10',
    typical: '2–4 log for secondary effluent; 4 default. 1-log is 90 %, 2-log 99 %, 3-log 99.9 %.',
    effect: 'required_fluence = target × k_inact, so doubling the target doubles the dose the system must deliver. Whether it is achieved then depends on the UVT correction.',
  },
  UVT_pct: {
    meaning: 'UV transmittance — the percentage of 254 nm light that gets through 1 cm of the water; its optical clarity.',
    unit: '%',
    typical: '55–70 % for secondary effluent, 75–90 % after filtration; 65 % is the model reference point.',
    effect: 'Delivered dose is scaled by √(UVT/65), so falling below 65 % cuts the fluence and the achieved log reduction, and `compliant` flips false once the deficit passes 0.05 log.',
  },
  lamp_power_kW: {
    meaning: 'Electrical power drawn by each UV lamp.',
    unit: 'kW',
    typical: '0.25–0.8 kW for a low-pressure high-output lamp; 0.4 default.',
    effect: 'It drives energy only — energy_kWh_d = lamp_count × lamp_power_kW × 24 — so it is the main cost lever here and has no effect on the delivered dose.',
  },
  lamp_Q_rating_m3_h: {
    meaning: 'Flow that one lamp bank is rated to treat.',
    unit: 'm³/h',
    typical: '30–100 m³/h per bank depending on the reactor; 50 default.',
    effect: 'lamp_count = ceil(Q_m3_h ÷ this rating), so a lower rating means more banks and proportionally more energy. It does not enter the fluence calculation.',
  },
  k_inact_mJ_cm2: {
    meaning: 'UV fluence needed for one log of inactivation of the target organism — in other words, its UV resistance.',
    unit: 'mJ/cm²',
    typical: 'E. coli 19, total coliforms 21, Cryptosporidium 10, Giardia 82, adenovirus about 186.',
    effect: 'required_fluence = target_log × k_inact, so naming a resistant organism multiplies the dose required. Because the achieved log reduction is delivered fluence ÷ k_inact, the compliance verdict follows the organism you choose.',
  },

  // ── Granular filter ────────────────────────────────────────────────────────
  filter_type: {
    meaning: 'Media arrangement in the filter bed.',
    unit: 'dual_media | sand',
    typical: 'dual_media (0.45 m anthracite over 0.30 m sand) for tertiary polishing.',
    effect: 'dual_media puts coarse 1.4 mm anthracite over 0.5 mm sand, giving lower clean-bed head loss and 40 % more solids-holding capacity than the 0.60 m single sand bed — so runs last longer before backwash.',
  },
  HLR_m_h: {
    meaning: 'Hydraulic loading rate — the downward velocity of water through the bed.',
    unit: 'm/h',
    typical: '5–15 m/h; 8 m/h default.',
    effect: 'area_m2 = Q_m3_h ÷ HLR, so raising it shrinks the filter but raises head loss (Kozeny-Carman is linear in velocity) and concentrates the solids load per m², shortening the run to backwash.',
  },
  TSS_removal_pct: {
    meaning: 'Design solids removal the clean bed is expected to achieve.',
    unit: '%',
    typical: '85–95 % for tertiary filtration; 90 % default.',
    effect: 'The achieved value is this target degraded by breakthrough — effective = target × (1 − 0.15 × load/capacity) — so on a heavily loaded run you get up to 15 % less than you asked for.',
  },
  sand_depth_m: {
    meaning: 'Depth of the sand layer in the filter bed.',
    unit: 'm',
    typical: '0.30 m under anthracite in a dual-media bed; 0.60 m for a mono-media sand filter.',
    effect: 'Head loss is proportional to depth in the Kozeny-Carman term, so a deeper bed gives a finer polish and more clean-bed head loss. total_bed_depth_m adds the anthracite layer on top.',
  },
  backwash_interval_h: {
    meaning: 'Run length between backwashes — how long the bed is left to accumulate solids.',
    unit: 'hours',
    typical: '12–48 h; 24 h default.',
    effect: 'TSS load per m² accumulates over this period and adds 0.4 m of head loss per kg/m², so lengthening the interval raises h_clogged_m and eventually trips backwash_needed above the 2.5 m limit.',
  },

  // ── Anaerobic digester ─────────────────────────────────────────────────────
  HRT_d: {
    meaning: 'Hydraulic retention time in the digester — how long the sludge stays inside.',
    unit: 'days',
    typical: '15–25 d mesophilic, 12–15 d thermophilic; 20 d default.',
    effect: 'Destruction follows 1 − e^(−k_eff × HRT), so more days means more gas and more volatile solids destroyed, with diminishing returns. Below 10 days the model warns of methanogen washout.',
  },
  temp_C: {
    meaning: 'Digester operating temperature, held by heating the tank.',
    unit: '°C',
    typical: 'Mesophilic around 35 °C, thermophilic around 55 °C.',
    effect: 'The rate is Arrhenius-corrected — θ = 1.08 per °C around 35 °C, a 1.7× step into the thermophilic band around 55 °C with θ = 1.06, and only 0.15× below 15 °C — so a 5 °C drop costs roughly a third of the hydrolysis rate.',
  },
  COD_removal_pct: {
    meaning: 'Calibration cap on volatile-solids and COD destruction, used to hold the model to measured plant performance.',
    unit: '%',
    typical: '45–60 % for a mesophilic digester on mixed sludge; 55 % default.',
    effect: 'The model takes the lower of the kinetic result and this cap, so lowering it always lowers gas production, while raising it only helps if the kinetics (HRT and temperature) can actually reach it.',
  },
  pH_setpoint: {
    meaning: 'Target pH inside the digester, held by the natural buffering of the process.',
    unit: 'pH units',
    typical: '6.8–7.4; 7.2 default.',
    effect: 'It caps the digestate pH and drives the stability check: below 6.8 the model warns of methanogenic inhibition and flags the digester as unstable.',
  },
  biogas_CH4_frac: {
    meaning: 'Methane content of the raw biogas.',
    unit: 'fraction',
    typical: '0.60–0.70; 0.65 default.',
    effect: 'Total biogas volume = CH₄ ÷ this fraction, so a lower methane content reports a larger gas volume for the same energy. Usable energy tracks the methane, not the raw volume.',
  },
  dewatering: {
    meaning: 'Whether the digestate is split into a dewatered cake and a liquid centrate.',
    unit: 'true | false',
    typical: 'true wherever cake is trucked off site.',
    effect: 'When true the digestate becomes a small cake stream at the cake dry-solids concentration, plus a large ammonia-rich centrate carrying about 95 % of the nitrogen — a return load your mainstream biology has to absorb.',
  },
  cake_DS_pct: {
    meaning: 'Dry solids content of the dewatered cake.',
    unit: '%',
    typical: '18–25 % from a centrifuge, 25–32 % from a filter press; 22 % default.',
    effect: 'Cake volume = captured solids ÷ (DS × 10), so raising it shrinks the tonnage hauled off site and pushes more water into the centrate returned to the works.',
  },
};

/**
 * METRIC_INFO — one plain sentence per Simulation Output key.
 * Keys with no entry simply render without an ⓘ.
 */
export const METRIC_INFO = {
  // ── Boundaries ─────────────────────────────────────────────────────────────
  Q_in: 'Flow of wastewater entering the plant at this inlet, in m³/d.',
  Q_out: 'Flow of treated water leaving the plant at this outlet, in m³/d.',
  compliant: 'True only when the effluent meets every limit in the discharge permit.',
  permit_violations: 'The list of permit limits this effluent breaks, each with its value and limit.',
  limits_applied: 'The permit limits used for this check — the built-in defaults unless your organisation has a template.',

  // ── Flow control ───────────────────────────────────────────────────────────
  status: 'The operating state of this flow element: ON/OFF for a pump, OPEN/THROTTLED/CLOSED for a valve.',
  speed_pct: 'Variable-speed-drive setting as a percentage of nominal pump speed.',
  opening_pct: 'How far the valve is open, as a percentage; flow passes in direct proportion.',
  Q_in_m3_d: 'Flow arriving at this element before it pumps or throttles anything, in m³/d.',
  Q_delivered_m3_d: 'Flow the pump actually passes downstream after its on/off state, speed and capacity are applied.',
  Q_out_m3_d: 'Flow the valve passes downstream, equal to the inflow times the opening percentage.',
  blocked_Q_m3_d: 'Flow this element could not pass — it would back up upstream in a real plant, and is lost here because the steady-state solver has no storage.',
  power_kW: 'Hydraulic shaft power the pump draws: 9.81 × flow × head ÷ efficiency.',
  energy_kWh_d: 'Electricity this unit consumes over a full day.',

  // ── Screening / grit ───────────────────────────────────────────────────────
  screenType: 'The screen aperture class in use, which sets the removal fractions.',
  chamberType: 'The grit chamber geometry in use, which sets the removal fractions.',
  TSS_removal_pct: 'Percentage of the incoming suspended solids this unit removes.',
  screenings_kg_d: 'Mass of rags, wipes and debris raked off the screen each day — wet garbage bound for landfill.',
  screenings_Q_m3_d: 'Volume of the screenings side stream, at about 20 % dry solids.',
  BOD_removed_kg_d: 'Mass of organic load leaving with the screenings rather than continuing downstream.',
  COD_removed_kg_d: 'Mass of oxidisable load leaving with the screenings rather than continuing downstream.',
  grit_removed_kg_d: 'Mass of sand, gravel and other dense grit trapped each day, keeping it out of the pumps.',
  chamber_volume_m3: 'Grit chamber volume needed for the retention time you set at this flow.',
  headloss_m: 'Design head loss across the screen — reported for the hydraulic profile, not applied to the flow.',

  // ── Clarifiers / tanks ─────────────────────────────────────────────────────
  area_m2: 'Surface area this unit needs at the loading rate you set.',
  volume_m3: 'Tank volume, either the area times the depth or the biologically sized basin.',
  HRT_h: 'Hydraulic retention time — how many hours the average drop of water spends in this tank.',
  HRT_min: 'Hydraulic retention time in minutes, used here to size the grit chamber.',
  SOR_m3_m2_d: 'Surface overflow rate — the upward velocity a particle must beat to settle out.',
  SLR_kg_m2_d: 'Solids loading rate on the clarifier floor; above about 6 kg/m²/d the sludge blanket starts to rise.',
  sludge_Q_m3_d: 'Volume of primary sludge drawn off the clarifier floor each day.',
  sludge_TSS_mg_L: 'Solids concentration of that primary sludge underflow.',
  BOD_removal_pct: 'Percentage of the incoming organic load this unit removes.',
  RAS_ratio: 'Return activated sludge flow as a multiple of the plant influent flow.',
  RAS_Q_m3_d: 'Volume of settled microbes pumped back to the aeration basin each day.',
  RAS_TSS_mg_L: 'Concentration of that returned sludge — a mass-balance result, not a setting; it thins as the RAS ratio rises.',
  eff_TSS_mg_L: 'Suspended solids carried over the clarifier weir with the treated water.',

  // ── Biological reactors ────────────────────────────────────────────────────
  config: 'Which reactor configuration was solved: none, simple, uct or jhb.',
  SRT_d: 'Sludge age — how many days the average microbe stays in the system before being wasted.',
  MLSS_mg_L: 'Mixed liquor suspended solids — how densely packed the microbe soup in the basin is.',
  BOD_effluent: 'Organic load left in the water leaving this reactor, in mg/L.',
  NH4_effluent: 'Ammonia left in the water leaving this reactor — the number a nitrification limit is judged on.',
  NO3_effluent: 'Nitrate leaving this reactor, produced by nitrification and removed by denitrification.',
  TP_effluent: 'Phosphorus left in the water leaving this reactor, in mg/L.',
  nitrification: 'True when the sludge age is long enough for the nitrifiers to survive and convert ammonia to nitrate.',
  denitrification: 'True when an anoxic zone is converting nitrate back to nitrogen gas.',
  O2_demand_kg_d: 'Oxygen the microbes need each day — the figure the aeration energy and blower cost are built from.',
  biomass_kg_d: 'New microbial mass grown each day, which is the sludge that must be wasted.',
  WAS_m3_d: 'Volume of waste activated sludge removed daily to hold the sludge age steady.',
  temp_C: 'Process temperature used for the temperature correction on every reaction rate.',
  anoxic_fraction: 'Share of the basin volume kept unaerated for denitrification.',
  anaerobic_fraction: 'Share of the basin volume held air-free and nitrate-free for the phosphorus bacteria.',

  // ── Chemical dosing ────────────────────────────────────────────────────────
  chemical_type: 'The chemical being dosed, which selects the coefficients applied to the stream.',
  dose_mg_L: 'Chemical dose applied, in mg/L of the treated stream.',
  dose_kg_d: 'Mass of chemical consumed each day — the figure the chemical cost is built from.',
  sludge_kg_d: 'Extra chemical sludge produced each day by the dose, which still has to be settled out and disposed of.',
  TP_in_mg_L: 'Phosphorus entering this dosing point.',
  TP_out_mg_L: 'Phosphorus leaving after the dose has precipitated what it can.',
  TP_removal_pct: 'Percentage of the phosphorus locked up by the chemical dose.',
  pH_in: 'pH of the water arriving at this dosing point.',
  pH_out: 'pH of the stream leaving this unit — shifted by the chemical dose (or forced to your target pH), and for a digester the pH of the digestate.',

  // ── UV ─────────────────────────────────────────────────────────────────────
  fluence_mJ_cm2: 'UV dose actually delivered to the water, after correcting for transmittance.',
  required_fluence_mJ_cm2: 'UV dose needed to hit your target log reduction for the chosen organism.',
  UVT_correction: 'Clarity factor applied to the dose, calculated as the square root of UVT divided by the 65 % reference.',
  log_reduction: 'Log10 pathogen inactivation achieved: 1 is 90 %, 2 is 99 %, 3 is 99.9 %.',
  log_deficit: 'How far short of the target log reduction the delivered dose falls; anything above 0.05 fails.',
  lamp_count: 'Number of lamp banks needed to cover this flow at the rated capacity per bank.',
  lamp_power_kW: 'Electrical power drawn by each UV lamp.',
  energy_kWh_m3: 'Electricity used per cubic metre treated — the standard way UV energy is benchmarked.',
  k_inact_mJ_cm2: 'UV dose needed for one log of inactivation of the target organism; its UV resistance.',
  UVT_pct: 'UV transmittance of the water at 254 nm — how much of the light gets through.',
  target_log_reduction: 'The log10 inactivation this system was sized to deliver.',

  // ── Granular filter ────────────────────────────────────────────────────────
  filter_type: 'Media arrangement in the bed: dual media (anthracite over sand) or single-media sand.',
  HLR_m_h: 'Hydraulic loading rate — how fast water travels down through the bed.',
  filtration_velocity_m_s: 'The same loading rate expressed in m/s, as used in the head loss calculation.',
  total_bed_depth_m: 'Combined depth of all media layers in the filter.',
  h_clean_bed_m: 'Head loss through a freshly backwashed bed, from the Kozeny-Carman equation.',
  h_clogged_m: 'Head loss at the end of the run once solids have accumulated in the bed.',
  h_limit_m: 'Head loss at which the filter must be backwashed, typically 2.5 m.',
  TSS_load_kg_m2: 'Solids deposited per square metre of bed over one filter run.',
  backwash_needed: 'True when the clogged head loss exceeds the limit before the scheduled backwash.',
  backwash_interval_h: 'Hours of run time between backwashes.',
  effective_TSS_removal_pct: 'Solids removal actually achieved, after the design target is degraded by breakthrough.',
  breakthrough_fraction: 'How far through its solids-holding capacity the bed has run; 1.0 means fully loaded.',
  filtrate_Q_m3_d: 'Volume of filtered water leaving each day, after the backwash share is taken out.',
  backwash_Q_m3_d: 'Volume of dirty backwash water produced each day — about 5 % of throughput, usually returned to the works.',

  // ── RO ─────────────────────────────────────────────────────────────────────
  recovery_pct: 'Percentage of the feed leaving as clean permeate; the rest becomes concentrate.',
  pressure_bar: 'Feed pressure applied across the membrane, which drives the energy figure.',
  perm_Q_m3_d: 'Volume of purified permeate produced each day.',
  conc_Q_m3_d: 'Volume of concentrate rejected each day — a real stream that still needs somewhere to go.',
  concentration_factor: 'How many times more concentrated the reject is than the feed, equal to 1/(1 − recovery).',
  BOD_permeate_mg_L: 'Organic load that slips through the membrane into the permeate.',
  TN_permeate_mg_L: 'Nitrogen that slips through the membrane into the permeate.',

  // ── Anaerobic digester ─────────────────────────────────────────────────────
  temp_correction_factor: 'Arrhenius multiplier applied to the hydrolysis rate at this digester temperature.',
  k_hyd_effective_d: 'Hydrolysis rate constant after temperature correction, in 1/d.',
  COD_destruction_pct: 'Percentage of the incoming COD broken down in the digester.',
  VS_destruction_pct: 'Percentage of the volatile solids destroyed — the headline measure of digester performance.',
  COD_in_mg_L: 'Organic load in the sludge fed to the digester.',
  COD_out_mg_L: 'Organic load remaining in the stabilised digestate.',
  TSS_in_mg_L: 'Solids concentration of the sludge fed to the digester.',
  TSS_out_mg_L: 'Solids concentration of the digestate after volatile solids have been destroyed.',
  NH4_released_mg_L: 'Ammonia set free as organic nitrogen is mineralised during digestion.',
  NH4_out_mg_L: 'Total ammonia in the digestate, which returns to the works if the liquor is recycled.',
  centrate_NH4_concern: 'True when the dewatering centrate carries an ammonia load heavy enough to upset the mainstream biology.',
  specific_biogas_m3_per_kgVS: 'Biogas produced per kilogram of volatile solids destroyed — the standard digester benchmark.',
  stable: 'True when temperature, pH and the VFA-to-alkalinity balance all sit in the safe operating window.',
  dewatering: 'True when the digestate is split into a dewatered cake plus a liquid centrate.',

  // ── Thickener ──────────────────────────────────────────────────────────────
  solids_in_kg_d: 'Mass of solids arriving at the thickener each day.',
  capture_pct: 'Percentage of those solids captured into the thickened sludge; the rest escapes in the filtrate.',
  thickened_Q_m3_d: 'Volume of thickened sludge produced each day.',
  thickened_TSS_g_L: 'Solids concentration of the thickened sludge, in grams per litre.',
};

/**
 * Look up parameter documentation, most specific first.
 *
 * @param {string} opType   node op type, e.g. 'primary_clarifier'
 * @param {string} key      param key, e.g. 'SOR_m3_m2_d'
 * @returns {{meaning: string, unit: string, typical: string, effect: string}|null}
 */
export function paramInfo(opType, key) {
  if (!key) return null;
  return PARAM_INFO[`${opType}.${key}`] || PARAM_INFO[key] || null;
}

/** Node documentation for an op type, or null when undocumented. */
export function opInfo(opType) {
  return (opType && OP_INFO[opType]) || null;
}

/** One-sentence explanation of a simulation-output metric, or null. */
export function metricInfo(key) {
  return (key && METRIC_INFO[key]) || null;
}
