import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { KASUMI_CHUNK_SIZE } from './mp4-resource-calibration-lib.mjs';
import { newTransmuxCounters, validateCleanupOwnership, ownershipSnapshot, transmuxPageScript,
  runTransmuxProbe, prepareFixtureCorpus } from './ap06-transmux-probe.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';

export function chunkRange(fixture, index) {
  const { bytes, dataOffset = 0, chunkCount } = fixture;
  if (![bytes, dataOffset, index, chunkCount].every(Number.isSafeInteger) || bytes <= 0 || dataOffset < 0 ||
      chunkCount !== Math.ceil(bytes / KASUMI_CHUNK_SIZE) || index < 0 || index >= chunkCount ||
      ![0, 1, 2].includes(fixture.id)) throw new Error('INVALID_KASUMI_RANGE');
  const plaintextBytes = Math.min(KASUMI_CHUNK_SIZE, bytes - index * KASUMI_CHUNK_SIZE);
  const encryptedBytes = plaintextBytes + 16;
  const start = dataOffset + index * (KASUMI_CHUNK_SIZE + 16);
  const end = start + encryptedBytes - 1;
  const total = dataOffset + bytes + chunkCount * 16;
  if (![start, end, total].every(Number.isSafeInteger)) throw new Error('INVALID_KASUMI_RANGE');
  return { start, end, total, plaintextBytes, encryptedBytes };
}

export async function fetchEncryptedRange(fixture, index, signal, counters, transport = fetch) {
  const range = chunkRange(fixture, index);
  counters.rangeRequestsStarted++; counters.rangeBytesRequested += range.encryptedBytes;
  counters.fetchesStarted++; counters.pendingFetches++; counters.activeRangeRequests++;
  counters.maxActiveRangeRequests = Math.max(counters.maxActiveRangeRequests, counters.activeRangeRequests);
  counters.currentSessionMaxActiveRanges = Math.max(counters.currentSessionMaxActiveRanges, counters.activeRangeRequests);
  try {
    const response = await transport(`/video-${fixture.id}.mp4`, { signal, cache: 'no-store', headers: { Range: `bytes=${range.start}-${range.end}` } });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${range.start}-${range.end}/${range.total}` ||
        response.headers.get('Content-Length') !== String(range.encryptedBytes)) throw new Error('INVALID_RANGE_RESPONSE');
    const blob = await response.blob();
    counters.rangeBytesReceived += blob.size;
    if (blob.size !== range.encryptedBytes) throw new Error('TRUNCATED_RANGE_BODY');
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength !== range.encryptedBytes) throw new Error('TRUNCATED_RANGE_BODY');
    counters.rangeRequestsCompleted++; counters.fetchesCompleted++; counters.bytesFetched += buffer.byteLength;
    return buffer;
  } catch (error) {
    counters.fetchesAborted++;
    if (signal.aborted) counters.rangeRequestsAborted++;
    else counters.rangeRequestsFailed++;
    throw error;
  } finally { counters.pendingFetches--; counters.activeRangeRequests--; }
}

export function createScheduler(totalChunks, nextChunkIndex, fetchChunk, processChunk, counters, bufferedAhead, onError = () => {}) {
  if (![totalChunks, nextChunkIndex].every(Number.isSafeInteger) || totalChunks <= 0 || nextChunkIndex < 0 || nextChunkIndex > totalChunks) {
    throw new Error('INVALID_SCHEDULER_BOUNDS');
  }
  const state = { nextChunkIndex, totalChunks, activeDownloads: 0, processLock: Promise.resolve(),
    currentFetches: new Set(), pendingPipelines: new Set(), generation: 0, closed: false, failure: null };
  let closing;
  function schedule() {
    if (state.closed || state.failure || state.activeDownloads >= 3 || state.nextChunkIndex >= state.totalChunks) return;
    const index = state.nextChunkIndex++, generation = state.generation, controller = new AbortController();
    counters.nextChunkIndex = state.nextChunkIndex;
    state.activeDownloads++; counters.activeDownloads++; counters.currentFetches++;
    counters.maxActiveDownloads = Math.max(counters.maxActiveDownloads, counters.activeDownloads);
    counters.fetchPromisesCreated++; counters.processLockJobsQueued++; counters.pendingSchedulerJobs++;
    state.currentFetches.add(controller);
    let buffer, ownedBytes = 0, request;
    try { request = fetchChunk(index, controller.signal); } catch (error) { request = Promise.reject(error); }
    const fetched = Promise.resolve(request).then(value => {
      buffer = value; ownedBytes = value.byteLength; counters.liveEncryptedFetchBytes += ownedBytes;
      return value;
    });
    fetched.catch(() => {});
    const pipeline = state.processLock.then(async () => {
      if (state.closed || generation !== state.generation) return;
      const bytes = await fetched;
      if (state.closed || generation !== state.generation) return;
      await processChunk(index, bytes);
    });
    state.processLock = pipeline.then(() => {}, () => {});
    let job;
    async function settle(error) {
      if (error && !state.closed && generation === state.generation) {
        state.failure ??= error;
        try { onError(error); } catch (callbackError) { state.failure = callbackError; }
      }
      await fetched.catch(() => {});
      buffer = null; counters.liveEncryptedFetchBytes -= ownedBytes;
      counters.fetchPromisesSettled++; counters.processLockJobsSettled++;
      state.activeDownloads--; counters.activeDownloads--; counters.currentFetches--; counters.pendingSchedulerJobs--;
      state.currentFetches.delete(controller); state.pendingPipelines.delete(job);
      pump();
    }
    job = pipeline.then(() => settle(), error => settle(error));
    job.catch(() => {});
    state.pendingPipelines.add(job);
  }
  function pump() {
    while (!state.closed && !state.failure && state.nextChunkIndex < totalChunks && state.activeDownloads < 3 && bufferedAhead() < 20) schedule();
  }
  function close() {
    if (closing) return closing;
    state.closed = true; state.generation++;
    for (const controller of state.currentFetches) controller.abort();
    closing = (async () => {
      let timer;
      try {
        await Promise.race([Promise.all([...state.pendingPipelines]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('SCHEDULER_DRAIN_TIMEOUT')), 20000);
        })]);
      } finally { clearTimeout(timer); }
      if (state.activeDownloads || state.currentFetches.size || state.pendingPipelines.size) throw new Error('SCHEDULER_OWNERSHIP_RETAINED');
    })();
    return closing;
  }
  return { state, prime: schedule, pump, close };
}

export function walkBoxes(buffer, fileStart, plaintextSize, start = 0) {
  if (![fileStart, plaintextSize, start].every(Number.isSafeInteger) || fileStart < 0 || start < 0 ||
      buffer.byteLength > plaintextSize - fileStart) throw new Error('INVALID_MP4_OFFSET');
  const view = new DataView(buffer);
  let offset = start;
  while (offset <= buffer.byteLength - 8) {
    let size = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (size === 1) {
      if (offset > buffer.byteLength - 16 || view.getUint32(offset + 8) > 0x1fffff) throw new Error('INVALID_MP4_BOX');
      size = view.getUint32(offset + 8) * 0x1_0000_0000 + view.getUint32(offset + 12);
      if (size < 16) throw new Error('INVALID_MP4_BOX');
    }
    if (!Number.isSafeInteger(size) || size < 8 || size > plaintextSize - fileStart - offset) throw new Error('INVALID_MP4_BOX');
    if (type === 0x6d6f6f76) {
      if (size > buffer.byteLength - offset) throw new Error('INCOMPLETE_MOOV');
      return { moov: { offset, size, absoluteOffset: fileStart + offset }, nextTopLevelOffset: null };
    }
    if (size > buffer.byteLength - offset) return { moov: null, nextTopLevelOffset: fileStart + offset + size };
    offset += size;
  }
  if (offset !== buffer.byteLength) throw new Error('TRUNCATED_MP4_BOX_HEADER');
  return { moov: null, nextTopLevelOffset: fileStart + offset };
}

export function newOrchestrationCounters() {
  const counters = newTransmuxCounters('crypto-transmux-mse');
  for (const name of ['rangeRequestsStarted', 'rangeRequestsCompleted', 'rangeRequestsAborted', 'rangeRequestsFailed',
    'rangeBytesRequested', 'rangeBytesReceived', 'activeRangeRequests', 'maxActiveRangeRequests', 'currentSessionMaxActiveRanges',
    'activeDownloads', 'maxActiveDownloads', 'fetchPromisesCreated', 'fetchPromisesSettled', 'processLockJobsQueued',
    'processLockJobsSettled', 'nextChunkIndex', 'pendingSchedulerJobs', 'currentFetches', 'liveEncryptedFetchBytes',
    'playbackSessionsCompleted', 'sessionsWithConcurrentRanges']) counters[name] = 0;
  return counters;
}

export function validateOrchestrationCleanup(counters, mediaNodes) {
  validateCleanupOwnership(counters, mediaNodes, 'crypto-transmux-mse');
  for (const name of ['activeDownloads', 'activeRangeRequests', 'pendingSchedulerJobs', 'currentFetches', 'liveEncryptedFetchBytes']) {
    if (counters[name] !== 0) throw new Error('SCHEDULER_OWNERSHIP_RETAINED');
  }
  if (counters.fetchPromisesCreated !== counters.fetchPromisesSettled || counters.processLockJobsQueued !== counters.processLockJobsSettled ||
      counters.rangeRequestsStarted !== counters.rangeRequestsCompleted + counters.rangeRequestsAborted + counters.rangeRequestsFailed ||
      counters.maxActiveDownloads > 3 || counters.maxActiveRangeRequests > 3) throw new Error('SCHEDULER_COUNTERS_UNBALANCED');
}

export function validateOrchestrationFunctional(counters, mediaNodes) {
  validateOrchestrationCleanup(counters, mediaNodes);
  if (counters.rangeRequestsFailed || counters.transmuxErrors || !counters.segmentBytesAppended ||
      !counters.playbackSessionsCompleted) throw new Error('ORCHESTRATION_FUNCTIONAL_FAILURE');
}

export function orchestrationSnapshot(counters) {
  return { ...ownershipSnapshot(counters), ...Object.fromEntries(['activeDownloads', 'activeRangeRequests',
    'pendingSchedulerJobs', 'currentFetches', 'liveEncryptedFetchBytes'].map(name => [name, counters[name]])) };
}

async function runOrchestrationFixture(fixture, condition, suppliedMaterial = null) {
  const counters = window.r5Counters;
  counters.currentSessionMaxActiveRanges = 0;
  const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; document.body.appendChild(video);
  const mediaSource = new MediaSource(), mediaUrl = URL.createObjectURL(mediaSource);
  const mse = window.r5CreateMseSession(video, mediaSource, mediaUrl, counters, url => URL.revokeObjectURL(url));
  const lifecycle = new AbortController();
  let cryptoHandle, transmuxHandle, client, material, scheduler;
  let bootstrapOwnedBytes = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
  const guardedMse = {
    open(codec) { if (scheduler?.state.closed) throw new Error('STREAM_CLOSED'); return mse.open(codec); },
    append(bytes) { if (scheduler?.state.closed) throw new Error('STREAM_CLOSED'); return mse.append(bytes); },
  };
  async function decrypt(index, encrypted) {
    counters.pendingDecrypts++; counters.messagesPendingCrypto++;
    try { return await window.r5DecryptWorkerChunk(cryptoHandle.worker, encrypted, index,
      chunkRange(fixture, index).plaintextBytes, counters, material); }
    finally { counters.pendingDecrypts--; counters.messagesPendingCrypto--; }
  }
  function bufferedAhead() {
    let end = video.currentTime;
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.end(index) <= end) continue;
      if (video.buffered.start(index) - end > 0.5) break;
      end = Math.max(end, video.buffered.end(index));
    }
    return Math.max(0, end - video.currentTime);
  }
  const tick = () => scheduler?.pump();
  try {
    cryptoHandle = workerBlob(window.r5CryptoWorkerSource, counters, 'crypto'); counters.cryptoWorkersCreated++;
    cryptoHandle.worker.postMessage({ type: 'INIT', logsEnabled: false });
    material = suppliedMaterial ?? window.r5DisposableCryptoMaterial(fixture.id);
    transmuxHandle = workerBlob(window.r5TransmuxWorkerSource, counters, 'transmux'); counters.transmuxWorkersCreated++;
    client = window.r5CreateTransmuxWorkerClient(transmuxHandle.worker, counters, 'crypto-transmux-mse');
    let nextIndex = 0;
    if (condition !== 'r6.1') {
      let first = await decrypt(0, await fetchEncryptedRange(fixture, 0, lifecycle.signal, counters));
      bootstrapOwnedBytes += first.byteLength;
      const head = walkBoxes(first, 0, fixture.bytes);
      let moovBytes = null, moovOffset;
      if (condition === 'r6.2') {
        if (!head.moov) throw new Error('FASTSTART_MOOV_MISSING');
        nextIndex = 1;
      } else {
        const lastIndex = fixture.chunkCount - 1, lastStart = lastIndex * KASUMI_CHUNK_SIZE;
        if (head.moov || head.nextTopLevelOffset === null || head.nextTopLevelOffset < lastStart) throw new Error('INVALID_TAIL_MOOV_TOPOLOGY');
        let last = await decrypt(lastIndex, await fetchEncryptedRange(fixture, lastIndex, lifecycle.signal, counters));
        try {
          const tail = walkBoxes(last, lastStart, fixture.bytes, head.nextTopLevelOffset - lastStart);
          if (!tail.moov) throw new Error('TAIL_MOOV_MISSING');
          moovBytes = last.slice(tail.moov.offset, tail.moov.offset + tail.moov.size); moovOffset = tail.moov.absoluteOffset;
          counters.liveKnownArrayBufferBytes += moovBytes.byteLength;
          bootstrapOwnedBytes += moovBytes.byteLength;
        } finally { counters.liveKnownArrayBufferBytes -= last.byteLength; last = null; }
      }
      const transferables = moovBytes ? [first, moovBytes] : [first];
      bootstrapOwnedBytes = 0; // The client owns input release on transfer or handoff failure.
      const response = await client.send({ type: 'BOOTSTRAP', chunk0: first, moovBytes, moovOffset,
        isLastChunk: fixture.chunkCount === 1 }, transferables, 'BOOTSTRAP_COMPLETE');
      first = null; moovBytes = null;
      await appendWorkerOutput(guardedMse, response, counters, true, condition !== 'r6.3');
      resolveReady();
    }
    scheduler = createScheduler(fixture.chunkCount, nextIndex,
      (index, signal) => fetchEncryptedRange(fixture, index, signal, counters), async (index, encrypted) => {
        let chunk = await decrypt(index, encrypted);
        if (scheduler.state.closed) { counters.liveKnownArrayBufferBytes -= chunk.byteLength; chunk = null; return; }
        const initial = condition === 'r6.1' && index === 0;
        counters.messagesPendingTransmux++;
        let response;
        try {
          response = await client.send(initial
            ? { type: 'BOOTSTRAP', chunk0: chunk, moovBytes: null, moovOffset: fixture.moovOffset, isLastChunk: false }
            : { type: 'TRANSMUX_CHUNK', decryptedChunk: chunk, chunkIndex: index, isLastChunk: index === fixture.chunkCount - 1 },
          [chunk], initial ? 'BOOTSTRAP_COMPLETE' : 'CHUNK_TRANSMUXED');
        } finally { chunk = null; counters.messagesPendingTransmux--; }
        await appendWorkerOutput(guardedMse, response, counters, initial);
        if (initial) resolveReady();
      }, counters, bufferedAhead, error => { rejectReady(error); lifecycle.abort(); });
    video.addEventListener('timeupdate', tick);
    scheduler.prime();
    await ready;
    // Evaluate real demand at playback start, then on timeupdate and pipeline settlement.
    scheduler.pump();
    const progress = waitForPlayback(video, 1.5, lifecycle.signal); progress.catch(() => {});
    try { await video.play(); await progress; }
    catch (error) { lifecycle.abort(); await progress.catch(() => {}); throw scheduler.state.failure || error; }
    if (scheduler.state.failure) throw scheduler.state.failure;
    if (video.error || video.readyState < 2 || video.currentTime <= 1.5) throw new Error('PLAYBACK_ASSERTION_FAILED');
    counters.playbackSessionsCompleted++;
    if (counters.currentSessionMaxActiveRanges >= 2) counters.sessionsWithConcurrentRanges++;
  } finally {
    counters.liveKnownArrayBufferBytes -= bootstrapOwnedBytes;
    video.pause(); video.removeEventListener('timeupdate', tick); lifecycle.abort();
    const drained = scheduler?.close(); client?.close();
    try { await Promise.all([drained, mse.cleanup()]); }
    finally {
      if (cryptoHandle) { cryptoHandle.worker.terminate(); counters.cryptoWorkersTerminated++; cryptoHandle.revoke(); }
      if (transmuxHandle) { transmuxHandle.worker.terminate(); counters.transmuxWorkersTerminated++; transmuxHandle.revoke(); }
      if (material) { material.fdk.fill(0); material.baseNonce.fill(0); }
    }
  }
}

export function orchestrationPageScript(condition) {
  if (!['r6.1', 'r6.2', 'r6.3'].includes(condition)) throw new Error('INVALID_R6_CONDITION');
  return transmuxPageScript() + `const KASUMI_CHUNK_SIZE=${KASUMI_CHUNK_SIZE};` +
    `${chunkRange.toString()};${fetchEncryptedRange.toString()};${createScheduler.toString()};${walkBoxes.toString()};` +
    `${runOrchestrationFixture.toString()};window.r5RunFixture=fixture=>runOrchestrationFixture(fixture,${JSON.stringify(condition)});`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--prepare') {
    const directory = process.env.AP06_R5_FIXTURE_DIR;
    if (!directory) throw new Error('OWNED_FIXTURE_PREPARATION_REQUIRED');
    mkdirSync(directory, { recursive: false });
    const manifest = await prepareFixtureCorpus(directory, { bitrateKbps: 2400, tailMoov: process.env.AP06_R6_TAIL_MOOV === '1' });
    if (manifest.some(fixture => fixture.chunkCount < 3)) throw new Error('INSUFFICIENT_FIXTURE_SCHEDULER_CAPACITY');
    writeJsonAtomic(process.env.AP06_R5_FIXTURE_MANIFEST, manifest);
  } else await runTransmuxProbe({ pageScript: orchestrationPageScript(process.env.AP06_R6_CONDITION),
    countersFactory: newOrchestrationCounters, cleanupValidator: validateOrchestrationCleanup,
    functionalValidator: validateOrchestrationFunctional, snapshot: orchestrationSnapshot });
}
