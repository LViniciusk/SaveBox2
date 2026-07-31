import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { VideoStreamService } from './video-stream.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import { ShareService } from './share.service';
import { of } from 'rxjs';

describe('VideoStreamService', () => {
  let service: VideoStreamService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let driveSpy: jasmine.SpyObj<DriveService>;
  let shareSpy: jasmine.SpyObj<ShareService>;

  beforeEach(() => {
    // Ponytail philosophy: mock all heavy dependencies to isolate pure logic and math
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['isVaultUnlocked', 'decryptName']);
    const kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['extractMetadata']);
    driveSpy = jasmine.createSpyObj('DriveService', [
      'downloadExternalMetadata', 'downloadExternalFileRange', 'downloadFileRange'
    ]);
    shareSpy = jasmine.createSpyObj('ShareService', ['downloadSharedFileRange']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        provideZonelessChangeDetection(),
        VideoStreamService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: DriveService, useValue: driveSpy },
        { provide: ShareService, useValue: shareSpy }
      ]
    });
    service = TestBed.inject(VideoStreamService);
  });

  describe('computeBufferedAhead', () => {
    it('should correctly calculate contiguous buffered ahead math handling micro-gaps', () => {
      // Arrange
      const mockTimeRanges = {
        length: 2,
        start: (index: number) => index === 0 ? 0 : 20.1, // micro-gap from 20 to 20.1 (tolerated if <= 0.5)
        end: (index: number) => index === 0 ? 20 : 30
      } as TimeRanges;

      const mockSourceBuffer = {
        buffered: mockTimeRanges
      } as SourceBuffer;

      const mockState = {
        sourceBuffers: new Map<number, SourceBuffer>([[1, mockSourceBuffer]])
      } as any;

      // Act
      // Playhead at 10s. Buffer ends at 30s. The micro-gap of 0.1 is bridged.
      // 30 - 10 = 20s ahead.
      const bufferedAhead = (service as any).computeBufferedAhead(mockState, 10);

      // Assert
      expect(bufferedAhead).toBe(20);
    });

    it('should stop calculating at macro-gaps', () => {
      // Arrange
      const mockTimeRanges = {
        length: 2,
        start: (index: number) => index === 0 ? 0 : 30, // macro-gap from 20 to 30 (> 0.5)
        end: (index: number) => index === 0 ? 20 : 40
      } as TimeRanges;

      const mockSourceBuffer = {
        buffered: mockTimeRanges
      } as SourceBuffer;

      const mockState = {
        sourceBuffers: new Map<number, SourceBuffer>([[1, mockSourceBuffer]])
      } as any;

      // Act
      // Playhead at 10s. Buffer ends at 20s. Gap is 10s, so it stops at 20.
      // 20 - 10 = 10s ahead.
      const bufferedAhead = (service as any).computeBufferedAhead(mockState, 10);

      // Assert
      expect(bufferedAhead).toBe(10);
    });

    it('should handle empty tracks, behind ranges and multiple tracks', () => {
      expect((service as any).computeBufferedAhead({ sourceBuffers: new Map() }, 5)).toBe(0);

      const empty = { length: 0, start: () => 0, end: () => 0 } as any;
      expect((service as any).computeBufferedAhead({ sourceBuffers: new Map([[1, { buffered: empty }]]) }, 5)).toBe(0);

      const behind = { length: 1, start: () => 0, end: () => 4 } as any;
      const ahead = { length: 1, start: () => 5, end: () => 25 } as any;
      const state = {
        sourceBuffers: new Map([[1, { buffered: behind }], [2, { buffered: ahead }]])
      } as any;
      expect((service as any).computeBufferedAhead(state, 5)).toBe(20);
    });
  });

  describe('Concurrency Control', () => {
    it('should prevent scheduling when activeDownloads (isFetching) limit is reached', () => {
      // Arrange
      const mockState = {
        activeDownloads: 3, // At limit
        aborted: false,
        nextChunkIndex: 0,
        totalChunks: 10,
        file: { storageProvider: 'google_drive' }
      } as any;
      
      const mockVideoElement = {} as HTMLVideoElement;

      // Act
      (service as any).scheduleNextChunk(mockState, mockVideoElement);

      // Assert - should return early and not increment activeDownloads or nextChunkIndex
      expect(mockState.activeDownloads).toBe(3);
      expect(mockState.nextChunkIndex).toBe(0);
    });
  });

  describe('Initialization guards', () => {
    it('rejects local playback while the vault is locked', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(false);

      await service.initializeStream({} as HTMLVideoElement, {
        id: 1,
        decryptedName: 'video.mp4',
        shareFdk: null,
        encryptedFdk: 'encrypted-fdk'
      } as any);

      expect(service.error()).toContain('Drive trancado');
      expect(service.isStreaming()).toBeFalse();
    });

    it('rejects unlocked files whose metadata has no FDK', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);

      await service.initializeStream({} as HTMLVideoElement, {
        id: 2,
        decryptedName: 'video.mp4',
        shareFdk: null,
        encryptedFdk: null
      } as any);

      expect(service.error()).toBe('FDK ausente nos metadados do arquivo.');
      expect(service.isStreaming()).toBeFalse();
    });
  });

  describe('Range routing', () => {
    it('uses the share endpoint when a share UUID is present', async () => {
      const blob = new Blob(['shared']);
      shareSpy.downloadSharedFileRange.and.returnValue(of(blob));

      const result = await (service as any).fetchRange(
        1, 10, 20, new AbortController(), null, null, 'share-123'
      );

      expect(result).toBe(blob);
      expect(shareSpy.downloadSharedFileRange).toHaveBeenCalledWith('share-123', 10, 20);
      expect(driveSpy.downloadFileRange).not.toHaveBeenCalled();
    });

    it('uses the Google Drive endpoint when an external URL and token are present', async () => {
      const blob = new Blob(['external']);
      driveSpy.downloadExternalFileRange.and.returnValue(of(blob));

      const result = await (service as any).fetchRange(
        1, 10, 20, new AbortController(), 'https://drive/file', 'token'
      );

      expect(result).toBe(blob);
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledWith(
        'https://drive/file', 'token', 10, 20
      );
    });

    it('fails immediately when the range request is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expectAsync((service as any).fetchRange(1, 0, 1, controller))
        .toBeRejectedWithError('Fetch aborted.');
    });
  });

  it('tears down an active session and resets public streaming state', () => {
    const controller = new AbortController();
    const cryptoWorker = jasmine.createSpyObj<Worker>('cryptoWorker', ['terminate']);
    const transmuxWorker = jasmine.createSpyObj<Worker>('transmuxWorker', ['terminate']);
    const mediaSource = {
      readyState: 'open',
      sourceBuffers: [],
      removeSourceBuffer: jasmine.createSpy('removeSourceBuffer')
    } as any;
    const video = {
      removeAttribute: jasmine.createSpy('removeAttribute'),
      load: jasmine.createSpy('load')
    } as any;
    (service as any).state = {
      aborted: false,
      currentFetches: new Set([controller]),
      removeVideoListeners: jasmine.createSpy('removeVideoListeners'),
      cryptoWorker,
      transmuxWorker,
      mediaSource,
      videoUrl: 'blob:stream',
      videoElement: video
    };
    spyOn(URL, 'revokeObjectURL');
    service.isStreaming.set(true);
    service.destroyStream();

    expect(controller.signal.aborted).toBeTrue();
    expect(cryptoWorker.terminate).toHaveBeenCalled();
    expect(transmuxWorker.terminate).toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(service.isStreaming()).toBeFalse();
    expect((service as any).state).toBeNull();
  });

  it('handles SourceBuffer append/remove success, waiting and errors', async () => {
    const sb = new EventTarget() as any;
    sb.updating = false;
    sb.appendBuffer = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    sb.remove = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    await (service as any).appendToSourceBufferRaw(sb, new ArrayBuffer(1));
    await (service as any).removeRangeRaw(sb, 0, 1);
    expect(sb.updating).toBeFalse();

    const waiting = new EventTarget() as any;
    waiting.updating = true;
    const waitingAdd = waiting.addEventListener.bind(waiting);
    waiting.addEventListener = (type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      waitingAdd(type, listener, options);
      if (type === 'updateend' && waiting.updating) {
        queueMicrotask(() => {
          waiting.updating = false;
          waiting.dispatchEvent(new Event('updateend'));
        });
      }
    };
    waiting.appendBuffer = () => queueMicrotask(() => {
      waiting.updating = false;
      waiting.dispatchEvent(new Event('updateend'));
    });
    await (service as any).appendToSourceBufferRaw(waiting, new ArrayBuffer(1));

    const failing = new EventTarget() as any;
    failing.updating = false;
    failing.appendBuffer = () => { throw new Error('append'); };
    await expectAsync((service as any).appendToSourceBufferRaw(failing, new ArrayBuffer(1)))
      .toBeRejectedWithError('append');
    const removeFailing = new EventTarget() as any;
    removeFailing.updating = false;
    removeFailing.remove = () => { throw new Error('remove'); };
    await (service as any).removeRangeRaw(removeFailing, 0, 1);
  });

  it('handles seek decisions and timeupdate scheduling guards', async () => {
    const buffered = { length: 1, start: () => 0, end: () => 20 } as any;
    const video = { currentTime: 10 } as any;
    const updateSpy = spyOn<any>(service, 'onTimeupdateTick').and.stub();
    const state: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 3,
      videoDuration: 30,
      sourceBuffers: new Map([[1, { buffered }]]),
      currentFetches: new Set<AbortController>(),
      seekGeneration: 0,
      mediaSource: { readyState: 'open' },
      processLock: Promise.resolve(),
      isRemoving: false
    };
    (service as any).onSeek(state, video);
    expect(service.isSeeking()).toBeFalse();
    expect(updateSpy).toHaveBeenCalled();
    updateSpy.and.callThrough();

    const controller = new AbortController();
    state.sourceBuffers = new Map([[1, { buffered: { length: 1, start: () => 0, end: () => 2 } }]]);
    state.currentFetches = new Set([controller]);
    video.currentTime = 25;
    const resumeSpy = spyOn<any>(service, 'clearAndResume').and.returnValue(Promise.resolve());
    (service as any).onSeek(state, video);
    expect(controller.signal.aborted).toBeTrue();
    expect(state.seekGeneration).toBe(1);
    expect(resumeSpy).toHaveBeenCalledWith(state, 1, 25, 30, video);

    const scheduleSpy = spyOn<any>(service, 'scheduleNextChunk').and.callFake((s: any) => s.nextChunkIndex++);
    const gcSpy = spyOn<any>(service, 'evictStaleRanges').and.returnValue(Promise.resolve());
    service.isSeeking.set(false);
    const tickState: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 2,
      sourceBuffers: new Map(),
      processLock: Promise.resolve()
    };
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    await tickState.processLock;
    expect(scheduleSpy).toHaveBeenCalled();
    expect(gcSpy).toHaveBeenCalled();

    tickState.aborted = true;
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    tickState.aborted = false;
    service.isSeeking.set(true);
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    service.isSeeking.set(false);
  });

  it('handles SourceBuffer removal and garbage collection guards', async () => {
    const state: any = { isRemoving: false, mediaSource: { readyState: 'open' }, sourceBuffers: new Map() };
    const sb = new EventTarget() as any;
    sb.updating = false;
    sb.buffered = { length: 1, start: () => 0, end: () => 20 };
    sb.remove = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    state.sourceBuffers.set(1, sb);
    await (service as any).evictStaleRanges(state, 15);
    expect(state.isRemoving).toBeFalse();

    await (service as any).evictStaleRanges({ ...state, isRemoving: true }, 15);
    await (service as any).evictStaleRanges({ ...state, mediaSource: { readyState: 'closed' } }, 15);
    await (service as any).evictStaleRanges({ ...state, mediaSource: { readyState: 'open' }, sourceBuffers: new Map() }, 5);

    const closed = { updating: false, remove: jasmine.createSpy('remove') } as any;
    await (service as any).removeRange({ mediaSource: { readyState: 'closed' }, isRemoving: false }, closed, 0, 1);
    expect(closed.remove).not.toHaveBeenCalled();

    const updating = { updating: true, remove: jasmine.createSpy('remove') } as any;
    await (service as any).removeRange({ mediaSource: { readyState: 'open' }, isRemoving: false }, updating, 0, 1);

    const errorSb = new EventTarget() as any;
    errorSb.updating = false;
    errorSb.remove = () => queueMicrotask(() => errorSb.dispatchEvent(new Event('error')));
    await expectAsync((service as any).removeRange(state, errorSb, 0, 1))
      .toBeRejectedWithError('SourceBuffer error during remove.');

    const throwing = { updating: false, addEventListener: () => {}, removeEventListener: () => {}, remove: () => { throw new Error('closed'); } } as any;
    await (service as any).removeRange(state, throwing, 0, 1);
    expect(state.isRemoving).toBeFalse();
  });

  it('handles worker success, ignored messages and worker errors', async () => {
    const makeWorker = (data: any) => {
      const worker = new EventTarget() as any;
      worker.postMessage = () => queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data })));
      return worker;
    };
    const cryptoWorker = makeWorker({ chunkIndex: 0, type: 'CHUNK_DECRYPTED', decryptedChunk: new ArrayBuffer(2) });
    const state: any = { cryptoWorker, fdk: new Uint8Array(32), baseNonce: new Uint8Array(24) };
    await expectAsync((service as any).sendToCryptoWorker(state, new ArrayBuffer(1), 0)).toBeResolved();

    state.cryptoWorker = makeWorker({ chunkIndex: 0, type: 'ERROR', message: 'decrypt failed' });
    await expectAsync((service as any).sendToCryptoWorker(state, new ArrayBuffer(1), 0))
      .toBeRejectedWithError('decrypt failed');

    const transmuxWorker = makeWorker({ chunkIndex: 1, type: 'CHUNK_TRANSMUXED', segments: [] });
    state.transmuxWorker = transmuxWorker;
    await expectAsync((service as any).sendToTransmuxWorker(state, new ArrayBuffer(1), 1, true)).toBeResolved();

    state.transmuxWorker = makeWorker({ chunkIndex: 1, type: 'ERROR', message: 'transmux failed' });
    await expectAsync((service as any).sendToTransmuxWorker(state, new ArrayBuffer(1), 1, false))
      .toBeRejectedWithError('transmux failed');

    state.transmuxWorker = makeWorker({ type: 'SEEK_COMPLETE', generation: 2, chunkIndex: 4 });
    await expectAsync((service as any).sendSeekToTransmuxWorker(state, 10, 2)).toBeResolvedTo(4);
  });

  it('routes video lifecycle events into buffering and seeking signals', () => {
    const video = document.createElement('video');
    const state: any = {
      aborted: false,
      activeDownloads: 3,
      nextChunkIndex: 0,
      totalChunks: 10,
      seekDebounceTimeout: null,
      removeVideoListeners: null,
      sourceBuffers: new Map()
    };
    (service as any).attachVideoListeners(state, video);
    video.dispatchEvent(new Event('waiting'));
    expect(service.isBuffering()).toBeTrue();
    video.dispatchEvent(new Event('playing'));
    expect(service.isBuffering()).toBeFalse();
    video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('seeked'));
    expect(service.isSeeking()).toBeFalse();
    state.removeVideoListeners();
  });

  it('clears a closed source buffer safely and ends an open media source', async () => {
    const closed = { readyState: 'closed' } as any;
    await expectAsync((service as any).appendToSourceBuffer(
      { mediaSource: closed, aborted: false }, {}, new ArrayBuffer(1), {} as HTMLVideoElement
    ))
      .toBeRejectedWithError('SourceBuffer indisponivel (closed).');
    const mediaSource = { readyState: 'open', endOfStream: jasmine.createSpy('endOfStream') } as any;
    const state = { mediaSource, aborted: false } as any;
    (service as any).signalEndOfStream(state);
    expect(mediaSource.endOfStream).toHaveBeenCalled();
    expect(service.isStreaming()).toBeFalse();
  });
});
