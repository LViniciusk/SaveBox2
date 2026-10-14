import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createTransmuxWorkerClient, newTransmuxCounters, appendWorkerOutput, validateCleanupOwnership,
  validateTransmuxOwnership, classifyTransmux, validateExpectedChromiumVersion, parseChromiumVersion,
  chromiumIdentityPreflight, chromiumPreflightResult, readChromiumBinaryVersion,
  classifyPreflightExecutionError, transmuxPageScript } from './ap06-transmux-probe.mjs';

test('Chromium authority requires an exact four-component version', () => {
  assert.equal(validateExpectedChromiumVersion('151.0.7922.34'), '151.0.7922.34');
  for (const value of [undefined, '', '151', '151.0.7922', '151.0.7922.34-beta']) {
    assert.throws(() => validateExpectedChromiumVersion(value), /AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID/);
  }
});

test('Chromium preflight parses exact version text and never launches a browser', async () => {
  assert.equal(parseChromiumVersion('Chromium 151.0.7922.34'), '151.0.7922.34');
  assert.equal(parseChromiumVersion('Google Chrome for Testing 151.0.7922.34'), '151.0.7922.34');
  assert.throws(() => parseChromiumVersion('Chromium version unavailable'), /CHROMIUM_VERSION_PREFLIGHT_INVALID/);
  const calls = [];
  const result = await chromiumIdentityPreflight('151.0.7922.34', () => {
    calls.push('executablePath'); return 'owned-chromium.exe';
  }, { platform: 'linux', execute: async (...args) => {
    calls.push(args); return { stdout: 'Chromium 151.0.7922.34', stderr: '' };
  } });
  assert.deepEqual(calls, ['executablePath', ['owned-chromium.exe', ['--version'], {
    windowsHide: true, timeout: 5000, maxBuffer: 65536,
  }]]);
  assert.deepEqual({ ...result, executablePath: undefined }, {
    status: 'PASS', expectedVersion: '151.0.7922.34', observedVersion: '151.0.7922.34',
    authority: 'playwright-chromium-executable', method: 'binary--version', executablePath: undefined,
  });
});

test('Chromium preflight rejects executable mismatch and unavailable executable', async () => {
  const execute = async () => ({ stdout: 'Chromium 151.0.7922.35', stderr: '' });
  await assert.rejects(chromiumIdentityPreflight('151.0.7922.34', () => 'chrome.exe', { platform: 'win32', execute }), /CHROMIUM_BINARY_VERSION_MISMATCH/);
  await assert.rejects(chromiumIdentityPreflight('151.0.7922.34', () => '', { execute }), /CHROMIUM_EXECUTABLE_UNAVAILABLE/);
  const result = await chromiumPreflightResult('151.0.7922.34', () => 'chrome.exe', { platform: 'win32', execute });
  assert.equal(result.failureClass, 'CHROMIUM_BINARY_VERSION_MISMATCH');
  assert.equal(result.expectedVersion, '151.0.7922.34');
  assert.equal(result.observedVersion, '151.0.7922.35');
  assert.equal(result.processInvoked, true);
});

test('Windows FileVersion uses one system PowerShell process and treats the Chromium path as data', async () => {
  const path = "C:\\Users\\Test User\\O'Brien\\App Data\\chrome.exe";
  const calls = [];
  const result = await chromiumIdentityPreflight('151.0.7922.34', () => path, {
    platform: 'win32', environment: { SystemRoot: 'C:\\Windows', TEST_VALUE: 'retained' },
    execute: async (...args) => { calls.push(args); return { stdout: '151.0.7922.34', stderr: '' }; },
  });
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:AP06_CHROMIUM_EXE).VersionInfo.FileVersion']);
  assert.equal(args.join(' ').includes(path), false);
  assert.equal(options.env.AP06_CHROMIUM_EXE, path);
  assert.equal(options.env.TEST_VALUE, 'retained');
  assert.equal(options.shell, undefined);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 5000);
  assert.equal(result.method, 'windows-file-version');
  assert.equal(result.observedVersion, result.expectedVersion);
});

test('portable preflight failures preserve expected identity and sanitized execution classification without retry', async () => {
  const failures = [
    [{ code: 'ENOENT' }, 'PROCESS_UNAVAILABLE'],
    [{ killed: true }, 'TIMEOUT'],
    [{ code: 'ETIMEDOUT' }, 'TIMEOUT'],
    [{ code: 1 }, 'NONZERO_EXIT'],
    [{ code: 'EACCES' }, 'EXECUTION_FAILED'],
  ];
  for (const [details, suffix] of failures) {
    let calls = 0;
    const error = Object.assign(new Error('sensitive stderr/path'), details, { stderr: 'secret' });
    assert.equal(classifyPreflightExecutionError(error), `CHROMIUM_VERSION_PREFLIGHT_${suffix}`);
    const result = await chromiumPreflightResult('151.0.7922.34', () => 'private-path.exe', {
      platform: 'win32', execute: async () => { calls++; throw error; },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.failureClass, `CHROMIUM_VERSION_PREFLIGHT_${suffix}`);
    assert.equal(result.expectedVersion, '151.0.7922.34');
    assert.equal(result.observedVersion, null);
    assert.equal(result.method, 'windows-file-version');
    assert.equal(result.processInvoked, true);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|private-path|secret/);
  }
  const malformed = await chromiumPreflightResult('151.0.7922.34', () => 'chrome.exe', {
    platform: 'win32', execute: async () => ({ stdout: 'FileVersion unavailable' }),
  });
  assert.equal(malformed.failureClass, 'CHROMIUM_VERSION_PREFLIGHT_INVALID');
  assert.equal(malformed.expectedVersion, '151.0.7922.34');
  assert.equal(malformed.processInvoked, true);
});

test('invalid authority or executable fails before any version subprocess', async () => {
  let calls = 0;
  const options = { execute: async () => { calls++; } };
  const invalid = await chromiumPreflightResult(undefined, () => 'chrome.exe', options);
  const unavailable = await chromiumPreflightResult('151.0.7922.34', () => '', options);
  assert.equal(calls, 0);
  assert.equal(invalid.expectedVersion, null);
  assert.equal(invalid.processInvoked, false);
  assert.equal(unavailable.expectedVersion, '151.0.7922.34');
  assert.equal(unavailable.processInvoked, false);
});

test('POSIX binary identity keeps --version and records its method', async () => {
  const calls = [];
  const result = await readChromiumBinaryVersion('/owned/chromium', { platform: 'darwin',
    execute: async (...args) => { calls.push(args); return { stdout: 'Chromium 151.0.7922.34' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/owned/chromium');
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal(calls[0][2].shell, undefined);
  assert.deepEqual(result, { version: '151.0.7922.34', method: 'binary--version' });
});

function worker(reply) {
  const value = new EventTarget();
  value.postMessage = (message, transfers) => {
    const received = structuredClone(message, { transfer: transfers });
    queueMicrotask(() => reply(value, received));
  };
  return value;
}

test('page init supplies the serialized fixture function with its actual worker, append and playback helpers', async () => {
  const video = new EventTarget(); Object.assign(video, { error: null, readyState: 2, currentTime: 2 });
  const counters = newTransmuxCounters();
  const page = { window: {}, setTimeout, clearTimeout, Blob,
    Worker: class extends EventTarget {},
    URL: { createObjectURL: () => 'blob:owned', revokeObjectURL: () => {} } };
  runInNewContext(transmuxPageScript(), page);
  const handle = page.workerBlob('actual-worker-source', counters, 'transmux');
  handle.revoke();
  assert.equal(counters.workerUrlsCreated, counters.workerUrlsRevoked);
  await page.waitForPlayback(video, 1.5, new AbortController().signal);
  const response = { segments: [{ buffer: new ArrayBuffer(3) }] };
  await page.appendWorkerOutput({ append: async () => {} }, response, counters, false);
  assert.equal(counters.segmentBytesAppended, 3);
  assert.equal(counters.knownTransmuxOutputBytes, 0);
  assert.equal(typeof page.window.r5RunFixture, 'function');
});

function complete(mode = 'transmux-mse') {
  const c = newTransmuxCounters(mode);
  Object.assign(c, {
    fetchesStarted: 1, fetchesCompleted: 1,
    mediaSourceCreated: 1, mediaSourceClosed: 1, objectUrlsCreated: 1, objectUrlsRevoked: 1,
    sourceBuffersCreated: 1, sourceBuffersReleased: 1,
    transmuxWorkersCreated: 1, transmuxWorkersTerminated: 1, workerUrlsCreated: 1, workerUrlsRevoked: 1,
    bootstrapMessagesSent: 1, bootstrapResponsesReceived: 1, bootstrapInputBuffersTransferred: 1, bootstrapInputBuffersDetached: 1,
    transmuxChunksSent: 1, transmuxResponsesReceived: 1, transmuxInputTransfersDetached: 1, detachedTransmuxInputs: 1,
    outputTransferBuffersReceived: 2, initSegmentsReceived: 1, initSegmentBytesReceived: 4,
    mediaSegmentsReceived: 1, mediaSegmentBytesReceived: 4, segmentBytesAppended: 8,
    appendOperationsStarted: 2, appendOperationsCompleted: 2,
  });
  if (mode === 'crypto-transmux-mse') Object.assign(c, {
    cryptoWorkersCreated: 1, cryptoWorkersTerminated: 1, cryptoWorkerUrlsCreated: 1, cryptoWorkerUrlsRevoked: 1,
    encryptedChunksSent: 2, decryptedChunksReceived: 2, detachedTransfersObserved: 2,
    cryptoToTransmuxTransfers: 2, cryptoToTransmuxDetached: 2,
  });
  return c;
}

test('counters start empty and require balanced worker/MSE cleanup', () => {
  const c = newTransmuxCounters('crypto-transmux-mse');
  assert.equal(c.knownTransmuxInputBytes, 0);
  assert.equal(c.transmuxWorkersCreated, 0);
  assert.equal(c.cryptoWorkersCreated, 0);
  validateCleanupOwnership(c, 0, 'crypto-transmux-mse');
  assert.throws(() => validateCleanupOwnership({ ...c, transmuxWorkersCreated: 1 }, 0), /OWNERSHIP_FAIL/);
  assert.throws(() => validateCleanupOwnership({ ...c, cryptoWorkersCreated: 1 }, 0, 'crypto-transmux-mse'), /CRYPTO_OWNERSHIP_FAIL/);
});

test('BOOTSTRAP and TRANSMUX_CHUNK transfers detach input and settle only matching replies', async () => {
  const c = newTransmuxCounters();
  const w = worker((target, message) => {
    target.dispatchEvent(new MessageEvent('message', { data: { type: 'UNRELATED' } }));
    target.dispatchEvent(new MessageEvent('message', { data: { type: message.type === 'BOOTSTRAP' ? 'BOOTSTRAP_COMPLETE' : 'CHUNK_TRANSMUXED', chunkIndex: message.chunkIndex } }));
  });
  const client = createTransmuxWorkerClient(w, c);
  for (const [message, expected] of [[{ type: 'BOOTSTRAP', chunk0: new ArrayBuffer(16) }, 'BOOTSTRAP_COMPLETE'],
    [{ type: 'TRANSMUX_CHUNK', chunkIndex: 1, decryptedChunk: new ArrayBuffer(8) }, 'CHUNK_TRANSMUXED']]) {
    const input = message.chunk0 || message.decryptedChunk;
    c.liveKnownArrayBufferBytes += input.byteLength;
    await client.send(message, [input], expected);
    assert.equal(input.byteLength, 0);
  }
  assert.equal(c.bootstrapResponsesReceived, 1);
  assert.equal(c.transmuxResponsesReceived, 1);
  assert.equal(c.transmuxMessagesPending, 0);
  assert.equal(c.knownTransmuxInputBytes, 0);
  assert.equal(c.liveKnownArrayBufferBytes, 0);
});

test('worker errors and cleanup settle pending requests without retry', async () => {
  const c = newTransmuxCounters();
  const failing = createTransmuxWorkerClient(worker((target, message) => target.dispatchEvent(
    new MessageEvent('message', { data: { type: 'ERROR', message: 'MP4_PARSER_ERROR', chunkIndex: message.chunkIndex } }))), c);
  const errorInput = new ArrayBuffer(2); c.liveKnownArrayBufferBytes += errorInput.byteLength;
  await assert.rejects(failing.send({ type: 'BOOTSTRAP', chunkIndex: -1 }, [errorInput], 'BOOTSTRAP_COMPLETE'), /MP4_PARSER_ERROR/);
  assert.equal(c.transmuxErrors, 1); assert.equal(c.transmuxMessagesPending, 0);

  const pendingWorker = new EventTarget(); pendingWorker.postMessage = (message, transfers) => { structuredClone(message, { transfer: transfers }); };
  const pending = createTransmuxWorkerClient(pendingWorker, c);
  const input = new ArrayBuffer(3); c.liveKnownArrayBufferBytes += input.byteLength;
  const request = pending.send({ type: 'BOOTSTRAP' }, [input], 'BOOTSTRAP_COMPLETE');
  pending.close(); pending.close();
  await assert.rejects(request, /TRANSMUX_REQUEST_CANCELLED/);
  assert.equal(c.pendingTransmuxMessages, 0);
});

test('segment ownership covers queued outputs and releases after append, including errors', async () => {
  const c = newTransmuxCounters(), first = new ArrayBuffer(4), second = new ArrayBuffer(8);
  const response = { segments: [{ buffer: first }, { buffer: second }] };
  const appended = [];
  await appendWorkerOutput({ append: async bytes => appended.push(bytes.byteLength) }, response, c, false);
  assert.deepEqual(appended, [4, 8]);
  assert.equal(response.segments[0].buffer, null); assert.equal(response.segments[1].buffer, null);
  assert.equal(c.knownTransmuxOutputBytes, 0); assert.equal(c.segmentBytesAppended, 12);

  const failed = { segments: [{ buffer: new ArrayBuffer(5) }] };
  await assert.rejects(appendWorkerOutput({ append: async () => { throw new Error('append failed'); } }, failed, c, false));
  assert.equal(failed.segments[0].buffer, null); assert.equal(c.knownTransmuxOutputBytes, 0);
});

test('final ownership validator rejects retained buffers, workers, messages and incomplete output', () => {
  validateTransmuxOwnership(complete(), 0);
  validateTransmuxOwnership(complete('crypto-transmux-mse'), 0, 'crypto-transmux-mse');
  for (const key of ['pendingTransmuxMessages', 'knownTransmuxInputBytes', 'knownTransmuxOutputBytes']) {
    assert.throws(() => validateTransmuxOwnership({ ...complete(), [key]: 1 }, 0));
  }
  assert.throws(() => validateTransmuxOwnership({ ...complete(), transmuxWorkersTerminated: 0 }, 0));
  assert.throws(() => validateTransmuxOwnership({ ...complete(), outputTransferBuffersReceived: 0 }, 0));
});

test('classification uses process ownership and leaves equal or missing attribution inconclusive', () => {
  const row = (browser, renderer) => ({ phases: [{ phase: 'cycle-6-close', gc: 'natural', processTypes: {
    browser: { privateBytes: { signedDelta: { median: browser } } },
    renderer: { privateBytes: { signedDelta: { median: renderer } } },
  } }] });
  assert.equal(classifyTransmux(row(20, 5)), 'TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP');
  assert.equal(classifyTransmux(row(1, 20)), 'TRANSMUX_MSE_DOES_NOT_REPRODUCE');
  assert.equal(classifyTransmux(row(10, 10)), 'INCONCLUSIVE_TRANSMUX_MSE_OWNERSHIP');
  assert.equal(classifyTransmux({ phases: [] }), 'INCONCLUSIVE_TRANSMUX_MSE_OWNERSHIP');
});
