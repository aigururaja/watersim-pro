#!/usr/bin/env node
/**
 * WaterSim Pro — seed the CMMS asset register from the tag registry (Phase 5)
 *
 *   node scripts/sync-cmms-assets.js --org itc-stp [--dry-run]
 *
 * One CMMS asset per equipment loop (asset_code = the ISA loop tag, e.g.
 * RFP-P-201), one sub-asset per unit (RFP-P-201/1). The WaterSim ids ride in
 * `custom_fields.watersim` so neither schema changes. Lookups (type, make)
 * are resolved by name on the CMMS side.
 *
 * Env: DATABASE_URL (this side), CMMS_URL, CMMS_API_KEY (the X-API-Key the
 * CMMS accepts — see the cmms-hydrogen README).
 */
'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db/pool');
const { processes } = require('../src/plants/itcStp');

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const slug = opt('org', 'itc-stp');
const dryRun = !!opt('dry-run', false);
const CMMS_URL = (process.env.CMMS_URL || '').replace(/\/$/, '');
const CMMS_API_KEY = process.env.CMMS_API_KEY || '';

const KIND_LABELS = processes.KIND_LABELS || {};
const label = (kind) => (KIND_LABELS[kind] && (KIND_LABELS[kind].label || KIND_LABELS[kind])) || kind;

async function main() {
  const org = (await query('SELECT id, name FROM organisations WHERE slug = $1', [slug])).rows[0];
  if (!org) throw new Error(`No organisation with slug "${slug}"`);
  const { rows } = await query(
    `SELECT t.loop_tag, t.area, t.code, MIN(t.kind) AS kind, MIN(t.name) AS name, MIN(t.plc_node) AS plc_node,
            MIN(t.flowsheet_id::text) AS flowsheet_id, MIN(t.node_id) AS node_id, MAX(t.unit) AS units,
            ARRAY_AGG(DISTINCT t.id::text) AS tag_ids
       FROM tags t WHERE t.organisation_id = $1 GROUP BY t.loop_tag, t.area, t.code ORDER BY t.loop_tag`,
    [org.id]
  );
  const assets = rows.map((r) => ({
    asset_code: r.loop_tag,
    asset_name: r.name || r.loop_tag,
    asset_type: label(r.kind),
    location: r.area,
    description: `${r.plc_node || ''} · ${r.loop_tag}`.trim(),
    custom_fields: { watersim: { organisation: slug, flowsheetId: r.flowsheet_id, nodeId: r.node_id, tagIds: r.tag_ids, kind: r.kind, area: r.area } },
    sub_assets: Array.from({ length: Number(r.units) || 0 }, (_, i) => ({
      sub_asset_code: `${r.loop_tag}/${i + 1}`, sub_asset_name: `${r.name || r.loop_tag} — unit ${i + 1}`,
      custom_fields: { watersim: { loopTag: r.loop_tag, unit: i + 1 } },
    })),
  }));
  console.log(`${assets.length} assets, ${assets.reduce((n, a) => n + a.sub_assets.length, 0)} sub-assets from ${org.name}`);
  if (dryRun || !CMMS_URL) {
    console.log(dryRun ? '(dry run)' : '(CMMS_URL not set — printing only)');
    console.log(JSON.stringify(assets.slice(0, 3), null, 2));
    return;
  }
  const res = await fetch(`${CMMS_URL}/api/v1/integrations/assets/upsert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': CMMS_API_KEY }, body: JSON.stringify({ assets }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CMMS answered ${res.status}: ${JSON.stringify(body)}`);
  console.log('CMMS:', JSON.stringify(body));
}

main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end().finally(() => process.exit(1)); });
