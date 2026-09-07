/**
 * Render a sheet of every mimic symbol in its states, plus a routed pipe, to
 * a standalone HTML file — a still frame to look at without the app:
 *
 *   npx vite-node scripts/mimicSheet.jsx [out.html]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MimicSymbol, { MimicDefs, PipeBody, PipeWater, PipeJoints } from '../src/components/mimic/MimicSymbols';
import { routePipe, streamStyle, NODE_W, NODE_H } from '../src/components/mimic/mimicLayout';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || resolve(here, '..', '..', 'mimic-sheet.html');
const css = readFileSync(resolve(here, '..', 'src', 'components', 'mimic', 'mimic.css'), 'utf8');

const CELLS = [
  ['Pump · running', { family: 'drive', opType: 'pump', s: { running: true }, label: 'RFP-P-201/1' }],
  ['Pump · stopped', { family: 'drive', opType: 'pump', s: { running: false }, label: 'RFP-P-201/2' }],
  ['Pump · tripped', { family: 'drive', opType: 'pump', s: { running: false, tripped: true }, label: 'FFP-P-501/1' }],
  ['Blower · running', { family: 'drive', opType: 'blower', s: { running: true }, label: 'R-B-301/1' }],
  ['Valve · open', { family: 'valve', opType: 'valve', s: { opened: true, closed: false }, label: 'ELP-XV-101/1' }],
  ['Valve · shut', { family: 'valve', opType: 'valve', s: { opened: false, closed: true }, label: 'ELP-XV-111/1' }],
  ['Tank · 61 %', { family: 'tank', opType: 'equalisation_tank', s: { level: 61 }, label: 'EQT-LT-101', sub: 'Equalisation' }],
  ['Tank · no level', { family: 'tank', opType: 'tank', s: {}, label: 'SWT', sub: 'Soft water' }],
  ['Filter vessel', { family: 'vessel', opType: 'pressure_filter', s: {}, label: 'MGF-601', mode: 'Filter' }],
  ['Carbon filter', { family: 'vessel', opType: 'activated_carbon_filter', s: {}, label: 'ACF-601', mode: 'Carbon' }],
  ['Basin', { family: 'basin', opType: 'oil_grease_trap', s: {}, label: 'OGT-001', sub: 'Oil & grease' }],
  ['Dosing', { family: 'dosing', opType: 'chlorination', s: { running: true }, label: 'CL-DP-701', chemical: 'NaOCl' }],
  ['Flow LCD', { family: 'instrument', opType: 'instrument', reading: { value: 612.4, quality: 'good', rangeMin: 0, rangeMax: 800 }, unit: 'm³/d', kind: 'flow', label: 'RFP-FT-201' }],
  ['Level dial', { family: 'instrument', opType: 'instrument', reading: { value: 61.2, quality: 'good', rangeMin: 0, rangeMax: 100 }, unit: '%', kind: 'level', label: 'EQT-LT-101' }],
  ['Inlet', { family: 'source', opType: 'inlet', label: 'Sewage influent', active: true }],
  ['Outlet', { family: 'sink', opType: 'outlet', label: 'Irrigation', active: true }],
];

const COLS = 4, PAD = 40, GAP_X = 60, GAP_Y = 70;
const W = PAD * 2 + COLS * NODE_W + (COLS - 1) * GAP_X;
const rows = Math.ceil(CELLS.length / COLS);
const pipeY = PAD + rows * (NODE_H + GAP_Y) + 10;
const H = pipeY + 260;

const water = streamStyle('stream');
const routeA = routePipe({ x: PAD, y: pipeY + 40 }, { x: PAD + 420, y: pipeY + 40 });
const routeB = routePipe({ x: PAD + 480, y: pipeY + 20 }, { x: PAD + 800, y: pipeY + 140 });
const routeC = routePipe({ x: W - PAD - 40, y: pipeY + 30 }, { x: W - PAD - 320, y: pipeY + 30 });

const sheet = (
  <svg xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mimic-root" style={{ background: '#eef1f4', fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
    <MimicDefs />
    {CELLS.map(([title, props], i) => {
      const x = PAD + (i % COLS) * (NODE_W + GAP_X);
      const y = PAD + Math.floor(i / COLS) * (NODE_H + GAP_Y);
      return (
        <g key={title} transform={`translate(${x} ${y})`}>
          <rect x="-8" y="-24" width={NODE_W + 16} height={NODE_H + 34} rx="8" fill="#ffffff" fillOpacity=".55" stroke="#d5dbe0" />
          <text x="0" y="-9" fontSize="11" fontWeight="600" fill="#243342">{title}</text>
          <MimicSymbol {...props} />
        </g>
      );
    })}
    <g transform="translate(0 0)">
      <text x={PAD} y={pipeY} fontSize="11" fontWeight="600" fill="#243342">Pipes: straight (flowing), stepped (flowing), backward recycle (static)</text>
      <PipeBody route={routeA} /><PipeWater d={routeA.d} style={water} moving /><PipeJoints route={routeA} />
      <PipeBody route={routeB} /><PipeWater d={routeB.d} style={streamStyle('filtrate')} moving /><PipeJoints route={routeB} />
      <PipeBody route={routeC} /><PipeWater d={routeC.d} style={streamStyle('recycle')} /><PipeJoints route={routeC} />
    </g>
  </svg>
);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Mimic symbol sheet</title><style>body{margin:0;background:#eef1f4}${css}</style></head><body>${renderToStaticMarkup(sheet)}</body></html>`;
writeFileSync(out, html);
console.log(`wrote ${out} (${W}×${H})`);
