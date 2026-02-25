const express = require('express');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const admin = require('../controllers/admin.controller');

const router = express.Router();

// All admin routes require authentication
router.use(authenticate);

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
router.patch('/members/:userId',    requireAdmin,            admin.updateMember);
router.post('/members/:userId/reset-password', requireAdmin, admin.resetMemberPassword);
router.delete('/members/:userId',   requireAdmin,            admin.deleteMember);

module.exports = router;
