import { newOrchestrationCounters } from './ap06-orchestration-probe.mjs';
import { ownershipSnapshot } from './ap06-transmux-probe.mjs';

export function newIntegrationCounters() {
  return { ...newOrchestrationCounters(), observed: Object.fromEntries([
    'initializeAttempts', 'initializeSettled', 'initializeFailures', 'playbackStarted', 'playbackCompleted', 'playbackFailures',
    'destroyCalls', 'componentsMounted', 'componentsDestroyed', 'rangeRequestsStarted', 'rangeRequestsCompleted',
    'rangeRequestsAborted', 'rangeRequestsFailed', 'rangeBytesReceived', 'activeRanges', 'maxActiveRanges', 'metadataRequests',
    'workersCreated', 'workersTerminated', 'workerMessagesSent', 'workerMessagesReceived', 'workerMessagesCancelled',
    'workerErrors', 'detachedTransfers', 'transferFailures', 'mediaSourcesCreated', 'mediaSourcesClosed', 'sourceBuffersCreated',
    'sourceBuffersReleased', 'objectUrlsCreated', 'objectUrlsRevoked', 'pendingOperations', 'pendingAppends',
    'bytesAppended', 'timersLive', 'experimentalListeners', 'unhandledRejections', 'gcRemoveCalls',
    'storeLoadStarted', 'storeLoadCompleted', 'storeFileResolved', 'storeEffectsSettled',
    'authAttempts', 'authSuccesses', 'http206Validated', 'jwtRangesValidated',
    'backendFileIdMatches', 'unexpectedPeripheralOperations', 'outstandingSubscriptions',
  ].map(key => [key, 0])), sessions: [] };
}

export function integrationSnapshot(counters) {
  const c = counters.observed;
  return { ...ownershipSnapshot(counters), workersLive: c.workersCreated - c.workersTerminated,
    observedMediaSourcesLive: c.mediaSourcesCreated - c.mediaSourcesClosed,
    observedSourceBuffersLive: c.sourceBuffersCreated - c.sourceBuffersReleased,
    observedObjectUrlsLive: c.objectUrlsCreated - c.objectUrlsRevoked,
    componentsLive: c.componentsMounted - c.componentsDestroyed, outstandingSubscriptions: c.outstandingSubscriptions,
    pendingOperations: c.pendingOperations,
    observedPendingAppends: c.pendingAppends, timersLive: c.timersLive, experimentalListeners: c.experimentalListeners };
}

export function validateIntegrationCleanup(counters, mediaNodes) {
  if (mediaNodes || Object.values(integrationSnapshot(counters)).some(value => value !== 0)) throw new Error('R7_OWNERSHIP_RETAINED');
  const c = counters.observed;
  if (c.rangeRequestsStarted !== c.rangeRequestsCompleted + c.rangeRequestsAborted + c.rangeRequestsFailed ||
      c.workerMessagesSent !== c.workerMessagesReceived + c.workerMessagesCancelled || c.activeRanges ||
      c.initializeAttempts !== c.initializeSettled || c.unhandledRejections) throw new Error('R7_SETTLEMENT_UNBALANCED');
}

export function validateIntegrationFunctional(counters, mediaNodes) {
  validateIntegrationCleanup(counters, mediaNodes);
  const c = counters.observed;
  if (c.initializeFailures || c.playbackFailures || c.rangeRequestsFailed || c.rangeRequestsAborted || c.workerErrors ||
      c.transferFailures || c.playbackStarted !== c.playbackCompleted || !c.playbackCompleted ||
      c.initializeAttempts !== c.playbackCompleted || !c.bytesAppended) throw new Error('R7_FUNCTIONAL_FAILURE');
}

// Weak records and primitive counters observe native objects without retaining their payloads.
export function installIntegrationInstrumentation() {
  const counters = () => window.r5Counters?.observed;
  const workers = new WeakMap(), sources = new WeakMap(), buffers = new WeakMap();
  const urls = new Set(), timers = new Set();
  const NativeWorker = window.Worker, NativeMediaSource = window.MediaSource;
  window.r7InstrumentationContracts = () => ({ workerPrototypePreserved: window.Worker.prototype === NativeWorker.prototype,
    mediaSourcePrototypePreserved: window.MediaSource.prototype === NativeMediaSource.prototype });
  const nativeSetTimeout = window.setTimeout, nativeSetInterval = window.setInterval;
  const nativeClearTimeout = window.clearTimeout, nativeClearInterval = window.clearInterval;
  window.addEventListener('unhandledrejection', () => { if (counters()) counters().unhandledRejections++; });
  window.Worker = new Proxy(NativeWorker, { construct(target, args, newTarget) {
    const worker = Reflect.construct(target, args, newTarget);
    const c = counters();
    if (!c) throw new Error('R7_UNOBSERVED_WORKER');
    const record = { pending: 0, terminated: false }; workers.set(worker, record); c.workersCreated++;
    worker.addEventListener('message', event => {
      if (record.pending) { record.pending--; c.pendingOperations--; c.workerMessagesReceived++; }
      if (event.data?.type === 'ERROR') c.workerErrors++;
    });
    worker.addEventListener('error', () => { c.workerErrors++; });
    worker.addEventListener('messageerror', () => { c.workerErrors++; });
    return worker;
  } });
  const post = NativeWorker.prototype.postMessage, terminate = NativeWorker.prototype.terminate;
  NativeWorker.prototype.postMessage = function(message, transfer) {
    const record = workers.get(this), c = counters();
    const request = record && ['DECRYPT_CHUNK', 'BOOTSTRAP', 'TRANSMUX_CHUNK', 'SEEK'].includes(message?.type);
    const transfers = Array.isArray(transfer) ? transfer : transfer?.transfer || [];
    if (request) { record.pending++; c.pendingOperations++; c.workerMessagesSent++; }
    try {
      const result = Reflect.apply(post, this, arguments);
      if (request) for (const buffer of transfers) {
        if (buffer instanceof ArrayBuffer && buffer.byteLength === 0) c.detachedTransfers++;
        else c.transferFailures++;
      }
      return result;
    } catch (error) {
      if (request) { record.pending--; c.pendingOperations--; c.workerMessagesCancelled++; }
      throw error;
    }
  };
  NativeWorker.prototype.terminate = function() {
    const result = Reflect.apply(terminate, this, arguments), record = workers.get(this), c = counters();
    if (record && !record.terminated) {
      record.terminated = true; c.workersTerminated++; c.pendingOperations -= record.pending;
      c.workerMessagesCancelled += record.pending; record.pending = 0;
    }
    return result;
  };
  window.MediaSource = new Proxy(NativeMediaSource, { construct(target, args, newTarget) {
    const source = Reflect.construct(target, args, newTarget), c = counters();
    if (!c) throw new Error('R7_UNOBSERVED_MEDIA_SOURCE');
    const record = { buffers: 0 }; sources.set(source, record); c.mediaSourcesCreated++;
    source.addEventListener('sourceclose', () => {
      c.mediaSourcesClosed++; c.sourceBuffersReleased += record.buffers; record.buffers = 0;
    }, { once: true });
    return source;
  } });
  const add = NativeMediaSource.prototype.addSourceBuffer, remove = NativeMediaSource.prototype.removeSourceBuffer;
  NativeMediaSource.prototype.addSourceBuffer = function() {
    const buffer = Reflect.apply(add, this, arguments), record = sources.get(this);
    if (record) { record.buffers++; buffers.set(buffer, { source: record, released: false }); counters().sourceBuffersCreated++; }
    return buffer;
  };
  NativeMediaSource.prototype.removeSourceBuffer = function(buffer) {
    const result = Reflect.apply(remove, this, arguments), record = buffers.get(buffer);
    if (record && !record.released) { record.released = true; record.source.buffers--; counters().sourceBuffersReleased++; }
    return result;
  };
  const append = SourceBuffer.prototype.appendBuffer, evict = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.appendBuffer = function(bytes) {
    const c = counters();
    if (!buffers.has(this)) return Reflect.apply(append, this, arguments);
    let done = false;
    const size = bytes.byteLength;
    const finish = () => {
      if (done) return; done = true; c.pendingAppends--;
      for (const type of ['updateend', 'abort', 'error']) this.removeEventListener(type, finish);
    };
    c.pendingAppends++;
    for (const type of ['updateend', 'abort', 'error']) this.addEventListener(type, finish);
    try { const result = Reflect.apply(append, this, arguments); c.bytesAppended += size; return result; }
    catch (error) { finish(); throw error; }
  };
  SourceBuffer.prototype.remove = function() {
    if (buffers.has(this)) counters().gcRemoveCalls++;
    return Reflect.apply(evict, this, arguments);
  };
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = function() {
    const url = Reflect.apply(createUrl, this, arguments);
    if (counters()) { urls.add(url); counters().objectUrlsCreated++; }
    return url;
  };
  URL.revokeObjectURL = function(url) {
    const result = Reflect.apply(revokeUrl, this, arguments);
    if (urls.delete(url)) counters().objectUrlsRevoked++;
    return result;
  };
  function setTimer(original, repeating, callback, delay, args) {
    if (!window.r7SessionActive || typeof callback !== 'function') return original(callback, delay, ...args);
    const c = counters(); let id;
    id = original(function(...values) {
      if (!repeating && timers.delete(id)) c.timersLive--;
      return Reflect.apply(callback, this, values);
    }, delay, ...args);
    timers.add(id); c.timersLive++; return id;
  }
  window.setTimeout = function(callback, delay, ...args) { return setTimer(nativeSetTimeout, false, callback, delay, args); };
  window.setInterval = function(callback, delay, ...args) { return setTimer(nativeSetInterval, true, callback, delay, args); };
  window.clearTimeout = function(id) { if (timers.delete(id)) counters().timersLive--; return nativeClearTimeout(id); };
  window.clearInterval = function(id) { if (timers.delete(id)) counters().timersLive--; return nativeClearInterval(id); };
}
