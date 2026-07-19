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


import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
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
const BUFFER_AHEAD_SECONDS = 20;

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
  nextChunkIndex: number;     // Index of the next chunk to download.
  activeDownloads: number;    // Replaces isFetching to allow parallel downloads
  isRemoving: boolean;        // True while SourceBuffer.remove is active.

  /**
   * Incremented on every seek. Any pipeline callback that captures an older
   * generation value discards its result instead of appending it.
   */
  seekGeneration: number;

  /** Set of AbortControllers for all in-flight HTTP Range requests. */
  currentFetches: Set<AbortController>;

  /** Chain of promises to ensure chunks are decrypted and transmuxed strictly in order. */
  processLock: Promise<void>;

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
  private readonly kasumi        = inject(KasumiCryptoService);
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
      // --- Step 2: Download the file header and extract metadata. ------------
      // Download up to 128KB to safely include Kasumi v2 metadata if it exists.
      const initialFetchSize = 1024 * 128;
      const headerBlob    = await this.fetchRange(fileToPlay.id, 0, initialFetchSize - 1, new AbortController(), gdriveUrl, gdriveToken);
      if (environment.logs.transmuxer) console.log('[VideoStream] Header blob fetched size:', headerBlob.size);
      
      const { dataOffset, expectedSize } = await this.kasumi.extractMetadata(headerBlob, fdk);
      const baseNonce = new Uint8Array(await headerBlob.slice(0, 24).arrayBuffer());
      
      const plaintextSize = expectedSize;
      const totalChunks   = Math.ceil(plaintextSize / CHUNK_SIZE);
      if (environment.logs.transmuxer) console.log('[VideoStream] File size:', plaintextSize, 'totalChunks:', totalChunks, 'dataOffset:', dataOffset);

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
        dataOffset,
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
        
        if (previousRetryCount > 0) {
          const checkBuffer = setInterval(() => {
            if (s.aborted) {
              clearInterval(checkBuffer);
              return;
            }
            if (videoElement.buffered.length > 0) {
              const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
              if (bufferedEnd >= videoElement.currentTime + 1 || videoElement.readyState >= 3) {
                clearInterval(checkBuffer);
                videoElement.play().catch(e => console.warn('Autoplay prevented on retry', e));
              }
            }
          }, 500);
        }
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
    s.currentFetches.forEach(c => c.abort());
    s.currentFetches.clear();

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
    if (s.aborted || this.isSeeking() || s.activeDownloads >= 3 || s.nextChunkIndex >= s.totalChunks) return;

    const currentTime  = videoElement.currentTime;
    const bufferedAhead = this.computeBufferedAhead(s, currentTime);

    // -- Injection decision -------------------------------------------------
    // While the buffer is starving and we have available network pipeline slots,
    // queue up the next block of chunks immediately.
    while (this.computeBufferedAhead(s, currentTime) < BUFFER_AHEAD_SECONDS && s.activeDownloads < 3) {
      if (s.nextChunkIndex >= s.totalChunks || s.aborted) break;
      this.scheduleNextChunk(s, videoElement);
    }

    // -- GC decision --------------------------------------------------------
    // Serialize GC removes through the processLock to prevent race conditions
    // where a removeRange fires updateend that triggers a pending appendBuffer.
    if (currentTime > GC_BEHIND_SECONDS) {
      const evictUpTo = currentTime - GC_BEHIND_SECONDS;
      s.processLock = s.processLock.then(() => this.evictStaleRanges(s, currentTime).catch(() => {}));
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
    const generation    = s.seekGeneration;
    s.activeDownloads++;
    
    // We want to fetch up to 3 chunks in a single HTTP request to reduce overhead for GDrive.
    // Local backend has a 4MB limit per request, so we only fetch 1 chunk.
    const maxChunksToFetch = s.file.storageProvider === 'google_drive' ? 3 : 1;
    const chunksToFetch = Math.min(maxChunksToFetch, s.totalChunks - startChunkIdx);
    s.nextChunkIndex += chunksToFetch;

    // Compute rangeStart for the first chunk in the block
    const firstChunkStart = s.dataOffset + startChunkIdx * (CHUNK_SIZE + MAC_SIZE);
    
    // Compute rangeEnd for the last chunk in the block (which might be smaller)
    const endChunkIdx = startChunkIdx + chunksToFetch - 1;
    const isEndChunkLast = endChunkIdx === s.totalChunks - 1;
    
    const endChunkPlaintextBytes = isEndChunkLast
      ? s.plaintextSize - endChunkIdx * CHUNK_SIZE
      : CHUNK_SIZE;
    const endChunkEncryptedBytes = MAC_SIZE + endChunkPlaintextBytes;
    
    const endChunkStart = s.dataOffset + endChunkIdx * (CHUNK_SIZE + MAC_SIZE);
    const rangeEnd = endChunkStart + endChunkEncryptedBytes - 1;

    const controller = new AbortController();
    s.currentFetches.add(controller);

    // Fire the network request immediately (runs in parallel with other fetches).
    // The catchall at the end prevents an unhandled rejection if this pipeline is discarded
    // by a seek/retry generation check before runChunkPipeline gets a chance to await it.
    const rawFetch = this.fetchRange(s.file.id, firstChunkStart, rangeEnd, controller, s.gdriveUrl, s.gdriveToken);
    const fetchPromise = rawFetch.then(blob => blob.arrayBuffer());
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
      return this.runChunkPipeline(s, capturedGeneration, startChunkIdx, chunksToFetch, fetchPromise, videoElement);
    });

    // Update processLock for the next chunk to chain after this one.
    // Use a catch-suppressed version to prevent rejection from breaking the next pipeline.
    s.processLock = pipelinePromise.then(() => {}, () => {});

    pipelinePromise
      .then(() => {
        // Guard: if a seek happened while we were processing, don't modify the new stream's counters.
        if (s.seekGeneration !== capturedGeneration) return;
        s.activeDownloads--;
        s.currentFetches.delete(controller);
        // Update download progress signal (must re-enter zone for signal reactivity).
        this.ngZone.run(() => {
          this.bufferProgress.set(Math.round((s.nextChunkIndex / s.totalChunks) * 100));
          if (s.nextChunkIndex >= s.totalChunks && s.activeDownloads === 0) {
            this.signalEndOfStream(s);
          }
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
        ? s.plaintextSize - currentChunkIdx * CHUNK_SIZE
        : CHUNK_SIZE;
      const chunkEncryptedBytes = MAC_SIZE + chunkPlaintextBytes;
      
      const chunkBuffer = fullBuffer.slice(offset, offset + chunkEncryptedBytes);
      offset += chunkEncryptedBytes;
      
      // Decrypt.
      const decrypted = await this.sendToCryptoWorker(s, chunkBuffer, currentChunkIdx);
      if (s.aborted || s.seekGeneration !== generation) return;

      // Transmux.
      const { segments } = await this.sendToTransmuxWorker(s, decrypted, currentChunkIdx, isLastChunk);
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
  }

  // ---------------------------------------------------------------------------
  // Phase 4.2 -- Seeking (jump to arbitrary playhead position)
  // ---------------------------------------------------------------------------

  /**
   * Called when the user seeks to a new position in the video.
   */
  private onSeek(s: StreamState, videoElement: HTMLVideoElement): void {
    if (s.aborted) return;

    const seekTime  = videoElement.currentTime;

    // Check if we are seeking within the already buffered range.
    // If so, we do not need to abort the current pipeline or reset the transmux worker.
    // The browser will seamlessly play from the cache and onTimeupdateTick will naturally 
    // resume fetching from the exact chunk it left off at.
    let alreadyBuffered = s.sourceBuffers.size > 0;
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
    s.currentFetches.forEach(c => c.abort());
    s.currentFetches.clear();
    s.activeDownloads = 0;
    s.processLock = Promise.resolve();

    // -- Invalidate any in-flight worker callbacks. --------------------------
    s.seekGeneration++;
    const generation = s.seekGeneration;

    const duration  = s.videoDuration > 0 ? s.videoDuration : videoElement.duration;
    this.clearAndResume(s, generation, seekTime, duration, videoElement);
  }

  private async clearAndResume(
    s: StreamState,
    generation: number,
    seekTime: number,
    duration: number,
    videoElement: HTMLVideoElement,
  ): Promise<void> {
    if (s.sourceBuffers.size === 0 || (s.mediaSource.readyState as string) === 'closed') return;

    // Wait until all ongoing appendBuffer or remove operations complete on all source buffers.
    for (const sb of s.sourceBuffers.values()) {
      await this.waitForSourceBufferIdle(sb);
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

    // Seek target is NOT buffered — we need to re-sync the transmux worker and download
    // chunks starting from the right chunk index.
    // Remove forward buffer so the transmux worker can re-sync segment timestamps cleanly.
    for (const sb of s.sourceBuffers.values()) {
      if (sb.buffered.length > 0 && sb.buffered.end(sb.buffered.length - 1) > seekTime) {
        await this.removeRange(s, sb, seekTime, (duration || s.totalChunks * CHUNK_SIZE / (1 * 1024 * 1024)) + 1);
        if (s.aborted || s.seekGeneration !== generation) return;
      }
    }

    // -- Seeking maths -------------------------------------------------------
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
    const firstRangeStart     = s.dataOffset;
    const firstRangeEnd       = firstRangeStart + firstEncryptedBytes - 1;
    if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap: downloading chunk 0...');

    const controller0 = new AbortController();
    s.currentFetches.add(controller0);
    const blob0       = await this.fetchRange(s.file.id, firstRangeStart, firstRangeEnd, controller0, s.gdriveUrl, s.gdriveToken);
    s.currentFetches.delete(controller0);
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
      const lastRangeStart     = s.dataOffset + lastChunkIndex * (CHUNK_SIZE + MAC_SIZE);
      const lastRangeEnd       = lastRangeStart + lastEncryptedBytes - 1;
      if (environment.logs.transmuxer) console.log('[VideoStream] Bootstrap last chunk idx:', lastChunkIndex, 'rangeStart:', lastRangeStart, 'rangeEnd:', lastRangeEnd);

      const controller = new AbortController();
      s.currentFetches.add(controller);
      const encChunkBlob   = await this.fetchRange(s.file.id, lastRangeStart, lastRangeEnd, controller, s.gdriveUrl, s.gdriveToken);
      s.currentFetches.delete(controller);
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
    if (!sb || (s.mediaSource.readyState as string) === 'closed') {
      throw new Error('SourceBuffer indisponivel (closed).');
    }

    while (!s.aborted) {
      if ((s.mediaSource.readyState as string) === 'closed') {
        throw new Error('SourceBuffer indisponivel (closed).');
      }
      try {
        await this.appendToSourceBufferRaw(sb, buffer);
        return; // Success!
      } catch (err: any) {
        // QuotaExceededError may be thrown synchronously by appendBuffer() or via the error event.
        // We check both the original error and any wrapped variant.
        const isQuota = err.name === 'QuotaExceededError' || err.isQuotaExceeded === true;
        if (isQuota) {
          // Try to evict old content behind the playhead first.
          const evictUpTo = Math.max(0, videoElement.currentTime - 2);
          if (evictUpTo > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < evictUpTo) {
            await this.removeRangeRaw(sb, 0, evictUpTo);
            continue; // Retry append immediately after eviction
          }
          // Nothing to evict yet — the playhead is still at the beginning.
          // Wait for the video to play forward, then retry every 500ms for up to 30s.
          console.warn('[VideoStream] SourceBuffer QuotaExceeded. Waiting for playback to free space...');
          let waited = 0;
          while (!s.aborted && waited < 30000) {
            await new Promise((r) => setTimeout(r, 500));
            waited += 500;
            if ((s.mediaSource.readyState as string) === 'closed') break;
            const canEvict = videoElement.currentTime - 2;
            if (canEvict > 0 && sb.buffered.length > 0 && sb.buffered.start(0) < canEvict) {
              await this.removeRangeRaw(sb, 0, canEvict);
              break; // Retry the outer while loop
            }
          }
        } else {
          throw err;
        }
      }
    }
  }

  private appendToSourceBufferRaw(sb: SourceBuffer, buffer: ArrayBuffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // If already updating, wait for updateend before attempting append
      const doAppend = () => {
        const onEnd = () => {
          sb.removeEventListener('updateend', onEnd);
          sb.removeEventListener('error',     onErr);
          resolve();
        };
        const onErr = () => {
          sb.removeEventListener('updateend', onEnd);
          sb.removeEventListener('error',     onErr);
          // Propagate with isQuotaExceeded flag if we can detect it
          const e = new Error('Erro no appendBuffer.');
          reject(e);
        };
        sb.addEventListener('updateend', onEnd, { once: true });
        sb.addEventListener('error',     onErr, { once: true });
        try {
          sb.appendBuffer(buffer);
        } catch (err: any) {
          sb.removeEventListener('updateend', onEnd);
          sb.removeEventListener('error',     onErr);
          // Propagate original error — preserves QuotaExceededError.name for the outer handler.
          reject(err);
        }
      };

      if (sb.updating) {
        // Wait for current operation to finish, then append
        sb.addEventListener('updateend', doAppend, { once: true });
      } else {
        doAppend();
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

