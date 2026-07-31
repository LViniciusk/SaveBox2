import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DriveService } from '../services/drive.service';
import { firstValueFromAbortable } from '../upload/abortable-observable';
import type { DriveFile } from '../state/drive.store';
import { StorageTarget } from '../state/drive.types';
import { StorageMoveItem, StorageMoveJob, StorageMoveView } from './storage-move.models';

const MOVE_CHUNK_SIZE = 4 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class StorageMoveEngineService {
  private readonly driveService = inject(DriveService);
  private readonly http = inject(HttpClient);
  private readonly controllers = new Map<number, AbortController>();
  private readonly sessions = new Map<number, { uri: string; token: string }>();
  private readonly targetFileIds = new Map<number, string>();
  private readonly names = new Map<number, string>();
  private readonly labels = new Map<number, { source: string; target: string }>();
  private readonly startedAt = new Map<number, { time: number; bytes: number }>();
  private readonly jobsSignal = signal<StorageMoveView[]>([]);

  readonly jobs = this.jobsSignal.asReadonly();
  readonly activeFileIds = computed(() => new Set(this.jobsSignal()
    .filter(job => !['completed', 'cancelled', 'failed'].includes(job.status))
    .map(job => job.file_id)));

  async start(file: DriveFile, target: StorageTarget): Promise<StorageMoveJob> {
    const job = await firstValueFrom(this.driveService.startStorageMove(file.id, target));
    this.names.set(job.id, file.decryptedName ?? file.encryptedName);
    this.labels.set(job.id, {
      source: file.storageProvider === 'local' ? 'Local' : `Google ${file.externalStorageId ?? ''}`.trim(),
      target: target.label,
    });
    this.upsert(job);
    void this.run(job.id);
    return job;
  }

  async loadActive(targets: readonly StorageTarget[], files: readonly DriveFile[]): Promise<void> {
    const response = await firstValueFrom(this.driveService.getActiveStorageMoves());
    for (const job of response.moves) {
      const file = files.find(item => item.id === job.file_id);
      const source = job.source_provider === 'local'
        ? 'Local'
        : targets.find(item => item.externalStorageId === job.source_external_storage_id)?.label ?? 'Google Drive';
      const target = job.target_provider === 'local'
        ? 'Local'
        : targets.find(item => item.externalStorageId === job.target_external_storage_id)?.label ?? 'Google Drive';
      this.names.set(job.id, file?.decryptedName ?? file?.encryptedName ?? `Arquivo ${job.file_id}`);
      this.labels.set(job.id, { source, target });
      this.upsert(job);
      if (['prepared', 'transferring', 'target_uploaded'].includes(job.status)) void this.run(job.id);
    }
  }

  async pause(moveId: number): Promise<void> {
    this.controllers.get(moveId)?.abort();
    this.dropSessions(moveId);
    this.upsert(await firstValueFrom(this.driveService.pauseStorageMove(moveId)));
  }

  async resume(moveId: number): Promise<void> {
    this.upsert(await firstValueFrom(this.driveService.resumeStorageMove(moveId)));
    void this.run(moveId);
  }

  async cancel(moveId: number): Promise<void> {
    this.controllers.get(moveId)?.abort();
    this.dropSessions(moveId);
    this.upsert(await firstValueFrom(this.driveService.cancelStorageMove(moveId)));
  }

  clear(moveId: number): void {
    const job = this.jobsSignal().find(item => item.id === moveId);
    if (job && ['completed', 'cancelled', 'failed'].includes(job.status)) {
      this.jobsSignal.update(items => items.filter(item => item.id !== moveId));
    }
  }

  private async run(moveId: number): Promise<void> {
    if (this.controllers.has(moveId)) return;
    const controller = new AbortController();
    this.controllers.set(moveId, controller);
    try {
      let job = await firstValueFromAbortable(this.driveService.getStorageMove(moveId), controller.signal);
      if (job.status === 'prepared') job = await firstValueFromAbortable(this.driveService.resumeStorageMove(moveId), controller.signal);
      this.upsert(job);
      for (const item of job.items) {
        if (item.status === 'target_uploaded' || item.status === 'completed') continue;
        if (job.target_provider === 'local') await this.transferToLocal(job, item, controller.signal);
        else await this.transferToGoogle(job, item, controller.signal);
      }
      const latest = this.jobsSignal().find(item => item.id === moveId);
      const externalIds = latest?.items.flatMap(item => (this.targetFileIds.get(item.id) ?? item.target_external_file_id)
        ? [{ item_id: item.id, target_external_file_id: this.targetFileIds.get(item.id) ?? item.target_external_file_id! }]
        : []) ?? [];
      this.upsert(await firstValueFromAbortable(this.driveService.completeStorageMove(moveId, externalIds), controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) {
        const current = this.jobsSignal().find(job => job.id === moveId);
        if (current) this.jobsSignal.update(jobs => jobs.map(job => job.id === moveId
          ? { ...job, status: 'failed', error_detail: this.errorMessage(error) }
          : job));
      }
    } finally {
      if (this.controllers.get(moveId) === controller) this.controllers.delete(moveId);
    }
  }

  private async transferToLocal(job: StorageMoveJob, item: StorageMoveItem, signal: AbortSignal): Promise<void> {
    const uploaded = new Set((await firstValueFromAbortable(
      this.driveService.getStorageMoveUploadedChunks(job.id, item.id), signal)).uploaded_chunks);
    const chunks = Math.ceil(item.total_bytes / MOVE_CHUNK_SIZE);
    for (let index = 0; index < chunks; index++) {
      this.throwIfAborted(signal);
      const start = index * MOVE_CHUNK_SIZE;
      const end = Math.min(start + MOVE_CHUNK_SIZE, item.total_bytes) - 1;
      if (!uploaded.has(index)) {
        const chunk = await this.retry(() => this.readRange(job, item, start, end, signal), signal);
        await this.retry(() => firstValueFromAbortable(
          this.driveService.uploadStorageMoveChunk(job.id, item.id, index, chunk), signal), signal);
      }
      await this.updateProgress(job.id, item.id, end + 1, signal);
    }
  }

  private async transferToGoogle(job: StorageMoveJob, item: StorageMoveItem, signal: AbortSignal): Promise<void> {
    const session = await firstValueFromAbortable(this.driveService.createStorageMoveGoogleSession(job.id, item.id), signal);
    this.sessions.set(item.id, { uri: session.session_uri, token: session.access_token });
    let externalFileId: string | undefined;
    for (let start = 0; start < item.total_bytes; start += MOVE_CHUNK_SIZE) {
      this.throwIfAborted(signal);
      const end = Math.min(start + MOVE_CHUNK_SIZE, item.total_bytes) - 1;
      const chunk = await this.retry(() => this.readRange(job, item, start, end, signal), signal);
      externalFileId = await this.retry(
        () => this.writeGoogleChunk(item, start, end, chunk, signal), signal) ?? externalFileId;
      await this.updateProgress(job.id, item.id, end + 1, signal);
    }
    if (!externalFileId) throw new Error('O Google Drive não confirmou o arquivo enviado.');
    this.targetFileIds.set(item.id, externalFileId);
    this.jobsSignal.update(jobs => jobs.map(current => current.id !== job.id ? current : {
      ...current,
      items: current.items.map(currentItem => currentItem.id === item.id
        ? { ...currentItem, target_external_file_id: externalFileId, transferred_bytes: item.total_bytes }
        : currentItem),
    }));
  }

  private async readRange(job: StorageMoveJob, item: StorageMoveItem, start: number, end: number, signal: AbortSignal): Promise<Blob> {
    if (job.source_provider === 'local') {
      return firstValueFromAbortable(this.driveService.downloadStorageMoveSourceRange(job.id, item.id, start, end), signal);
    }
    const metadata = await firstValueFromAbortable(this.driveService.getStorageMoveSource(job.id, item.id), signal);
    return firstValueFromAbortable(this.driveService.downloadExternalFileRange(
      `https://www.googleapis.com/drive/v3/files/${metadata.external_file_id}?alt=media`,
      metadata.access_token, start, end), signal);
  }

  private async writeGoogleChunk(item: StorageMoveItem, start: number, end: number, chunk: Blob, signal: AbortSignal): Promise<string | undefined> {
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
      }), signal);
      return response.body?.id;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 308) return undefined;
      throw error;
    }
  }

  private async updateProgress(moveId: number, itemId: number, bytes: number, signal: AbortSignal): Promise<void> {
    const job = await firstValueFromAbortable(this.driveService.reportStorageMoveProgress(moveId, itemId, bytes), signal);
    this.upsert(job);
  }

  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.throwIfAborted(signal);
      try { return await operation(); }
      catch (error) {
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        if ([400, 401, 403].includes(status) || attempt >= 3 || signal.aborted) throw error;
        const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
        attempt++;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
      }
    }
  }

  private upsert(job: StorageMoveJob): void {
    const now = performance.now();
    const previous = this.startedAt.get(job.id) ?? { time: now, bytes: job.transferred_bytes };
    const seconds = Math.max((now - previous.time) / 1000, .001);
    const speed = Math.max(0, (job.transferred_bytes - previous.bytes) / seconds);
    this.startedAt.set(job.id, { time: now, bytes: job.transferred_bytes });
    const labels = this.labels.get(job.id) ?? { source: job.source_provider === 'local' ? 'Local' : 'Google Drive', target: job.target_provider === 'local' ? 'Local' : 'Google Drive' };
    const view: StorageMoveView = {
      ...job,
      fileName: this.names.get(job.id) ?? `Arquivo ${job.file_id}`,
      sourceLabel: labels.source,
      targetLabel: labels.target,
      speedBytesPerSecond: speed,
      etaSeconds: speed > 0 ? Math.ceil((job.total_bytes - job.transferred_bytes) / speed) : null,
    };
    this.jobsSignal.update(jobs => jobs.some(item => item.id === job.id)
      ? jobs.map(item => item.id === job.id ? view : item)
      : [...jobs, view]);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  private dropSessions(moveId: number): void {
    for (const item of this.jobsSignal().find(job => job.id === moveId)?.items ?? []) this.sessions.delete(item.id);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) return error.error?.error ?? error.message;
    return error instanceof Error ? error.message : 'Falha na transferência.';
  }
}
