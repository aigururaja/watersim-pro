// Runs before every test file (jest "setupFiles").
// Pins the test environment portably (Windows shells can't do `NODE_ENV=test npx jest`),
// which disables rate limiters and production-only behaviour during tests.
process.env.NODE_ENV = 'test';
