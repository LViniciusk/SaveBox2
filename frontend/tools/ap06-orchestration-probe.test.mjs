import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { chunkRange, fetchEncryptedRange, createScheduler, walkBoxes, newOrchestrationCounters,
  validateOrchestrationCleanup, orchestrationPageScript } from './ap06-orchestration-probe.mjs';
import { createTransmuxWorkerClient, newTransmuxCounters, appendWorkerOutput } from './ap06-transmux-probe.mjs';
import { generateVideo } from '../e2e-video/video-fixtures.ts';

const CHUNK = 4 * 1024 * 1024;
const fixture = { id: 0, bytes: 2 * CHUNK + 17, chunkCount: 3, dataOffset: 100 };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('fixture bitrate is limited to historical and predeclared supplemental profiles before spawning FFmpeg', async () => {
  await assert.rejects(generateVideo('must-not-be-created.mp4',false,'+faststart',30,9999),/INVALID_EXPERIMENTAL_FIXTURE_BITRATE/);
});

test('scheduler rejects invalid state before opening HTTP or queuing a promise', () => {
  for (const [total, next] of [[0,0],[3,-1],[3,4],[NaN,0],[3,0.5]]) {
    assert.throws(() => createScheduler(total,next,() => assert.fail(),async () => {},newOrchestrationCounters(),() => 0),/INVALID_SCHEDULER_BOUNDS/);
  }
});

test('Kasumi ranges use inclusive bounds, MAC, offset and final partial chunk', () => {
  assert.deepEqual(chunkRange(fixture, 2), { start: 100 + 2 * (CHUNK + 16), end: 100 + 2 * (CHUNK + 16) + 32,
    total: 100 + 2 * CHUNK + 65, plaintextBytes: 17, encryptedBytes: 33 });
  assert.equal(chunkRange(fixture, 0).encryptedBytes, CHUNK + 16);
  for (const index of [-1, 3, 0.5, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => chunkRange(fixture, index), /INVALID/);
  for (const change of [{ id: '../private' }, { bytes: 0 }, { bytes: Number.MAX_SAFE_INTEGER, chunkCount: Math.ceil(Number.MAX_SAFE_INTEGER / CHUNK) },
    { dataOffset: -1 }, { chunkCount: 2 }]) assert.throws(() => chunkRange({ ...fixture, ...change }, 0), /INVALID/);
});

function response(change = {}) {
  const range = chunkRange(fixture, 2);
  return { status: 206, headers: new Map([['Content-Range', `bytes ${range.start}-${range.end}/${range.total}`], ['Content-Length', '33']]),
    blob: async () => new Blob([new Uint8Array(33)]), ...change };
}

test('transport validates 206 and both exact headers before Blob then ArrayBuffer', async () => {
  const counters = newOrchestrationCounters(), events = [];
  const result = await fetchEncryptedRange(fixture, 2, new AbortController().signal, counters, async (url, options) => {
    assert.equal(url, '/video-0.mp4'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Range, `bytes=${chunkRange(fixture, 2).start}-${chunkRange(fixture, 2).end}`);
    return response({ blob: async () => { events.push('blob'); return { size: 33, arrayBuffer: async () => { events.push('arrayBuffer'); return new ArrayBuffer(33); } }; } });
  });
  assert.deepEqual(events, ['blob', 'arrayBuffer']); assert.equal(result.byteLength, 33);
  assert.equal(counters.rangeRequestsCompleted, 1); assert.equal(counters.activeRangeRequests, 0);
});

test('transport rejects wrong status, range, length and truncated bodies', async () => {
  for (const invalid of [response({ status: 200 }), response({ status: 416 }), response({ headers: new Map() }),
    response({ headers: new Map([['Content-Range', 'bytes 0-32/33'], ['Content-Length', '33']]) }),
    response({ blob: async () => new Blob([new Uint8Array(32)]) }),
    response({ blob: async () => ({ size: 33, arrayBuffer: async () => new ArrayBuffer(32) }) })]) {
    const c = newOrchestrationCounters();
    await assert.rejects(fetchEncryptedRange(fixture, 2, new AbortController().signal, c, async () => invalid), /RANGE|TRUNCATED/);
    assert.equal(c.rangeRequestsFailed, 1); assert.equal(c.pendingFetches, 0); assert.equal(c.activeRangeRequests, 0);
  }
});

test('scheduler starts HTTP before the lock, caps three slots and processes reversed responses in order', async () => {
  const counters = newOrchestrationCounters(), gate = deferred(), downloads = Array.from({ length: 3 }, deferred);
  const starts = [], processed = [];
  const scheduler = createScheduler(3, 0, index => { starts.push(index); return downloads[index].promise; }, async index => processed.push(index), counters, () => 0);
  scheduler.state.processLock = gate.promise;
  scheduler.prime(); assert.deepEqual(starts, [0]); scheduler.pump(); assert.deepEqual(starts, [0, 1, 2]);
  assert.equal(counters.maxActiveDownloads, 3); assert.equal(scheduler.state.nextChunkIndex, 3);
  downloads[2].resolve(new ArrayBuffer(1)); downloads[1].resolve(new ArrayBuffer(1)); downloads[0].resolve(new ArrayBuffer(1));
  await tick(); assert.deepEqual(processed, []); gate.resolve(); await tick();
  assert.deepEqual(processed, [0, 1, 2]); await scheduler.close(); validateOrchestrationCleanup(counters, 0);
});

test('scheduler stops at a real 20-second buffer and refills only after demand and settlement', async () => {
  const counters = newOrchestrationCounters(), gate = deferred(), seen = []; let buffer = 20;
  const scheduler = createScheduler(4, 0, async index => { seen.push(index); return new ArrayBuffer(1); }, async () => gate.promise, counters, () => buffer);
  scheduler.pump(); assert.equal(seen.length, 0);
  scheduler.prime(); await tick(); assert.deepEqual(seen, [0]);
  buffer = 0; scheduler.pump(); await tick(); assert.deepEqual(seen, [0, 1, 2]);
  gate.resolve(); await tick(); assert.deepEqual(seen, [0, 1, 2, 3]);
  await scheduler.close(); validateOrchestrationCleanup(counters, 0);
});

test('early HTTP rejection is observed while a previous processing lock is blocked', async () => {
  const unhandled = []; const listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
  try {
    const counters = newOrchestrationCounters(), gate = deferred(), errors = [];
    const scheduler = createScheduler(1, 0, () => Promise.reject(new Error('NETWORK_FAIL')), async () => assert.fail(), counters, () => 0, error => errors.push(error.message));
    scheduler.state.processLock = gate.promise; scheduler.prime(); await tick(); assert.deepEqual(unhandled, []);
    gate.resolve(); await tick(); assert.deepEqual(errors, ['NETWORK_FAIL']); await scheduler.close();
    validateOrchestrationCleanup(counters, 0); assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', listener); }
});

test('processing failure does not leave the lock rejected or ownership unbalanced', async () => {
  const c = newOrchestrationCounters();
  const scheduler = createScheduler(1, 0, async () => new ArrayBuffer(1), async () => { throw new Error('APPEND_FAIL'); }, c, () => 0);
  scheduler.prime(); await tick(); await scheduler.state.processLock;
  assert.equal(scheduler.state.failure.message, 'APPEND_FAIL'); await scheduler.close(); validateOrchestrationCleanup(c, 0);
});

test('close aborts in-flight HTTP, drains promises and is idempotent', async () => {
  const c = newOrchestrationCounters(), signals = [], processed = [];
  const scheduler = createScheduler(3, 0, (index, signal) => new Promise((resolve, reject) => {
    signals.push(signal); signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
  }), async index => processed.push(index), c, () => 0);
  scheduler.pump(); const closing = scheduler.close(); assert.equal(closing, scheduler.close());
  await closing; scheduler.pump(); assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal.aborted));
  assert.deepEqual(processed, []); validateOrchestrationCleanup(c, 0);
});

test('close during processing waits for settlement and a discarded generation cannot process new bytes', async () => {
  const c = newOrchestrationCounters(), processing = deferred(); let started = false, settled = false;
  const scheduler = createScheduler(2, 0, async () => new ArrayBuffer(1), async () => { started = true; await processing.promise; }, c, () => 0);
  scheduler.pump(); await tick(); assert.ok(started);
  const closing = scheduler.close().then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  processing.resolve(); await closing; validateOrchestrationCleanup(c, 0);
  assert.equal(scheduler.state.generation, 1); assert.equal(c.processLockJobsSettled, 2);
});

function box(type, size = 8) {
  const bytes = new ArrayBuffer(size), view = new DataView(bytes); view.setUint32(0, size);
  for (let i = 0; i < 4; i++) view.setUint8(4 + i, type.charCodeAt(i)); return bytes;
}

test('bootstrap parser handles complete faststart, absent moov and absolute versus relative tail offsets', () => {
  assert.deepEqual(walkBoxes(box('moov', 16), 0, 16).moov, { offset: 0, size: 16, absoluteOffset: 0 });
  const head = box('mdat'); new DataView(head).setUint32(0, CHUNK + 8);
  assert.equal(walkBoxes(head, 0, CHUNK + 24).nextTopLevelOffset, CHUNK + 8);
  const tail = new Uint8Array(24); tail.set(new Uint8Array(box('moov', 16)), 8);
  assert.deepEqual(walkBoxes(tail.buffer, CHUNK, CHUNK + 24, 8).moov, { offset: 8, size: 16, absoluteOffset: CHUNK + 8 });
  assert.equal(walkBoxes(box('free'), 0, 8).moov, null);
});

test('bootstrap parser rejects invalid, truncated, incomplete and overflowing metadata', () => {
  const small = box('moov'); new DataView(small).setUint32(0, 16);
  assert.throws(() => walkBoxes(small, 0, 16), /INCOMPLETE/);
  for (const size of [0, 4, 100]) { const bytes = box('free'); new DataView(bytes).setUint32(0, size); assert.throws(() => walkBoxes(bytes, 0, 8), /INVALID/); }
  assert.throws(() => walkBoxes(new ArrayBuffer(7), 0, 7), /TRUNCATED/);
  assert.throws(() => walkBoxes(box('free'), -1, 8), /INVALID/);
  const extended = box('moov', 16), v = new DataView(extended); v.setUint32(0, 1); v.setUint32(8, 0x200000);
  assert.throws(() => walkBoxes(extended, 0, Number.MAX_SAFE_INTEGER), /INVALID/);
});

test('serialized page installs the actual scheduler, range validator and worker pipeline helpers', () => {
  const page = { window: {}, AbortController, Promise, setTimeout, clearTimeout };
  runInNewContext(orchestrationPageScript('r6.1'), page);
  assert.equal(typeof page.window.r5RunFixture, 'function');
  assert.equal(runInNewContext('typeof createScheduler', page), 'function');
  assert.equal(runInNewContext('chunkRange({id:0,bytes:17,chunkCount:1},0).encryptedBytes', page), 33);
  assert.throws(() => orchestrationPageScript('unknown'), /INVALID/);
});

test('transmux handoff failure releases logical input ownership and pending messages', async () => {
  const c = newTransmuxCounters(), worker = new EventTarget(); worker.postMessage = () => { throw new Error('HANDOFF_FAILED'); };
  c.liveKnownArrayBufferBytes = 8;
  const client = createTransmuxWorkerClient(worker, c);
  await assert.rejects(client.send({ type: 'BOOTSTRAP' }, [new ArrayBuffer(8)], 'BOOTSTRAP_COMPLETE'), /HANDOFF/);
  assert.equal(c.knownTransmuxInputBytes, 0); assert.equal(c.liveKnownArrayBufferBytes, 0); assert.equal(c.pendingTransmuxMessages, 0); client.close();
});

test('tail bootstrap accepts init-only output, while the historical faststart contract still requires media', async () => {
  const session = { open: async () => {}, append: async () => {} };
  const previous = globalThis.MediaSource; globalThis.MediaSource = { isTypeSupported: () => true };
  try {
    const output = () => ({ initData: [{ codecString: 'video/mp4', buffer: new ArrayBuffer(8) }], segments: [] });
    await appendWorkerOutput(session, output(), newTransmuxCounters(), true, false);
    await assert.rejects(appendWorkerOutput(session, output(), newTransmuxCounters(), true), /OUTPUT_MISSING/);
  } finally { globalThis.MediaSource = previous; }
});

// Full serialized page with policy mocks only; measurements always load the frozen real workers.
function mockedPage(condition, behavior = {}) {
  const counters = newOrchestrationCounters(), nodes = [], urls = new Map(); let urlId = 0, activeMedia;
  class FakeMedia extends EventTarget {
    constructor() { super(); this.readyState = 'closed'; activeMedia = this; this.appends = 0; }
    static isTypeSupported() { return true; }
    addSourceBuffer() {
      const media = this;
      return new class extends EventTarget {
        updating = false;
        appendBuffer() {
          if (behavior.appendAfterCloseCheck) assert.notEqual(media.readyState, 'closed');
          this.updating = true; media.appends++;
          if (behavior.closeDuringAppend && media.appends === 3) {
            nodes[0].currentTime = 1.6; nodes[0].dispatchEvent(new Event('timeupdate')); return;
          }
          queueMicrotask(() => {
            this.updating = false; this.dispatchEvent(new Event('updateend'));
            if (media.appends >= 2 && nodes[0]?.playing) { nodes[0].currentTime = 1.6; nodes[0].dispatchEvent(new Event('timeupdate')); }
          });
        }
      }();
    }
    endOfStream() { this.readyState = 'ended'; }
  }
  class FakeVideo extends EventTarget {
    currentTime = 0;
    error = null;
    playing = false;
    get readyState() { return activeMedia?.appends >= 2 ? 2 : 0; }
    get buffered() { return { length: activeMedia?.appends >= 2 ? 1 : 0, start: () => 0, end: () => 12 }; }
    set src(url) { this.media = urls.get(url); this.media.readyState = 'open'; queueMicrotask(() => this.media.dispatchEvent(new Event('sourceopen'))); }
    play() {
      this.playing = true;
      if (!behavior.closeDuringAppend && this.readyState >= 2) { this.currentTime = 1.6; queueMicrotask(() => this.dispatchEvent(new Event('timeupdate'))); }
      return Promise.resolve();
    }
    pause() { this.playing = false; }
    removeAttribute() { if (this.media) { this.media.readyState = 'closed'; queueMicrotask(() => this.media.dispatchEvent(new Event('sourceclose'))); } }
    load() {}
    remove() { nodes.splice(nodes.indexOf(this), 1); }
  }
  class FakeWorker extends EventTarget {
    postMessage(message, transfers = []) {
      const received = structuredClone(message, { transfer: transfers });
      if (message.type === 'INIT') return;
      queueMicrotask(() => {
        let data;
        if (message.type === 'DECRYPT_CHUNK') {
          const buffer = new ArrayBuffer(received.encryptedChunk.byteLength - 16), view = new DataView(buffer);
          if (!behavior.invalidMoov && message.chunkIndex === 0) {
            view.setUint32(0, 8); view.setUint32(4, 0x66747970);
            if (condition === 'r6.3') { view.setUint32(8, 2 * CHUNK + 17 - 24); view.setUint32(12, 0x6d646174); }
            else { view.setUint32(8, 8); view.setUint32(12, 0x6d6f6f76); }
          }
          if (condition === 'r6.3' && message.chunkIndex === 2) { view.setUint32(1, 16); view.setUint32(5, 0x6d6f6f76); }
          data = { type: 'CHUNK_DECRYPTED', chunkIndex: message.chunkIndex, decryptedChunk: buffer };
        } else if (message.type === 'BOOTSTRAP') {
          if (condition === 'r6.3') { assert.equal(message.moovOffset, 2 * CHUNK + 1); assert.equal(received.moovBytes.byteLength, 16); }
          data = { type: 'BOOTSTRAP_COMPLETE', initData: [{ codecString: 'video/mp4', buffer: new ArrayBuffer(8) }],
            segments: condition === 'r6.3' ? [] : [{ buffer: new ArrayBuffer(8) }] };
        } else data = { type: 'CHUNK_TRANSMUXED', chunkIndex: message.chunkIndex, segments: [{ buffer: new ArrayBuffer(8) }] };
        this.dispatchEvent(new MessageEvent('message', { data }));
      });
    }
    terminate() {}
  }
  const fixture = { id: 0, bytes: 2 * CHUNK + 17, chunkCount: 3, moovOffset: 8, dataOffset: 0 };
  const context = { window: { r5Counters: counters, r5CryptoWorkerSource: 'test-only-crypto', r5TransmuxWorkerSource: 'test-only-transmux' },
    AbortController, ArrayBuffer, Uint8Array, DataView, Promise, Blob, setTimeout, clearTimeout, Worker: FakeWorker, MediaSource: FakeMedia,
    URL: { createObjectURL(value) { const key = `blob:mock-${++urlId}`; urls.set(key, value); return key; }, revokeObjectURL(key) { urls.delete(key); } },
    document: { createElement() { return new FakeVideo(); }, body: { appendChild(video) { nodes.push(video); } } },
    fetch: async (url, options) => {
      assert.equal(url, '/video-0.mp4'); const start = Number(options.headers.Range.match(/^bytes=(\d+)-/)[1]);
      const index = Math.floor(start / (CHUNK + 16)), range = chunkRange(fixture, index);
      if (behavior.abortPendingFetches && index > 0) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true }));
      return { status: 206, headers: new Map([['Content-Range', `bytes ${range.start}-${range.end}/${range.total}`], ['Content-Length', String(range.encryptedBytes)]]),
        blob: async () => new Blob([new Uint8Array(range.encryptedBytes)]) };
    } };
  runInNewContext(orchestrationPageScript(condition), context);
  return { fixture, counters, nodes, urls, run: () => context.window.r5RunFixture(fixture) };
}

test('serialized faststart pipeline drains real helper ownership when pending policy fetches are aborted', async () => {
  for (const condition of ['r6.1', 'r6.2']) {
    const page = mockedPage(condition, { abortPendingFetches: true });
    await page.run(); validateOrchestrationCleanup(page.counters, page.nodes.length);
    assert.equal(page.counters.rangeRequestsAborted, 2); assert.equal(page.counters.maxActiveRangeRequests, 2);
    assert.equal(page.urls.size, 0); assert.equal(page.counters.playbackSessionsCompleted, 1);
  }
});

test('serialized tail pipeline uses absolute moov offset and init-only bootstrap before ordered chunks', async () => {
  const page = mockedPage('r6.3'); await page.run(); validateOrchestrationCleanup(page.counters, page.nodes.length);
  assert.equal(page.counters.bootstrapMessagesSent, 1); assert.equal(page.counters.playbackSessionsCompleted, 1); assert.equal(page.urls.size, 0);
});

test('serialized close during append cancels and drains without appending after close', async () => {
  const page = mockedPage('r6.1', { closeDuringAppend: true, appendAfterCloseCheck: true });
  await page.run(); validateOrchestrationCleanup(page.counters, page.nodes.length); assert.equal(page.urls.size, 0);
  assert.ok(page.counters.appendOperationsStarted > page.counters.appendOperationsCompleted);
});

test('serialized invalid bootstrap drops unhanded plaintext and closes all owned resources', async () => {
  const page = mockedPage('r6.2', { invalidMoov: true });
  await assert.rejects(page.run(), /INVALID_MP4_BOX/); validateOrchestrationCleanup(page.counters, page.nodes.length); assert.equal(page.urls.size, 0);
});
