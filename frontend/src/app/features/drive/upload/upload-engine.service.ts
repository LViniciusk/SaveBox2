import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import { DRIVE_TRANSFER_CHUNK_SIZE, DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';
import {
  GoogleUploadPlan,
  GoogleUploadSession,
  LocalUploadPlan,
  UploadPlan,
  UploadEngineCallbacks,
  UploadExecutionControl,
  UploadExecutionResult,
  UploadPauseError,
  throwIfUploadCancelled,
} from './upload.models';
import { firstValueFromAbortable, isUploadAbortError, NetworkDeadlineError } from './abortable-observable';
import { frameUploadChunks } from './upload-stream-framer';

type CryptoScheduler = <T>(operation: () => Promise<T>) => Promise<T>;

@Injectable({ providedIn: 'root' })
export class UploadEngineService {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly http = inject(HttpClient);

  async planUpload(file: File, signal?: AbortSignal): Promise<UploadPlan> {
    const fdk = new Uint8Array(32);
    try {
      throwIfUploadCancelled(signal);
      const encryptedName = await this.cryptoService.encryptName(file.name);
      throwIfUploadCancelled(signal);
      const nameHash = await this.cryptoService.hashName(file.name);
      throwIfUploadCancelled(signal);
      crypto.getRandomValues(fdk);
      const encryptedFdk = await this.cryptoService.encryptName(
        btoa(String.fromCharCode(...fdk))
      );
      throwIfUploadCancelled(signal);

      const thumbnail = await generateThumbnail(file, signal);
      throwIfUploadCancelled(signal);
      const metadata = this.uploadMetadata(thumbnail);
      const encryptedSize = this.kasumi.calculateEncryptedSize(file.size, metadata);
      return {
        file,
        encryptedName,
        nameHash,
        encryptedFdk,
        fdk,
        totalChunks: Math.ceil(encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE),
        encryptedSize,
        thumbnail: thumbnail ?? undefined,
      };
    } catch (error) {
      fdk.fill(0);
      throw error;
    }
  }

  createLocalUploadPlan(
    plan: UploadPlan,
    baseNonce = this.kasumi.generateBaseNonce(),
    rematerializationMetadata?: string,
  ): LocalUploadPlan {
    return { ...plan, baseNonce, rematerializationMetadata };
  }

  createGoogleUploadPlan(
    plan: UploadPlan,
    baseNonce = this.kasumi.generateBaseNonce(),
    rematerializationMetadata?: string,
  ): GoogleUploadPlan {
    return { ...plan, baseNonce, rematerializationMetadata };
  }

  discardUploadPlan(plan: UploadPlan): void {
    plan.fdk.fill(0);
  }

  private uploadMetadata(thumbnail?: string | null): string | undefined {
    return thumbnail ? JSON.stringify({ thumb: thumbnail }) : undefined;
  }

  async executeLocal(
    plan: LocalUploadPlan,
    fileId: number,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks,
    scheduleCrypto: CryptoScheduler = operation => operation(),
  ): Promise<UploadExecutionResult> {
    try {
      return await this.uploadLocal(plan, fileId, control, callbacks, scheduleCrypto);
    } catch (error) {
      if (error instanceof UploadPauseError) return { paused: true };
      if (isUploadAbortError(error) || control.shouldCancel()) {
        plan.fdk.fill(0);
        return { paused: false, cancelled: true };
      }
      throw error;
    }
  }

  async executeGoogle(
    plan: GoogleUploadPlan,
    fileId: number,
    session: GoogleUploadSession | undefined,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks,
    scheduleCrypto: CryptoScheduler = operation => operation(),
  ): Promise<UploadExecutionResult> {
    try {
      const result = await this.uploadGoogleResumable(plan, fileId, session, control, callbacks, scheduleCrypto);
      return result;
    } catch (error) {
      if (isUploadAbortError(error) || control.shouldCancel()) {
        return this.cancelled(plan);
      }
      throw error;
    }
  }

  private async uploadLocal(
    plan: LocalUploadPlan,
    fileId: number,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks,
    scheduleCrypto: CryptoScheduler,
  ): Promise<UploadExecutionResult> {
    const expectedTotalChunks = Math.ceil(plan.encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE);
    if (expectedTotalChunks !== plan.totalChunks) {
      throw new Error('Encrypted upload geometry mismatch');
    }

    let uploadedChunks = new Set<number>();
    try {
      const res = await firstValueFromAbortable(this.driveService.getUploadedChunks(fileId), control.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      uploadedChunks = new Set(res.uploaded_chunks);
    } catch (error) {
      // Fallback: retry every chunk when the progress endpoint is unavailable.
      if (isUploadAbortError(error)) throw error;
    }
    if ([...uploadedChunks].some(index =>
      !Number.isInteger(index) || index < 0 || index >= plan.totalChunks
    )) {
      throw new Error('Encrypted upload geometry mismatch');
    }

    const frames = frameUploadChunks(
      this.kasumi.encryptFileParts(
        plan.file,
        plan.fdk,
        plan.baseNonce,
        plan.rematerializationMetadata ?? this.uploadMetadata(plan.thumbnail),
        control.signal,
      ),
      plan.encryptedSize,
    );
    const iterator = frames[Symbol.asyncIterator]();
    let expectedIndex = 0;
    try {
      while (expectedIndex < plan.totalChunks) {
        if (control.shouldCancel()) return this.cancelled(plan);
        if (control.shouldPause()) return { paused: true };

        const step = await scheduleCrypto(() => iterator.next());
        if (step.done) throw new Error('Encrypted upload geometry mismatch');
        const frame = step.value;
        const expectedSize = Math.min(
          DRIVE_TRANSFER_CHUNK_SIZE,
          plan.encryptedSize - expectedIndex * DRIVE_TRANSFER_CHUNK_SIZE,
        );
        if (frame.index !== expectedIndex || expectedSize <= 0 || frame.blob.size !== expectedSize) {
          throw new Error('Encrypted upload geometry mismatch');
        }
        if (control.shouldCancel()) return this.cancelled(plan);
        if (control.shouldPause()) return { paused: true };

        if (!uploadedChunks.has(frame.index)) {
          await firstValueFromAbortable(
            this.driveService.uploadChunk(fileId, frame.index, frame.blob),
            control.signal,
            DRIVE_CHUNK_REQUEST_DEADLINE_MS,
          );
        }

        if (control.shouldCancel()) return this.cancelled(plan);
        const progress = Math.round(((frame.index + 1) / plan.totalChunks) * 100);
        const transferredBytes = Math.min(
          (frame.index + 1) * DRIVE_TRANSFER_CHUNK_SIZE,
          plan.encryptedSize,
        );
        callbacks.onProgress({ progress, transferredBytes, totalBytes: plan.encryptedSize });
        expectedIndex++;
      }

      if (control.shouldCancel()) return this.cancelled(plan);
      return { paused: false };
    } finally {
      try {
        await iterator.return?.(undefined);
      } catch {
        // Preserve the original upload result/error.
      }
    }
  }

  private cancelled(plan: UploadPlan, options?: { googleCleanupPending?: boolean }): UploadExecutionResult {
    plan.fdk.fill(0);
    return {
      paused: false,
      cancelled: true,
      ...(options?.googleCleanupPending ? { googleCleanupPending: true } : {}),
    };
  }

  private async uploadGoogleResumable(
    plan: GoogleUploadPlan,
    fileId: number,
    session: GoogleUploadSession | undefined,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks,
    scheduleCrypto: CryptoScheduler,
  ): Promise<UploadExecutionResult> {
    const expectedTotalChunks = Math.ceil(plan.encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE);
    if (expectedTotalChunks !== plan.totalChunks || plan.encryptedSize <= 0) {
      throw new Error('Encrypted upload geometry mismatch');
    }
    if (control.shouldCancel()) return this.cancelled(plan);
    if (control.shouldPause()) return { paused: true, googleSession: session };

    let activeSession = session;
    let confirmedOffset = 0;
    let sessionReplacementUsed = false;
    let noAdvanceCount = 0;

    if (activeSession) {
      const status = await this.queryGoogleSession(activeSession, plan.encryptedSize, control.signal);
      if (status.kind === 'completed') return this.finalizeGoogle(fileId, status.externalFileId);
      if (status.kind === 'restart') {
        activeSession = undefined;
        sessionReplacementUsed = true;
      }
      else {
        const nextConfirmedOffset = status.confirmedOffset;
        if (nextConfirmedOffset >= plan.encryptedSize) {
          throw new Error('Google resumable upload completed without external ID');
        }
        confirmedOffset = nextConfirmedOffset;
        if (confirmedOffset > 0) {
          callbacks.onProgress({
            progress: Math.round((confirmedOffset / plan.encryptedSize) * 100),
            transferredBytes: confirmedOffset,
            totalBytes: plan.encryptedSize,
          });
        }
      }
    }

    while (true) {
      if (control.shouldCancel()) return this.cancelled(plan);
      if (control.shouldPause()) return { paused: true, googleSession: activeSession };

      if (!activeSession) {
        const response = await firstValueFromAbortable(
          this.driveService.createExternalUploadSession(fileId),
          control.signal,
          DRIVE_CONTROL_REQUEST_DEADLINE_MS,
        );
        if (response.status === 'completed') {
          return this.finalizeGoogle(fileId, response.external_file_id);
        }
        if (!response.session_uri || !response.access_token) throw new Error('Google session response invalid');
        activeSession = {
          session_uri: response.session_uri,
          access_token: response.access_token,
        };
        confirmedOffset = 0;
      }

      if (confirmedOffset >= plan.encryptedSize) {
        throw new Error('Google resumable upload completed without external ID');
      }
      if (control.shouldPause()) return { paused: true, googleSession: activeSession };

      const iterator = frameUploadChunks(
        skipUploadPrefix(
          this.kasumi.encryptFileParts(
            plan.file,
            plan.fdk,
            plan.baseNonce,
            plan.rematerializationMetadata ?? this.uploadMetadata(plan.thumbnail),
            control.signal,
          ),
          confirmedOffset,
        ),
        plan.encryptedSize - confirmedOffset,
      )[Symbol.asyncIterator]();
      const iteratorStartOffset = confirmedOffset;
      let bytesPublishedByIterator = 0;
      let restartStream = false;

      try {
        while (true) {
          if (control.shouldCancel()) return this.cancelled(plan);
          if (control.shouldPause()) return { paused: true, googleSession: activeSession };

          const step = await scheduleCrypto(() => iterator.next());
          if (step.done) {
            if (confirmedOffset !== plan.encryptedSize) throw new Error('Encrypted upload geometry mismatch');
            throw new Error('Google resumable upload completed without external ID');
          }

          const frame = step.value;
          const start = iteratorStartOffset + bytesPublishedByIterator;
          const expectedSize = Math.min(
            DRIVE_TRANSFER_CHUNK_SIZE,
            plan.encryptedSize - start,
          );
          if (frame.index !== Math.floor(bytesPublishedByIterator / DRIVE_TRANSFER_CHUNK_SIZE)
            || frame.blob.size !== expectedSize || start < 0 || start >= plan.encryptedSize
            || start + frame.blob.size > plan.encryptedSize) {
            throw new Error('Encrypted upload geometry mismatch');
          }
          if (control.shouldCancel()) return this.cancelled(plan);
          if (control.shouldPause()) return { paused: true, googleSession: activeSession };

          const terminalFrame = start + frame.blob.size === plan.encryptedSize;
          let result: GoogleUploadChunkResult;
          try {
            result = await this.putGoogleFrame(
              activeSession,
              frame.blob,
              start,
              plan.encryptedSize,
              control.signal,
            );
          } catch (error) {
            if (terminalFrame && isUploadAbortError(error) && control.shouldCancel()) {
              return this.cancelled(plan, { googleCleanupPending: true });
            }
            throw error;
          }
          if (result.kind === 'restart') {
            if (sessionReplacementUsed) throw new Error('Google resumable session replacement limit reached');
            sessionReplacementUsed = true;
            activeSession = undefined;
            confirmedOffset = 0;
            noAdvanceCount = 0;
            restartStream = true;
            break;
          }
          if (result.kind === 'completed') {
            return this.finalizeGoogle(fileId, result.externalFileId);
          }

          const nextConfirmedOffset = result.confirmedOffset;
          if (nextConfirmedOffset < start || nextConfirmedOffset > plan.encryptedSize) {
            throw new Error('Google resumable offset invalid');
          }
          const frameEnd = start + frame.blob.size;
          if (nextConfirmedOffset > frameEnd) {
            throw new Error('Google resumable offset exceeds sent frame');
          }
          if (nextConfirmedOffset === plan.encryptedSize) {
            throw new Error('Google resumable upload completed without external ID');
          }

          const previousOffset = confirmedOffset;
          confirmedOffset = nextConfirmedOffset;
          if (confirmedOffset > previousOffset) noAdvanceCount = 0;
          else if (++noAdvanceCount >= 3) throw new Error('Google resumable upload made no progress');
          callbacks.onProgress({
            progress: Math.round((confirmedOffset / plan.encryptedSize) * 100),
            transferredBytes: confirmedOffset,
            totalBytes: plan.encryptedSize,
          });

          if (confirmedOffset !== frameEnd) {
            restartStream = true;
            break;
          }
          bytesPublishedByIterator += frame.blob.size;
        }
      } finally {
        try {
          await iterator.return?.(undefined);
        } catch {
          // Preserve the original upload result/error.
        }
      }

      if (!restartStream) throw new Error('Google resumable upload stopped unexpectedly');
    }
  }

  private async finalizeGoogle(
    fileId: number,
    externalFileId: string,
  ): Promise<UploadExecutionResult> {
    if (!externalFileId) throw new Error('Google Drive upload failed: ID missing from response');
    await firstValueFromAbortable(this.driveService.finalizeExternalUpload(fileId, externalFileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    return { paused: false };
  }

  private async putGoogleFrame(
    session: GoogleUploadSession,
    blob: Blob,
    start: number,
    total: number,
    signal?: AbortSignal,
  ): Promise<GoogleUploadChunkResult> {
    const headers = {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${start + blob.size - 1}/${total}`,
    };
    try {
      const response = await firstValueFromAbortable(
        this.http.put<any>(session.session_uri, blob, { headers, observe: 'response' }),
        signal,
        DRIVE_CHUNK_REQUEST_DEADLINE_MS,
      );
      return this.parseGoogleSessionResponse(response.status, response.headers.get('Range'), response.body, total);
    } catch (error) {
      if (error instanceof NetworkDeadlineError) return this.queryGoogleSession(session, total, signal);
      if (!(error instanceof HttpErrorResponse)) throw error;
      if (error.status === 308) return this.parseGoogleSessionResponse(308, error.headers.get('Range'), error.error, total);
      if (error.status >= 400 && error.status < 500) return { kind: 'restart' };
      if (error.status === 0 || error.status >= 500) {
        return this.queryGoogleSession(session, total, signal);
      }
      throw error;
    }
  }

  private async queryGoogleSession(
    session: GoogleUploadSession,
    total: number,
    signal?: AbortSignal,
  ): Promise<GoogleUploadChunkResult> {
    const headers = {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Range': `bytes */${total}`,
    };
    try {
      const response = await firstValueFromAbortable(
        this.http.put<any>(session.session_uri, null, { headers, observe: 'response' }),
        signal,
        DRIVE_CONTROL_REQUEST_DEADLINE_MS,
      );
      return this.parseGoogleSessionResponse(response.status, response.headers.get('Range'), response.body, total);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse)) throw error;
      if (error.status === 308) return this.parseGoogleSessionResponse(308, error.headers.get('Range'), error.error, total);
      if (error.status >= 400 && error.status < 500) return { kind: 'restart' };
      throw error;
    }
  }

  private parseGoogleSessionResponse(
    status: number,
    range: string | null,
    body: unknown,
    total: number,
  ): GoogleUploadChunkResult {
    if (status === 308) {
      if (!range) return { kind: 'incomplete', confirmedOffset: 0 };
      const match = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
      if (!match) throw new Error('Google resumable Range inválido');
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== 0 || end < 0 || end >= total) {
        throw new Error('Google resumable Range inválido');
      }
      return { kind: 'incomplete', confirmedOffset: end + 1 };
    }
    if (status === 200 || status === 201) {
      const externalFileId = typeof body === 'object' && body !== null && 'id' in body
        ? (body as { id?: unknown }).id
        : undefined;
      if (typeof externalFileId !== 'string' || !externalFileId) {
        throw new Error('Google Drive upload failed: ID missing from response');
      }
      return { kind: 'completed', externalFileId };
    }
    throw new Error(`Google resumable upload failed with status ${status}`);
  }
}

type GoogleUploadChunkResult =
  | { kind: 'incomplete'; confirmedOffset: number }
  | { kind: 'completed'; externalFileId: string }
  | { kind: 'restart' };

async function* skipUploadPrefix(parts: AsyncIterable<Blob>, bytesToSkip: number): AsyncGenerator<Blob> {
  if (!Number.isSafeInteger(bytesToSkip) || bytesToSkip < 0) throw new Error('Invalid upload stream offset');
  let remaining = bytesToSkip;
  for await (const part of parts) {
    if (!(part instanceof Blob)) throw new Error('Encrypted stream must contain Blob parts');
    if (remaining === 0) {
      yield part;
      continue;
    }
    if (part.size <= remaining) {
      remaining -= part.size;
      continue;
    }
    yield part.slice(remaining);
    remaining = 0;
  }
  if (remaining !== 0) throw new Error('Encrypted stream offset exceeds stream size');
}

const THUMBNAIL_MAX_DIMENSION = 1280;

export async function generateThumbnail(file: File, signal?: AbortSignal): Promise<string | null> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return null;

  if (file.type.startsWith('image/')) {
    return generateImageThumbnail(file, signal);
  }

  return generateVideoThumbnail(file, signal);
}

async function generateImageThumbnail(file: File, signal?: AbortSignal): Promise<string | null> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      try {
        return renderThumbnail(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to the HTMLImageElement path for browsers with limited bitmap support.
    }
  }

  return loadImageElementThumbnail(file, signal);
}

function loadImageElementThumbnail(file: File, signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const image = document.createElement('img');
    const finish = (value: string | null) => {
      URL.revokeObjectURL(url);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return finish(null);
    image.onload = () => finish(renderThumbnail(image, image.naturalWidth || image.width, image.naturalHeight || image.height));
    image.onerror = () => finish(null);
    image.src = url;
  });
}

function generateVideoThumbnail(file: File, signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return finish(null);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, Math.max(0, video.duration || 0));
      } catch {
        finish(null);
      }
    };
    video.onseeked = () => finish(renderThumbnail(video, video.videoWidth, video.videoHeight));
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function renderThumbnail(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): string | null {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(source, 0, 0, width, height);
  try {
    return canvas.toDataURL('image/webp', 0.5);
  } catch {
    return null;
  }
}
