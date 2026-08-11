import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test as base, type APIRequestContext } from '@playwright/test';
import {
  generateCredentials,
  type E2ECredentials,
} from './session';
import {
  formatFixtureFailure,
  parseFixtureResponse,
} from '../../tools/e2e-fixture-diagnostics.mjs';
import {
  installE2EBackendRouting,
  resolveE2EBackendOrigin,
} from '../../tools/e2e-backend-routing.mjs';

const MAX_FIXTURE_STDOUT_CHARS = 16 * 1024;
const MAX_FIXTURE_STDERR_CHARS = 1024;

type E2EFixtures = {
  credentials: E2ECredentials;
};

function fixtureExecutable(): string {
  const override = process.env['NANIKA_E2E_FIXTURE_EXE'];
  if (override) return override;

  const candidates = process.platform === 'win32'
    ? [
        '../backend/build/nanika_e2e_fixture.exe',
        '../backend/build/Debug/nanika_e2e_fixture.exe',
        '../backend/build/Release/nanika_e2e_fixture.exe',
      ]
    : [
        '../backend/build/nanika_e2e_fixture',
        '../backend/build-e2e/nanika_e2e_fixture',
      ];
  const found = candidates.map(path => resolve(process.cwd(), path)).find(existsSync);
  if (!found) {
    throw new Error('E2E fixture executable not found. Build with BUILD_TESTS=ON and target nanika_e2e_fixture.');
  }
  return found;
}

function fixtureStorage(): { path: string; identity: string } {
  const configuredPath = process.env['NANIKA_E2E_STORAGE_PATH'];
  const identity = process.env['NANIKA_E2E_STORAGE_ID'];
  if (!configuredPath || !isAbsolute(configuredPath) || !identity || !/^[0-9a-f]{64}$/.test(identity)) {
    throw new Error('An isolated E2E storage path and identity are required.');
  }

  const path = resolve(configuredPath);
  try {
    const root = lstatSync(path);
    const markerPath = join(path, '.nanika-e2e-storage-id');
    const marker = lstatSync(markerPath);
    if (!root.isDirectory() || root.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() ||
        readFileSync(markerPath, 'utf8').trim() !== identity) {
      throw new Error();
    }
  } catch {
    throw new Error('The configured E2E storage identity does not match.');
  }
  return { path, identity };
}

async function preflight(request: APIRequestContext): Promise<void> {
  const url = `${resolveE2EBackendOrigin(process.env)}/health`;
  try {
    const response = await request.get(url, { timeout: 3000 });
    if (!response.ok()) throw new Error();
  } catch {
    throw new Error(`Backend E2E is not reachable at ${url}`);
  }
}

async function runFixture(command: 'provision' | 'cleanup', payload: object): Promise<number[]> {
  const executable = fixtureExecutable();
  const storage = fixtureStorage();
  const configuredCwd = process.env['NANIKA_E2E_FIXTURE_CWD'];
  const cwd = configuredCwd ? resolve(configuredCwd) : dirname(executable);
  if (configuredCwd) {
    try {
      const status = lstatSync(cwd);
      if (!isAbsolute(configuredCwd) || !status.isDirectory() || status.isSymbolicLink()) throw new Error();
    } catch {
      throw new Error('The configured E2E fixture working directory is invalid.');
    }
  }
  return new Promise<number[]>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [command], {
        cwd,
        env: {
          ...process.env,
          NANIKA_E2E_FIXTURE: '1',
          NANIKA_E2E_STORAGE_PATH: storage.path,
          NANIKA_E2E_STORAGE_ID: storage.identity,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new Error(`E2E fixture ${command} could not start`));
      return;
    }

    let output = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const succeed = (value: number[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };

    timer = setTimeout(() => {
      child.kill();
      fail(new Error(`E2E fixture ${command} timed out`));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      if (output.length + text.length > MAX_FIXTURE_STDOUT_CHARS) {
        child.kill();
        fail(new Error(`E2E fixture ${command} returned an oversized response`));
        return;
      }
      output += text;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      if (stderr.length + text.length > MAX_FIXTURE_STDERR_CHARS) {
        child.kill();
        fail(new Error(`E2E fixture ${command} failed`));
        return;
      }
      stderr += text;
    });
    child.stdin.on('error', () => fail(new Error(`E2E fixture ${command} failed`)));
    child.on('error', () => {
      fail(new Error(`E2E fixture ${command} could not start`));
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(formatFixtureFailure(command, stderr)));
        return;
      }
      try {
        succeed(parseFixtureResponse(command, output));
      } catch {
        fail(new Error(`E2E fixture ${command} returned an invalid response`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const test = base.extend<E2EFixtures>({
  page: async ({ page }, use) => {
    await installE2EBackendRouting(page);
    await use(page);
  },
  credentials: async ({ request }, use) => {
    await preflight(request);
    const credentials = generateCredentials();
    await runFixture('provision', credentials);
    try {
      await use(credentials);
    } finally {
      await cleanupE2EAccount(credentials.username);
      credentials.password = '';
      credentials.vaultPhrase = '';
    }
  },
});

export { installE2EBackendRouting, resolveE2EBackendOrigin };

export async function cleanupE2EAccount(username: string): Promise<number[]> {
  return runFixture('cleanup', { username });
}

export { expect } from '@playwright/test';
