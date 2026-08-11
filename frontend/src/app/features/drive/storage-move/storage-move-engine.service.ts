import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { firstValueFromAbortable, NetworkDeadlineError } from '../upload/abortable-observable';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';
import type { DriveFile } from '../state/drive.store';
import { StorageTarget } from '../state/drive.types';
import { StorageMoveItem, StorageMoveJob, StorageMoveView } from './storage-move.models';

const MOVE_CHUNK_SIZE = 4 * 1024 * 1024;

type GoogleChunkResult =
  | { kind: 'incomplete'; nextOffset: number }
  | { kind: 'completed'; externalFileId: string }
  | { kind: 'ambiguous' };

class RecoverableStorageMoveError extends Error {
  constructor(message: string) { super(message); }
}

@Injectable({ providedIn: 'root' })
export class StorageMoveEngineService {
  private readonly driveService = inject(DriveService);
  private readonly http = inject(HttpClient);
  private readonly controllers = new Map<number, AbortController>();
  private readonly sessions = new Map<number, { uri: string; token: string }>();
  private readonly sourceMetadata = new Map<number, { externalFileId: string; accessToken: string }>();
  private readonly targetFileIds = new Map<number, string>();
  private readonly names = new Map<number, string>();
  private readonly labels = new Map<number, { source: string; target: string }>();
  private readonly startedAt = new Map<number, { time: number; bytes: number }>();
  private readonly stages = new Map<number, 'prepare' | 'source_metadata' | 'source_read' | 'target_session' | 'target_write' | 'target_ack' | 'commit' | 'cleanup'>();
  private readonly jobsSignal = signal<StorageMoveView[]>([]);
  private readonly validatingMoveIds = new Set<number>();
  private readonly resumingMoveIds = new Map<number, symbol>();
  private readonly pauseOperations = new Map<number, symbol>();
  private runtimeGeneration = 0;
  private presentationGeneration = 0;

  readonly jobs = this.jobsSignal.asReadonly();
  readonly activeFileIds = computed(() => new Set(this.jobsSignal()
    .filter(job => !['completed', 'cancelled', 'failed'].includes(job.status))
    .map(job => job.file_id)));

  resetRuntimeState(): void {
    this.runtimeGeneration++;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.sessions.clear();
    this.sourceMetadata.clear();
    this.targetFileIds.clear();
    this.names.clear();
    this.labels.clear();
    this.startedAt.clear();
    this.stages.clear();
    this.validatingMoveIds.clear();
    this.resumingMoveIds.clear();
    this.pauseOperations.clear();
    this.jobsSignal.set([]);
  }

  clearDecryptedPresentationData(): void {
    this.presentationGeneration++;
    this.names.clear();
    this.jobsSignal.update(jobs => jobs.map(job => ({ ...job, fileName: `Arquivo ${job.file_id}` })));
  }

  async start(file: DriveFile, target: StorageTarget): Promise<StorageMoveJob> {
    const runtimeGeneration = this.runtimeGeneration;
    const presentationGeneration = this.presentationGeneration;
    const job = await firstValueFromAbortable(this.driveService.startStorageMove(file.id, target), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    if (this.runtimeGeneration !== runtimeGeneration) return job;
    if (this.presentationGeneration === presentationGeneration) {
      this.names.set(job.id, file.decryptedName ?? `Arquivo ${file.id}`);
    }
    this.labels.set(job.id, {
      source: file.storageProvider === 'local' ? 'Local' : `Google ${file.externalStorageId ?? ''}`.trim(),
      target: target.label,
    });
    this.upsertCanonical(job);
    void this.run(job.id);
    return job;
  }

  async loadActive(targets: readonly StorageTarget[], files: readonly DriveFile[]): Promise<void> {
    const runtimeGeneration = this.runtimeGeneration;
    const presentationGeneration = this.presentationGeneration;
    let response: { moves: StorageMoveJob[] };
    try {
      response = await firstValueFromAbortable(this.driveService.getActiveStorageMoves(), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    } catch {
      if (this.runtimeGeneration !== runtimeGeneration) return;
      this.jobsSignal.update(jobs => jobs.map(job => ({
        ...job,
        stateSyncError: true,
        speedBytesPerSecond: 0,
        etaSeconds: null,
      })));
      return;
    }
    if (this.runtimeGeneration !== runtimeGeneration) return;
    const canonicalIds = new Set(response.moves.map(job => job.id));
    const staleIds = new Set(this.jobsSignal()
      .filter(job => !canonicalIds.has(job.id) &&
        !this.controllers.has(job.id) &&
        !this.resumingMoveIds.has(job.id) &&
        !['completed', 'cancelled'].includes(job.status))
      .map(job => job.id));
    for (const moveId of staleIds) this.forgetMissingCanonicalMove(moveId);
    if (staleIds.size) this.jobsSignal.update(jobs => jobs.filter(job => !staleIds.has(job.id)));
    for (const job of response.moves) {
      if (this.runtimeGeneration !== runtimeGeneration) return;
      const file = files.find(item => item.id === job.file_id);
      const source = job.source_provider === 'local'
        ? 'Local'
        : targets.find(item => item.externalStorageId === job.source_external_storage_id)?.label ?? 'Google Drive';
      const target = job.target_provider === 'local'
        ? 'Local'
        : targets.find(item => item.externalStorageId === job.target_external_storage_id)?.label ?? 'Google Drive';
      if (this.presentationGeneration === presentationGeneration) {
        this.names.set(job.id, file?.decryptedName ?? `Arquivo ${job.file_id}`);
      }
      this.labels.set(job.id, { source, target });
      this.upsertCanonical(job);
      if (job.target_provider === 'google_drive' && job.status === 'paused') {
        try {
          const reconciled = await firstValueFromAbortable(this.driveService.reconcileStorageMove(job.id), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          if (this.runtimeGeneration !== runtimeGeneration) return;
          this.upsertCanonical(reconciled);
          if (reconciled.status === 'paused') continue;
          if (['prepared', 'transferring', 'target_uploaded', 'cleanup_pending'].includes(reconciled.status)) void this.run(job.id);
        } catch {
          if (this.runtimeGeneration !== runtimeGeneration) return;
          this.upsert(job, { stateSyncError: true });
        }
        continue;
      }
      if (['prepared', 'transferring', 'target_uploaded', 'cleanup_pending'].includes(job.status)) void this.run(job.id);
    }
  }

  async pause(moveId: number): Promise<void> {
    const operation = Symbol();
    this.pauseOperations.set(moveId, operation);
    try {
      this.controllers.get(moveId)?.abort();
      this.dropSessions(moveId);
      let current: StorageMoveJob;
      try {
        current = await firstValueFromAbortable(this.driveService.pauseStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      } catch (pauseError) {
        try {
          current = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        } catch {
          if (this.pauseOperations.get(moveId) !== operation) return;
          const local = this.jobsSignal().find(job => job.id === moveId);
          if (local) this.upsert(local, { stateSyncError: true });
          throw pauseError;
        }
      }
      if (this.pauseOperations.get(moveId) !== operation) return;
      this.upsertCanonical(current);
      this.dropTransientExecutionState(moveId);
      if (['prepared', 'transferring', 'target_uploaded', 'cleanup_pending'].includes(current.status)) void this.run(moveId);
    } finally {
      if (this.pauseOperations.get(moveId) === operation) this.pauseOperations.delete(moveId);
    }
  }

  async resume(moveId: number): Promise<void> {
    if (this.controllers.has(moveId) || this.resumingMoveIds.has(moveId)) return;
    const operation = Symbol();
    this.resumingMoveIds.set(moveId, operation);
    try {
      let current: StorageMoveJob;
      try {
        current = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      } catch (error) {
        if (this.resumingMoveIds.get(moveId) !== operation) return;
        throw error;
      }
      if (this.resumingMoveIds.get(moveId) !== operation) return;
      this.upsertCanonical(current);
      if (current.status !== 'paused') {
        if (['prepared', 'transferring', 'target_uploaded', 'cleanup_pending'].includes(current.status)) void this.run(moveId);
        return;
      }
      if (current.target_provider === 'google_drive') {
        try {
          current = await firstValueFromAbortable(this.driveService.reconcileStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        } catch (error) {
          if (this.resumingMoveIds.get(moveId) !== operation) return;
          this.upsert(current, { stateSyncError: true });
          return;
        }
        if (this.resumingMoveIds.get(moveId) !== operation) return;
        this.upsertCanonical(current);
        if (current.status === 'paused') {
          if (this.resumingMoveIds.get(moveId) !== operation) return;
          try {
            current = await firstValueFromAbortable(this.driveService.resumeStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          } catch (error) {
            if (this.resumingMoveIds.get(moveId) !== operation) return;
            throw error;
          }
          if (this.resumingMoveIds.get(moveId) !== operation) return;
          this.upsertCanonical(current);
        }
      } else {
        if (this.resumingMoveIds.get(moveId) !== operation) return;
        try {
          current = await firstValueFromAbortable(this.driveService.resumeStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        } catch (error) {
          if (this.resumingMoveIds.get(moveId) !== operation) return;
          throw error;
        }
        if (this.resumingMoveIds.get(moveId) !== operation) return;
        this.upsertCanonical(current);
      }
      if (['prepared', 'transferring', 'target_uploaded', 'cleanup_pending'].includes(current.status)) void this.run(moveId);
    } finally {
      if (this.resumingMoveIds.get(moveId) === operation) this.resumingMoveIds.delete(moveId);
    }
  }

  async cancel(moveId: number): Promise<void> {
    this.pauseOperations.delete(moveId);
    const resumeBarrier = Symbol();
    this.resumingMoveIds.set(moveId, resumeBarrier);
    try {
      this.controllers.get(moveId)?.abort();
      this.dropSessions(moveId);
      const items = this.jobsSignal().find(job => job.id === moveId)?.items.flatMap(item => {
        const externalId = this.targetFileIds.get(item.id) ?? item.target_external_file_id;
        return externalId ? [{ item_id: item.id, target_external_file_id: externalId }] : [];
      }) ?? [];
      try {
        const cancelled = await firstValueFromAbortable(this.driveService.cancelStorageMove(moveId, items), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
        this.pauseOperations.delete(moveId);
        this.upsertCanonical(cancelled);
        this.dropTargetFileIds(moveId);
        this.dropTransientExecutionState(moveId);
        return;
      } catch (cancelError) {
        if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;

        let current: StorageMoveJob;
        try {
          current = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        } catch {
          if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
          const local = this.jobsSignal().find(job => job.id === moveId);
          if (local) this.upsert(local, { stateSyncError: true });
          throw cancelError;
        }

        if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
        this.upsertCanonical(current);
        if (current.status === 'cancelled' || current.status === 'completed') {
          this.pauseOperations.delete(moveId);
          this.dropTargetFileIds(moveId);
          this.dropTransientExecutionState(moveId);
          return;
        }
        if (current.status === 'cleanup_pending') {
          void this.run(moveId);
          return;
        }
        if (!['prepared', 'transferring', 'target_uploaded'].includes(current.status)) return;

        if (
          current.status === 'transferring'
          && current.target_provider === 'google_drive'
          && current.items.some(item => this.targetFileIds.has(item.id) || item.target_external_file_id)
        ) {
          try {
            current = await firstValueFromAbortable(this.driveService.reconcileStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          } catch {
            if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
            this.upsert(current, { stateSyncError: true });
            return;
          }
          if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
          this.upsertCanonical(current);
        }

        if (this.resumingMoveIds.get(moveId) !== resumeBarrier) return;
        void this.run(moveId);
      }
    } finally {
      if (this.resumingMoveIds.get(moveId) === resumeBarrier) this.resumingMoveIds.delete(moveId);
    }
  }

  async clear(moveId: number): Promise<void> {
    const job = this.jobsSignal().find(item => item.id === moveId);
    if (job && ['completed', 'cancelled', 'failed'].includes(job.status)) {
      this.controllers.get(moveId)?.abort();
      await firstValueFromAbortable(this.driveService.clearStorageMove(moveId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.dropTargetFileIds(moveId);
      this.dropTransientExecutionState(moveId);
      this.names.delete(moveId);
      this.labels.delete(moveId);
      this.jobsSignal.update(items => items.filter(item => item.id !== moveId));
    }
  }

  private async run(moveId: number): Promise<void> {
    if (this.controllers.has(moveId)) return;
    const controller = new AbortController();
    this.controllers.set(moveId, controller);
    let rerunAfterCleanup = false;
    try {
      let job = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), controller.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.throwIfAborted(controller.signal);
      this.upsertCanonical(job);
      if (job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') return;
      if (job.status === 'cleanup_pending') {
        const final = await this.finishCleanup(moveId, controller.signal);
        this.throwIfAborted(controller.signal);
        if (final.status === 'completed') this.dropTargetFileIds(moveId);
        return;
      }
      if (job.status === 'prepared' || job.status === 'transferring') {
        job = await firstValueFromAbortable(this.driveService.resumeStorageMove(moveId), controller.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        this.throwIfAborted(controller.signal);
        this.upsertCanonical(job);
      }
      for (const item of job.items) {
        if (item.status === 'target_uploaded' || item.status === 'completed') continue;
        if (job.target_provider === 'local') await this.transferToLocal(job, item, controller.signal);
        else await this.transferToGoogle(job, item, controller.signal);
        this.throwIfAborted(controller.signal);
      }
      this.stages.set(moveId, 'commit');
      let completed = await firstValueFromAbortable(this.driveService.completeStorageMove(moveId), controller.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.throwIfAborted(controller.signal);
      if (completed.status === 'cleanup_pending') {
        completed = await this.finishCleanup(moveId, controller.signal);
        this.throwIfAborted(controller.signal);
        if (completed.status === 'completed') this.dropTargetFileIds(moveId);
        return;
      }
      this.upsertCanonical(completed);
      this.dropTargetFileIds(moveId);
    } catch (error) {
      if (!controller.signal.aborted) {
        const current = this.jobsSignal().find(job => job.id === moveId);
        if (current) {
          const retryable = this.isRetryableFailure(error);
          const stage = this.stages.get(moveId) ?? 'prepare';
          const targets = current.items.flatMap(item => {
            const externalId = this.targetFileIds.get(item.id) ?? item.target_external_file_id;
            return externalId ? [{ item_id: item.id, target_external_file_id: externalId }] : [];
          });
          rerunAfterCleanup = await this.persistFailureState(moveId, current, this.failureCode(stage, current.target_provider), stage, retryable, targets, controller.signal);
        }
      }
    } finally {
      if (this.controllers.get(moveId) === controller) {
        this.controllers.delete(moveId);
        this.dropTransientExecutionState(moveId);
      }
    }
    if (rerunAfterCleanup && !controller.signal.aborted) void this.run(moveId);
  }

  private async transferToLocal(job: StorageMoveJob, item: StorageMoveItem, signal: AbortSignal): Promise<void> {
    const uploaded = new Set((await firstValueFromAbortable(
      this.driveService.getStorageMoveUploadedChunks(job.id, item.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS)).uploaded_chunks);
    const chunks = Math.ceil(item.total_bytes / MOVE_CHUNK_SIZE);
    for (let index = 0; index < chunks; index++) {
      this.throwIfAborted(signal);
      const start = index * MOVE_CHUNK_SIZE;
      const end = Math.min(start + MOVE_CHUNK_SIZE, item.total_bytes) - 1;
      if (!uploaded.has(index)) {
        this.stages.set(job.id, 'source_read');
        const chunk = await this.retry(() => this.readRange(job, item, start, end, signal), signal);
        this.stages.set(job.id, 'target_write');
        await this.retry(() => firstValueFromAbortable(
          this.driveService.uploadStorageMoveChunk(job.id, item.id, index, chunk), signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS), signal);
      }
      await this.updateProgress(job.id, item.id, end + 1, signal);
    }
    this.stages.set(job.id, 'target_ack');
    const acknowledged = await firstValueFromAbortable(
      this.driveService.markStorageMoveTargetUploaded(job.id, item.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    this.throwIfAborted(signal);
    this.upsertCanonical(acknowledged);
  }

  private async finishCleanup(moveId: number, signal: AbortSignal): Promise<StorageMoveJob> {
    this.stages.set(moveId, 'cleanup');
    let current = await firstValueFromAbortable(this.driveService.completeStorageMove(moveId), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    this.throwIfAborted(signal);
    this.upsertCanonical(current);
    let delay = 500;

    for (let attempt = 0; attempt < 30 && current.status === 'cleanup_pending'; attempt++) {
      await this.wait(delay, signal);
      current = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.throwIfAborted(signal);
      this.upsertCanonical(current);
      delay = Math.min(delay * 1.5, 2000);
    }

    if (current.status === 'cleanup_pending') this.upsert(current, { stateSyncError: true });
    return current;
  }

  private wait(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async transferToGoogle(job: StorageMoveJob, item: StorageMoveItem, signal: AbortSignal): Promise<void> {
    this.stages.set(job.id, 'target_session');
    const session = await firstValueFromAbortable(this.driveService.createStorageMoveGoogleSession(job.id, item.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    this.throwIfAborted(signal);
    this.sessions.set(item.id, { uri: session.session_uri, token: session.access_token });
    try {
      let externalFileId: string | undefined;
      let start = 0;
      let stalledResponses = 0;
      while (start < item.total_bytes) {
        this.throwIfAborted(signal);
        const end = Math.min(start + MOVE_CHUNK_SIZE, item.total_bytes) - 1;
        this.stages.set(job.id, 'source_read');
        const chunk = await this.retry(() => this.readRange(job, item, start, end, signal), signal);
        this.stages.set(job.id, 'target_write');
        const result = await this.retry(() => this.writeGoogleChunk(item, start, end, chunk, signal), signal);
        if (result.kind === 'ambiguous') {
          if (end === item.total_bytes - 1) {
            externalFileId = await this.reconcileAmbiguousGoogleUpload(job, item, signal);
            this.targetFileIds.set(item.id, externalFileId);
            start = item.total_bytes;
            continue;
          }
          throw new RecoverableStorageMoveError('GOOGLE_INTERMEDIATE_RESULT_AMBIGUOUS');
        }
        const nextOffset = result.kind === 'completed' ? item.total_bytes : result.nextOffset;
        if (nextOffset < start || nextOffset > end + 1 || nextOffset > item.total_bytes) {
          throw new RecoverableStorageMoveError('GOOGLE_UPLOAD_OFFSET_INVALID');
        }
        if (nextOffset === start) {
          stalledResponses++;
          if (stalledResponses > 3) throw new RecoverableStorageMoveError('GOOGLE_UPLOAD_OFFSET_STALLED');
        } else {
          stalledResponses = 0;
        }
        if (result.kind === 'completed') {
          externalFileId = result.externalFileId;
          this.targetFileIds.set(item.id, externalFileId);
        }
        start = nextOffset;
        await this.updateProgress(job.id, item.id, start, signal);
      }
      if (!externalFileId) throw new Error('O Google Drive não confirmou o arquivo enviado.');
      this.stages.set(job.id, 'target_ack');
      const acknowledged = await firstValueFromAbortable(
        this.driveService.markStorageMoveTargetUploaded(job.id, item.id, externalFileId), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.throwIfAborted(signal);
      this.upsertCanonical(acknowledged);
      this.targetFileIds.delete(item.id);
    } finally {
      if (!signal.aborted) this.sessions.delete(item.id);
    }
  }

  private async readRange(job: StorageMoveJob, item: StorageMoveItem, start: number, end: number, signal: AbortSignal): Promise<Blob> {
    if (job.source_provider === 'local') {
      return firstValueFromAbortable(this.driveService.downloadStorageMoveSourceRange(job.id, item.id, start, end), signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS);
    }
    let refreshed = false;
    for (;;) {
      this.stages.set(job.id, 'source_metadata');
      let metadata = this.sourceMetadata.get(item.id);
      try {
        if (!metadata) {
          const response = await firstValueFromAbortable(this.driveService.getStorageMoveSource(job.id, item.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          this.throwIfAborted(signal);
          metadata = { externalFileId: response.external_file_id, accessToken: response.access_token };
          this.sourceMetadata.set(item.id, metadata);
        }
        return await firstValueFromAbortable(this.driveService.downloadExternalFileRange(
          `https://www.googleapis.com/drive/v3/files/${metadata.externalFileId}?alt=media`,
          metadata.accessToken, start, end), signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      } catch (error) {
        if (!signal.aborted) this.sourceMetadata.delete(item.id);
        if (!(error instanceof HttpErrorResponse) || error.status !== 401 || refreshed) throw error;
        refreshed = true;
      }
    }
  }

  private async writeGoogleChunk(item: StorageMoveItem, start: number, end: number, chunk: Blob, signal: AbortSignal): Promise<GoogleChunkResult> {
    const session = this.sessions.get(item.id);
    if (!session) throw new Error('Sessão de upload ausente.');
    try {
      const response = await firstValueFromAbortable(this.http.put<{ id?: string }>(session.uri, chunk, {
        headers: new HttpHeaders({
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${item.total_bytes}`,
        }),
        observe: 'response',
      }), signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      const externalFileId = response.body?.id;
      if (!externalFileId) throw new Error('GOOGLE_UPLOAD_ID_MISSING');
      return { kind: 'completed', externalFileId };
    } catch (error) {
      if (error instanceof NetworkDeadlineError) return { kind: 'ambiguous' };
      if (error instanceof HttpErrorResponse && error.status === 308) {
        const range = error.headers.get('Range');
        const match = range?.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return { kind: 'ambiguous' };
        const rangeStart = Number(match[1]);
        const rangeEnd = Number(match[2]);
        const nextOffset = rangeEnd + 1;
        if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeStart !== 0 || rangeEnd < rangeStart ||
          !Number.isSafeInteger(nextOffset) || nextOffset < start || nextOffset > end + 1 || nextOffset > item.total_bytes) {
          throw new RecoverableStorageMoveError('GOOGLE_UPLOAD_OFFSET_INVALID');
        }
        return { kind: 'incomplete', nextOffset };
      }
      if (error instanceof HttpErrorResponse && error.status === 0) return { kind: 'ambiguous' };
      throw error;
    }
  }

  private async updateProgress(moveId: number, itemId: number, bytes: number, signal: AbortSignal): Promise<void> {
    const job = await firstValueFromAbortable(this.driveService.reportStorageMoveProgress(moveId, itemId, bytes), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    this.throwIfAborted(signal);
    this.upsertCanonical(job);
  }

  private async reconcileAmbiguousGoogleUpload(job: StorageMoveJob, item: StorageMoveItem, signal: AbortSignal): Promise<string> {
    this.validatingMoveIds.add(job.id);
    this.upsert(job);
    try {
      const reconciled = await firstValueFromAbortable(this.driveService.reconcileStorageMove(job.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      this.throwIfAborted(signal);
      this.upsertCanonical(reconciled);
      const reconciledItem = reconciled.items.find(candidate => candidate.id === item.id);
      const externalFileId = reconciledItem?.target_external_file_id;
      if (externalFileId && (reconciledItem.status === 'target_uploaded' || reconciledItem.status === 'completed')) {
        return externalFileId;
      }
      throw new RecoverableStorageMoveError('GOOGLE_UPLOAD_NOT_CONFIRMED');
    } finally {
      if (!signal.aborted) {
        this.validatingMoveIds.delete(job.id);
        const current = this.jobsSignal().find(candidate => candidate.id === job.id);
        if (current) this.upsert(current);
      }
    }
  }

  private async persistFailureState(
    moveId: number,
    current: StorageMoveView,
    errorCode: string,
    stage: NonNullable<StorageMoveView['failure_stage']>,
    retryable: boolean,
    targets: readonly { item_id: number; target_external_file_id: string }[],
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const failureJob = await this.retry(
        () => firstValueFromAbortable(this.driveService.reportStorageMoveFailure(moveId, errorCode, stage, retryable, targets), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS),
        signal,
      );
      this.throwIfAborted(signal);
      this.upsertCanonical(failureJob);
      if (!retryable) this.dropTargetFileIds(moveId);
      return false;
    } catch (failureError) {
      if (signal.aborted) return false;
      try {
        const canonical = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        this.throwIfAborted(signal);
        if (canonical.status === 'target_uploaded' || canonical.status === 'cleanup_pending') {
          this.upsertCanonical(canonical);
          return true;
        }
        if (['prepared', 'transferring', 'committing'].includes(canonical.status)) {
          this.upsert(canonical, { stateSyncError: true });
        } else {
          this.upsertCanonical(canonical);
        }
        return false;
      } catch (stateError) {
        if (signal.aborted) return false;
        this.upsert(current, { stateSyncError: true });
        return false;
      }
    }
  }

  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.throwIfAborted(signal);
      try { return await operation(); }
      catch (error) {
        if (error instanceof RecoverableStorageMoveError) throw error;
        const retryable = error instanceof NetworkDeadlineError ||
          (error instanceof HttpErrorResponse && this.isRetryableHttpStatus(error.status));
        if (!retryable || attempt >= 3 || signal.aborted) throw error;
        const retryAfter = error instanceof HttpErrorResponse ? error.headers.get('Retry-After') : null;
        const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
        const retryAfterDate = retryAfter && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfter) : NaN;
        const retryAfterDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.min(60_000, retryAfterSeconds * 1000)
          : Number.isFinite(retryAfterDate) ? Math.min(60_000, Math.max(0, retryAfterDate - Date.now())) : undefined;
        const delay = retryAfterDelay ?? Math.min(60_000, 250 * 2 ** attempt + Math.floor(Math.random() * 100));
        attempt++;
        await this.wait(delay, signal);
      }
    }
  }

  private isRetryableHttpStatus(status: number): boolean {
    return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }

  private isRetryableFailure(error: unknown): boolean {
    return error instanceof RecoverableStorageMoveError ||
      error instanceof NetworkDeadlineError ||
      (error instanceof HttpErrorResponse && this.isRetryableHttpStatus(error.status));
  }

  private upsert(job: StorageMoveJob, flags: Pick<StorageMoveView, 'validationPending' | 'stateSyncError'> = {}): void {
    const now = performance.now();
    const previous = this.startedAt.get(job.id) ?? { time: now, bytes: job.transferred_bytes };
    const seconds = Math.max((now - previous.time) / 1000, .001);
    const speed = Math.max(0, (job.transferred_bytes - previous.bytes) / seconds);
    this.startedAt.set(job.id, { time: now, bytes: job.transferred_bytes });
    const labels = this.labels.get(job.id) ?? { source: job.source_provider === 'local' ? 'Local' : 'Google Drive', target: job.target_provider === 'local' ? 'Local' : 'Google Drive' };
    const existing = this.jobsSignal().find(item => item.id === job.id);
    const stateSyncError = flags.stateSyncError ?? existing?.stateSyncError ?? false;
    const view: StorageMoveView = {
      ...job,
      fileName: this.names.get(job.id) ?? `Arquivo ${job.file_id}`,
      sourceLabel: labels.source,
      targetLabel: labels.target,
      speedBytesPerSecond: stateSyncError ? 0 : speed,
      etaSeconds: stateSyncError ? null : speed > 0 ? Math.ceil((job.total_bytes - job.transferred_bytes) / speed) : null,
      validationPending: flags.validationPending ?? this.validatingMoveIds.has(job.id),
      stateSyncError,
    };
    this.jobsSignal.update(jobs => jobs.some(item => item.id === job.id)
      ? jobs.map(item => item.id === job.id ? view : item)
      : [...jobs, view]);
  }

  private upsertCanonical(job: StorageMoveJob, flags: Pick<StorageMoveView, 'validationPending'> = {}): void {
    this.upsert(job, { ...flags, stateSyncError: false });
  }

  private forgetMissingCanonicalMove(moveId: number): void {
    this.dropTargetFileIds(moveId);
    this.dropTransientExecutionState(moveId);
    this.names.delete(moveId);
    this.labels.delete(moveId);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  private dropSessions(moveId: number): void {
    for (const item of this.jobsSignal().find(job => job.id === moveId)?.items ?? []) this.sessions.delete(item.id);
  }

  private dropTargetFileIds(moveId: number): void {
    for (const item of this.jobsSignal().find(job => job.id === moveId)?.items ?? []) this.targetFileIds.delete(item.id);
  }

  private dropTransientExecutionState(moveId: number): void {
    this.dropSessions(moveId);
    for (const item of this.jobsSignal().find(job => job.id === moveId)?.items ?? []) this.sourceMetadata.delete(item.id);
    this.startedAt.delete(moveId);
    this.stages.delete(moveId);
    this.validatingMoveIds.delete(moveId);
  }

  private failureCode(stage: NonNullable<StorageMoveView['failure_stage']>, targetProvider: StorageMoveJob['target_provider']): string {
    if (stage === 'source_read' || stage === 'source_metadata') return 'SOURCE_READ_FAILED';
    if (stage === 'target_session') return 'GOOGLE_TARGET_SESSION_FAILED';
    if (stage === 'target_write') return targetProvider === 'local' ? 'LOCAL_TARGET_WRITE_FAILED' : 'GOOGLE_TARGET_WRITE_FAILED';
    if (stage === 'target_ack') return targetProvider === 'local' ? 'LOCAL_TARGET_WRITE_FAILED' : 'GOOGLE_TARGET_ACK_FAILED';
    return 'STORAGE_MOVE_NETWORK_FAILED';
  }
}
