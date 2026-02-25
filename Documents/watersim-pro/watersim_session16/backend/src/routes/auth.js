const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { message: 'Too many auth attempts, please wait' } },
});

const registerRules = [
  body('orgName').trim().isLength({ min: 2, max: 100 }),
  body('orgSlug').trim().matches(/^[a-z0-9-]+$/).isLength({ min: 2, max: 50 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  body('firstName').trim().isLength({ min: 1, max: 100 }),
  body('lastName').trim().isLength({ min: 1, max: 100 }),
];

const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('orgSlug').trim().notEmpty(),
];

router.post('/register',    authLimiter, registerRules, authController.register);
router.post('/login',       authLimiter, loginRules,    authController.login);
router.post('/refresh',                                  authController.refresh);
router.post('/logout',                                   authController.logout);
router.post('/logout-all',  authenticate,                authController.logoutAll);
router.get('/me',           authenticate,                authController.me);

module.exports = router;
