// ─────────────────────────────────────────────────────────────────────────────
// WaterSim Pro — e2e smoke test (login → dashboard → project → reports).
//
// NEVER EXECUTED YET in this repo: Playwright browsers were deliberately not
// downloaded during scaffolding. Requires the seeded demo data
// (npm run db:migrate && npm run db:seed) which creates the demo-org admin
// account used below. See playwright.config.js for first-run instructions.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, expect } = require('@playwright/test');

const ADMIN = {
  orgSlug: 'demo-org',
  email: 'admin@watersim.dev',
  password: 'Admin1234!',
};

test.describe('smoke: login → dashboard → project → reports', () => {
  test('logs in with the seeded admin and reaches the reports page', async ({ page }) => {
    // ── Login page renders ───────────────────────────────────────────────────
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'WaterSim Pro' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

    // ── Login with the seeded demo-org admin ─────────────────────────────────
    await page.getByLabel('Organisation').fill(ADMIN.orgSlug);
    await page.getByLabel('Email address').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // ── Dashboard visible ────────────────────────────────────────────────────
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();

    // ── Navigate to a project ────────────────────────────────────────────────
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.waitForURL('**/projects');
    // Open the first seeded project (any project card/link that routes to /projects/:id).
    const projectLink = page.locator('a[href^="/projects/"]:not([href="/projects/new"])').first();
    await expect(projectLink).toBeVisible();
    await projectLink.click();
    await page.waitForURL(/\/projects\/[0-9a-f-]+/i);

    // ── Open the reports page ────────────────────────────────────────────────
    await page.getByRole('link', { name: 'Reports' }).click();
    await page.waitForURL('**/reports');
    await expect(page).toHaveURL(/\/reports/);
  });
});
