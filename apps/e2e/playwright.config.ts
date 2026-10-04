import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, ORIGIN_PORT, SETUP_TOKEN, WORKER_PORT } from './support/env';

/**
 * T2.8: Playwright against the real Worker (`wrangler dev`) with a mock origin server.
 * One worker process and one database serve the whole run, so specs run serially in one file
 * order. Chromium only: the CDP virtual authenticator is Chromium-specific (TDD §5.1).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0, // the journey creates the first operator once; a retry would find setup closed
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node mock-origin.mjs',
      url: `http://127.0.0.1:${String(ORIGIN_PORT)}/__requests`,
      reuseExistingServer: false,
      env: { MOCK_ORIGIN_PORT: String(ORIGIN_PORT) },
    },
    {
      command: 'node start-worker.mjs',
      url: `${BASE_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { E2E_WORKER_PORT: String(WORKER_PORT), E2E_SETUP_TOKEN: SETUP_TOKEN },
    },
  ],
});
