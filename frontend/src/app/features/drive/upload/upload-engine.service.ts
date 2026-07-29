import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import {
  PreparedUpload,
  UploadEngineCallbacks,
  UploadExecutionControl,
  UploadExecutionResult,
  UploadProvider,
} from './upload.models';

const CHUNK_SIZE = 4 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class UploadEngineService {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly http = inject(HttpClient);

  async prepareUpload(file: File): Promise<PreparedUpload> {
    const encryptedName = await this.cryptoService.encryptName(file.name);
    const nameHash = await this.cryptoService.hashName(file.name);
    const fdk = new Uint8Array(32);
    crypto.getRandomValues(fdk);
    const encryptedFdk = await this.cryptoService.encryptName(
      btoa(String.fromCharCode(...fdk))
    );

    let metadata: string | undefined;
    const thumbnail = await generateThumbnail(file);
    if (thumbnail) metadata = JSON.stringify({ thumb: thumbnail });

    const encryptedBlob = await this.kasumi.encryptFile(file, fdk, undefined, metadata);
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
  }

  async execute(
    prepared: PreparedUpload,
    fileId: number,
    provider: UploadProvider,
    initRes: any,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks
  ): Promise<UploadExecutionResult> {
    if (provider === 'google_drive') {
      return this.uploadGoogleDrive(prepared, fileId, initRes, control, callbacks);
    }
    return this.uploadLocal(prepared, fileId, control, callbacks);
  }

  private async uploadLocal(
    prepared: PreparedUpload,
    fileId: number,
    control: UploadExecutionControl,
    callbacks: UploadEngineCallbacks
  ): Promise<UploadExecutionResult> {
    let uploadedChunks = new Set<number>();
    try {
      const res = await firstValueFrom(this.driveService.getUploadedChunks(fileId));
      uploadedChunks = new Set(res.uploaded_chunks);
    } catch {
      // Fallback: retry every chunk when the progress endpoint is unavailable.
    }

    for (let i = 0; i < prepared.totalChunks; i++) {
      if (control.shouldPause() || control.shouldCancel()) return { paused: true };

      if (!uploadedChunks.has(i)) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, prepared.encryptedBlob.size);
        await firstValueFrom(this.driveService.uploadChunk(fileId, i, prepared.encryptedBlob.slice(start, end)));
      }

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
    if (control.shouldPause() || control.shouldCancel()) return { paused: true };

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
    const bodyUint8 = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bodyUint8.set(chunk, offset);
      offset += chunk.length;
    }

    let uploadRes: any;
    try {
      uploadRes = await new Promise<any>((resolve, reject) => {
        this.http.post<any>(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
          new Blob([bodyUint8]),
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
              resolve(event.body);
            }
          },
          error: reject
        });
      });
    } catch (error: any) {
      if (error?.message === 'PAUSED') return { paused: true };
      throw error;
    }

    if (control.shouldPause() || control.shouldCancel()) return { paused: true };
    if (!uploadRes?.id) throw new Error('Google Drive upload failed: ID missing from response');
    await firstValueFrom(this.driveService.finalizeExternalUpload(fileId, uploadRes.id));
    return { paused: false };
  }
}

export const THUMBNAIL_MAX_DIMENSION = 1280;

export async function generateThumbnail(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return null;

  if (file.type.startsWith('image/')) {
    return generateImageThumbnail(file);
  }

  return generateVideoThumbnail(file);
}

async function generateImageThumbnail(file: File): Promise<string | null> {
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

  return loadImageElementThumbnail(file);
}

function loadImageElementThumbnail(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const image = document.createElement('img');
    const finish = (value: string | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    image.onload = () => finish(renderThumbnail(image, image.naturalWidth || image.width, image.naturalHeight || image.height));
    image.onerror = () => finish(null);
    image.src = url;
  });
}

function generateVideoThumbnail(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
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
