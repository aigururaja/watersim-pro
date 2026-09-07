/**
 * Render the live plant's schematic (the same MimicView the Live plant screen
 * draws, from the running backend's flowsheet and snapshot) to a standalone
 * HTML file — a still frame of the whole plant to look at without a browser
 * session:
 *
 *   npx vite-node scripts/mimicPlant.jsx out.html [http://localhost:3001/api/v1]
 *
 * Logs in as the seeded ITC engineer (dev only).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MimicView from '../src/components/mimic/MimicView';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || resolve(here, '..', '..', 'mimic-plant.html');
const base = process.argv[3] || 'http://localhost:3001/api/v1';
const css = readFileSync(resolve(here, '..', 'src', 'components', 'mimic', 'mimic.css'), 'utf8');

const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'engineer@itc-stp.local', password: 'Engineer1!', orgSlug: 'itc-stp' }) });
const token = (await r.json()).data.accessToken;
const h = { authorization: `Bearer ${token}` };
const unwrap = (j) => (j && j.data !== undefined && !Array.isArray(j) ? j.data : j);
const snap = unwrap(await (await fetch(`${base}/live/snapshot`, { headers: h })).json());
const plant = snap.flowsheets[0];
const fs = unwrap(await (await fetch(`${base}/projects/${plant.projectId}/flowsheets/${plant.id}`, { headers: h })).json());
const canvas = fs.canvas_data;

// The same mapping LivePlantPage makes: contacts → running / opened / closed, LT → level, AI → readings.
const states = new Map();
for (const t of snap.tags) {
  if (!t.nodeId) continue;
  if (!states.has(t.nodeId)) states.set(t.nodeId, { readings: {} });
  const s = states.get(t.nodeId);
  const bit = t.value == null ? undefined : t.value >= 0.5;
  if (t.signalType === 'DI') {
    if (t.fn === 'XS') s.running = s.running === true ? true : bit;
    else if (t.fn === 'XA') s.tripped = s.tripped === true ? true : bit;
    else if (t.fn === 'ZSO') s.opened = bit;
    else if (t.fn === 'ZSC') s.closed = bit;
  } else if (t.signalType === 'AI') {
    if (t.fn === 'LT' && t.value != null) s.level = Number(t.value);
    s.readings[t.fn] = { value: t.value, quality: t.quality, rangeMin: t.rangeMin, rangeMax: t.rangeMax, at: t.at, tag: t.tag };
  }
}

const markup = renderToStaticMarkup(<MimicView nodes={canvas.nodes} edges={canvas.edges} states={states} height={1500} />);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>ITC plant — mimic</title><style>body{margin:0;background:#eef1f4;width:2600px}${css}</style></head><body>${markup}</body></html>`;
writeFileSync(out, html);
console.log(`wrote ${out}: ${canvas.nodes.length} nodes, ${canvas.edges.length} edges, ${states.size} measured nodes`);
