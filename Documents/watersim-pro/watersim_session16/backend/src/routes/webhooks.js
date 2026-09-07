/**
 * WaterSim Pro — Inbound webhooks (no session; mounted before the API limiter)
 *
 * Mounted at: /api/v1/webhooks
 *
 *   GET  /webhooks/whatsapp   Meta's one-time verification handshake: echoes
 *                             hub.challenge when hub.verify_token matches
 *                             WHATSAPP_VERIFY_TOKEN, else 403.
 *   POST /webhooks/whatsapp   Live events from the WhatsApp Cloud API —
 *                             delivery statuses onto the outbox, inbound
 *                             messages mark the number verified. Always 200
 *                             once the signature (if WHATSAPP_APP_SECRET is
 *                             set) checks out, or Meta retries and disables.
 *
 * Meta App Dashboard → WhatsApp → Configuration:
 *   Callback URL  https://<PUBLIC_HOST>/api/v1/webhooks/whatsapp
 *   Verify token  the value of WHATSAPP_VERIFY_TOKEN
 *   Fields        messages
 */
'use strict';

const express = require('express');
const whatsapp = require('../notifications/adapters/whatsapp');
const inbound = require('../notifications/inbound');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/whatsapp', (req, res) => {
  const challenge = whatsapp.verifyWebhook(req.query);
  if (challenge == null) {
    logger.warn('WhatsApp webhook verification refused', { mode: req.query['hub.mode'], tokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN });
    return res.status(403).type('text/plain').send('Verification failed');
  }
  logger.info('WhatsApp webhook verified by Meta');
  return res.status(200).type('text/plain').send(challenge);
});

router.post('/whatsapp', async (req, res) => {
  if (!whatsapp.signatureOk(req.rawBody, req.get('X-Hub-Signature-256'))) {
    logger.warn('WhatsApp webhook signature mismatch');
    return res.status(401).json({ error: 'Bad signature' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.object && body.object !== 'whatsapp_business_account') return res.json({ status: 'ignored' });
  const result = await inbound.processWebhook(body);
  return res.json({ status: 'ok', ...result });
});

module.exports = router;
