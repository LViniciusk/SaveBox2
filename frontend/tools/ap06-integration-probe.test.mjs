import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { firstValueFrom } from 'rxjs';
import { rangeAdapter, validateBounds, validatePartialResponse } from '../experiments/ap06-r7/range-adapter.ts';
import { buildKasumi, loadKasumi, validateContainer } from './ap06-r7-fixtures.mjs';
import { disposableCryptoMaterial } from './ap06-mse-probe.mjs';
import { newIntegrationCounters, integrationSnapshot, validateIntegrationCleanup, validateIntegrationFunctional } from './ap06-r7-instrumentation.mjs';
import { configureIntegrationPage, integrationPageScript, AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';

const fixtures = [0, 1, 2].map(id => ({ id, ciphertextBytes: 100 }));
const counters = () => newIntegrationCounters().observed;
const response = (bytes = new Uint8Array(4), status = 206, headers = {}) => new Response(bytes, { status,
  headers: { 'Content-Range': 'bytes 10-13/100', 'Content-Length': '4', ...headers } });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('inclusive Range validates all boundaries and rejects impossible values', () => {
  validateBounds(0, 99, 100);
  for (const args of [[-1, 3, 100], [10, 9, 100], [0, 100, 100], [0, 0, 0], [0, Infinity, 100], [0, 1, 2 ** 54], ['0', 3, 100]]) {
    assert.throws(() => validateBounds(...args), /INVALID_RANGE_BOUNDS/);
  }
});
test('206, Content-Range and Content-Length must match exactly', () => {
  validatePartialResponse(response(), 10, 13, 100);
  for (const candidate of [response(undefined, 200), response(undefined, 206, { 'Content-Length': '3' }),
    response(undefined, 206, { 'Content-Range': 'bytes 10-13/101' }), response(undefined, 206, { 'Content-Range': 'bytes 10-13,20-30/100' })]) {
    assert.throws(() => validatePartialResponse(candidate, 10, 13, 100), /INVALID_RANGE_RESPONSE/);
  }
});
test('adapter permits only the three fixed fixture IDs', () => {
  const adapter = rangeAdapter(fixtures, counters(), async () => response());
  for (const id of [-1, 3, '../0', '0']) assert.throws(() => adapter.downloadFileRange(id, 10, 13), /FORBIDDEN_FIXTURE_ID/);
  assert.throws(() => rangeAdapter([fixtures[0], fixtures[0], fixtures[1]], counters()), /INVALID_FIXTURE_WHITELIST/);
});
test('adapter performs true Range fetch and settles exactly once', async () => {
  const c = counters(); let calls = 0;
  const adapter = rangeAdapter(fixtures, c, async (url, options) => {
    calls++; assert.equal(url, '/video-1.mp4'); assert.equal(options.headers.Range, 'bytes=10-13');
    assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal); return response();
  });
  assert.equal((await firstValueFrom(adapter.downloadFileRange(1, 10, 13))).size, 4);
  await turn(); assert.equal(calls, 1); assert.equal(c.rangeRequestsCompleted, 1); assert.equal(c.pendingOperations, 0);
  assert.equal(c.rangeRequestsAborted, 0); assert.equal(c.rangeBytesReceived, 4);
});
test('truncated body and incorrect status fail without adapter retries', async () => {
  for (const value of [response(new Uint8Array(3)), response(undefined, 200)]) {
    const c = counters(); let calls = 0;
    const adapter = rangeAdapter(fixtures, c, async () => { calls++; return value; });
    await assert.rejects(firstValueFrom(adapter.downloadFileRange(0, 10, 13)), /TRUNCATED_RANGE_BODY|INVALID_RANGE_RESPONSE/);
    await turn(); assert.equal(calls, 1); assert.equal(c.rangeRequestsFailed, 1); assert.equal(c.pendingOperations, 0);
  }
});
test('unsubscribe aborts the fetch and drains its pending operation', async () => {
  const c = counters(); let signal;
  const adapter = rangeAdapter(fixtures, c, async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true }));
  });
  const subscription = adapter.downloadFileRange(0, 10, 13).subscribe();
  subscription.unsubscribe(); await turn();
  assert.equal(signal.aborted, true); assert.equal(c.rangeRequestsAborted, 1); assert.equal(c.pendingOperations, 0);
});
test('a late body after unsubscribe cannot emit or complete a second time', async () => {
  const c = counters(); let deliver; let emitted = 0;
  const adapter = rangeAdapter(fixtures, c, () => new Promise(resolve => { deliver = resolve; }));
  const subscription = adapter.downloadFileRange(0, 10, 13).subscribe(() => emitted++);
  subscription.unsubscribe(); deliver(response()); await turn();
  assert.equal(emitted, 0); assert.equal(c.rangeRequestsAborted, 1); assert.equal(c.rangeRequestsCompleted, 0); assert.equal(c.pendingOperations, 0);
});
test('network errors are forwarded once and never retried by the adapter', async () => {
  const c = counters(); let calls = 0;
  const adapter = rangeAdapter(fixtures, c, async () => { calls++; throw new Error('offline'); });
  await assert.rejects(firstValueFrom(adapter.downloadFileRange(0, 10, 13)), /offline/);
  await turn(); assert.equal(calls, 1); assert.equal(c.rangeRequestsFailed, 1); assert.equal(c.activeRanges, 0);
});
test('ownership uses the reused R6 snapshot plus actual integration observations', () => {
  const c = newIntegrationCounters();
  assert.ok(Object.values(integrationSnapshot(c)).every(value => value === 0));
  validateIntegrationCleanup(c, 0);
  for (const field of ['workersCreated', 'mediaSourcesCreated', 'sourceBuffersCreated', 'objectUrlsCreated', 'componentsMounted', 'timersLive', 'experimentalListeners', 'pendingOperations']) {
    c.observed[field]++; assert.throws(() => validateIntegrationCleanup(c, 0), /R7_OWNERSHIP_RETAINED/); c.observed[field]--;
  }
});
test('functional errors, corruption and missing settlement invalidate a run; natural GC is recorded', () => {
  const c = newIntegrationCounters();
  Object.assign(c.observed, { initializeAttempts: 1, initializeSettled: 1, playbackStarted: 1, playbackCompleted: 1, bytesAppended: 10 });
  validateIntegrationFunctional(c, 0);
  c.observed.gcRemoveCalls++; validateIntegrationFunctional(c, 0);
  for (const field of ['initializeFailures', 'playbackFailures', 'rangeRequestsFailed', 'workerErrors', 'transferFailures', 'unhandledRejections']) {
    c.observed[field]++; assert.throws(() => validateIntegrationFunctional(c, 0)); c.observed[field]--;
  }
  c.observed.initializeSettled = 0; assert.throws(() => validateIntegrationCleanup(c, 0), /R7_SETTLEMENT_UNBALANCED/);
});
test('network blocker matches forbidden URLs while authorized loopback requests bypass it', async () => {
  let pattern, handler; const events = new Map(), raw = {};
  const context = { route: async (value, fn) => { pattern = value; handler = fn; }, on: (event, fn) => events.set(event, fn) };
  const page = { on() {} };
  await configureIntegrationPage(page, context, raw, 'http://127.0.0.1:1234', ['/', '/main-ABC.js', '/video-0.mp4']);
  for (const url of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/main-ABC.js', 'http://127.0.0.1:1234/video-0.mp4']) assert.equal(pattern.test(url), false);
  for (const url of ['https://example.com/a', 'http://127.0.0.1:1234/other', 'http://127x0x0x1:1234/', 'http://127.0.0.1:12345/', 'http://127.0.0.1:1234/main-ABC.js?x=1']) assert.equal(pattern.test(url), true);
  let aborted = 0; await handler({ abort: async () => { aborted++; } });
  assert.equal(aborted, 1); assert.equal(raw.network.rejectedRequests, 1);
  events.get('request')({ url: () => 'blob:http://127.0.0.1:1234/synthetic' }); assert.equal(raw.network.externalRequests, 0);
});
test('control reuses the R6.2 scheduler and public runner hooks preserve default behavior', () => {
  const script = integrationPageScript();
  assert.match(script, /runOrchestrationFixture\(fixture,'r6\.2',material\)/);
  assert.match(script, /finally\{material\.fdk\.fill\(0\);material\.baseNonce\.fill\(0\)/);
  assert.match(script, /window\.r7WaitPlayback=waitForPlayback/);
  assert.deepEqual(AUTOPLAY_ARGS, ['--autoplay-policy=no-user-gesture-required']);
  const source = readFileSync(new URL('./ap06-transmux-probe.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('if (initializePage) await initializePage') < source.indexOf("await capture('baseline'"));
  assert.match(source, /launchOptions = \{\}, configurePage = null, initializePage = null, identity = \{\}/);
});

const ownedTemp = process.env.AP06_R7_KASUMI_BUNDLE ? null : mkdtempSync(join(tmpdir(), 'nanika-r7-unit-'));
const bundle = process.env.AP06_R7_KASUMI_BUNDLE || join(ownedTemp, 'kasumi.cjs');
if (ownedTemp) await buildKasumi(bundle);
const kasumi = loadKasumi(bundle);
const material = disposableCryptoMaterial(0);
after(() => {
  material.fdk.fill(0); material.baseNonce.fill(0);
  if (ownedTemp) {
    assert.equal(dirname(resolve(ownedTemp)), resolve(tmpdir()));
    assert.ok(ownedTemp.split(/[\\/]/).at(-1).startsWith('nanika-r7-unit-'));
    rmSync(ownedTemp, { recursive: true });
  }
});
const plain = new File([new Uint8Array(4194304 + 37).map((_, i) => i % 251)], 'unit.mp4');
let encrypted;
test('real Kasumi encryptFileParts produces authenticated KAS2 with a partial final chunk', async () => {
  const parts = [];
  for await (const part of kasumi.encryptFileParts(plain, material.fdk, material.baseNonce, '{"name":"unit"}')) parts.push(part);
  encrypted = new Blob(parts);
  assert.equal(material.fdk.length, 32); assert.equal(material.baseNonce.length, 24);
  assert.deepEqual(new Uint8Array(await encrypted.slice(0, 24).arrayBuffer()), material.baseNonce);
  const result = await validateContainer(kasumi, plain, encrypted, material);
  assert.equal(result.dataOffset, 71); assert.equal(result.chunkCount, 2); assert.equal(result.lastChunkBytes, 37);
  assert.equal(result.ciphertextBytes, kasumi.calculateEncryptedSize(plain.size, '{"name":"unit"}'));
  assert.equal(new TextDecoder().decode(await encrypted.slice(32, 36).arrayBuffer()), 'KAS2');
});
test('real Kasumi rejects incorrect FDK and corrupted metadata MAC', async () => {
  const wrong = material.fdk.slice(); wrong[0] ^= 1;
  try { await assert.rejects(kasumi.extractMetadata(encrypted, wrong, encrypted.size), /authenticate/); }
  finally { wrong.fill(0); }
  const bytes = new Uint8Array(await encrypted.arrayBuffer()); bytes[40] ^= 1;
  try { await assert.rejects(kasumi.extractMetadata(new Blob([bytes]), material.fdk, encrypted.size), /authenticate/); }
  finally { bytes.fill(0); }
  const wrongNonce = new Uint8Array(await encrypted.arrayBuffer()); wrongNonce[0] ^= 1;
  try { await assert.rejects(kasumi.extractMetadata(new Blob([wrongNonce]), material.fdk, encrypted.size), /authenticate/); }
  finally { wrongNonce.fill(0); }
});
test('real Kasumi rejects truncated metadata and inconsistent trusted ciphertext size', async () => {
  await assert.rejects(kasumi.extractMetadata(encrypted.slice(0, 60), material.fdk, encrypted.size), /full metadata/);
  await assert.rejects(kasumi.extractMetadata(encrypted, material.fdk, encrypted.size - 1), /corrupted/);
  await assert.rejects(kasumi.decryptFile(encrypted.slice(0, -1), material.fdk, encrypted.size), /corrupted/);
  const overflow = new Uint8Array(await encrypted.arrayBuffer());
  new DataView(overflow.buffer).setBigUint64(24, 2n ** 63n, true);
  try { await assert.rejects(kasumi.extractMetadata(new Blob([overflow]), material.fdk, encrypted.size), /corrupted/); }
  finally { overflow.fill(0); }
});
test('real Kasumi rejects modified data MAC and impossible sizes', async () => {
  const bytes = new Uint8Array(await encrypted.arrayBuffer()); bytes[71] ^= 1;
  try { await assert.rejects(kasumi.decryptFile(new Blob([bytes]), material.fdk, bytes.length), /Authentication failed/); }
  finally { bytes.fill(0); }
  for (const size of [-1, Infinity, 2 ** 54]) assert.throws(() => kasumi.calculateEncryptedSize(size), /Invalid plaintext size/);
  material.fdk.fill(0); material.baseNonce.fill(0);
});
