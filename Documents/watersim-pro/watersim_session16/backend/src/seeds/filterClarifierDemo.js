/**
 * filterClarifierDemo.js — solid/liquid split demo:
 *
 *   Water Inlet → Feed Pump → Two-Layer Filter → Primary Clarifier ─┬─[liquid]→ Discharge Pump → Liquid Output
 *                                                                    └─[solid] → Solid Output
 *
 * Built to show how the numbers respond when you change the inflow and the
 * "affecting" parameters (flow, solids, filter removal, clarifier outflow).
 *
 * Idempotent: upserts by flowsheet name inside the first project.
 *   node backend/src/seeds/filterClarifierDemo.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (_) {}
const { Pool } = require('pg');

const FLOWSHEET_NAME = 'Filtration + Primary Clarifier — Solid/Liquid Split';

const canvasData = {
  nodes: [
    { id: 'node_1', type: 'unitOp', position: { x: 80,  y: 220 },
      data: { label: 'Water Inlet', opType: 'inlet',
              params: { Q: 10000, BOD: 250, COD: 500, TSS: 400, TN: 40, NH4: 30, TP: 6, pH: 7.2, temp: 20 } } },
    { id: 'node_2', type: 'unitOp', position: { x: 290, y: 220 },
      data: { label: 'Feed Pump (P-01)', opType: 'pump',
              params: { pump_type: 'centrifugal', rated_flow_m3h: 420, head_m: 20, power_kW: 30, speed_pct: 100 } } },
    { id: 'node_3', type: 'unitOp', position: { x: 500, y: 220 },
      data: { label: 'Two-Layer Filter', opType: 'sand_filter',
              params: { filter_type: 'dual_media', HLR_m_h: 10, TSS_removal_pct: 60, sand_depth_m: 1.0, backwash_interval_h: 24 } } },
    { id: 'node_4', type: 'unitOp', position: { x: 720, y: 220 },
      data: { label: 'Primary Clarifier', opType: 'primary_clarifier',
              params: { SOR_m3_m2_d: 40, depth_m: 3.5, sludge_TSS: 25000, Q_out_m3d: 0 } } },
    { id: 'node_5', type: 'unitOp', position: { x: 960, y: 140 },
      data: { label: 'Discharge Pump (P-02)', opType: 'pump',
              params: { pump_type: 'centrifugal', rated_flow_m3h: 400, head_m: 15, power_kW: 22, speed_pct: 100 } } },
    { id: 'node_6', type: 'unitOp', position: { x: 1180, y: 140 },
      data: { label: 'Liquid Output', opType: 'outlet',
              params: { discharge_to: 'reuse', limit_TSS: 20, limit_BOD: 30 } } },
    { id: 'node_7', type: 'unitOp', position: { x: 960, y: 320 },
      data: { label: 'Solid Output', opType: 'outlet',
              params: { discharge_to: 'land' } } },
  ],
  edges: [
    { id: 'edge_1', source: 'node_1', target: 'node_2', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_2', source: 'node_2', target: 'node_3', type: 'stream', animated: true, data: { streamType: 'stream' } },
    { id: 'edge_3', source: 'node_3', target: 'node_4', type: 'stream', animated: true, data: { streamType: 'stream' } },
    // liquid line: clarifier effluent → discharge pump → liquid outlet
    { id: 'edge_4', source: 'node_4', target: 'node_5', type: 'stream', animated: true, data: { streamType: 'stream', label: 'liquid' } },
    { id: 'edge_5', source: 'node_5', target: 'node_6', type: 'stream', animated: true, data: { streamType: 'stream' } },
    // solid line: clarifier underflow → solid outlet
    { id: 'edge_6', source: 'node_4', target: 'node_7', type: 'stream', animated: true, data: { streamType: 'sludge', isSolids: true, label: 'solid' } },
  ],
  viewport: { x: 0, y: 0, zoom: 0.82 },
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
      projectId = r.rows[0].id; createdBy = createdBy || r.rows[0].created_by;
    }
    if (!createdBy) {
      const u = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
      createdBy = u.rows[0] && u.rows[0].id;
    }
    const json = JSON.stringify(canvasData);
    const existing = await pool.query('SELECT id FROM flowsheets WHERE project_id = $1 AND name = $2 LIMIT 1', [projectId, FLOWSHEET_NAME]);
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
         'Inlet → pump → two-layer filter → primary clarifier → liquid (pumped) + solid outputs', json]);
      id = ins.rows[0].id;
      console.log(`Created flowsheet "${FLOWSHEET_NAME}" (${id})`);
    }
    console.log(`  project: ${projectId} · nodes ${canvasData.nodes.length}, edges ${canvasData.edges.length}`);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error('filterClarifierDemo failed:', e.message); process.exit(1); });
