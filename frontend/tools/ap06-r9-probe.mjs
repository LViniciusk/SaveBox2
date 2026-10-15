import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runTransmuxProbe } from './ap06-transmux-probe.mjs';
import { integrationPageScript, configureIntegrationPage, initializeIntegrationPage, AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';
import { newIntegrationCounters, integrationSnapshot, validateIntegrationCleanup, validateIntegrationFunctional } from './ap06-r7-instrumentation.mjs';
import { observeRangeNetwork, backendTraffic } from './ap06-r9-network.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';

export const TRANSPORTS = { 'r9-r2.0': 'xhr', 'r9-r2.1': 'angular-fetch', 'r9-r2.2': 'direct-fetch' };

export function authorityAction(args, raw, output) {
  try {
    execFileSync(process.env.WAVE1_PYTHON, [process.env.AP06_R9_PUBLISHER, ...args], { windowsHide: true, stdio: 'pipe' });
  } catch (error) {
    const codes = String(error.stderr ?? '').match(/(?:AUTHORITY|R9|R10|CUSTODY|DPAPI)_[A-Z_0-9]+/g);
    raw.checkpointFailure = codes?.at(-1) ?? 'R9_AUTHORITY_HELPER_FAILED';
    writeJsonAtomic(output, raw);
    throw new Error(raw.checkpointFailure);
  }
}

export async function configureR9Page(page, context, raw, origin, paths, condition) {
  if (!TRANSPORTS[condition]) throw new Error('R9_INVALID_CONDITION');
  await page.addInitScript(transport => { window.ap06R9Transport = transport; }, TRANSPORTS[condition]);
  return configureBackendObservation(page,context,raw,origin,paths);
}

export async function configureBackendObservation(page, context, raw, origin, paths, options) {
  await configureIntegrationPage(page, context, raw, origin, paths, 'r8.2');
  const mapping = JSON.parse(process.env.AP06_R8_FILE_MAPPING);
  const observer = await observeRangeNetwork(context, page, mapping, options);
  const run = raw.runs?.at(-1) ?? raw;
  run.rangeNetwork = observer.data;
  const logPath = process.env.AP06_R9_BACKEND_LOG;
  const offset = statSync(logPath).size;
  return async () => {
    await observer.close();
    const size = statSync(logPath).size - offset;
    if (size < 0 || size > 8 * 1024 * 1024) throw new Error('R9_BACKEND_LOG_IDENTITY_INVALID');
    const buffer = Buffer.alloc(size), fd = openSync(logPath, 'r');
    try { if (readSync(fd, buffer, 0, size, offset) !== size) throw new Error('R9_BACKEND_LOG_TRUNCATED'); }
    finally { closeSync(fd); }
    run.backendTraffic = backendTraffic(buffer.toString('utf8'), mapping.map(row => row.fileId));
    buffer.fill(0);
  };
}

export const initializeR9Page = (page, fixtures) => initializeBackendPage(page,fixtures,'r9TransportProof');

export async function initializeBackendPage(page, fixtures, proofName) {
  const runtime = JSON.parse(readFileSync(process.env.AP06_R8_PRIVATE_CONFIG, 'utf8'));
  runtime.fdks = JSON.parse(readFileSync(process.env.AP06_R9_PRIVATE_KEYS, 'utf8'));
  try { await initializeIntegrationPage(page, fixtures, 'r8.2', runtime); }
  finally { runtime.password = ''; for (const key of Object.values(runtime.fdks)) key.fill(0); }
  return page.evaluate(name => window[name](), proofName);
}

export async function runBackendProbe({ condition, transport, configure, initialize, experimentalIdentity = {}, ...sampling }) {
  const fixtures = JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST, 'utf8'));
  const paths = JSON.parse(process.env.AP06_R7_ALLOWED_PATHS), pageScript = integrationPageScript();
  await runTransmuxProbe({ pageScript, countersFactory: newIntegrationCounters,
    cleanupValidator: validateIntegrationCleanup, functionalValidator: validateIntegrationFunctional,
    snapshot: integrationSnapshot, launchOptions: { args: AUTOPLAY_ARGS },
    identity: { angularOrBackendUsed: true, backendUsed: true, videoStreamServiceUsed: true, driveStoreUsed: true,
      videoPlayerComponentUsed: true, autoplayArgs: AUTOPLAY_ARGS, transport,
      backendAuthoritySha256: process.env.AP06_R8_BACKEND_AUTHORITY_SHA256,
      backendFileMapping: JSON.parse(process.env.AP06_R8_FILE_MAPPING), playwrightRoutingInstalled: true,
      localRequestsIntercepted: false, fullKasumiContainer: true,
      experimentalAppProducts: JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
      pageScriptSha256: createHash('sha256').update(sampling.pageScript ?? pageScript).digest('hex'), ...experimentalIdentity },
    configurePage: (page, context, raw) => configure(page, context, raw, process.env.AP06_R5_MEDIA_ORIGIN, paths, condition),
    initializePage: async (page, raw) => { raw.runs.at(-1).transportProof = await initialize(page, fixtures); },
    beforeRun: async (raw, output) => { authorityAction(['--verify-freeze'], raw, output); },
    afterRun: async (raw, output) => {
      authorityAction(['--verify-freeze'], raw, output);
      authorityAction(['--publish-raw', output, '--snapshot', `${raw.stage}-${condition}-${raw.runs.length}`], raw, output);
    }, ...sampling });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const condition = process.env.AP06_R6_CONDITION;
  if (!TRANSPORTS[condition]) throw new Error('R9_INVALID_CONDITION');
  await runBackendProbe({condition,transport:TRANSPORTS[condition],configure:configureR9Page,initialize:initializeR9Page});
}
