/**
 * SafeKrit — ISA-5.1 tag conformance  (Session 18)
 *
 * The plant is tagged to ISA-5.1 and nothing else. That is a requirement, not a
 * style preference, so it is enforced here against the standard's own letter
 * tables rather than asserted in a comment.
 *
 * What the standard governs, and what this test checks:
 *
 *   INSTRUMENT TAGS  `<area>-<function letters>-<loop>`
 *     First letter  = the measured / initiating variable (Table 1, col. 1)
 *     Later letters = readout / passive / output functions (Table 1, cols 3–4)
 *     A tag like AV or BV is therefore NOT "air valve" or "ball valve" — an ISA
 *     reader parses it as Analysis Valve / Burner Valve. Body type is not a
 *     function letter; every actuated on/off valve is XV.
 *
 *   EQUIPMENT TAGS   `<area>-<single letter>-<number>`
 *     Pumps, blowers and drives are outside ISA-5.1's scope. A single letter
 *     can never be mistaken for a loop tag, because a loop tag always carries
 *     at least two letters — so the two families stay visually distinct.
 *
 *   SIGNAL SUFFIXES  the function letters of each wired point
 *     ZSO / ZSC  position switch, open / closed (O and C are ISA modifiers)
 *     XY         relay / solenoid output — NOT XC (controller) or XR (recorder)
 *     XS / XA    status switch / trip alarm
 *     LT / FT / AT / LSH   transmitters and the high-level switch
 *     Two relays in one loop take suffix letters A and B (ISA-5.1 §5.3).
 *
 * The first-letter and succeeding-letter sets below are ISA-5.1-2009 Table 1.
 * User's-choice letters (C, D, G, M, N, O as first letters) are deliberately
 * EXCLUDED: allowing them would let any two letters pass.
 */

'use strict';

const { PROCESSES } = require('../plants/itcStp/processes');
const io = require('../plants/itcStp/ioSchedule');
const { NODES } = require('../plants/itcStp/flowsheet');
const { SECTIONS } = require('../plants/itcStp/narrative');

// The letter tables and the grammar live in ONE place — backend/src/tags/isa.js
// — shared with the tag-registry API, so what this suite forbids the API also
// refuses. The set-shaped EQUIPMENT below is the same classes as the module's
// map, in the form the assertions read.
const {
  EQUIPMENT: EQUIPMENT_CLASSES,
  FORBIDDEN_FUNCTIONS,
  DEVICE_TAG,
  SIGNAL_TAG,
  isIsaFunction,
  validateDeviceTag,
  validateSignalTag,
} = require('../tags/isa');

const EQUIPMENT = new Set(Object.keys(EQUIPMENT_CLASSES));

// ── The validator itself ─────────────────────────────────────────────────────

describe('ISA-5.1 validator (tags/isa.js)', () => {
  it.each([
    ['LT', true], ['FT', true], ['AT', true], ['XV', true], ['ZSO', true], ['ZSC', true],
    ['LSH', true], ['XY', true], ['XS', true], ['XA', true], ['PIC', true], ['TIC', true],
    ['P', false],        // one letter is equipment, not a function
    ['CV', false],       // C is user's choice as a first letter — excluded on purpose
    ['LZ', true],        // level + final control element is legal, if unusual
    ['1T', false], ['', false], ['ft', false],
  ])('isIsaFunction(%s) → %s', (letters, ok) => {
    expect(isIsaFunction(letters)).toBe(ok);
  });

  it('accepts a well-formed instrument tag and an equipment tag', () => {
    expect(validateDeviceTag('RFP-FT-201')).toMatchObject({ ok: true, parsed: { area: 'RFP', code: 'FT', loop: '201', family: 'instrument' } });
    expect(validateDeviceTag('RFP-P-201')).toMatchObject({ ok: true, parsed: { family: 'equipment' } });
  });

  it.each(Object.keys(FORBIDDEN_FUNCTIONS))('refuses %s with the reason', (code) => {
    const r = validateDeviceTag(`R-${code}-301`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(code);
  });

  it('refuses an unknown single-letter equipment class', () => {
    expect(validateDeviceTag('R-Q-301').ok).toBe(false);
  });

  it('refuses malformed shapes without throwing', () => {
    for (const bad of ['', 'RFP', 'RFP-FT', 'rfp-ft-201', 'RFP-FT-20', 'RFP FT 201', null, undefined, 42]) {
      expect(validateDeviceTag(bad).ok).toBe(false);
      expect(validateSignalTag(bad).ok).toBe(false);
    }
  });

  it('parses a full signal tag with unit and suffix', () => {
    const r = validateSignalTag('R-M-301/2.XY-B');
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ loopTag: 'R-M-301', unit: 2, fn: 'XY', suffix: 'B' });
    expect(r.parsed.device).toMatchObject({ area: 'R', code: 'M', family: 'equipment' });
  });

  it('refuses a signal whose function letters are a forbidden set', () => {
    expect(validateSignalTag('ELP-XV-101/1.XC').ok).toBe(false);
    expect(validateSignalTag('ELP-XV-101/1.XR').ok).toBe(false);
  });
});

const allDevices = PROCESSES.flatMap((p) => p.devices.map((d) => ({ ...d, area: p.area })));

// ── Device tags ──────────────────────────────────────────────────────────────

describe('ISA-5.1 device tags', () => {
  it('follow <area>-<code>-<loop> with a 3–4 digit loop number', () => {
    const bad = allDevices.filter((d) => !DEVICE_TAG.test(d.tag)).map((d) => d.tag);
    expect(bad).toEqual([]);
  });

  it('use only an ISA-5.1 function set or a single-letter equipment class', () => {
    const bad = [];
    for (const d of allDevices) {
      const code = DEVICE_TAG.exec(d.tag)[2];
      const ok = code.length === 1 ? EQUIPMENT.has(code) : isIsaFunction(code);
      if (!ok) bad.push(`${d.tag} (${code})`);
    }
    expect(bad).toEqual([]);
  });

  it.each(Object.entries(FORBIDDEN_FUNCTIONS))('never use %s — %s', (code) => {
    const hits = allDevices.filter((d) => DEVICE_TAG.exec(d.tag)[2] === code).map((d) => d.tag);
    expect(hits).toEqual([]);
  });

  it('put every actuated valve, whatever its body, under XV', () => {
    const valveKinds = new Set(['butterfly_valve', 'ball_valve', 'bypass_valve', 'air_valve']);
    const bad = allDevices
      .filter((d) => valveKinds.has(d.kind))
      .filter((d) => DEVICE_TAG.exec(d.tag)[2] !== 'XV')
      .map((d) => `${d.tag} (${d.kind})`);
    expect(bad).toEqual([]);
  });

  it('tag instruments with the letter for what they measure', () => {
    const expected = { level_tx: 'LT', level_switch: 'LSH', flow_meter: 'FT', ph_analyser: 'AT' };
    const bad = [];
    for (const d of allDevices) {
      const want = expected[d.kind];
      if (want && DEVICE_TAG.exec(d.tag)[2] !== want) bad.push(`${d.tag} should be ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it('tag rotating equipment with a single equipment letter, never a loop function', () => {
    const machine = { pump: 'P', dosing_pump: 'P', air_blower: 'B', decanter_vfd: 'M', agitator: 'M' };
    const bad = [];
    for (const d of allDevices) {
      const want = machine[d.kind];
      if (want && DEVICE_TAG.exec(d.tag)[2] !== want) bad.push(`${d.tag} should be ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it('never reuse a loop number within one area and function', () => {
    const seen = new Map();
    for (const d of allDevices) {
      const [, area, code, loop] = DEVICE_TAG.exec(d.tag);
      const key = `${area}-${code}-${loop}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });
});

// ── Signal tags ──────────────────────────────────────────────────────────────

describe('ISA-5.1 signal tags', () => {
  const rows = io.buildTagList();

  it('follow <device>[/unit].<function letters>[-suffix]', () => {
    const bad = rows.filter((r) => !SIGNAL_TAG.test(r.tag)).map((r) => r.tag);
    expect(bad).toEqual([]);
  });

  it('carry a valid ISA-5.1 function on every wired point', () => {
    const bad = [];
    for (const r of rows) {
      const letters = SIGNAL_TAG.exec(r.tag)[3];
      if (!isIsaFunction(letters)) bad.push(`${r.tag} (${letters})`);
    }
    expect(bad).toEqual([]);
  });

  it('use a relay (Y) for every discrete output — never a controller or recorder', () => {
    const outputs = rows.filter((r) => r.type === 'DO');
    expect(outputs.length).toBeGreaterThan(100);
    for (const r of outputs) {
      const letters = SIGNAL_TAG.exec(r.tag)[3];
      expect(letters).toBe('XY');
    }
  });

  it('use position-switch modifiers on every valve limit switch', () => {
    const limits = rows.filter((r) => /limit switch/i.test(r.signal));
    expect(limits.length).toBeGreaterThan(100);
    for (const r of limits) {
      const letters = SIGNAL_TAG.exec(r.tag)[3];
      expect(['ZSO', 'ZSC']).toContain(letters);
      expect(letters).toBe(/open/i.test(r.signal) ? 'ZSO' : 'ZSC');
    }
  });

  it('distinguish two relays in one loop with suffix letters, and use them nowhere else', () => {
    const suffixed = rows.filter((r) => SIGNAL_TAG.exec(r.tag)[4]);
    // Only the decanter drives carry two relays.
    for (const r of suffixed) expect(r.kind).toBe('decanter_vfd');
    const byUnit = new Map();
    for (const r of suffixed) {
      const key = r.tag.replace(/-[A-Z]$/, '');
      byUnit.set(key, (byUnit.get(key) || []).concat(SIGNAL_TAG.exec(r.tag)[4]));
    }
    for (const [, letters] of byUnit) expect(letters.sort()).toEqual(['A', 'B']);
  });

  it('let analogue inputs carry only a transmitter letter set', () => {
    const analog = rows.filter((r) => r.type === 'AI');
    for (const r of analog) {
      expect(['LT', 'FT', 'AT']).toContain(SIGNAL_TAG.exec(r.tag)[3]);
    }
  });

  it('are unique across the whole plant', () => {
    expect(new Set(rows.map((r) => r.tag)).size).toBe(rows.length);
  });
});

// ── Everything that CITES a tag cites one that exists ────────────────────────

describe('Tag references resolve', () => {
  const known = new Set(allDevices.map((d) => d.tag));

  it('from every flowsheet node', () => {
    const bad = NODES.flatMap((n) => n.data.tags || []).filter((t) => !known.has(t));
    expect(bad).toEqual([]);
  });

  it('from every control-narrative step', () => {
    const bad = SECTIONS.flatMap((s) => s.steps.flatMap((st) => st.devices || [])).filter((t) => !known.has(t));
    expect(bad).toEqual([]);
  });

  it('from every instrument node parameter', () => {
    const bad = NODES
      .filter((n) => n.data.params && n.data.params.tag)
      .map((n) => n.data.params.tag)
      .filter((t) => !known.has(t));
    expect(bad).toEqual([]);
  });
});
