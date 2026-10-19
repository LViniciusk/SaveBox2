import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-video',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env['NANIKA_E2E_BASE_URL'] ?? 'http://localhost:4200',
    video: 'off',
    trace: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium-video', use: { ...devices['Desktop Chrome'] } }],
});
