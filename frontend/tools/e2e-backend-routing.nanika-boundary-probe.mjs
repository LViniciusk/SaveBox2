import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  installE2EBackendRouting,
  resolveE2EBackendOrigin,
} from './e2e-backend-routing.mjs';

const ROUND_ID = 'B.90-R1.M19';
const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:4200';
const FRONTEND_COMPILED_BACKEND_ORIGIN = 'http://localhost:8080';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SAFE_FAILURE = /^net::ERR_[A-Z0-9_]+$/;

function outputPath(argv) {
  const index = argv.indexOf('--output');
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('-')) {
    throw new Error('Expected --output <path>.');
  }
  return resolve(argv[index + 1]);
}

function resolveFrontendOrigin(environment = process.env) {
  const raw = environment.NANIKA_E2E_BASE_URL ?? DEFAULT_FRONTEND_ORIGIN;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('E2E frontend authority is invalid.');
  }

  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('E2E frontend authority is invalid.');
  }

  return parsed.origin;
}

function safePath(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    return path === '/health' || path === '/login' ? path : null;
  } catch {
    return null;
  }
}

function statusClass(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  return `${Math.floor(status / 100)}xx`;
}

function safeRequestFailure(request) {
  const failure = request.failure()?.errorText;
  return typeof failure === 'string' && SAFE_FAILURE.test(failure)
    ? failure
    : 'REQUEST_FAILED';
}

function emptyEvidence() {
  return {
    navigationPassed: false,
    healthRouteMatched: false,
    loginRouteMatched: false,
    loginOriginMatchesFrontend: false,
    healthBrowserFetchResolved: false,
    healthResponseObserved: false,
    healthStatus: null,
    healthRequestFailureClass: null,
    healthCorsAllowOriginMatchesFrontend: false,
    loginBrowserFetchResolved: false,
    loginResponseObserved: false,
    loginStatus: null,
    loginStatusClass: null,
    loginRequestFailureClass: null,
    loginCorsAllowOriginMatchesFrontend: false,
  };
}

function hasEvidenceContradiction(evidence) {
  return (
    (evidence.healthResponseObserved && !Number.isInteger(evidence.healthStatus)) ||
    (evidence.loginResponseObserved && !Number.isInteger(evidence.loginStatus))
  );
}

export function classifyRealBoundary(evidence) {
  if (hasEvidenceContradiction(evidence)) return 'PROBE_EVIDENCE_INVALID';
  if (!evidence.navigationPassed) return 'FRONTEND_NAVIGATION_FAILED';
  if (!evidence.healthRouteMatched) return 'HEALTH_ROUTE_NOT_MATCHED';
  if (!evidence.healthBrowserFetchResolved) return 'REAL_BACKEND_HEALTH_BROWSER_TRANSPORT_FAILED';
  if (!evidence.healthResponseObserved) return 'REAL_BACKEND_HEALTH_RESPONSE_NOT_OBSERVED';
  if (evidence.healthStatus !== 200) return 'REAL_BACKEND_HEALTH_HTTP_UNEXPECTED';
  if (!evidence.loginRouteMatched) return 'LOGIN_ROUTE_NOT_MATCHED';
  if (!evidence.loginOriginMatchesFrontend) return 'REAL_LOGIN_ORIGIN_MISMATCH';
  if (!evidence.loginBrowserFetchResolved) return 'REAL_BACKEND_LOGIN_BROWSER_TRANSPORT_FAILED';
  if (!evidence.loginResponseObserved) return 'REAL_LOGIN_RESPONSE_NOT_OBSERVED';
  if (!evidence.loginCorsAllowOriginMatchesFrontend) return 'REAL_CORS_RESPONSE_AUTHORITY_MISMATCH';
  return 'PASS_REAL_BROWSER_BOUNDARY';
}

async function writeResult(output, result) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export async function runProbe({ frontendOrigin, environment = process.env }) {
  const evidence = emptyEvidence();
  let probeActive = false;
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  const observeRequest = (request, path) => {
    if (path === '/health') evidence.healthRouteMatched = true;
    if (path === '/login') {
      evidence.loginRouteMatched = true;
      evidence.loginOriginMatchesFrontend = request.headers().origin === frontendOrigin;
    }
  };

  page.on('requestfailed', request => {
    if (!probeActive) return;
    const path = safePath(request.url());
    if (path === '/health') evidence.healthRequestFailureClass = safeRequestFailure(request);
    if (path === '/login') evidence.loginRequestFailureClass = safeRequestFailure(request);
  });

  page.on('response', response => {
    if (!probeActive) return;
    const path = safePath(response.url());
    if (path !== '/health' && path !== '/login') return;
    const status = response.status();
    const allowOrigin = response.headers()['access-control-allow-origin'];
    const matches = allowOrigin === frontendOrigin;
    if (path === '/health') {
      evidence.healthResponseObserved = true;
      evidence.healthStatus = status;
      evidence.healthCorsAllowOriginMatchesFrontend = matches;
    } else {
      evidence.loginResponseObserved = true;
      evidence.loginStatus = status;
      evidence.loginStatusClass = statusClass(status);
      evidence.loginCorsAllowOriginMatchesFrontend = matches;
    }
  });

  try {
    await installE2EBackendRouting(page, environment);
    await page.route(`${FRONTEND_COMPILED_BACKEND_ORIGIN}/**`, async route => {
      if (probeActive) observeRequest(route.request(), safePath(route.request().url()));
      await route.fallback();
    });

    try {
      await page.goto(frontendOrigin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      evidence.navigationPassed = true;
    } catch {
      return { ...evidence, result: classifyRealBoundary(evidence) };
    }

    probeActive = true;

    const syntheticUsername = `nanika_probe_missing_${randomBytes(12).toString('hex')}`;
    const syntheticPassword = 'nanika-probe-password';
    const browserEvidence = await page.evaluate(async ({ username, password }) => {
      async function request(url, init) {
        try {
          const response = await fetch(url, init);
          return { resolved: true, status: response.status };
        } catch {
          return { resolved: false, status: null };
        }
      }

      const health = await request('http://localhost:8080/health', {
        method: 'GET',
        credentials: 'include',
      });
      const login = await request('http://localhost:8080/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return { health, login };
    }, { username: syntheticUsername, password: syntheticPassword });

    evidence.healthBrowserFetchResolved = browserEvidence.health.resolved;
    if (browserEvidence.health.resolved) evidence.healthStatus = browserEvidence.health.status;
    evidence.loginBrowserFetchResolved = browserEvidence.login.resolved;
    if (browserEvidence.login.resolved) {
      evidence.loginStatus = browserEvidence.login.status;
      evidence.loginStatusClass = statusClass(browserEvidence.login.status);
    }
    return { ...evidence, result: classifyRealBoundary(evidence) };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  const frontendOrigin = resolveFrontendOrigin(process.env);
  resolveE2EBackendOrigin(process.env);
  const result = await runProbe({ frontendOrigin, environment: process.env });
  const artifact = {
    round: ROUND_ID,
    result: result.result,
    secretsRecorded: false,
    frontend: { navigationPassed: result.navigationPassed },
    routing: {
      helper: 'existing',
      transport: 'route.continue',
      healthRouteMatched: result.healthRouteMatched,
      loginRouteMatched: result.loginRouteMatched,
      loginOriginMatchesFrontend: result.loginOriginMatchesFrontend,
    },
    health: {
      browserFetchResolved: result.healthBrowserFetchResolved,
      responseObserved: result.healthResponseObserved,
      status: result.healthStatus,
      requestFailureClass: result.healthRequestFailureClass,
      corsAllowOriginMatchesFrontend: result.healthCorsAllowOriginMatchesFrontend,
    },
    login: {
      browserFetchResolved: result.loginBrowserFetchResolved,
      responseObserved: result.loginResponseObserved,
      status: result.loginStatus,
      statusClass: result.loginStatusClass,
      requestFailureClass: result.loginRequestFailureClass,
      corsAllowOriginMatchesFrontend: result.loginCorsAllowOriginMatchesFrontend,
    },
  };
  await writeResult(output, artifact);
  console.log(`${ROUND_ID} real boundary probe: ${artifact.result}`);
  if (artifact.result !== 'PASS_REAL_BROWSER_BOUNDARY') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error && /authority|Expected --output/.test(error.message)
      ? error.message
      : 'M16 real boundary probe failed before producing a valid result.');
    process.exitCode = 1;
  });
}
