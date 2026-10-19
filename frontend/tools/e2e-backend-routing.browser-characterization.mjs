import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROUND_ID = 'B.90-R1.M16';
const LOGIN_BODY = JSON.stringify({ username: 'synthetic', password: 'synthetic' });
const LOGIN_BODY_HASH = createHash('sha256').update(LOGIN_BODY).digest('hex');
const RANGE_BYTES = [0x31, 0x32, 0x33];
const COOKIE = 'probe_session=opaque; HttpOnly; Path=/; SameSite=Lax';

function outputPath(argv) {
  const index = argv.indexOf('--output');
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('-')) {
    throw new Error('Expected --output <path>.');
  }
  return resolve(argv[index + 1]);
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolvePromise, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Loopback server did not expose a dynamic port.'));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}

function close(server) {
  return new Promise(resolvePromise => server.close(() => resolvePromise()));
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('synthetic body exceeded the characterization limit.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response, status, headers, body = '') {
  response.writeHead(status, headers);
  response.end(body);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges',
  };
}

function makeMetrics() {
  return {
    preflight: false,
    requests: 0,
    loginReceived: false,
    loginOriginPreserved: false,
    bodyHashMatch: false,
    methodPreserved: false,
    cookieHeaderPresent: false,
    probeCookieReturned: false,
    authorizationReceived: false,
    rangeHeaderMatch: false,
    fallbackReceived: false,
  };
}

function makeScenarioState() {
  return { sourceBypass: false, targetMetrics: makeMetrics() };
}

export function classifyScenario({
  routeMatched,
  routeFailure,
  sourceBypassReceived,
  targetRequestReceived,
  targetLoginReceived,
  browserResponseReceived,
  browserFetchFailed,
  originPreserved,
  methodPreserved,
  bodyHashMatch,
  responseBodyPreserved,
  cookiePreserved,
  authorizationPreserved,
  rangeRequestPreserved,
  rangePreserved,
  fallbackChainPreserved,
}) {
  if (routeFailure) return routeFailure;
  if (!routeMatched) return 'ROUTE_NOT_MATCHED';
  if (sourceBypassReceived) return 'SOURCE_BYPASS_REACHED';

  const evidenceContradiction = (
    browserResponseReceived && !targetRequestReceived
  ) || (
    (
      methodPreserved ||
      bodyHashMatch ||
      responseBodyPreserved ||
      cookiePreserved ||
      authorizationPreserved ||
      rangeRequestPreserved ||
      rangePreserved ||
      fallbackChainPreserved
    ) && !targetRequestReceived
  );
  if (evidenceContradiction) return 'CHARACTERIZATION_EVIDENCE_INVALID';
  if (browserFetchFailed) return 'BROWSER_FETCH_FAILED';
  if (!browserResponseReceived) return 'CHARACTERIZATION_EVIDENCE_INVALID';
  if (!targetRequestReceived) return 'TARGET_REQUEST_NOT_RECEIVED';
  if (!targetLoginReceived) return 'TARGET_LOGIN_NOT_RECEIVED';
  if (!originPreserved) return 'ORIGIN_NOT_PRESERVED';
  if (!methodPreserved || !bodyHashMatch) return 'REQUEST_FIDELITY_FAILED';
  if (!responseBodyPreserved) return 'RESPONSE_FIDELITY_FAILED';
  if (!cookiePreserved) return 'COOKIE_NOT_PRESERVED';
  if (!authorizationPreserved) return 'AUTHORIZATION_NOT_PRESERVED';
  if (!rangeRequestPreserved || !rangePreserved) return 'RANGE_NOT_PRESERVED';
  if (!fallbackChainPreserved) return 'FALLBACK_CHAIN_NOT_PRESERVED';
  return null;
}

export { makeMetrics, makeScenarioState };

function createTargetHandler(pageOrigin, scenarioState) {
  return async (request, response) => {
    const metrics = scenarioState.targetMetrics;
    const url = new URL(request.url ?? '/', 'http://target.invalid');
    const headers = corsHeaders(pageOrigin);

    if (request.method === 'OPTIONS') {
      metrics.preflight = true;
      send(response, 204, headers);
      return;
    }

    metrics.requests += 1;
    if (request.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(request);
      metrics.loginReceived = true;
      metrics.loginOriginPreserved = request.headers.origin === pageOrigin;
      metrics.methodPreserved = true;
      metrics.bodyHashMatch = createHash('sha256').update(body).digest('hex') === LOGIN_BODY_HASH;
      send(response, 200, {
        ...headers,
        'Content-Type': 'application/json',
        'Set-Cookie': COOKIE,
      }, '{"ok":true}');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/cookie-check') {
      const cookie = request.headers.cookie ?? '';
      metrics.cookieHeaderPresent = cookie.length > 0;
      metrics.probeCookieReturned = cookie.includes('probe_session=opaque');
      send(response, 200, { ...headers, 'Content-Type': 'application/json' }, '{"ok":true}');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/protected') {
      metrics.authorizationReceived = request.headers.authorization === 'Bearer synthetic';
      send(response, 200, { ...headers, 'Content-Type': 'application/json' }, '{"ok":true}');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/range') {
      metrics.rangeHeaderMatch = request.headers.range === 'bytes=1-3';
      send(response, 206, {
        ...headers,
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes 1-3/5',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(RANGE_BYTES.length),
      }, Buffer.from(RANGE_BYTES));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/fallback-probe') {
      metrics.fallbackReceived = true;
      send(response, 200, { ...headers, 'Content-Type': 'application/json' }, '{"ok":true}');
      return;
    }

    send(response, 404, headers);
  };
}

async function runScenario(strategy, origins, scenarioState) {
  const metrics = scenarioState.targetMetrics;
  let routeMatched = false;
  let secondaryRouteMatched = false;
  let routeFailure = null;
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  try {
    await page.route(`${origins.source}/**`, async route => {
      routeMatched = true;
      const source = new URL(route.request().url());
      const rewritten = new URL(`${source.pathname}${source.search}`, `${origins.target}/`).toString();
      try {
        if (strategy === 'continue') {
          await route.continue({ url: rewritten });
          return;
        }
        let response;
        try {
          response = await route.fetch({ url: rewritten, maxRedirects: 0, maxRetries: 0 });
        } catch {
          routeFailure = 'ROUTE_FETCH_FAILED';
          throw new Error('route fetch failed');
        }
        try {
          await route.fulfill({ response });
        } catch {
          routeFailure = 'ROUTE_FULFILL_FAILED';
          throw new Error('route fulfill failed');
        }
      } catch (error) {
        if (strategy === 'continue' && routeFailure === null) routeFailure = 'ROUTE_CONTINUE_FAILED';
        throw error;
      }
    });

    await page.route(`${origins.source}/fallback-probe`, async route => {
      secondaryRouteMatched = true;
      await route.fallback();
    });

    await page.goto(origins.page);
    const browserResult = await page.evaluate(async sourceOrigin => {
      async function request(path, init) {
        try {
          const response = await fetch(`${sourceOrigin}${path}`, init);
          const body = new Uint8Array(await response.arrayBuffer());
          return {
            status: response.status,
            contentRange: response.headers.get('content-range'),
            body: Array.from(body),
            text: new TextDecoder().decode(body),
          };
        } catch {
          return { status: null, contentRange: null, body: [], text: '', failure: 'BROWSER_FETCH_FAILED' };
        }
      }

      const login = await request('/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'synthetic', password: 'synthetic' }),
      });
      const cookie = await request('/cookie-check', { credentials: 'include' });
      const authorization = await request('/protected', {
        headers: { Authorization: 'Bearer synthetic' },
      });
      const range = await request('/range', { headers: { Range: 'bytes=1-3' } });
      const fallback = await request('/fallback-probe');
      return { login, cookie, authorization, range, fallback };
    }, origins.source);

    const allResponses = Object.values(browserResult);
    const browserResponseReceived = allResponses.every(item => item.status !== null);
    const browserFetchFailed = allResponses.some(item => item.status === null);
    const rangeResponsePreserved = browserResult.range.status === 206 &&
      browserResult.range.contentRange === 'bytes 1-3/5' &&
      JSON.stringify(browserResult.range.body) === JSON.stringify(RANGE_BYTES);
    const scenario = {
      routeMatched,
      sourceBypassReceived: scenarioState.sourceBypass,
      preflightObserved: metrics.preflight,
      preflightRequiredForVerdict: false,
      targetRequestReceived: metrics.requests > 0,
      targetLoginReceived: metrics.loginReceived,
      originPreserved: metrics.loginOriginPreserved,
      browserResponseReceived,
      browserFetchFailed,
      methodPreserved: metrics.methodPreserved,
      statusPreserved: browserResult.login.status === 200 && browserResult.range.status === 206,
      bodyHashMatch: metrics.bodyHashMatch,
      responseBodyPreserved: browserResult.login.text === '{"ok":true}',
      cookiePreserved: metrics.cookieHeaderPresent && metrics.probeCookieReturned,
      authorizationPreserved: metrics.authorizationReceived,
      rangeRequestPreserved: metrics.rangeHeaderMatch,
      rangeStatusPreserved: browserResult.range.status === 206,
      rangeResponseHeaderPreserved: browserResult.range.contentRange === 'bytes 1-3/5',
      binaryBodyPreserved: JSON.stringify(browserResult.range.body) === JSON.stringify(RANGE_BYTES),
      rangePreserved: metrics.rangeHeaderMatch && rangeResponsePreserved,
      fallbackChainPreserved: secondaryRouteMatched && metrics.fallbackReceived && browserResult.fallback.status === 200,
    };
    scenario.failureClass = classifyScenario({ ...scenario, routeFailure });
    delete scenario.browserFetchFailed;
    delete scenario.targetLoginReceived;
    return scenario;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

function summary(result) {
  const lines = [
    `# ${ROUND_ID} — Chromium transport characterization`,
    '',
    `- Evidence integrity: **${result.evidenceIntegrity}**`,
    `- route.continue: **${result.scenarios.continue.failureClass === null ? 'PASS' : 'FAIL'}**`,
    `- continue failure class: **${result.scenarios.continue.failureClass ?? 'none'}**`,
    `- route.fetch + route.fulfill: **${result.scenarios.fetchFulfill.failureClass === null ? 'PASS' : 'FAIL'}**`,
    `- fetch+fulfill failure class: **${result.scenarios.fetchFulfill.failureClass ?? 'none'}**`,
    `- CORS preflight observability: **${result.scenarios.fetchFulfill.preflightObserved ? 'OBSERVED' : 'NOT OBSERVED / INFORMATIONAL'}**`,
    `- Origin header fidelity: **${result.scenarios.fetchFulfill.originPreserved ? 'PASS' : 'FAIL'}**`,
    `- HttpOnly cookie: **${result.scenarios.fetchFulfill.cookiePreserved ? 'PASS' : 'FAIL'}**`,
    `- Authorization: **${result.scenarios.fetchFulfill.authorizationPreserved ? 'PASS' : 'FAIL'}**`,
    `- Range / 206 / binary: **${result.scenarios.fetchFulfill.rangePreserved ? 'PASS' : 'FAIL'}**`,
    `- route fallback chain: **${result.scenarios.fetchFulfill.fallbackChainPreserved ? 'PASS' : 'FAIL'}**`,
    '',
    'Os artefatos registram somente classificações booleanas e não contêm URL completa, body, cookie ou Authorization.',
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  let pageServer;
  let sourceServer;
  let targetServer;
  let result;
  try {
    const page = await listen((_request, response) => send(response, 200, { 'Content-Type': 'text/html' }, '<!doctype html><meta charset="utf-8"><title>E2E route transport characterization</title>'));
    pageServer = page.server;
    const scenarioState = makeScenarioState();
    const source = await listen(async (request, response) => {
      scenarioState.sourceBypass = true;
      await readBody(request).catch(() => undefined);
      send(response, 418, { 'Content-Type': 'text/plain' }, 'source bypass');
    });
    sourceServer = source.server;
    const origins = {
      page: `http://127.0.0.1:${page.port}`,
      source: `http://localhost:${source.port}`,
      target: '',
    };
    const target = await listen(createTargetHandler(origins.page, scenarioState));
    targetServer = target.server;
    origins.target = `http://127.0.0.1:${target.port}`;

    const scenarios = {};
    for (const strategy of ['continue', 'fetchFulfill']) {
      scenarioState.sourceBypass = false;
      scenarioState.targetMetrics = makeMetrics();
      scenarios[strategy] = await runScenario(strategy, origins, scenarioState);
    }

    const evidenceIntegrity = Object.values(scenarios).every(
      scenario => scenario.failureClass !== 'CHARACTERIZATION_EVIDENCE_INVALID',
    ) ? 'VALID' : 'INVALID';
    result = {
      round: ROUND_ID,
      browser: 'chromium',
      secretsRecorded: false,
      evidenceIntegrity,
      transportVerdict: {
        continue: scenarios.continue.failureClass === null ? 'PASS' : 'FAIL',
        fetchFulfill: scenarios.fetchFulfill.failureClass === null ? 'PASS' : 'FAIL',
      },
      topology: {
        sourceLoopback: true,
        targetLoopback: true,
        distinctPorts: true,
        sourceHostClass: 'localhost',
        targetHostClass: 'ipv4-loopback',
      },
      scenarios,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(resolve(dirname(output), 'summary.md'), summary(result), 'utf8');
    console.log(`${ROUND_ID} characterization complete: continue=${scenarios.continue.failureClass ?? 'PASS'} fetchFulfill=${scenarios.fetchFulfill.failureClass ?? 'PASS'}`);
  } finally {
    if (pageServer) await close(pageServer);
    if (sourceServer) await close(sourceServer);
    if (targetServer) await close(targetServer);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof Error && /Expected --output/.test(error.message)
      ? error.message
      : 'M16 characterization failed before producing a valid result.';
    console.error(safe);
    process.exitCode = 1;
  });
}
