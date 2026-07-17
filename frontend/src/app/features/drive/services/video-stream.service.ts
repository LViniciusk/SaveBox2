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
 *      - Instead of a greedy sequential download loop, the service now listens
 *        to the 'timeupdate' event of the HTMLVideoElement.
 *      - On every tick it computes how many seconds of video are already
 *        buffered ahead of the playhead (using SourceBuffer.buffered).
 *      - If the look-ahead falls below BUFFER_AHEAD_SECONDS and no chunk is
 *        currently being fetched, it schedules the next chunk.
 *
 *   2. Seeking (jump to arbitrary playhead position)
 *      - A 'seeking' event listener is registered on the video element.
 *      - On seek: any in-flight HTTP request is aborted via AbortController,
 *        the SourceBuffer is cleared (sb.remove), the transmux worker is
 *        reset, and the download resumes from the chunk that contains the
 *        seek target timestamp.
 *      - Seeking maths:
 *          chunkIndex = floor((seekTime / videoDuration) * totalChunks)
 *        This maps wall-clock seek time linearly to the chunk index, which is
 *        accurate for CBR video. VBR video requires an index or moov/stts
 *        parse; the transmux worker provides duration metadata when available.
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
 *   CPU pipeline RAM <= MAX_PIPELINE_SLOTS * (MAC_SIZE + CHUNK_SIZE) = 12 MB
 *
 * Race Condition Guards
 * ---------------------
 *   - s.isFetching        prevents overlapping HTTP+Worker pipelines.
 *   - s.isAppending       prevents overlapping appendBuffer calls.
 *   - s.isRemoving        prevents overlapping sb.remove calls.
 *   - s.seekGeneration    is incremented on every seek; stale pipeline
 *                         responses detect a mismatch and self-discard.
 *   - All SourceBuffer mutations wait for 'updateend' before proceeding.
 */

import { Injectable, signal, inject, NgZone } from '@angular/core';
import { firstValueFrom, timer } from 'rxjs';
import { retry } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService }  from '../services/drive.service';
import { DriveFile, DriveStore } from '../state/drive.store';

// ---------------------------------------------------------------------------
// On-disk format constants (must mirror Kasumi XChaCha20 layout exactly).
// ---------------------------------------------------------------------------

/** File header: 24-byte base nonce + 8-byte uint64-LE plaintext size. */
const HEADER_SIZE = 32;
const NONCE_SIZE  = 24;
const MAC_SIZE    = 16;
/** Plaintext capacity per encrypted chunk. */
const CHUNK_SIZE  = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Buffering / GC policy constants.
// ---------------------------------------------------------------------------

/**
 * Minimum seconds of buffered video required ahead of the playhead before
 * the service schedules another chunk download. Low values increase HTTP
 * request frequency; high values increase RAM pressure.
 */
const BUFFER_AHEAD_SECONDS = 15;

/**
 * Seconds of already-played video the service retains in the SourceBuffer
 * for backward seeks without re-downloading. Everything older is evicted.
 */
const GC_BEHIND_SECONDS = 10;

/**
 * Maximum number of fMP4 segments allowed in the in-memory append queue.
 * This bounds RAM between the transmux worker output and SourceBuffer input.
 */
const MAX_PIPELINE_SLOTS = 3;

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
  nextChunkIndex: number;     // Index of the next chunk to download.
  isFetching: boolean;        // True while an HTTP+Worker pipeline is active.
  isRemoving: boolean;        // True while SourceBuffer.remove is active.

  /**
   * Incremented on every seek. Any pipeline callback that captures an older
   * generation value discards its result instead of appending it.
   */
  seekGeneration: number;

  /** AbortController for the current in-flight HTTP Range request. */
  currentFetch: AbortController | null;

  seekDebounceTimeout: any | null;

  /** Whether the stream has been fully destroyed. */
  aborted: boolean;

  silentRetryCount: number;
  lastSilentRetryTime: number;

  // Video element binding references
  videoElement: HTMLVideoElement;
  videoUrl: string;
  gdriveUrl: string | null;
  gdriveToken: string | null;

  // Event listener cleanup handles
  removeVideoListeners: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class VideoStreamService {
  private readonly cryptoService = inject(CryptoService);
  private readonly driveService  = inject(DriveService);
  private readonly ngZone        = inject(NgZone);
  private readonly driveStore    = inject(DriveStore);

  // Public reactive state for component bindings.
  readonly isStreaming    = signal(false);
  readonly bufferProgress = signal(0);     // 0..100; buffered chunks / total.
  readonly isSeeking      = signal(false); // True while seek pipeline runs.
  readonly isBuffering    = signal(true);  // True when video is stalling for data.
  readonly error          = signal<string | null>(null);
  readonly originalBitrateWarning = signal(false);

  private state: StreamState | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Attaches a secure streaming session to the given HTMLVideoElement.
   * Safe to call multiple times -- destroys any previous session first.
   */
  async initializeStream(videoElement: HTMLVideoElement, file: DriveFile, initialSeekTime?: number, previousRetryCount = 0, previousRetryTime = 0): Promise<void> {
    this.destroyStream();
    this.error.set(null);
    this.isStreaming.set(true);
    this.bufferProgress.set(0);
    this.isSeeking.set(false);
    this.isBuffering.set(true);
    this.originalBitrateWarning.set(false);

    if (!this.cryptoService.isVaultUnlocked()) {
      this.error.set('Drive trancado. Desbloqueie o drive antes de reproduzir.');
      this.isStreaming.set(false);
      return;
    }
    
    // Procura por versão otimizada (proxy) do vídeo
    let fileToPlay = file;
    if (this.driveStore && !file.forceOriginal) {
      // Tenta achar a versão proxy (otimizada H.264 720p) caso exista
      const allFiles = this.driveStore.files();
      const proxyName = file.decryptedName + '.proxy.mp4';
      const legacyProxyName = '__PROXY__' + file.decryptedName;
      const proxyFile = allFiles.find(f => (f.decryptedName === proxyName || f.decryptedName === legacyProxyName) && f.folderId === file.folderId);
      if (proxyFile) {
        if (environment.logs.transmuxer) console.log('[VideoStream] Proxy version found! Using optimized stream instead of original master.');
        fileToPlay = proxyFile;
      }
    }
    
    if (!fileToPlay.encryptedFdk) {
      this.error.set('FDK ausente nos metadados do arquivo.');
      this.isStreaming.set(false);
      return;
    }

    try {
      if (environment.logs.transmuxer) console.log('[VideoStream] initializeStream started', fileToPlay);
      // --- Step 1: Decrypt the File Data Key from the Vault. -----------------
      const fdkBase64 = await this.cryptoService.decryptName(fileToPlay.encryptedFdk);
      const fdkString = atob(fdkBase64);
      const fdk       = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) fdk[i] = fdkString.charCodeAt(i);

      let gdriveUrl: string | null = null;
      let gdriveToken: string | null = null;

      if (fileToPlay.storageProvider === 'google_drive') {
        if (environment.logs.transmuxer) console.log('[VideoStream] Loading Google Drive metadata for file ID:', fileToPlay.id);
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(fileToPlay.id));
        gdriveUrl = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
        gdriveToken = meta.access_token;
      }

      if (environment.logs.transmuxer) console.log('[VideoStream] Fetching header...');
      // --- Step 2: Download the 32-byte file header. -------------------------
      const headerBlob    = await this.fetchRange(fileToPlay.id, 0, HEADER_SIZE - 1, new AbortController(), gdriveUrl, gdriveToken);
      if (environment.logs.transmuxer) console.log('[VideoStream] Header blob fetched size:', headerBlob.size);
      const headerBuffer  = await headerBlob.arrayBuffer();
      const baseNonce     = new Uint8Array(headerBuffer, 0, NONCE_SIZE);
      const headerView    = new DataView(headerBuffer);
      const plaintextSize = Number(headerView.getBigUint64(NONCE_SIZE, true));
      const totalChunks   = Math.ceil(plaintextSize / CHUNK_SIZE);
      if (environment.logs.transmuxer) console.log('[VideoStream] File size:', plaintextSize, 'totalChunks:', totalChunks);

      // --- Step 3: Create MediaSource and bind to the video element. ---------
      const mediaSource = new MediaSource();
      const videoUrl = URL.createObjectURL(mediaSource);
      videoElement.src = videoUrl;
      if (environment.logs.transmuxer) console.log('[VideoStream] Waiting for media source open...');
      await this.waitForSourceOpen(mediaSource);
      if (environment.logs.transmuxer) console.log('[VideoStream] Media source opened.');

      // --- Step 4: Instantiate workers. --------------------------------------
      const cryptoWorker = new Worker(
        new URL('../workers/stream-crypto.worker',   import.meta.url), { type: 'module' }
      );
      cryptoWorker.onerror = (e) => console.error('[CryptoWorker Error]', e);
      cryptoWorker.postMessage({ type: 'INIT', logsEnabled: environment.logs.crypto });

      const transmuxWorker = new Worker(
        new URL('../workers/stream-transmux.worker', import.meta.url), { type: 'module' }
      );
      transmuxWorker.onerror = (e) => console.error('[TransmuxWorker Error]', e);
      transmuxWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'LOG') {
          if (environment.logs.transmuxer) console.log('[TransmuxWorker Log]', ev.data.message);
        }
      });

      const s: StreamState = {
        file: fileToPlay,
        fdk,
        baseNonce,
        plaintextSize,
        totalChunks,
        videoDuration: 0,
        mediaSource,
        sourceBuffers: new Map<number, SourceBuffer>(),
        codecStrings: new Map<number, string>(),
        cryptoWorker,
        transmuxWorker,
        nextChunkIndex: 0,
        isFetching: false,
        isRemoving: false,
        seekGeneration: 0,
        currentFetch: null,
        seekDebounceTimeout: null,
        aborted: false,
        silentRetryCount: previousRetryCount,
        lastSilentRetryTime: previousRetryTime,
        videoElement,
        videoUrl,
        gdriveUrl,
        gdriveToken,
        removeVideoListeners: null,
      };
      this.state = s;

      if (environment.logs.transmuxer) console.log('[VideoStream] Starting bootstrapLastChunk...');
      // --- Step 5: Bootstrap (moov atom from last chunk). --------------------
      await this.bootstrapLastChunk(s, videoElement);
      if (s.aborted) return;
      if (environment.logs.transmuxer) console.log('[VideoStream] bootstrapLastChunk completed. nextChunkIndex is:', s.nextChunkIndex);

      // --- Step 6: Attach event listeners. ----------------------------------
      this.attachVideoListeners(s, videoElement);

      if (initialSeekTime !== undefined && initialSeekTime > 0) {
        if (environment.logs.transmuxer) console.log('[VideoStream] Silent retry: jumping to initialSeekTime', initialSeekTime);
        videoElement.currentTime = initialSeekTime;
      } else {
        if (environment.logs.transmuxer) console.log('[VideoStream] Priming the pump (scheduleNextChunk)...');
        // --- Step 7: Prime the pump -- request the first content chunk. --------
        this.scheduleNextChunk(s, videoElement);
      }

    } catch (err: any) {
      if (!this.state?.aborted) {
        this.error.set(err?.message ?? 'Erro desconhecido no streaming.');
        this.isStreaming.set(false);
        this.destroyWorkers();
      }
    }
  }

  /**
   * Terminates the stream session and releases all resources.
   * Must be called from the owning component's ngOnDestroy.
   */
  destroyStream(): void {
    if (!this.state) return;
    const s = this.state;

    s.aborted = true;
    s.currentFetch?.abort();

    s.removeVideoListeners?.();

    this.destroyWorkers();

    if (s.mediaSource) {
      if (s.mediaSource.readyState === 'open') {
        try {
          const sbs = Array.from(s.mediaSource.sourceBuffers);
          for (const sb of sbs) {
            s.mediaSource.removeSourceBuffer(sb);
          }
        } catch (e) {
          console.warn('[VideoStream] Error removing source buffers during destroy:', e);
        }
      }
    }

    if (s.videoUrl) {
      URL.revokeObjectURL(s.videoUrl);
    }

    if (s.videoElement) {
      try {
        s.videoElement.removeAttribute('src');
        s.videoElement.load();
      } catch (e) {
        // ignore
      }
    }

    this.state = null;
    this.isStreaming.set(false);
    this.isSeeking.set(false);
    this.originalBitrateWarning.set(false);
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

    const onSeeked = () => this.ngZone.run(() => this.isSeeking.set(false));

    this.ngZone.runOutsideAngular(() => {
      videoElement.addEventListener('timeupdate', onTimeupdate);
      videoElement.addEventListener('seeking',    onSeeking);
      videoElement.addEventListener('seeked',     onSeeked);
      videoElement.addEventListener('waiting',    onWaiting);
      videoElement.addEventListener('playing',    onPlaying);
      videoElement.addEventListener('canplay',    onCanPlay);
    });

    s.removeVideoListeners = () => {
      videoElement.removeEventListener('timeupdate', onTimeupdate);
      videoElement.removeEventListener('seeking',    onSeeking);
      videoElement.removeEventListener('seeked',     onSeeked);
      videoElement.removeEventListener('waiting',    onWaiting);
      videoElement.removeEventListener('playing',    onPlaying);
      videoElement.removeEventListener('canplay',    onCanPlay);
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
    if (s.aborted || s.isFetching || s.nextChunkIndex >= s.totalChunks) return;

    const currentTime  = videoElement.currentTime;
    const bufferedAhead = this.computeBufferedAhead(s, currentTime);

    // -- Injection decision -------------------------------------------------
    if (bufferedAhead < BUFFER_AHEAD_SECONDS) {
      this.scheduleNextChunk(s, videoElement);
    }

    // -- GC decision --------------------------------------------------------
    if (currentTime > GC_BEHIND_SECONDS) {
      this.evictStaleRanges(s, currentTime);
    }
  }

  /**
   * Returns how many seconds of video are buffered strictly ahead of the
   * current playhead position.
   */
  private computeBufferedAhead(s: StreamState, currentTime: number): number {
    if (s.sourceBuffers.size === 0) return 0;

    let minBufferedAhead = Infinity;
    for (const sb of s.sourceBuffers.values()) {
      const buffered = sb.buffered;
      let trackBufferedAhead = 0;
      if (buffered.length > 0) {
        // Use the furthest buffered end point to avoid getting stuck on MSE micro-gaps
        const furthestEnd = buffered.end(buffered.length - 1);
        trackBufferedAhead = Math.max(0, furthestEnd - currentTime);
      }
      if (trackBufferedAhead < minBufferedAhead) {
        minBufferedAhead = trackBufferedAhead;
      }
    }
    return minBufferedAhead === Infinity ? 0 : minBufferedAhead;
  }

  /**
   * Kicks off the download -> decrypt -> transmux -> append pipeline for the
   * chunk at s.nextChunkIndex. Fire-and-forget; isFetching prevents overlap.
   */
  private scheduleNextChunk(s: StreamState, videoElement: HTMLVideoElement): void {
    if (s.isFetching || s.aborted || s.nextChunkIndex >= s.totalChunks) return;

    const chunkIdx      = s.nextChunkIndex;
    const generation    = s.seekGeneration;
    s.isFetching        = true;
    s.nextChunkIndex++;

    const isLastChunk    = chunkIdx === s.totalChunks - 1;
    const plaintextBytes = isLastChunk
      ? s.plaintextSize - chunkIdx * CHUNK_SIZE
      : CHUNK_SIZE;
    const encryptedBytes = MAC_SIZE + plaintextBytes;
    const rangeStart     = HEADER_SIZE + chunkIdx * (CHUNK_SIZE + MAC_SIZE);
    const rangeEnd       = rangeStart + encryptedBytes - 1;

    const controller = new AbortController();
    s.currentFetch   = controller;

    this.runChunkPipeline(s, generation, chunkIdx, rangeStart, rangeEnd, isLastChunk, controller, videoElement)
      .then(() => {
        s.isFetching = false;
        // Update download progress signal (must re-enter zone for signal reactivity).
        this.ngZone.run(() => {
          this.bufferProgress.set(Math.round((s.nextChunkIndex / s.totalChunks) * 100));
          if (s.nextChunkIndex >= s.totalChunks) {
            this.signalEndOfStream(s);
          }
        });
        // Immediately check if another chunk is needed.
        this.onTimeupdateTick(s, videoElement);
      })
      .catch((err) => {
        s.isFetching = false;
        if (!s.aborted && err?.name !== 'AbortError') {
          if (err?.message === 'Erro no appendBuffer.') {
            const now = Date.now();
            let newRetryCount = s.silentRetryCount;
            
            if (now - s.lastSilentRetryTime < 10000) {
              newRetryCount++;
            } else {
              newRetryCount = 1;
            }

            if (newRetryCount > 3) {
              console.warn('[VideoStream] Silent retry loop detected! Adding playhead by 1 second to bypass corrupted chunk.', err);
              this.initializeStream(videoElement, s.file, videoElement.currentTime + 1, 0, now);
            } else {
              console.warn(`[VideoStream] Append error detected! Attempting silent retry ${newRetryCount}/3 at currentTime:`, videoElement.currentTime);
              this.initializeStream(videoElement, s.file, videoElement.currentTime, newRetryCount, now);
            }
          } else {
            this.ngZone.run(() => this.error.set(err?.message ?? 'Erro no pipeline de chunk.'));
          }
        }
      });
  }

  /**
   * The full async pipeline for a single chunk:
   *   HTTP Range download -> Crypto Worker -> Transmux Worker -> append queue.
   */
  private async runChunkPipeline(
    s: StreamState,
    generation: number,
    chunkIdx: number,
    rangeStart: number,
    rangeEnd: number,
    isLastChunk: boolean,
    controller: AbortController,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    // Download.
    const encBlob   = await this.fetchRange(s.file.id, rangeStart, rangeEnd, controller, s.gdriveUrl, s.gdriveToken);
    const encBuffer = await encBlob.arrayBuffer();

    if (s.aborted || s.seekGeneration !== generation) return; // Stale -- discard.

    // Decrypt.
    const decrypted = await this.sendToCryptoWorker(s, encBuffer, chunkIdx);
    if (s.aborted || s.seekGeneration !== generation) return;

    // Transmux.
    const { segments } = await this.sendToTransmuxWorker(s, decrypted, chunkIdx, isLastChunk);
    if (s.aborted || s.seekGeneration !== generation) return;

    if (segments && segments.length > 0) {
      for (const seg of segments) {
        const sb = s.sourceBuffers.get(seg.id);
        if (sb) {
          await this.appendToSourceBuffer(s, sb, seg.buffer, videoElement);
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

    this.ngZone.run(() => this.isSeeking.set(true));

    // -- 1. Abort in-flight HTTP. -------------------------------------------
    s.currentFetch?.abort();
    s.currentFetch = null;
    s.isFetching   = false;

    // -- 2. Invalidate any in-flight worker callbacks. ----------------------
    s.seekGeneration++;
    const generation = s.seekGeneration;



    // -- 4. Transmux worker remains alive (mp4box handles fileStart jumps natively).

    const seekTime  = videoElement.currentTime;
    const duration  = s.videoDuration > 0 ? s.videoDuration : videoElement.duration;

    // -- 5. Remove stale SourceBuffer ranges asynchronously. ---------------
    this.clearAndResume(s, generation, seekTime, duration, videoElement);
  }

  private async clearAndResume(
    s: StreamState,
    generation: number,
    seekTime: number,
    duration: number,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    if (s.sourceBuffers.size === 0 || s.mediaSource.readyState !== 'open') return;

    // Wait until all ongoing appendBuffer or remove operations complete on all source buffers.
    for (const sb of s.sourceBuffers.values()) {
      await this.waitForSourceBufferIdle(sb);
    }
    if (s.aborted || s.seekGeneration !== generation) return;

    // Remove everything except a small window around the seek target from all buffers.
    const keepStart = Math.max(0, seekTime - GC_BEHIND_SECONDS);
    const totalDuration = duration || s.totalChunks * CHUNK_SIZE / (1 * 1024 * 1024); // rough fallback

    for (const sb of s.sourceBuffers.values()) {
      // If there is buffered content before the keep window, remove it.
      if (keepStart > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < keepStart) {
        await this.removeRange(s, sb, 0, keepStart);
        if (s.aborted || s.seekGeneration !== generation) return;
      }

      // If there is buffered content after the seek target, remove it too so
      // the transmux worker can re-sync the segment timestamps cleanly.
      if (sb.buffered.length > 0 && sb.buffered.end(sb.buffered.length - 1) > seekTime) {
        await this.removeRange(s, sb, seekTime, totalDuration + 1);
        if (s.aborted || s.seekGeneration !== generation) return;
      }
    }

    // -- Seeking maths -------------------------------------------------------
    // We now ask the worker for the EXACT chunk index needed to resume playback at seekTime!
    const exactChunkIndex = await this.sendSeekToTransmuxWorker(s, seekTime, generation);
    if (s.aborted || s.seekGeneration !== generation) return;

    s.nextChunkIndex = Math.min(exactChunkIndex, s.totalChunks - 1);

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
  private async evictStaleRanges(s: StreamState, currentTime: number): Promise<void> {
    if (s.isRemoving || s.mediaSource.readyState !== 'open') return;

    const evictUpTo = currentTime - GC_BEHIND_SECONDS;
    if (evictUpTo <= 0) return;

    for (const sb of s.sourceBuffers.values()) {
      if (sb.updating) continue;
      if (sb.buffered.length === 0 || sb.buffered.start(0) >= evictUpTo) continue;

      try {
        await this.removeRange(s, sb, 0, evictUpTo);
      } catch (err) {
        // ignore GC errors
      }
    }
  }

  private removeRange(s: StreamState, sb: SourceBuffer, start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!sb || s.mediaSource.readyState !== 'open' || sb.updating) {
        resolve();
        return;
      }

      s.isRemoving = true;

      const onUpdateEnd = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error',     onError);
        s.isRemoving = false;
        resolve();
      };
      const onError = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error',     onError);
        s.isRemoving = false;
        reject(new Error('SourceBuffer error during remove.'));
      };

      try {
        sb.addEventListener('updateend', onUpdateEnd, { once: true });
        sb.addEventListener('error',     onError,     { once: true });
        sb.remove(start, end);
      } catch (err) {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error',     onError);
        s.isRemoving = false;
        resolve(); // ignore
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap (Phase 3)
  // ---------------------------------------------------------------------------

  private async bootstrapLastChunk(s: StreamState, videoElement: HTMLVideoElement): Promise<void> {
    // 1. We ALWAYS download chunk 0 first since we need the real ftyp box from the beginning of the file.
    const firstEncryptedBytes = MAC_SIZE + Math.min(CHUNK_SIZE, s.plaintextSize);
    const firstRangeStart     = HEADER_SIZE;
    const firstRangeEnd       = firstRangeStart + firstEncryptedBytes - 1;
    if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: downloading chunk 0...');

    const controller0 = new AbortController();
    s.currentFetch    = controller0;
    const blob0       = await this.fetchRange(s.file.id, firstRangeStart, firstRangeEnd, controller0, s.gdriveUrl, s.gdriveToken);
    s.currentFetch    = null;
    if (s.aborted) return;
    const buf0 = await blob0.arrayBuffer();
    if (environment.logs.transmuxer) console.log('[VideoStream] Decrypting chunk 0 for bootstrap...');
    const decryptedChunk0 = await this.sendToCryptoWorker(s, buf0, 0);
    if (s.aborted) return;

    // 2. Scan decrypted chunk 0 for the 'moov' FourCC (0x6d6f6f76).
    const view0 = new DataView(decryptedChunk0);
    let moovOffsetInChunk0 = -1;
    let moovSizeInChunk0 = 0;
    const len0 = decryptedChunk0.byteLength;
    for (let i = 4; i < len0 - 4; i++) {
      if (view0.getUint32(i) === 0x6d6f6f76) {
        moovOffsetInChunk0 = i - 4;
        moovSizeInChunk0 = view0.getUint32(moovOffsetInChunk0);
        break;
      }
    }

    let initData: { id: number; codecString: string; buffer: ArrayBuffer }[] | undefined;
    let videoDuration: number | undefined;
    let initialSegments: any[] | undefined;

    if (moovOffsetInChunk0 !== -1 && moovOffsetInChunk0 + moovSizeInChunk0 <= len0) {
      // --- Fast-Start MP4: moov is in chunk 0 ---
      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: moov found in chunk 0 (Fast-Start MP4) at offset:', moovOffsetInChunk0, 'size:', moovSizeInChunk0);
      const isOnlyChunk = s.totalChunks === 1;
      const res = await this.sendBootstrapToTransmuxWorker(s, decryptedChunk0, null, undefined, isOnlyChunk);
      initData = res.initData;
      videoDuration = res.videoDuration;
      initialSegments = res.segments;
      // Mark chunk 0 as already processed so scheduleNextChunk starts at chunk 1.
      s.nextChunkIndex = 1;
    } else {
      // --- Standard MP4: moov is in the last chunk ---
      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: moov NOT in chunk 0. Downloading last chunk...');
      const lastChunkIndex     = s.totalChunks - 1;
      const lastPlaintextBytes = s.plaintextSize - lastChunkIndex * CHUNK_SIZE;
      const lastEncryptedBytes = MAC_SIZE + lastPlaintextBytes;
      const lastRangeStart     = HEADER_SIZE + lastChunkIndex * (CHUNK_SIZE + MAC_SIZE);
      const lastRangeEnd       = lastRangeStart + lastEncryptedBytes - 1;
      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap last chunk idx:', lastChunkIndex, 'rangeStart:', lastRangeStart, 'rangeEnd:', lastRangeEnd);

      const controller = new AbortController();
      s.currentFetch   = controller;
      const encChunkBlob   = await this.fetchRange(s.file.id, lastRangeStart, lastRangeEnd, controller, s.gdriveUrl, s.gdriveToken);
      s.currentFetch = null;
      if (s.aborted) return;
      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap last chunk download size:', encChunkBlob.size);
      const encChunkBuffer = await encChunkBlob.arrayBuffer();

      if (environment.logs.transmuxer) console.log('[VideoStream] Decrypting last chunk...');
      const decryptedLast = await this.sendToCryptoWorker(s, encChunkBuffer, lastChunkIndex);
      if (s.aborted) return;

      // Scan last chunk for the 'moov' FourCC
      const viewLast = new DataView(decryptedLast);
      let moovOffsetInLast = -1;
      let moovSizeInLast = 0;
      const lenLast = decryptedLast.byteLength;
      for (let i = 4; i < lenLast - 4; i++) {
        if (viewLast.getUint32(i) === 0x6d6f6f76) {
          moovOffsetInLast = i - 4;
          moovSizeInLast = viewLast.getUint32(moovOffsetInLast);
          break;
        }
      }

      if (moovOffsetInLast === -1 || moovOffsetInLast + moovSizeInLast > lenLast) {
        throw new Error('Metadados de video nao encontrados (moov atom ausente).');
      }

      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: moov found in last chunk at offset:', moovOffsetInLast, 'size:', moovSizeInLast);
      const moovBytes = decryptedLast.slice(moovOffsetInLast, moovOffsetInLast + moovSizeInLast);
      const realMoovOffset = lastChunkIndex * CHUNK_SIZE + moovOffsetInLast;

      const res = await this.sendBootstrapToTransmuxWorker(s, decryptedChunk0, moovBytes, realMoovOffset);
      initData = res.initData;
      videoDuration = res.videoDuration;
      initialSegments = res.segments;

      // Standard MP4 needs chunk 0 again to start feeding video data (since we only fed it to get ftyp in bootstrap)
      s.nextChunkIndex = 0;
    }

    if (environment.logs.transmuxer) console.log('[VideoStream] Transmux result initData tracks:', initData?.length, 'duration:', videoDuration);
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
            if (environment.logs.transmuxer) console.log('[VideoStream] Adding SourceBuffer for track:', track.id, 'codec:', track.codecString);
            const sb = s.mediaSource.addSourceBuffer(track.codecString);
            s.sourceBuffers.set(track.id, sb);
            s.codecStrings.set(track.id, track.codecString);
          } catch (e) {
            console.error('[VideoStream] Failed to add SourceBuffer for track', track.id, track.codecString, e);
            throw e;
          }
        }
        const sb = s.sourceBuffers.get(track.id);
        if (sb) {
          await this.appendToSourceBufferRaw(sb, track.buffer);
        }
      }

      if (initialSegments && initialSegments.length > 0) {
        if (environment.logs.transmuxer) console.log('[VideoStream] Appending', initialSegments.length, 'segments generated during bootstrap');
        for (const seg of initialSegments) {
          const sb = s.sourceBuffers.get(seg.id);
          if (sb && seg.buffer.byteLength > 0) {
            await this.appendToSourceBufferRaw(sb, seg.buffer);
          }
        }
      }
    } else {
      throw new Error('Nenhuma faixa de audio ou video encontrada.');
    }
  }

  // ---------------------------------------------------------------------------
  // Worker communication helpers
  // ---------------------------------------------------------------------------

  private sendToCryptoWorker(
    s: StreamState,
    encryptedChunk: ArrayBuffer,
    chunkIndex: number,
  ): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.data.chunkIndex !== chunkIndex) return;
        s.cryptoWorker.removeEventListener('message', onMessage);
        if (ev.data.type === 'CHUNK_DECRYPTED') {
          resolve(ev.data.decryptedChunk as ArrayBuffer);
        } else {
          reject(new Error(ev.data.message ?? 'Crypto worker error.'));
        }
      };
      s.cryptoWorker.addEventListener('message', onMessage);

      s.cryptoWorker.postMessage(
        {
          type: 'DECRYPT_CHUNK',
          encryptedChunk,
          fdk:       s.fdk.slice().buffer,
          baseNonce: s.baseNonce.slice().buffer,
          chunkIndex,
        },
        [encryptedChunk],
      );
    });
  }

  private sendBootstrapToTransmuxWorker(
    s: StreamState,
    chunk0: ArrayBuffer,
    moovBytes: ArrayBuffer | null,
    moovOffset?: number,
    isLastChunk: boolean = false
  ): Promise<{ initData?: { id: number; codecString: string; buffer: ArrayBuffer }[]; videoDuration?: number; segments?: any[] }> {
    return new Promise((resolve, reject) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.data.type === 'BOOTSTRAP_COMPLETE') {
          s.transmuxWorker.removeEventListener('message', onMessage);
          resolve({
            initData:      ev.data.initData      as { id: number; codecString: string; buffer: ArrayBuffer }[] | undefined,
            videoDuration: ev.data.videoDuration as number | undefined,
            segments:      ev.data.segments      as any[] | undefined,
          });
        } else if (ev.data.type === 'ERROR') {
          s.transmuxWorker.removeEventListener('message', onMessage);
          reject(new Error(ev.data.message ?? 'Transmux bootstrap error.'));
        }
      };
      s.transmuxWorker.addEventListener('message', onMessage);

      const transferables: Transferable[] = [chunk0];
      if (moovBytes) transferables.push(moovBytes);

      s.transmuxWorker.postMessage(
        {
          type: 'BOOTSTRAP',
          chunk0,
          moovBytes,
          moovOffset,
          isLastChunk
        },
        transferables
      );
    });
  }

  private sendSeekToTransmuxWorker(
    s: StreamState,
    seekTime: number,
    generation: number,
  ): Promise<number> {
    return new Promise((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.data.type === 'SEEK_COMPLETE' && ev.data.generation === generation) {
          s.transmuxWorker.removeEventListener('message', onMessage);
          resolve(ev.data.chunkIndex as number);
        }
      };
      s.transmuxWorker.addEventListener('message', onMessage);
      s.transmuxWorker.postMessage({ type: 'SEEK', time: seekTime, generation });
    });
  }

  private sendToTransmuxWorker(
    s: StreamState,
    decryptedChunk: ArrayBuffer,
    chunkIndex: number,
    isLastChunk: boolean,
  ): Promise<{ segments: { id: number; buffer: ArrayBuffer }[] }> {
    return new Promise((resolve, reject) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.data.chunkIndex !== chunkIndex) return;
        s.transmuxWorker.removeEventListener('message', onMessage);
        if (ev.data.type === 'CHUNK_TRANSMUXED') {
          resolve({
            segments: ev.data.segments as { id: number; buffer: ArrayBuffer }[],
          });
        } else {
          reject(new Error(ev.data.message ?? 'Transmux worker error.'));
        }
      };
      s.transmuxWorker.addEventListener('message', onMessage);
      s.transmuxWorker.postMessage(
        {
          type: 'TRANSMUX_CHUNK',
          decryptedChunk,
          chunkIndex,
          isLastChunk,
        },
        [decryptedChunk],
      );
    });
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
    sb: SourceBuffer,
    buffer: ArrayBuffer,
    videoElement: HTMLVideoElement
  ): Promise<void> {
    if (!sb || s.mediaSource.readyState !== 'open') {
      throw new Error('SourceBuffer indisponivel.');
    }

    while (!s.aborted) {
      try {
        await this.appendToSourceBufferRaw(sb, buffer);
        return; // Success!
      } catch (err: any) {
        if (err.name === 'QuotaExceededError') {
          // RAM overflow: try aggressive eviction
          const evictUpTo = Math.max(0, videoElement.currentTime - 2);
          if (evictUpTo > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < evictUpTo) {
            await this.removeRangeRaw(sb, 0, evictUpTo);
            continue; // Retry append immediately after eviction
          }
          // We can't evict yet (all data is ahead of the playhead).
          // Wait 1 second for the video to play and free up space, then retry.
          console.warn('[VideoStream] SourceBuffer QuotaExceeded. Awaiting playback to free space...');
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw err;
        }
      }
    }
  }

  private appendToSourceBufferRaw(sb: SourceBuffer, buffer: ArrayBuffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onEnd = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        resolve();
      };
      const onErr = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        reject(new Error('Erro no appendBuffer.'));
      };
      sb.addEventListener('updateend', onEnd, { once: true });
      sb.addEventListener('error',     onErr, { once: true });
      try {
        sb.appendBuffer(buffer);
      } catch (err: any) {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        reject(new Error('Erro no appendBuffer.'));
      }
    });
  }

  private removeRangeRaw(sb: SourceBuffer, start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (sb.updating) {
        const onUpdateEnd = () => {
          sb.removeEventListener('updateend', onUpdateEnd);
          this.removeRangeRaw(sb, start, end).then(resolve, reject);
        };
        sb.addEventListener('updateend', onUpdateEnd, { once: true });
        return;
      }
      const onEnd = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        resolve();
      };
      const onErr = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        reject(new Error('Erro no remove.'));
      };
      sb.addEventListener('updateend', onEnd, { once: true });
      sb.addEventListener('error',     onErr, { once: true });
      try {
        sb.remove(start, end);
      } catch (err) {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error',     onErr);
        resolve(); // Non-fatal
      }
    });
  }



  /**
   * Waits until SourceBuffer.updating is false by polling on 'updateend'.
   */
  private waitForSourceBufferIdle(sb: SourceBuffer): Promise<void> {
    if (!sb.updating) return Promise.resolve();
    return new Promise<void>((resolve) => {
      sb.addEventListener('updateend', () => resolve(), { once: true });
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
    gdriveUrl: string | null = null,
    gdriveToken: string | null = null,
  ): Promise<Blob> {
    if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange start:', start, 'end:', end);
    return new Promise<Blob>((resolve, reject) => {
      const abortHandler = () => {
        if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange aborted');
        reject(Object.assign(new Error('Fetch aborted.'), { name: 'AbortError' }));
      };
      if (controller.signal.aborted) {
        if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange already aborted');
        reject(Object.assign(new Error('Fetch aborted.'), { name: 'AbortError' }));
        return;
      }
      controller.signal.addEventListener('abort', abortHandler, { once: true });

      const request$ = (gdriveUrl && gdriveToken)
        ? this.driveService.downloadExternalFileRange(gdriveUrl, gdriveToken, start, end)
        : this.driveService.downloadFileRange(fileId, start, end);

      request$.pipe(
        retry({
          count: 3,
          delay: (error, retryCount) => {
            if (controller.signal.aborted || error?.name === 'AbortError') {
              throw error;
            }
            console.warn('[VideoStream] fetchRange retryCount:', retryCount, 'error:', error);
            // Exponential backoff: 1s, 2s, 4s
            return timer(Math.pow(2, retryCount - 1) * 1000);
          }
        })
      )
      .subscribe({
        next: (blob) => {
          if (environment.logs.transmuxer) console.log('[VideoStream] fetchRange complete size:', blob.size);
          controller.signal.removeEventListener('abort', abortHandler);
          resolve(blob);
        },
        error: (err) => {
          console.error('[VideoStream] fetchRange failed:', err);
          controller.signal.removeEventListener('abort', abortHandler);
          reject(err);
        }
      });
    });
  }

  private waitForSourceOpen(mediaSource: MediaSource): Promise<void> {
    if (mediaSource.readyState === 'open') return Promise.resolve();
    return new Promise<void>((resolve) => {
      mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    });
  }

  private signalEndOfStream(s: StreamState): void {
    if (s.mediaSource.readyState === 'open') {
      try { s.mediaSource.endOfStream(); } catch { /* already closed */ }
    }
    this.ngZone.run(() => this.isStreaming.set(false));
  }

  private destroyWorkers(): void {
    this.state?.cryptoWorker.terminate();
    this.state?.transmuxWorker.terminate();
  }
}

