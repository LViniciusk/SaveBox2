import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env['PLAYWRIGHT_OUTPUT_DIR'] ?? 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['PLAYWRIGHT_JSON_REPORT']
    ? [['json', { outputFile: '../.quality/playwright/results.json' }]]
    : [['list']],
  use: {
    baseURL: process.env['NANIKA_E2E_BASE_URL'] ?? 'http://localhost:4200',
    video: 'off',
    trace: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
