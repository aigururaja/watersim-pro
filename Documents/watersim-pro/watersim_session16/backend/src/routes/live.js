/**
 * Live device gateway routes.
 *
 *   GET  /api/v1/live/drivers  — which protocol drivers are installed
 *   POST /api/v1/live/test     — read a single binding once { protocol, config, scale }
 *   POST /api/v1/live/read     — read many bindings at once { bindings: [{ id, ... }] }
 */
'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { readBinding, driverStatus } = require('../live/gateway');

const router = express.Router();
router.use(authenticate);

router.get('/drivers', (req, res) => {
  res.json({ drivers: driverStatus() });
});

router.post('/test', async (req, res) => {
  const { protocol, config, scale } = req.body || {};
  if (!protocol) return res.status(400).json({ ok: false, error: 'protocol is required' });
  try {
    const r = await readBinding({ protocol, config, scale });
    res.json({ ok: true, raw: r.raw, value: r.value });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/read', async (req, res) => {
  const bindings = Array.isArray(req.body?.bindings) ? req.body.bindings : [];
  const values = await Promise.all(bindings.map(async (b) => {
    try { const r = await readBinding(b); return { id: b.id, ok: true, raw: r.raw, value: r.value }; }
    catch (e) { return { id: b.id, ok: false, error: e.message }; }
  }));
  res.json({ values });
});

module.exports = router;
