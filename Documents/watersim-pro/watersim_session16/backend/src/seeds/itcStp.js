/**
 * SafeKrit — ITC sewage treatment plant seed.
 *
 * Creates the plant as a working project: the organisation, its users, the full
 * flowsheet from the schematic, the reuse permit template, and alarm rules
 * taken from the setpoints the control narrative actually states.
 *
 * Run as part of `npm run seed`; also importable so tests and the demo seed can
 * call `seedItcStp(client)` on their own connection.
 *
 * ── WHY THE ALARM RULES ARE WORTH SEEDING ────────────────────────────────────
 * The control narrative names exactly four numeric setpoints — the chlorine
 * band, the sludge-transfer trigger, the level setpoints, and the pH the filters
 * are monitored on. Seeding those as alarm rules is what turns a document into a
 * plant you can watch: each rule cites the slide it came from in its name, so an
 * operator who challenges an alarm can be shown where the number was agreed.
 *
 * Only rules on targets the flowsheet genuinely exposes are created — the same
 * validation `alarms/validTargets.js` applies — so this seed can never create a
 * rule the alarm evaluator will silently ignore.
 */
'use strict';

const bcrypt = require('bcryptjs');
const plant = require('../plants/itcStp');
const { isValidTarget } = require('../alarms/validTargets');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

const ORG = { name: 'ITC — Sewage Treatment Plant', slug: 'itc-stp' };

const USERS = [
  // Every kind of user has a phone number, so each role can be reached on
  // WhatsApp as well as by email (Settings → Notifications → Receivers).
  { email: 'admin@itc-stp.local', password: 'Admin1234!', first: 'Plant', last: 'Administrator', role: 'admin', phone: '+919800000000' },
  // The manager is the role that approves maintenance tasks and acknowledges
  // critical alarms (Phase 2). It needs migration 009 to have committed before
  // this seed runs — which it has, because migrations always run first.
  { email: 'manager@itc-stp.local', password: 'Manager1!', first: 'Plant', last: 'Manager', role: 'manager', phone: '+919800000001' },
  { email: 'engineer@itc-stp.local', password: 'Engineer1!', first: 'Process', last: 'Engineer', role: 'engineer', phone: '+919800000002' },
  { email: 'operator@itc-stp.local', password: 'Operator1!', first: 'Shift', last: 'Operator', role: 'operator', phone: '+919800000003' },
  { email: 'viewer@itc-stp.local', password: 'Viewer123!', first: 'Plant', last: 'Viewer', role: 'viewer', phone: '+919800000004' },
];

/**
 * Who hears what (Phase 2): the platform's default policy, one set of rows per
 * role (notifications/defaults.js), so viewer, operator, engineer, manager and
 * admin each hear what their role needs. The assignee of a task always hears
 * about their own assignment regardless of this table.
 */
const { DEFAULT_POLICY, installDefaultPolicy } = require('../notifications/defaults');

/**
 * Alarm rules from the narrative's own setpoints.
 *
 * `source` is carried into the rule name so the provenance survives into the
 * alarm event, the CSV export and the PDF report.
 */
const ALARM_RULES = [
  // Same category error as the reactor rules had: `high_level_pct` is the
  // setpoint itself, so a limit of 90 on a value of 90 can never fire. What is
  // worth watching on the balancing tank is its STRENGTH — every backwash,
  // centrate and spent-backwash return lands here, so a climb in solids means
  // something upstream is recycling more than it should.
  {
    name: 'EQT solids climbing — a return line is loading the balance tank (slide 4)',
    targetType: 'node_output', nodeId: 'eqt', paramKey: 'TSS',
    max: 350, severity: 'warning',
  },
  // These two watch the reactors' DECANT QUALITY, not their cycle times.
  //
  // The first version of these rules put a `min: 1.5` on the `fill_h` parameter,
  // whose value is exactly 1.5 — a limit equal to the thing it watches, on a
  // static setpoint that the solver never changes. They could not fire, ever,
  // and would have sat dead on the alarm page. An alarm on a setpoint is a
  // category error: it watches what you typed, not what the plant did.
  //
  // Decant TSS is the number that actually moves and actually matters: it is the
  // reactor's effluent, everything downstream is sized against it, and it is the
  // first thing to degrade if the settle phase is shortened to chase capacity.
  {
    name: 'R1 decant carrying solids — settling degraded (slide 22)',
    targetType: 'node_output', nodeId: 'r1', paramKey: 'TSS',
    max: 30, severity: 'critical',
  },
  {
    name: 'R2 decant carrying solids — settling degraded (slide 22)',
    targetType: 'node_output', nodeId: 'r2', paramKey: 'TSS',
    max: 30, severity: 'critical',
  },
  {
    name: 'Filtered water pH out of band (slide 9 · AT-601)',
    targetType: 'node_output', nodeId: 'at_601', paramKey: 'pH',
    min: 6.5, max: 8.5, severity: 'warning',
  },
  {
    name: 'Cooling tower feed TSS above reuse criteria (slide 14)',
    targetType: 'node_output', nodeId: 'ft_swt', paramKey: 'TSS',
    max: 10, severity: 'critical',
  },
  {
    name: 'Irrigation feed BOD above reuse criteria (slide 12)',
    targetType: 'node_output', nodeId: 'ft_irr', paramKey: 'BOD',
    max: 10, severity: 'warning',
  },
  {
    name: 'Flushing water TSS above reuse criteria (slide 13)',
    targetType: 'node_output', nodeId: 'ft_fwt', paramKey: 'TSS',
    max: 10, severity: 'critical',
  },
  {
    name: 'Softener regenerating too often — resin undersized (slide 10)',
    targetType: 'param', nodeId: 'sof', paramKey: 'feed_hardness_ppm',
    max: 300, severity: 'warning',
  },
  {
    name: 'Plant discharge BOD above reuse criteria',
    targetType: 'effluent', nodeId: null, paramKey: 'BOD',
    max: 10, severity: 'critical',
  },
  {
    name: 'Plant discharge TSS above reuse criteria',
    targetType: 'effluent', nodeId: null, paramKey: 'TSS',
    max: 10, severity: 'critical',
  },
  // The one alarm a value can never raise: the PLC going quiet. Watches the
  // reactor feed flow meter's bound point; fires when no good sample has
  // arrived for 30 s (disable the demo simulator connection to see it).
  {
    name: 'RFP-FT-201 comms loss — no PLC sample for 30 s',
    targetType: 'param', nodeId: 'ft_201', paramKey: 'measured',
    kind: 'quality', staleAfterS: 30, severity: 'critical',
  },
  // The twin's own alarm: the model and the transmitter disagree beyond
  // three standard deviations of their usual difference.
  {
    name: 'RFP-FT-201 drift — model and plant disagree (twin)',
    targetType: 'param', nodeId: 'ft_201', paramKey: 'measured',
    kind: 'drift', max: 3, severity: 'warning',
  },
];

/**
 * The canvas parameter a signal tag writes into, when it has one. Analogue
 * inputs land on the instrument's `measured` (flow, pH) or the vessel's
 * `level_pct`; a run-status contact lands on `running`. Everything else
 * (valve limit switches, trips, commands) has no parameter and is history
 * only.
 */
function demoParamKey(signalType, fn) {
  if (signalType === 'AI') return fn === 'LT' ? 'level_pct' : 'measured';
  if (signalType === 'DI' && fn === 'XS') return 'running';
  if (signalType === 'DI' && fn === 'ZSO') return 'opened';
  if (signalType === 'DO' && fn === 'XY') return 'run_cmd';
  return null;
}

/**
 * The simulator's writable register for a drive: its run-status contact reads
 * the register that its run command writes, so a Start from the live screen
 * comes back as "running" on the next poll — the closed loop the demo needs.
 */
const demoRegister = (t) => `mem:${t.loop_tag}/${t.unit || 1}.run`;

/** Nominal spans for the demo simulator, per flow meter (m³/d). */
const DEMO_FLOW_SPAN = {
  'RFP-FT-201': [520, 720], 'FFP-FT-501': [350, 520], 'SOF-FT-701': [150, 300],
  'HWT-FT-901': [80, 160], 'FWT-FT-1001': [60, 140], 'SWT-FT-1101': [150, 300],
};

/**
 * A simulator address that looks like the real point would: slow, in range.
 * `hasCommand` says the drive also has a bound run command, in which case its
 * status reads the shared register instead of a free-running square wave.
 */
function demoAddress(t, i, hasCommand = false) {
  const period = (base, step) => base + ((i * step) % 900);
  if (t.signal_type === 'AI') {
    if (t.fn === 'LT') return `sine:35,85,${period(1200, 97)}`;
    if (t.fn === 'AT') return `sine:6.9,7.6,${period(1800, 61)}`;
    const [lo, hi] = DEMO_FLOW_SPAN[t.loop_tag] || [100, 400];
    return `sine:${lo},${hi},${period(600, 137)}`;
  }
  if (t.signal_type === 'DI' && ['XS', 'ZSO'].includes(t.fn)) return hasCommand ? demoRegister(t) : `step:0,1,${period(900, 53)}`;
  if (t.signal_type === 'DO' && t.fn === 'XY') return demoRegister(t);
  return null;
}

/**
 * The demo PLC: the built-in simulator, bound to every point that has a
 * canvas parameter, so the historian fills and the trends page has something
 * to show the moment the server starts. Idempotent: the connection upserts on
 * its name and each binding on its (flowsheet, node, param).
 */
async function seedDemoBindings(query, org, flowsheetId, adminId, log) {
  const { rows: [conn] } = await query(`
    INSERT INTO plc_connections (organisation_id, name, protocol, config, enabled, created_by)
    VALUES ($1, $2, 'simulator', '{}'::jsonb, TRUE, $3)
    ON CONFLICT (organisation_id, name) DO UPDATE SET enabled = TRUE
    RETURNING id
  `, [org.id, 'ITC STP — Simulator (demo signals)', adminId]);

  const { rows: tags } = await query(`
    SELECT id, tag, loop_tag, fn, unit, node_id, param_key, signal_type FROM tags
     WHERE organisation_id = $1 AND flowsheet_id = $2 AND param_key IS NOT NULL AND node_id IS NOT NULL
     ORDER BY tag
  `, [org.id, flowsheetId]);

  // A drive is closed-loop when BOTH its status and its command land on the
  // same node (one drive per node gets the loop; the rest keep a free-running
  // status so the screen still shows movement).
  const commandKeys = new Set(tags.filter((t) => t.param_key === 'run_cmd').map((t) => `${t.loop_tag}/${t.unit || 1}`));
  const seen = new Set();
  let n = 0;
  for (const [i, t] of tags.entries()) {
    const key = `${t.node_id}|${t.param_key}`;
    if (seen.has(key)) continue; // one binding per (node, param): the second unit of a pair is history only
    const hasCommand = commandKeys.has(`${t.loop_tag}/${t.unit || 1}`);
    const address = demoAddress(t, i, hasCommand);
    if (!address) continue;
    seen.add(key);
    const direction = t.param_key === 'run_cmd' ? 'write' : 'read';
    // The first unit of every drive and every valve is commanded ON to begin
    // with, so the plant boots running; the poller restores these commanded
    // values into the simulator's registers on every start. A value someone
    // has since commanded is never overwritten.
    const initialCommand = direction === 'write' ? 1 : null;
    const r = await query(`
      INSERT INTO plc_bindings
        (organisation_id, flowsheet_id, node_id, param_key, connection_id, address,
         direction, poll_interval_ms, enabled, tag_id, last_value, quality, last_read_at)
      VALUES ($1,$2,$3,$4,$5,$6,$8,5000,TRUE,$7,$9,
              CASE WHEN $9::float8 IS NULL THEN 'unknown' ELSE 'good' END,
              CASE WHEN $9::float8 IS NULL THEN NULL ELSE NOW() END)
      ON CONFLICT (flowsheet_id, node_id, param_key)
        DO UPDATE SET tag_id = COALESCE(plc_bindings.tag_id, EXCLUDED.tag_id),
                      address = EXCLUDED.address, direction = EXCLUDED.direction,
                      last_value = COALESCE(plc_bindings.last_value, EXCLUDED.last_value)
      RETURNING id
    `, [org.id, flowsheetId, t.node_id, t.param_key, conn.id, address, t.id, direction, initialCommand]);
    n += r.rowCount;
  }
  log(`   ✔  Demo PLC      : simulator bound to ${n} points (${tags.length} candidates)`);
  return n;
}

/**
 * @param {(text: string, params?: any[]) => Promise<{rows: any[]}>} query
 * @param {(msg: string) => void} [log]
 */
async function seedItcStp(query, log = console.log) {
  const canvasData = plant.flowsheet.buildFlowsheet();

  // ── Organisation ─────────────────────────────────────────────────────────
  const { rows: [org] } = await query(`
    INSERT INTO organisations (name, slug)
    VALUES ($1, $2)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, name, slug
  `, [ORG.name, ORG.slug]);
  log(`   ✔  Organisation  : ${org.name}  (${org.slug})`);

  // ── Users ────────────────────────────────────────────────────────────────
  const created = {};
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, ROUNDS);
    const { rows: [row] } = await query(`
      INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role, email_verified, phone_e164)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7)
      ON CONFLICT (email, organisation_id)
        DO UPDATE SET password_hash = EXCLUDED.password_hash, email_verified = true,
                      phone_e164 = COALESCE(users.phone_e164, EXCLUDED.phone_e164)
      RETURNING id, email, role
    `, [org.id, u.email, hash, u.first, u.last, u.role, u.phone || null]);
    created[u.role] = row;
    log(`   ✔  ${u.role.padEnd(9)}    : ${row.email}  /  ${u.password}`);
  }
  const admin = created.admin;

  // ── Permit template — the reuse criteria, marked unconfirmed ─────────────
  // The proposal states no limits at all, so this template is explicitly a
  // placeholder. Its name says so, because an operator reading a pass/fail
  // verdict deserves to know the yardstick has not been agreed.
  await query(`
    INSERT INTO permit_templates (organisation_id, created_by, name, description, is_active, permit_limits)
    VALUES ($1,$2,$3,$4,TRUE,$5::jsonb)
    ON CONFLICT DO NOTHING
  `, [
    org.id, admin.id,
    plant.REUSE_CRITERIA.name,
    plant.REUSE_CRITERIA.basis,
    JSON.stringify(plant.REUSE_CRITERIA.limits),
  ]);
  log(`   ✔  Permit        : ${plant.REUSE_CRITERIA.name}`);

  // ── Project + flowsheet: found if present, created if not ────────────────
  // `projects` has no unique key on its name, so the old ON CONFLICT could
  // never fire and every re-run added another copy. Look first, then insert.
  const PROJECT_NAME = 'ITC STP — Monitoring & Control';
  const FLOWSHEET_NAME = 'ITC STP — Full plant';
  let project;
  let flowsheet;
  const found = await query(
    `SELECT id FROM projects WHERE organisation_id = $1 AND name = $2 AND status != 'deleted'
      ORDER BY created_at LIMIT 1`,
    [org.id, PROJECT_NAME]
  );
  if (found.rows[0]) {
    project = found.rows[0];
    const fs = await query(
      'SELECT id FROM flowsheets WHERE project_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
      [project.id, FLOWSHEET_NAME]
    );
    flowsheet = fs.rows[0] || null;
    log(`   ·  Project       : already present (${project.id}) — canvas left untouched`);
  } else {
    const { rows: [p] } = await query(`
      INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags)
      VALUES ($1,$2,$3,$4,'wastewater',ARRAY['itc','stp','sbr','reuse'])
      RETURNING id
    `, [
      org.id, admin.id, PROJECT_NAME,
      `${plant.IDENTITY.objective}. Client ${plant.IDENTITY.client}, contractor ${plant.IDENTITY.contractor}, `
        + `sub-contractor ${plant.IDENTITY.subContractor}. Design flow ${plant.IDENTITY.designFlowKld} KLD.`,
    ]);
    project = p;
    log(`   ✔  Project       : ${PROJECT_NAME}  (${project.id})`);

    const { rows: [f] } = await query(`
      INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id
    `, [
      project.id, admin.id, FLOWSHEET_NAME,
      'The schematic on slide 3: three influents through the SBR reactors, filtration and softening '
        + 'to the cooling tower, irrigation and flushing lines, with the sludge train and every backwash return.',
      JSON.stringify(canvasData),
    ]);
    flowsheet = f;
    log(`   ✔  Flowsheet     : ${FLOWSHEET_NAME} (${canvasData.nodes.length} nodes, ${canvasData.edges.length} streams)`);
  }
  // The plant is a MONITORING project: it is what Operations watches and
  // controls. The twin is a separate project, imported from it (below).
  await query(`UPDATE projects SET kind = 'monitoring' WHERE id = $1 AND kind <> 'monitoring'`, [project.id]);
  if (!flowsheet) {
    log('   ⚠  Flowsheet missing on the existing project — alarms, tags and bindings skipped');
    return { org, project, flowsheet: null, alarmRules: 0, tags: 0, bindings: 0 };
  }

  // ── Alarm rules ──────────────────────────────────────────────────────────
  // Validated against the canvas with the same function the API uses, so a rule
  // whose target does not exist is skipped loudly rather than seeded dead.
  let ruleCount = 0;
  for (const r of ALARM_RULES) {
    const valid = isValidTarget(canvasData, {
      targetType: r.targetType, nodeId: r.nodeId, paramKey: r.paramKey,
    });
    if (!valid) {
      log(`   ⚠  Alarm skipped : "${r.name}" — ${r.nodeId || 'effluent'}.${r.paramKey} is not a valid target on this canvas`);
      continue;
    }
    const kind = r.kind || (r.min != null && r.max != null ? 'range' : r.max != null ? 'high' : 'low');
    if (kind === 'drift' && r.min != null) throw new Error('drift rules take max only');
    // Idempotent through uq_alarm_rules_target (flowsheet, target, kind).
    const ins = await query(`
      INSERT INTO alarm_rules
        (organisation_id, flowsheet_id, name, target_type, node_id, param_key, min_value, max_value,
         severity, created_by, kind, stale_after_s,
         tag_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
              (SELECT id FROM tags WHERE flowsheet_id = $2 AND node_id = $5 AND param_key = $6 LIMIT 1))
      ON CONFLICT DO NOTHING
    `, [
      org.id, flowsheet.id, r.name, r.targetType, r.nodeId, r.paramKey,
      r.min ?? null, r.max ?? null, r.severity, admin.id, kind, r.staleAfterS ?? null,
    ]);
    ruleCount += ins.rowCount;
  }
  log(`   ✔  Alarm rules   : ${ruleCount} seeded from the control narrative's own setpoints`);

  // ── Tag registry ─────────────────────────────────────────────────────────
  // Every wired point of the plant, as an ISA-5.1 signal tag, linked to the
  // canvas node that carries its device. This is the identity that Phase 1's
  // historian, Phase 2's tasks and Phase 5's CMMS boundary all key on.
  const { validateSignalTag } = require('../tags/isa');
  const rows = plant.ioSchedule.buildTagList();
  const nodeOfDevice = new Map();
  for (const n of canvasData.nodes) {
    for (const t of n.data.tags || []) if (!nodeOfDevice.has(t)) nodeOfDevice.set(t, n.id);
  }
  let tagCount = 0;
  for (const r of rows) {
    const v = validateSignalTag(r.tag);
    if (!v.ok) { log(`   ⚠  Tag skipped   : ${r.tag} — ${v.reason}`); continue; }
    const p = v.parsed;
    // A re-run fills in what an older seed did not know (the canvas parameter,
    // the node) without ever touching a value a person has since edited.
    const { rowCount } = await query(`
      INSERT INTO tags
        (organisation_id, flowsheet_id, tag, loop_tag, area, code, loop_no, unit, fn, fn_suffix,
         signal_type, kind, name, signal, description, node_id, plc_node, created_by, param_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (organisation_id, tag) DO UPDATE SET
        node_id   = COALESCE(tags.node_id, EXCLUDED.node_id),
        param_key = COALESCE(tags.param_key, EXCLUDED.param_key)
    `, [
      org.id, flowsheet.id, r.tag, p.loopTag, p.device.area, p.device.code, p.device.loop,
      p.unit, p.fn, p.suffix, r.type, r.kind, r.device, r.signal, r.description,
      nodeOfDevice.get(r.deviceTag) || null, r.node, admin.id,
      demoParamKey(r.type, p.fn),
    ]);
    tagCount += rowCount;
  }
  log(`   ✔  Tag registry  : ${tagCount} ISA-5.1 signal tags (${rows.length} in the schedule)`);

  // ── Demo PLC bindings ────────────────────────────────────────────────────
  const bindings = await seedDemoBindings(query, org, flowsheet.id, admin.id, log);

  // ── Task policy on the rules, and who is told ────────────────────────────
  // Critical rules raise a task for an engineer, due in 4 h, needing the
  // manager's approval; warnings raise one due in 24 h. Idempotent.
  await query(`
    UPDATE alarm_rules SET create_task = TRUE, task_assignee_role = 'engineer', task_requires_approval = TRUE,
           task_due_within_h = CASE severity WHEN 'critical' THEN 4 ELSE 24 END
     WHERE organisation_id = $1 AND flowsheet_id = $2 AND severity IN ('critical', 'warning')
  `, [org.id, flowsheet.id]);
  let subCount = 0;
  subCount = (await installDefaultPolicy(org.id, admin.id)).added;
  log(`   ✔  Notifications : ${subCount} policy rows added (${DEFAULT_POLICY.length} defined, every role); critical + warning rules raise tasks`);

  // ── The twin: its own project, imported from the plant, running every 30 s ─
  const twinFlowsheet = await ensureTwinProject(query, org, admin, project, flowsheet, log);
  await query(`UPDATE twin_config SET enabled = FALSE WHERE flowsheet_id = $1 AND enabled = TRUE`, [flowsheet.id]);
  await query(`
    INSERT INTO twin_config (flowsheet_id, organisation_id, enabled, cadence_s, drift_z, updated_by)
    VALUES ($1, $2, TRUE, 30, 3, $3)
    ON CONFLICT (flowsheet_id) DO UPDATE SET enabled = TRUE
  `, [twinFlowsheet.id, org.id, admin.id]);
  log(`   ✔  Digital twin  : ${TWIN_PROJECT_NAME} — runs every 30 s on the plant's measurements, drift at |z| > 3`);

  return { org, project, flowsheet, twinFlowsheet, alarmRules: ruleCount, tags: tagCount, bindings, subscriptions: subCount };
}

const TWIN_PROJECT_NAME = 'ITC STP — Digital twin';

/**
 * The twin project for the plant: a TWIN-kind project imported from the
 * monitoring project, its flowsheet a copy linked to the live one through
 * `source_flowsheet_id` so the twin loop reads the plant's measurements.
 * Idempotent: found by (kind, source_project_id), then by source flowsheet.
 */
async function ensureTwinProject(query, org, admin, project, flowsheet, log) {
  const found = await query(
    `SELECT id FROM projects WHERE organisation_id = $1 AND kind = 'twin' AND source_project_id = $2 AND status != 'deleted'
      ORDER BY created_at LIMIT 1`,
    [org.id, project.id]
  );
  let twin = found.rows[0];
  if (!twin) {
    const { rows: [p] } = await query(`
      INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags, kind, source_project_id)
      VALUES ($1,$2,$3,$4,'wastewater',ARRAY['itc','stp','twin'],'twin',$5)
      RETURNING id
    `, [
      org.id, admin.id, TWIN_PROJECT_NAME,
      'The model that runs beside the plant. Imported from the monitoring project; solved every 30 s with the '
        + "plant's measured values merged in, and compared with its transmitters.",
      project.id,
    ]);
    twin = p;
    log(`   ✔  Twin project  : ${TWIN_PROJECT_NAME} (${twin.id}) — imported from the plant`);
  }
  const fs = await query(
    'SELECT id FROM flowsheets WHERE project_id = $1 AND source_flowsheet_id = $2 ORDER BY created_at LIMIT 1',
    [twin.id, flowsheet.id]
  );
  if (fs.rows[0]) return fs.rows[0];
  const { rows: [f] } = await query(`
    INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data, source_flowsheet_id)
    SELECT $1, $2, name, description, canvas_data, id FROM flowsheets WHERE id = $3
    RETURNING id
  `, [twin.id, admin.id, flowsheet.id]);
  return f;
}

module.exports = { seedItcStp, ORG, USERS, ALARM_RULES, DEFAULT_POLICY };
