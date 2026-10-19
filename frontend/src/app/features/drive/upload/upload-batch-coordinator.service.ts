import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DriveService } from '../services/drive.service';
import {
  BatchUploadResponseItem,
  InitializedUpload,
  UploadPlan,
  UploadBatchCandidate,
  UploadBatchResult,
  UploadBatchSummary,
  UploadAbortError,
  UploadPauseError,
} from './upload.models';
import { UploadEngineService } from './upload-engine.service';
import { UploadQueue, UploadQueueTask } from './upload-queue';
import { firstValueFromAbortable, isUploadAbortError } from './abortable-observable';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS } from '../transfer-limits';

const BATCH_WINDOW_SIZE = 10;
const PREPARATION_CONCURRENCY = 2;
const LOCAL_UPLOAD_CONCURRENCY = 3;
const GOOGLE_UPLOAD_CONCURRENCY = 2;

export interface UploadBatchCallbacks {
  onInitialized(candidate: UploadBatchCandidate, initialized: InitializedUpload, response: BatchUploadResponseItem): void;
  onStarted?(candidate: UploadBatchCandidate): void;
  onProgress(candidate: UploadBatchCandidate, progress: number, transferredBytes: number, totalBytes: number): void;
  onResult(result: UploadBatchResult): void;
}

interface PlannedCandidate {
  candidate: UploadBatchCandidate;
  plan: UploadPlan;
}

type WindowInitialization =
  | { kind: 'ready'; response: BatchUploadResponseItem[] }
  | { kind: 'failed' }
  | { kind: 'unauthorized'; error: unknown };

@Injectable({ providedIn: 'root' })
export class UploadBatchCoordinatorService {
  private readonly driveService = inject(DriveService);
  private readonly uploadEngine = inject(UploadEngineService);
  private operationTail = Promise.resolve();

  upload(candidates: readonly UploadBatchCandidate[], callbacks: UploadBatchCallbacks): Promise<UploadBatchSummary> {
    const operation = this.operationTail.then(() => this.process(candidates, callbacks));
    this.operationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async process(
    candidates: readonly UploadBatchCandidate[],
    callbacks: UploadBatchCallbacks
  ): Promise<UploadBatchSummary> {
    const summary: UploadBatchSummary = { total: candidates.length, succeeded: 0, paused: 0, cancelled: 0, failed: 0 };

    for (let offset = 0; offset < candidates.length; offset += BATCH_WINDOW_SIZE) {
      const window = candidates.slice(offset, offset + BATCH_WINDOW_SIZE);
      const planned = await this.planWindow(window, callbacks, summary);
      if (!planned.length) continue;

      const valid = this.rejectDuplicates(planned, callbacks, summary);
      if (!valid.length) continue;

      const initialization = await this.initializeWindow(valid, callbacks, summary);
      if (initialization.kind === 'unauthorized') {
        for (let index = offset + window.length; index < candidates.length; index++) {
          this.fail(candidates[index], initialization.error, callbacks, summary);
        }
        break;
      }
      if (initialization.kind === 'failed') continue;

      await this.executeWindow(valid, initialization.response, callbacks, summary);
    }

    return summary;
  }

  private rejectDuplicates(
    planned: readonly PlannedCandidate[],
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): PlannedCandidate[] {
    const duplicateNamespaces = this.duplicateNamespaces(planned);
    return planned.filter(item => {
      if (this.isDetached(item.candidate)) {
        this.uploadEngine.discardUploadPlan(item.plan);
        return false;
      }
      const namespace = JSON.stringify([item.candidate.folderId, item.plan.nameHash]);
      if (!duplicateNamespaces.has(namespace)) return true;
      this.uploadEngine.discardUploadPlan(item.plan);
      this.fail(item.candidate, new Error('Seleção contém nomes duplicados no mesmo lote'), callbacks, summary);
      return false;
    });
  }

  private async initializeWindow(
    valid: readonly PlannedCandidate[],
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): Promise<WindowInitialization> {
    const batchAbort = this.abortWhenAllCancelled(valid.map(item => item.candidate));
    try {
      const batchRequest = this.driveService.batchInitUploads(valid.map(item => ({
        client_ref: item.candidate.transferId,
        folder_id: item.candidate.folderId,
        encrypted_name: item.plan.encryptedName,
        name_hash: item.plan.nameHash,
        encrypted_fdk: item.plan.encryptedFdk,
        size_bytes: item.plan.encryptedSize,
        total_chunks: item.plan.totalChunks,
        storage_provider: item.candidate.provider,
      })));
      const response = (await firstValueFromAbortable(batchRequest, batchAbort.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS)).files;
      this.validateResponse(valid, response);
      return { kind: 'ready', response };
    } catch (error) {
      for (const item of valid) {
        this.uploadEngine.discardUploadPlan(item.plan);
        if (this.isDetached(item.candidate)) continue;
        if (item.candidate.control.shouldCancel() || isUploadAbortError(error)) await this.cancel(item.candidate, callbacks, summary);
        else this.fail(item.candidate, error, callbacks, summary);
      }
      return this.statusOf(error) === 401 ? { kind: 'unauthorized', error } : { kind: 'failed' };
    } finally {
      batchAbort.dispose();
    }
  }

  private async executeWindow(
    valid: readonly PlannedCandidate[],
    response: readonly BatchUploadResponseItem[],
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): Promise<void> {
    const byClientRef = new Map(response.map(item => [item.client_ref, item]));
    const localTasks: UploadQueueTask<void>[] = [];
    const googleTasks: UploadQueueTask<void>[] = [];
    const cryptoGate = createConcurrencyGate(2);

    for (const item of valid) {
      const init = byClientRef.get(item.candidate.transferId)!;
      if (this.isDetached(item.candidate)) {
        this.uploadEngine.discardUploadPlan(item.plan);
        continue;
      }
      if (this.isCancelled(item.candidate)) {
        this.uploadEngine.discardUploadPlan(item.plan);
        await this.cleanupInitializedFile(init.file_id);
        await this.cancel(item.candidate, callbacks, summary);
        continue;
      }
      const task: UploadQueueTask<void> = {
        run: () => this.executeItem(item, init, callbacks, summary, cryptoGate),
      };
      (item.candidate.provider === 'google_drive' ? googleTasks : localTasks).push(task);
    }

    await Promise.all([
      new UploadQueue(LOCAL_UPLOAD_CONCURRENCY).run(localTasks),
      new UploadQueue(GOOGLE_UPLOAD_CONCURRENCY).run(googleTasks),
    ]);
  }

  private async planWindow(
    candidates: readonly UploadBatchCandidate[],
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): Promise<PlannedCandidate[]> {
    const planned: PlannedCandidate[] = [];
    const queue = new UploadQueue(PREPARATION_CONCURRENCY);
    await queue.run(candidates.map(candidate => async () => {
      if (this.isDetached(candidate)) return;
      if (candidate.control.shouldCancel()) {
        await this.cancel(candidate, callbacks, summary);
        return;
      }
      try {
        const plan = await this.uploadEngine.planUpload(candidate.file, candidate.control.signal);
        if (this.isDetached(candidate)) {
          this.uploadEngine.discardUploadPlan(plan);
          return;
        }
        planned.push({ candidate, plan });
      } catch (error) {
        if (this.isDetached(candidate)) return;
        if (candidate.control.shouldCancel() || isUploadAbortError(error)) await this.cancel(candidate, callbacks, summary);
        else this.fail(candidate, error, callbacks, summary);
      }
    }));
    return planned;
  }

  private async executeItem(
    item: PlannedCandidate,
    response: BatchUploadResponseItem,
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary,
    cryptoGate: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    let handedOff = false;
    let callbackAttempted = false;
    let initialized: InitializedUpload | undefined;
    try {
      if (this.isDetached(item.candidate)) {
        this.uploadEngine.discardUploadPlan(item.plan);
        return;
      }
      if (this.isCancelled(item.candidate)) {
        this.uploadEngine.discardUploadPlan(item.plan);
        await this.cleanupInitializedFile(response.file_id);
        await this.cancel(item.candidate, callbacks, summary);
        return;
      }
      if (item.candidate.provider === 'local') {
        const plan = this.uploadEngine.createLocalUploadPlan(item.plan);
        if (this.isCancelled(item.candidate)) {
          this.uploadEngine.discardUploadPlan(plan);
          await this.cleanupInitializedFile(response.file_id);
          await this.cancel(item.candidate, callbacks, summary);
          return;
        }
        initialized = { provider: 'local', plan };
      } else {
        if (this.isCancelled(item.candidate)) throw new UploadAbortError();
        initialized = { provider: 'google_drive', plan: this.uploadEngine.createGoogleUploadPlan(item.plan) };
      }
      if (this.isDetached(item.candidate)) {
        this.uploadEngine.discardUploadPlan(initializedPlan(initialized)!);
        return;
      }
      if (this.isCancelled(item.candidate)) {
        this.uploadEngine.discardUploadPlan(initializedPlan(initialized)!);
        await this.cleanupInitializedFile(response.file_id);
        await this.cancel(item.candidate, callbacks, summary);
        return;
      }
      callbackAttempted = true;
      callbacks.onInitialized(item.candidate, initialized, response);
      if (this.isDetached(item.candidate)) {
        this.uploadEngine.discardUploadPlan(initializedPlan(initialized)!);
        return;
      }
      handedOff = true;
      callbacks.onStarted?.(item.candidate);
      const callbacksForItem = {
        onProgress: (update: { progress: number; transferredBytes: number; totalBytes: number }) =>
          this.isDetached(item.candidate)
            ? undefined
            : callbacks.onProgress(item.candidate, update.progress, update.transferredBytes, update.totalBytes),
      };
      const scheduleCrypto = <T>(operation: () => Promise<T>): Promise<T> => cryptoGate(async () => {
        if (this.isStopped(item.candidate)) throw new UploadAbortError();
        if (item.candidate.control.shouldPause()) throw new UploadPauseError();
        return operation();
      });
      const result = initialized.provider === 'local'
        ? await this.uploadEngine.executeLocal(initialized.plan, response.file_id, item.candidate.control, callbacksForItem, scheduleCrypto)
        : await this.uploadEngine.executeGoogle(initialized.plan, response.file_id, undefined, item.candidate.control, callbacksForItem, scheduleCrypto);
      if (this.isDetached(item.candidate)) return;
      if (result.cancelled || item.candidate.control.shouldCancel()) {
        summary.cancelled++;
        await callbacks.onResult({
          transferId: item.candidate.transferId,
          status: 'cancelled',
          ...(initialized.provider === 'google_drive' && result.googleCleanupPending
            ? { googleCleanupPending: true }
            : {}),
        });
      } else if (result.paused) {
        summary.paused++;
        await callbacks.onResult({
          transferId: item.candidate.transferId,
          status: 'paused',
          ...(initialized.provider === 'google_drive' && result.googleSession
            ? { googleSession: result.googleSession }
            : {}),
        });
      } else {
        summary.succeeded++;
        await callbacks.onResult({ transferId: item.candidate.transferId, status: 'success' });
      }
    } catch (error) {
      if (this.isDetached(item.candidate)) {
        if (!handedOff) this.uploadEngine.discardUploadPlan(initializedPlan(initialized) ?? item.plan);
        return;
      }
      if (callbackAttempted && !handedOff) {
        this.uploadEngine.discardUploadPlan(initializedPlan(initialized) ?? item.plan);
        await this.cleanupInitializedFile(response.file_id);
        throw error;
      }
      if (handedOff) {
        this.fail(item.candidate, error, callbacks, summary);
        return;
      }
      this.uploadEngine.discardUploadPlan(initializedPlan(initialized) ?? item.plan);
      await this.cleanupInitializedFile(response.file_id);
      if (this.isCancelled(item.candidate) || isUploadAbortError(error)) await this.cancel(item.candidate, callbacks, summary);
      else this.fail(item.candidate, error, callbacks, summary);
    }
  }

  private validateResponse(candidates: readonly PlannedCandidate[], response: readonly BatchUploadResponseItem[]): void {
    if (response.length !== candidates.length) throw new Error('Resposta batch inconsistente');
    const clientRefs = new Set<string>();
    const ids = new Set<number>();
    const expected = new Map(candidates.map(item => [item.candidate.transferId, item]));
    for (const item of response) {
      const candidate = expected.get(item.client_ref);
      if (!item.client_ref || item.client_ref.length > 128 || !candidate || clientRefs.has(item.client_ref)
        || !item.file_id || ids.has(item.file_id) || item.name_hash !== candidate.plan.nameHash) {
        throw new Error('Resposta batch inconsistente');
      }
      if (candidate.candidate.provider !== item.storage_provider) {
        throw new Error('Provider batch inconsistente');
      }
      if (item.storage_provider !== 'local' && item.storage_provider !== 'google_drive') {
        throw new Error('Provider batch inválido');
      }
      clientRefs.add(item.client_ref);
      ids.add(item.file_id);
    }
  }

  private duplicateNamespaces(items: readonly PlannedCandidate[]): Set<string> {
    const counts = new Map<string, number>();
    for (const item of items) {
      const namespace = JSON.stringify([item.candidate.folderId, item.plan.nameHash]);
      counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([namespace]) => namespace));
  }

  private fail(candidate: UploadBatchCandidate, error: unknown, callbacks: UploadBatchCallbacks, summary: UploadBatchSummary): void {
    summary.failed++;
    callbacks.onResult({ transferId: candidate.transferId, status: 'error', error });
  }

  private async cancel(candidate: UploadBatchCandidate, callbacks: UploadBatchCallbacks, summary: UploadBatchSummary): Promise<void> {
    if (this.isDetached(candidate)) return;
    summary.cancelled++;
    await callbacks.onResult({ transferId: candidate.transferId, status: 'cancelled' });
  }

  private async cleanupInitializedFile(fileId: number): Promise<void> {
    try {
      await firstValueFromAbortable(this.driveService.trashFile(fileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await firstValueFromAbortable(this.driveService.hardDeleteFile(fileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    } catch (error: any) {
      if (error?.status !== 404) console.error('Falha ao limpar upload cancelado', error);
    }
  }

  private abortWhenAllCancelled(candidates: readonly UploadBatchCandidate[]): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const listeners: Array<() => void> = [];
    const check = () => {
      if (candidates.every(candidate => this.isStopped(candidate))) controller.abort();
    };
    for (const candidate of candidates) {
      const signal = candidate.control.signal;
      if (!signal) continue;
      const listener = () => check();
      signal.addEventListener('abort', listener);
      listeners.push(() => signal.removeEventListener('abort', listener));
    }
    check();
    return { signal: controller.signal, dispose: () => listeners.forEach(remove => remove()) };
  }

  private statusOf(error: unknown): number | undefined {
    return error instanceof HttpErrorResponse ? error.status : (error as { status?: number })?.status;
  }

  private isCancelled(candidate: UploadBatchCandidate): boolean {
    return !this.isDetached(candidate)
      && (candidate.control.shouldCancel() || !!candidate.control.signal?.aborted);
  }

  private isDetached(candidate: UploadBatchCandidate): boolean {
    return candidate.control.shouldDetach?.() ?? false;
  }

  private isStopped(candidate: UploadBatchCandidate): boolean {
    return this.isDetached(candidate) || this.isCancelled(candidate);
  }
}

function createConcurrencyGate(limit: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let available = limit;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (available > 0) {
      available--;
      return;
    }
    await new Promise<void>(resolve => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else available++;
  };
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function initializedPlan(initialized?: InitializedUpload): UploadPlan | undefined {
  if (!initialized) return undefined;
  return initialized.plan;
}
