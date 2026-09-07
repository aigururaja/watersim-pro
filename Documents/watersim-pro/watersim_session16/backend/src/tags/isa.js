/**
 * WaterSim Pro — ISA-5.1 tag grammar and validation.
 *
 * The plant is tagged to ISA-5.1 and nothing else. This module is the single
 * definition of what that means, shared by the tag registry API (which refuses
 * a non-conforming tag at POST time) and by `isaTags.test.js` (which holds the
 * seeded ITC schedule to the same rule). A rule that lived only in a test would
 * let the API accept what the test forbids.
 *
 * ── WHAT ISA-5.1 GOVERNS ─────────────────────────────────────────────────────
 *   Instrument tags   <area>-<function letters>-<loop>      e.g. RFP-FT-201
 *     first letter    the measured / initiating variable    (Table 1, col. 1)
 *     later letters   readout / passive / output functions  (Table 1, cols 3–4)
 *   Equipment tags    <area>-<single letter>-<number>        e.g. RFP-P-201
 *     Pumps, blowers and drives are outside the standard's scope. A single
 *     letter can never be mistaken for a loop tag, which always carries two
 *     or more — so the two families stay visually distinct.
 *   Signal tags       <device>[/unit].<function letters>[-suffix]
 *     One per wired point. Two relays in one loop take suffix letters A and B.
 *
 * The letter sets are ISA-5.1-2009 Table 1. User's-choice first letters
 * (C, D, G, M, N, O) are deliberately EXCLUDED: allowing them would let any two
 * letters pass, which is exactly what a validator must not do.
 */
'use strict';

/** Column 1 — measured or initiating variable. */
const FIRST = Object.freeze(new Set([
  'A', // analysis
  'B', // burner, combustion
  'E', // voltage
  'F', // flow
  'H', // hand
  'I', // current
  'J', // power
  'K', // time
  'L', // level
  'P', // pressure
  'Q', // quantity
  'R', // radiation
  'S', // speed, frequency
  'T', // temperature
  'U', // multivariable
  'V', // vibration
  'W', // weight, force
  'X', // unclassified
  'Y', // event, state, presence
  'Z', // position, dimension
]));

/** Columns 3–4 — readout / passive and output / active functions. */
const SUCCEEDING = Object.freeze(new Set([
  'A', // alarm
  'C', // control
  'E', // sensor, primary element
  'G', // glass, gauge
  'H', // high
  'I', // indicate
  'K', // control station
  'L', // low, light
  'M', // middle
  'O', // orifice — and the OPEN modifier on position switches
  'P', // point, test connection
  'Q', // integrate, totalise
  'R', // record
  'S', // switch
  'T', // transmit
  'U', // multifunction
  'V', // valve, damper
  'W', // well
  'X', // unclassified
  'Y', // relay, compute, convert
  'Z', // driver, actuator, final control element
]));

/** Modifier letters valid after an S (switch): open, closed, high, low. */
const SWITCH_MODIFIERS = Object.freeze(new Set(['O', 'C', 'H', 'L']));

/** Single-letter equipment classes in use. Site-defined, outside ISA-5.1. */
const EQUIPMENT = Object.freeze({
  P: 'pump',
  B: 'blower',
  M: 'motor drive',
});

/** Function-letter sets that would MISLEAD an ISA reader, however intended. */
const FORBIDDEN_FUNCTIONS = Object.freeze({
  AV: 'reads as Analysis Valve — an air valve is XV',
  BV: 'reads as Burner Valve — a ball valve is XV',
  XC: 'C is CONTROLLER — a discrete output is a relay, XY',
  XR: 'R is RECORDER — a discrete output is a relay, XY',
  DEC: 'three letters parse as D-E-C function letters — a drive is equipment, M',
});

const DEVICE_TAG = /^([A-Z]{1,6})-([A-Z]{1,4})-(\d{3,4})$/;
const SIGNAL_TAG = /^([A-Z]{1,6}-[A-Z]{1,4}-\d{3,4})(?:\/(\d{1,2}))?\.([A-Z]{2,4})(?:-([A-Z]))?$/;

/** Is `letters` a valid ISA-5.1 function identification (two or more letters)? */
function isIsaFunction(letters) {
  if (typeof letters !== 'string' || letters.length < 2) return false;
  if (!FIRST.has(letters[0])) return false;
  for (let i = 1; i < letters.length; i += 1) {
    const l = letters[i];
    if (letters[i - 1] === 'S' && SWITCH_MODIFIERS.has(l)) continue;
    if (!SUCCEEDING.has(l)) return false;
  }
  return true;
}

/**
 * Parse a device (loop or equipment) tag.
 * @returns {{area, code, loop, family:'instrument'|'equipment'}|null}
 */
function parseDeviceTag(tag) {
  const m = DEVICE_TAG.exec(String(tag || ''));
  if (!m) return null;
  const [, area, code, loop] = m;
  return { area, code, loop, family: code.length === 1 ? 'equipment' : 'instrument' };
}

/**
 * Parse a signal tag.
 * @returns {{loopTag, unit:number|null, fn, suffix:string|null}|null}
 */
function parseSignalTag(tag) {
  const m = SIGNAL_TAG.exec(String(tag || ''));
  if (!m) return null;
  const [, loopTag, unit, fn, suffix] = m;
  return { loopTag, unit: unit == null ? null : Number(unit), fn, suffix: suffix || null };
}

/**
 * Validate a device tag against the grammar and the letter tables.
 * @returns {{ok:true, parsed:object}|{ok:false, reason:string}}
 */
function validateDeviceTag(tag) {
  const parsed = parseDeviceTag(tag);
  if (!parsed) {
    return { ok: false, reason: 'expected <AREA>-<CODE>-<LOOP>, e.g. RFP-FT-201 or RFP-P-201' };
  }
  if (FORBIDDEN_FUNCTIONS[parsed.code]) {
    return { ok: false, reason: `${parsed.code}: ${FORBIDDEN_FUNCTIONS[parsed.code]}` };
  }
  if (parsed.family === 'equipment') {
    if (!EQUIPMENT[parsed.code]) {
      return { ok: false, reason: `${parsed.code} is not a known equipment class (${Object.keys(EQUIPMENT).join(', ')})` };
    }
    return { ok: true, parsed };
  }
  if (!isIsaFunction(parsed.code)) {
    return { ok: false, reason: `${parsed.code} is not a valid ISA-5.1 function identification` };
  }
  return { ok: true, parsed };
}

/**
 * Validate a full signal tag: the device part, then the function letters.
 * @returns {{ok:true, parsed:object}|{ok:false, reason:string}}
 */
function validateSignalTag(tag) {
  const parsed = parseSignalTag(tag);
  if (!parsed) {
    return { ok: false, reason: 'expected <DEVICE>[/unit].<FN>[-A|B], e.g. RFP-P-201/1.XS' };
  }
  const device = validateDeviceTag(parsed.loopTag);
  if (!device.ok) return device;
  if (FORBIDDEN_FUNCTIONS[parsed.fn]) {
    return { ok: false, reason: `${parsed.fn}: ${FORBIDDEN_FUNCTIONS[parsed.fn]}` };
  }
  if (!isIsaFunction(parsed.fn)) {
    return { ok: false, reason: `${parsed.fn} is not a valid ISA-5.1 function identification` };
  }
  return { ok: true, parsed: { ...parsed, device: device.parsed } };
}

module.exports = {
  FIRST,
  SUCCEEDING,
  SWITCH_MODIFIERS,
  EQUIPMENT,
  FORBIDDEN_FUNCTIONS,
  DEVICE_TAG,
  SIGNAL_TAG,
  isIsaFunction,
  parseDeviceTag,
  parseSignalTag,
  validateDeviceTag,
  validateSignalTag,
};
