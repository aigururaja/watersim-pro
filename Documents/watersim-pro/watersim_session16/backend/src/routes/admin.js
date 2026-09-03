const express = require('express');
const { param, validationResult } = require('express-validator');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const admin = require('../controllers/admin.controller');

const router = express.Router();

// All admin routes require authentication
router.use(authenticate);

// :userId must be a UUID — reject garbage with 400 instead of letting
// Postgres throw 22P02 (invalid uuid input) as a 500.
const validateUserId = [
  param('userId').isUUID().withMessage('userId must be a valid UUID'),
  (req, res, next) => {
    const e = validationResult(req);
    if (!e.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: e.array() });
    next();
  },
];

// ── Organisation profile ──────────────────────────────────────────────────────
// Engineers can view, only admins can edit
router.get('/organisation',         requireRole('engineer'), admin.getOrganisation);
router.patch('/organisation',       requireAdmin,            admin.updateOrganisation);

// ── Stats ─────────────────────────────────────────────────────────────────────
// Admins and engineers can view stats
router.get('/stats',                requireRole('engineer'), admin.getStats);

// ── Member management ─────────────────────────────────────────────────────────
// List: engineers+ can see the team; mutate: admins only
router.get('/members',              requireRole('engineer'), admin.listMembers);
router.post('/members',             requireAdmin,            admin.inviteMember);
router.patch('/members/:userId',    requireAdmin, validateUserId, admin.updateMember);
router.post('/members/:userId/reset-password', requireAdmin, validateUserId, admin.resetMemberPassword);
router.delete('/members/:userId',   requireAdmin, validateUserId, admin.deleteMember);

module.exports = router;
