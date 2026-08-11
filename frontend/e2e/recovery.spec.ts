import { test, expect } from './support/fixtures';
import type { Page, Request } from '@playwright/test';
import { resolveE2EBackendOrigin } from '../tools/e2e-backend-routing.mjs';
import {
  classifyRecoveryContinuation,
  createRecoveryEvidenceJournal,
  parseRecoveryJournal,
  RECOVERY_JOURNAL_SCHEMA,
} from '../tools/e2e-recovery-diagnostics.mjs';
import {
  deterministicFile,
  driveItem,
  ensureVaultUnlocked,
  downloadDriveFile,
  loginAndUnlock,
  sha256File,
  uniqueFileName,
} from './support/session';

type RecoveryRequestInfo = {
  kind: 'chunk';
  fileId: number;
  chunkIndex?: number;
  method: string;
};

const RECOVERY_CONVERGENCE_TIMEOUT_MS = 120_000;
const RECOVERY_TEST_TIMEOUT_MS = 180_000;

async function installContinuationTrace(page: Page, filename: string): Promise<boolean> {
  const installed = await page.evaluate(({ filename }) => {
    const api = (window as any).ng;
    const panel = document.querySelector('app-transfer-panel');
    const component = typeof api?.getComponent === 'function' ? api.getComponent(panel) : undefined;
    const store = component?.driveStore;
    const sink = (window as any).__nanikaM26RecordRecoveryEvent;
    const transfers = typeof store?.transfers === 'function' ? store.transfers() : [];
    const targetTransfers = transfers.filter((item: any) => item?.fileName === filename && item?.isRecovery === true);
    const cards = [...document.querySelectorAll('.transfer-card')].filter(item => item.textContent?.includes(filename));
    const cardHasRecoveryInput = cards.length === 1 && cards[0].querySelectorAll('[data-testid="recovery-file-input"]').length === 1;
    const shapeValid = !!panel && targetTransfers.length === 1 && cardHasRecoveryInput
      && store.activeUploads instanceof Map
      && typeof store.uploadRuntimeGeneration === 'number'
      && typeof store.runUploadLoop === 'function'
      && typeof store.updateTransfer === 'function'
      && typeof store.updateTransferProgress === 'function'
      && typeof store.uploadEngine?.executeLocal === 'function'
      && typeof store.driveService?.uploadChunk === 'function'
      && typeof sink === 'function';
    if (!shapeValid) return false;

    const targetId = targetTransfers[0].id;
    const targetFileId = targetTransfers[0].pendingData?.id;
    const expectedFinalChunk = targetTransfers[0].pendingData?.total_chunks - 1;
    if (typeof targetId !== 'string' || !Number.isSafeInteger(targetFileId) || !Number.isInteger(expectedFinalChunk) || expectedFinalChunk < 0) return false;

    const restores: Array<() => void> = [];
    let targetFinalChunkWrapped = false;
    let instrumentationHealthy = true;
    let terminalSuccessApplied = false;
    const record = (kind: string, details: Record<string, unknown> = {}) => {
      if (!instrumentationHealthy) return Promise.resolve(false);
      try {
        return Promise.resolve(sink({ kind, phase: 'recovery', ...details })).catch(() => {
          instrumentationHealthy = false;
          return false;
        });
      } catch {
        instrumentationHealthy = false;
        return Promise.resolve(false);
      }
    };
    const stateClass = (value: unknown) => ['processing', 'paused', 'success', 'error', 'cancelled', 'cancelling'].includes(String(value)) ? value : 'unknown';
    const progressClass = (value: unknown) => typeof value !== 'number' ? 'unknown'
      : value >= 100 ? '100' : value >= 50 ? '50-99' : '0-49';
    const targetPresent = () => store.transfers().some((item: any) => item?.id === targetId);

    const originalLoop = store.runUploadLoop;
    restores.push(() => { store.runUploadLoop = originalLoop; });
    store.runUploadLoop = function (...args: any[]) {
      if (args[1] !== targetId) return originalLoop.apply(this, args);
      const generation = args[5] ?? store.uploadRuntimeGeneration;
      record('run-upload-loop-enter', { generationCurrent: generation === store.uploadRuntimeGeneration });
      let operation: Promise<unknown>;
      try { operation = originalLoop.apply(this, args); }
      catch (error) { record('run-upload-loop-rejected', { generationCurrent: generation === store.uploadRuntimeGeneration }); throw error; }
      return Promise.resolve(operation).then(value => {
        record('run-upload-loop-resolved', { generationCurrent: generation === store.uploadRuntimeGeneration });
        return value;
      }, error => {
        record('run-upload-loop-rejected', { generationCurrent: generation === store.uploadRuntimeGeneration });
        throw error;
      });
    };

    const engine = store.uploadEngine;
    const originalEngine = engine.executeLocal;
    restores.push(() => { engine.executeLocal = originalEngine; });
    engine.executeLocal = function (...args: any[]) {
      if (args[1] !== targetFileId) return originalEngine.apply(this, args);
      record('upload-engine-enter');
      let operation: Promise<unknown>;
      try { operation = originalEngine.apply(this, args); }
      catch (error) { record('upload-engine-rejected'); throw error; }
      return Promise.resolve(operation).then(value => { record('upload-engine-resolved'); return value; }, error => {
        record('upload-engine-rejected');
        throw error;
      });
    };

    const originalProgress = store.updateTransferProgress;
    restores.push(() => { store.updateTransferProgress = originalProgress; });
    store.updateTransferProgress = function (id: unknown, progress: number, ...args: unknown[]) {
      const result = originalProgress.call(this, id, progress, ...args);
      if (id === targetId && progress === 100) record('store-progress-100', { transferPresent: targetPresent() });
      return result;
    };
    const originalUpdate = store.updateTransfer;
    restores.push(() => { store.updateTransfer = originalUpdate; });
    store.updateTransfer = function (id: unknown, updates: Record<string, unknown>) {
      const result = originalUpdate.call(this, id, updates);
      if (id === targetId && updates?.status === 'success' && updates?.progress === 100) {
        const item = store.transfers().find((transfer: any) => transfer?.id === targetId);
        terminalSuccessApplied = !!item && item.status === 'success' && item.progress === 100;
        record('terminal-success-applied', {
          present: !!item,
          state: stateClass(item?.status),
          progressClass: progressClass(item?.progress),
        });
        snapshotStore();
      }
      return result;
    };

    const drive = store.driveService;
    const originalUploadChunk = drive.uploadChunk;
    restores.push(() => { drive.uploadChunk = originalUploadChunk; });
    drive.uploadChunk = function (fileId: unknown, chunkIndex: unknown, ...args: unknown[]) {
      const source = originalUploadChunk.call(this, fileId, chunkIndex, ...args);
      const runtime = [...store.activeUploads.values()].find((item: any) => item?.transferId === targetId && item?.provider === 'local');
      const isTargetFinalChunk = runtime?.fileId === fileId && runtime?.plan?.totalChunks - 1 === chunkIndex
        && fileId === targetFileId && chunkIndex === expectedFinalChunk;
      if (!isTargetFinalChunk) return source;
      targetFinalChunkWrapped = true;
      return {
        subscribe(observer: any) {
          record('chunk-observable-subscribed');
          return source.subscribe({
            next(value: unknown) { record('chunk-observable-next'); observer?.next?.(value); },
            error(error: unknown) { record('chunk-observable-error'); observer?.error?.(error); },
            complete() { record('chunk-observable-complete'); observer?.complete?.(); },
          });
        },
      };
    };

    const snapshotStore = () => {
      const item = store.transfers().find((transfer: any) => transfer?.id === targetId);
      return record('store-state-snapshot', {
        present: !!item,
        state: stateClass(item?.status),
        progressClass: progressClass(item?.progress),
      });
    };
    const snapshotDom = () => {
      const matches = [...document.querySelectorAll('.transfer-card')].filter(item => item.textContent?.includes(filename));
      if (matches.length === 0 && terminalSuccessApplied) return record('dom-terminal-hidden');
      const card = matches.length === 1 ? matches[0] : undefined;
      const state = card ? ['success', 'paused', 'error', 'cancelled'].find(value => card.classList.contains(value))
        ?? (card.querySelector('.spinner') ? 'processing' : 'unknown') : 'unknown';
      const percentText = card?.querySelector('.status-indicator')?.textContent?.match(/\b(\d{1,3})%\b/)?.[1];
      const widthText = card?.querySelector('.transfer-progress-bar-fill')?.getAttribute('style')?.match(/width:\s*(\d{1,3})%/i)?.[1];
      const progress = percentText ?? widthText;
      const snapshot = record('dom-state-snapshot', {
        state,
        progressClass: progress === undefined ? 'unknown' : progressClass(Number(progress)),
        matchingCards: matches.length,
      });
      return state === 'success' && matches.length === 1
        ? Promise.resolve(snapshot).then(() => record('dom-success-observed'))
        : snapshot;
    };
    (window as any).__nanikaM26Trace = {
      snapshotStore,
      snapshotDom,
      valid: () => targetFinalChunkWrapped && instrumentationHealthy,
      restore: () => { for (const restore of restores.reverse()) restore(); },
    };
    return true;
  }, { filename });
  return installed;
}

async function restoreContinuationTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__nanikaM26Trace?.restore();
    delete (window as any).__nanikaM26Trace;
  }).catch(() => undefined);
}

test('recovers the same local upload and preserves its bytes', async ({ page, credentials }, testInfo) => {
  test.setTimeout(RECOVERY_TEST_TIMEOUT_MS);
  const evidencePath = process.env.NANIKA_RECOVERY_EVIDENCE_PATH ?? '';
  const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? '';
  const journal = createRecoveryEvidenceJournal(evidencePath, outputDir);
  const appendEvent = (event: unknown) => journal.append(event);
  journal.append({ kind: 'phase-start', phase: 'initial' });
  try {
    await page.exposeFunction('__nanikaM26RecordRecoveryEvent', appendEvent);
  } catch {
    journal.append({ kind: 'instrumentation-invalid', phase: 'initial' });
    journal.close();
    throw new Error('Recovery evidence transport unavailable');
  }
  const filename = uniqueFileName('recovery-e2e', 'bin');
  const initialFileIds: number[] = [];
  const recoveryFileIds: number[] = [];
  const prefixFileIds: number[] = [];
  const recoveryDownloadFileIds: number[] = [];
  const requestInfo = new WeakMap<Request, RecoveryRequestInfo>();
  let phase: 'initial' | 'recovery' = 'initial';
  let chunkRequests = 0;
  let forcedChunkFailureInjected = false;
  let firstChunkResponseStatus: number | null = null;
  let firstChunkResponsePort: string | null = null;
  const recoveryChunkIndices: number[] = [];
  const expectedBackendPort = new URL(resolveE2EBackendOrigin(process.env)).port;

  const record = (kind: string, details: Record<string, unknown> = {}) => {
    appendEvent({ kind, phase, ...details });
  };
  const diagnosticRequestInfo = (request: Request): RecoveryRequestInfo | undefined => {
    const path = new URL(request.url()).pathname;
    const chunk = path.match(/^\/files\/(\d+)\/chunks$/);
    if (!chunk) return undefined;

    const fileId = Number(chunk[1]);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) return undefined;
    let chunkIndex: number | undefined;
    const rawIndex = request.headers()['x-chunk-index'];
    const parsedIndex = rawIndex === undefined ? Number.NaN : Number(rawIndex);
    if (Number.isSafeInteger(parsedIndex) && parsedIndex >= 0) chunkIndex = parsedIndex;
    return {
      kind: 'chunk',
      fileId,
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
      method: request.method(),
    };
  };
  const attachDiagnostics = async () => {
    const result = parseRecoveryJournal(evidencePath, outputDir);
    await testInfo.attach('recovery-diagnostic', {
      body: Buffer.from(JSON.stringify({
        schema: RECOVERY_JOURNAL_SCHEMA,
        classifier: result.classifier,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        journalDurable: result.journalValid,
        eventCount: result.eventCount ?? 0,
        truncated: result.truncated ?? false,
      })),
      contentType: 'application/json',
    }).catch(() => undefined);
  };

  page.on('request', request => {
    const info = diagnosticRequestInfo(request);
    if (info) requestInfo.set(request, info);
    const chunk = request.url().match(/\/files\/(\d+)\/chunks$/);
    if (chunk) {
      const fileId = Number(chunk[1]);
      if (phase === 'initial') initialFileIds.push(fileId);
      else {
        recoveryFileIds.push(fileId);
        if (info?.kind === 'chunk' && info.method === 'POST' && info.chunkIndex !== undefined) {
          recoveryChunkIndices.push(info.chunkIndex);
        }
      }
    }
    const prefix = request.url().match(/\/files\/(\d+)\/pending-upload-recovery-prefix$/);
    if (prefix) prefixFileIds.push(Number(prefix[1]));
    const download = request.url().match(/\/files\/(\d+)\/download(?:\?|$)/);
    if (download) recoveryDownloadFileIds.push(Number(download[1]));
  });
  page.on('response', response => {
    const info = requestInfo.get(response.request());
    if (info?.kind === 'chunk') {
      const status = response.status();
      record('chunk-response', { statusClass: status >= 200 && status < 300 ? '2xx'
        : status >= 400 && status < 500 ? '4xx' : status >= 500 ? '5xx' : 'other' });
    }
    const url = new URL(response.url());
    if (/\/files\/\d+\/chunks$/.test(url.pathname)) {
      if (phase === 'initial' && firstChunkResponseStatus === null && response.request().method() === 'POST') {
        firstChunkResponseStatus = response.status();
        firstChunkResponsePort = url.port || (url.protocol === 'https:' ? '443' : '80');
      }
    }
  });

  page.on('requestfinished', request => {
    const info = requestInfo.get(request);
    if (info?.kind === 'chunk') record('chunk-finished');
  });

  page.on('requestfailed', request => {
    const info = requestInfo.get(request);
    if (info?.kind === 'chunk') record('chunk-failed');
  });

  try {
    await loginAndUnlock(page, credentials);
    const filePath = await deterministicFile(testInfo.outputPath(filename), 6 * 1024 * 1024);
    const expected = await sha256File(filePath);

    await page.route(/\/files\/(\d+)\/chunks$/, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      chunkRequests += 1;
      if (chunkRequests === 1) {
        await route.fallback();
        return;
      }
      forcedChunkFailureInjected = true;
      await route.abort('failed');
    });

    try {
      await page.getByTestId('drive-file-input').setInputFiles(filePath);
      await expect.poll(() => firstChunkResponseStatus, {
        timeout: 10_000,
        message: 'The initial upload chunk must receive an HTTP response from the configured E2E backend',
      }).not.toBeNull();
      expect(firstChunkResponseStatus).toBeGreaterThanOrEqual(200);
      expect(firstChunkResponseStatus).toBeLessThan(300);
      expect(firstChunkResponsePort).toBe(expectedBackendPort);

      await page.getByRole('button', { name: /Transferências|Pendentes/ }).click();
      const failedTransfer = page.locator('.transfer-card').filter({ hasText: filename }).first();
      await expect.poll(async () => {
        if (!forcedChunkFailureInjected) return 'awaiting-forced-chunk-failure';
        const text = (await failedTransfer.textContent()) ?? '';
        if (/Falhou|Pausado/.test(text)) return 'terminal';
        return 'failure-injected-ui-nonterminal';
      }, {
        timeout: 30_000,
        message: 'Recovery upload must inject the forced second-chunk failure before converging to a terminal recoverable state',
      }).toBe('terminal');
    } finally {
      await page.unroute(/\/files\/(\d+)\/chunks$/);
    }
    await page.getByRole('button', { name: /Meu Drive/ }).click();
    expect(chunkRequests).toBeGreaterThan(1);
    expect(initialFileIds.length).toBeGreaterThan(1);
    const originalFileId = initialFileIds[0];
    expect(new Set(initialFileIds)).toEqual(new Set([originalFileId]));
    await page.reload();
    await page.waitForLoadState('networkidle');
    await ensureVaultUnlocked(page, credentials);
    await page.getByRole('button', { name: /Transferências|Pendentes/ }).click();
    const recoveryTransfer = page.locator('.transfer-card').filter({ hasText: filename }).first();
    await expect(recoveryTransfer.locator('[data-testid="recovery-file-input"]')).toHaveCount(1);

    phase = 'recovery';
    record('phase-start');
    const instrumentationInstalled = await installContinuationTrace(page, filename);
    if (!instrumentationInstalled) {
      record('instrumentation-invalid');
      expect(instrumentationInstalled, 'Angular debug runtime must expose the exact recovery card and required store shape').toBe(true);
    }
    record('instrumentation-installed');
    record('recovery-upload-start');
    await recoveryTransfer.locator('[data-testid="recovery-file-input"]').setInputFiles(filePath);
    await page.evaluate(async () => {
      await (window as any).__nanikaM26Trace?.snapshotStore();
      await (window as any).__nanikaM26Trace?.snapshotDom();
    });
    let previousCardText: string | undefined;
    await expect.poll(async () => {
      const matchingCards = await recoveryTransfer.count();
      if (matchingCards === 0) return 'completed-hidden';
      const card = recoveryTransfer.first();
      const state = await card.getAttribute('class');
      const progress = await card.locator('.status-indicator').textContent().catch(() => '');
      const fingerprint = `${state ?? ''}|${progress ?? ''}`;
      if (fingerprint !== previousCardText) {
        previousCardText = fingerprint;
        await page.evaluate(async () => {
          await (window as any).__nanikaM26Trace?.snapshotStore();
          await (window as any).__nanikaM26Trace?.snapshotDom();
        });
      }
      return (state ?? '').split(/\s+/).includes('success') ? 'completed' : fingerprint;
    }, { timeout: RECOVERY_CONVERGENCE_TIMEOUT_MS }).toMatch(/^(completed|completed-hidden)$/);
    await page.evaluate(async () => {
      await (window as any).__nanikaM26Trace?.snapshotStore();
      await (window as any).__nanikaM26Trace?.snapshotDom();
    });
    const instrumentationValid = await page.evaluate(() => (window as any).__nanikaM26Trace?.valid() === true);
    if (!instrumentationValid) record('instrumentation-invalid');
    expect(instrumentationValid).toBe(true);
    const continuation = parseRecoveryJournal(evidencePath, outputDir);
    expect(continuation.journalValid).toBe(true);
    expect(continuation.classifier).toBe('PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
    expect(continuation.evidence).toBeDefined();
    expect(classifyRecoveryContinuation(continuation.evidence!)).toBe('PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
    expect(prefixFileIds).toEqual([originalFileId]);
    expect(new Set(recoveryFileIds)).toEqual(new Set([originalFileId]));
    expect(recoveryChunkIndices).toEqual([1]);
    expect(recoveryDownloadFileIds).toEqual([]);

    await page.getByRole('button', { name: /Meu Drive/ }).click();
    await expect(driveItem(page, filename)).toBeVisible();
    expect(await sha256File(await downloadDriveFile(page, filename))).toBe(expected);
  } finally {
    try { await attachDiagnostics(); } catch { /* The journal was already written incrementally. */ }
    await restoreContinuationTrace(page);
    journal.close();
  }
});
