import test from 'node:test';
import assert from 'node:assert/strict';
import { createMseSession, newOwnership, validateOwnership, summarizeMseRuns, disposableCryptoMaterial, decryptFixture } from './ap06-mse-probe.mjs';

function rig(appendMode = 'success') {
  const counters = newOwnership(), source = new EventTarget(), buffer = new EventTarget(), video = new EventTarget();
  source.readyState = 'closed'; buffer.updating = false;
  buffer.appendBuffer = () => {
    buffer.updating = true;
    if (appendMode !== 'pending') queueMicrotask(() => {
      buffer.updating = false; buffer.dispatchEvent(new Event(appendMode === 'error' ? 'error' : 'updateend'));
    });
  };
  source.addSourceBuffer = () => buffer;
  source.endOfStream = () => { source.readyState = 'ended'; };
  Object.defineProperty(video, 'src', { set() { queueMicrotask(() => { source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen')); }); } });
  video.pause = () => { video.paused = true; };
  video.removeAttribute = name => { assert.equal(name, 'src'); video.detached = true; };
  video.load = () => { source.readyState = 'closed'; source.dispatchEvent(new Event('sourceclose')); };
  video.remove = () => { video.removed = true; };
  video.play = async () => {
    video.readyState = 2; video.currentTime = 1.5; video.error = null;
    video.dispatchEvent(new Event('timeupdate'));
  };
  const revoked = [];
  const session = createMseSession(video, source, 'blob:disposable-test', counters, url => revoked.push(url));
  return { session, counters, source, buffer, video, revoked };
}

test('successful lifecycle closes resources and cleanup is idempotent', async () => {
  const value = rig(); await value.session.play(new ArrayBuffer(8), 'video/mp4; codecs="test"');
  assert.equal(value.session.phase, 'CLOSED'); assert.equal(value.video.paused, true);
  assert.equal(value.video.detached, true); assert.equal(value.video.removed, true);
  assert.deepEqual(value.revoked, ['blob:disposable-test']);
  const first = value.session.cleanup(); assert.equal(first, value.session.cleanup()); await first;
  assert.equal(value.counters.sourceBuffersReleased, 1); assert.equal(value.counters.mediaSourceClosed, 1);
  assert.equal(value.counters.liveKnownArrayBufferBytes, 0); assert.equal(value.counters.pendingAppends, 0);
  assert.equal(value.counters.bytesAppended, 8);
});

test('transmux init and media segments can be appended sequentially in one MSE session', async () => {
  const value = rig();
  try {
    await value.session.open('video/mp4');
    await value.session.append(new ArrayBuffer(4));
    await value.session.append(new ArrayBuffer(8));
    assert.equal(value.counters.appendOperationsCompleted, 2);
    assert.equal(value.counters.bytesAppended, 12);
    assert.equal(value.counters.pendingAppends, 0);
    assert.equal(value.counters.liveKnownArrayBufferBytes, 0);
  } finally { await value.session.cleanup(); }
});

test('append error settles ownership, revokes URL and removes video without claiming functional PASS', async () => {
  const value = rig('error');
  await assert.rejects(value.session.play(new ArrayBuffer(8), 'video/mp4'), /MEDIA_OR_SOURCEBUFFER_ERROR/);
  assert.equal(value.session.phase, 'CLOSED'); assert.equal(value.video.removed, true);
  assert.equal(value.revoked.length, 1); assert.equal(value.counters.pendingAppends, 0);
  assert.equal(value.counters.liveKnownArrayBufferBytes, 0);
  assert.throws(() => validateOwnership(value.counters, 0), /UNBALANCED/);
});

test('cleanup rejects and settles a pending append without native SourceBuffer.abort', async () => {
  const value = rig('pending'); await value.session.open('video/mp4');
  const pending = value.session.append(new ArrayBuffer(16));
  const rejection = assert.rejects(pending, /MSE_OPERATION_CANCELLED/);
  await value.session.cleanup(); await rejection;
  assert.equal(value.counters.liveKnownArrayBufferBytes, 0); assert.equal(value.counters.pendingAppends, 0);
  assert.equal(value.counters.sourceBuffersReleased, 1); assert.equal(value.revoked.length, 1);
  assert.equal(value.video.removed, true); assert.equal(value.session.phase, 'CLOSED');
});

test('all logical counters and functional completion must pass independently of memory values', () => {
  const counters = newOwnership(); validateOwnership(counters, 0);
  for (const key of ['liveKnownArrayBufferBytes', 'pendingFetches', 'pendingAppends', 'objectUrlsCreated', 'mediaSourceCreated', 'sourceBuffersCreated']) {
    assert.throws(() => validateOwnership({ ...counters, [key]: 1 }, 0));
  }
  assert.throws(() => validateOwnership(counters, 1));
  assert.throws(() => validateOwnership({ ...counters, bytesFetched: 1 }, 0));
});

test('per-process summaries preserve signed deltas, independent samples and no p95 from three', () => {
  const sample = (id, phase, browser, renderer) => ({ runId: id, scenarioId: 'plain-mse', fixtureId: 'ABC-fMP4-corpus',
    browserVersion: 'test', sourceHash: 'same', phase, gc: 'natural', timestamp: '2026-10-04T00:00:00Z', functionalStatus: 'PASS',
    metrics: { JSHeapUsedSize: browser, JSHeapTotalSize: 100, Nodes: 1, Documents: 1 },
    processMemory: { status: 'AVAILABLE', privateBytes: browser + renderer, workingSetBytes: 100,
      byCategory: { browser: { privateBytes: browser, workingSetBytes: browser }, renderer: { privateBytes: renderer, workingSetBytes: renderer } } } });
  const raw = { runs: ['a', 'b', 'c'].map((id, i) => ({ runId: id, functionalStatus: 'PASS', cleanupStatus: 'PASS', samples: [
    sample(id, 'baseline', 10, 20), sample(id, 'cycle-6-close', [3, 6, 9][i], 25) ] })) };
  const summary = summarizeMseRuns(raw), phase = summary.phases.find(row => row.phase === 'cycle-6-close');
  assert.deepEqual(phase.processTypes.browser.privateBytes.signedDelta, { min: -7, median: -4, max: -1 });
  assert.deepEqual(phase.processTypes.renderer.privateBytes.signedDelta, { min: 5, median: 5, max: 5 });
  assert.deepEqual(phase.processTypes['gpu-process'], { status: 'NOT_AVAILABLE' });
  assert.equal(summary.p95, null);
  raw.runs[0].functionalStatus = 'FAIL'; assert.throws(() => summarizeMseRuns(raw));
});

test('crypto handoff transfers all three inputs, settles each serial request and wipes disposable material', async () => {
  const worker = new EventTarget(), material = disposableCryptoMaterial(0);
  const counters = { ...newOwnership(), messagesPending: 0, decryptOperationsPending: 0, encryptedChunksSent: 0,
    encryptedBytesSent: 0, decryptedChunksReceived: 0, decryptedBytesReceived: 0, detachedTransfersObserved: 0 };
  worker.postMessage = (message, transfers) => {
    assert.equal(transfers.length, 3); assert.deepEqual(transfers, [message.encryptedChunk, message.fdk, message.baseNonce]);
    const transferred = structuredClone(message, { transfer: transfers });
    queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data: { type: 'CHUNK_DECRYPTED',
      chunkIndex: transferred.chunkIndex, decryptedChunk: transferred.encryptedChunk.slice(16) } })));
  };
  const input = new Uint8Array(72).fill(7);
  const result = await decryptFixture(worker, input.buffer, { bytes: 24, chunkBytes: 8, chunkCount: 3 }, counters, material);
  assert.equal(result.byteLength, 24); assert.equal(counters.encryptedChunksSent, 3);
  assert.equal(counters.detachedTransfersObserved, 3); assert.equal(counters.decryptedChunksReceived, 3);
  assert.equal(counters.messagesPending, 0); assert.equal(counters.decryptOperationsPending, 0);
  assert.equal(counters.liveKnownArrayBufferBytes, 0);
  assert.ok(material.fdk.every(byte => byte === 0)); assert.ok(material.baseNonce.every(byte => byte === 0));
});

test('failed crypto handoff settles ownership and wipes key copies without pretending to decrypt', async () => {
  const worker = new EventTarget(), material = disposableCryptoMaterial(1); let message;
  worker.postMessage = value => { message = value; throw new Error('HANDOFF'); };
  const counters = { ...newOwnership(), messagesPending: 0, decryptOperationsPending: 0 };
  await assert.rejects(decryptFixture(worker, new ArrayBuffer(24), { bytes: 8, chunkBytes: 8, chunkCount: 1 }, counters, material), /CRYPTO_HANDOFF_FAILED/);
  assert.equal(counters.liveKnownArrayBufferBytes, 0); assert.equal(counters.messagesPending, 0); assert.equal(counters.decryptOperationsPending, 0);
  assert.ok(new Uint8Array(message.fdk).every(byte => byte === 0)); assert.ok(new Uint8Array(message.baseNonce).every(byte => byte === 0));
  assert.ok(material.fdk.every(byte => byte === 0)); assert.ok(material.baseNonce.every(byte => byte === 0));
});
