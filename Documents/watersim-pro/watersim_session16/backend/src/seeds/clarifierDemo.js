/**
 * clarifierDemo.js — a classic activated-sludge train built to exercise the
 * secondary-clarifier tank-level logic:
 *
 *   Raw Influent → Primary Clarifier → Aeration Basin → Secondary Clarifier → Outlet
 *                                          ▲──────── RAS recycle ───────┘
 *
 * In the Live Sim, click the Secondary Clarifier and set its "Outflow Setpoint"
 * different from the inflow to watch the blanket level rise / fall.
 *
 * Idempotent: upserts by flowsheet name inside the first project.
 *   node backend/src/seeds/clarifierDemo.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (_) {}
const { Pool } = require('pg');

const FLOWSHEET_NAME = 'Activated Sludge — Clarifier Level Dynamics';

const canvasData = {
  nodes: [
    { id: 'node_1', type: 'unitOp', position: { x: 80,  y: 220 },
      data: { label: 'Raw Influent', opType: 'inlet',
              params: { Q: 10000, BOD: 220, COD: 420, TSS: 260, TN: 45, NH4: 35, TP: 8, pH: 7.2, temp: 20 } } },
    { id: 'node_2', type: 'unitOp', position: { x: 300, y: 220 },
      data: { label: 'Primary Clarifier', opType: 'primary_clarifier',
              params: { SOR_m3_m2_d: 40, depth_m: 3.5, sludge_TSS: 25000 } } },
    { id: 'node_3', type: 'unitOp', position: { x: 540, y: 220 },
      data: { label: 'Aeration Basin', opType: 'activated_sludge',
              params: { SRT_d: 12, MLSS_mg_L: 3500, DO_set_mg_L: 2.0 } } },
    { id: 'node_4', type: 'unitOp', position: { x: 780, y: 220 },
      data: { label: 'Secondary Clarifier', opType: 'secondary_clarifier',
              params: { SOR_m3_m2_d: 16, RAS_ratio: 0.6, TSS_effluent: 12, depth_m: 4.0, Q_out_m3d: 0 } } },
    { id: 'node_5', type: 'unitOp', position: { x: 1020, y: 220 },
      data: { label: 'Final Effluent', opType: 'outlet',
              params: { limit_BOD: 30, limit_TSS: 30, limit_TN: 10, limit_TP: 1, limit_NH4: 5 } } },
  ],
  edges: [
    { id: 'edge_1', source: 'node_1', target: 'node_2', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_2', source: 'node_2', target: 'node_3', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_3', source: 'node_3', target: 'node_4', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_4', source: 'node_4', target: 'node_5', type: 'stream', animated: true, data: { streamType: 'stream' } },
    // Return activated sludge — recycle from the clarifier underflow back to aeration
    { id: 'edge_5', source: 'node_4', target: 'node_3', type: 'stream', animated: true, data: { streamType: 'ras', isRecycle: true, label: 'RAS' } },
  ],
  viewport: { x: 0, y: 0, zoom: 0.85 },
};

async function main() {
  const connectionString = process.env.DATABASE_URL || 'postgres://postgres:root@localhost:5432/watersim_dev';
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
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
      'SELECT id FROM flowsheets WHERE project_id = $1 AND name = $2 LIMIT 1', [projectId, FLOWSHEET_NAME]);

    let id;
    if (existing.rows.length) {
      id = existing.rows[0].id;
      await pool.query('UPDATE flowsheets SET canvas_data = $1::jsonb, version = version + 1, updated_at = now() WHERE id = $2', [json, id]);
      console.log(`Updated existing flowsheet "${FLOWSHEET_NAME}" (${id})`);
    } else {
      const ins = await pool.query(
        `INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [projectId, createdBy, FLOWSHEET_NAME,
         'Activated sludge with RAS recycle — demonstrates secondary-clarifier tank-level dynamics', json]);
      id = ins.rows[0].id;
      console.log(`Created flowsheet "${FLOWSHEET_NAME}" (${id})`);
    }
    console.log(`  project: ${projectId}`);
    console.log(`  nodes:   ${canvasData.nodes.length}, edges: ${canvasData.edges.length} (incl. RAS recycle)`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('clarifierDemo failed:', e.message); process.exit(1); });
