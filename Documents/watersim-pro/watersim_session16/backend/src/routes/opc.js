/**
 * WaterSim Pro — OPC REST API Routes (UA + DA)
 *
 * UA routes (OPC-UA / node-opcua):
 *   POST /discover     — discover OPC-UA servers on a host
 *   POST /connect      — connect to OPC-UA server
 *   POST /disconnect   — disconnect from OPC-UA server
 *   POST /browse       — browse server namespace
 *   POST /read         — read tag values
 *   POST /write        — write tag values
 *   GET  /status       — get connection status
 *
 * DA routes (OPC DA / DCOM):
 *   POST /da/discover  — discover OPC DA servers (registry scan)
 *   POST /da/connect   — connect to OPC DA server by CLSID
 *   POST /da/disconnect— disconnect from OPC DA server
 *   POST /da/browse    — browse DA server tags (flat)
 *   POST /da/read      — read DA tag values
 *   POST /da/write     — write DA tag values (PowerShell bridge)
 */

'use strict';

const { Router } = require('express');
const opcClient = require('../opc/opcClient');
const opcDaClient = require('../opc/opcDaClient');

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// OPC UA Routes
// ═══════════════════════════════════════════════════════════════════════════════

// ── Discover UA Servers ──────────────────────────────────────────────────────

router.post('/discover', async (req, res) => {
  try {
    const { hostname } = req.body;
    const servers = await opcClient.discoverServers(hostname || 'localhost');
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connect ──────────────────────────────────────────────────────────────────

router.post('/connect', async (req, res) => {
  try {
    const { endpointUrl } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });

    const result = await opcClient.connect(endpointUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Disconnect ───────────────────────────────────────────────────────────────

router.post('/disconnect', async (req, res) => {
  try {
    const { endpointUrl } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });

    await opcClient.disconnect(endpointUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Browse ───────────────────────────────────────────────────────────────────

router.post('/browse', async (req, res) => {
  try {
    const { endpointUrl, nodeId } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });

    const nodes = await opcClient.browse(endpointUrl, nodeId || undefined);
    res.json({ nodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Read ─────────────────────────────────────────────────────────────────────

router.post('/read', async (req, res) => {
  try {
    const { endpointUrl, tagIds } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });
    if (!tagIds || !Array.isArray(tagIds) || tagIds.length === 0) {
      return res.status(400).json({ error: 'tagIds array is required' });
    }

    const values = await opcClient.read(endpointUrl, tagIds);
    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Write ────────────────────────────────────────────────────────────────────

router.post('/write', async (req, res) => {
  try {
    const { endpointUrl, tags } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: 'tags array is required' });
    }

    const results = await opcClient.write(endpointUrl, tags);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Status ───────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const { endpointUrl } = req.query;
  if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl query param is required' });

  const status = opcClient.getStatus(endpointUrl);
  res.json(status);
});

// ── DA Status ────────────────────────────────────────────────────────────────

router.get('/da/status', async (req, res) => {
  try {
    const { progId, address } = req.query;
    if (!progId) return res.status(400).json({ error: 'progId query param is required' });

    const status = await opcDaClient.getStatus(progId, address);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPC DA Routes
// ═══════════════════════════════════════════════════════════════════════════════

// ── Discover DA Servers ──────────────────────────────────────────────────────

router.post('/da/discover', async (req, res) => {
  try {
    const { hostname } = req.body;
    const servers = await opcDaClient.discoverDaServers(hostname || 'localhost');
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DA Connect ───────────────────────────────────────────────────────────────

router.post('/da/connect', async (req, res) => {
  try {
    const { progId, address, credentials } = req.body;
    if (!progId) return res.status(400).json({ error: 'progId is required' });

    const result = await opcDaClient.connect(progId, address, credentials);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DA Disconnect ────────────────────────────────────────────────────────────

router.post('/da/disconnect', async (req, res) => {
  try {
    const { progId, address } = req.body;
    if (!progId) return res.status(400).json({ error: 'progId is required' });

    await opcDaClient.disconnect(progId, address);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DA Browse ────────────────────────────────────────────────────────────────

router.post('/da/browse', async (req, res) => {
  try {
    const { progId, address } = req.body;
    if (!progId) return res.status(400).json({ error: 'progId is required' });

    const nodes = await opcDaClient.browse(progId, address);
    res.json({ nodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DA Read ──────────────────────────────────────────────────────────────────

router.post('/da/read', async (req, res) => {
  try {
    const { progId, address, tagIds } = req.body;
    if (!progId) return res.status(400).json({ error: 'progId is required' });
    if (!tagIds || !Array.isArray(tagIds) || tagIds.length === 0) {
      return res.status(400).json({ error: 'tagIds array is required' });
    }

    const values = await opcDaClient.read(progId, address, tagIds);
    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DA Write ─────────────────────────────────────────────────────────────────

router.post('/da/write', async (req, res) => {
  try {
    const { progId, address, tags } = req.body;
    if (!progId) return res.status(400).json({ error: 'progId is required for DA write' });
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: 'tags array is required' });
    }

    const results = await opcDaClient.write(progId, address, tags);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
