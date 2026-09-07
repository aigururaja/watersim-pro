/**
 * MimicSymbols — equipment drawn as MACHINERY, for the schematic view and the
 * realistic canvas.
 *
 * Each symbol is SVG placed in a 168 × 116 cell (the canvas node cell), water
 * entering at the left centre (0, 58) and leaving at the right centre
 * (168, 58). Everything is shaded with the gradients in <MimicDefs/>: pipes
 * are cylinders with bolted flanges and elbows, a pump is a volute casing on a
 * baseplate with a coupling guard and a finned motor, a valve has a bonnet,
 * stem and handwheel, a filter is a domed pressure vessel on legs with a media
 * window and a gauge, a tank is a rimmed cylinder with a level scale.
 *
 * Every moving part is tied to a MEASURED (or, on the canvas, controlled)
 * state passed in `s`:
 *   running  → impeller and motor fan spin, the run LED pulses, the casing is
 *              green; false parks everything and greys the casing
 *   tripped  → red ring on the casing, red LED
 *   opened / closed → the handwheel turns, the gate rises or drops, the body
 *              band is green or red
 *   level    → the water line in a tank (only when a level is known)
 *   reading  → an instrument's dial needle or LCD value
 */
import { memo, useId } from 'react';
import { NODE_W, NODE_H, polyline } from './mimicLayout';

export const G = {
  green: '#2f9a4a', greenDeep: '#1d6f34', greenLight: '#6fd08b',
  grey: '#9aa3ab', greyDeep: '#5c6670', greyLight: '#e6eaee',
  steel: '#b9c2c9', steelDeep: '#6f7a84', steelLight: '#f2f5f7',
  water: '#4aa9d3', waterDeep: '#2c86b3', waterLight: '#bfe6f6',
  red: '#d9534f', redDeep: '#8f2b27', amber: '#e0a020', ink: '#243342',
};

const STEEL = ['#4d5861', '#aab3bb', '#e9edf0', '#f8fafb', '#d9dfe4', '#8e98a1', '#4a545d'];
const STEEL_AT = [0, .18, .38, .5, .62, .85, 1];
const stops = (colours, at) => colours.map((c, i) => <stop key={i} offset={at[i]} stopColor={c} />);

export function MimicDefs() {
  return (
    <defs>
      {/* Cylinders: a horizontal tube is shaded top→bottom, a vertical one left→right. */}
      <linearGradient id="mm-pipe" x1="0" y1="0" x2="0" y2="1">{stops(STEEL, STEEL_AT)}</linearGradient>
      <linearGradient id="mm-pipe-v" x1="0" y1="0" x2="1" y2="0">{stops(STEEL, STEEL_AT)}</linearGradient>
      <linearGradient id="mm-flange" x1="0" y1="0" x2="0" y2="1">{stops(['#38424b', '#8e98a1', '#d5dbe0', '#8e98a1', '#2f3941'], [0, .3, .5, .7, 1])}</linearGradient>
      <linearGradient id="mm-flange-v" x1="0" y1="0" x2="1" y2="0">{stops(['#38424b', '#8e98a1', '#d5dbe0', '#8e98a1', '#2f3941'], [0, .3, .5, .7, 1])}</linearGradient>
      <radialGradient id="mm-elbow" cx=".35" cy=".3" r=".8">{stops(['#f4f7f9', '#b9c2c9', '#4d5861'], [0, .5, 1])}</radialGradient>
      <radialGradient id="mm-bolt" cx=".35" cy=".35" r=".8">{stops(['#f5f7f9', '#9aa3ab', '#3f4a54'], [0, .6, 1])}</radialGradient>
      {/* Painted castings. */}
      <linearGradient id="mm-green" x1="0" y1="0" x2="0" y2="1">{stops(['#a9e6b8', '#5fc57a', '#2e9a4a', '#1e6f34', '#144d24'], [0, .2, .5, .8, 1])}</linearGradient>
      <linearGradient id="mm-green-v" x1="0" y1="0" x2="1" y2="0">{stops(['#144d24', '#2e9a4a', '#7fd598', '#2e9a4a', '#1d6f34'], [0, .3, .5, .7, 1])}</linearGradient>
      <linearGradient id="mm-grey" x1="0" y1="0" x2="0" y2="1">{stops(['#dfe4e8', '#b8c0c7', '#969fa7', '#6b747d', '#4b535b'], [0, .2, .5, .8, 1])}</linearGradient>
      <linearGradient id="mm-grey-v" x1="0" y1="0" x2="1" y2="0">{stops(['#4b535b', '#969fa7', '#dfe4e8', '#969fa7', '#5c6670'], [0, .3, .5, .7, 1])}</linearGradient>
      <linearGradient id="mm-red" x1="0" y1="0" x2="0" y2="1">{stops(['#f2a19a', '#d9534f', '#8f2b27'], [0, .5, 1])}</linearGradient>
      <linearGradient id="mm-dark" x1="0" y1="0" x2="0" y2="1">{stops(['#5c6670', '#333c45', '#1c242b'], [0, .5, 1])}</linearGradient>
      <linearGradient id="mm-concrete" x1="0" y1="0" x2="0" y2="1">{stops(['#dde2e6', '#c3cad0', '#a5adb4'], [0, .5, 1])}</linearGradient>
      {/* Vessels and glass. */}
      <linearGradient id="mm-vessel" x1="0" y1="0" x2="1" y2="0">{stops(['#a6b0b8', '#f0f3f5', '#ffffff', '#d5dbe0', '#7e8890'], [0, .2, .45, .8, 1])}</linearGradient>
      <linearGradient id="mm-tank" x1="0" y1="0" x2="0" y2="1">{stops(['#8ed0ee', '#4aa9d3', '#2c86b3', '#1f6b93'], [0, .3, .7, 1])}</linearGradient>
      <linearGradient id="mm-glass" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#ffffff" stopOpacity=".55" /><stop offset=".35" stopColor="#ffffff" stopOpacity=".05" /><stop offset=".8" stopColor="#000000" stopOpacity=".06" /><stop offset="1" stopColor="#000000" stopOpacity=".2" />
      </linearGradient>
      <linearGradient id="mm-chem" x1="0" y1="0" x2="0" y2="1">{stops(['#f3a6c8', '#d6578f', '#9c2f62'], [0, .5, 1])}</linearGradient>
      {/* Pump volute, dials, wheels. */}
      <radialGradient id="mm-volute" cx=".38" cy=".32" r=".8">{stops(['#b6efc6', '#4fbf6c', '#1f7a3a', '#0f3f1e'], [0, .35, .75, 1])}</radialGradient>
      <radialGradient id="mm-volute-off" cx=".38" cy=".32" r=".8">{stops(['#eef1f3', '#b3bcc3', '#6b747d', '#39424a'], [0, .35, .75, 1])}</radialGradient>
      <radialGradient id="mm-dial" cx=".5" cy=".42" r=".65">{stops(['#ffffff', '#f4f6f8', '#d5dbe0'], [0, .7, 1])}</radialGradient>
      <radialGradient id="mm-chrome" cx=".3" cy=".25" r=".9">{stops(['#ffffff', '#c9d1d8', '#6f7a84', '#dfe5ea', '#4d5861'], [0, .3, .6, .8, 1])}</radialGradient>
      <radialGradient id="mm-wheel" cx=".4" cy=".35" r=".8">{stops(['#f39a92', '#c0392b', '#7d1f16'], [0, .55, 1])}</radialGradient>
      <linearGradient id="mm-lcd" x1="0" y1="0" x2="0" y2="1">{stops(['#dcf6cf', '#bfe9a9', '#a3d88f'], [0, .5, 1])}</linearGradient>
      <linearGradient id="mm-housing" x1="0" y1="0" x2="0" y2="1">{stops(['#5a6a7a', '#33414f', '#1d2731'], [0, .5, 1])}</linearGradient>
      {/* Textures. */}
      <pattern id="mm-ripple" width="48" height="12" patternUnits="userSpaceOnUse">
        <path d="M0 6 Q 12 0 24 6 T 48 6" fill="none" stroke="#ffffff" strokeOpacity=".35" strokeWidth="1.5" />
      </pattern>
      <pattern id="mm-fins" width="6" height="6" patternUnits="userSpaceOnUse">
        <line x1="3" y1="0" x2="3" y2="6" stroke="#06140a" strokeOpacity=".3" strokeWidth="1.6" />
      </pattern>
      <pattern id="mm-grille" width="6" height="4" patternUnits="userSpaceOnUse">
        <line x1="0" y1="2" x2="6" y2="2" stroke="#1c242b" strokeOpacity=".55" strokeWidth="1.2" />
      </pattern>
      <pattern id="mm-sand" width="5" height="5" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" fill="#d9c58a" /><circle cx="1.5" cy="1.5" r=".9" fill="#b39a55" /><circle cx="3.8" cy="3.6" r=".7" fill="#e8d9a6" />
      </pattern>
      <pattern id="mm-carbon" width="5" height="5" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" fill="#2b2f33" /><circle cx="1.6" cy="1.4" r="1" fill="#4b5157" /><circle cx="3.9" cy="3.7" r=".8" fill="#14171a" />
      </pattern>
      <pattern id="mm-gravel" width="7" height="6" patternUnits="userSpaceOnUse">
        <rect width="7" height="6" fill="#8d979f" /><ellipse cx="2" cy="2" rx="1.6" ry="1.1" fill="#b9c2c9" /><ellipse cx="5.2" cy="4.2" rx="1.4" ry="1" fill="#6b747d" />
      </pattern>
      <filter id="mm-shadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#1a2633" floodOpacity=".28" />
      </filter>
      <filter id="mm-soft" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#1a2633" floodOpacity=".22" />
      </filter>
    </defs>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Primitives — the pipework every symbol and every line is built from
// ═══════════════════════════════════════════════════════════════════════════

export const PIPE_R = 6.5;
const fmt = (v, dp = 1) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : dp }));

/** A straight length of pipe: a cylinder, shaded across its axis. */
export function Tube({ x, y, w, h, vertical = false }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={vertical ? 'url(#mm-pipe-v)' : 'url(#mm-pipe)'} />
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="#2f3941" strokeOpacity=".7" strokeWidth=".8" />
    </g>
  );
}

/** A bolt head. */
export function Bolt({ cx, cy, r = 1.7 }) {
  return <circle cx={cx} cy={cy} r={r} fill="url(#mm-bolt)" stroke="#2f3941" strokeWidth=".5" />;
}

/** A bolted flange: a thick ring across a pipe. `vertical` = the PIPE is vertical (the band lies flat). */
export function Flange({ x, y, vertical = false, size = 26, thick = 7 }) {
  const w = vertical ? size : thick, h = vertical ? thick : size;
  const bolts = vertical
    ? [[x - size / 2 + 3.5, y], [x + size / 2 - 3.5, y]]
    : [[x, y - size / 2 + 3.5], [x, y + size / 2 - 3.5]];
  return (
    <g className="mimic-flange">
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx="1.5" fill={vertical ? 'url(#mm-flange-v)' : 'url(#mm-flange)'} stroke="#2f3941" strokeWidth=".7" />
      {bolts.map(([bx, by], i) => <Bolt key={i} cx={bx} cy={by} />)}
    </g>
  );
}

/** A run of pipe along an orthogonal route: shadow, dark edge, a cylinder per leg, an elbow at each bend. */
export function PipeBody({ route, r = PIPE_R }) {
  const pts = route.points;
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const extA = i > 1 ? r : 0, extB = i < pts.length - 1 ? r : 0;
    if (vertical) {
      const down = a.y < b.y;
      const y0 = Math.min(a.y, b.y) - (down ? extA : extB), y1 = Math.max(a.y, b.y) + (down ? extB : extA);
      legs.push(<rect key={i} x={a.x - r} y={y0} width={2 * r} height={Math.max(0, y1 - y0)} fill="url(#mm-pipe-v)" />);
    } else {
      const right = a.x < b.x;
      const x0 = Math.min(a.x, b.x) - (right ? extA : extB), x1 = Math.max(a.x, b.x) + (right ? extB : extA);
      legs.push(<rect key={i} x={x0} y={a.y - r} width={Math.max(0, x1 - x0)} height={2 * r} fill="url(#mm-pipe)" />);
    }
  }
  return (
    <g className="mimic-pipe-body">
      <path d={route.d} fill="none" stroke="#0b141c" strokeOpacity=".2" strokeWidth={2 * r + 1} strokeLinejoin="round" transform="translate(0 3)" />
      <path d={route.d} fill="none" stroke="#2f3941" strokeWidth={2 * r + 1.4} strokeLinejoin="round" />
      {legs}
      {route.corners.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={r + 1.2} fill="url(#mm-elbow)" stroke="#2f3941" strokeWidth=".7" />)}
    </g>
  );
}

/** Bolted flanges either side of every bend. */
export function PipeJoints({ route, inset = 10 }) {
  const pts = route.points;
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], p = pts[i - 1], n = pts[i + 1];
    const inV = Math.abs(c.x - p.x) < 0.5, outV = Math.abs(n.x - c.x) < 0.5;
    const di = { x: Math.sign(c.x - p.x), y: Math.sign(c.y - p.y) };
    const dn = { x: Math.sign(n.x - c.x), y: Math.sign(n.y - c.y) };
    if (Math.hypot(c.x - p.x, c.y - p.y) >= inset * 1.6) out.push(<Flange key={`${i}a`} x={c.x - di.x * inset} y={c.y - di.y * inset} vertical={inV} />);
    if (Math.hypot(n.x - c.x, n.y - c.y) >= inset * 1.6) out.push(<Flange key={`${i}b`} x={c.x + dn.x * inset} y={c.y + dn.y * inset} vertical={outV} />);
  }
  return <g className="mimic-pipe-joints">{out}</g>;
}

/**
 * The water inside a pipe: a tint of the service colour, and when `moving`,
 * lighter slugs travelling along it, a glint and bubbles. Drawn between
 * PipeBody and PipeJoints.
 */
export function PipeWater({ d, style, moving = false, width = 8 }) {
  return (
    <g className="mimic-pipe-water">
      <path d={d} fill="none" stroke={style.color} strokeWidth={width} strokeLinejoin="round" strokeOpacity={moving ? .55 : .5} />
      {moving && <path className="mimic-flow" d={d} fill="none" stroke={style.light} strokeWidth={width - 2} strokeLinejoin="round" strokeOpacity=".9" />}
      {moving && <path className="mimic-glint" d={d} fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" strokeOpacity=".85" />}
      {moving && style.kind !== 'sludge' && <path className="mimic-bubbles" d={d} fill="none" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" strokeOpacity=".8" />}
    </g>
  );
}

/** A run/trip LED. */
function Led({ cx, cy, on, tripped }) {
  const fill = tripped ? '#ff4d4d' : on ? '#3ddc72' : '#6b747d';
  return (
    <g>
      <circle cx={cx} cy={cy} r="3.4" fill={fill} stroke="#1a222a" strokeWidth=".7" className={tripped ? 'mimic-throb' : on ? 'mimic-led' : undefined} />
      <circle cx={cx - 1} cy={cy - 1} r="1.1" fill="#ffffff" fillOpacity=".75" />
    </g>
  );
}

const WATER = { color: '#4aa9d3', light: '#a6dcf2', kind: 'water' };
const Y = NODE_H / 2;

// ═══════════════════════════════════════════════════════════════════════════
// Pump: end-suction volute on a baseplate, coupling guard, finned motor,
// fan cover, discharge riser and header over the motor to the outlet
// ═══════════════════════════════════════════════════════════════════════════
const DISCHARGE = polyline([{ x: 52, y: 36 }, { x: 52, y: 22 }, { x: 158, y: 22 }, { x: 158, y: Y }, { x: NODE_W, y: Y }], 8);

export function PumpSymbol({ s = {}, label }) {
  const on = s.running === true;
  const tripped = s.tripped === true;
  const casing = on ? 'url(#mm-volute)' : 'url(#mm-volute-off)';
  const body = on ? 'url(#mm-green)' : 'url(#mm-grey)';
  return (
    <g filter="url(#mm-soft)" data-running={on ? 'true' : 'false'}>
      {/* suction */}
      <Tube x={0} y={Y - PIPE_R} w={30} h={2 * PIPE_R} />
      <Flange x={27} y={Y} />
      {/* discharge riser and header */}
      <PipeBody route={DISCHARGE} />
      {on && <PipeWater d={DISCHARGE.d} style={WATER} moving />}
      <PipeJoints route={DISCHARGE} />
      <Flange x={52} y={38} vertical />
      {/* baseplate and feet */}
      <rect x="34" y="84" width="124" height="7" rx="1.5" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".6" />
      <rect x="46" y="76" width="12" height="8" fill="url(#mm-grey-v)" /><rect x="120" y="76" width="12" height="8" fill="url(#mm-grey-v)" />
      <Bolt cx={40} cy={87.5} /><Bolt cx={152} cy={87.5} />
      {/* motor: a cylinder with cooling fins, a terminal box and the fan cover */}
      <rect x="80" y="38" width="62" height="40" rx="9" fill={body} stroke="#0f2a17" strokeOpacity=".6" strokeWidth=".8" />
      <rect x="84" y="40" width="54" height="36" rx="7" fill="url(#mm-fins)" />
      <rect x="86" y="43" width="50" height="6" rx="3" fill="#ffffff" fillOpacity=".28" />
      <rect x="100" y="28" width="24" height="12" rx="2" fill={body} stroke="#0f2a17" strokeOpacity=".6" strokeWidth=".7" />
      <Led cx={112} cy={34} on={on} tripped={tripped} />
      <rect x="140" y="43" width="12" height="30" rx="4" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".6" />
      <rect x="141" y="45" width="10" height="26" rx="3" fill="url(#mm-grille)" />
      <g className={on ? 'mimic-fan' : undefined} style={{ '--spin': '0.5s' }}>
        {[0, 90].map((a) => <rect key={a} x="145" y="50" width="2" height="16" rx="1" fill="#d5dbe0" fillOpacity=".8" transform={`rotate(${a} 146 58)`} />)}
      </g>
      {/* coupling guard */}
      <rect x="72" y="47" width="10" height="22" rx="2" fill="url(#mm-dark)" stroke="#111820" strokeWidth=".6" />
      {[51, 56, 61, 66].map((y) => <line key={y} x1="74" y1={y} x2="80" y2={y} stroke="#8e98a1" strokeWidth=".8" />)}
      {/* discharge nozzle, then the volute in front */}
      <rect x="45" y="30" width="14" height="12" fill={body} stroke="#0f2a17" strokeOpacity=".6" strokeWidth=".7" />
      <circle cx="52" cy={Y} r="24" fill={casing} stroke={tripped ? G.red : '#0f3a1c'} strokeOpacity={tripped ? 1 : .7} strokeWidth={tripped ? 3 : 1.1} className={tripped ? 'mimic-throb' : undefined} />
      <circle cx="52" cy={Y} r="24" fill="none" stroke="#ffffff" strokeOpacity=".25" strokeWidth="1" />
      <ellipse cx="44" cy="46" rx="9" ry="5" fill="#ffffff" fillOpacity=".22" transform="rotate(-30 44 46)" />
      {/* cut-away: the impeller */}
      <circle cx="52" cy={Y} r="14" fill="#08150c" fillOpacity=".62" stroke="#ffffff" strokeOpacity=".25" strokeWidth=".8" />
      <g className={on ? 'mimic-spin' : undefined} style={{ '--spin': '0.7s' }}>
        {[0, 72, 144, 216, 288].map((a) => <path key={a} d="M52 58 Q 60 50 65 58 Q 60 63 52 58" fill="#cfe8d5" fillOpacity=".92" transform={`rotate(${a} 52 58)`} />)}
        <circle cx="52" cy={Y} r="3.2" fill="#e6eaee" stroke="#5c6670" strokeWidth=".6" />
      </g>
      {[0, 60, 120, 180, 240, 300].map((a) => <Bolt key={a} cx={52 + 19.5 * Math.cos((a * Math.PI) / 180)} cy={Y + 19.5 * Math.sin((a * Math.PI) / 180)} r={1.4} />)}
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Blower: intake silencer, motor, side-channel housing with the fan behind
// its grille, air header out
// ═══════════════════════════════════════════════════════════════════════════
export function BlowerSymbol({ s = {}, label }) {
  const on = s.running === true;
  const tripped = s.tripped === true;
  const body = on ? 'url(#mm-green)' : 'url(#mm-grey)';
  return (
    <g filter="url(#mm-soft)" data-running={on ? 'true' : 'false'}>
      {/* intake silencer */}
      <rect x="2" y="44" width="16" height="28" rx="3" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".6" />
      <rect x="4" y="47" width="12" height="22" fill="url(#mm-grille)" />
      {/* motor */}
      <rect x="18" y="40" width="34" height="36" rx="8" fill={body} stroke="#0f2a17" strokeOpacity=".6" strokeWidth=".8" />
      <rect x="21" y="42" width="28" height="32" rx="6" fill="url(#mm-fins)" />
      <rect x="22" y="45" width="26" height="5" rx="2.5" fill="#ffffff" fillOpacity=".28" />
      <Led cx={35} cy={35} on={on} tripped={tripped} />
      {/* housing */}
      <rect x="52" y="30" width="84" height="58" rx="12" fill="url(#mm-vessel)" stroke="#6b747d" strokeWidth="1" />
      <rect x="58" y="34" width="72" height="5" rx="2.5" fill="#ffffff" fillOpacity=".5" />
      <circle cx="94" cy="59" r="24" fill="#1c242b" stroke={tripped ? G.red : '#4b535b'} strokeWidth={tripped ? 3 : 2} className={tripped ? 'mimic-throb' : undefined} />
      <g className={on ? 'mimic-fan' : undefined} style={{ '--spin': '0.9s' }}>
        {[0, 60, 120, 180, 240, 300].map((a) => <path key={a} d="M94 59 C 100 46, 112 46, 112 56 C 112 64, 100 66, 94 59 Z" fill={on ? G.greenLight : G.grey} fillOpacity=".9" transform={`rotate(${a} 94 59)`} />)}
        <circle cx="94" cy="59" r="5" fill="#dfe5ea" stroke="#6b747d" strokeWidth=".7" />
      </g>
      {[0, 30, 60, 90, 120, 150].map((a) => <line key={a} x1="94" y1="36" x2="94" y2="82" stroke="#d5dbe0" strokeWidth="1.4" transform={`rotate(${a} 94 59)`} />)}
      <circle cx="94" cy="59" r="24" fill="none" stroke="#8d979f" strokeWidth="1.2" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <Bolt key={a} cx={94 + 28 * Math.cos((a * Math.PI) / 180)} cy={59 + 28 * Math.sin((a * Math.PI) / 180)} r={1.3} />)}
      {/* air header out */}
      <Tube x={136} y={Y - PIPE_R} w={NODE_W - 136} h={2 * PIPE_R} />
      <Flange x={139} y={Y} />
      <line x1="146" y1={Y} x2={NODE_W} y2={Y} stroke="#d6f1fa" strokeWidth="5" strokeDasharray="1 6" strokeLinecap="round" className={on ? 'mimic-bubbles' : undefined} opacity={on ? .95 : .3} />
      {/* feet */}
      <rect x="60" y="88" width="10" height="8" fill="url(#mm-grey-v)" /><rect x="118" y="88" width="10" height="8" fill="url(#mm-grey-v)" />
      <rect x="14" y="96" width="122" height="5" rx="1.5" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".5" />
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Valve: flanged gate valve — body, bonnet, rising stem, red handwheel; the
// gate visibly drops into the bore when shut, the body band says the state
// ═══════════════════════════════════════════════════════════════════════════
export function ValveSymbol({ s = {}, label }) {
  const open = s.opened === true || (s.opened == null && s.closed === false);
  const known = s.opened != null || s.closed != null;
  const band = !known ? 'url(#mm-grey)' : open ? 'url(#mm-green)' : 'url(#mm-red)';
  return (
    <g filter="url(#mm-soft)" data-open={known ? String(open) : 'unknown'}>
      <Tube x={0} y={Y - PIPE_R} w={62} h={2 * PIPE_R} />
      <Tube x={106} y={Y - PIPE_R} w={NODE_W - 106} h={2 * PIPE_R} />
      <Flange x={61} y={Y} size={32} thick={8} /><Flange x={107} y={Y} size={32} thick={8} />
      {/* body */}
      <rect x="64" y={Y - 16} width="40" height="32" rx="7" fill="url(#mm-vessel)" stroke="#4b535b" strokeWidth="1" />
      <rect x="66" y={Y - 14} width="36" height="6" rx="3" fill="#ffffff" fillOpacity=".55" />
      <rect x="68" y={Y + 2} width="32" height="11" rx="3" fill={band} stroke="#1f2a33" strokeOpacity=".5" strokeWidth=".6" />
      <text x="84" y={Y + 10.5} textAnchor="middle" fontSize="7" fontWeight="700" fill="#ffffff" letterSpacing=".5">{known ? (open ? 'OPEN' : 'SHUT') : ''}</text>
      {/* bore and the gate inside it */}
      <rect x="80" y={Y - 13} width="8" height="14" rx="1" fill="#1c242b" fillOpacity=".55" />
      <rect className="mimic-gate" x="81" y={Y - 12} width="6" height="12" rx="1" fill="url(#mm-grey-v)" stroke="#2f3941" strokeWidth=".5" style={{ transform: `translateY(${!known ? 0 : open ? -10 : 0}px)` }} />
      {/* bonnet and stem */}
      <path d={`M72 ${Y - 16} L96 ${Y - 16} L92 ${Y - 30} L76 ${Y - 30} Z`} fill="url(#mm-grey-v)" stroke="#4b535b" strokeWidth=".8" />
      <Bolt cx={75} cy={Y - 19} r={1.3} /><Bolt cx={93} cy={Y - 19} r={1.3} />
      <rect x="81.5" y="8" width="5" height={Y - 30 - 8} fill="url(#mm-pipe-v)" stroke="#2f3941" strokeWidth=".5" />
      {/* handwheel */}
      <g className="mimic-handle" style={{ transform: `rotate(${open ? 0 : 90}deg)` }}>
        <circle cx="84" cy="15" r="13" fill="none" stroke="#5a1410" strokeWidth="5.5" />
        <circle cx="84" cy="15" r="13" fill="none" stroke="url(#mm-wheel)" strokeWidth="4" />
        <circle cx="84" cy="15" r="13" fill="none" stroke="#ffffff" strokeOpacity=".35" strokeWidth="1" />
        {[0, 60, 120].map((a) => <line key={a} x1="71" y1="15" x2="97" y2="15" stroke="#9a2d22" strokeWidth="2.6" transform={`rotate(${a} 84 15)`} />)}
        <circle cx="84" cy="15" r="3.6" fill="url(#mm-bolt)" stroke="#2f3941" strokeWidth=".6" />
      </g>
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tank: a rimmed cylinder on legs with a manway, a level scale on the wall
// and a MEASURED water line
// ═══════════════════════════════════════════════════════════════════════════
export function TankSymbol({ s = {}, label, sub }) {
  const uid = useId();
  const clipId = `clip-${label || uid}`;
  const hasLevel = typeof s.level === 'number';
  const level = hasLevel ? Math.max(0, Math.min(100, s.level)) : null;
  const top = 20, bottom = 96, h = bottom - top;
  const waterH = hasLevel ? (h * level) / 100 : h * 0.6;
  const waterY = bottom - waterH;
  return (
    <g filter="url(#mm-soft)" data-level={hasLevel ? level.toFixed(0) : 'unknown'}>
      <Tube x={0} y={Y - PIPE_R} w={16} h={2 * PIPE_R} /><Tube x={152} y={Y - PIPE_R} w={16} h={2 * PIPE_R} />
      <Flange x={13} y={Y} /><Flange x={155} y={Y} />
      {/* legs */}
      <rect x="26" y={bottom} width="8" height="10" fill="url(#mm-grey-v)" /><rect x="134" y={bottom} width="8" height="10" fill="url(#mm-grey-v)" />
      {/* shell */}
      <rect x="14" y={top} width={NODE_W - 28} height={h} rx="5" fill="#dfe5ea" stroke="#6b747d" strokeWidth="1" />
      <clipPath id={clipId}><rect x="15" y={top + 1} width={NODE_W - 30} height={h - 2} rx="4" /></clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect className="mimic-level" x="15" y={waterY} width={NODE_W - 30} height={waterH + 2} fill="url(#mm-tank)" opacity={hasLevel ? 1 : .5} />
        <g className="mimic-wave"><rect x="15" y={waterY - 3} width={NODE_W + 40} height="10" fill="url(#mm-ripple)" /></g>
        {[30, 60, 90, 120].map((x, i) => <circle key={x} cx={x} cy={bottom - 4} r="1.6" fill="#ffffff" fillOpacity=".8" className="mimic-rise" style={{ animationDelay: `${i * 0.9}s` }} />)}
      </g>
      <rect x="14" y={top} width={NODE_W - 28} height={h} rx="5" fill="url(#mm-glass)" pointerEvents="none" />
      <rect x="14" y={top} width={NODE_W - 28} height={h} rx="5" fill="none" stroke="#4b535b" strokeWidth="1" />
      {/* rim, roof and manway */}
      <rect x="10" y={top - 6} width={NODE_W - 20} height="7" rx="2" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".6" />
      <rect x="20" y={top - 12} width="128" height="7" rx="3" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".5" />
      <ellipse cx="124" cy={top - 12} rx="8" ry="3" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".5" />
      {/* level scale on the wall */}
      {[0, 25, 50, 75, 100].map((p) => (
        <g key={p}>
          <line x1="142" y1={bottom - (h * p) / 100} x2={p % 50 === 0 ? 150 : 147} y2={bottom - (h * p) / 100} stroke="#243342" strokeOpacity=".6" strokeWidth="1" />
        </g>
      ))}
      {hasLevel && <path d={`M150 ${waterY} l -5 -3 v 6 z`} fill="#e0a020" stroke="#7a5200" strokeWidth=".5" />}
      <text x="78" y={Y + 2} textAnchor="middle" fontSize="13" fontWeight="700" fill={hasLevel && level > 45 ? '#ffffff' : G.ink} style={{ paintOrder: 'stroke' }} stroke={hasLevel && level > 45 ? '#1f6b93' : '#ffffff'} strokeWidth="2.5" strokeOpacity=".6">{hasLevel ? `${level.toFixed(0)} %` : ''}</text>
      {sub && <text x="78" y={Y + 15} textAnchor="middle" fontSize="8.5" fill={hasLevel && level > 60 ? '#e6f4fb' : G.ink}>{sub}</text>}
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Vessel: domed pressure filter on legs, manway, gauge, a media window
// ═══════════════════════════════════════════════════════════════════════════
export function VesselSymbol({ s = {}, label, mode }) {
  const on = s.running !== false;
  return (
    <g filter="url(#mm-soft)">
      <Tube x={0} y={Y - PIPE_R} w={50} h={2 * PIPE_R} /><Tube x={118} y={Y - PIPE_R} w={NODE_W - 118} h={2 * PIPE_R} />
      <Flange x={47} y={Y} /><Flange x={121} y={Y} />
      {/* legs */}
      <rect x="56" y="88" width="7" height="18" fill="url(#mm-grey-v)" /><rect x="105" y="88" width="7" height="18" fill="url(#mm-grey-v)" />
      <rect x="50" y="104" width="68" height="4" rx="1.5" fill="url(#mm-grey)" />
      {/* shell */}
      <path d="M50 28 A 34 18 0 0 1 118 28 L118 82 A 34 12 0 0 1 50 82 Z" fill="url(#mm-vessel)" stroke="#6b747d" strokeWidth="1" />
      <path d="M50 28 A 34 18 0 0 1 118 28" fill="none" stroke="#ffffff" strokeOpacity=".8" strokeWidth="2" />
      <line x1="50" y1="28" x2="118" y2="28" stroke="#8d979f" strokeWidth=".8" strokeDasharray="2 2" />
      <line x1="50" y1="82" x2="118" y2="82" stroke="#8d979f" strokeWidth=".8" strokeDasharray="2 2" />
      {/* manway and gauge */}
      <circle cx="84" cy="14" r="7" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".7" />
      {[0, 90, 180, 270].map((a) => <Bolt key={a} cx={84 + 5 * Math.cos((a * Math.PI) / 180)} cy={14 + 5 * Math.sin((a * Math.PI) / 180)} r={1.1} />)}
      <rect x="107" y="18" width="3" height="8" fill="url(#mm-pipe-v)" />
      <circle cx="108.5" cy="13" r="6.5" fill="url(#mm-dial)" stroke="url(#mm-chrome)" strokeWidth="2.2" />
      <line x1="108.5" y1="13" x2="111.5" y2="9" stroke={G.red} strokeWidth="1.2" strokeLinecap="round" />
      {/* media window */}
      <rect x="64" y="36" width="40" height="42" rx="3" fill="#d7e9f2" stroke="#6b747d" strokeWidth=".8" />
      <rect x="65" y="37" width="38" height="12" fill="url(#mm-tank)" opacity=".8" />
      <rect x="65" y="49" width="38" height="8" fill={mode === 'Carbon' ? 'url(#mm-carbon)' : 'url(#mm-sand)'} />
      <rect x="65" y="57" width="38" height="12" fill={mode === 'Carbon' ? 'url(#mm-carbon)' : 'url(#mm-sand)'} opacity=".9" />
      <rect x="65" y="69" width="38" height="8" fill="url(#mm-gravel)" />
      <rect x="64" y="36" width="40" height="42" rx="3" fill="url(#mm-glass)" pointerEvents="none" />
      {on && [70, 84, 98].map((x, i) => <circle key={x} cx={x} cy="47" r="1.3" fill="#ffffff" fillOpacity=".85" className="mimic-rise" style={{ animationDelay: `${i * 1.1}s` }} />)}
      {/* mode plate */}
      <rect x="58" y="84" width="52" height="12" rx="2" fill="#ffffff" stroke="#b9c2c9" />
      <Led cx={65} cy={90} on={on} />
      <text x="90" y="93.5" textAnchor="middle" fontSize="7.5" fontWeight="600" fill={G.ink}>{mode || 'Filter'}</text>
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Basin: an open concrete unit (trap, screen, clarifier, biological basin)
// with a handrail and water
// ═══════════════════════════════════════════════════════════════════════════
export function BasinSymbol({ label, sub }) {
  return (
    <g filter="url(#mm-soft)">
      <Tube x={0} y={Y - PIPE_R} w={26} h={2 * PIPE_R} /><Tube x={142} y={Y - PIPE_R} w={NODE_W - 142} h={2 * PIPE_R} />
      <Flange x={23} y={Y} /><Flange x={145} y={Y} />
      {/* concrete walls */}
      <path d="M24 30 L144 30 L136 94 L32 94 Z" fill="url(#mm-concrete)" stroke="#6b747d" strokeWidth="1.2" />
      <path d="M31 38 L137 38 L130 87 L38 87 Z" fill="#b6bfc6" />
      {/* water */}
      <path d="M31 44 L137 44 L130 87 L38 87 Z" fill="url(#mm-tank)" opacity=".9" />
      <g className="mimic-wave"><rect x="31" y="41" width="150" height="8" fill="url(#mm-ripple)" /></g>
      {[52, 84, 116].map((x, i) => <circle key={x} cx={x} cy="82" r="1.5" fill="#ffffff" fillOpacity=".8" className="mimic-rise" style={{ animationDelay: `${i * 1.2}s` }} />)}
      <path d="M31 44 L137 44 L130 87 L38 87 Z" fill="url(#mm-glass)" pointerEvents="none" />
      {/* handrail */}
      <line x1="20" y1="22" x2="148" y2="22" stroke="#e0a020" strokeWidth="2" /><line x1="20" y1="26" x2="148" y2="26" stroke="#e0a020" strokeWidth="1.2" />
      {[24, 64, 104, 144].map((x) => <line key={x} x1={x} y1="22" x2={x} y2="30" stroke="#e0a020" strokeWidth="1.6" />)}
      {sub && <text x={NODE_W / 2} y="68" textAnchor="middle" fontSize="9" fontWeight="600" fill="#ffffff" style={{ paintOrder: 'stroke' }} stroke="#1f6b93" strokeWidth="2" strokeOpacity=".5">{sub}</text>}
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Dosing: a translucent chemical drum with its liquid, a diaphragm dosing
// pump and the injection line
// ═══════════════════════════════════════════════════════════════════════════
export function DosingSymbol({ s = {}, label, chemical }) {
  const on = s.running === true;
  return (
    <g filter="url(#mm-soft)" data-running={on ? 'true' : 'false'}>
      <Tube x={0} y={Y - PIPE_R} w={30} h={2 * PIPE_R} /><Tube x={138} y={Y - PIPE_R} w={NODE_W - 138} h={2 * PIPE_R} />
      <Flange x={27} y={Y} /><Flange x={141} y={Y} />
      {/* drum */}
      <rect x="38" y="16" width="56" height="78" rx="7" fill="#eef2f5" stroke="#8d979f" strokeWidth="1" />
      <rect x="41" y="52" width="50" height="39" rx="4" fill="url(#mm-chem)" opacity=".9" />
      <g className="mimic-wave"><rect x="41" y="49" width="120" height="8" fill="url(#mm-ripple)" /></g>
      <rect x="38" y="16" width="56" height="78" rx="7" fill="url(#mm-glass)" pointerEvents="none" />
      <rect x="52" y="10" width="28" height="8" rx="3" fill="url(#mm-grey)" stroke="#2f3941" strokeWidth=".5" />
      <text x="66" y="40" textAnchor="middle" fontSize="8" fontWeight="600" fill={G.ink}>{chemical || 'Dosing'}</text>
      {/* suction lance and dosing pump */}
      <rect x="72" y="18" width="3" height="66" fill="url(#mm-pipe-v)" opacity=".8" />
      <rect x="100" y="44" width="34" height="28" rx="4" fill={on ? 'url(#mm-green)' : 'url(#mm-grey)'} stroke="#0f2a17" strokeOpacity=".6" strokeWidth=".7" />
      <rect x="103" y="47" width="28" height="5" rx="2.5" fill="#ffffff" fillOpacity=".3" />
      <circle cx="117" cy="61" r="7" fill="#1c242b" fillOpacity=".55" />
      <g className={on ? 'mimic-spin' : undefined} style={{ '--spin': '1.6s' }}>
        <circle cx="117" cy="61" r="5" fill="#dfe5ea" /><line x1="117" y1="56" x2="117" y2="66" stroke="#5c6670" strokeWidth="2" />
      </g>
      <Led cx={128} cy={50} on={on} />
      {/* injection line */}
      <path d="M94 34 H117 V44" fill="none" stroke="#9c2f62" strokeWidth="3" />
      <path d={`M117 72 V${Y}`} fill="none" stroke="#9c2f62" strokeWidth="3" className={on ? 'mimic-flow' : undefined} style={{ '--mimic-flow-speed': '1.2s' }} />
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Instruments: a chrome-bezel dial on a stem, or an in-line transmitter
// with an LCD
// ═══════════════════════════════════════════════════════════════════════════
export function InstrumentSymbol({ label, reading, unit, kind }) {
  const v = reading?.value;
  const hasSpan = reading?.rangeMin != null && reading?.rangeMax != null && reading.rangeMax > reading.rangeMin;
  const frac = hasSpan && v != null ? Math.max(0, Math.min(1, (v - reading.rangeMin) / (reading.rangeMax - reading.rangeMin))) : null;
  const needle = frac == null ? -120 : -120 + 240 * frac;
  const live = reading?.quality === 'good';
  const dial = kind === 'level' || kind === 'pressure';
  return (
    <g filter="url(#mm-soft)" data-quality={reading?.quality || 'unknown'}>
      {dial ? (
        <g>
          <Tube x={0} y={Y - PIPE_R} w={NODE_W} h={2 * PIPE_R} />
          <Flange x={64} y={Y} /><Flange x={104} y={Y} />
          <rect x="81" y="44" width="6" height={Y - PIPE_R - 44} fill="url(#mm-pipe-v)" stroke="#2f3941" strokeWidth=".5" />
          <circle cx="84" cy="26" r="24" fill="url(#mm-chrome)" />
          <circle cx="84" cy="26" r="20.5" fill="url(#mm-dial)" stroke="#8d979f" strokeWidth=".6" />
          <path d={describeArc(84, 26, 17, 84, 120)} fill="none" stroke={G.red} strokeWidth="3" strokeOpacity=".8" />
          {Array.from({ length: 25 }, (_, i) => {
            const a = -120 + i * 10;
            const major = i % 3 === 0;
            return <line key={i} x1="84" y1={26 - 19} x2="84" y2={26 - (major ? 14.5 : 16.5)} stroke="#243342" strokeWidth={major ? 1.3 : .7} transform={`rotate(${a} 84 26)`} />;
          })}
          <text x="84" y="40" textAnchor="middle" fontSize="6.5" fill="#5c6670">{unit || ''}</text>
          <line className={`mimic-needle${live ? ' mimic-needle--live' : ''}`} style={{ '--needle': `${needle}deg` }} x1="84" y1="30" x2="84" y2="9" stroke={G.red} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="84" cy="26" r="2.8" fill="url(#mm-bolt)" stroke="#2f3941" strokeWidth=".5" />
          <ellipse cx="76" cy="16" rx="9" ry="4" fill="#ffffff" fillOpacity=".3" transform="rotate(-35 76 16)" />
          <rect x="66" y="66" width="36" height="12" rx="2" fill="#ffffff" stroke="#b9c2c9" />
          <text x="84" y="75" textAnchor="middle" fontSize="8" fontWeight="700" fill={G.ink} fontFamily="ui-monospace, monospace">{fmt(v)}</text>
        </g>
      ) : (
        <g>
          <Tube x={0} y={Y - PIPE_R} w={58} h={2 * PIPE_R} /><Tube x={110} y={Y - PIPE_R} w={NODE_W - 110} h={2 * PIPE_R} />
          <Flange x={57} y={Y} size={30} thick={8} /><Flange x={111} y={Y} size={30} thick={8} />
          <rect x="60" y={Y - 13} width="48" height="26" rx="4" fill="url(#mm-pipe)" stroke="#2f3941" strokeWidth=".7" />
          <rect x="79" y="40" width="10" height="8" fill="url(#mm-pipe-v)" stroke="#2f3941" strokeWidth=".5" />
          <rect x="56" y="8" width="56" height="34" rx="5" fill="url(#mm-housing)" stroke="#111820" strokeWidth=".8" />
          <rect x="58" y="10" width="52" height="5" rx="2.5" fill="#ffffff" fillOpacity=".18" />
          <rect x="62" y="16" width="44" height="18" rx="2" fill="url(#mm-lcd)" stroke="#2b3a2a" strokeWidth=".7" />
          <text x="84" y="27" textAnchor="middle" fontSize="10" fontWeight="700" fill="#1f3a2a" fontFamily="ui-monospace, monospace">{fmt(v)}</text>
          <text x="104" y="32" textAnchor="end" fontSize="5" fill="#2b3a2a">{unit || ''}</text>
          {[68, 78, 88].map((x) => <circle key={x} cx={x} cy="38" r="1.6" fill="#8e98a1" stroke="#111820" strokeWidth=".4" />)}
          <Led cx={102} cy={38} on={live} tripped={reading?.quality === 'bad'} />
        </g>
      )}
      {label && <text x={NODE_W / 2} y="112" textAnchor="middle" fontSize="9" fill={G.ink} fontFamily="ui-monospace, monospace">{label}</text>}
    </g>
  );
}

function describeArc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(((a - 90) * Math.PI) / 180), cy + r * Math.sin(((a - 90) * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Source / sink: a pipe out of a wall; a discharge into a drain
// ═══════════════════════════════════════════════════════════════════════════
const DRAIN = polyline([{ x: 0, y: Y }, { x: 84, y: Y }, { x: 84, y: 92 }], 8);

export function EndSymbol({ label, kind, active }) {
  const isSink = kind === 'sink';
  return (
    <g filter="url(#mm-soft)">
      {isSink ? (
        <g>
          <PipeBody route={DRAIN} />
          {active && <PipeWater d={DRAIN.d} style={WATER} moving />}
          <PipeJoints route={DRAIN} />
          <rect x="62" y="98" width="44" height="7" rx="1.5" fill="url(#mm-dark)" stroke="#111820" strokeWidth=".5" />
          {[66, 72, 78, 84, 90, 96, 102].map((x) => <line key={x} x1={x} y1="99" x2={x} y2="104" stroke="#8e98a1" strokeWidth="1" />)}
          <g className={active ? 'mimic-splash' : undefined}>
            <path d="M76 92 q 8 12 16 0 q -4 10 -8 10 q -4 0 -8 -10" fill={G.water} opacity={active ? .9 : .3} />
          </g>
        </g>
      ) : (
        <g>
          <rect x="52" y="30" width="18" height="60" rx="2" fill="url(#mm-concrete)" stroke="#6b747d" strokeWidth="1" />
          {[38, 50, 62, 74].map((y) => <line key={y} x1="54" y1={y} x2="68" y2={y} stroke="#8d979f" strokeWidth=".6" />)}
          <Tube x={70} y={Y - PIPE_R} w={NODE_W - 70} h={2 * PIPE_R} />
          <Flange x={74} y={Y} />
          {active && <PipeWater d={`M 70 ${Y} L ${NODE_W} ${Y}`} style={WATER} moving />}
        </g>
      )}
      <rect x="8" y="6" width={NODE_W - 16} height="20" rx="4" fill="#ffffff" stroke="#c9d1d8" />
      <text x={NODE_W / 2} y="19.5" textAnchor="middle" fontSize="9.5" fontWeight="600" fill={G.ink}>{label}</text>
    </g>
  );
}

export default memo(function MimicSymbol({ family, ...props }) {
  switch (family) {
    case 'drive': return props.opType === 'blower' ? <BlowerSymbol {...props} /> : <PumpSymbol {...props} />;
    case 'valve': return <ValveSymbol {...props} />;
    case 'tank': return <TankSymbol {...props} />;
    case 'vessel': return <VesselSymbol {...props} />;
    case 'dosing': return <DosingSymbol {...props} />;
    case 'instrument': return <InstrumentSymbol {...props} />;
    case 'source': return <EndSymbol kind="source" {...props} />;
    case 'sink': return <EndSymbol kind="sink" {...props} />;
    default: return <BasinSymbol {...props} />;
  }
});
