/**
 * WaterSim Pro — Plain-language report layer
 *
 * buildPlainSummary(report) turns the structured report JSON (see
 * reportData.js) into a "layman's" summary a non-engineer can read:
 * a one-line verdict, a short water story, a friendly quality table,
 * permit violations in words, the treatment train step by step, the
 * cost in everyday terms, and a glossary of every term used.
 *
 * Contract:
 *   - Pure and deterministic: same input → same output. No Date, no random.
 *   - NEVER throws. Missing / null / dynamic-mode fields degrade to empty
 *     arrays and an 'unknown' verdict instead of errors.
 *
 * Relatable-comparison constants used throughout:
 *   - 1 Olympic swimming pool ≈ 2,500 m³
 *   - 1 m³ = 1,000 litres ≈ 5 bathtubs (1 bathtub ≈ 150 L = 0.15 m³)
 *   - a typical household uses ≈ 400 L (0.4 m³) of water per day
 */

'use strict';

const OLYMPIC_POOL_M3 = 2500;
const BATHTUB_M3      = 0.15;
const HOUSEHOLD_M3_D  = 0.4;

// ── Tiny safe helpers ─────────────────────────────────────────────────────────

/** Finite number or null. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "5,000" — deterministic en-US grouping. */
function fmtInt(v) {
  const n = num(v);
  if (n === null) return null;
  return Math.round(n).toLocaleString('en-US');
}

function fmtDec(v, dec = 1) {
  const n = num(v);
  if (n === null) return null;
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** "$271,000" / "$3.4 million". */
function fmtMoney(v) {
  const n = num(v);
  if (n === null) return null;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} million`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Removal percentage (influent → effluent) or null. */
function removalPct(inVal, outVal) {
  const i = num(inVal), o = num(outVal);
  if (i === null || o === null || i <= 0) return null;
  return +(((i - o) / i) * 100).toFixed(1);
}

/** "about 5× over" / "nearly double the limit" / "just over the limit". */
function overLimitPhrase(value, limit) {
  const v = num(value), l = num(limit);
  if (v === null || l === null || l <= 0) return 'over the limit';
  const ratio = v / l;
  if (ratio >= 2.5) return `about ${Math.round(ratio)}× over`;
  if (ratio >= 1.75) return 'nearly double the limit';
  if (ratio >= 1.25) return `about ${Math.round((ratio - 1) * 100)}% over the limit`;
  return 'just over the limit';
}

/** Relatable phrase for a daily volume in m³. */
function volumeComparison(q) {
  const n = num(q);
  if (n === null || n <= 0) return null;
  const pools = n / OLYMPIC_POOL_M3;
  if (pools >= 0.95) {
    const p = pools >= 10 ? Math.round(pools) : +pools.toFixed(1);
    return `roughly ${p.toLocaleString('en-US')} Olympic swimming pool${p === 1 ? '' : 's'} of water`;
  }
  const households = Math.max(1, Math.round(n / HOUSEHOLD_M3_D));
  return `the daily water use of about ${households.toLocaleString('en-US')} household${households === 1 ? '' : 's'}`;
}

// ── Parameter knowledge ───────────────────────────────────────────────────────

const PARAM_INFO = {
  BOD: {
    friendly: 'Organic waste (BOD)',
    short:    'Organic waste',
    meaning:  'How much oxygen bacteria need to eat the waste — high levels suffocate fish.',
    consequence: 'Untreated organic waste uses up the oxygen in a river and suffocates fish.',
  },
  COD: {
    friendly: 'All burnable pollution (COD)',
    short:    'Chemical oxygen demand',
    meaning:  'A broader chemistry measure of everything in the water that can be "burned up" — usually about twice the BOD.',
    consequence: 'High COD means a heavy load of oxidisable pollution reaching the river.',
  },
  TSS: {
    friendly: 'Floating particles (TSS)',
    short:    'Suspended solids',
    meaning:  'The particles floating in the water — the visible cloudiness.',
    consequence: 'Escaping solids cloud the water and smother the riverbed.',
  },
  TN: {
    friendly: 'Nitrogen (TN)',
    short:    'Nitrogen',
    meaning:  'All forms of nitrogen combined, from urine and food waste — it feeds algae blooms.',
    consequence: 'Excess nitrogen feeds algae that choke rivers.',
  },
  NH4: {
    friendly: 'Ammonia (NH4)',
    short:    'Ammonia',
    meaning:  'The sharp-smelling form of nitrogen — directly toxic to fish.',
    consequence: 'Ammonia is directly toxic to fish, even at low levels.',
  },
  NO3: {
    friendly: 'Nitrate (NO3)',
    short:    'Nitrate',
    meaning:  'What ammonia becomes after treatment — less toxic, but still algae food.',
    consequence: 'Nitrate keeps feeding algae downstream.',
  },
  TP: {
    friendly: 'Phosphorus (TP)',
    short:    'Phosphorus',
    meaning:  'Phosphorus from detergents and food — even small amounts feed algae.',
    consequence: 'Excess phosphorus feeds algae that choke rivers.',
  },
  pH: {
    friendly: 'Acidity (pH)',
    short:    'Acidity',
    meaning:  'The acid/alkaline scale from 0 to 14; 7 is neutral. Rivers need water close to neutral.',
    consequence: 'Water that is too acidic or too alkaline harms everything living in the river.',
  },
};

/**
 * Judge a quality row: 'good' | 'ok' | 'poor' | null.
 *
 * Heuristics (documented so engineers can audit them):
 *   BOD : good if ≥90% removed or effluent ≤10 mg/L; ok if ≥70% or ≤30 mg/L
 *         (30 mg/L is the typical secondary-treatment permit level).
 *   COD : good ≥85% removed or ≤50 mg/L; ok ≥60% or ≤125 mg/L (EU urban limit).
 *   TSS : good ≥85% removed or ≤15 mg/L; ok ≥60% or ≤30 mg/L.
 *   NH4 : judged on the effluent level (toxicity is absolute):
 *         good ≤1 mg/L; ok ≤5 mg/L (a common permit level).
 *   TN  : good if effluent ≤10 mg/L (typical strict permit); ok ≤20 mg/L
 *         or ≥60% removed.
 *   TP  : good ≤1 mg/L (typical permit); ok ≤2 mg/L or ≥70% removed.
 * Returns null when the effluent value is unknown.
 */
function judgeParam(param, inVal, outVal) {
  const o = num(outVal);
  if (o === null) return null;
  const rem = removalPct(inVal, outVal);
  switch (param) {
    case 'BOD':
      if ((rem !== null && rem >= 90) || o <= 10) return 'good';
      if ((rem !== null && rem >= 70) || o <= 30) return 'ok';
      return 'poor';
    case 'COD':
      if ((rem !== null && rem >= 85) || o <= 50) return 'good';
      if ((rem !== null && rem >= 60) || o <= 125) return 'ok';
      return 'poor';
    case 'TSS':
      if ((rem !== null && rem >= 85) || o <= 15) return 'good';
      if ((rem !== null && rem >= 60) || o <= 30) return 'ok';
      return 'poor';
    case 'NH4':
      if (o <= 1) return 'good';
      if (o <= 5) return 'ok';
      return 'poor';
    case 'TN':
      if (o <= 10) return 'good';
      if (o <= 20 || (rem !== null && rem >= 60)) return 'ok';
      return 'poor';
    case 'TP':
      if (o <= 1) return 'good';
      if (o <= 2 || (rem !== null && rem >= 70)) return 'ok';
      return 'poor';
    default:
      return null;
  }
}

// ── Unit-operation explanations (covers every palette type) ───────────────────

const OP_EXPLANATIONS = {
  // Sources / sinks
  inlet:  { label: 'Inlet',  explanation: 'The front door: where the town’s wastewater arrives and is measured before treatment begins.' },
  outlet: { label: 'Outlet', explanation: 'The exit referee: checks the finished water against the legal permit limits before it is released.' },
  // Flow control
  pump:  { label: 'Pump',  explanation: 'Moves the water to the next stage; when off, flow stops.' },
  valve: { label: 'Valve', explanation: 'A tap on the pipe: fully open lets everything through, part-open throttles the flow, closed stops it.' },
  // Preliminary
  screening:    { label: 'Bar Screen',   explanation: 'A giant sieve that catches rags, wipes and plastic before they wreck the pumps.' },
  screen:       { label: 'Bar Screen',   explanation: 'A giant sieve that catches rags, wipes and plastic before they wreck the pumps.' },
  grit_removal: { label: 'Grit Chamber', explanation: 'A sand trap: swirls the water so grit and gravel sink out before they sandpaper the machinery.' },
  grit:         { label: 'Grit Chamber', explanation: 'A sand trap: swirls the water so grit and gravel sink out before they sandpaper the machinery.' },
  // Primary
  primary_clarifier: { label: 'Primary Clarifier', explanation: 'A big, calm settling tank: the water sits still so gravity pulls the heavy particles down as sludge.' },
  prim_clarifier:    { label: 'Primary Clarifier', explanation: 'A big, calm settling tank: the water sits still so gravity pulls the heavy particles down as sludge.' },
  // Biological
  activated_sludge: { label: 'Aeration Basin', explanation: 'The microbe zoo: billions of hungry microbes eat the dissolved pollution while blowers keep them supplied with air.' },
  aeration:         { label: 'Aeration Basin', explanation: 'The microbe zoo: billions of hungry microbes eat the dissolved pollution while blowers keep them supplied with air.' },
  membrane_bioreactor: { label: 'Membrane Bioreactor', explanation: 'A microbe tank combined with an ultra-fine filter, so the clean water is strained straight out of the microbe soup.' },
  uct_reactor: { label: 'UCT Reactor', explanation: 'An advanced microbe tank with air-free zones that also destroys nitrate and trains microbes to hoard phosphorus.' },
  jhb_reactor: { label: 'JHB Reactor', explanation: 'An advanced microbe tank with air-free zones that also destroys nitrate and trains microbes to hoard phosphorus.' },
  ebpr_uct:    { label: 'UCT Reactor', explanation: 'An advanced microbe tank with air-free zones that also destroys nitrate and trains microbes to hoard phosphorus.' },
  ebpr_jhb:    { label: 'JHB Reactor', explanation: 'An advanced microbe tank with air-free zones that also destroys nitrate and trains microbes to hoard phosphorus.' },
  secondary_clarifier: { label: 'Secondary Clarifier', explanation: 'A settling pond for the microbes: clear water rises over the rim while the settled microbes are pumped back to work (the RAS line).' },
  sec_clarifier:       { label: 'Secondary Clarifier', explanation: 'A settling pond for the microbes: clear water rises over the rim while the settled microbes are pumped back to work (the RAS line).' },
  // Sludge
  anaerobic_digester: { label: 'Anaerobic Digester', explanation: 'A sealed, heated tank where microbes rot the sludge down without air, shrinking it and producing burnable biogas.' },
  anaerobic_digest:   { label: 'Anaerobic Digester', explanation: 'A sealed, heated tank where microbes rot the sludge down without air, shrinking it and producing burnable biogas.' },
  thickener:        { label: 'Sludge Thickener', explanation: 'Squeezes extra water out of the sludge so there is less of it to haul away.' },
  sludge_thickener: { label: 'Sludge Thickener', explanation: 'Squeezes extra water out of the sludge so there is less of it to haul away.' },
  // Tertiary / disinfection
  uv_disinfection: { label: 'UV Disinfection', explanation: 'Strong ultraviolet light zaps the germs that survived treatment, without adding any chemicals.' },
  chlorination:    { label: 'Chlorination', explanation: 'A carefully measured dose of chlorine kills the remaining germs before the water is released.' },
  sand_filter:     { label: 'Sand Filter', explanation: 'The water trickles through a deep bed of sand that strains out the last fine particles.' },
  granular_filter: { label: 'Sand Filter', explanation: 'The water trickles through a deep bed of sand that strains out the last fine particles.' },
  // Chemical
  chemical_dosing:  { label: 'Chemical Dosing', explanation: 'Adds a treatment chemical that turns dissolved pollution (mainly phosphorus) into particles that can settle out.' },
  coagulant_dosing: { label: 'Coagulant Dosing', explanation: 'Adds a chemical that makes tiny particles clump together into bigger ones that settle out easily.' },
  polymer_dosing:   { label: 'Polymer Dosing', explanation: 'Adds a sticky polymer that glues fine particles into heavy clumps so they settle faster.' },
  ph_adjustment:    { label: 'pH Adjustment', explanation: 'Adds acid or alkali to bring the water back close to neutral.' },
  coagulation:      { label: 'Coagulation/Flocculation', explanation: 'Gently stirs in a chemical that makes tiny particles clump into "flocs" big enough to settle.' },
  // Membranes / adsorption
  ro_membrane: { label: 'RO Membrane', explanation: 'Reverse osmosis: squeezes the water through a membrane so fine that almost nothing but water molecules gets through.' },
  ro:          { label: 'RO Membrane', explanation: 'Reverse osmosis: squeezes the water through a membrane so fine that almost nothing but water molecules gets through.' },
  uf_membrane: { label: 'UF Membrane', explanation: 'An ultra-fine strainer with pores far thinner than a hair, catching particles and most germs.' },
  gac_adsorption: { label: 'Carbon Filter (GAC)', explanation: 'A bed of activated carbon that soaks up dissolved chemicals like a sponge, the way a fridge filter does.' },
  // Utility / passive
  blower: { label: 'Blower', explanation: 'The air compressor that pushes bubbles into the aeration tank so the microbes can breathe.' },
  tank:   { label: 'Storage Tank', explanation: 'A holding tank that evens out surges so the plant sees a steady flow.' },
  passthrough: { label: 'Passthrough', explanation: 'A connection point: the water flows through unchanged.' },
};

/** Human label for an op type not in the map: 'ro_membrane' → 'Ro Membrane'. */
function titleCase(s) {
  return String(s || 'unit')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Pick the most meaningful metric for a unit and phrase it simply.
 * Returns a string or null. All reads are defensive.
 */
function keyFactFor(kind, metrics) {
  const m = metrics || {};
  const val = (k) => num(m[k]);
  switch (kind) {
    case 'inlet': {
      const q = val('Q_in');
      return q !== null ? `receives ${fmtInt(q)} m³ of wastewater a day` : null;
    }
    case 'outlet': {
      if (m.compliant === true)  return 'final check: PASS — the water meets its permit';
      if (m.compliant === false) {
        const n = Array.isArray(m.permit_violations) ? m.permit_violations.length : 0;
        return n > 0 ? `final check: FAIL — ${n} limit${n === 1 ? '' : 's'} broken` : 'final check: FAIL';
      }
      return null;
    }
    case 'pump': {
      if (m.status === 'OFF') return 'switched OFF — no water is moving past this point';
      const kw = val('power_kW'), q = val('Q_delivered_m3_d');
      if (kw !== null && q !== null) return `drawing ${fmtDec(kw, 1)} kW to move ${fmtInt(q)} m³ a day`;
      if (kw !== null) return `drawing ${fmtDec(kw, 1)} kW`;
      return null;
    }
    case 'valve': {
      if (m.status === 'CLOSED') return 'CLOSED — no water is getting through';
      const pct = val('opening_pct');
      if (m.status === 'THROTTLED' && pct !== null) return `part-open at ${fmtDec(pct, 0)}%, holding back the rest of the flow`;
      return 'fully open — everything flows through';
    }
    case 'screen': {
      const kg = val('screenings_kg_d');
      return kg !== null ? `caught ${fmtInt(kg)} kg of screenings per day` : null;
    }
    case 'grit': {
      const kg = val('grit_removed_kg_d');
      return kg !== null ? `trapped ${fmtInt(kg)} kg of sand and grit per day` : null;
    }
    case 'prim_clarifier': {
      const pct = val('TSS_removal_pct');
      return pct !== null ? `settled out ${fmtDec(pct, 0)}% of the floating particles` : null;
    }
    case 'aeration': {
      const o2 = val('O2_demand_kg_d');
      const nit = m.nitrification === true ? ' while converting the toxic ammonia' : '';
      return o2 !== null ? `the microbes breathe ${fmtInt(o2)} kg of oxygen a day${nit}` : null;
    }
    case 'sec_clarifier': {
      const ras = val('RAS_Q_m3_d');
      return ras !== null ? `sends ${fmtInt(ras)} m³ of settled microbes back to work each day` : null;
    }
    case 'thickener': {
      const pct = val('capture_pct');
      return pct !== null ? `captures ${fmtDec(pct, 0)}% of the incoming solids into a thicker sludge` : null;
    }
    case 'ro': {
      const q = val('perm_Q_m3_d');
      return q !== null ? `produces ${fmtInt(q)} m³ of very pure water a day` : null;
    }
    case 'uv_disinfection': {
      const lamps = val('lamp_count'), log = val('log_reduction');
      if (log !== null) return `kills ${fmtDec(log, 1)}-log of germs (${lamps !== null ? `${fmtInt(lamps)} lamps` : 'UV lamps'})`;
      return null;
    }
    case 'granular_filter': {
      const pct = val('effective_TSS_removal_pct');
      return pct !== null ? `strains out ${fmtDec(pct, 0)}% of the remaining particles` : null;
    }
    case 'chemical_dosing': {
      const tp = val('TP_removal_pct'), kg = val('dose_kg_d');
      if (tp !== null && tp > 0) return `locks up ${fmtDec(tp, 0)}% of the phosphorus`;
      if (kg !== null) return `doses ${fmtInt(kg)} kg of chemical a day`;
      return null;
    }
    case 'anaerobic_digest': {
      const vs = val('VS_destruction_pct') ?? val('COD_destruction_pct');
      return vs !== null ? `rots down ${fmtDec(vs, 0)}% of the sludge, making biogas` : null;
    }
    default:
      return null;
  }
}

// ── Section builders (each individually guarded by the caller) ────────────────

/**
 * Dynamic runs store per-hour steps rather than one summary. Pick a usable
 * summary/unitResults pair: steady-state top level first, else the last
 * dynamic step that has a summary.
 */
function effectiveResults(report) {
  const results = (report && report.results) || {};
  const summary = results.summary || {};
  if (summary && (summary.influent || summary.effluent)) {
    return { summary, unitResults: results.unitResults || {}, fromDynamicStep: false };
  }
  const steps = Array.isArray(results.steps) ? results.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && s.summary && (s.summary.influent || s.summary.effluent)) {
      return { summary: s.summary, unitResults: s.unitResults || {}, fromDynamicStep: true };
    }
  }
  return { summary: summary || {}, unitResults: results.unitResults || {}, fromDynamicStep: false };
}

/** Count how many separate limits the permit applies (pH range counts once). */
function countPermitLimits(limits) {
  if (!limits || typeof limits !== 'object') return null;
  let n = 0;
  for (const k of ['BOD', 'TSS', 'TN', 'TP', 'NH4', 'NO3']) {
    if (num(limits[k]) !== null) n += 1;
  }
  if (num(limits.pH_min) !== null || num(limits.pH_max) !== null) n += 1;
  return n > 0 ? n : null;
}

function buildVerdict(summary, limits, fromDynamicStep) {
  const compliant  = summary.compliant;
  const violations = Array.isArray(summary.permit_violations) ? summary.permit_violations : [];
  const inf = summary.influent || {};
  const eff = summary.effluent || {};
  const bodRem = removalPct(inf.BOD, eff.BOD);
  const remPhrase = bodRem !== null ? `The plant removes ${fmtDec(bodRem, 1)}% of the organic pollution` : null;
  const dynNote = fromDynamicStep ? ' (based on the final hour of the simulated day)' : '';

  if (compliant === true) {
    const limitCount = countPermitLimits(limits);
    return {
      status: 'pass',
      headline: remPhrase
        ? `${remPhrase}, and the treated water passes every permit limit.`
        : 'The treated water passes every permit limit.',
      detail: (limitCount
        ? `All ${limitCount} legal limits checked in this run were met`
        : 'Every legal limit checked in this run was met')
        + ` — this water is clean enough to release${dynNote}.`,
    };
  }

  if (compliant === false) {
    const v = violations.length;
    const limitCount = countPermitLimits(limits);
    const names = [...new Set(violations.map((x) => {
      const info = PARAM_INFO[x && x.param];
      return info ? info.short.toLowerCase() : (x && x.param) || 'a pollutant';
    }))];
    const breaks = limitCount
      ? `breaks ${v} of the ${limitCount} permit limits`
      : `breaks ${v} permit limit${v === 1 ? '' : 's'}`;
    return {
      status: 'fail',
      headline: remPhrase
        ? `${remPhrase}, but the treated water still ${breaks}.`
        : `The treated water ${breaks}.`,
      detail: names.length
        ? `The water is over the legal limit for ${names.join(' and ')}${dynNote} — in real life that would mean fines and an unhappy river downstream.`
        : `The water is over one or more legal limits${dynNote}.`,
    };
  }

  return {
    status: 'unknown',
    headline: 'This run did not produce a clear pass-or-fail verdict against a discharge permit.',
    detail: 'No permit check was recorded for this run, so there is nothing to grade the water against.',
  };
}

function buildWaterStory(summary) {
  const story = [];
  const inf = summary.influent || {};
  const eff = summary.effluent || {};
  const qIn  = num(inf.Q);
  const qOut = num(eff.Q);

  if (qIn !== null && qIn > 0) {
    const cmp = volumeComparison(qIn);
    story.push({
      label: 'What comes in',
      text: `About ${fmtInt(qIn)} m³ of dirty water arrives every day${cmp ? ` — ${cmp}` : ''}. (A cubic metre, m³, is 1,000 litres — about five bathtubs.)`,
    });
  }

  if (qOut !== null && qOut >= 0) {
    const pct = qIn && qIn > 0 ? Math.round((qOut / qIn) * 100) : null;
    story.push({
      label: 'What goes out',
      text: qOut === 0
        ? 'No treated water is leaving the plant in this run — the flow is stopped somewhere along the way.'
        : `About ${fmtInt(qOut)} m³ of treated water leaves for the river each day${pct !== null ? ` — ${pct}% of what came in` : ''}.`,
    });
  }

  if (qIn !== null && qOut !== null && qIn > 0) {
    const lost = qIn - qOut;
    const lostShare = lost / qIn;
    if (lostShare > 0.005 && lost > 0) {
      let text = `The remaining ~${fmtInt(lost)} m³ a day leaves as sludge and other side-streams — the solids and microbes pulled out of the water.`;
      if (lostShare > 0.1) {
        text += ` That is ${Math.round(lostShare * 100)}% of the flow — a real plant loses only a percent or two, so a settings check is worthwhile.`;
      }
      story.push({ label: 'Where the rest goes', text });
    } else if (lostShare <= 0.005) {
      story.push({
        label: 'Where the rest goes',
        text: 'Almost all of the water that arrives makes it through to the river — only a trickle leaves with the removed sludge.',
      });
    }
  }

  return story;
}

function buildQualityRows(summary) {
  const inf = summary.influent || {};
  const eff = summary.effluent || {};
  const params = ['BOD', 'TSS', 'NH4', 'TN', 'TP'];
  if (num(inf.COD) !== null || num(eff.COD) !== null) params.splice(1, 0, 'COD');

  const rows = [];
  for (const p of params) {
    const info = PARAM_INFO[p];
    const inV  = num(inf[p]);
    const outV = num(eff[p]);
    if (inV === null && outV === null) continue;
    rows.push({
      param:      p,
      friendly:   info ? info.friendly : p,
      meaning:    info ? info.meaning : '',
      in:         inV,
      out:        outV,
      unit:       'mg/L',
      removalPct: removalPct(inV, outV),
      judgment:   judgeParam(p, inV, outV),
    });
  }
  return rows;
}

function buildComplianceStory(summary) {
  const compliant  = summary.compliant;
  const violations = Array.isArray(summary.permit_violations) ? summary.permit_violations : [];

  if (compliant === true) {
    return [{
      param: null,
      friendly: 'All limits met',
      text: 'Good news: the treated water stays inside every legal limit on its discharge permit. It is officially clean enough to release.',
      severity: 'none',
    }];
  }
  if (compliant !== false) return [];

  const story = [];
  for (const v of violations) {
    if (!v || typeof v !== 'object') continue;
    const p     = v.param;
    const info  = PARAM_INFO[p] || {};
    const value = num(v.value);
    const limit = num(v.limit);
    let text;
    if (p === 'pH') {
      const bound = v.unit === '(min)' ? 'minimum' : 'maximum';
      text = `The water is too ${v.unit === '(min)' ? 'acidic' : 'alkaline'}: pH ${value !== null ? fmtDec(value, 1) : '?'} against a legal ${bound} of ${limit !== null ? fmtDec(limit, 1) : '?'}. ${info.consequence || ''}`.trim();
    } else {
      const name = info.short || p || 'A pollutant';
      const vs = value !== null ? fmtDec(value, value >= 100 ? 0 : 1) : '?';
      const ls = limit !== null ? fmtDec(limit, limit >= 100 ? 0 : 1) : '?';
      text = `${name} is ${vs} mg/L; the permit allows ${ls} — ${overLimitPhrase(value, limit)}. ${info.consequence || ''}`.trim();
    }
    let severity = 'low';
    if (value !== null && limit !== null && limit > 0) {
      const ratio = value / limit;
      severity = ratio >= 3 ? 'high' : ratio >= 1.5 ? 'medium' : 'low';
    }
    story.push({ param: p ?? null, friendly: info.friendly || p || 'Pollutant', text, severity });
  }
  return story;
}

/**
 * Order node ids the way the water actually flows.
 *
 * unitResults CANNOT be trusted for this: results are stored as Postgres
 * jsonb, which discards key insertion order (keys come back sorted by length,
 * so 'n0'…'n6' precede 'p_feed' regardless of where the pump sits in the
 * train). When the flowsheet canvas is available we sort topologically from
 * the inlets instead; otherwise we keep whatever order we were given.
 *
 * @returns {string[]} node ids in flow order (every id of unitResults, once)
 */
function orderNodesByFlow(unitResults, canvas) {
  const ids = Object.keys(unitResults || {});
  const nodes = canvas && Array.isArray(canvas.nodes) ? canvas.nodes : null;
  const edges = canvas && Array.isArray(canvas.edges) ? canvas.edges : [];
  if (!nodes || !nodes.length) return ids;

  const known = new Set(ids);
  const canvasIds = nodes.map(n => n && n.id).filter(id => known.has(id));
  const inSet = new Set(canvasIds);

  const isRecycleEdge = (e) => {
    if (e && e.data && e.data.isRecycle === true) return true;
    const st = String((e && e.data && e.data.streamType) || '').toLowerCase();
    return st === 'ras' || st === 'was' || st === 'recycle' || st === 'internal_recycle';
  };

  const indeg    = new Map(canvasIds.map(id => [id, 0]));
  const out      = new Map(canvasIds.map(id => [id, []]));
  const anyEdge  = new Set();                       // touched by any edge at all
  const feederOf = new Map();                       // recycle-fed node → its source
  for (const e of edges) {
    if (!e || !inSet.has(e.source) || !inSet.has(e.target)) continue;
    anyEdge.add(e.source); anyEdge.add(e.target);
    // Recycle/return lines (RAS, WAS…) are not forward flow — following them
    // would create a cycle and push the receiving unit to the end.
    if (isRecycleEdge(e)) {
      if (!feederOf.has(e.target)) feederOf.set(e.target, e.source);
      continue;
    }
    indeg.set(e.target, indeg.get(e.target) + 1);
    out.get(e.source).push(e.target);
  }

  // Seed only genuine starting points: units with nothing flowing into them
  // (forward OR recycle) that do feed something. A pump on a RAS line has no
  // forward inlet but is NOT where the story starts.
  const hasInbound = new Set();
  for (const e of edges) {
    if (e && inSet.has(e.source) && inSet.has(e.target)) hasInbound.add(e.target);
  }
  const isolated = canvasIds.filter(id => !anyEdge.has(id));
  const queue = canvasIds.filter(id =>
    indeg.get(id) === 0 && !hasInbound.has(id) && anyEdge.has(id));

  const ordered = [];
  const seen = new Set();
  const visit = () => {
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
      for (const t of out.get(id) || []) {
        indeg.set(t, indeg.get(t) - 1);
        if (indeg.get(t) === 0 && !seen.has(t)) queue.push(t);
      }
    }
  };
  visit();

  // Recycle-fed units (a RAS pump, a return valve) read best right after the
  // unit whose stream they carry — "clarifier → RAS pump" — so splice them in
  // there rather than leaving them stranded at either end.
  for (const id of canvasIds) {
    if (seen.has(id) || isolated.includes(id)) continue;
    const feeder = feederOf.get(id);
    const at = feeder ? ordered.indexOf(feeder) : -1;
    seen.add(id);
    if (at >= 0) ordered.splice(at + 1, 0, id);
    else ordered.push(id);
    // Anything this unit feeds forward can now follow normally.
    for (const t of out.get(id) || []) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0 && !seen.has(t)) queue.push(t);
    }
    visit();
  }

  // Units connected to nothing are real (someone dropped them on the canvas)
  // but they are not part of the journey — mention them last.
  for (const id of isolated) if (!seen.has(id)) { seen.add(id); ordered.push(id); }
  // Results for nodes that are no longer on the canvas still get told.
  for (const id of ids) if (!inSet.has(id)) ordered.push(id);
  return ordered;
}

/**
 * @param {object} unitResults  per-node solver results
 * @param {object} [canvas]     flowsheet canvas_data — supplies flow order and
 *                              the operator's own node names ("RAS Pump"),
 *                              neither of which survives into unitResults
 */
function buildTreatmentSteps(unitResults, canvas) {
  const steps = [];
  if (!unitResults || typeof unitResults !== 'object') return steps;

  const labelById = new Map();
  if (canvas && Array.isArray(canvas.nodes)) {
    for (const n of canvas.nodes) {
      const label = n && n.data && typeof n.data.label === 'string' ? n.data.label.trim() : '';
      if (n && n.id && label) labelById.set(n.id, label);
    }
  }

  for (const nodeId of orderNodesByFlow(unitResults, canvas)) {
    const ur = unitResults[nodeId];
    if (!ur || typeof ur !== 'object') continue;
    const palette = ur.paletteType || ur.type || 'unit';
    const kind    = ur.type || palette;
    const entry   = OP_EXPLANATIONS[palette] || OP_EXPLANATIONS[kind] || null;
    let keyFact = null;
    try {
      keyFact = keyFactFor(kind, ur.metrics);
    } catch { keyFact = null; }
    // The name on the canvas is what the reader sees in the app; the generic
    // type name is only a fallback ("Pump" when nobody named it).
    const label = labelById.get(nodeId) || (entry ? entry.label : titleCase(palette));
    steps.push({
      id:          nodeId,
      label,
      kind,
      explanation: entry ? entry.explanation : 'A treatment step in the process train.',
      keyFact,
    });
  }
  return steps;
}

function buildCostStory(cost) {
  const lines = [];
  if (!cost || typeof cost !== 'object') return { lines };

  const total = num(cost.total_USD_yr);
  const lcow  = num(cost.lcow_per_m3) ?? num(cost.cost_per_m3_treated_USD);

  if (total !== null && total > 0) {
    let line = `Running the plant costs about ${fmtMoney(total)} a year`;
    if (lcow !== null && lcow > 0) {
      line += ` — about $${lcow.toFixed(2)} per 1,000 litres treated (one cubic metre)`;
    }
    lines.push(line + '.');
  }

  if (lcow !== null && lcow > 0) {
    const perTubCents  = lcow * BATHTUB_M3 * 100;      // 1 bathtub ≈ 150 L
    const perHouseDay  = lcow * HOUSEHOLD_M3_D;        // household ≈ 400 L/day
    lines.push(
      `That is roughly ${perTubCents < 1 ? 'under 1' : fmtDec(perTubCents, 0)}¢ per bathtub (150 L), or about $${perHouseDay.toFixed(2)} a day to treat a typical household's 400 litres.`
    );
  }

  const capex = num(cost.capex && cost.capex.totalInstalled)
             ?? num(cost.maintenance && cost.maintenance.capex_estimate_USD);
  if (capex !== null && capex > 0) {
    lines.push(`Building a plant like this is estimated at about ${fmtMoney(capex)} (already spread into the per-litre figure above).`);
  }

  // Biggest running-cost category.
  const cats = [
    ['electricity',      num(cost.energy && cost.energy.cost_USD_yr)],
    ['chemicals',        num(cost.chemicals && cost.chemicals.total_USD_yr)],
    ['sludge disposal',  num(cost.sludge && cost.sludge.cost_USD_yr)],
    ['staff wages',      num(cost.labour && cost.labour.cost_USD_yr)],
    ['maintenance',      num(cost.maintenance && cost.maintenance.cost_USD_yr)],
  ].filter(([, v]) => v !== null && v > 0);
  if (cats.length && total !== null && total > 0) {
    cats.sort((a, b) => b[1] - a[1]);
    const [name, v] = cats[0];
    lines.push(`The biggest running cost is ${name}: ${fmtMoney(v)} a year (${Math.round((v / total) * 100)}% of the bill).`);
  }

  return { lines };
}

// ── Glossary ──────────────────────────────────────────────────────────────────

/**
 * Master glossary. Each entry is included in the output only when its term
 * (or one of its aliases) actually appears in the generated plain text, so
 * everything referenced above is always covered and nothing unused pads the
 * list.
 */
const GLOSSARY = [
  { term: 'BOD',  definition: 'Biochemical oxygen demand — how much oxygen bacteria use up while eating the organic waste in the water. High BOD water suffocates rivers.' },
  { term: 'COD',  definition: 'Chemical oxygen demand — a broader measure of everything in the water that can be chemically "burned up"; usually about twice the BOD.' },
  { term: 'TSS',  definition: 'Total suspended solids — the particles floating in the water; the visible cloudiness.' },
  { term: 'TN',   definition: 'Total nitrogen — all forms of nitrogen combined. It feeds algae blooms, so permits limit it strictly.' },
  { term: 'NH4',  definition: 'Ammonia nitrogen — the sharp-smelling form of nitrogen from urine and proteins; directly toxic to fish.', aliases: ['ammonia'] },
  { term: 'NO3',  definition: 'Nitrate — what ammonia becomes after treatment. Less toxic, but still algae food.', aliases: ['nitrate'] },
  { term: 'TP',   definition: 'Total phosphorus — phosphorus from detergents and food. Even small amounts feed algae.', aliases: ['phosphorus'] },
  { term: 'pH',   definition: 'The acid/alkaline scale from 0 to 14; 7 is neutral. Permits usually require the water to stay between 6 and 9.' },
  { term: 'DO',   definition: 'Dissolved oxygen — the oxygen gas dissolved in water; what fish and microbes breathe.' },
  { term: 'm³', definition: 'A cubic metre: 1,000 litres, about five bathtubs. Plant flows are measured in m³ per day.' },
  { term: 'mg/L', definition: 'Milligrams per litre — the standard pollution unit. 1 mg/L is about a pinch of sugar dissolved in a whole bathtub.' },
  { term: 'SRT',  definition: 'Solids retention time ("sludge age") — how many days the average microbe stays in the plant before being removed; the master biological dial.' },
  { term: 'HRT',  definition: 'Hydraulic retention time — how long the average drop of water spends inside a tank.' },
  { term: 'MLSS', definition: 'Mixed liquor suspended solids — how densely packed the microbe soup in the aeration tank is.' },
  { term: 'RAS',  definition: 'Return activated sludge — the backward pipe that sends settled microbes from the clarifier back to the aeration tank to keep the workforce staffed.' },
  { term: 'WAS',  definition: 'Waste activated sludge — the small surplus of microbes deliberately removed each day so the population stays balanced.' },
  { term: 'sludge', definition: 'The thick, mud-like layer of settled solids drawn from the bottom of a tank.', aliases: ['Sludge'] },
  { term: 'screenings', definition: 'The rags, wipes and debris raked off the bar screen — landfill-bound wet garbage.' },
  { term: 'grit', definition: 'Dense mineral grains — sand, gravel, coffee grounds — removed early so they don’t sandpaper the pumps.' },
  { term: 'clarifier', definition: 'A large, calm settling tank: gravity pulls particles down, clear water spills over the top.', aliases: ['Clarifier'] },
  { term: 'aeration', definition: 'Blowing air into a tank so the microbes can breathe — usually the plant’s biggest electricity bill.', aliases: ['Aeration'] },
  { term: 'nitrate-destroying', definition: 'Denitrification: microbes in an air-free zone breathe nitrate and release it to the sky as harmless nitrogen gas.', aliases: ['destroys nitrate'] },
  { term: 'biogas', definition: 'The burnable gas (mostly methane) produced when sludge rots in a sealed digester — usable as fuel.' },
  { term: 'permit', definition: 'The discharge permit — the legal contract listing the maximum concentration of each pollutant the plant may release to the river.', aliases: ['Permit'] },
  { term: 'effluent', definition: 'The treated water flowing OUT of the plant into the river.', aliases: ['treated water'] },
  { term: 'influent', definition: 'The dirty water flowing INTO the plant — the town’s raw sewage.', aliases: ['dirty water'] },
  { term: 'log', definition: 'Log reduction — germ-killing shorthand: 1-log kills 90% of germs, 2-log 99%, 3-log 99.9%.', aliases: ['-log'] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGlossary(plainSoFar) {
  let text = '';
  try {
    text = JSON.stringify(plainSoFar) || '';
  } catch {
    return [];
  }
  const out = [];
  for (const entry of GLOSSARY) {
    const candidates = [entry.term, ...(entry.aliases || [])];
    const found = candidates.some((t) => {
      try {
        // \b doesn't work next to non-word chars like ³ or / — fall back to includes.
        if (/^[A-Za-z0-9-]+$/.test(t)) return new RegExp(`\\b${escapeRegExp(t)}\\b`).test(text);
        return text.includes(t);
      } catch {
        return false;
      }
    });
    if (found) out.push({ term: entry.term, definition: entry.definition });
  }
  return out;
}

// ── Main entry point ──────────────────────────────────────────────────────────

const EMPTY_VERDICT = {
  status: 'unknown',
  headline: 'This run did not produce a clear pass-or-fail verdict against a discharge permit.',
  detail: 'No permit check was recorded for this run, so there is nothing to grade the water against.',
};

/**
 * @param {object} report — output of buildReportData (may be partial/old/dynamic)
 * @returns {{verdict: object, waterStory: Array, qualityRows: Array,
 *            complianceStory: Array, treatmentSteps: Array,
 *            costStory: {lines: Array}, glossary: Array}}
 */
/**
 * @param {object} report  the report JSON built by reportData.js
 * @param {object} [canvas] flowsheet canvas_data (nodes/edges) — optional;
 *                          supplies flow order and node names for the steps
 */
function buildPlainSummary(report, canvas) {
  const plain = {
    verdict:         { ...EMPTY_VERDICT },
    waterStory:      [],
    qualityRows:     [],
    complianceStory: [],
    treatmentSteps:  [],
    costStory:       { lines: [] },
    glossary:        [],
  };

  let summary = {}, unitResults = {}, fromDynamicStep = false, results = {};
  try {
    results = (report && report.results) || {};
    const eff = effectiveResults(report);
    summary = eff.summary || {};
    unitResults = eff.unitResults || {};
    fromDynamicStep = eff.fromDynamicStep;
  } catch { /* keep empty defaults */ }

  try { plain.verdict = buildVerdict(summary, results.permitLimitsUsed, fromDynamicStep); } catch { /* keep default */ }
  try { plain.waterStory = buildWaterStory(summary); } catch { plain.waterStory = []; }
  try { plain.qualityRows = buildQualityRows(summary); } catch { plain.qualityRows = []; }
  try { plain.complianceStory = buildComplianceStory(summary); } catch { plain.complianceStory = []; }
  try { plain.treatmentSteps = buildTreatmentSteps(unitResults, canvas); } catch { plain.treatmentSteps = []; }
  try { plain.costStory = buildCostStory(results.costBreakdown); } catch { plain.costStory = { lines: [] }; }
  try {
    plain.glossary = buildGlossary({
      verdict: plain.verdict, waterStory: plain.waterStory, qualityRows: plain.qualityRows,
      complianceStory: plain.complianceStory, treatmentSteps: plain.treatmentSteps,
      costStory: plain.costStory,
    });
  } catch { plain.glossary = []; }

  return plain;
}

module.exports = { buildPlainSummary };
