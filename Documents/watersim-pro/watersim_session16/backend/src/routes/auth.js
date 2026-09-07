const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(cookieParser());

// Failed sign-ins and registrations only: a successful login never eats into
// the budget, so a team behind one office IP is not locked out by using the app.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many auth attempts, please try again later' },
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => req.ip,
});

// NOTE: no normalizeEmail() here — it mangles addresses (e.g. strips gmail
// dots/plus tags) inconsistently with the rest of the app. Emails are
// normalized everywhere with trim().toLowerCase() instead.
const PASSWORD_STRENGTH = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

const registerRules = [
  body('orgName').trim().isLength({ min: 2, max: 100 }),
  body('orgSlug').trim().matches(/^[a-z0-9-]+$/).isLength({ min: 2, max: 50 }),
  body('email').trim().isEmail(),
  body('password').isLength({ min: 8 }).matches(PASSWORD_STRENGTH),
  body('firstName').trim().isLength({ min: 1, max: 100 }),
  body('lastName').trim().isLength({ min: 1, max: 100 }),
];

const loginRules = [
  body('email').trim().isEmail(),
  body('password').notEmpty(),
  body('orgSlug').trim().notEmpty(),
];

const changePasswordRules = [
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isLength({ min: 8 }).matches(PASSWORD_STRENGTH)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and a digit'),
];

// The login page reads the organisation list once per visit. Looser than the
// auth limiter so a reload never eats into the sign-in budget, still capped.
const listLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => req.ip,
});

router.get('/organisations',    listLimiter,                authController.listOrganisations);
router.post('/register',        authLimiter, registerRules, authController.register);
router.post('/login',           authLimiter, loginRules,    authController.login);
router.post('/refresh',                                     authController.refresh);
router.post('/logout',                                      authController.logout);
router.post('/logout-all',      authenticate,               authController.logoutAll);
router.post('/change-password', authenticate, changePasswordRules, authController.changePassword);
router.get('/me',               authenticate,               authController.me);

module.exports = router;
