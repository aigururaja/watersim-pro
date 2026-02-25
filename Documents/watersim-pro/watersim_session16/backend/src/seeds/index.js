/**
 * WaterSim Pro — Development Seed
 * Run: npm run seed  (from backend/ directory)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

async function seed() {
  console.log('\n▶  Seeding WaterSim Pro development data…\n');

  // ── Organisation ────────────────────────────────────────────────────────
  const { rows: [org] } = await query(`
    INSERT INTO organisations (name, slug, plan)
    VALUES ($1, $2, $3)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan
    RETURNING id, name, slug
  `, ['WaterSim Demo Org', 'demo-org', 'professional']);
  console.log(`   ✔  Organisation  : ${org.name}  (${org.id})`);

  // ── Admin user ───────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('Admin1234!', ROUNDS);
  const { rows: [admin] } = await query(`
    INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES ($1,$2,$3,$4,$5,'admin',true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_verified = true
    RETURNING id, email
  `, [org.id, 'admin@watersim.dev', adminHash, 'Ada', 'Admin']);
  console.log(`   ✔  Admin         : ${admin.email}  /  Admin1234!`);

  // ── Engineer user ────────────────────────────────────────────────────────
  const engHash = await bcrypt.hash('Engineer1!', ROUNDS);
  const { rows: [engineer] } = await query(`
    INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES ($1,$2,$3,$4,$5,'engineer',true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, email
  `, [org.id, 'engineer@watersim.dev', engHash, 'Eddie', 'Engineer']);
  console.log(`   ✔  Engineer      : ${engineer.email}  /  Engineer1!`);

  // ── Operator user ────────────────────────────────────────────────────────
  const opHash = await bcrypt.hash('Operator1!', ROUNDS);
  await query(`
    INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES ($1,$2,$3,$4,$5,'operator',true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [org.id, 'operator@watersim.dev', opHash, 'Olivia', 'Operator']);
  console.log(`   ✔  Operator      : operator@watersim.dev  /  Operator1!`);

  // ── Demo Project 1: Municipal WWTP ────────────────────────────────────────
  const { rows: proj1Rows } = await query(`
    INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags)
    VALUES ($1,$2,$3,$4,'wastewater',ARRAY['activated-sludge','demo'])
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [org.id, admin.id, 'Municipal WWTP — Demo', 'Activated sludge plant: primary + secondary treatment']);

  if (proj1Rows.length) {
    const p1 = proj1Rows[0];
    console.log(`   ✔  Project       : Municipal WWTP (${p1.id})`);

    // Flowsheet 1
    await query(`
      INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
      VALUES ($1,$2,$3,$4,$5)
    `, [p1.id, admin.id, 'Main Treatment Train', 'Primary clarifier → Aeration tank → Secondary clarifier',
      JSON.stringify({
        nodes: [
          { id: 'n0', type: 'unitOp', position: { x:  80, y: 200 }, data: { label: 'Influent', opType: 'inlet', params: { Q: 10000, BOD: 220, TSS: 260, TN: 45, NH4: 35, TP: 8, COD: 420, pH: 7.2, temp: 20 } } },
          { id: 'n1', type: 'unitOp', position: { x: 260, y: 200 }, data: { label: 'Bar Screen', opType: 'screening', params: { screenType: 'fine' } } },
          { id: 'n2', type: 'unitOp', position: { x: 440, y: 200 }, data: { label: 'Grit Chamber', opType: 'grit_removal', params: { chamberType: 'vortex' } } },
          { id: 'n3', type: 'unitOp', position: { x: 620, y: 200 }, data: { label: 'Primary Clarifier', opType: 'primary_clarifier', params: {} } },
          { id: 'n4', type: 'unitOp', position: { x: 800, y: 200 }, data: { label: 'Aeration Basin', opType: 'activated_sludge', params: { SRT_d: 10, MLSS_mg_L: 3000, DO_set_mg_L: 2.0 } } },
          { id: 'n5', type: 'unitOp', position: { x: 980, y: 200 }, data: { label: 'Secondary Clarifier', opType: 'secondary_clarifier', params: { RAS_ratio: 0.5 } } },
          { id: 'n6', type: 'unitOp', position: { x:1160, y: 200 }, data: { label: 'Effluent Discharge', opType: 'outlet', params: {} } },
        ],
        edges: [
          { id: 'e0', source: 'n0', target: 'n1', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e1', source: 'n1', target: 'n2', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e2', source: 'n2', target: 'n3', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e3', source: 'n3', target: 'n4', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e4', source: 'n4', target: 'n5', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e5', source: 'n5', target: 'n6', type: 'stream', animated: true, data: { streamType: 'stream' } },
          { id: 'e6_ras', source: 'n5', target: 'n4', type: 'stream', animated: true, data: { streamType: 'ras', isRecycle: true } },
        ],
        viewport: { x: 0, y: 0, zoom: 0.8 },
      })]);
    console.log(`   ✔  Flowsheet     : Main Treatment Train`);

    // Flowsheet 2 (empty)
    await query(`
      INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
      VALUES ($1,$2,$3,$4,$5)
    `, [p1.id, engineer.id, 'Sludge Handling', 'Digestion + dewatering — to be designed',
      JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })]);
    console.log(`   ✔  Flowsheet     : Sludge Handling`);
  }

  // ── Demo Project 2: Industrial (engineer-owned) ───────────────────────────
  const { rows: proj2Rows } = await query(`
    INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags)
    VALUES ($1,$2,$3,$4,'water_purification',ARRAY['membrane','ro','demo'])
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [org.id, engineer.id, 'Industrial RO System', 'Reverse osmosis pre-treatment and permeate conditioning']);

  if (proj2Rows.length) {
    console.log(`   ✔  Project       : Industrial RO System (${proj2Rows[0].id})`);
    await query(`
      INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
      VALUES ($1,$2,$3,$4,$5)
    `, [proj2Rows[0].id, engineer.id, 'Pre-treatment Train', 'Coagulation → UF → RO',
      JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })]);
    console.log(`   ✔  Flowsheet     : Pre-treatment Train`);
  }

  console.log('\n✅  Seed complete!\n');
  console.log('   admin@watersim.dev          / Admin1234!');
  console.log('   engineer@watersim.dev       / Engineer1!');
  console.log('   operator@watersim.dev       / Operator1!\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('\n❌  Seed failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
