import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { integrationPageScript, configureIntegrationPage, initializeIntegrationPage, AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';
import { newIntegrationCounters, validateIntegrationCleanup, validateIntegrationFunctional } from './ap06-r7-instrumentation.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';
import { configureR9Page, initializeR9Page, TRANSPORTS } from './ap06-r9-probe.mjs';

const r9 = process.env.AP06_R9_CHECK === '1';
const configure = r9 ? configureR9Page : configureIntegrationPage;
const initialize = r9 ? initializeR9Page : initializeIntegrationPage;

const output = process.env.AP06_R7_UNIT_OUTPUT;
if (!output) throw new Error('OWNED_R7_UNIT_OUTPUT_REQUIRED');
const fixtures = JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST, 'utf8'));
const paths = JSON.parse(process.env.AP06_R7_ALLOWED_PATHS), origin = process.env.AP06_R5_MEDIA_ORIGIN;
const result = { status: 'FAIL', measurementBrowsers: 0, unitBrowserLaunchAttempts: 0, unitBrowserLaunches: 0, cases: [], observations: {},
  boundaryCounters: {}, transportProofs: {}, rangeNetworks: {},
  multiplexedContract: { fixtureHash: createHash('sha256').update(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST)).digest('hex'),
    workerHashes: { crypto: process.env.AP06_R5_CRYPTO_WORKER_SHA256, transmux: process.env.AP06_R5_TRANSMUX_WORKER_SHA256 },
    initDataPerFixture: [1, 1, 1], initDataId: 0 }, sourceBufferChecks: [],
  pageScriptSha256: createHash('sha256').update(integrationPageScript()).digest('hex'),
  appProducts: JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
  sourceHashes: Object.fromEntries(['ap06-transmux-probe.mjs', 'ap06-orchestration-probe.mjs', 'ap06-integration-probe.mjs',
    'ap06-r7-instrumentation.mjs'].map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')])) };
const save = () => writeJsonAtomic(output, result);
let browser;
async function check(name, action) {
  await action(); result.cases.push({ name, status: 'PASS' }); save();
}
try {
  result.unitBrowserLaunchAttempts++; save();
  browser = await chromium.launch({ args: AUTOPLAY_ARGS }); result.unitBrowserLaunches++; save();
  assert.equal(browser.version(), '151.0.7922.34');
  for (const condition of r9 ? Object.keys(TRANSPORTS) : ['r8.0', 'r8.1', 'r8.2']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    let closeObservation, observation;
    try {
      const page = await context.newPage(), raw = {};
      observation = raw;
      closeObservation = await configure(page, context, raw, origin, paths, condition);
      await page.addInitScript({ content: integrationPageScript() });
      await page.goto(origin);
      await page.evaluate(({ counters, crypto, transmux }) => {
        window.r5Counters = counters; window.r5CryptoWorkerSource = crypto; window.r5TransmuxWorkerSource = transmux;
      }, { counters: newIntegrationCounters(), crypto: readFileSync(process.env.AP06_R5_CRYPTO_WORKER, 'utf8'),
        transmux: readFileSync(process.env.AP06_R5_TRANSMUX_WORKER, 'utf8') });
      const proof = await initialize(page, fixtures, condition);
      if (r9) result.transportProofs[condition] = proof;
      await check(condition + ' original Angular DI and native API prototypes', async () => {
        assert.ok(Object.values(await page.evaluate(() => ({ ...window.r7Contracts(), ...window.r7InstrumentationContracts() }))).every(Boolean));
      });
      const cdp = await context.newCDPSession(page);
      async function windowListeners() {
        const { result: object } = await cdp.send('Runtime.evaluate', { expression: 'window', objectGroup: 'r7-unit-listeners' });
        try {
          const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId });
          return listeners.filter(listener => listener.type === 'keydown').length;
        } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'r7-unit-listeners' }); }
      }
      const listenersBefore = await windowListeners();
      await check(condition + ' actual playback and repeated Angular mount/destroy', async () => {
        for (const fixture of fixtures) {
          const before = await page.evaluate(() => ({ ...window.r5Counters.observed }));
          await page.evaluate(fixture => window.r7Run(fixture), fixture);
          const after = await page.evaluate(() => ({ ...window.r5Counters.observed }));
          assert.equal(after.sourceBuffersCreated - before.sourceBuffersCreated, 1);
          assert.equal(after.sourceBuffersReleased - before.sourceBuffersReleased, 1);
          assert.equal(after.pendingAppends, 0);
          result.sourceBufferChecks.push({ condition, fixture: fixture.id, tracks: fixture.tracks.length,
            created: after.sourceBuffersCreated - before.sourceBuffersCreated,
            released: after.sourceBuffersReleased - before.sourceBuffersReleased }); save();
        }
        const state = await page.evaluate(() => ({ counters: window.r5Counters, media: document.querySelectorAll('video,audio').length }));
        result.observations[condition] = state.counters.sessions; save();
        result.boundaryCounters[condition] = state.counters.observed; save();
        validateIntegrationFunctional(state.counters, state.media);
        assert.equal(state.counters.observed.playbackCompleted, 3);
        assert.equal(state.counters.observed.workersCreated, 6);
        assert.ok(state.counters.observed.detachedTransfers > 0);
        assert.ok(state.counters.sessions.every(session => session.maxCurrentTime > 1.5 && session.maxCurrentTime < 10 && session.seeks === 0));
        assert.ok(state.counters.sessions.every(session => session.muted === false && session.volume === 1 && session.playbackRate === 1));
        assert.equal(await windowListeners(), listenersBefore);
        assert.equal(state.counters.observed.componentsMounted, 6);
        assert.ok(state.counters.sessions.every(session => session.playbackMs - session.canplayMs >= 450));
        if (condition !== 'r8.0') {
          assert.equal(state.counters.observed.storeLoadStarted, 1);
          assert.equal(state.counters.observed.storeLoadCompleted, 1);
          assert.equal(state.counters.observed.storeFileResolved, 3);
          assert.equal(state.counters.observed.storeEffectsSettled, 1);
        }
        assert.equal(state.counters.observed.unexpectedPeripheralOperations, 0);
        assert.equal(state.counters.observed.outstandingSubscriptions, 0);
        if (condition === 'r8.2' || r9) {
          assert.equal(state.counters.observed.authAttempts, 1);
          assert.equal(state.counters.observed.authSuccesses, 1);
          assert.equal(state.counters.observed.backendFileIdMatches, 3);
          assert.equal(state.counters.observed.http206Validated, state.counters.observed.rangeRequestsCompleted);
          assert.equal(state.counters.observed.jwtRangesValidated, condition === 'r9-r2.2' ? 0 : state.counters.observed.rangeRequestsStarted);
          assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]
            .some(value => /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value))), false);
        }
      });
      if (closeObservation) {
        await closeObservation(); closeObservation = null;
        result.rangeNetworks[condition] = { cdp: observation.rangeNetwork, backend: observation.backendTraffic };
        assert.equal(observation.rangeNetwork.requests.length, result.boundaryCounters[condition].rangeRequestsCompleted);
        assert.equal(observation.backendTraffic.rows.length, observation.rangeNetwork.requests.length);
        assert.ok(observation.rangeNetwork.requests.every(row => row.finished && !row.failed && row.status === 206 &&
          row.type === (condition === 'r9-r2.0' ? 'XHR' : 'Fetch') && !row.fromDiskCache && !row.fromServiceWorker));
        save();
      }
      if (condition !== 'r8.0') {
        await check(condition + ' original Store refresh and computed/effects settle without transfers', async () => {
          const before = await windowListeners();
          for (let index = 0; index < 2; index++) {
            assert.deepEqual(await page.evaluate(() => window.r8RefreshStore()),
              { files: 3, visibleFiles: 3, transfers: 0, thumbnails: 0, outstandingSubscriptions: 0 });
          }
          assert.equal(await windowListeners(), before);
          const state = await page.evaluate(() => ({ counters: window.r5Counters, media: document.querySelectorAll('video,audio').length }));
          validateIntegrationCleanup(state.counters, state.media);
        });
      }
      if (condition === 'r8.2' || r9) {
        await check('real service destroy aborts its RxJS Range and settles the initialization', async () => {
          const cancelled = await page.evaluate(async fixture => {
            const pending = window.r7Run(fixture); pending.catch(() => {});
            for (let tick = 0; tick < 30 && window.r5Counters.observed.activeRanges === 0; tick++) await Promise.resolve();
            if (window.r5Counters.observed.activeRanges === 0) throw new Error('UNIT_RANGE_DID_NOT_START');
            window.r7CancelSession();
            try { await pending; return false; } catch { return true; }
          }, fixtures[2]);
          assert.equal(cancelled, true);
          const state = await page.evaluate(() => ({ counters: window.r5Counters, media: document.querySelectorAll('video,audio').length }));
          validateIntegrationCleanup(state.counters, state.media);
          assert.ok(state.counters.observed.rangeRequestsAborted >= 1);
        });
        await check('real Store file identity rejects inconsistent authenticated container size', async () => {
          await assert.rejects(page.evaluate(fixture => window.r7Run(fixture), { ...fixtures[0], ciphertextBytes: fixtures[0].ciphertextBytes - 1 }));
          const state = await page.evaluate(() => ({ counters: window.r5Counters, media: document.querySelectorAll('video,audio').length }));
          validateIntegrationCleanup(state.counters, state.media);
          assert.equal(state.counters.observed.storeFileResolved, 4);
        });
      }
      assert.equal(raw.pageErrors, 0); assert.equal(raw.network.rejectedRequests, 0);
      assert.equal(raw.network.externalRequests, 0); assert.equal(raw.network.unexpectedRequests, 0);
      assert.equal(raw.recoveryWarnings, 0);
    } finally { if (closeObservation) await closeObservation(); await context.close(); }
  }
  await check('original Store swallowed HTTP error is rejected by initial readiness validation', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage(), raw = {};
      const close = await configure(page, context, raw, origin, paths, r9 ? 'r9-r2.0' : 'r8.2');
      await context.route('**/tree?*', route => route.fulfill({ status: 500, body: '{}',
        headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type' } }));
      await page.addInitScript({ content: integrationPageScript() });
      await page.goto(origin);
      await page.evaluate(counters => { window.r5Counters = counters; }, newIntegrationCounters());
      await assert.rejects(initialize(page, fixtures, r9 ? 'r9-r2.0' : 'r8.2'), /R8_STORE_LOAD_FAILED/);
      const state = await page.evaluate(() => ({ counters: window.r5Counters, media: document.querySelectorAll('video,audio').length }));
      assert.equal(state.counters.observed.storeLoadStarted, 1);
      assert.equal(state.counters.observed.storeLoadCompleted, 0);
      assert.equal(state.counters.observed.workersCreated, 0);
      validateIntegrationCleanup(state.counters, state.media);
      if (close) await close();
    } finally { await context.close(); }
  });
  result.status = 'PASS';
} catch (error) {
  result.failureClass = error.name; result.failure = error.message; process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  result.browserClosed = true; save();
  console.log(JSON.stringify(result));
}
