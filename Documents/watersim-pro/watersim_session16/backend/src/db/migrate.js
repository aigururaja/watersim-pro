/**
 * WaterSim Pro — Versioned Database Migration Runner
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks applied migrations in a `schema_migrations` table.
 * Migrations live in backend/src/db/migrations/*.js — each exports { id, up, down }.
 *
 * Usage:
 *   node src/db/migrate.js up        — run all pending migrations
 *   node src/db/migrate.js down      — roll back the last applied migration
 *   node src/db/migrate.js down:all  — roll back ALL migrations (destructive!)
 *   node src/db/migrate.js status    — print applied / pending migrations
 */

require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const { getClient } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`⚠  No migrations directory found at ${MIGRATIONS_DIR}`);
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .sort()
    .map(filename => {
      const m = require(path.join(MIGRATIONS_DIR, filename));
      if (!m.id || typeof m.up !== 'string' || typeof m.down !== 'string') {
        throw new Error(`Migration ${filename} must export { id, up: string, down: string }`);
      }
      return { filename, ...m };
    });
}

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          VARCHAR(255) PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(
    'SELECT id FROM schema_migrations ORDER BY applied_at ASC'
  );
  return new Set(rows.map(r => r.id));
}

async function cmdUp() {
  const client = await getClient();
  try {
    await ensureTrackingTable(client);
    const applied    = await getApplied(client);
    const migrations = loadMigrations();
    const pending    = migrations.filter(m => !applied.has(m.id));

    if (pending.length === 0) {
      console.log('✅  Database is up to date — no pending migrations.');
      return;
    }

    console.log(`▶  Running ${pending.length} pending migration(s)...`);
    for (const m of pending) {
      console.log(`   → ${m.id} (${m.filename})`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query(
          'INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)',
          [m.id, m.filename]
        );
        await client.query('COMMIT');
        console.log(`   ✓ ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.id} failed: ${err.message}`);
      }
    }
    console.log('✅  All migrations applied.');
  } finally {
    client.release();
  }
}

async function cmdDown(all = false) {
  const client = await getClient();
  try {
    await ensureTrackingTable(client);
    const applied    = await getApplied(client);
    const migrations = loadMigrations();

    const toRollback = migrations.filter(m => applied.has(m.id)).reverse();
    if (toRollback.length === 0) {
      console.log('✅  No applied migrations to roll back.');
      return;
    }

    const targets = all ? toRollback : [toRollback[0]];
    console.log(`▶  Rolling back ${targets.length} migration(s)...`);
    for (const m of targets) {
      console.log(`   → ${m.id} (${m.filename})`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE id = $1', [m.id]);
        await client.query('COMMIT');
        console.log(`   ✓ rolled back ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Rollback of ${m.id} failed: ${err.message}`);
      }
    }
    console.log('✅  Rollback complete.');
  } finally {
    client.release();
  }
}

async function cmdStatus() {
  const client = await getClient();
  try {
    await ensureTrackingTable(client);
    const applied    = await getApplied(client);
    const migrations = loadMigrations();

    console.log('\nMigration status:\n');
    console.log('  Status    ID');
    console.log('  ────────  ─────────────────────────────────────────────');
    for (const m of migrations) {
      const status = applied.has(m.id) ? '✓ applied' : '○ pending';
      console.log(`  ${status.padEnd(9)} ${m.id}`);
    }
    console.log(`\n  Applied: ${applied.size}  Pending: ${migrations.length - applied.size}\n`);
  } finally {
    client.release();
  }
}

async function main() {
  const cmd = process.argv[2] || 'up';
  try {
    switch (cmd) {
      case 'up':       await cmdUp();         break;
      case 'down':     await cmdDown(false);  break;
      case 'down:all': await cmdDown(true);   break;
      case 'status':   await cmdStatus();     break;
      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ ', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { cmdUp, cmdDown, cmdStatus };
