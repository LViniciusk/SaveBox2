import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectRawMetrics, writeJsonAtomic } from './browser-memory-probe.mjs';
import { sampleOwnedProcesses } from './ap06-process-sample.mjs';
import {
  createMseSession, decryptWorkerChunk, disposableCryptoMaterial, newOwnership, summarizeMseRuns,
} from './ap06-mse-probe.mjs';
import { KASUMI_CHUNK_SIZE, scanMp4ResourceMetadata } from './mp4-resource-calibration-lib.mjs';
import { generateVideo } from '../e2e-video/video-fixtures.ts';

const exec = promisify(execFile);
const FIXTURE_CASES = [
  { id: 0, name: 'classic-faststart-av-30s', audio: true, seconds: 30 },
  { id: 1, name: 'classic-faststart-video-35s', audio: false, seconds: 35 },
  { id: 2, name: 'classic-faststart-av-35s', audio: true, seconds: 35 },
];

export function validateExpectedChromiumVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID');
  }
  return value;
}

export function parseChromiumVersion(text) {
  const match = String(text).match(/\b(\d+\.\d+\.\d+\.\d+)\b/);
  if (!match) throw new Error('CHROMIUM_VERSION_PREFLIGHT_INVALID');
  return match[1];
}

export function classifyPreflightExecutionError(error) {
  if (error?.killed === true || error?.code === 'ETIMEDOUT') return 'CHROMIUM_VERSION_PREFLIGHT_TIMEOUT';
  if (error?.code === 'ENOENT') return 'CHROMIUM_VERSION_PREFLIGHT_PROCESS_UNAVAILABLE';
  if (Number.isInteger(error?.code)) return 'CHROMIUM_VERSION_PREFLIGHT_NONZERO_EXIT';
  return 'CHROMIUM_VERSION_PREFLIGHT_EXECUTION_FAILED';
}

export async function readChromiumBinaryVersion(executablePath, {
  platform = process.platform, execute = exec, environment = process.env,
} = {}) {
  const method = platform === 'win32' ? 'windows-file-version' : 'binary--version';
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
  const executable = platform === 'win32'
    ? systemRoot ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
    : executablePath;
  const args = platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:AP06_CHROMIUM_EXE).VersionInfo.FileVersion'] : ['--version'];
  const options = { windowsHide: true, timeout: 5000, maxBuffer: 65536 };
  if (platform === 'win32') options.env = { ...environment, AP06_CHROMIUM_EXE: executablePath };
  let output;
  try {
    output = await execute(executable, args, options);
  } catch (error) {
    throw Object.assign(new Error(classifyPreflightExecutionError(error)), { processInvoked: true, method });
  }
  try {
    return { version: parseChromiumVersion(`${output.stdout ?? ''}\n${output.stderr ?? ''}`), method };
  } catch (error) {
    throw Object.assign(error, { processInvoked: true, method });
  }
}

export async function chromiumIdentityPreflight(expectedValue, getExecutablePath, options = {}) {
  const expectedVersion = validateExpectedChromiumVersion(expectedValue);
  const executablePath = getExecutablePath();
  if (typeof executablePath !== 'string' || !executablePath) throw new Error('CHROMIUM_EXECUTABLE_UNAVAILABLE');
  const observed = await readChromiumBinaryVersion(executablePath, options);
  if (observed.version !== expectedVersion) {
    throw Object.assign(new Error('CHROMIUM_BINARY_VERSION_MISMATCH'), {
      processInvoked: true, observedVersion: observed.version, method: observed.method,
    });
  }
  return { status: 'PASS', expectedVersion, observedVersion: observed.version,
    authority: 'playwright-chromium-executable', method: observed.method, executablePath };
}

export async function chromiumPreflightResult(expectedValue, getExecutablePath, options = {}) {
  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedChromiumVersion(expectedValue);
    const result = await chromiumIdentityPreflight(expectedVersion, getExecutablePath, options);
    return { ...result, processInvoked: true, nodeVersion: process.version };
  } catch (error) {
    const failureClass = /^[A-Z0-9_]+$/.test(error?.message ?? '')
      ? error.message : 'CHROMIUM_VERSION_PREFLIGHT_EXECUTION_FAILED';
    return { status: 'FAIL', expectedVersion, observedVersion: error?.observedVersion ?? null,
      authority: 'playwright-chromium-executable', method: error?.method ?? null,
      failureClass, processInvoked: error?.processInvoked === true, nodeVersion: process.version };
  }
}

export function newTransmuxCounters(mode = 'transmux-mse') {
  const counters = newOwnership();
  for (const key of [
    'transmuxWorkersCreated', 'transmuxWorkersTerminated', 'transmuxMessagesPending',
    'bootstrapMessagesSent', 'bootstrapResponsesReceived', 'transmuxChunksSent', 'transmuxResponsesReceived',
    'bootstrapInputBytes', 'bootstrapInputBuffersTransferred', 'bootstrapInputBuffersDetached',
    'transmuxInputBytes', 'transmuxInputTransfersDetached', 'detachedTransmuxInputs',
    'initSegmentsReceived', 'initSegmentBytesReceived', 'mediaSegmentsReceived', 'mediaSegmentBytesReceived',
    'outputTransferBuffersReceived', 'segmentBytesAppended', 'pendingTransmuxMessages',
    'knownTransmuxInputBytes', 'knownTransmuxOutputBytes', 'transmuxErrors',
    'workerUrlsCreated', 'workerUrlsRevoked',
  ]) counters[key] = 0;
  if (mode === 'crypto-transmux-mse') Object.assign(counters, {
    cryptoWorkersCreated: 0, cryptoWorkersTerminated: 0, cryptoWorkerUrlsCreated: 0, cryptoWorkerUrlsRevoked: 0,
    encryptedChunksSent: 0, encryptedBytesSent: 0, decryptedChunksReceived: 0, decryptedBytesReceived: 0,
    detachedTransfersObserved: 0, cryptoToTransmuxTransfers: 0, cryptoToTransmuxDetached: 0,
    pendingDecrypts: 0, messagesPendingCrypto: 0, messagesPendingTransmux: 0,
    messagesPending: 0, decryptOperationsPending: 0,
  });
  return counters;
}

export function createTransmuxWorkerClient(worker, counters, mode = 'transmux-mse') {
  let closed = false;
  const pending = new Set();
  return {
    send(message, transferables, expectedType) {
      if (closed) return Promise.reject(new Error('TRANSMUX_CLIENT_CLOSED'));
      const bootstrap = message.type === 'BOOTSTRAP';
      const inputBytes = transferables.reduce((sum, item) => sum + item.byteLength, 0);
      counters.pendingTransmuxMessages++;
      counters.transmuxMessagesPending++;
      counters.knownTransmuxInputBytes += inputBytes;
      if (bootstrap) {
        counters.bootstrapMessagesSent++;
        counters.bootstrapInputBytes += inputBytes;
        counters.bootstrapInputBuffersTransferred += transferables.length;
      } else {
        counters.transmuxChunksSent++;
        counters.transmuxInputBytes += inputBytes;
      }
      if (mode === 'crypto-transmux-mse') counters.cryptoToTransmuxTransfers++;

      return new Promise((resolve, reject) => {
        let settled = false;
        let inputReleased = false;
        let timeout;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          pending.delete(cancel);
          counters.pendingTransmuxMessages--;
          counters.transmuxMessagesPending--;
          error ? reject(error) : resolve(value);
        };
        const cancel = () => finish(new Error('TRANSMUX_REQUEST_CANCELLED'));
        const onError = () => { counters.transmuxErrors++; finish(new Error('TRANSMUX_WORKER_FAILED')); };
        const onMessage = event => {
          const data = event.data;
          if (data?.type === 'ERROR') { counters.transmuxErrors++; finish(new Error(data.message || 'TRANSMUX_WORKER_ERROR')); return; }
          if (data?.type !== expectedType) return;
          if (expectedType === 'CHUNK_TRANSMUXED' && data.chunkIndex !== message.chunkIndex) return;
          if (bootstrap) counters.bootstrapResponsesReceived++;
          else counters.transmuxResponsesReceived++;
          finish(null, data);
        };
        pending.add(cancel);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        timeout = setTimeout(() => { counters.transmuxErrors++; finish(new Error('TRANSMUX_RESPONSE_TIMEOUT')); }, 15000);
        try {
          worker.postMessage(message, transferables);
          const detached = transferables.reduce((count, item) => count + Number(item.byteLength === 0), 0);
          if (detached !== transferables.length) throw new Error('TRANSMUX_TRANSFER_NOT_DETACHED');
          counters.knownTransmuxInputBytes -= inputBytes;
          counters.liveKnownArrayBufferBytes -= inputBytes;
          inputReleased = true;
          if (bootstrap) counters.bootstrapInputBuffersDetached += detached;
          else {
            counters.transmuxInputTransfersDetached += detached;
            counters.detachedTransmuxInputs += detached;
          }
          if (mode === 'crypto-transmux-mse') counters.cryptoToTransmuxDetached++;
        } catch {
          if (!inputReleased) {
            counters.knownTransmuxInputBytes -= inputBytes;
            counters.liveKnownArrayBufferBytes -= inputBytes;
          }
          counters.transmuxErrors++;
          finish(new Error('TRANSMUX_HANDOFF_FAILED'));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
    },
  };
}

export function validateCleanupOwnership(counters, mediaNodes, mode = 'transmux-mse') {
  for (const key of ['liveKnownArrayBufferBytes', 'pendingFetches', 'pendingAppends', 'pendingTransmuxMessages',
    'transmuxMessagesPending', 'knownTransmuxInputBytes', 'knownTransmuxOutputBytes']) {
    if (counters[key] !== 0) throw new Error('FUNCTIONAL_OWNERSHIP_FAIL');
  }
  if (counters.transmuxWorkersCreated !== counters.transmuxWorkersTerminated ||
      counters.workerUrlsCreated !== counters.workerUrlsRevoked ||
      counters.mediaSourceCreated !== counters.mediaSourceClosed ||
      counters.objectUrlsCreated !== counters.objectUrlsRevoked ||
      counters.sourceBuffersCreated !== counters.sourceBuffersReleased ||
      counters.fetchesStarted !== counters.fetchesCompleted + counters.fetchesAborted || mediaNodes !== 0) {
    throw new Error('FUNCTIONAL_OWNERSHIP_FAIL');
  }
  if (mode === 'crypto-transmux-mse' && (
    counters.cryptoWorkersCreated !== counters.cryptoWorkersTerminated ||
    counters.cryptoWorkerUrlsCreated !== counters.cryptoWorkerUrlsRevoked ||
    counters.pendingDecrypts !== 0 || counters.messagesPendingCrypto !== 0 || counters.messagesPendingTransmux !== 0 ||
    counters.messagesPending !== 0 || counters.decryptOperationsPending !== 0
  )) throw new Error('FUNCTIONAL_CRYPTO_OWNERSHIP_FAIL');
}

export function validateTransmuxOwnership(counters, mediaNodes, mode = 'transmux-mse') {
  validateCleanupOwnership(counters, mediaNodes, mode);
  if (counters.fetchesAborted !== 0 || counters.transmuxErrors !== 0 ||
      counters.appendOperationsStarted !== counters.appendOperationsCompleted) throw new Error('FUNCTIONAL_OWNERSHIP_FAIL');
  if (counters.bootstrapMessagesSent !== counters.bootstrapResponsesReceived ||
      counters.transmuxChunksSent !== counters.transmuxResponsesReceived ||
      counters.bootstrapInputBuffersTransferred !== counters.bootstrapInputBuffersDetached ||
      counters.transmuxInputTransfersDetached !== counters.detachedTransmuxInputs ||
      counters.outputTransferBuffersReceived !== counters.initSegmentsReceived + counters.mediaSegmentsReceived ||
      counters.segmentBytesAppended !== counters.initSegmentBytesReceived + counters.mediaSegmentBytesReceived ||
      counters.initSegmentsReceived === 0 || counters.mediaSegmentsReceived === 0 || counters.transmuxChunksSent === 0) {
    throw new Error('FUNCTIONAL_TRANSMUX_INCOMPLETE');
  }
  if (mode === 'crypto-transmux-mse' && (
    counters.encryptedChunksSent !== counters.decryptedChunksReceived ||
    counters.encryptedChunksSent !== counters.detachedTransfersObserved ||
    counters.cryptoToTransmuxTransfers !== counters.cryptoToTransmuxDetached ||
    counters.cryptoToTransmuxTransfers !== counters.bootstrapMessagesSent + counters.transmuxChunksSent
  )) throw new Error('FUNCTIONAL_CRYPTO_OWNERSHIP_FAIL');
}

export function classifyTransmux(summary) {
  const phase = summary?.phases?.find(row => row.phase === 'cycle-6-close' && row.gc === 'natural');
  const byType = phase?.processTypes;
  const browser = byType?.browser?.privateBytes?.signedDelta?.median;
  const renderer = byType?.renderer?.privateBytes?.signedDelta?.median;
  if (!Number.isFinite(browser) || !Number.isFinite(renderer) || browser === renderer) return 'INCONCLUSIVE_TRANSMUX_MSE_OWNERSHIP';
  return browser > renderer && browser > 0
    ? 'TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP'
    : 'TRANSMUX_MSE_DOES_NOT_REPRODUCE';
}

function workerBlob(source, counters, kind) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  if (kind === 'crypto') counters.cryptoWorkerUrlsCreated++;
  else counters.workerUrlsCreated++;
  let worker;
  try { worker = new Worker(url, { type: 'module' }); }
  catch (error) {
    URL.revokeObjectURL(url);
    if (kind === 'crypto') counters.cryptoWorkerUrlsRevoked++;
    else counters.workerUrlsRevoked++;
    throw error;
  }
  return { url, worker, revoke() {
    URL.revokeObjectURL(url);
    if (kind === 'crypto') counters.cryptoWorkerUrlsRevoked++;
    else counters.workerUrlsRevoked++;
  } };
}

function waitForPlayback(video, targetSeconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(deadline);
      for (const type of ['loadedmetadata', 'canplay', 'timeupdate', 'error']) video.removeEventListener(type, check);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (video.error) finish(new Error('MEDIA_ERROR'));
      else if (video.readyState >= 2 && video.currentTime >= targetSeconds) finish();
    };
    const aborted = () => finish(new Error('PLAYBACK_CANCELLED'));
    const deadline = setTimeout(() => finish(new Error('PLAYBACK_PROGRESS_TIMEOUT')), 15000);
    for (const type of ['loadedmetadata', 'canplay', 'timeupdate', 'error']) video.addEventListener(type, check);
    signal.addEventListener('abort', aborted, { once: true });
    check();
  });
}

export async function appendWorkerOutput(session, response, counters, initial, requireInitialMedia = true) {
  const initData = response.initData || [];
  const segments = response.segments || [];
  counters.initSegmentsReceived += initData.length;
  counters.initSegmentBytesReceived += initData.reduce((sum, item) => sum + item.buffer.byteLength, 0);
  counters.mediaSegmentsReceived += segments.length;
  counters.mediaSegmentBytesReceived += segments.reduce((sum, item) => sum + item.buffer.byteLength, 0);
  counters.outputTransferBuffersReceived += initData.length + segments.length;
  counters.knownTransmuxOutputBytes += initData.reduce((sum, item) => sum + item.buffer.byteLength, 0) +
    segments.reduce((sum, item) => sum + item.buffer.byteLength, 0);
  try {
    if (initial) {
      const codec = initData[0]?.codecString;
      if (!codec || !MediaSource.isTypeSupported(codec)) throw new Error('TRANSMUX_CODEC_UNSUPPORTED');
      await session.open(codec);
    }
    for (const list of [initData, segments]) for (const item of list) {
      const bytes = item.buffer, size = bytes.byteLength;
      try { await session.append(bytes); counters.segmentBytesAppended += size; }
      finally { item.buffer = null; counters.knownTransmuxOutputBytes -= size; }
    }
    if (initial && (!initData.length || (requireInitialMedia && !segments.length))) throw new Error('TRANSMUX_BOOTSTRAP_OUTPUT_MISSING');
  } finally {
    for (const list of [initData, segments]) for (const item of list) if (item.buffer) {
      counters.knownTransmuxOutputBytes -= item.buffer.byteLength; item.buffer = null;
    }
  }
}

export function transmuxPageScript() {
  return `${workerBlob.toString()};${waitForPlayback.toString()};${appendWorkerOutput.toString()};` +
    `window.r5CreateMseSession=${createMseSession.toString()};` +
    `window.r5CreateTransmuxWorkerClient=${createTransmuxWorkerClient.toString()};` +
    `window.r5DecryptWorkerChunk=${decryptWorkerChunk.toString()};` +
    `window.r5DisposableCryptoMaterial=${disposableCryptoMaterial.toString()};` +
    `window.r5RunFixture=${runFixtureInPage.toString()};`;
}

async function runFixtureInPage(fixture, mode) {
  const counters = window.r5Counters;
  const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; document.body.appendChild(video);
  const mediaSource = new MediaSource();
  const mediaUrl = URL.createObjectURL(mediaSource);
  const mse = window.r5CreateMseSession(video, mediaSource, mediaUrl, counters, url => URL.revokeObjectURL(url));
  let sourceBytes = null, ownedSourceBytes = 0, transmuxHandle = null, client = null;
  let cryptoHandle = null, material = null;
  try {
    counters.fetchesStarted++; counters.pendingFetches++;
    try {
      const response = await fetch(`/video-${fixture.id}.mp4`);
      if (!response.ok) throw new Error('FIXTURE_HTTP_FAILED');
      sourceBytes = await response.arrayBuffer();
      counters.fetchesCompleted++; counters.bytesFetched += sourceBytes.byteLength;
    } catch (error) { counters.fetchesAborted++; throw error; }
    finally { counters.pendingFetches--; }
    ownedSourceBytes = sourceBytes.byteLength; counters.liveKnownArrayBufferBytes += ownedSourceBytes;
    const expectedSourceBytes = mode === 'crypto-transmux-mse' ? fixture.ciphertextBytes : fixture.bytes;
    if (sourceBytes.byteLength !== expectedSourceBytes) throw new Error('FIXTURE_SIZE_MISMATCH');

    if (mode === 'crypto-transmux-mse') {
      cryptoHandle = workerBlob(window.r5CryptoWorkerSource, counters, 'crypto'); counters.cryptoWorkersCreated++;
      cryptoHandle.worker.postMessage({ type: 'INIT', logsEnabled: false });
      material = window.r5DisposableCryptoMaterial(fixture.id);
    }
    transmuxHandle = workerBlob(window.r5TransmuxWorkerSource, counters, 'transmux');
    counters.transmuxWorkersCreated++;
    client = window.r5CreateTransmuxWorkerClient(transmuxHandle.worker, counters, mode);

    const chunkCount = fixture.chunkCount;
    if (chunkCount < 2 || fixture.moovOffset >= fixture.chunkBytes) throw new Error('FIXTURE_NOT_MULTI_CHUNK_FASTSTART');
    let firstChunk;
    if (mode === 'crypto-transmux-mse') {
      const cipherChunk = sourceBytes.slice(0, fixture.chunkBytes + 16);
      counters.pendingDecrypts++; counters.messagesPendingCrypto++;
      try {
        firstChunk = await window.r5DecryptWorkerChunk(cryptoHandle.worker, cipherChunk, 0, fixture.chunkBytes,
          counters, material);
      } finally { counters.pendingDecrypts--; counters.messagesPendingCrypto--; }
    } else firstChunk = sourceBytes.slice(0, fixture.chunkBytes);
    if (mode !== 'crypto-transmux-mse') counters.liveKnownArrayBufferBytes += firstChunk.byteLength;
    const bootstrap = await client.send({ type: 'BOOTSTRAP', chunk0: firstChunk, moovBytes: null, moovOffset: fixture.moovOffset,
      isLastChunk: chunkCount === 1 }, [firstChunk], 'BOOTSTRAP_COMPLETE');
    await appendWorkerOutput(mse, bootstrap, counters, true);

    let plainOffset = fixture.chunkBytes;
    let cipherOffset = fixture.chunkBytes + 16;
    for (let chunkIndex = 1; chunkIndex < chunkCount; chunkIndex++) {
      const plainBytes = Math.min(fixture.chunkBytes, fixture.bytes - plainOffset);
      let chunk;
      if (mode === 'crypto-transmux-mse') {
        const cipherChunk = sourceBytes.slice(cipherOffset, cipherOffset + plainBytes + 16);
        counters.pendingDecrypts++; counters.messagesPendingCrypto++;
        try {
          chunk = await window.r5DecryptWorkerChunk(cryptoHandle.worker, cipherChunk, chunkIndex, plainBytes,
            counters, material);
        } finally { counters.pendingDecrypts--; counters.messagesPendingCrypto--; }
        cipherOffset += plainBytes + 16;
      } else {
        chunk = sourceBytes.slice(plainOffset, plainOffset + plainBytes);
        counters.liveKnownArrayBufferBytes += chunk.byteLength;
      }
      counters.messagesPendingTransmux++;
      let result;
      try {
        result = await client.send({ type: 'TRANSMUX_CHUNK', decryptedChunk: chunk, chunkIndex,
          isLastChunk: chunkIndex === chunkCount - 1 }, [chunk], 'CHUNK_TRANSMUXED');
      } finally { counters.messagesPendingTransmux--; }
      await appendWorkerOutput(mse, result, counters, false);
      plainOffset += plainBytes;
    }
    if (plainOffset !== fixture.bytes || (mode === 'crypto-transmux-mse' && cipherOffset !== sourceBytes.byteLength)) {
      throw new Error('FIXTURE_CHUNKING_INCOMPLETE');
    }
    const playbackAbort = new AbortController();
    const progress = waitForPlayback(video, 1.5, playbackAbort.signal);
    try { await video.play(); await progress; }
    catch (error) { playbackAbort.abort(); await progress.catch(() => {}); throw error; }
    if (video.error || video.readyState < 2 || video.currentTime <= 1.5) throw new Error('PLAYBACK_ASSERTION_FAILED');
  } finally {
    sourceBytes = null;
    if (ownedSourceBytes) { counters.liveKnownArrayBufferBytes -= ownedSourceBytes; ownedSourceBytes = 0; }
    if (client) client.close();
    if (transmuxHandle) {
      transmuxHandle.worker.terminate(); counters.transmuxWorkersTerminated++;
      transmuxHandle.revoke(); transmuxHandle = null;
    }
    if (cryptoHandle) {
      cryptoHandle.worker.terminate(); counters.cryptoWorkersTerminated++;
      cryptoHandle.revoke(); cryptoHandle = null;
    }
    if (material) { material.fdk.fill(0); material.baseNonce.fill(0); material = null; }
    await mse.cleanup();
  }
}

export async function prepareFixtureCorpus(directory, { bitrateKbps = 1200, tailMoov = false } = {}) {
  const manifest = [];
  for (const fixture of FIXTURE_CASES) {
    const path = `${directory}/video-${fixture.id}.mp4`;
    await generateVideo(path, fixture.audio, tailMoov ? null : '+faststart', fixture.seconds, bitrateKbps);
    const bytes = readFileSync(path);
    const scan = scanMp4ResourceMetadata(new Uint8Array(bytes));
    const moov = scan.topLevel.find(box => box.type === 'moov');
    const lastChunkStart = Math.floor((bytes.byteLength - 1) / KASUMI_CHUNK_SIZE) * KASUMI_CHUNK_SIZE;
    if (scan.status !== 'characterized' || scan.mode !== 'classic' || !moov ||
        (tailMoov ? moov.offset < lastChunkStart || moov.offset + moov.size > bytes.byteLength
          : moov.offset + moov.size > KASUMI_CHUNK_SIZE)) {
      throw new Error('FIXTURE_NOT_VALID_FASTSTART_MP4');
    }
    let info = null, parserError = null;
    const file = (await import('mp4box')).createFile();
    file.onReady = value => { info = value; };
    file.onError = error => { parserError = error; };
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    input.fileStart = 0; file.appendBuffer(input); file.flush();
    if (parserError || !info?.tracks?.length) throw new Error('FIXTURE_MP4BOX_METADATA_FAILED');
    const codec = `video/mp4; codecs="${info.tracks.map(track => track.codec).join(', ')}"`;
    manifest.push({ id: fixture.id, name: fixture.name, path: `video-${fixture.id}.mp4`, bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), container: 'classic-mp4', layout: tailMoov ? 'tail-moov' : 'faststart',
      ...(bitrateKbps === 1200 && !tailMoov ? {} : { durationSeconds: fixture.seconds, bitrateKbps,
        width: bitrateKbps === 1200 ? 320 : 640, height: bitrateKbps === 1200 ? 180 : 360, supplementalCohort: true }),
      moovOffset: moov.offset, moovBytes: moov.size, codec, tracks: info.tracks.map(track => ({ type: track.type, codec: track.codec })),
      chunkBytes: KASUMI_CHUNK_SIZE, chunkCount: Math.ceil(bytes.byteLength / KASUMI_CHUNK_SIZE),
      ffmpegVersion: process.env.AP06_R5_FFMPEG_VERSION,
      generationCommand: ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        `testsrc2=size=${bitrateKbps === 1200 ? '320x180' : '640x360'}:rate=24:duration=${fixture.seconds}`,
        ...(fixture.audio ? ['-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${fixture.seconds}`] : []),
        '-map', '0:v:0', ...(fixture.audio ? ['-map', '1:a:0'] : []), '-c:v', 'libx264', '-preset', 'ultrafast',
        '-threads', '2', '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`, '-g', '24', '-pix_fmt', 'yuv420p',
        ...(fixture.audio ? ['-c:a', 'aac', '-b:a', '96k'] : []), ...(tailMoov ? [] : ['-movflags', '+faststart']), `<fixture>/video-${fixture.id}.mp4`] });
    if (bytes.byteLength <= KASUMI_CHUNK_SIZE || manifest.at(-1).chunkCount < 2) throw new Error('FIXTURE_TOO_SMALL_FOR_TRANSMUX_CHUNK');
  }
  return manifest;
}

export function ownershipSnapshot(counters) {
  return {
    liveKnownArrayBufferBytes: counters.liveKnownArrayBufferBytes,
    knownTransmuxInputBytes: counters.knownTransmuxInputBytes,
    knownTransmuxOutputBytes: counters.knownTransmuxOutputBytes,
    pendingTransmuxMessages: counters.pendingTransmuxMessages,
    transmuxWorkersLive: counters.transmuxWorkersCreated - counters.transmuxWorkersTerminated,
    workerUrlsLive: counters.workerUrlsCreated - counters.workerUrlsRevoked,
    sourceBuffersLive: counters.sourceBuffersCreated - counters.sourceBuffersReleased,
    mediaSourcesLive: counters.mediaSourceCreated - counters.mediaSourceClosed,
    objectUrlsLive: counters.objectUrlsCreated - counters.objectUrlsRevoked,
    pendingAppends: counters.pendingAppends,
    pendingFetches: counters.pendingFetches,
    ...(counters.cryptoWorkersCreated === undefined ? {} : {
      cryptoWorkersLive: counters.cryptoWorkersCreated - counters.cryptoWorkersTerminated,
      cryptoWorkerUrlsLive: counters.cryptoWorkerUrlsCreated - counters.cryptoWorkerUrlsRevoked,
      pendingDecrypts: counters.pendingDecrypts,
      messagesPendingCrypto: counters.messagesPendingCrypto,
      messagesPendingTransmux: counters.messagesPendingTransmux,
    }),
  };
}

export async function captureNaturalIdle(page,capture,milliseconds) {
  if(![30000,120000].includes(milliseconds))throw new Error('INVALID_CHECKPOINT_TIMING');
  await capture('post-teardown-settled',6);
  await page.waitForTimeout(30000);await capture('idle-30s',6);
  if(milliseconds===120000){await page.waitForTimeout(90000);await capture('idle-120s',6);}
}

import {launchAttestedBrowser,finishBrowserIdentity,closeBrowserIdentity} from './ap06-browser-identity.mjs';

export async function runTransmuxProbe({ pageScript = transmuxPageScript(), countersFactory = newTransmuxCounters,
  cleanupValidator = validateCleanupOwnership, functionalValidator = validateTransmuxOwnership, snapshot = ownershipSnapshot,
  launchOptions = {}, configurePage = null, initializePage = null, identity = {}, beforeRun = null, afterRun = null,
  auxiliaryMetrics = null, repetitions = null, runLabel = null, idleAfterTeardownMs = 0, naturalCloseDelayMs = 1000 } = {}) {
  if (![0,30000,120000].includes(idleAfterTeardownMs) || ![0,1000].includes(naturalCloseDelayMs)) throw new Error('INVALID_CHECKPOINT_TIMING');
  const expectedChromiumVersion = validateExpectedChromiumVersion(process.env.AP06_R5_CHROMIUM_VERSION);
  const { AP06_R5_MODE: mode, AP06_R5_STAGE: stage, AP06_R5_ARTIFACT_DIR: artifactDir,
    AP06_R5_MEDIA_ORIGIN: origin, AP06_R5_FIXTURE_MANIFEST: manifestPath,
    AP06_R5_TRANSMUX_WORKER: transmuxWorkerPath, AP06_R5_CRYPTO_WORKER: cryptoWorkerPath } = process.env;
  if (!['transmux-mse', 'crypto-transmux-mse'].includes(mode) || !['triage', 'formal'].includes(stage) ||
      !artifactDir || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !manifestPath || !transmuxWorkerPath) {
    throw new Error('OWNED_AP06_R5_RUNNER_REQUIRED');
  }
  const fixtures = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  const transmuxSource = readFileSync(transmuxWorkerPath, 'utf8');
  const transpHash = createHash('sha256').update(transmuxSource).digest('hex');
  if (transpHash !== process.env.AP06_R5_TRANSMUX_WORKER_SHA256) throw new Error('TRANSMUX_WORKER_BUNDLE_HASH_MISMATCH');
  const cryptoSource = mode === 'crypto-transmux-mse' ? readFileSync(cryptoWorkerPath, 'utf8') : null;
  const cryptoWorkerHash = cryptoSource ? createHash('sha256').update(cryptoSource).digest('hex') : null;
  if (cryptoSource && cryptoWorkerHash !== process.env.AP06_R5_CRYPTO_WORKER_SHA256) {
    throw new Error('CRYPTO_WORKER_BUNDLE_HASH_MISMATCH');
  }
  const raw = { mode, stage, expectedChromiumVersion, playwrightRoutingInstalled: false, fetchInterceptionInstalled: false,
    ...(process.env.AP06_R6_CONDITION ? { condition: process.env.AP06_R6_CONDITION } : {}),
    videoStreamServiceUsed: false, angularOrBackendUsed: false,
    browserLaunches: 0, launchAttempts: 0, retries: 0, processSampleCalls: 0,
    orchestratorHash: process.env.AP06_R5_RUNNER_SHA256,
    fixtureManifestSha256: manifestHash, fixtureIdentities: fixtures.map(({ id, name, bytes, sha256 }) => ({ id, name, bytes, sha256 })),
    workerBundleSha256: transpHash, cryptoWorkerBundleSha256: cryptoWorkerHash, runs: [], ...identity };
  const output = `${artifactDir}/${mode}.raw.json`;
  const flush = () => writeJsonAtomic(output, raw);
  flush();
  const count = repetitions ?? (stage === 'triage' ? 1 : 3);
  if (![1,3].includes(count) || runLabel && count !== 1) throw new Error('INVALID_INDEPENDENT_RUN_COUNT');
  for (let repetition = 1; repetition <= count; repetition++) {
    if (beforeRun) await beforeRun(raw, output);
    const runId = runLabel ?? `${stage}-${process.env.AP06_R6_CONDITION || mode}-r${repetition}`;
    const run = { runId, mode, functionalStatus: 'FAIL', cleanupStatus: 'FAIL', browserVersion: null,
      playbackSessions: 0, extendedForPlateau: false, samples: [] };
    raw.runs.push(run); raw.launchAttempts++; flush();
    let browser = null, page = null, pageInitialized = false, closeObservation = null;
    try {
      browser = await launchAttestedBrowser(chromium,launchOptions,run,()=>{raw.browserLaunches++;flush();});
      run.browserVersion = browser.version();
      if (run.browserVersion !== expectedChromiumVersion) throw new Error('CHROMIUM_VERSION_MISMATCH');
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      page = await context.newPage();
      if (configurePage) closeObservation = await configurePage(page, context, raw);
      await page.addInitScript({ content: pageScript });
      await page.goto(origin);
      await page.evaluate(({ counters, transmux, crypto }) => {
        window.r5Counters = counters; window.r5TransmuxWorkerSource = transmux; window.r5CryptoWorkerSource = crypto;
      }, { counters: countersFactory(mode), transmux: transmuxSource, crypto: cryptoSource });
      if (initializePage) await initializePage(page, raw);
      pageInitialized = true;
      run.supportedCodecs = await page.evaluate(codecs => codecs.map(codec => ({ codec, supported: MediaSource.isTypeSupported(codec) })),
        [...new Set(fixtures.map(fixture => fixture.codec))]);
      if (run.supportedCodecs.some(codec => !codec.supported)) throw new Error('TRANSMUX_CODEC_UNSUPPORTED');
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      const browserCdp = await browser.newBrowserCDPSession();
      const capture = async (phase, cycle, gc = 'natural') => {
        if (gc === 'forced-diagnostic') await cdp.send('HeapProfiler.collectGarbage');
        const auxiliary = auxiliaryMetrics ? await auxiliaryMetrics(cdp,{phase,cycle,gc,browser,page}) : null;
        const sample = await collectRawMetrics(cdp, { runId, scenarioId: mode, fixtureId: 'ABC-classic-MP4-corpus',
          mode, cycle, fixture: 'ABC-classic-MP4-corpus', phase, gc, browserVersion: run.browserVersion,
          sourceHash: process.env.AP06_R5_SOURCE_HASH, fixtureHash: manifestHash, harnessHash: process.env.AP06_R5_HARNESS_HASH,
          orchestratorHash: process.env.AP06_R5_RUNNER_SHA256, workerBundleHash: transpHash,
          cryptoWorkerBundleHash: cryptoWorkerHash, functionalStatus: 'PENDING' }, async () => {
          raw.processSampleCalls++;
          return sampleOwnedProcesses(browserCdp);
        }, auxiliary);
        const state = await page.evaluate(() => ({ counters: { ...window.r5Counters }, mediaNodes: document.querySelectorAll('video,audio').length }));
        sample.counters = state.counters; sample.mediaNodes = state.mediaNodes;
        sample.ownership = snapshot(state.counters);
        cleanupValidator(state.counters, state.mediaNodes, mode);
        if (phase !== 'baseline' && gc !== 'forced-diagnostic') functionalValidator(state.counters, state.mediaNodes, mode);
        run.samples.push(sample); flush();
      };
      await page.waitForTimeout(1000); await capture('baseline', 0);
      for (let cycle = 1; cycle <= 6; cycle++) {
        for (const fixture of fixtures) {
          await page.evaluate(({ fixture, mode }) => window.r5RunFixture(fixture, mode), { fixture, mode });
          run.playbackSessions++;
        }
        if (naturalCloseDelayMs) await page.waitForTimeout(naturalCloseDelayMs);
        await capture(`cycle-${cycle}-close`, cycle);
      }
      if (idleAfterTeardownMs) {
        await captureNaturalIdle(page,capture,idleAfterTeardownMs);
      }
      await capture('forced-GC-final', 6, 'forced-diagnostic');
      run.functionalStatus = 'PASS'; run.cleanupStatus = 'PASS';
    } catch (error) {
      run.failureClass = error?.message?.match(/^[A-Z0-9_]+$/) ? error.message : error?.name || 'UNKNOWN_ERROR';
      run.failureStage ??= run.browserIdentity?.failureStage;
      process.exitCode = 1;
    } finally {
      let cleanupOk = true;
      try {
        if (page && pageInitialized) {
          const state = await page.evaluate(() => ({ counters: { ...window.r5Counters }, mediaNodes: document.querySelectorAll('video,audio').length }));
          cleanupValidator(state.counters, state.mediaNodes, mode);
        }
      } catch { cleanupOk = false; }
      if (closeObservation) {
        try { await closeObservation(); } catch { cleanupOk = false; }
      }
      if (browser) {
        try {
          try { await finishBrowserIdentity(browser); }
          finally { try { await browser.close(); } finally { await closeBrowserIdentity(browser); } }
          if (process.env.AP06_R8_PID_AUDITOR && run.samples.length) {
            const pids = [...new Set(run.samples.flatMap(sample => sample.processMemory.processes.map(row => row.pid)))];
            const { stdout } = await exec(process.env.WAVE1_PYTHON,
              [process.env.AP06_R8_PID_AUDITOR, '--closed-pids', pids.join(',')], { windowsHide: true });
            run.processExitAudit = JSON.parse(stdout);
            if (run.processExitAudit.status !== 'PASS') cleanupOk = false;
          }
        }
        catch { cleanupOk = false; }
      } else if (run.browserIdentity?.browserLaunchSucceeded) {
        run.processExitAudit=run.browserIdentity.failureCleanupAudit;
        cleanupOk=run.browserIdentity.browserClosed===true&&run.browserIdentity.cleanupStatus==='PASS';
      }
      run.cleanupStatus = cleanupOk ? 'PASS' : 'FAIL';
      for (const sample of run.samples) {
        sample.functionalStatus = run.functionalStatus;
        sample.cleanupStatus = run.cleanupStatus;
      }
      flush();
      if (afterRun) await afterRun(raw, output);
    }
    if (run.functionalStatus !== 'PASS' || run.cleanupStatus !== 'PASS') break;
  }
  if (raw.runs.every(run => run.functionalStatus === 'PASS' && run.cleanupStatus === 'PASS')) {
    raw.summary = summarizeMseRuns(raw);
    flush();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--preflight') {
    console.log(JSON.stringify(await chromiumPreflightResult(process.env.AP06_R5_CHROMIUM_VERSION,
      () => chromium.executablePath())));
  } else if (process.argv[2] === '--prepare') {
    const { mkdir } = await import('node:fs/promises');
    const directory = process.env.AP06_R5_FIXTURE_DIR;
    if (!directory) throw new Error('OWNED_AP06_R5_FIXTURE_PREPARATION_REQUIRED');
    await mkdir(directory, { recursive: true });
    const manifest = await prepareFixtureCorpus(directory);
    writeJsonAtomic(process.env.AP06_R5_FIXTURE_MANIFEST, manifest);
  } else await runTransmuxProbe();
}
