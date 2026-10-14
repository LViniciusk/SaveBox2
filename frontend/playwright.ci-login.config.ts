import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-probe',
  testMatch: 'credential-login-boundary.spec.ts',
  outputDir: process.env['PLAYWRIGHT_OUTPUT_DIR'] ?? 'test-results/ci-login',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: process.env['NANIKA_E2E_BASE_URL'],
    trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
