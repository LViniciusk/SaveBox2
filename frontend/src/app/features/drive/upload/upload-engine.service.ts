import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import {
  PreparedUpload,
  UploadEngineCallbacks,
  UploadExecutionControl,
  UploadExecutionResult,
  UploadProvider,
  UploadAbortError,
  throwIfUploadCancelled,
} from './upload.models';
import { firstValueFromAbortable, isUploadAbortError } from './abortable-observable';

const CHUNK_SIZE = 4 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class UploadEngineService {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly http = inject(HttpClient);

  async prepareUpload(file: File, signal?: AbortSignal): Promise<PreparedUpload> {
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

      let metadata: string | undefined;
      const thumbnail = await generateThumbnail(file, signal);
      throwIfUploadCancelled(signal);
      if (thumbnail) metadata = JSON.stringify({ thumb: thumbnail });

      const encryptedBlob = await this.kasumi.encryptFile(file, fdk, undefined, metadata);
      throwIfUploadCancelled(signal);
      return {
        file,
        encryptedBlob,
        encryptedName,
        nameHash,
        encryptedFdk,
        fdk,
        totalChunks: Math.ceil(encryptedBlob.size / CHUNK_SIZE),
        encryptedSize: encryptedBlob.size,
        thumbnail: thumbnail ?? undefined,
      };
    } catch (error) {
      if (signal?.aborted) fdk.fill(0);
      throw error;
    }
  }

  async execute(
    prepared: PreparedUpload,
    fileId: number,
    provider: UploadProvider,
    initRes: any,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks
  ): Promise<UploadExecutionResult> {
    try {
      if (provider === 'google_drive') {
        return await this.uploadGoogleDrive(prepared, fileId, initRes, control, callbacks);
      }
      return await this.uploadLocal(prepared, fileId, control, callbacks);
    } catch (error) {
      if (isUploadAbortError(error) || control.shouldCancel()) {
        prepared.fdk.fill(0);
        return { paused: false, cancelled: true };
      }
      throw error;
    }
  }

  private async uploadLocal(
    prepared: PreparedUpload,
    fileId: number,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks
  ): Promise<UploadExecutionResult> {
    let uploadedChunks = new Set<number>();
    try {
      const res = await firstValueFromAbortable(this.driveService.getUploadedChunks(fileId), control.signal);
      uploadedChunks = new Set(res.uploaded_chunks);
    } catch (error) {
      // Fallback: retry every chunk when the progress endpoint is unavailable.
      if (isUploadAbortError(error)) throw error;
    }

    for (let i = 0; i < prepared.totalChunks; i++) {
      if (control.shouldCancel()) return { paused: false, cancelled: true };
      if (control.shouldPause()) return { paused: true };

      if (!uploadedChunks.has(i)) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, prepared.encryptedBlob.size);
        await firstValueFromAbortable(this.driveService.uploadChunk(fileId, i, prepared.encryptedBlob.slice(start, end)), control.signal);
      }

      if (control.shouldCancel()) return { paused: false, cancelled: true };

      const progress = Math.round(((i + 1) / prepared.totalChunks) * 100);
      const transferredBytes = Math.min((i + 1) * CHUNK_SIZE, prepared.encryptedBlob.size);
      callbacks.onProgress({ progress, transferredBytes, totalBytes: prepared.encryptedBlob.size });
    }

    return { paused: false };
  }

  private async uploadGoogleDrive(
    prepared: PreparedUpload,
    fileId: number,
    initRes: any,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks
  ): Promise<UploadExecutionResult> {
    if (control.shouldCancel()) return { paused: false, cancelled: true };
    if (control.shouldPause()) return { paused: true };

    const metadata = {
      name: initRes.name_hash || 'file',
      parents: [initRes.root_folder_id]
    };
    const boundary = '-------314159265358979323846';
    const firstDelimiter = `--${boundary}\r\n`;
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--\r\n`;
    const metadataPart = JSON.stringify(metadata);
    const arrayBuffer = await prepared.encryptedBlob.arrayBuffer();
    throwIfUploadCancelled(control.signal);
    const chunks = [
      new TextEncoder().encode(
        firstDelimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        metadataPart +
        delimiter +
        'Content-Type: application/octet-stream\r\n\r\n'
      ),
      new Uint8Array(arrayBuffer),
      new TextEncoder().encode(closeDelim)
    ];
    let bodyUint8: Uint8Array | null = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      throwIfUploadCancelled(control.signal);
      bodyUint8.set(chunk, offset);
      offset += chunk.length;
    }
    const requestBody = new Blob([bodyUint8.buffer as ArrayBuffer]);
    bodyUint8 = null;

    let uploadRes: any;
    try {
      uploadRes = await new Promise<any>((resolve, reject) => {
        let settled = false;
        let subscription: Subscription | undefined;
        const removeAbortListener = () => control.signal?.removeEventListener('abort', onAbort);
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          removeAbortListener();
          callback();
        };
        const onAbort = () => {
          subscription?.unsubscribe();
          finish(() => reject(new UploadAbortError()));
        };
        control.signal?.addEventListener('abort', onAbort, { once: true });
        subscription = this.http.post<any>(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${initRes.access_token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`
            },
            reportProgress: true,
            observe: 'events'
          }
        ).subscribe({
          next: event => {
            if (event.type === HttpEventType.UploadProgress) {
              const progress = Math.round((event.loaded / event.total!) * 100);
              callbacks.onProgress({
                progress,
                transferredBytes: event.loaded,
                totalBytes: event.total!,
              });
            } else if (event.type === HttpEventType.Response) {
              finish(() => resolve(event.body));
            }
          },
          error: error => finish(() => reject(error))
        });
        if (control.signal?.aborted) onAbort();
      });
    } catch (error: any) {
      if (isUploadAbortError(error) || control.shouldCancel()) return { paused: false, cancelled: true };
      if (error?.message === 'PAUSED') return { paused: true };
      throw error;
    }

    if (control.shouldCancel()) return { paused: false, cancelled: true };
    if (control.shouldPause()) return { paused: true };
    if (!uploadRes?.id) throw new Error('Google Drive upload failed: ID missing from response');
    await firstValueFromAbortable(this.driveService.finalizeExternalUpload(fileId, uploadRes.id), control.signal);
    if (control.shouldCancel()) return { paused: false, cancelled: true };
    return { paused: false };
  }
}

export const THUMBNAIL_MAX_DIMENSION = 1280;

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
