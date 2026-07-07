/**
 * customFlow.js — import a hand-authored flowsheet into WaterSim Pro.
 *
 * Flow:  Water Inlet -> Feed Pump -> Two-Layer (dual-media) Filter
 *        -> Agitator/Thickener (sludge thickener: rotating mechanism)
 *        -> [water]  Treated Water outlet
 *        -> [solid]  Discharge Pump -> Solid Discharge outlet
 *
 * Idempotent: upserts a flowsheet by name inside a project.
 * By default it targets the first project in the DB (override with
 * PROJECT_ID / CREATED_BY env vars).
 *
 *   node backend/src/seeds/customFlow.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (_) {}

const { Pool } = require('pg');

const FLOWSHEET_NAME = 'Filtration & Solid–Liquid Separation';

// ---- flowsheet graph (matches CanvasPage.jsx node/edge shape) ----
const canvasData = {
  nodes: [
    { id: 'node_1', type: 'unitOp', position: { x: 80,  y: 220 },
      data: { label: 'Water Inlet', opType: 'inlet',
              params: { Q: 10000, BOD: 200, TSS: 250, COD: 400, TN: 45, NH4: 35, TP: 8, pH: 7.2, temp: 20 } } },
    { id: 'node_2', type: 'unitOp', position: { x: 280, y: 220 },
      data: { label: 'Feed Pump (P-01)', opType: 'pump', params: {} } },
    { id: 'node_3', type: 'unitOp', position: { x: 480, y: 220 },
      data: { label: 'Two-Layer Filter', opType: 'sand_filter',
              params: { filter_type: 'dual', TSS_removal_pct: 80 } } },
    { id: 'node_4', type: 'unitOp', position: { x: 700, y: 220 },
      data: { label: 'Agitator / Thickener', opType: 'sludge_thickener',
              params: { type: 'gravity', target_TSS_mg_L: 40000 } } },
    { id: 'node_5', type: 'unitOp', position: { x: 940, y: 340 },
      data: { label: 'Discharge Pump (P-02)', opType: 'pump', params: {} } },
    { id: 'node_6', type: 'unitOp', position: { x: 940, y: 120 },
      data: { label: 'Treated Water', opType: 'outlet', params: {} } },
    { id: 'node_7', type: 'unitOp', position: { x: 1160, y: 340 },
      data: { label: 'Solid Discharge', opType: 'outlet', params: {} } },
  ],
  edges: [
    { id: 'edge_1', source: 'node_1', target: 'node_2', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_2', source: 'node_2', target: 'node_3', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_3', source: 'node_3', target: 'node_4', type: 'stream', animated: true, data: { streamType: 'stream' } },
    // water (filtrate) goes straight to the treated-water outlet
    { id: 'edge_4', source: 'node_4', target: 'node_6', type: 'stream', animated: true, data: { streamType: 'stream', label: 'water' } },
    // solids (thickened) are pumped by P-02 to the solid discharge
    { id: 'edge_5', source: 'node_4', target: 'node_5', type: 'stream', animated: true, data: { streamType: 'sludge', isSolids: true, label: 'solid' } },
    { id: 'edge_6', source: 'node_5', target: 'node_7', type: 'stream', animated: true, data: { streamType: 'stream' } },
  ],
  viewport: { x: 0, y: 0, zoom: 0.85 },
};

async function main() {
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:root@localhost:5432/watersim_dev';
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });

  try {
    // resolve target project + author
    let projectId = process.env.PROJECT_ID;
    let createdBy = process.env.CREATED_BY;
    if (!projectId) {
      const r = await pool.query('SELECT id, created_by FROM projects ORDER BY created_at ASC LIMIT 1');
      if (!r.rows.length) throw new Error('No project found. Create a project in the app first.');
      projectId = r.rows[0].id;
      createdBy = createdBy || r.rows[0].created_by;
    }
    if (!createdBy) {
      const u = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
      createdBy = u.rows[0] && u.rows[0].id;
    }

    const json = JSON.stringify(canvasData);
    const existing = await pool.query(
      'SELECT id FROM flowsheets WHERE project_id = $1 AND name = $2 LIMIT 1',
      [projectId, FLOWSHEET_NAME]
    );

    let id;
    if (existing.rows.length) {
      id = existing.rows[0].id;
      await pool.query(
        'UPDATE flowsheets SET canvas_data = $1::jsonb, version = version + 1, updated_at = now() WHERE id = $2',
        [json, id]
      );
      console.log(`Updated existing flowsheet "${FLOWSHEET_NAME}" (${id})`);
    } else {
      const ins = await pool.query(
        `INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [projectId, createdBy, FLOWSHEET_NAME,
         'Inlet -> pump -> two-layer filter -> agitator/separator -> water + solid outlets', json]
      );
      id = ins.rows[0].id;
      console.log(`Created flowsheet "${FLOWSHEET_NAME}" (${id})`);
    }
    console.log(`  project: ${projectId}`);
    console.log(`  nodes:   ${canvasData.nodes.length}, edges: ${canvasData.edges.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('customFlow failed:', e.message); process.exit(1); });
