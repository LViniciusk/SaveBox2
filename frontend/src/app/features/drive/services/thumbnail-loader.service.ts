import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import type { DriveFile } from '../state/drive.store';
import { DriveService } from './drive.service';
import { firstValueFromAbortable } from '../upload/abortable-observable';

type ThumbnailRangeFetcher = (size: number) => Promise<Blob>;
type ThumbnailRangeResolution = ThumbnailRangeFetcher | Promise<ThumbnailRangeFetcher | undefined>;

@Injectable({ providedIn: 'root' })
export class ThumbnailLoaderService {
  readonly thumbnails = signal<Record<number, string>>({});
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly retries = new Map<number, number>();
  private readonly permanentFailures = new Set<number>();
  private readonly retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private generation = 0;
  private nextFileGeneration = 0;
  private readonly fileGenerations = new Map<number, number>();

  constructor(
    private readonly cryptoService: CryptoService,
    private readonly driveService: DriveService,
    private readonly http: HttpClient,
    private readonly kasumi: KasumiCryptoService,
  ) {}

  clear(): void {
    this.generation++;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.inFlight.clear();
    this.retries.clear();
    this.permanentFailures.clear();
    this.fileGenerations.clear();
    this.thumbnails.set({});
  }

  setThumbnail(fileId: number, thumbnail: string): void {
    this.thumbnails.update(current => ({ ...current, [fileId]: thumbnail }));
    this.retries.delete(fileId);
    this.permanentFailures.delete(fileId);
  }

  prune(fileIds: ReadonlySet<number>): void {
    const current = this.thumbnails();
    const candidates = new Set<number>([
      ...this.controllers.keys(),
      ...this.inFlight.keys(),
      ...this.retryTimers.keys(),
      ...this.retries.keys(),
      ...this.permanentFailures,
      ...this.fileGenerations.keys(),
      ...Object.keys(current).map(Number),
    ]);
    let thumbnailsChanged = false;
    for (const id of candidates) {
      if (fileIds.has(id)) continue;
      this.fileGenerations.delete(id);
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.inFlight.delete(id);
      const timer = this.retryTimers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.retryTimers.delete(id);
      this.retries.delete(id);
      this.permanentFailures.delete(id);
      if (Object.prototype.hasOwnProperty.call(current, id)) thumbnailsChanged = true;
    }
    if (thumbnailsChanged) {
      const retained = Object.fromEntries(Object.entries(current).filter(([id]) => fileIds.has(Number(id))));
      this.thumbnails.set(retained);
    }
  }

  async load(file: DriveFile): Promise<void> {
    if (this.thumbnails()[file.id] || !file.encryptedFdk || this.permanentFailures.has(file.id)) return;
    const existing = this.inFlight.get(file.id);
    if (existing) return existing;

    const generation = this.generation;
    const fileGeneration = ++this.nextFileGeneration;
    const controller = new AbortController();
    this.fileGenerations.set(file.id, fileGeneration);
    this.controllers.set(file.id, controller);
    const request = this.loadOnce(file, generation, fileGeneration, controller.signal);
    this.inFlight.set(file.id, request);
    try {
      await request;
    } finally {
      if (this.inFlight.get(file.id) === request) this.inFlight.delete(file.id);
      if (this.controllers.get(file.id) === controller) this.controllers.delete(file.id);
    }
  }

  private async loadOnce(file: DriveFile, generation: number, fileGeneration: number, signal: AbortSignal): Promise<void> {
    if (!file.encryptedFdk) return;
    let fdkToWipe: Uint8Array | undefined;
    try {
      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
      fdkToWipe = this.decodeFdk(fdkBase64);
      const fetchRange = this.resolveRangeFetcher(file, generation, fileGeneration, signal);
      const metadata = await this.loadMetadata(file, fdkToWipe, fetchRange, generation, fileGeneration, signal);
      if (!metadata || !this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
      const parsed = JSON.parse(metadata);
      if (parsed.thumb && this.isCurrentGeneration(file.id, generation, fileGeneration)) this.setThumbnail(file.id, parsed.thumb);
    } catch (error) {
      await this.handleLoadError(file, generation, fileGeneration, error);
    } finally {
      fdkToWipe?.fill(0);
    }
  }

  private decodeFdk(fdkBase64: string): Uint8Array {
    const fdkString = atob(fdkBase64);
    const fdk = new Uint8Array(fdkString.length);
    for (let i = 0; i < fdkString.length; i++) fdk[i] = fdkString.charCodeAt(i);
    return fdk;
  }

  private resolveRangeFetcher(
    file: DriveFile,
    generation: number,
    fileGeneration: number,
    signal: AbortSignal,
  ): ThumbnailRangeResolution {
    if (file.storageProvider !== 'google_drive') {
      return size => firstValueFromAbortable(this.driveService.downloadFileRange(file.id, 0, size - 1), signal);
    }
    return firstValueFromAbortable(this.driveService.downloadExternalMetadata(file.id), signal).then(meta => {
      if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
      const url = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
      const token = meta.access_token;
      if (!token) return;
      return size => firstValueFromAbortable(this.http.get(url, {
        headers: { Range: `bytes=0-${size - 1}`, Authorization: `Bearer ${token}` },
        responseType: 'blob'
      }), signal);
    });
  }

  private async loadMetadata(
    file: DriveFile,
    fdk: Uint8Array,
    fetchRange: ThumbnailRangeResolution,
    generation: number,
    fileGeneration: number,
    signal: AbortSignal,
  ): Promise<string | null | undefined> {
    const resolvedRange = fetchRange instanceof Promise ? await fetchRange : fetchRange;
    if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
    const rangeFetcher = resolvedRange ?? (size => firstValueFromAbortable(this.driveService.downloadFileRange(file.id, 0, size - 1), signal));
    const initialFetchSize = 1024 * 128;
    const maxMetadataFetchSize = 4 * 1024 * 1024;
    let requestedSize = Math.max(1, Math.min(initialFetchSize, file.sizeBytes > 0 ? file.sizeBytes : initialFetchSize));
    const maxRequestedSize = Math.min(file.sizeBytes > 0 ? file.sizeBytes : maxMetadataFetchSize, maxMetadataFetchSize);
    while (true) {
      const blob = await rangeFetcher(requestedSize);
      if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
      try {
        const metadata = (await this.kasumi.extractMetadata(blob, fdk, file.sizeBytes)).metadata;
        if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
        return metadata;
      } catch (error) {
        if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
        const nextSize = this.nextMetadataFetchSize(error, requestedSize, maxRequestedSize);
        if (nextSize === undefined) throw error;
        requestedSize = nextSize;
      }
    }
  }

  private nextMetadataFetchSize(error: unknown, requestedSize: number, maxRequestedSize: number): number | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (!/partial blob|full metadata|metadata block/i.test(message) || requestedSize >= maxRequestedSize) return;
    return Math.min(maxRequestedSize, Math.max(requestedSize * 4, 1024 * 1024));
  }

  private async handleLoadError(file: DriveFile, generation: number, fileGeneration: number, error: unknown): Promise<void> {
    if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
    const message = (await this.errorMessage(error)).toLowerCase();
    if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
    const status = error instanceof HttpErrorResponse ? error.status : 0;
    const incomplete = status === 400 && /(incomplete|pending|upload|chunk)/i.test(message);
    const networkFailure = error instanceof HttpErrorResponse && status === 0;
    if (status === 404 || status === 416 || !(incomplete || networkFailure)) {
      if (this.isCurrentGeneration(file.id, generation, fileGeneration)) this.permanentFailures.add(file.id);
    } else {
      const retries = this.retries.get(file.id) ?? 0;
      if (retries < 2) {
        if (!this.isCurrentGeneration(file.id, generation, fileGeneration)) return;
        this.retries.set(file.id, retries + 1);
        this.scheduleRetry(file, generation, fileGeneration, 300 * (retries + 1));
      } else if (this.isCurrentGeneration(file.id, generation, fileGeneration)) {
        this.permanentFailures.add(file.id);
      }
    }
    console.warn('Could not load thumbnail for file ' + file.id);
  }

  private scheduleRetry(file: DriveFile, generation: number, fileGeneration: number, delay: number): void {
    const existing = this.retryTimers.get(file.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.retryTimers.get(file.id) === timer) this.retryTimers.delete(file.id);
      if (this.isCurrentGeneration(file.id, generation, fileGeneration)) void this.load(file);
    }, delay);
    this.retryTimers.set(file.id, timer);
  }

  private isCurrentGeneration(fileId: number, generation: number, fileGeneration: number): boolean {
    return generation === this.generation && this.fileGenerations.get(fileId) === fileGeneration;
  }

  private async errorMessage(error: unknown): Promise<string> {
    if (error instanceof HttpErrorResponse) {
      if (error.error instanceof Blob) return error.error.text();
      if (typeof error.error === 'string') return error.error;
      if (error.error && typeof error.error === 'object') return JSON.stringify(error.error);
      return error.message;
    }
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : '';
  }
}
