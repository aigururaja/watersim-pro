// Runs before every test file (jest "setupFiles").
// Pins the test environment portably (Windows shells can't do `NODE_ENV=test npx jest`),
// which disables rate limiters and production-only behaviour during tests.
process.env.NODE_ENV = 'test';

// The suite runs against its own database (`watersim_test`, or
// TEST_DATABASE_URL), never the one a running app is using — see
// scripts/testDbUrl.js and the global setup that creates and migrates it.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { testDbUrl } = require('./scripts/testDbUrl');
const url = testDbUrl();
if (url) process.env.DATABASE_URL = url;

// Never let a test reach a real provider. A developer's backend/.env (loaded
// above, and again by src/config when the app loads) may hold the plant's
// SMTP and WhatsApp credentials; the suites assert the "not configured" paths
// and inject fake transports themselves, and a real send from a test would
// reach a real phone or inbox. The keys are pinned to '' rather than deleted
// because dotenv fills in missing keys but never touches a set one — and only
// the credential keys, so defaults such as the country code stay defaults.
for (const key of [
  'SMTP_HOST', 'SMTP_SERVER', 'SMTP_USER', 'SMTP_USERNAME', 'SMTP_PASS', 'SMTP_PASSWORD',
  'SMTP_FROM', 'SMTP_FROM_EMAIL', 'FROM_EMAIL',
  'WHATSAPP_PROVIDER', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_TEMPLATES',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM',
]) process.env[key] = '';
