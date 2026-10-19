import { Injectable } from '@angular/core';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';
import { DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';
import { firstValueFromAbortable, isUploadAbortError } from '../upload/abortable-observable';
import type { DriveFile, TransferItem } from '../state/drive.store';
import { DriveService } from './drive.service';

interface DownloadStateBase {
  file: DriveFile;
  fdk: Uint8Array;
}

export interface GoogleDownloadState extends DownloadStateBase {
  kind: 'google';
  meta: { external_file_id: string; access_token: string };
}

export interface LocalDownloadState extends DownloadStateBase {
  kind: 'local';
  baseNonce: Uint8Array;
  expectedSize: number;
  decryptedBytes: number;
  currentOffset: number;
  chunkIndex: number;
  plaintextChunks: Blob[];
}

export type DownloadState = GoogleDownloadState | LocalDownloadState;

export interface DownloadCallbacks {
  setProgress: (progress: number, bytes: number, total: number) => void;
  updateTransfer: (id: string, changes: Partial<TransferItem>) => void;
  isPaused: (id: string) => boolean;
}

@Injectable({ providedIn: 'root' })
export class DownloadEngineService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeDownloads = new Map<string, DownloadState>();

  constructor(
    private readonly driveService: DriveService,
    private readonly kasumi: KasumiCryptoService,
  ) {}

  begin(id: string): AbortSignal {
    this.cancel(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller.signal;
  }

  setState(id: string, state: DownloadState): boolean {
    const controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted) {
      this.wipeState(state);
      return false;
    }
    this.activeDownloads.set(id, state);
    return true;
  }

  getState(id: string): DownloadState | undefined {
    return this.activeDownloads.get(id);
  }

  deleteState(id: string): void {
    const state = this.activeDownloads.get(id);
    if (state) this.wipeState(state);
    this.activeDownloads.delete(id);
    this.controllers.delete(id);
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    const state = this.activeDownloads.get(id);
    if (state) this.wipeState(state);
    this.activeDownloads.delete(id);
  }

  resetRuntimeState(): void {
    const ids = new Set([...this.controllers.keys(), ...this.activeDownloads.keys()]);
    for (const id of ids) this.cancel(id);
  }

  async run(id: string, state: DownloadState, callbacks: DownloadCallbacks): Promise<void> {
    const controller = this.controllers.get(id);
    if (!controller || !this.isCurrent(id, state, controller)) return;

    try {
      if (state.kind === 'google') {
        await this.runGoogleDrive(id, state, controller, callbacks);
      } else {
        await this.runLocal(id, state, controller, callbacks);
      }
    } catch (error) {
      if (controller.signal.aborted || isUploadAbortError(error)) return;
      throw error;
    }
  }

  private async runGoogleDrive(
    id: string,
    state: GoogleDownloadState,
    controller: AbortController,
    callbacks: DownloadCallbacks,
  ): Promise<void> {
    const { meta, fdk } = state;
    if (callbacks.isPaused(id)) {
      callbacks.updateTransfer(id, { status: 'paused' });
      return;
    }

    const encryptedBlob = await firstValueFromAbortable(
      this.driveService.downloadExternalFile(
        `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`,
        meta.access_token,
      ),
      controller.signal,
    );
    if (!this.canContinue(id, state, controller, callbacks)) return;

    callbacks.setProgress(70, encryptedBlob.size / 2, encryptedBlob.size);
    if (!this.canContinue(id, state, controller, callbacks)) return;

    const decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk, state.file.sizeBytes);
    if (!this.canContinue(id, state, controller, callbacks)) return;

    callbacks.setProgress(95, encryptedBlob.size, encryptedBlob.size);
    if (!this.canContinue(id, state, controller, callbacks)) return;
    this.commitDownload(id, state, controller, callbacks, decryptedBlob);
  }

  private async runLocal(
    id: string,
    state: LocalDownloadState,
    controller: AbortController,
    callbacks: DownloadCallbacks,
  ): Promise<void> {
    const { file, fdk, baseNonce, expectedSize, plaintextChunks } = state;

    while (state.decryptedBytes < expectedSize) {
      if (!this.canContinue(id, state, controller, callbacks)) return;

      const plaintextSize = Math.min(KASUMI_CHUNK_SIZE, expectedSize - state.decryptedBytes);
      const encryptedSize = 16 + plaintextSize;
      const start = state.currentOffset;
      const end = start + encryptedSize - 1;
      callbacks.setProgress(Math.round((state.decryptedBytes / expectedSize) * 100), state.decryptedBytes, expectedSize);
      if (!this.isCurrent(id, state, controller)) return;

      const chunkBlob = await firstValueFromAbortable(
        this.driveService.downloadFileRange(file.id, start, end),
        controller.signal,
        DRIVE_CHUNK_REQUEST_DEADLINE_MS,
      );
      if (!this.canContinue(id, state, controller, callbacks)) return;

      const chunkUint8 = new Uint8Array(await chunkBlob.arrayBuffer());
      if (!this.isCurrent(id, state, controller)) return;
      if (chunkUint8.length < encryptedSize) throw new Error('File corrupted or truncated');

      const plaintext = await this.kasumi.decryptFileChunk(
        chunkUint8.slice(16),
        chunkUint8.slice(0, 16),
        baseNonce,
        state.chunkIndex,
        fdk,
      );
      if (!this.canContinue(id, state, controller, callbacks)) return;

      plaintextChunks.push(new Blob([plaintext as any]));
      state.decryptedBytes += plaintextSize;
      state.currentOffset += encryptedSize;
      state.chunkIndex++;
    }

    this.completeLocalDownload(id, state, controller, callbacks);
  }

  private completeLocalDownload(
    id: string,
    state: LocalDownloadState,
    controller: AbortController,
    callbacks: DownloadCallbacks,
  ): void {
    if (!this.isCurrent(id, state, controller)) return;
    const decryptedBlob = new Blob(state.plaintextChunks, { type: 'application/octet-stream' });
    callbacks.setProgress(95, state.expectedSize, state.expectedSize);
    if (!this.canContinue(id, state, controller, callbacks)) return;
    this.commitDownload(id, state, controller, callbacks, decryptedBlob);
  }

  private canContinue(
    id: string,
    state: DownloadState,
    controller: AbortController,
    callbacks: DownloadCallbacks,
  ): boolean {
    if (!this.isCurrent(id, state, controller)) return false;
    if (!callbacks.isPaused(id)) return true;
    callbacks.updateTransfer(id, { status: 'paused' });
    return false;
  }

  private commitDownload(
    id: string,
    state: DownloadState,
    controller: AbortController,
    callbacks: DownloadCallbacks,
    decryptedBlob: Blob,
  ): void {
    this.triggerDownload(decryptedBlob, state.file.decryptedName || 'arquivo_desconhecido');
    if (!this.isCurrent(id, state, controller)) return;
    callbacks.updateTransfer(id, { status: 'success', progress: 100, statusMessage: 'Concluído!' });
    if (!this.isCurrent(id, state, controller)) return;
    this.deleteState(id);
  }

  private isCurrent(id: string, state: DownloadState, controller: AbortController): boolean {
    return !controller.signal.aborted
      && this.controllers.get(id) === controller
      && this.activeDownloads.get(id) === state;
  }

  private wipeState(state: DownloadState): void {
    state.fdk.fill(0);
    if (state.kind === 'local') {
      state.baseNonce.fill(0);
      state.plaintextChunks.length = 0;
    }
  }

  private triggerDownload(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
