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
