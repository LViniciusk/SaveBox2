import test from 'node:test';
import assert from 'node:assert/strict';
import { firstValueFrom } from 'rxjs';
import { buildSync } from 'esbuild';
import { newIntegrationCounters } from './ap06-r7-instrumentation.mjs';
const bundle = buildSync({ entryPoints: ['experiments/ap06-r7/r9-transport.ts'], bundle: true, format: 'esm', write: false });
const { directRange, selectTransport } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const counters = () => ({ ...newIntegrationCounters().observed, directAuthorizedRanges: 0 });
const files = [{ id: 101, ciphertextBytes: 100 }];
const turn = () => new Promise(resolve => setImmediate(resolve));
const response = (status = 206, size = 4, headers = {}) => new Response(new Uint8Array(size), {
  status, headers: { 'Content-Range': 'bytes 10-13/100', 'Content-Length': '4', ...headers } });
test('transport bootstrap enum is strict', () => {
  for (const value of ['xhr', 'angular-fetch', 'direct-fetch']) assert.equal(selectTransport(value), value);
  assert.equal(selectTransport(undefined), null);
  for (const value of [null, '', 'fetch', {}, 0]) assert.throws(() => selectTransport(value));
});
test('cold direct Range uses fixed origin, real-session token, and settles once', async () => {
  const c = counters(); let calls = 0;
  const stream = directRange(101, 10, 13, files, () => 'synthetic-unit-token', c, async (url, options) => {
    calls++; assert.equal(url, 'http://127.0.0.1:42187/files/101/download');
    assert.deepEqual(options.headers, { Authorization: 'Bearer synthetic-unit-token', Range: 'bytes=10-13' });
    assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'default');
    return response();
  });
  assert.equal(calls, 0); assert.equal((await firstValueFrom(stream)).size, 4); await turn();
  assert.equal(calls, 1); assert.equal(c.rangeRequestsCompleted, 1); assert.equal(c.http206Validated, 1);
  assert.equal(c.rangeBytesReceived, 4); assert.equal(c.outstandingSubscriptions, 0); assert.equal(c.activeRanges, 0);
});
test('invalid identities, absent session and unsafe bounds never reach fetch', async () => {
  const transport = () => { throw new Error('MUST_NOT_REQUEST'); };
  for (const id of [0, 102, '101', '../101', 'https://external.test']) {
    assert.throws(() => directRange(id, 10, 13, files, () => 'token', counters(), transport), /FORBIDDEN/);
  }
  for (const [start, end] of [[-1, 3], [10, 9], [0, 100], [0, Infinity], [0, 2**54]]) {
    assert.throws(() => directRange(101, start, end, files, () => 'token', counters(), transport), /BOUNDS/);
  }
  await assert.rejects(firstValueFrom(directRange(101, 10, 13, files, () => null, counters(), transport)), /TOKEN_REQUIRED/);
});
test('invalid statuses, redirect, malformed headers, truncation and transport errors fail without retries', async () => {
  const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true });
  for (const value of [200, 401, 403, 404, 416].map(status => response(status)).concat([
    response(206, 3), response(206, 4, { 'Content-Range': 'bytes 10-13/101' }),
    response(206, 4, { 'Content-Length': '3' }), redirected, new Error('network failure')])) {
    const c = counters(); let calls = 0;
    await assert.rejects(firstValueFrom(directRange(101, 10, 13, files, () => 'token', c, async () => {
      calls++; if (value instanceof Error) throw value; return value;
    })));
    await turn(); assert.equal(calls, 1); assert.equal(c.rangeRequestsFailed, 1); assert.equal(c.rangeRequestsCompleted, 0);
    assert.equal(c.rangeRequestsAborted, 0); assert.equal(c.pendingOperations, 0); assert.equal(c.outstandingSubscriptions, 0);
  }
});
test('unsubscribe aborts once and drains subscriptions without completion or retry', async () => {
  const c = counters(); let signal;
  const sub = directRange(101, 10, 13, files, () => 'token', c, async (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }).subscribe();
  sub.unsubscribe(); sub.unsubscribe(); await turn();
  assert.equal(signal.aborted, true); assert.equal(c.rangeRequestsAborted, 1); assert.equal(c.rangeRequestsFailed, 0);
  assert.equal(c.rangeRequestsCompleted, 0); assert.equal(c.pendingOperations, 0); assert.equal(c.outstandingSubscriptions, 0);
});
test('late body resolution after cancellation cannot emit or double settle', async () => {
  const c = counters(); let release, next = 0, complete = 0;
  const value = response(); value.blob = () => new Promise(resolve => { release = resolve; });
  const sub = directRange(101, 10, 13, files, () => 'token', c, async () => value)
    .subscribe({ next: () => next++, complete: () => complete++ });
  await turn(); sub.unsubscribe(); release(new Blob([new Uint8Array(4)])); await turn();
  assert.equal(next, 0); assert.equal(complete, 0); assert.equal(c.rangeRequestsAborted, 1);
  assert.equal(c.rangeRequestsFailed, 0); assert.equal(c.rangeRequestsCompleted, 0); assert.equal(c.pendingOperations, 0);
});
