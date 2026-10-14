import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectRawMetrics, groupProcessMetrics, calculateSignedDelta, summarizeRuns, writeJsonAtomic } from './browser-memory-probe.mjs';
import { summarize } from './mp4-resource-calibration-lib.mjs';

export function newOwnership() {
  return { mediaSourceCreated: 0, mediaSourceClosed: 0, objectUrlsCreated: 0, objectUrlsRevoked: 0,
    sourceBuffersCreated: 0, sourceBuffersReleased: 0, fetchesStarted: 0, fetchesCompleted: 0,
    fetchesAborted: 0, bytesFetched: 0, bytesAppended: 0, appendOperationsStarted: 0,
    appendOperationsCompleted: 0, liveKnownArrayBufferBytes: 0, pendingFetches: 0, pendingAppends: 0 };
}

// Self-contained so the same runtime logic is exercised by unit tests and the plain page.
// Counters describe logical ownership, never native allocator memory.
export function createMseSession(video, mediaSource, objectUrl, counters, revokeUrl) {
  let phase = 'CREATED', sourceBuffer = null, activeAppend = null, closing = null;
  const cancellation = new AbortController();
  counters.mediaSourceCreated++; counters.objectUrlsCreated++;
  function wait(target, events, ready, action, signal = cancellation.signal) {
    if (!action && ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(deadline);
        for (const name of events) target.removeEventListener(name, check);
        target.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const check = () => { if (ready()) finish(); };
      const failed = () => finish(new Error('MEDIA_OR_SOURCEBUFFER_ERROR'));
      const aborted = () => finish(new Error('MSE_OPERATION_CANCELLED'));
      const deadline = setTimeout(() => finish(new Error('MSE_EVENT_DEADLINE')), 15000);
      for (const name of events) target.addEventListener(name, check);
      target.addEventListener('error', failed); signal?.addEventListener('abort', aborted);
      if (signal?.aborted) { aborted(); return; }
      try { action?.(); } catch (error) { finish(error); }
    });
  }
  async function open(codec) {
    if (phase !== 'CREATED') throw new Error('MSE_INVALID_OPEN_PHASE');
    await wait(mediaSource, ['sourceopen'], () => mediaSource.readyState === 'open', () => { video.src = objectUrl; });
    phase = 'SOURCE_OPEN'; sourceBuffer = mediaSource.addSourceBuffer(codec); counters.sourceBuffersCreated++;
  }
  async function append(bytes) {
    if (phase !== 'SOURCE_OPEN' || activeAppend) throw new Error('MSE_INVALID_APPEND_PHASE');
    const size = bytes.byteLength;
    phase = 'APPENDING'; counters.pendingAppends++; counters.appendOperationsStarted++;
    counters.liveKnownArrayBufferBytes += size;
    activeAppend = (async () => {
      try {
        await wait(sourceBuffer, ['updateend'], () => !sourceBuffer.updating);
        await wait(sourceBuffer, ['updateend'], () => !sourceBuffer.updating, () => sourceBuffer.appendBuffer(bytes));
        counters.appendOperationsCompleted++; counters.bytesAppended += size;
      } finally {
        bytes = null; counters.liveKnownArrayBufferBytes -= size; counters.pendingAppends--;
      }
    })();
    try { await activeAppend; } finally {
      activeAppend = null;
      if (phase === 'APPENDING') phase = 'SOURCE_OPEN';
    }
  }
  function cleanup() {
    if (closing) return closing;
    closing = (async () => {
      phase = 'CLEANING'; video.pause();
      const pending = activeAppend;
      cancellation.abort();
      try {
        if (pending) await pending.catch(() => {}); // Settle the explicitly cancelled append before releasing references.
        if (sourceBuffer && !pending) await wait(sourceBuffer, ['updateend'], () => !sourceBuffer.updating, null, null);
        // Only a successfully completed full-fixture append authorizes endOfStream.
        if (mediaSource.readyState === 'open' && sourceBuffer && !sourceBuffer.updating &&
            counters.appendOperationsCompleted === counters.appendOperationsStarted) mediaSource.endOfStream();
      } finally {
        const closed = wait(mediaSource, ['sourceclose'], () => mediaSource.readyState === 'closed', null, null);
        video.removeAttribute('src'); video.load();
        revokeUrl(objectUrl); counters.objectUrlsRevoked++; video.remove();
        if (sourceBuffer) { sourceBuffer = null; counters.sourceBuffersReleased++; }
        await closed; counters.mediaSourceClosed++; mediaSource = null; video = null; objectUrl = null; phase = 'CLOSED';
      }
    })();
    return closing;
  }
  async function play(bytes, codec) {
    const size = bytes.byteLength; let handedToAppend = false;
    counters.liveKnownArrayBufferBytes += size;
    try {
      await open(codec);
      counters.liveKnownArrayBufferBytes -= size; handedToAppend = true;
      await append(bytes); bytes = null;
      phase = 'PLAYING';
      const progress = wait(video, ['loadedmetadata', 'canplay', 'timeupdate'],
        () => !video.error && video.readyState >= 2 && video.currentTime >= 1.5);
      try { await video.play(); await progress; } catch (error) { cancellation.abort(); await progress.catch(() => {}); throw error; }
      if (video.error) throw new Error('MEDIA_ERROR');
    } finally { if (!handedToAppend) counters.liveKnownArrayBufferBytes -= size; bytes = null; await cleanup(); }
  }
  return { open, append, play, cleanup, get phase() { return phase; } };
}

export function validateOwnership(counters, mediaNodes) {
  for (const key of ['liveKnownArrayBufferBytes', 'pendingFetches', 'pendingAppends']) {
    if (counters[key] !== 0) throw new Error('MSE_LIVE_OWNERSHIP_RETAINED');
  }
  for (const [created, released] of [['mediaSourceCreated', 'mediaSourceClosed'], ['objectUrlsCreated', 'objectUrlsRevoked'],
    ['sourceBuffersCreated', 'sourceBuffersReleased'], ['fetchesStarted', 'fetchesCompleted'], ['appendOperationsStarted', 'appendOperationsCompleted']]) {
    if (counters[created] !== counters[released]) throw new Error('MSE_LIFECYCLE_UNBALANCED');
  }
  if (mediaNodes !== 0 || counters.fetchesAborted !== 0 || counters.bytesFetched !== counters.bytesAppended) throw new Error('MSE_FUNCTIONAL_INCOMPLETE');
}

export function disposableCryptoMaterial(id) {
  return { fdk: Uint8Array.from({ length: 32 }, (_, i) => (i + 1 + id * 37) % 256),
    baseNonce: Uint8Array.from({ length: 24 }, (_, i) => (i + 100 + id * 19) % 256) };
}

// Shared with R5 so decrypted chunks can be transferred directly to the next worker.
export async function decryptWorkerChunk(worker, encryptedChunk, chunkIndex, outputBytes, counters, material) {
  const inputBytes = encryptedChunk.byteLength;
  const fdkCopy = material.fdk.slice(), nonceCopy = material.baseNonce.slice();
  let handedOff = false;
  counters.liveKnownArrayBufferBytes += inputBytes;
  counters.messagesPending++; counters.decryptOperationsPending++;
  try {
    const decrypted = await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(deadline);
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', failure);
      };
      const failure = () => { cleanup(); reject(new Error('CRYPTO_WORKER_FAILED')); };
      const message = event => {
        if (event.data.chunkIndex !== chunkIndex) { failure(); return; }
        cleanup();
        event.data.type === 'CHUNK_DECRYPTED'
          ? resolve(event.data.decryptedChunk)
          : reject(new Error('CRYPTO_DECRYPT_FAILED'));
      };
      const deadline = setTimeout(failure, 15000);
      worker.addEventListener('message', message);
      worker.addEventListener('error', failure);
      try {
        worker.postMessage({ type: 'DECRYPT_CHUNK', encryptedChunk, fdk: fdkCopy.buffer,
          baseNonce: nonceCopy.buffer, chunkIndex }, [encryptedChunk, fdkCopy.buffer, nonceCopy.buffer]);
        handedOff = encryptedChunk.byteLength === 0 && fdkCopy.byteLength === 0 && nonceCopy.byteLength === 0;
        if (!handedOff) throw new Error('CRYPTO_TRANSFER_NOT_DETACHED');
        counters.encryptedChunksSent++; counters.encryptedBytesSent += inputBytes; counters.detachedTransfersObserved++;
      } catch { cleanup(); reject(new Error('CRYPTO_HANDOFF_FAILED')); }
    });
    if (!(decrypted instanceof ArrayBuffer) || decrypted.byteLength !== outputBytes) throw new Error('CRYPTO_CHUNK_SIZE_INVALID');
    counters.decryptedChunksReceived++; counters.decryptedBytesReceived += outputBytes;
    counters.liveKnownArrayBufferBytes += outputBytes;
    return decrypted;
  } finally {
    if (!handedOff) { fdkCopy.fill(0); nonceCopy.fill(0); }
    counters.liveKnownArrayBufferBytes -= inputBytes;
    counters.messagesPending--; counters.decryptOperationsPending--;
  }
}

// Sequential use of the actual worker protocol. No decryption implementation lives in the harness.
export async function decryptFixture(worker, encrypted, fixture, counters, material) {
  const inputSize = encrypted.byteLength, outputSize = fixture.bytes;
  let output = new ArrayBuffer(outputSize), outputHandedOff = false;
  counters.liveKnownArrayBufferBytes += inputSize + outputSize;
  try {
    let cipherOffset = 0, plainOffset = 0;
    for (let index = 0; index < fixture.chunkCount; index++) {
      const size = Math.min(fixture.chunkBytes, outputSize - plainOffset);
      const chunk = encrypted.slice(cipherOffset, cipherOffset + size + 16);
      let handedOff = false;
      let decrypted;
      try {
        decrypted = await decryptWorkerChunk(worker, chunk, index, size, counters, material);
        handedOff = true;
        try { new Uint8Array(output).set(new Uint8Array(decrypted), plainOffset); }
        finally { decrypted = null; counters.liveKnownArrayBufferBytes -= size; }
      } finally {
        if (!handedOff && chunk.byteLength) new Uint8Array(chunk).fill(0);
      }
      cipherOffset += size + 16; plainOffset += size;
    }
    if (cipherOffset !== inputSize || plainOffset !== outputSize) throw new Error('CRYPTO_CORPUS_SIZE_INVALID');
    outputHandedOff = true; return output;
  } finally {
    encrypted = null; counters.liveKnownArrayBufferBytes -= inputSize + outputSize;
    if (!outputHandedOff) new Uint8Array(output).fill(0);
    output = null; material.fdk.fill(0); material.baseNonce.fill(0);
  }
}

async function prepareCryptoFixtures() {
  const { build } = await import('esbuild');
  if (existsSync(process.env.AP06_KASUMI_BUNDLE)) {
    if (createHash('sha256').update(readFileSync(process.env.AP06_KASUMI_BUNDLE)).digest('hex') !== process.env.AP06_KASUMI_BUNDLE_SHA256) {
      throw new Error('CRYPTO_GENERATOR_REUSE_HASH_MISMATCH');
    }
  } else await build({ stdin: { contents: "import '@angular/compiler'; export {KasumiCryptoService} from './src/app/core/crypto/kasumi-crypto.service'; export {KASUMI_CHUNK_SIZE} from './src/app/core/crypto/kasumi-format';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', outfile: process.env.AP06_KASUMI_BUNDLE, logLevel: 'error' });
  const { KasumiCryptoService, KASUMI_CHUNK_SIZE } = createRequire(import.meta.url)(process.env.AP06_KASUMI_BUNDLE);
  const kasumi = new KasumiCryptoService(), fixtures = JSON.parse(process.env.AP06_FIXTURES);
  for (const fixture of fixtures) {
    const material = disposableCryptoMaterial(fixture.id), parts = [];
    try {
      const plaintext = readFileSync(fixture.absolutePath); let header = true;
      for await (const part of kasumi.encryptFileParts(new File([plaintext], 'disposable.mp4'), material.fdk, material.baseNonce)) {
        if (header) { header = false; continue; } // Do not publish the Kasumi header's plaintext base nonce.
        parts.push(Buffer.from(await part.arrayBuffer()));
      }
      writeFileSync(fixture.ciphertextAbsolutePath, Buffer.concat(parts), { flag: 'wx' });
      fixture.chunkBytes = KASUMI_CHUNK_SIZE; fixture.chunkCount = parts.length;
    } finally { material.fdk.fill(0); material.baseNonce.fill(0); }
  }
  writeJsonAtomic(process.env.AP06_CRYPTO_PREP_METADATA, fixtures.map(({ id, chunkBytes, chunkCount }) => ({ id, chunkBytes, chunkCount })));
}

export function summarizeMseRuns(raw) {
  const summary = summarizeRuns({ samples: raw.runs.flatMap(run => run.samples),
    functionalStatus: raw.runs.every(run => run.functionalStatus === 'PASS') ? 'PASS' : 'FAIL',
    cleanupStatus: raw.runs.every(run => run.cleanupStatus === 'PASS') ? 'PASS' : 'FAIL' });
  const baselines = new Map(raw.runs.map(run => [run.runId, run.samples.find(sample => sample.phase === 'baseline')]));
  for (const phase of summary.phases) {
    const rows = raw.runs.flatMap(run => run.samples.filter(sample => sample.phase === phase.phase && sample.gc === phase.gc));
    phase.processTypes = Object.fromEntries(['browser', 'renderer', 'gpu-process', 'utility', 'other'].map(type => [type,
      rows.every(row => row.processMemory.status === 'AVAILABLE' && row.processMemory.byCategory[type] &&
        baselines.get(row.runId).processMemory.byCategory?.[type])
        ? Object.fromEntries(['privateBytes', 'workingSetBytes'].map(metric => [metric, {
          signedDelta: summarize(rows.map(row => calculateSignedDelta(row.processMemory.byCategory[type][metric],
            baselines.get(row.runId).processMemory.byCategory[type][metric]))),
        }])) : { status: 'NOT_AVAILABLE' }]));
  }
  return summary;
}

async function main() {
  if (process.env.AP06_PREPARE_CRYPTO === '1') { await prepareCryptoFixtures(); return; }
  const { AP06_STAGE: stage, AP06_ARTIFACT_ROOT: artifact, AP06_MEDIA_ORIGIN: origin } = process.env;
  const mode = process.env.AP06_MODE, prefix = process.env.AP06_ARTIFACT_PREFIX ?? '';
  if (!['plain-mse', 'crypto-mse'].includes(mode) || !['triage', 'formal'].includes(stage) || !artifact ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !['', 'crypto-'].includes(prefix)) throw new Error('OWNED_MSE_RUNNER_REQUIRED');
  const fixtures = JSON.parse(process.env.AP06_FIXTURES), exec = promisify(execFile);
  const raw = { mode, stage, browserLaunches: 0, launchAttempts: 0, retries: 0, processSampleCalls: 0, runs: [] };
  const flush = () => writeJsonAtomic(join(artifact, `${prefix}raw.json`), raw);
  flush();
  for (let repetition = 1; repetition <= (stage === 'triage' ? 1 : 3); repetition++) {
    const run = { runId: `${stage}-${mode}-r${repetition}`, mode, functionalStatus: 'FAIL', cleanupStatus: 'FAIL',
      playwrightRoutingInstalled: false, fetchInterceptionInstalled: false, angularOrBackendUsed: false,
      extendedForPlateau: false, samples: [], supportedCodecs: [] };
    raw.runs.push(run); raw.launchAttempts++; flush();
    let browser;
    try {
      browser = await chromium.launch(); raw.browserLaunches++; flush();
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.addInitScript({ content: `window.createMseSession = ${createMseSession.toString()};` });
      if (mode === 'crypto-mse') await page.addInitScript({ content: `window.decryptFixture = ${decryptFixture.toString()}; window.disposableCryptoMaterial = ${disposableCryptoMaterial.toString()};` });
      await page.goto(origin);
      const ownership = newOwnership();
      if (mode === 'crypto-mse') Object.assign(ownership, { workerCreates: 0, workerTerminates: 0, workerUrlsCreated: 0, workerUrlsRevoked: 0,
        encryptedChunksSent: 0, encryptedBytesSent: 0, decryptedChunksReceived: 0, decryptedBytesReceived: 0,
        detachedTransfersObserved: 0, messagesPending: 0, decryptOperationsPending: 0 });
      await page.evaluate(counters => { window.mseOwnership = counters; }, ownership);
      if (mode === 'crypto-mse') await page.evaluate(source => { window.cryptoWorkerSource = source; }, readFileSync(process.env.AP06_CRYPTO_WORKER, 'utf8'));
      run.supportedCodecs = await page.evaluate(fixtures => fixtures.map(fixture => ({ id: fixture.id, codec: fixture.codec,
        supported: MediaSource.isTypeSupported(fixture.codec) })), fixtures);
      if (run.supportedCodecs.some(codec => !codec.supported)) throw new Error('MSE_FIXTURE_CODEC_UNSUPPORTED');
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      const browserCdp = await browser.newBrowserCDPSession();
      const capture = async (phase, cycle, gc = 'natural') => {
        if (gc === 'forced-diagnostic') await cdp.send('HeapProfiler.collectGarbage');
        const sample = await collectRawMetrics(cdp, { runId: run.runId, scenarioId: mode, fixtureId: 'ABC-fMP4-corpus',
          mode, cycle, fixture: 'ABC-fMP4-corpus', phase, gc, browserVersion: browser.version(),
          sourceHash: process.env.AP06_PLAYER_SOURCE_HASH, fixtureHash: process.env.AP06_FIXTURE_HASH,
          harnessHash: process.env.AP06_HARNESS_HASH, functionalStatus: 'PENDING' }, async () => {
          const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo'); raw.processSampleCalls++;
          const { stdout } = await exec(process.env.WAVE1_PYTHON, [process.env.WAVE1_RUNNER, '--process-sample',
            processInfo.map(process => process.id).join(',')], { windowsHide: true });
          return groupProcessMetrics(JSON.parse(stdout), processInfo);
        });
        const lifecycle = await page.evaluate(() => ({ counters: { ...window.mseOwnership }, mediaNodes: document.querySelectorAll('video,audio').length }));
        sample.counters = lifecycle.counters; sample.mediaNodes = lifecycle.mediaNodes;
        sample.ownership = { liveKnownArrayBufferBytes: sample.counters.liveKnownArrayBufferBytes,
          pendingFetches: sample.counters.pendingFetches, pendingAppends: sample.counters.pendingAppends,
          objectUrlsLive: sample.counters.objectUrlsCreated - sample.counters.objectUrlsRevoked,
          sourceBuffersLive: sample.counters.sourceBuffersCreated - sample.counters.sourceBuffersReleased,
          mediaSourcesLive: sample.counters.mediaSourceCreated - sample.counters.mediaSourceClosed };
        if (mode === 'crypto-mse') Object.assign(sample.ownership, { workersLive: sample.counters.workerCreates - sample.counters.workerTerminates,
          workerUrlsLive: sample.counters.workerUrlsCreated - sample.counters.workerUrlsRevoked,
          pendingDecrypts: sample.counters.decryptOperationsPending, messagesPending: sample.counters.messagesPending });
        run.samples.push(sample); flush();
        validateOwnership({ ...sample.counters, bytesFetched: mode === 'crypto-mse' ? sample.counters.decryptedBytesReceived : sample.counters.bytesFetched }, sample.mediaNodes);
        if (mode === 'crypto-mse' && (Object.values(sample.ownership).some(value => value !== 0) ||
          sample.counters.encryptedChunksSent !== sample.counters.decryptedChunksReceived ||
          sample.counters.encryptedChunksSent !== sample.counters.detachedTransfersObserved)) throw new Error('CRYPTO_OWNERSHIP_UNBALANCED');
      };
      // One second of declared measurement settling, never a functional assertion.
      await page.waitForTimeout(1000); await capture('baseline', 0);
      for (let cycle = 1; cycle <= 6; cycle++) {
        for (const fixture of fixtures) await page.evaluate(async ({ fixture, mode }) => {
          const counters = window.mseOwnership;
          const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; document.body.appendChild(video);
          const mediaSource = new MediaSource(), objectUrl = URL.createObjectURL(mediaSource);
          const session = window.createMseSession(video, mediaSource, objectUrl, counters, url => URL.revokeObjectURL(url));
          const abort = new AbortController(); let bytes = null, worker = null, workerUrl = null;
          try {
            counters.fetchesStarted++; counters.pendingFetches++;
            try {
              const response = await fetch(`/video-${fixture.id}.mp4`, { signal: abort.signal });
              if (!response.ok) throw new Error('FIXTURE_HTTP_FAILED');
              bytes = await response.arrayBuffer(); counters.bytesFetched += bytes.byteLength; counters.fetchesCompleted++;
            } catch (error) { abort.abort(); counters.fetchesAborted++; throw error; }
            finally { counters.pendingFetches--; }
            if (mode === 'crypto-mse') {
              workerUrl = URL.createObjectURL(new Blob([window.cryptoWorkerSource], { type: 'text/javascript' })); counters.workerUrlsCreated++;
              worker = new Worker(workerUrl, { type: 'module' }); counters.workerCreates++;
              worker.postMessage({ type: 'INIT', logsEnabled: false });
              const decryption = window.decryptFixture(worker, bytes, fixture, counters, window.disposableCryptoMaterial(fixture.id));
              bytes = null; bytes = await decryption;
            }
            const playback = session.play(bytes, fixture.codec); bytes = null; await playback;
          } finally {
            bytes = null;
            if (worker) { worker.terminate(); counters.workerTerminates++; worker = null; }
            if (workerUrl) { URL.revokeObjectURL(workerUrl); counters.workerUrlsRevoked++; workerUrl = null; }
            await session.cleanup();
          }
        }, { fixture, mode });
        await page.waitForTimeout(1000); await capture(`cycle-${cycle}-close`, cycle);
      }
      await capture('forced-GC-final', 6, 'forced-diagnostic'); run.functionalStatus = 'PASS';
    } catch (error) { run.failureClass = error.message?.match(/^[A-Z_]+$/) ? error.message : error.name; process.exitCode = 1; }
    finally {
      try { if (browser) { await browser.close(); run.cleanupStatus = 'PASS'; } }
      finally { for (const sample of run.samples) sample.functionalStatus = run.functionalStatus; flush(); }
    }
    if (run.functionalStatus !== 'PASS' || run.cleanupStatus !== 'PASS') break;
  }
  if (raw.runs.every(run => run.functionalStatus === 'PASS' && run.cleanupStatus === 'PASS')) writeJsonAtomic(join(artifact, `${prefix}summary.json`), summarizeMseRuns(raw));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
