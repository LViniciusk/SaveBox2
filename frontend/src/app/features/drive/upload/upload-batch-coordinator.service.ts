import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DriveService } from '../services/drive.service';
import {
  BatchUploadResponseItem,
  PreparedUpload,
  UploadBatchCandidate,
  UploadBatchResult,
  UploadBatchSummary,
} from './upload.models';
import { UploadEngineService } from './upload-engine.service';
import { UploadQueue } from './upload-queue';

export const BATCH_API_LIMIT = 100;
export const BATCH_WINDOW_SIZE = 5;
export const PREPARATION_CONCURRENCY = 1;
export const LOCAL_UPLOAD_CONCURRENCY = 2;
export const GOOGLE_UPLOAD_CONCURRENCY = 1;

export interface UploadBatchCallbacks {
  onInitialized(candidate: UploadBatchCandidate, prepared: PreparedUpload, response: BatchUploadResponseItem): void;
  onProgress(candidate: UploadBatchCandidate, progress: number, transferredBytes: number, totalBytes: number): void;
  onResult(result: UploadBatchResult): void;
}

interface PreparedCandidate {
  candidate: UploadBatchCandidate;
  prepared: PreparedUpload;
}

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
    const summary: UploadBatchSummary = { total: candidates.length, succeeded: 0, paused: 0, failed: 0 };
    let stop = false;

    for (let offset = 0; offset < candidates.length && !stop; offset += BATCH_WINDOW_SIZE) {
      const window = candidates.slice(offset, offset + BATCH_WINDOW_SIZE);
      const prepared = await this.prepareWindow(window, callbacks, summary);
      if (!prepared.length) continue;

      const duplicateHashes = this.duplicateHashes(prepared);
      const valid = prepared.filter(item => {
        if (!duplicateHashes.has(item.prepared.nameHash)) return true;
        this.fail(item.candidate, new Error('Seleção contém nomes duplicados no mesmo lote'), callbacks, summary);
        return false;
      });
      if (!valid.length) continue;

      let response: BatchUploadResponseItem[];
      try {
        response = (await firstValueFrom(this.driveService.batchInitUploads(valid.map(item => ({
          folder_id: item.candidate.folderId,
          encrypted_name: item.prepared.encryptedName,
          name_hash: item.prepared.nameHash,
          encrypted_fdk: item.prepared.encryptedFdk,
          size_bytes: item.prepared.encryptedSize,
          total_chunks: item.prepared.totalChunks,
          storage_provider: item.candidate.provider,
        })) ))).files;
        this.validateResponse(valid, response);
      } catch (error) {
        for (const item of valid) this.fail(item.candidate, error, callbacks, summary);
        stop = this.statusOf(error) === 401;
        if (stop) {
          for (const pending of candidates.slice(offset + window.length)) {
            this.fail(pending, error, callbacks, summary);
          }
        }
        continue;
      }

      const byHash = new Map(response.map(item => [item.name_hash, item]));
      const localTasks: Array<() => Promise<void>> = [];
      const googleTasks: Array<() => Promise<void>> = [];

      for (const item of valid) {
        const init = byHash.get(item.prepared.nameHash)!;
        callbacks.onInitialized(item.candidate, item.prepared, init);
        const task = () => this.execute(item, init, callbacks, summary);
        (item.candidate.provider === 'google_drive' ? googleTasks : localTasks).push(task);
      }

      await Promise.all([
        new UploadQueue(LOCAL_UPLOAD_CONCURRENCY).run(localTasks),
        new UploadQueue(GOOGLE_UPLOAD_CONCURRENCY).run(googleTasks),
      ]);
    }

    return summary;
  }

  private async prepareWindow(
    candidates: readonly UploadBatchCandidate[],
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): Promise<PreparedCandidate[]> {
    const prepared: PreparedCandidate[] = [];
    const queue = new UploadQueue(PREPARATION_CONCURRENCY);
    await queue.run(candidates.map(candidate => async () => {
      if (candidate.control.shouldCancel()) return;
      try {
        prepared.push({ candidate, prepared: await this.uploadEngine.prepareUpload(candidate.file) });
      } catch (error) {
        this.fail(candidate, error, callbacks, summary);
      }
    }));
    return prepared;
  }

  private async execute(
    item: PreparedCandidate,
    response: BatchUploadResponseItem,
    callbacks: UploadBatchCallbacks,
    summary: UploadBatchSummary
  ): Promise<void> {
    try {
      const result = await this.uploadEngine.execute(
        item.prepared,
        response.file_id,
        response.storage_provider,
        response,
        item.candidate.control,
        { onProgress: update => callbacks.onProgress(item.candidate, update.progress, update.transferredBytes, update.totalBytes) }
      );
      if (result.paused) {
        summary.paused++;
        callbacks.onResult({ transferId: item.candidate.transferId, status: 'paused' });
      } else {
        summary.succeeded++;
        callbacks.onResult({ transferId: item.candidate.transferId, status: 'success' });
      }
    } catch (error) {
      this.fail(item.candidate, error, callbacks, summary);
    }
  }

  private validateResponse(candidates: readonly PreparedCandidate[], response: readonly BatchUploadResponseItem[]): void {
    if (response.length !== candidates.length) throw new Error('Resposta batch inconsistente');
    const hashes = new Set<string>();
    const ids = new Set<number>();
    const expected = new Set(candidates.map(item => item.prepared.nameHash));
    const providers = new Map(candidates.map(item => [item.prepared.nameHash, item.candidate.provider]));
    for (const item of response) {
      if (!item.file_id || !item.name_hash || !expected.has(item.name_hash) || hashes.has(item.name_hash) || ids.has(item.file_id)) {
        throw new Error('Resposta batch inconsistente');
      }
      if (providers.get(item.name_hash) !== item.storage_provider) {
        throw new Error('Provider batch inconsistente');
      }
      if (item.storage_provider !== 'local' && item.storage_provider !== 'google_drive') {
        throw new Error('Provider batch inválido');
      }
      if (item.storage_provider === 'google_drive' && (!item.access_token || !item.root_folder_id)) {
        throw new Error('Resposta Google batch incompleta');
      }
      hashes.add(item.name_hash);
      ids.add(item.file_id);
    }
  }

  private duplicateHashes(items: readonly PreparedCandidate[]): Set<string> {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.prepared.nameHash, (counts.get(item.prepared.nameHash) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([hash]) => hash));
  }

  private fail(candidate: UploadBatchCandidate, error: unknown, callbacks: UploadBatchCallbacks, summary: UploadBatchSummary): void {
    summary.failed++;
    callbacks.onResult({ transferId: candidate.transferId, status: 'error', error });
  }

  private statusOf(error: unknown): number | undefined {
    return error instanceof HttpErrorResponse ? error.status : (error as { status?: number })?.status;
  }
}
