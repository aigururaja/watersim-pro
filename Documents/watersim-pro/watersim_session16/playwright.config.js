// ─────────────────────────────────────────────────────────────────────────────
// Playwright e2e scaffold for WaterSim Pro.
//
// STATUS: scaffold only — this suite has NEVER been executed in this repo
// (browsers were deliberately not downloaded). Before the first run:
//
//   npx playwright install chromium          # one-time browser download
//   npm run db:migrate && npm run db:seed    # seeded demo data (demo-org admin)
//   npm run e2e
//
// webServer entries reuse dev servers already running on 3001/5173 (so a local
// `npm run dev` session is left alone); otherwise Playwright starts them itself.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev --workspace=backend',
      url: 'http://localhost:3001/health/live',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace=frontend',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
