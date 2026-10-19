import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runTransmuxProbe } from './ap06-transmux-probe.mjs';
import { orchestrationPageScript } from './ap06-orchestration-probe.mjs';
import { newIntegrationCounters, installIntegrationInstrumentation, integrationSnapshot,
  validateIntegrationCleanup, validateIntegrationFunctional } from './ap06-r7-instrumentation.mjs';

export {AUTOPLAY_ARGS} from './ap06-browser-identity.mjs';
import {AUTOPLAY_ARGS} from './ap06-browser-identity.mjs';
export const MODES = { 'r8.0': 'component', 'r8.1': 'store', 'r8.2': 'backend' };

export function integrationPageScript() {
  return orchestrationPageScript('r6.2') + `(${installIntegrationInstrumentation.toString()})();
    window.r7WaitPlayback=waitForPlayback;
    window.r7ControlFixture=async fixture=>{const material=await window.r7ReadEnvelope(fixture);
      try{return await runOrchestrationFixture(fixture,'r6.2',material);}
      finally{material.fdk.fill(0);material.baseNonce.fill(0);}};`;
}

export async function configureIntegrationPage(page, context, raw, origin, allowedPaths, condition = process.env.AP06_R6_CONDITION) {
  if (condition) {
    if (!MODES[condition]) throw new Error('INVALID_R8_CONDITION');
    await page.addInitScript(mode => { window.r8BootstrapMode = mode; }, MODES[condition]);
  }
  raw.network ??= { rejectedRequests: 0, externalRequests: 0, unexpectedRequests: 0, workerRequests: {} };
  raw.pageErrors ??= 0; raw.recoveryWarnings ??= 0;
  const allowed = new Set(allowedPaths.map(path => path.startsWith('http://127.0.0.1:42187/') ? path : origin + path));
  const escaped = [...allowed].map(url => url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Allowed loopback requests bypass routing; only forbidden destinations match this blocker.
  await context.route(new RegExp(`^(?!(?:${escaped.join('|')})$)(?:https?|wss?):`), async route => {
    raw.network.rejectedRequests++;
    await route.abort('blockedbyclient');
  });
  context.on('request', request => {
    const url = request.url();
    if (!/^(?:https?|wss?):/.test(url)) return;
    if (!allowed.has(url)) {
      if (!url.startsWith(origin + '/')) raw.network.externalRequests++;
      else raw.network.unexpectedRequests++;
    }
    if (allowed.has(url) && /\/worker-[\w-]+\.js$/.test(url)) {
      const name = new URL(url).pathname.slice(1);
      raw.network.workerRequests[name] = (raw.network.workerRequests[name] || 0) + 1;
    }
  });
  page.on('pageerror', () => { raw.pageErrors++; });
  page.on('console', message => {
    if (message.type() === 'warning' && /retryCount:|Autoplay prevented|recover.*append|retry:/i.test(message.text())) raw.recoveryWarnings++;
  });
}

export async function initializeIntegrationPage(page, fixtures, condition, runtimeOverride) {
  await page.waitForFunction(() => window.r7Ready === true, null, { timeout: 20000 });
  const runtime = runtimeOverride ?? (condition === 'r8.2' ? JSON.parse(readFileSync(process.env.AP06_R8_PRIVATE_CONFIG, 'utf8')) : undefined);
  await page.evaluate(async ({ fixtures, mode, runtime }) => {
    await window.r7Configure(fixtures, mode, runtime);
    window.r5RunFixture = fixture => window.r7Run(fixture);
  }, { fixtures, mode: MODES[condition], runtime });
  if (runtime) runtime.password = '';
  const contracts = await page.evaluate(() => window.r7Contracts());
  if (Object.values(contracts).some(value => value !== true)) throw new Error('R7_ANGULAR_DI_CONTRACT_FAILED');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const condition = process.env.AP06_R6_CONDITION;
  if (!MODES[condition]) throw new Error('INVALID_R7_CONDITION');
  const fixtures = JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST, 'utf8'));
  const paths = JSON.parse(process.env.AP06_R7_ALLOWED_PATHS);
  const pageScript = integrationPageScript();
  await runTransmuxProbe({ pageScript, countersFactory: newIntegrationCounters,
    cleanupValidator: validateIntegrationCleanup, functionalValidator: validateIntegrationFunctional,
    snapshot: integrationSnapshot, launchOptions: { args: AUTOPLAY_ARGS },
    identity: { angularOrBackendUsed: true, backendUsed: condition === 'r8.2', videoStreamServiceUsed: true,
      driveStoreUsed: condition !== 'r8.0', videoPlayerComponentUsed: true, autoplayArgs: AUTOPLAY_ARGS,
      backendAuthoritySha256: condition === 'r8.2' ? process.env.AP06_R8_BACKEND_AUTHORITY_SHA256 : null,
      backendFileMapping: condition === 'r8.2' ? JSON.parse(process.env.AP06_R8_FILE_MAPPING) : null,
      playwrightRoutingInstalled: true, localRequestsIntercepted: false, fullKasumiContainer: true,
      experimentalAppProducts: JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
      pageScriptSha256: createHash('sha256').update(pageScript).digest('hex') },
    configurePage: (page, context, raw) => configureIntegrationPage(page, context, raw, process.env.AP06_R5_MEDIA_ORIGIN, paths),
    initializePage: page => initializeIntegrationPage(page, fixtures, condition) });
}
