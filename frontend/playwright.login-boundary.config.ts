import { resolve, isAbsolute } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { resolveE2EBackendOrigin } from './tools/e2e-backend-routing.mjs';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('M20 required configuration is missing.');
  return value;
}

function localOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('M20 local authority configuration is invalid.');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !parsed.port || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash
  ) {
    throw new Error('M20 local authority configuration is invalid.');
  }
  return parsed.origin;
}

const baseURL = localOrigin(required('NANIKA_E2E_BASE_URL'));
const backendURL = localOrigin(required('NANIKA_E2E_BACKEND_URL'));
if (resolveE2EBackendOrigin(process.env) !== backendURL) {
  throw new Error('M20 backend authority configuration is inconsistent.');
}

const resultPath = resolve(required('NANIKA_M20_RESULT_PATH'));
const expectedResultPath = resolve(
  process.cwd(),
  '../.quality/b90-r1m20-angular-login-boundary/real-probe/login-result.json',
);
if (resultPath !== expectedResultPath) throw new Error('M20 result destination is invalid.');

const outputDir = required('NANIKA_M20_PLAYWRIGHT_OUTPUT_DIR');
if (!isAbsolute(outputDir)) throw new Error('M20 temporary output directory is invalid.');

const fixtureExecutable = required('NANIKA_E2E_FIXTURE_EXE');
const fixtureCwd = required('NANIKA_E2E_FIXTURE_CWD');
const storagePath = required('NANIKA_E2E_STORAGE_PATH');
const storageId = required('NANIKA_E2E_STORAGE_ID');
if (!isAbsolute(fixtureExecutable) || !isAbsolute(fixtureCwd) || !isAbsolute(storagePath) || !/^[0-9a-f]{64}$/.test(storageId)) {
  throw new Error('M20 fixture configuration is invalid.');
}

export default defineConfig({
  testDir: './e2e-probe',
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL,
    video: 'off',
    trace: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
