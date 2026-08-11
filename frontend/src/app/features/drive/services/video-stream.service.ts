/**
 * video-stream.service.ts
 *
 * Phases 3 + 4: MSE Orchestrator with Injection Loop, Seeking, GC and Teardown.
 *
 * Architecture
 * ------------
 *
 * Phase 3:
 *   - Bootstraps the MediaSource by fetching the last MP4 chunk first so
 *     mp4box.js can parse the moov atom and return the codec string and the
 *     fMP4 Initialization Segment before playback begins.
 *   - Creates the SourceBuffer and appends the init segment.
 *
 * Phase 4:
 *   1. Injection Loop (demand-driven buffering)
 *      - Instead of a greedy sequential download loop, the service listens
 *        to the 'timeupdate' event of the HTMLVideoElement.
 *      - On every tick it computes how many seconds of video are already
 *        buffered ahead of the playhead (using SourceBuffer.buffered).
 *      - If the look-ahead falls below BUFFER_AHEAD_SECONDS and no chunk is
 *        currently being fetched, it schedules the next chunk.
 *
 *   2. Seeking (jump to arbitrary playhead position)
 *      - A 'seeking' event listener is registered on the video element.
 *      - On seek: MP4Box.seek() owns byte/timeline resync, resumeTime owns the
 *        MSE reconstruction boundary, and chunkIndex comes from exactOffset.
 *
 *   3. Garbage Collection (eviction of stale SourceBuffer ranges)
 *      - Called from the timeupdate handler whenever
 *        videoElement.currentTime > GC_BEHIND_SECONDS.
 *      - Removes TimeRange [0, currentTime - GC_BEHIND_SECONDS] from the
 *        SourceBuffer using sb.remove(start, end).
 *      - Guarded by sb.updating to avoid racing with an active appendBuffer.
 *      - Protects against QuotaExceededError which would freeze the player.
 *
 * Memory Guarantees
 * -----------------
 *   Active RAM from SourceBuffer <= BUFFER_AHEAD_SECONDS * bitrate
 *                                 + GC_BEHIND_SECONDS    * bitrate
 *
 *   CPU pipeline RAM is bounded by active downloads and KASUMI_CHUNK_SIZE.
 *
 * Race Condition Guards
 * ---------------------
 *   - s.activeDownloads   bounds concurrent HTTP+Worker pipelines.
 *   - processLock         serializes appendBuffer processing.
 *   - s.isRemoving        prevents overlapping sb.remove calls.
 *   - s.seekGeneration    is incremented on every seek; stale pipeline
 *                         responses detect a mismatch and self-discard.
 *   - All SourceBuffer mutations wait for 'updateend' before proceeding.
 */

import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import {
  KASUMI_CHUNK_SIZE,
  KASUMI_MAX_METADATA_SIZE,
  KASUMI_KAS2_METADATA_PREFIX_SIZE,
} from '../../../core/crypto/kasumi-format';
import { Injectable, signal, inject, NgZone } from '@angular/core';
import { Subscription, timer } from 'rxjs';
import { retry } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService } from '../services/drive.service';
import { ShareService } from './share.service';
import { DriveFile, DriveStore } from '../state/drive.store';
import { firstValueFromAbortable, NetworkDeadlineError } from '../upload/abortable-observable';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';

// ---------------------------------------------------------------------------
// On-disk format constants (must mirror Kasumi XChaCha20 layout exactly).
// ---------------------------------------------------------------------------

const MAC_SIZE = 16;
const MOOV_FOURCC = 0x6d6f6f76;
const EBML_HEADER = 0x1a45dfa3;
const UNSUPPORTED_STREAMING_FORMAT_MESSAGE =
  'Este vídeo não está em um formato compatível com o streaming do Nanika.';
/** Plaintext capacity per encrypted chunk. */

// ---------------------------------------------------------------------------
// Buffering / GC policy constants.
// ---------------------------------------------------------------------------

/**
 * Minimum seconds of buffered video required ahead of the playhead before
 * the service schedules another chunk download. Low values increase HTTP
 * request frequency; high values increase RAM pressure.
 */
const BUFFER_AHEAD_SECONDS = 20;

/**
 * Seconds of already-played video the service retains in the SourceBuffer
 * for backward seeks without re-downloading. Everything older is evicted.
 */
const GC_BEHIND_SECONDS = 10;

const WORKER_RESPONSE_TIMEOUT_MS = 30_000;
const SOURCE_BUFFER_OPERATION_TIMEOUT_MS = 10_000;
const SOURCE_BUFFER_RECOVERY_BUDGET_MS = 30_000;
const SOURCE_BUFFER_RECOVERY_DELAY_MS = 500;
const MAX_APPEND_RECOVERY_RESTARTS = 1;

/**
 * Maximum number of fMP4 segments allowed in the in-memory append queue.
 * This bounds RAM between the transmux worker output and SourceBuffer input.
 */

// ---------------------------------------------------------------------------
// Internal stream state
// ---------------------------------------------------------------------------

interface StreamState {
  // File metadata
  file: DriveFile;
  fdk: Uint8Array;
  baseNonce: Uint8Array;
  plaintextSize: number;
  totalChunks: number;
  dataOffset: number; // Kasumi v2 offset
  /** Total video duration in seconds (set after moov parse; 0 until known). */
  videoDuration: number;

  // MSE objects
  mediaSource: MediaSource;
  sourceBuffers: Map<number, SourceBuffer>;
  codecStrings: Map<number, string>;

  // Workers
  cryptoWorker: Worker;
  transmuxWorker: Worker;

  // Pipeline state
  nextChunkIndex: number; // Index of the next chunk to download.
  activeDownloads: number; // Replaces isFetching to allow parallel downloads
  isRemoving: boolean; // True while SourceBuffer.remove is active.

  /**
   * Incremented on every seek. Any pipeline callback that captures an older
   * generation value discards its result instead of appending it.
   */
  seekGeneration: number;

  /** Set of AbortControllers for all in-flight HTTP Range requests. */
  currentFetches: Set<AbortController>;

  /** Chain of promises to ensure chunks are decrypted and transmuxed strictly in order. */
  processLock: Promise<void>;

  seekDebounceTimeout: ReturnType<typeof setTimeout> | null;
  initialSeekInterval: ReturnType<typeof setInterval> | null;

  /** Whether the stream has been fully destroyed. */
  aborted: boolean;
  lifecycleController: AbortController;
  recoveryContext: PlaybackRecoveryContext;

  // Video element binding references
  videoElement: HTMLVideoElement;
  videoUrl: string;
  gdriveUrl: string | null;
  gdriveToken: string | null;
  shareUuid: string | null;

  // Event listener cleanup handles
  removeVideoListeners: (() => void) | null;
}

interface InitializationContext {
  generation: number;
  controller: AbortController;
}

interface StreamSource {
  gdriveUrl: string | null;
  gdriveToken: string | null;
}

interface GoogleRangeCredentials {
  gdriveUrl: string | null;
  gdriveToken: string | null;
}

interface PlaybackRecoveryContext {
  appendRestartsRemaining: number;
}

interface StreamMetadata {
  baseNonce: Uint8Array;
  dataOffset: number;
  plaintextSize: number;
  totalChunks: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class VideoStreamService {
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly driveService = inject(DriveService);
  private readonly shareService = inject(ShareService);
  private readonly ngZone = inject(NgZone);
  private readonly driveStore = inject(DriveStore);

  // Public reactive state for component bindings.
  readonly isStreaming = signal(false);
  readonly bufferProgress = signal(0); // 0..100; buffered chunks / total.
  readonly isSeeking = signal(false); // True while seek pipeline runs.
  readonly isBuffering = signal(true); // True when video is stalling for data.
  readonly error = signal<string | null>(null);
  readonly originalBitrateWarning = signal(false);

  private state: StreamState | null = null;
  private initializationGeneration = 0;
  private initializationController: AbortController | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Attaches a secure streaming session to the given HTMLVideoElement.
   * Safe to call multiple times -- destroys any previous session first.
   */
  async initializeStream(
    videoElement: HTMLVideoElement,
    file: DriveFile,
    initialSeekTime?: number,
  ): Promise<void> {
    return this.initializeStreamAttempt(videoElement, file, initialSeekTime, {
      appendRestartsRemaining: MAX_APPEND_RECOVERY_RESTARTS,
    });
  }

  private async initializeStreamAttempt(
    videoElement: HTMLVideoElement,
    file: DriveFile,
    initialSeekTime: number | undefined,
    recoveryContext: PlaybackRecoveryContext,
  ): Promise<void> {
    this.destroyStream();
    const initialization = this.beginInitialization();
    this.error.set(null);
    this.isStreaming.set(true);
    this.bufferProgress.set(0);
    this.isSeeking.set(false);
    this.isBuffering.set(true);
    this.originalBitrateWarning.set(false);

    let fdk: Uint8Array | null = null;
    let baseNonce: Uint8Array | null = null;
    let mediaSource: MediaSource | null = null;
    let videoUrl: string | null = null;
    let cryptoWorker: Worker | null = null;
    let transmuxWorker: Worker | null = null;
    let committedState: StreamState | null = null;
    try {
      if (!file.shareFdk && !this.cryptoService.isVaultUnlocked()) {
        throw new Error('Drive trancado. Desbloqueie o drive antes de reproduzir.');
      }
      const fileToPlay = this.selectPlaybackFile(file);
      if (!fileToPlay.shareFdk && !fileToPlay.encryptedFdk) {
        throw new Error('FDK ausente nos metadados do arquivo.');
      }

      fdk = await this.resolveOwnedFdk(fileToPlay, initialization);
      this.ensureInitializationCurrent(initialization);
      const source = await this.resolveStreamSource(fileToPlay, initialization);
      this.ensureInitializationCurrent(initialization);
      const metadata = await this.loadStreamMetadata(fileToPlay, fdk, source, initialization);
      baseNonce = metadata.baseNonce;
      this.ensureInitializationCurrent(initialization);
      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] File size:',
          metadata.plaintextSize,
          'totalChunks:',
          metadata.totalChunks,
          'dataOffset:',
          metadata.dataOffset,
        );

      // --- Step 3: Create MediaSource and bind to the video element. ---------
      mediaSource = new MediaSource();
      videoUrl = URL.createObjectURL(mediaSource);
      videoElement.src = videoUrl;
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Waiting for media source open...');
      await this.waitForSourceOpen(mediaSource, initialization.controller.signal);
      this.ensureInitializationCurrent(initialization);
      if (environment.logs.transmuxer) console.log('[VideoStream] Media source opened.');

      // --- Step 4: Instantiate workers. --------------------------------------
      ({ cryptoWorker, transmuxWorker } = this.createWorkers());
      this.ensureInitializationCurrent(initialization);
      const s = this.createStreamState(
        fileToPlay,
        videoElement,
        videoUrl,
        mediaSource,
        fdk,
        source,
        metadata,
        cryptoWorker,
        transmuxWorker,
        recoveryContext,
      );
      this.state = s;
      committedState = s;
      this.bindWorkerLifecycle(s);
      fdk = null;
      baseNonce = null;
      mediaSource = null;
      videoUrl = null;
      cryptoWorker = null;
      transmuxWorker = null;

      if (environment.logs.transmuxer) console.log('[VideoStream] Starting bootstrapLastChunk...');
      // --- Step 5: Bootstrap (moov atom from last chunk). --------------------
      await this.bootstrapLastChunk(s);
      this.ensureInitializationCurrent(initialization);
      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] bootstrapLastChunk completed. nextChunkIndex is:',
          s.nextChunkIndex,
        );

      // --- Step 6: Attach event listeners. ----------------------------------
      this.attachVideoListeners(s, videoElement);
      this.startInitialPlayback(s, videoElement, initialSeekTime);
    } catch (err: any) {
      if (committedState) {
        this.teardownState(committedState);
      } else {
        this.cleanupInitializationResources(
          videoElement,
          videoUrl,
          mediaSource,
          cryptoWorker,
          transmuxWorker,
          fdk,
          baseNonce,
        );
      }
      if (this.isInitializationCurrent(initialization) && !this.isAbortError(err)) {
        this.error.set(err?.message ?? 'Erro desconhecido no streaming.');
        this.isStreaming.set(false);
      }
    } finally {
      this.finishInitialization(initialization);
    }
  }

  private selectPlaybackFile(file: DriveFile): DriveFile {
    if (file.shareFdk || file.forceOriginal) return file;
    const proxyName = file.decryptedName + '.proxy.mp4';
    const proxyFile = this.driveStore
      .files()
      .find(
        (candidate) =>
          candidate.decryptedName === proxyName && candidate.folderId === file.folderId,
      );
    if (proxyFile && environment.logs.transmuxer) {
      console.log(
        '[VideoStream] Proxy version found! Using optimized stream instead of original master.',
      );
    }
    return proxyFile ?? file;
  }

  private async resolveStreamSource(
    file: DriveFile,
    context: InitializationContext,
  ): Promise<StreamSource> {
    let gdriveUrl: string | null = null;
    let gdriveToken: string | null = null;
    if (!file.shareFdk && file.storageProvider === 'google_drive') {
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Loading Google Drive metadata for file ID:', file.id);
      const meta = await firstValueFromAbortable(
        this.driveService.downloadExternalMetadata(file.id),
        context.controller.signal,
        DRIVE_CONTROL_REQUEST_DEADLINE_MS,
      );
      gdriveUrl = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
      gdriveToken = meta.access_token;
    }
    this.ensureInitializationCurrent(context);
    return { gdriveUrl, gdriveToken };
  }

  private async resolveOwnedFdk(
    file: DriveFile,
    context: InitializationContext,
  ): Promise<Uint8Array> {
    if (file.shareFdk) return file.shareFdk.slice();

    const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk!);
    this.ensureInitializationCurrent(context);
    const fdkString = atob(fdkBase64);
    return Uint8Array.from(fdkString, (character) => character.charCodeAt(0));
  }

  private async loadStreamMetadata(
    file: DriveFile,
    fdk: Uint8Array,
    source: StreamSource,
    context: InitializationContext,
  ): Promise<StreamMetadata> {
    if (environment.logs.transmuxer) console.log('[VideoStream] Fetching header...');
    const maxHeaderSize = KASUMI_MAX_METADATA_SIZE + KASUMI_KAS2_METADATA_PREFIX_SIZE;
    const maxRequestedSize = Math.min(Math.max(file.sizeBytes, 1), maxHeaderSize);
    let requestedSize = Math.min(128 * 1024, maxRequestedSize);
    let headerBlob: Blob;
    let dataOffset: number;
    let expectedSize: number;
    while (true) {
      headerBlob = await this.fetchRange(
        file.id,
        0,
        requestedSize - 1,
        context.controller,
        source,
        file.shareUuid,
      );
      this.ensureInitializationCurrent(context);
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Header blob fetched size:', headerBlob.size);
      try {
        ({ dataOffset, expectedSize } = await this.kasumi.extractMetadata(headerBlob, fdk, file.sizeBytes));
        this.ensureInitializationCurrent(context);
        break;
      } catch (error) {
        const nextSize = this.nextMetadataFetchSize(error, requestedSize, maxRequestedSize);
        if (nextSize === undefined) throw error;
        requestedSize = nextSize;
      }
    }
    let baseNonce: Uint8Array | undefined;
    try {
      baseNonce = new Uint8Array(await headerBlob.slice(0, 24).arrayBuffer());
      this.ensureInitializationCurrent(context);
      return {
        baseNonce,
        dataOffset,
        plaintextSize: expectedSize,
        totalChunks: Math.ceil(expectedSize / KASUMI_CHUNK_SIZE),
      };
    } catch (error) {
      baseNonce?.fill(0);
      throw error;
    }
  }

  private nextMetadataFetchSize(error: unknown, requestedSize: number, maxRequestedSize: number): number | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (!/partial blob|full metadata|metadata block/i.test(message) || requestedSize >= maxRequestedSize) return;
    return Math.min(maxRequestedSize, Math.max(requestedSize * 4, 1024 * 1024));
  }

  private createStreamState(
    file: DriveFile,
    videoElement: HTMLVideoElement,
    videoUrl: string,
    mediaSource: MediaSource,
    fdk: Uint8Array,
    source: StreamSource,
    metadata: StreamMetadata,
    cryptoWorker: Worker,
    transmuxWorker: Worker,
    recoveryContext: PlaybackRecoveryContext,
  ): StreamState {
    return {
      file,
      fdk,
      baseNonce: metadata.baseNonce,
      plaintextSize: metadata.plaintextSize,
      totalChunks: metadata.totalChunks,
      dataOffset: metadata.dataOffset,
      videoDuration: 0,
      mediaSource,
      sourceBuffers: new Map<number, SourceBuffer>(),
      codecStrings: new Map<number, string>(),
      cryptoWorker,
      transmuxWorker,
      nextChunkIndex: 0,
      activeDownloads: 0,
      isRemoving: false,
      seekGeneration: 0,
      currentFetches: new Set<AbortController>(),
      processLock: Promise.resolve(),
      seekDebounceTimeout: null,
      initialSeekInterval: null,
      aborted: false,
      lifecycleController: new AbortController(),
      recoveryContext,
      videoElement,
      videoUrl,
      gdriveUrl: source.gdriveUrl,
      gdriveToken: source.gdriveToken,
      shareUuid: file.shareUuid ?? null,
      removeVideoListeners: null,
    };
  }

  private startInitialPlayback(
    s: StreamState,
    videoElement: HTMLVideoElement,
    initialSeekTime?: number,
  ): void {
    if (initialSeekTime === undefined || initialSeekTime <= 0) {
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Priming the pump (scheduleNextChunk)...');
      this.scheduleNextChunk(s, videoElement);
      return;
    }
    if (environment.logs.transmuxer)
      console.log('[VideoStream] Silent retry: jumping to initialSeekTime', initialSeekTime);
    videoElement.currentTime = initialSeekTime;
    s.initialSeekInterval = setInterval(() => {
      if (s.aborted) {
        this.clearInitialSeekInterval(s);
      } else if (videoElement.buffered.length > 0) {
        const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
        if (bufferedEnd >= videoElement.currentTime + 1 || videoElement.readyState >= 3) {
          this.clearInitialSeekInterval(s);
          videoElement.play().catch((error) => console.warn('Autoplay prevented on retry', error));
        }
      }
    }, 500);
  }

  /**
   * Terminates the stream session and releases all resources.
   * Must be called from the owning component's ngOnDestroy.
   */
  destroyStream(): void {
    this.invalidateInitialization();
    if (this.state) this.teardownState(this.state);
    this.isStreaming.set(false);
    this.isSeeking.set(false);
    this.originalBitrateWarning.set(false);
  }

  private beginInitialization(): InitializationContext {
    this.initializationController?.abort();
    const context: InitializationContext = {
      generation: ++this.initializationGeneration,
      controller: new AbortController(),
    };
    this.initializationController = context.controller;
    return context;
  }

  private finishInitialization(context: InitializationContext): void {
    if (this.initializationController === context.controller) {
      this.initializationController = null;
    }
  }

  private invalidateInitialization(): void {
    this.initializationGeneration++;
    this.initializationController?.abort();
    this.initializationController = null;
  }

  private isInitializationCurrent(context: InitializationContext): boolean {
    return (
      this.initializationGeneration === context.generation &&
      this.initializationController === context.controller &&
      !context.controller.signal.aborted
    );
  }

  private ensureInitializationCurrent(context: InitializationContext): void {
    if (!this.isInitializationCurrent(context)) throw this.createAbortError();
  }

  private isAbortError(error: unknown): boolean {
    return (
      !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
    );
  }

  private createAbortError(): Error {
    return Object.assign(new Error('Fetch aborted.'), { name: 'AbortError' });
  }

  private createWorkers(): { cryptoWorker: Worker; transmuxWorker: Worker } {
    let cryptoWorker: Worker | null = null;
    let transmuxWorker: Worker | null = null;
    try {
      cryptoWorker = new Worker(new URL('../workers/stream-crypto.worker', import.meta.url), {
        type: 'module',
      });

      transmuxWorker = new Worker(new URL('../workers/stream-transmux.worker', import.meta.url), {
        type: 'module',
      });
      return { cryptoWorker, transmuxWorker };
    } catch (error) {
      cryptoWorker?.terminate();
      transmuxWorker?.terminate();
      throw error;
    }
  }

  private bindWorkerLifecycle(s: StreamState): void {
    const fail = (message: string, label: string): void => {
      if (environment.logs.transmuxer) console.error(label, message);
      this.failStream(s, message);
    };

    s.cryptoWorker.onerror = () =>
      fail('Falha no processamento criptográfico do vídeo.', '[CryptoWorker Error]');
    s.cryptoWorker.onmessageerror = () =>
      fail('Resposta inválida do worker de descriptografia.', '[CryptoWorker Message Error]');
    s.transmuxWorker.onerror = () =>
      fail('Falha no processamento do vídeo.', '[TransmuxWorker Error]');
    s.transmuxWorker.onmessageerror = () =>
      fail('Resposta inválida do worker de vídeo.', '[TransmuxWorker Message Error]');

    try {
      s.cryptoWorker.postMessage({ type: 'INIT', logsEnabled: environment.logs.crypto });
    } catch (error) {
      fail('Falha ao inicializar o processamento criptográfico do vídeo.', '[CryptoWorker Error]');
      throw error;
    }
  }

  private failStream(s: StreamState, message: string): void {
    if (s.aborted || this.state !== s) return;

    this.invalidateInitialization();
    this.ngZone.run(() => {
      this.error.set(message);
      this.isStreaming.set(false);
      this.isBuffering.set(false);
      this.isSeeking.set(false);
    });
    this.teardownState(s);
  }

  private clearInitialSeekInterval(s: StreamState): void {
    if (s.initialSeekInterval !== null) {
      clearInterval(s.initialSeekInterval);
      s.initialSeekInterval = null;
    }
  }

  private ownsVideoSource(videoElement: HTMLVideoElement, videoUrl: string): boolean {
    return (
      (videoElement as any).src === videoUrl || videoElement.getAttribute?.('src') === videoUrl
    );
  }

  private cleanupInitializationResources(
    videoElement: HTMLVideoElement,
    videoUrl: string | null,
    mediaSource: MediaSource | null,
    cryptoWorker: Worker | null,
    transmuxWorker: Worker | null,
    fdk: Uint8Array | null,
    baseNonce: Uint8Array | null,
  ): void {
    cryptoWorker?.terminate();
    transmuxWorker?.terminate();
    fdk?.fill(0);
    baseNonce?.fill(0);

    if (mediaSource?.readyState === 'open') {
      for (const sourceBuffer of Array.from(mediaSource.sourceBuffers)) {
        try {
          mediaSource.removeSourceBuffer(sourceBuffer);
        } catch {
          /* already closed */
        }
      }
    }
    if (videoUrl) {
      if (this.ownsVideoSource(videoElement, videoUrl)) {
        try {
          videoElement.removeAttribute('src');
          videoElement.load();
        } catch {
          /* element may already be detached */
        }
      }
      URL.revokeObjectURL(videoUrl);
    }
  }

  private teardownState(s: StreamState): void {
    if (s.aborted) {
      if (this.state === s) this.state = null;
      return;
    }
    s.aborted = true;
    s.lifecycleController?.abort();
    s.currentFetches.forEach((controller) => controller.abort());
    s.currentFetches.clear();
    this.clearInitialSeekInterval(s);
    if (s.seekDebounceTimeout !== null) {
      clearTimeout(s.seekDebounceTimeout);
      s.seekDebounceTimeout = null;
    }
    s.removeVideoListeners?.();
    s.removeVideoListeners = null;
    s.cryptoWorker?.terminate();
    s.transmuxWorker?.terminate();

    if (s.mediaSource.readyState === 'open') {
      try {
        for (const sourceBuffer of Array.from(s.mediaSource.sourceBuffers)) {
          s.mediaSource.removeSourceBuffer(sourceBuffer);
        }
      } catch (error) {
        console.warn('[VideoStream] Error removing source buffers during destroy:', error);
      }
    }
    s.sourceBuffers?.clear();
    s.codecStrings?.clear();

    if (this.ownsVideoSource(s.videoElement, s.videoUrl)) {
      try {
        s.videoElement.removeAttribute('src');
        s.videoElement.load();
      } catch {
        /* element may already be detached */
      }
    }
    URL.revokeObjectURL(s.videoUrl);
    s.fdk?.fill(0);
    s.baseNonce?.fill(0);
    s.gdriveToken = null;
    s.shareUuid = null;
    if (this.state === s) this.state = null;
  }

  // ---------------------------------------------------------------------------
  // Phase 4.1 -- Injection Loop (demand-driven buffering)
  // ---------------------------------------------------------------------------

  /**
   * Attaches the 'timeupdate' and 'seeking' event listeners to the video
   * element. The listeners are registered outside Angular's zone to avoid
   * triggering change detection on every video clock tick.
   */
  private attachVideoListeners(s: StreamState, videoElement: HTMLVideoElement): void {
    const onTimeupdate = () => {
      this.onTimeupdateTick(s, videoElement);
    };
    const onSeeking = () => {
      this.ngZone.run(() => this.isSeeking.set(true));

      if (s.seekDebounceTimeout) {
        clearTimeout(s.seekDebounceTimeout);
      }
      s.seekDebounceTimeout = setTimeout(() => {
        s.seekDebounceTimeout = null;
        this.onSeek(s, videoElement);
      }, 300);
    };

    const onWaiting = () => this.ngZone.run(() => this.isBuffering.set(true));
    const onPlaying = () => this.ngZone.run(() => this.isBuffering.set(false));
    const onCanPlay = () => this.ngZone.run(() => this.isBuffering.set(false));
    const onError = () => {
      if (environment.logs.transmuxer) {
        console.error('[VideoStream] HTMLMediaElement error', {
          code: videoElement.error?.code ?? null,
          message: videoElement.error?.message ?? null,
          readyState: videoElement.readyState,
          networkState: videoElement.networkState,
          seekGeneration: s.seekGeneration,
          isSeeking: this.isSeeking(),
          mediaSourceReadyState: s.mediaSource.readyState,
        });
      }

      if (s.aborted || this.state !== s) return;
      if (this.isSeeking() || s.seekDebounceTimeout !== null) return;
      this.failStream(s, 'Falha ao reproduzir o vídeo.');
    };

    this.ngZone.runOutsideAngular(() => {
      videoElement.addEventListener('timeupdate', onTimeupdate);
      videoElement.addEventListener('seeking', onSeeking);
      videoElement.addEventListener('waiting', onWaiting);
      videoElement.addEventListener('playing', onPlaying);
      videoElement.addEventListener('canplay', onCanPlay);
      videoElement.addEventListener('error', onError);
    });

    s.removeVideoListeners = () => {
      videoElement.removeEventListener('timeupdate', onTimeupdate);
      videoElement.removeEventListener('seeking', onSeeking);
      videoElement.removeEventListener('waiting', onWaiting);
      videoElement.removeEventListener('playing', onPlaying);
      videoElement.removeEventListener('canplay', onCanPlay);
      videoElement.removeEventListener('error', onError);
    };
  }

  /**
   * Called on every 'timeupdate' event (approximately every 250ms).
   *
   * Two jobs:
   *   1. Decide whether to fetch the next chunk (injection loop).
   *   2. Evict stale SourceBuffer ranges (garbage collection).
   */
  private onTimeupdateTick(s: StreamState, videoElement: HTMLVideoElement): void {
    if (
      s.aborted ||
      this.isSeeking() ||
      s.activeDownloads >= 3 ||
      s.nextChunkIndex >= s.totalChunks
    )
      return;

    const currentTime = videoElement.currentTime;
    // -- Injection decision -------------------------------------------------
    // While the buffer is starving and we have available network pipeline slots,
    // queue up the next block of chunks immediately.
    while (
      this.computeBufferedAhead(s, currentTime) < BUFFER_AHEAD_SECONDS &&
      s.activeDownloads < 3
    ) {
      if (s.nextChunkIndex >= s.totalChunks || s.aborted) break;
      this.scheduleNextChunk(s, videoElement);
    }

    // -- GC decision --------------------------------------------------------
    // Serialize GC removes through the processLock to prevent race conditions
    // where a removeRange fires updateend that triggers a pending appendBuffer.
    if (currentTime > GC_BEHIND_SECONDS) {
      const generation = s.seekGeneration;
      s.processLock = s.processLock.then(() => {
        if (s.aborted || s.seekGeneration !== generation) return;
        return this.evictStaleRanges(s, currentTime, generation).catch(() => {});
      });
    }
  }

  /**
   * Returns how many seconds of video are buffered strictly ahead of the
   * current playhead position.
   */
  private computeBufferedAhead(s: StreamState, currentTime: number): number {
    if (s.sourceBuffers.size === 0) return 0;

    let maxBufferedAhead = 0;
    for (const sb of s.sourceBuffers.values()) {
      const buffered = sb.buffered;
      if (buffered.length === 0) continue;

      let contiguousEnd = currentTime;

      // Find the first range that covers currentTime or is immediately after it.
      for (let r = 0; r < buffered.length; r++) {
        const start = buffered.start(r);
        const end = buffered.end(r);

        // If this range is completely behind us, ignore it.
        if (end <= contiguousEnd) continue;

        // If there's a macro-gap between our contiguous block and this range, stop.
        // We tolerate MSE micro-gaps up to 0.5 seconds.
        if (start - contiguousEnd > 0.5) {
          break;
        }

        // Extend our contiguous block.
        contiguousEnd = Math.max(contiguousEnd, end);
      }

      const trackBufferedAhead = Math.max(0, contiguousEnd - currentTime);
      if (trackBufferedAhead > maxBufferedAhead) {
        maxBufferedAhead = trackBufferedAhead;
      }
    }
    return maxBufferedAhead;
  }

  /**
   * Kicks off the download -> decrypt -> transmux -> append pipeline for the
   * chunk at s.nextChunkIndex. Fire-and-forget; isFetching prevents overlap.
   */
  private scheduleNextChunk(s: StreamState, videoElement: HTMLVideoElement): void {
    if (s.activeDownloads >= 3 || s.aborted || s.nextChunkIndex >= s.totalChunks) return;

    const startChunkIdx = s.nextChunkIndex;
    const generation = s.seekGeneration;
    s.activeDownloads++;

    // We want to fetch up to 3 chunks in a single HTTP request to reduce overhead for GDrive.
    // Local backend has a 4MB limit per request, so we only fetch 1 chunk.
    const maxChunksToFetch = s.file.storageProvider === 'google_drive' ? 3 : 1;
    const chunksToFetch = Math.min(maxChunksToFetch, s.totalChunks - startChunkIdx);
    s.nextChunkIndex += chunksToFetch;

    // Compute rangeStart for the first chunk in the block
    const firstChunkStart = s.dataOffset + startChunkIdx * (KASUMI_CHUNK_SIZE + MAC_SIZE);

    // Compute rangeEnd for the last chunk in the block (which might be smaller)
    const endChunkIdx = startChunkIdx + chunksToFetch - 1;
    const isEndChunkLast = endChunkIdx === s.totalChunks - 1;

    const endChunkPlaintextBytes = isEndChunkLast
      ? s.plaintextSize - endChunkIdx * KASUMI_CHUNK_SIZE
      : KASUMI_CHUNK_SIZE;
    const endChunkEncryptedBytes = MAC_SIZE + endChunkPlaintextBytes;

    const endChunkStart = s.dataOffset + endChunkIdx * (KASUMI_CHUNK_SIZE + MAC_SIZE);
    const rangeEnd = endChunkStart + endChunkEncryptedBytes - 1;

    const controller = new AbortController();
    s.currentFetches.add(controller);

    // Fire the network request immediately (runs in parallel with other fetches).
    // The catchall at the end prevents an unhandled rejection if this pipeline is discarded
    // by a seek/retry generation check before runChunkPipeline gets a chance to await it.
    const rawFetch = this.fetchRange(
      s.file.id,
      firstChunkStart,
      rangeEnd,
      controller,
      s,
      s.shareUuid,
    );
    const fetchPromise = rawFetch.then((blob) => blob.arrayBuffer());
    // Register a no-op rejection handler on BOTH legs of the chain so that if seek aborts the request
    // before the processLock lambda runs, the engine never sees an unhandled Promise rejection.
    rawFetch.catch(() => {});
    fetchPromise.catch(() => {});

    // Chain the processing of this fetch strictly after previous chunks have been processed.
    // The generation check at the start of runChunkPipeline ensures stale pipelines self-discard.
    const capturedGeneration = generation;
    const pipelinePromise = s.processLock.then(() => {
      // If a seek/retry happened while we were waiting in the lock queue, discard silently
      if (s.seekGeneration !== capturedGeneration || s.aborted) return;
      return this.runChunkPipeline(
        s,
        capturedGeneration,
        startChunkIdx,
        chunksToFetch,
        fetchPromise,
        videoElement,
      );
    });

    // Update processLock for the next chunk to chain after this one.
    // Use a catch-suppressed version to prevent rejection from breaking the next pipeline.
    s.processLock = pipelinePromise.then(
      () => {},
      () => {},
    );

    pipelinePromise
      .then(() => {
        // Guard: if a seek happened while we were processing, don't modify the new stream's counters.
        if (s.seekGeneration !== capturedGeneration) return;
        s.activeDownloads--;
        s.currentFetches.delete(controller);
        // Update download progress signal (must re-enter zone for signal reactivity).
        this.ngZone.run(() => {
          this.bufferProgress.set(Math.round((s.nextChunkIndex / s.totalChunks) * 100));
          this.signalEndOfStreamIfComplete(s);
        });
        // Immediately check if another chunk is needed.
        this.onTimeupdateTick(s, videoElement);
      })
      .catch((err) => {
        // Guard: if a seek happened, the counter was already reset — don't double-decrement.
        if (s.seekGeneration === capturedGeneration) {
          s.activeDownloads--;
          s.currentFetches.delete(controller);
        }
        if (!s.aborted && err?.name !== 'AbortError' && s.seekGeneration === capturedGeneration) {
          if (
            (err?.name === 'SourceBufferAppendError' || err?.message === 'Erro no appendBuffer.') &&
            (s.recoveryContext?.appendRestartsRemaining ?? 0) > 0
          ) {
            s.recoveryContext!.appendRestartsRemaining--;
            console.warn(
              '[VideoStream] Append error detected! Advancing playhead by 1 second to bypass corrupted chunk.',
              err,
            );
            void this.initializeStreamAttempt(
              videoElement,
              s.file,
              videoElement.currentTime + 1,
              s.recoveryContext,
            );
          } else {
            this.failStream(s, err?.message ?? 'Erro no pipeline de chunk.');
          }
        }
      });
  }

  /**
   * The full async pipeline for a batch of chunks:
   *   HTTP Range download (N chunks) -> Slice -> (Crypto Worker -> Transmux Worker -> append queue) x N.
   */
  private async runChunkPipeline(
    s: StreamState,
    generation: number,
    startChunkIdx: number,
    chunksToFetch: number,
    fetchPromise: Promise<ArrayBuffer>,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    if (s.aborted || s.seekGeneration !== generation) return; // Stale before wait

    // Wait for the parallel download to finish
    const fullBuffer = await fetchPromise;

    if (s.aborted || s.seekGeneration !== generation) return; // Stale after wait

    // Process chunks sequentially inside the worker so they stay in order
    let offset = 0;
    for (let i = 0; i < chunksToFetch; i++) {
      const currentChunkIdx = startChunkIdx + i;
      const isLastChunk = currentChunkIdx === s.totalChunks - 1;

      const chunkPlaintextBytes = isLastChunk
        ? s.plaintextSize - currentChunkIdx * KASUMI_CHUNK_SIZE
        : KASUMI_CHUNK_SIZE;
      const chunkEncryptedBytes = MAC_SIZE + chunkPlaintextBytes;

      const chunkBuffer = fullBuffer.slice(offset, offset + chunkEncryptedBytes);
      offset += chunkEncryptedBytes;

      // Decrypt.
      const decrypted = await this.sendToCryptoWorker(s, chunkBuffer, currentChunkIdx);
      if (s.aborted || s.seekGeneration !== generation) return;

      // Transmux.
      const { segments } = await this.sendToTransmuxWorker(
        s,
        decrypted,
        currentChunkIdx,
        isLastChunk,
      );
      if (s.aborted || s.seekGeneration !== generation) return;

      if (segments && segments.length > 0) {
        for (const seg of segments) {
          const sb = s.sourceBuffers.get(seg.id);
          if (sb) {
            await this.appendToSourceBuffer(s, generation, sb, seg.buffer, videoElement);
            if (s.aborted || s.seekGeneration !== generation) return;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4.2 -- Seeking (jump to arbitrary playhead position)
  // ---------------------------------------------------------------------------

  /**
   * Called when the user seeks to a new position in the video.
   */
  private onSeek(s: StreamState, videoElement: HTMLVideoElement): void {
    if (s.aborted) return;

    const seekTime = videoElement.currentTime;

    // Check if we are seeking within the already buffered range.
    // If so, we do not need to abort the current pipeline or start a new seek generation.
    // The browser will seamlessly play from the cache and onTimeupdateTick will naturally
    // resume fetching from the exact chunk it left off at.
    // A native decoder error invalidates the buffered fast path even when the
    // MSE ranges still contain the requested time.
    let alreadyBuffered = videoElement.error == null && s.sourceBuffers.size > 0;
    for (const sb of s.sourceBuffers.values()) {
      let covered = false;
      for (let r = 0; r < sb.buffered.length; r++) {
        if (sb.buffered.start(r) <= seekTime + 0.5 && sb.buffered.end(r) > seekTime) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        alreadyBuffered = false;
        break;
      }
    }

    if (alreadyBuffered) {
      this.ngZone.run(() => this.isSeeking.set(false));
      this.onTimeupdateTick(s, videoElement);
      return;
    }

    // -- Seek target is outside buffer. Abort in-flight HTTP. ----------------
    this.ngZone.run(() => this.isSeeking.set(true));
    s.currentFetches.forEach((c) => c.abort());
    s.currentFetches.clear();
    s.activeDownloads = 0;
    s.processLock = Promise.resolve();

    // -- Invalidate any in-flight worker callbacks. --------------------------
    s.seekGeneration++;
    const generation = s.seekGeneration;

    const duration = s.videoDuration > 0 ? s.videoDuration : videoElement.duration;
    void this.clearAndResume(s, generation, seekTime, duration, videoElement).catch((err: any) => {
      if (s.aborted || s.seekGeneration !== generation) return;
      this.ngZone.run(() => {
        this.error.set(err?.message ?? 'Erro desconhecido no streaming.');
        this.isSeeking.set(false);
      });
    });
  }

  private async clearAndResume(
    s: StreamState,
    generation: number,
    seekTime: number,
    duration: number,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    if (s.sourceBuffers.size === 0 || (s.mediaSource.readyState as string) === 'closed') {
      if (!s.aborted && s.seekGeneration === generation) {
        this.ngZone.run(() => this.isSeeking.set(false));
      }
      return;
    }

    // Wait until all ongoing appendBuffer or remove operations complete on all source buffers.
    for (const sb of s.sourceBuffers.values()) {
      await this.waitForSourceBufferIdle(sb, s.lifecycleController?.signal);
    }
    if (s.aborted || s.seekGeneration !== generation) return;

    // Only remove content that is strictly behind the seek window (GC before seekTime).
    // We deliberately PRESERVE everything that is buffered AHEAD of seekTime.
    const keepStart = Math.max(0, seekTime - GC_BEHIND_SECONDS);

    for (const sb of s.sourceBuffers.values()) {
      if (keepStart > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < keepStart) {
        await this.removeRange(s, sb, 0, keepStart);
        if (s.aborted || s.seekGeneration !== generation) return;
      }
    }

    // MP4Box chooses the byte and timeline reconstruction boundary.
    const seekResult = await this.sendSeekToTransmuxWorker(s, seekTime, generation);
    if (s.aborted || s.seekGeneration !== generation) return;

    const clearFrom = Math.max(0, Math.min(seekTime, seekResult.resumeTime));
    const chunkStart = seekResult.chunkIndex * KASUMI_CHUNK_SIZE;
    if (environment.logs.transmuxer) {
      console.log('[VideoStream] Seek resync:', {
        generation,
        requestedTime: seekTime,
        resumeTime: seekResult.resumeTime,
        exactOffset: seekResult.exactOffset,
        chunkIndex: seekResult.chunkIndex,
        chunkStart,
        offsetInsideChunk: seekResult.exactOffset - chunkStart,
      });
    }

    for (const sb of s.sourceBuffers.values()) {
      const mediaSourceEnded = s.mediaSource.readyState === 'ended';
      const hasForwardRange =
        sb.buffered.length > 0 && sb.buffered.end(sb.buffered.length - 1) > clearFrom;
      if (mediaSourceEnded || hasForwardRange) {
        await this.removeRange(
          s,
          sb,
          clearFrom,
          (duration || (s.totalChunks * KASUMI_CHUNK_SIZE) / (1 * 1024 * 1024)) + 1,
        );
        if (s.aborted || s.seekGeneration !== generation) return;
      }
    }

    if (s.mediaSource.readyState !== 'open') {
      throw new Error('MediaSource indisponivel apos a limpeza do seek.');
    }

    // Reset each idle MSE parser before re-entering the RAP-aligned sequence.
    for (const sb of s.sourceBuffers.values()) {
      if (s.aborted || s.seekGeneration !== generation) return;
      sb.abort();
    }

    s.nextChunkIndex = Math.min(seekResult.chunkIndex, s.totalChunks - 1);

    this.ngZone.run(() => this.isSeeking.set(false));

    // Resume buffering from the seek target chunk.
    this.scheduleNextChunk(s, videoElement);
  }

  // ---------------------------------------------------------------------------
  // Phase 4.3 -- Garbage Collection (eviction of stale SourceBuffer ranges)
  // ---------------------------------------------------------------------------

  /**
   * Evicts SourceBuffer content that is older than GC_BEHIND_SECONDS relative
   * to the current playhead. Called from onTimeupdateTick.
   */
  private async evictStaleRanges(
    s: StreamState,
    currentTime: number,
    generation: number = s.seekGeneration,
  ): Promise<void> {
    if (
      s.aborted ||
      s.seekGeneration !== generation ||
      s.isRemoving ||
      s.mediaSource.readyState !== 'open'
    )
      return;

    const evictUpTo = currentTime - GC_BEHIND_SECONDS;
    if (evictUpTo <= 0) return;

    for (const sb of s.sourceBuffers.values()) {
      if (s.aborted || s.seekGeneration !== generation) return;
      if (sb.updating) continue;
      if (sb.buffered.length === 0 || sb.buffered.start(0) >= evictUpTo) continue;

      try {
        await this.removeRange(s, sb, 0, evictUpTo);
        if (s.aborted || s.seekGeneration !== generation) return;
      } catch (err) {
        // ignore GC errors
      }
    }
  }

  private removeRange(s: StreamState, sb: SourceBuffer, start: number, end: number): Promise<void> {
    const mediaSourceEnded = s.mediaSource.readyState === 'ended';
    if (!sb || s.mediaSource.readyState === 'closed' || sb.updating) return Promise.resolve();

    s.isRemoving = true;
    return this.removeRangeRaw(
      sb,
      start,
      end,
      s.lifecycleController?.signal,
      SOURCE_BUFFER_OPERATION_TIMEOUT_MS,
      mediaSourceEnded,
    )
      .catch((error) => {
        if (error?.name === 'SourceBufferRemoveError') {
          throw new Error('SourceBuffer error during remove.');
        }
        throw error;
      })
      .finally(() => {
        s.isRemoving = false;
      });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap (Phase 3)
  // ---------------------------------------------------------------------------

  private readTopLevelBoxHeader(
    buffer: ArrayBuffer,
    offset: number,
  ): { type: number; size: number } | null {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.byteLength - 8)
      return null;
    const view = new DataView(buffer);
    const size32 = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (size32 === 1) {
      if (offset > buffer.byteLength - 16) return null;
      const high = view.getUint32(offset + 8);
      if (high > 0x1fffff) return null;
      const size = high * 0x1_0000_0000 + view.getUint32(offset + 12);
      return Number.isSafeInteger(size) && size >= 16 ? { type, size } : null;
    }
    return size32 >= 8 ? { type, size: size32 } : null;
  }

  private walkTopLevelBoxes(
    buffer: ArrayBuffer,
    offset = 0,
    fileStart = 0,
    plaintextSize = Number.MAX_SAFE_INTEGER,
  ): { moov: { offset: number; size: number } | null; nextTopLevelOffset: number | null } {
    const absent = { moov: null, nextTopLevelOffset: null };
    if (!Number.isSafeInteger(plaintextSize) || !Number.isSafeInteger(fileStart) ||
        fileStart < 0 || buffer.byteLength > plaintextSize - fileStart) return absent;
    while (offset <= buffer.byteLength - 8) {
      const header = this.readTopLevelBoxHeader(buffer, offset);
      if (!header) return absent;
      if (header.type === MOOV_FOURCC)
        return { moov: { offset, size: header.size }, nextTopLevelOffset: null };
      // Only a complete, bounded header can establish the next global box boundary.
      if (header.size > plaintextSize - fileStart - offset) return absent;
      if (header.size > buffer.byteLength - offset)
        return { moov: null, nextTopLevelOffset: fileStart + offset + header.size };

      offset += header.size;
    }
    return { moov: null, nextTopLevelOffset: offset === buffer.byteLength ? fileStart + offset : null };
  }

  private hasEbmlHeader(buffer: ArrayBuffer): boolean {
    return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0) === EBML_HEADER;
  }

  private async bootstrapLastChunk(s: StreamState): Promise<void> {
    if (!Number.isSafeInteger(s.plaintextSize) || s.plaintextSize <= 0)
      throw new Error('Metadados MP4 invalidos (tamanho fora dos limites).');
    // 1. We ALWAYS download chunk 0 first since we need the real ftyp box from the beginning of the file.
    const firstEncryptedBytes = MAC_SIZE + Math.min(KASUMI_CHUNK_SIZE, s.plaintextSize);
    const firstRangeStart = s.dataOffset;
    const firstRangeEnd = firstRangeStart + firstEncryptedBytes - 1;
    if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: downloading chunk 0...');

    const controller0 = new AbortController();
    s.currentFetches.add(controller0);
    let blob0: Blob;
    try {
      blob0 = await this.fetchRange(
        s.file.id,
        firstRangeStart,
        firstRangeEnd,
        controller0,
        s,
        s.shareUuid,
      );
    } finally {
      s.currentFetches.delete(controller0);
    }
    if (s.aborted) return;
    const buf0 = await blob0.arrayBuffer();
    if (environment.logs.transmuxer)
      console.log('[VideoStream] Decrypting chunk 0 for bootstrap...');
    const decryptedChunk0 = await this.sendToCryptoWorker(s, buf0, 0);
    if (s.aborted) return;
    if (this.hasEbmlHeader(decryptedChunk0)) {
      throw new Error(UNSUPPORTED_STREAMING_FORMAT_MESSAGE);
    }

    const len0 = decryptedChunk0.byteLength;
    const layout = this.walkTopLevelBoxes(decryptedChunk0, 0, 0, s.plaintextSize);
    const topLevelMoov = layout.moov;
    const moovOffsetInChunk0 = topLevelMoov?.offset ?? -1;
    const moovSizeInChunk0 = topLevelMoov?.size ?? 0;

    if (moovOffsetInChunk0 !== -1 && moovSizeInChunk0 > Number.MAX_SAFE_INTEGER - moovOffsetInChunk0)
      throw new Error('Metadados MP4 invalidos (tamanho do moov fora dos limites).');
    if (moovOffsetInChunk0 !== -1 && moovSizeInChunk0 > s.plaintextSize - moovOffsetInChunk0)
      throw new Error('Metadados MP4 invalidos (moov fora dos limites do arquivo).');
    const moovEndExclusive =
      moovOffsetInChunk0 === -1 ? -1 : moovOffsetInChunk0 + moovSizeInChunk0;
    const secondChunkEnd = Math.min(s.plaintextSize, 2 * KASUMI_CHUNK_SIZE);
    const moovCrossesIntoChunk1 =
      moovOffsetInChunk0 !== -1 &&
      Number.isSafeInteger(moovEndExclusive) &&
      moovEndExclusive > len0 &&
      moovEndExclusive <= secondChunkEnd &&
      s.totalChunks >= 2;

    if (moovOffsetInChunk0 !== -1 && moovEndExclusive > secondChunkEnd) {
      throw new Error('Metadados MP4 invalidos (moov exige mais de um chunk de continuacao).');
    }

    let initData: { id: number; codecString: string; buffer: ArrayBuffer }[] | undefined;
    let videoDuration: number | undefined;
    let initialSegments: any[] | undefined;

    if (moovOffsetInChunk0 !== -1 && moovEndExclusive <= len0) {
      // --- Fast-Start MP4: moov is in chunk 0 ---
      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] Bootstrap: moov found in chunk 0 (Fast-Start MP4) at offset:',
          moovOffsetInChunk0,
          'size:',
          moovSizeInChunk0,
        );
      const isOnlyChunk = s.totalChunks === 1;
      const res = await this.sendBootstrapToTransmuxWorker(
        s,
        decryptedChunk0,
        null,
        undefined,
        isOnlyChunk,
      );
      initData = res.initData;
      videoDuration = res.videoDuration;
      initialSegments = res.segments;
      // Mark chunk 0 as already processed so scheduleNextChunk starts at chunk 1.
      s.nextChunkIndex = 1;
    } else if (moovCrossesIntoChunk1) {
      // --- Boundary-crossing MP4: feed the complete plaintext chunk 1 incrementally. ---
      const continuationChunkPlaintextBytes = secondChunkEnd - KASUMI_CHUNK_SIZE;
      const continuationChunkEncryptedBytes = MAC_SIZE + continuationChunkPlaintextBytes;
      const continuationRangeStart =
        s.dataOffset + KASUMI_CHUNK_SIZE + MAC_SIZE;
      const continuationRangeEnd =
        continuationRangeStart + continuationChunkEncryptedBytes - 1;
      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] Bootstrap: moov crosses chunk 0 into chunk 1; downloading continuation.',
        );

      const continuationController = new AbortController();
      s.currentFetches.add(continuationController);
      let continuationBlob: Blob;
      try {
        continuationBlob = await this.fetchRange(
          s.file.id,
          continuationRangeStart,
          continuationRangeEnd,
          continuationController,
          s,
          s.shareUuid,
        );
      } finally {
        s.currentFetches.delete(continuationController);
      }
      if (s.aborted) return;

      const continuationBuffer = await continuationBlob.arrayBuffer();
      const decryptedChunk1 = await this.sendToCryptoWorker(s, continuationBuffer, 1);
      if (s.aborted) return;

      const res = await this.sendBootstrapToTransmuxWorker(
        s,
        decryptedChunk0,
        decryptedChunk1,
        KASUMI_CHUNK_SIZE,
        s.totalChunks === 2,
      );
      initData = res.initData;
      videoDuration = res.videoDuration;
      initialSegments = res.segments;
      // Bootstrap consumed chunks 0 and 1; normal streaming starts at chunk 2.
      s.nextChunkIndex = 2;
    } else {
      // --- Standard MP4: moov is in the last chunk ---
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Bootstrap: moov NOT in chunk 0. Downloading last chunk...');
      const lastChunkIndex = s.totalChunks - 1;
      const lastChunkGlobalStart = lastChunkIndex * KASUMI_CHUNK_SIZE;
      const tailStart = layout.nextTopLevelOffset;
      if (tailStart === null)
        throw new Error('Metadados de video nao encontrados (moov atom ausente).');
      if (!Number.isSafeInteger(lastChunkGlobalStart) || tailStart < lastChunkGlobalStart ||
          tailStart >= s.plaintextSize)
        throw new Error('Metadados MP4 invalidos (tail estrutural fora do ultimo chunk).');
      const lastPlaintextBytes = s.plaintextSize - lastChunkGlobalStart;
      const lastEncryptedBytes = MAC_SIZE + lastPlaintextBytes;
      const lastRangeStart = s.dataOffset + lastChunkIndex * (KASUMI_CHUNK_SIZE + MAC_SIZE);
      const lastRangeEnd = lastRangeStart + lastEncryptedBytes - 1;
      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] Bootstrap last chunk idx:',
          lastChunkIndex,
          'rangeStart:',
          lastRangeStart,
          'rangeEnd:',
          lastRangeEnd,
        );

      const controller = new AbortController();
      s.currentFetches.add(controller);
      let encChunkBlob: Blob;
      try {
        encChunkBlob = await this.fetchRange(
          s.file.id,
          lastRangeStart,
          lastRangeEnd,
          controller,
          s,
          s.shareUuid,
        );
      } finally {
        s.currentFetches.delete(controller);
      }
      if (s.aborted) return;
      if (environment.logs.transmuxer)
        console.log('[VideoStream] Bootstrap last chunk download size:', encChunkBlob.size);
      const encChunkBuffer = await encChunkBlob.arrayBuffer();

      if (environment.logs.transmuxer) console.log('[VideoStream] Decrypting last chunk...');
      const decryptedLast = await this.sendToCryptoWorker(s, encChunkBuffer, lastChunkIndex);
      if (s.aborted) return;

      const tailMoov = this.walkTopLevelBoxes(
        decryptedLast, tailStart - lastChunkGlobalStart, lastChunkGlobalStart, s.plaintextSize,
      ).moov;
      if (!tailMoov || tailMoov.size > decryptedLast.byteLength - tailMoov.offset ||
          tailMoov.size > s.plaintextSize - lastChunkGlobalStart - tailMoov.offset) {
        throw new Error('Metadados de video nao encontrados (moov atom ausente).');
      }
      const { offset: moovOffsetInLast, size: moovSizeInLast } = tailMoov;

      if (environment.logs.transmuxer)
        console.log(
          '[VideoStream] Bootstrap: moov found in last chunk at offset:',
          moovOffsetInLast,
          'size:',
          moovSizeInLast,
        );
      const moovBytes = decryptedLast.slice(moovOffsetInLast, moovOffsetInLast + moovSizeInLast);
      const realMoovOffset = lastChunkGlobalStart + moovOffsetInLast;

      const res = await this.sendBootstrapToTransmuxWorker(
        s,
        decryptedChunk0,
        moovBytes,
        realMoovOffset,
      );
      initData = res.initData;
      videoDuration = res.videoDuration;
      initialSegments = res.segments;

      // Standard MP4 needs chunk 0 again to start feeding video data (since we only fed it to get ftyp in bootstrap)
      s.nextChunkIndex = 0;
    }

    if (environment.logs.transmuxer)
      console.log(
        '[VideoStream] Transmux result initData tracks:',
        initData?.length,
        'duration:',
        videoDuration,
      );
    if (s.aborted) return;

    if (videoDuration && videoDuration > 0) {
      s.videoDuration = videoDuration;
      try {
        s.mediaSource.duration = videoDuration;
      } catch (e) {
        // ignore
      }

      // Check for originalBitrateWarning: sizeBytes / duration > 5MB/s
      const bitrate = s.file.sizeBytes / videoDuration;
      if (bitrate > 5 * 1024 * 1024) {
        this.ngZone.run(() => this.originalBitrateWarning.set(true));
      } else {
        this.ngZone.run(() => this.originalBitrateWarning.set(false));
      }
    }

    if (initData && initData.length > 0) {
      for (const track of initData) {
        if (!s.sourceBuffers.has(track.id)) {
          try {
            if (environment.logs.transmuxer)
              console.log(
                '[VideoStream] Adding SourceBuffer for track:',
                track.id,
                'codec:',
                track.codecString,
              );
            const sb = s.mediaSource.addSourceBuffer(track.codecString);
            s.sourceBuffers.set(track.id, sb);
            s.codecStrings.set(track.id, track.codecString);
          } catch (e) {
            console.error(
              '[VideoStream] Failed to add SourceBuffer for track',
              track.id,
              track.codecString,
              e,
            );
            throw e;
          }
        }
        const sb = s.sourceBuffers.get(track.id);
        if (sb) {
          await this.appendToSourceBufferRaw(sb, track.buffer, s.lifecycleController?.signal);
        }
      }

      if (initialSegments && initialSegments.length > 0) {
        if (environment.logs.transmuxer)
          console.log(
            '[VideoStream] Appending',
            initialSegments.length,
            'segments generated during bootstrap',
          );
        for (const seg of initialSegments) {
          const sb = s.sourceBuffers.get(seg.id);
          if (sb && seg.buffer.byteLength > 0) {
            await this.appendToSourceBufferRaw(sb, seg.buffer, s.lifecycleController?.signal);
          }
        }
      }
    } else {
      throw new Error('Nenhuma faixa de audio ou video encontrada.');
    }

    this.signalEndOfStreamIfComplete(s);
  }

  // ---------------------------------------------------------------------------
  // Worker communication helpers
  // ---------------------------------------------------------------------------

  private waitForWorkerResponse<T>(
    worker: Worker,
    signal: AbortSignal | undefined,
    response: (data: any) => { value: T } | { error: Error } | null,
    send: () => void,
    workerError: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
        signal?.removeEventListener('abort', onAbort);
        if (timeoutId !== null) clearTimeout(timeoutId);
      };
      const finishResolve = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onMessage = (event: MessageEvent) => {
        try {
          const result = response(event.data);
          if (!result) return;
          if ('error' in result) finishReject(result.error);
          else finishResolve(result.value);
        } catch (error) {
          finishReject(error);
        }
      };
      const onError = () => finishReject(new Error(workerError));
      const onMessageError = () => finishReject(new Error(workerError));
      const onAbort = () => finishReject(this.createAbortError());

      if (signal?.aborted) {
        onAbort();
        return;
      }

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(() => {
        const error = Object.assign(
          new Error('Tempo limite excedido aguardando resposta do worker.'),
          { name: 'WorkerResponseTimeoutError' },
        );
        finishReject(error);
      }, WORKER_RESPONSE_TIMEOUT_MS);

      try {
        send();
      } catch (error) {
        finishReject(error);
      }
    });
  }

  private sendToCryptoWorker(
    s: StreamState,
    encryptedChunk: ArrayBuffer,
    chunkIndex: number,
  ): Promise<ArrayBuffer> {
    return this.waitForWorkerResponse<ArrayBuffer>(
      s.cryptoWorker,
      s.lifecycleController?.signal,
      (data) => {
        if (data.chunkIndex !== chunkIndex) return null;
        if (data.type === 'CHUNK_DECRYPTED') return { value: data.decryptedChunk as ArrayBuffer };
        return { error: new Error(data.message ?? 'Crypto worker error.') };
      },
      () => {
        const fdkCopy = s.fdk.slice();
        const baseNonceCopy = s.baseNonce.slice();
        try {
          s.cryptoWorker.postMessage(
            {
              type: 'DECRYPT_CHUNK',
              encryptedChunk,
              fdk: fdkCopy.buffer,
              baseNonce: baseNonceCopy.buffer,
              chunkIndex,
            },
            [encryptedChunk, fdkCopy.buffer, baseNonceCopy.buffer],
          );
        } catch (error) {
          fdkCopy.fill(0);
          baseNonceCopy.fill(0);
          throw error;
        }
      },
      'Falha no processamento criptográfico do vídeo.',
    );
  }

  private sendBootstrapToTransmuxWorker(
    s: StreamState,
    chunk0: ArrayBuffer,
    moovBytes: ArrayBuffer | null,
    moovOffset?: number,
    isLastChunk: boolean = false,
  ): Promise<{
    initData?: { id: number; codecString: string; buffer: ArrayBuffer }[];
    videoDuration?: number;
    segments?: any[];
  }> {
    return this.waitForWorkerResponse<{
      initData?: { id: number; codecString: string; buffer: ArrayBuffer }[];
      videoDuration?: number;
      segments?: any[];
    }>(
      s.transmuxWorker,
      s.lifecycleController?.signal,
      (data) => {
        if (data.type === 'BOOTSTRAP_COMPLETE') {
          return {
            value: {
              initData: data.initData as
                { id: number; codecString: string; buffer: ArrayBuffer }[] | undefined,
              videoDuration: data.videoDuration as number | undefined,
              segments: data.segments as any[] | undefined,
            },
          };
        }
        if (data.type === 'ERROR') {
          return { error: new Error(data.message ?? 'Transmux bootstrap error.') };
        }
        return null;
      },
      () => {
        const transferables: Transferable[] = [chunk0];
        if (moovBytes) transferables.push(moovBytes);
        s.transmuxWorker.postMessage(
          {
            type: 'BOOTSTRAP',
            chunk0,
            moovBytes,
            moovOffset,
            isLastChunk,
          },
          transferables,
        );
      },
      'Falha no processamento do vídeo.',
    );
  }

  private sendSeekToTransmuxWorker(
    s: StreamState,
    seekTime: number,
    generation: number,
  ): Promise<{ chunkIndex: number; resumeTime: number; exactOffset: number }> {
    return this.waitForWorkerResponse<{
      chunkIndex: number;
      resumeTime: number;
      exactOffset: number;
    }>(
      s.transmuxWorker,
      s.lifecycleController?.signal,
      (data) => {
        if (data.generation !== generation) return null;
        if (data.type === 'SEEK_COMPLETE') {
          return {
            value: {
              chunkIndex: data.chunkIndex as number,
              resumeTime: data.resumeTime as number,
              exactOffset: data.exactOffset as number,
            },
          };
        }
        if (data.type === 'ERROR') {
          return { error: new Error(data.message ?? 'Transmux worker error.') };
        }
        return null;
      },
      () => s.transmuxWorker.postMessage({ type: 'SEEK', time: seekTime, generation }),
      'Falha no processamento do vídeo.',
    );
  }

  private sendToTransmuxWorker(
    s: StreamState,
    decryptedChunk: ArrayBuffer,
    chunkIndex: number,
    isLastChunk: boolean,
  ): Promise<{ segments: { id: number; buffer: ArrayBuffer }[] }> {
    return this.waitForWorkerResponse<{ segments: { id: number; buffer: ArrayBuffer }[] }>(
      s.transmuxWorker,
      s.lifecycleController?.signal,
      (data) => {
        if (data.chunkIndex !== chunkIndex) return null;
        if (data.type === 'CHUNK_TRANSMUXED') {
          return {
            value: {
              segments: data.segments as { id: number; buffer: ArrayBuffer }[],
            },
          };
        }
        return { error: new Error(data.message ?? 'Transmux worker error.') };
      },
      () =>
        s.transmuxWorker.postMessage(
          {
            type: 'TRANSMUX_CHUNK',
            decryptedChunk,
            chunkIndex,
            isLastChunk,
          },
          [decryptedChunk],
        ),
      'Falha no processamento do vídeo.',
    );
  }

  // ---------------------------------------------------------------------------
  // SourceBuffer helpers
  // ---------------------------------------------------------------------------

  /**
   * Appends one ArrayBuffer to the SourceBuffer; awaits 'updateend'.
   * Recovers aggressively from QuotaExceededError by clearing old ranges and retrying.
   */
  private async appendToSourceBuffer(
    s: StreamState,
    generation: number,
    sb: SourceBuffer,
    buffer: ArrayBuffer,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    if (s.aborted || s.seekGeneration !== generation) return;
    if (!sb || (s.mediaSource.readyState as string) === 'closed') {
      throw new Error('SourceBuffer indisponivel (closed).');
    }

    let recoveryDeadline: number | null = null;
    while (!s.aborted && s.seekGeneration === generation) {
      if ((s.mediaSource.readyState as string) === 'closed') {
        throw new Error('SourceBuffer indisponivel (closed).');
      }
      try {
        const timeout = recoveryDeadline === null
          ? SOURCE_BUFFER_OPERATION_TIMEOUT_MS
          : this.remainingRecoveryMs(recoveryDeadline);
        if (timeout <= 0) throw this.createRecoveryTimeoutError();
        await this.waitForSourceBufferIdle(sb, s.lifecycleController?.signal, timeout);
        if (s.aborted || s.seekGeneration !== generation) return;
        await this.appendToSourceBufferRaw(
          sb,
          buffer,
          s.lifecycleController?.signal,
          recoveryDeadline === null
            ? SOURCE_BUFFER_OPERATION_TIMEOUT_MS
            : this.remainingRecoveryMs(recoveryDeadline),
        );
        return; // Success!
      } catch (err: any) {
        // QuotaExceededError may be thrown synchronously by appendBuffer() or via the error event.
        // We check both the original error and any wrapped variant.
        const isQuota = err.name === 'QuotaExceededError' || err.isQuotaExceeded === true;
        if (isQuota) {
          if (s.aborted || s.seekGeneration !== generation) return;
          recoveryDeadline ??= Date.now() + SOURCE_BUFFER_RECOVERY_BUDGET_MS;
          if (this.remainingRecoveryMs(recoveryDeadline) <= 0) {
            throw this.createRecoveryTimeoutError();
          }
          // Try to evict old content behind the playhead first.
          const evictUpTo = Math.max(0, videoElement.currentTime - 2);
          if (evictUpTo > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < evictUpTo) {
            const remaining = this.remainingRecoveryMs(recoveryDeadline);
            await this.waitForSourceBufferIdle(sb, s.lifecycleController?.signal, Math.min(
              SOURCE_BUFFER_OPERATION_TIMEOUT_MS,
              remaining,
            ));
            if (s.aborted || s.seekGeneration !== generation) return;
            await this.removeRangeRaw(
              sb,
              0,
              evictUpTo,
              s.lifecycleController?.signal,
              Math.min(SOURCE_BUFFER_OPERATION_TIMEOUT_MS, this.remainingRecoveryMs(recoveryDeadline)),
            );
            if (s.aborted || s.seekGeneration !== generation) return;
            continue; // Retry append immediately after eviction
          }
          // Nothing to evict yet — the playhead is still at the beginning.
          // Wait for the video to play forward, then retry every 500ms for up to 30s.
          console.warn(
            '[VideoStream] SourceBuffer QuotaExceeded. Waiting for playback to free space...',
          );
          while (!s.aborted && s.seekGeneration === generation) {
            const remaining = this.remainingRecoveryMs(recoveryDeadline);
            if (remaining <= 0) throw this.createRecoveryTimeoutError();
            await this.delay(
              Math.min(SOURCE_BUFFER_RECOVERY_DELAY_MS, remaining),
              s.lifecycleController?.signal,
            );
            if (this.remainingRecoveryMs(recoveryDeadline) <= 0) {
              throw this.createRecoveryTimeoutError();
            }
            if (s.aborted || s.seekGeneration !== generation) return;
            if ((s.mediaSource.readyState as string) === 'closed') break;
            const canEvict = videoElement.currentTime - 2;
            if (canEvict > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < canEvict) {
              const waitRemaining = this.remainingRecoveryMs(recoveryDeadline);
              await this.waitForSourceBufferIdle(
                sb,
                s.lifecycleController?.signal,
                Math.min(SOURCE_BUFFER_OPERATION_TIMEOUT_MS, waitRemaining),
              );
              if (s.aborted || s.seekGeneration !== generation) return;
              await this.removeRangeRaw(
                sb,
                0,
                canEvict,
                s.lifecycleController?.signal,
                Math.min(SOURCE_BUFFER_OPERATION_TIMEOUT_MS, this.remainingRecoveryMs(recoveryDeadline)),
              );
              if (s.aborted || s.seekGeneration !== generation) return;
              break; // Retry the outer while loop
            }
          }
        } else {
          throw err;
        }
      }
    }
  }

  private appendToSourceBufferRaw(
    sb: SourceBuffer,
    buffer: ArrayBuffer,
    signal?: AbortSignal,
    timeoutMs = SOURCE_BUFFER_OPERATION_TIMEOUT_MS,
  ): Promise<void> {
    return this.runSourceBufferOperation(
      sb,
      () => sb.appendBuffer(buffer),
      signal,
      timeoutMs,
      'SourceBufferAppendError',
      true,
    );
  }

  private removeRangeRaw(
    sb: SourceBuffer,
    start: number,
    end: number,
    signal?: AbortSignal,
    timeoutMs = SOURCE_BUFFER_OPERATION_TIMEOUT_MS,
    rejectSynchronousError = false,
  ): Promise<void> {
    return this.runSourceBufferOperation(
      sb,
      () => sb.remove(start, end),
      signal,
      timeoutMs,
      'SourceBufferRemoveError',
      rejectSynchronousError,
    );
  }

  /** Waits until SourceBuffer.updating is false or an operation boundary settles. */
  private waitForSourceBufferIdle(
    sb: SourceBuffer,
    signal?: AbortSignal,
    timeoutMs = SOURCE_BUFFER_OPERATION_TIMEOUT_MS,
  ): Promise<void> {
    if (!sb.updating) return Promise.resolve();
    if (timeoutMs <= 0) return Promise.reject(this.createSourceBufferTimeoutError());
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        sb.removeEventListener('abort', onSourceAbort);
        signal?.removeEventListener('abort', onAbort);
        if (timeoutId !== null) clearTimeout(timeoutId);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onUpdateEnd = () => finish(resolve);
      const onError = () => finish(() => reject(new Error('Erro no SourceBuffer.')));
      const onSourceAbort = () => finish(() => reject(this.createSourceBufferAbortError()));
      const onAbort = () => finish(() => reject(this.createAbortError()));
      const onTimeout = () =>
        finish(() => reject(this.createSourceBufferTimeoutError()));

      if (signal?.aborted) {
        onAbort();
        return;
      }
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      sb.addEventListener('abort', onSourceAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }

  private runSourceBufferOperation(
    sb: SourceBuffer,
    operation: () => void,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    asyncErrorName: string,
    rejectSynchronousError: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        sb.removeEventListener('abort', onSourceAbort);
        signal?.removeEventListener('abort', onAbort);
        if (timeoutId !== null) clearTimeout(timeoutId);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onUpdateEnd = () => finish(resolve);
      const onError = () =>
        finish(() =>
          reject(Object.assign(new Error(
            asyncErrorName === 'SourceBufferAppendError'
              ? 'Erro no appendBuffer.'
              : 'Erro no remove.',
          ), { name: asyncErrorName })),
        );
      const onSourceAbort = () => finish(() => reject(this.createSourceBufferAbortError()));
      const onAbort = () => finish(() => reject(this.createAbortError()));
      const onTimeout = () => finish(() => reject(this.createSourceBufferTimeoutError()));

      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (timeoutMs <= 0) {
        onTimeout();
        return;
      }
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      sb.addEventListener('abort', onSourceAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
      try {
        operation();
      } catch (error) {
        if (rejectSynchronousError) finish(() => reject(error));
        else finish(() => resolve());
      }
    });
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(this.createAbortError());
        return;
      }
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(this.createAbortError());
      };
      timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private remainingRecoveryMs(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  private createRecoveryTimeoutError(): Error {
    return Object.assign(new Error('Não foi possível liberar espaço no buffer de vídeo.'), {
      name: 'SourceBufferRecoveryTimeoutError',
    });
  }

  private createSourceBufferTimeoutError(): Error {
    return Object.assign(new Error('Tempo limite excedido na operação do SourceBuffer.'), {
      name: 'SourceBufferOperationTimeoutError',
    });
  }

  private createSourceBufferAbortError(): Error {
    return Object.assign(new Error('Operação do SourceBuffer abortada.'), {
      name: 'SourceBufferAbortError',
    });
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Fetches a byte range from the backend with AbortController support.
   * Includes exponential backoff retry logic.
   */
  private async fetchRange(
    fileId: number,
    start: number,
    end: number,
    controller: AbortController,
    googleCredentials: GoogleRangeCredentials | null = null,
    shareUuid: string | null = null,
  ): Promise<Blob> {
    if (environment.logs.transmuxer)
      console.log('[VideoStream] fetchRange start:', start, 'end:', end);

    const hasGoogleUrl = !!googleCredentials?.gdriveUrl;
    const hasGoogleToken = !!googleCredentials?.gdriveToken;
    const isGoogleRange = !shareUuid && (hasGoogleUrl || hasGoogleToken);
    if (isGoogleRange && (!hasGoogleUrl || !hasGoogleToken)) {
      return Promise.reject(new Error('Credenciais do Google Drive indisponíveis.'));
    }

    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let subscription: Subscription | null = null;
      let authRecoveryUsed = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlineAt = Date.now() + DRIVE_CHUNK_REQUEST_DEADLINE_MS;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', abortHandler);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        subscription?.unsubscribe();
        callback();
      };
      const abortHandler = () => {
        if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange aborted');
        finish(() => reject(this.createAbortError()));
      };
      if (controller.signal.aborted) {
        if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange already aborted');
        reject(this.createAbortError());
        return;
      }
      controller.signal.addEventListener('abort', abortHandler, { once: true });
      deadlineTimer = setTimeout(() => finish(() => reject(new NetworkDeadlineError())), DRIVE_CHUNK_REQUEST_DEADLINE_MS);

      const requestRange = () => {
        if (settled) return;
        if (controller.signal.aborted) {
          finish(() => reject(this.createAbortError()));
          return;
        }

        const requestUrl = googleCredentials?.gdriveUrl ?? null;
        const requestToken = googleCredentials?.gdriveToken ?? null;
        const request$ = shareUuid
          ? this.shareService.downloadSharedFileRange(shareUuid, start, end)
          : isGoogleRange
            ? this.driveService.downloadExternalFileRange(requestUrl!, requestToken!, start, end)
            : this.driveService.downloadFileRange(fileId, start, end);

        subscription = request$
          .pipe(
            retry({
              count: 3,
              delay: (error, retryCount) => {
                const status = this.httpStatus(error);
                if (
                  controller.signal.aborted ||
                  error?.name === 'AbortError' ||
                  (isGoogleRange && (status === 401 || status === 403))
                ) {
                  throw error;
                }
                console.warn('[VideoStream] fetchRange retryCount:', retryCount);
                // Exponential backoff: 1s, 2s, 4s
                return timer(Math.pow(2, retryCount - 1) * 1000);
              },
            }),
          )
          .subscribe({
            next: (blob) => {
              if (environment.logs.transmuxer)
                console.log('[VideoStream] fetchRange complete size:', blob.size);
              finish(() => resolve(blob));
            },
            error: (err) => {
              if (isGoogleRange && this.httpStatus(err) === 401 && !authRecoveryUsed) {
                authRecoveryUsed = true;
                void this.refreshGoogleCredentials(
                  fileId,
                  googleCredentials!,
                  requestUrl!,
                  requestToken!,
                  controller.signal,
                  () => !settled,
                  Math.min(DRIVE_CONTROL_REQUEST_DEADLINE_MS, Math.max(1, deadlineAt - Date.now())),
                )
                  .then(() => requestRange())
                  .catch((refreshError) => finish(() => reject(refreshError)));
                return;
              }
              console.error('[VideoStream] fetchRange failed');
              finish(() => reject(err));
            },
          });
        if (settled) subscription.unsubscribe();
      };

      requestRange();
    });
  }

  private async refreshGoogleCredentials(
    fileId: number,
    credentials: GoogleRangeCredentials,
    failedUrl: string,
    failedToken: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
    deadlineMs: number,
  ): Promise<void> {
    if (credentials.gdriveUrl !== failedUrl || credentials.gdriveToken !== failedToken) return;

    const metadata = await firstValueFromAbortable(
      this.driveService.downloadExternalMetadata(fileId),
      signal,
      deadlineMs,
    );
    if (signal.aborted) throw this.createAbortError();
    if (!isCurrent()) return;
    if (credentials.gdriveUrl !== failedUrl || credentials.gdriveToken !== failedToken) return;
    if (!metadata.external_file_id || !metadata.access_token) {
      throw new Error('Credenciais do Google Drive indisponíveis.');
    }

    credentials.gdriveUrl = `https://www.googleapis.com/drive/v3/files/${metadata.external_file_id}?alt=media`;
    credentials.gdriveToken = metadata.access_token;
  }

  private httpStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }

  private waitForSourceOpen(mediaSource: MediaSource, signal?: AbortSignal): Promise<void> {
    if (mediaSource.readyState === 'open') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        mediaSource.removeEventListener('sourceopen', onOpen);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onOpen = () => finish(resolve);
      const onAbort = () => finish(() => reject(this.createAbortError()));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private signalEndOfStreamIfComplete(s: StreamState): void {
    if (
      s.aborted ||
      this.state !== s ||
      s.nextChunkIndex < s.totalChunks ||
      s.activeDownloads !== 0
    ) {
      return;
    }
    this.signalEndOfStream(s);
  }

  private signalEndOfStream(s: StreamState): void {
    if (s.mediaSource.readyState === 'open') {
      try {
        s.mediaSource.endOfStream();
      } catch {
        /* already closed */
      }
    }
    this.ngZone.run(() => this.isStreaming.set(false));
  }
}
