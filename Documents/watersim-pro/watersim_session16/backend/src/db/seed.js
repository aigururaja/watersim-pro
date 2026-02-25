/**
 * WaterSim Pro — Development Seed
 * Creates a demo organisation and admin user for local development.
 *
 * Run: node src/db/seed.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query } = require('./pool');

async function seed() {
  console.log('▶  Seeding development data...');

  // Demo organisation
  const orgResult = await query(`
    INSERT INTO organisations (name, slug, plan)
    VALUES ($1, $2, $3)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, ['WaterSim Demo Org', 'demo-org', 'professional']);

  const orgId = orgResult.rows[0].id;
  console.log(`   ✔  Organisation: ${orgId}`);

  // Admin user
  const passwordHash = await bcrypt.hash('Admin1234!', parseInt(process.env.BCRYPT_ROUNDS || '10'));
  const userResult = await query(`
    INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `, [orgId, 'admin@watersim.dev', passwordHash, 'Admin', 'User', 'admin', true]);

  const userId = userResult.rows[0].id;
  console.log(`   ✔  Admin user: ${userId}`);

  // Demo engineer user
  const engHash = await bcrypt.hash('Engineer1!', parseInt(process.env.BCRYPT_ROUNDS || '10'));
  await query(`
    INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [orgId, 'engineer@watersim.dev', engHash, 'Jane', 'Engineer', 'engineer', true]);
  console.log(`   ✔  Engineer user: engineer@watersim.dev`);

  // Demo project
  const projResult = await query(`
    INSERT INTO projects (organisation_id, created_by, name, description, project_type)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [orgId, userId, 'Municipal WWTP — Demo', 'Activated sludge demo plant for development testing', 'wastewater']);

  if (projResult.rows.length > 0) {
    const projId = projResult.rows[0].id;
    console.log(`   ✔  Demo project: ${projId}`);

    // Demo flowsheet
    await query(`
      INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
      VALUES ($1, $2, $3, $4, $5)
    `, [projId, userId, 'Main Treatment Train', 'Primary + secondary treatment flowsheet',
      JSON.stringify({
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    ]);
    console.log(`   ✔  Demo flowsheet created`);
  }

  console.log('\n✅  Seed complete.');
  console.log('   Login: admin@watersim.dev / Admin1234!');
  console.log('   Login: engineer@watersim.dev / Engineer1!');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌  Seed failed:', err.message);
  process.exit(1);
});
