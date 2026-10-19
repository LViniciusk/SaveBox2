import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { VideoStreamService } from './video-stream.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import { ShareService } from './share.service';
import { DriveStore, DriveFile } from '../state/drive.store';
import {
  KASUMI_CHUNK_SIZE,
} from '../../../core/crypto/kasumi-format';
import { Observable, of, Subject, throwError } from 'rxjs';
import { NetworkDeadlineError } from '../upload/abortable-observable';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly terminate = jasmine.createSpy('terminate');
  readonly postMessage = jasmine.createSpy('postMessage');
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
}

class FakeMediaSource extends EventTarget {
  readyState: MediaSource['readyState'] = 'open';
  sourceBuffers: SourceBuffer[] = [];
  readonly removeSourceBuffer = jasmine.createSpy('removeSourceBuffer');
  readonly endOfStream = jasmine.createSpy('endOfStream');
}

function installPlatformFakes(): { mediaSource: FakeMediaSource; restore: () => void } {
  FakeWorker.instances = [];
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const mediaSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    writable: true,
    value: FakeMediaSource,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: jasmine.createSpy('createObjectURL').and.returnValue('blob:stream'),
  });

  const mediaSource = new FakeMediaSource();
  return {
    mediaSource,
    restore: () => {
      if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
      else delete (globalThis as any).Worker;
      if (mediaSourceDescriptor)
        Object.defineProperty(globalThis, 'MediaSource', mediaSourceDescriptor);
      else delete (globalThis as any).MediaSource;
      if (createObjectUrlDescriptor)
        Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
      else delete (URL as any).createObjectURL;
    },
  };
}

function createVideo(): any {
  return {
    currentTime: 0,
    readyState: 0,
    buffered: { length: 0, end: () => 0 },
    play: jasmine.createSpy('play').and.resolveTo(),
    removeAttribute: jasmine.createSpy('removeAttribute'),
    load: jasmine.createSpy('load'),
  };
}

function createFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: 1,
    isFolder: false,
    encryptedName: 'encrypted-name',
    decryptedName: 'movie.mp4',
    type: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 5 * 1024 * 1024,
    sizeFormatted: '5 MB',
    modifiedAt: '',
    owner: '',
    encryptedFdk: 'encrypted-fdk',
    storageProvider: 'local',
    externalStorageId: null,
    folderId: 10,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FTYP_FOURCC = 0x66747970;
const FREE_FOURCC = 0x66726565;
const SKIP_FOURCC = 0x736b6970;
const MDAT_FOURCC = 0x6d646174;
const MOOV_FOURCC = 0x6d6f6f76;
const EBML_HEADER = 0x1a45dfa3;

function writeBoxHeader(view: DataView, offset: number, size: number, type: number): void {
  view.setUint32(offset, size);
  view.setUint32(offset + 4, type);
}

function writeExtendedBoxHeader(view: DataView, offset: number, size: number, type: number): void {
  const high = Math.floor(size / 0x1_0000_0000);
  const low = size - high * 0x1_0000_0000;
  view.setUint32(offset, 1);
  view.setUint32(offset + 4, type);
  view.setUint32(offset + 8, high);
  view.setUint32(offset + 12, low);
}

function writeTopLevelPrefix(view: DataView, moovOffset: number): void {
  writeBoxHeader(view, 0, 8, FTYP_FOURCC);
  writeBoxHeader(view, 8, moovOffset - 8, FREE_FOURCC);
}

function createBootstrapState(id: number, plaintextSize: number, totalChunks: number): any {
  const sourceBuffer = {} as SourceBuffer;
  const mediaSource = {
    readyState: 'open',
    endOfStream: jasmine.createSpy('endOfStream'),
    sourceBuffers: [sourceBuffer],
  } as any;
  return {
    file: createFile({ id }),
    plaintextSize,
    totalChunks,
    dataOffset: 64,
    nextChunkIndex: 0,
    activeDownloads: 0,
    aborted: false,
    mediaSource,
    sourceBuffers: new Map([[1, sourceBuffer]]),
    codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
    currentFetches: new Set<AbortController>(),
    lifecycleController: new AbortController(),
    fdk: new Uint8Array([1]),
    baseNonce: new Uint8Array([2]),
    shareUuid: null,
  };
}

function stubBootstrapSuccess(service: VideoStreamService): jasmine.Spy {
  spyOn<any>(service, 'appendToSourceBufferRaw').and.resolveTo();
  return spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
    initData: [
      { id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) },
    ],
    segments: [{ id: 1, buffer: new ArrayBuffer(2) }],
  });
}

function createFalseMoovFixture(fakeMoovSize: number): {
  chunk0: ArrayBuffer;
  lastChunk: ArrayBuffer;
} {
  const chunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
  const chunk0View = new DataView(chunk0);
  writeBoxHeader(chunk0View, 0, 8, FTYP_FOURCC);
  writeBoxHeader(chunk0View, 8, 3 * KASUMI_CHUNK_SIZE - 8, MDAT_FOURCC);
  writeBoxHeader(chunk0View, 128, fakeMoovSize, MOOV_FOURCC);

  const lastChunk = new ArrayBuffer(KASUMI_CHUNK_SIZE);
  writeBoxHeader(new DataView(lastChunk), 0, 16, MOOV_FOURCC);
  return { chunk0, lastChunk };
}

function createUnsupportedBoxFixture(size: number): {
  chunk0: ArrayBuffer;
  lastChunk: ArrayBuffer;
} {
  const chunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
  const chunk0View = new DataView(chunk0);
  writeBoxHeader(chunk0View, 0, 8, FTYP_FOURCC);
  writeBoxHeader(chunk0View, 8, size, FREE_FOURCC);
  writeBoxHeader(chunk0View, 16, 16, MOOV_FOURCC);

  const lastChunk = new ArrayBuffer(KASUMI_CHUNK_SIZE);
  writeBoxHeader(new DataView(lastChunk), 0, 16, MOOV_FOURCC);
  return { chunk0, lastChunk };
}

describe('VideoStreamService', () => {
  let service: VideoStreamService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let kasumiSpy: jasmine.SpyObj<KasumiCryptoService>;
  let driveSpy: jasmine.SpyObj<DriveService>;
  let shareSpy: jasmine.SpyObj<ShareService>;
  let driveStoreMock: { files: ReturnType<typeof signal<DriveFile[]>> };

  beforeEach(() => {
    // Ponytail philosophy: mock all heavy dependencies to isolate pure logic and math
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['isVaultUnlocked', 'decryptName']);
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['extractMetadata']);
    driveSpy = jasmine.createSpyObj('DriveService', [
      'downloadExternalMetadata',
      'downloadExternalFileRange',
      'downloadFileRange',
    ]);
    shareSpy = jasmine.createSpyObj('ShareService', ['downloadSharedFileRange']);
    driveStoreMock = { files: signal<DriveFile[]>([]) };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        provideZonelessChangeDetection(),
        VideoStreamService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: DriveService, useValue: driveSpy },
        { provide: ShareService, useValue: shareSpy },
        { provide: DriveStore, useValue: driveStoreMock },
      ],
    });
    service = TestBed.inject(VideoStreamService);
  });

  describe('B.94 video network deadline', () => {
    beforeEach(() => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
    });
    afterEach(() => jasmine.clock().uninstall());

    it('B.94 expires an unresponsive range without aborting the owner signal', async () => {
      const source = new Subject<Blob>();
      driveSpy.downloadFileRange.and.returnValue(source);
      const controller = new AbortController();
      let error: Error | undefined;
      const pending = (service as any).fetchRange(94, 0, 99, controller)
        .catch((value: Error) => { error = value; });
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(300_000);
      await pending;
      expect(source.observed).toBeFalse();
      expect(error?.name).toBe('NetworkDeadlineError');
      expect(controller.signal.aborted).toBeFalse();
      controller.abort();
      await pending;
    });

    it('B.94 keeps one total budget across the existing retry backoff', async () => {
      const source = new Subject<Blob>();
      let subscriptions = 0;
      driveSpy.downloadFileRange.and.returnValue(new Observable<Blob>(subscriber => {
        if (++subscriptions === 1) subscriber.error({ status: 503 });
        else return source.subscribe(subscriber);
        return undefined;
      }));
      const controller = new AbortController();
      let error: Error | undefined;
      const pending = (service as any).fetchRange(94, 0, 99, controller)
        .catch((value: Error) => { error = value; });
      jasmine.clock().tick(300_000);
      await pending;
      expect(subscriptions).toBe(2);
      expect(error?.name).toBe('NetworkDeadlineError');
      expect(source.observed).toBeFalse();
      controller.abort();
      await pending;
    });

    it('B.94 bounds initialization metadata before crypto or worker acquisition', async () => {
      const metadata = new Subject<any>();
      driveSpy.downloadExternalMetadata.and.returnValue(metadata);
      const context = (service as any).beginInitialization();
      const pending = (service as any).resolveStreamSource(createFile({ storageProvider: 'google_drive' }), context);
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(metadata.observed).toBeFalse();
      expect(cryptoSpy.decryptName).not.toHaveBeenCalled();
      (service as any).finishInitialization(context);
    });

    it('B.94 limits authentication recovery to the remaining range budget', async () => {
      const range = new Subject<Blob>();
      const metadata = new Subject<any>();
      driveSpy.downloadExternalFileRange.and.returnValue(range);
      driveSpy.downloadExternalMetadata.and.returnValue(metadata);
      const credentials = { gdriveUrl: 'https://google.test/old', gdriveToken: 'synthetic-old' };
      const controller = new AbortController();
      const pending = (service as any).fetchRange(94, 0, 99, controller, credentials);
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS - 10);
      range.error({ status: 401 });
      expect(metadata.observed).toBeTrue();
      jasmine.clock().tick(10);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(metadata.observed).toBeFalse();
      metadata.next({ external_file_id: 'late', access_token: 'synthetic-late' });
      await Promise.resolve();
      expect(credentials).toEqual({ gdriveUrl: 'https://google.test/old', gdriveToken: 'synthetic-old' });
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledTimes(1);
      expect(controller.signal.aborted).toBeFalse();
    });

    it('B.94 ignores a recovery result already resolved when the range deadline wins', async () => {
      const range = new Subject<Blob>();
      const metadata = new Subject<any>();
      driveSpy.downloadExternalFileRange.and.returnValue(range);
      driveSpy.downloadExternalMetadata.and.returnValue(metadata);
      const credentials = { gdriveUrl: 'https://google.test/old', gdriveToken: 'synthetic-old' };
      const pending = (service as any).fetchRange(94, 0, 99, new AbortController(), credentials);
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS - 1);
      range.error({ status: 401 });
      metadata.next({ external_file_id: 'late', access_token: 'synthetic-late' });
      jasmine.clock().tick(1);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(credentials.gdriveToken).toBe('synthetic-old');
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledTimes(1);
    });

    it('B.94 releases download ownership and suppresses late append after a range deadline', async () => {
      const source = new Subject<Blob>();
      driveSpy.downloadFileRange.and.returnValue(source);
      const state = createBootstrapState(94, 32, 1);
      state.seekGeneration = 0;
      state.processLock = Promise.resolve();
      (service as any).state = state;
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker');
      const append = spyOn<any>(service, 'appendToSourceBufferRaw');
      const failure = spyOn<any>(service, 'failStream').and.stub();
      (service as any).scheduleNextChunk(state, createVideo());
      expect(state.activeDownloads).toBe(1);
      expect(state.currentFetches.size).toBe(1);
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      for (let i = 0; i < 15; i++) await Promise.resolve();
      expect(state.activeDownloads).toBe(0);
      expect(state.currentFetches.size).toBe(0);
      expect(source.observed).toBeFalse();
      expect(failure).toHaveBeenCalledTimes(1);
      source.next(new Blob(['late']));
      await Promise.resolve();
      expect(decrypt).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(service.bufferProgress()).toBe(0);
    });
  });

  describe('computeBufferedAhead', () => {
    it('should correctly calculate contiguous buffered ahead math handling micro-gaps', () => {
      // Arrange
      const mockTimeRanges = {
        length: 2,
        start: (index: number) => (index === 0 ? 0 : 20.1), // micro-gap from 20 to 20.1 (tolerated if <= 0.5)
        end: (index: number) => (index === 0 ? 20 : 30),
      } as TimeRanges;

      const mockSourceBuffer = {
        buffered: mockTimeRanges,
      } as SourceBuffer;

      const mockState = {
        sourceBuffers: new Map<number, SourceBuffer>([[1, mockSourceBuffer]]),
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
        start: (index: number) => (index === 0 ? 0 : 30), // macro-gap from 20 to 30 (> 0.5)
        end: (index: number) => (index === 0 ? 20 : 40),
      } as TimeRanges;

      const mockSourceBuffer = {
        buffered: mockTimeRanges,
      } as SourceBuffer;

      const mockState = {
        sourceBuffers: new Map<number, SourceBuffer>([[1, mockSourceBuffer]]),
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
      expect(
        (service as any).computeBufferedAhead(
          { sourceBuffers: new Map([[1, { buffered: empty }]]) },
          5,
        ),
      ).toBe(0);

      const behind = { length: 1, start: () => 0, end: () => 4 } as any;
      const ahead = { length: 1, start: () => 5, end: () => 25 } as any;
      const state = {
        sourceBuffers: new Map([
          [1, { buffered: behind }],
          [2, { buffered: ahead }],
        ]),
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
        file: { storageProvider: 'google_drive' },
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

      await service.initializeStream(
        {} as HTMLVideoElement,
        {
          id: 1,
          decryptedName: 'video.mp4',
          shareFdk: null,
          encryptedFdk: 'encrypted-fdk',
        } as any,
      );

      expect(service.error()).toContain('Drive trancado');
      expect(service.isStreaming()).toBeFalse();
    });

    it('rejects unlocked files whose metadata has no FDK', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);

      await service.initializeStream(
        {} as HTMLVideoElement,
        {
          id: 2,
          decryptedName: 'video.mp4',
          shareFdk: null,
          encryptedFdk: null,
        } as any,
      );

      expect(service.error()).toBe('FDK ausente nos metadados do arquivo.');
      expect(service.isStreaming()).toBeFalse();
    });
  });

  describe('B.79 EBML admission guard', () => {
    it('rejects authenticated EBML before fallback MP4 bootstrap or MP4Box work', async () => {
      const state = createBootstrapState(80, KASUMI_CHUNK_SIZE * 4, 4);
      const ebmlChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      new DataView(ebmlChunk0).setUint32(0, EBML_HEADER);
      const mp4LastChunk = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      writeBoxHeader(new DataView(mp4LastChunk), 0, 16, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.callFake(
        (_fileId: number, start: number) => Promise.resolve(new Blob([
          start === state.dataOffset ? ebmlChunk0 : mp4LastChunk,
        ])),
      );
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
        (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
          Promise.resolve(chunkIndex === 0 ? ebmlChunk0 : mp4LastChunk),
      );
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Este vídeo não está em um formato compatível com o streaming do Nanika.',
      );

      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledOnceWith(state, jasmine.any(ArrayBuffer), 0);
      expect(bootstrap).not.toHaveBeenCalled();
    });

    it('recognizes only the initial EBML magic and never reads short buffers out of bounds', () => {
      for (const size of [0, 1, 2, 3]) {
        expect((service as any).hasEbmlHeader(new ArrayBuffer(size))).toBeFalse();
      }

      const exact = new ArrayBuffer(4);
      new DataView(exact).setUint32(0, EBML_HEADER);
      expect((service as any).hasEbmlHeader(exact)).toBeTrue();

      for (const bytes of [[0x1a, 0x45, 0xdf, 0xa2], [0x00, 0x45, 0xdf, 0xa3]]) {
        const nearMiss = new Uint8Array(bytes).buffer;
        expect((service as any).hasEbmlHeader(nearMiss)).toBeFalse();
      }

      const offsetOnly = new Uint8Array(8);
      new DataView(offsetOnly.buffer).setUint32(4, EBML_HEADER);
      expect((service as any).hasEbmlHeader(offsetOnly.buffer)).toBeFalse();
    });

    it('allows MP4 bytes when the filename retains a WebM extension', async () => {
      const state = createBootstrapState(81, KASUMI_CHUNK_SIZE * 2, 2);
      state.file = createFile({ decryptedName: 'movie.webm', mimeType: 'video/mp4' });
      const mp4Chunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      writeBoxHeader(new DataView(mp4Chunk0), 0, 8, FTYP_FOURCC);
      writeBoxHeader(new DataView(mp4Chunk0), 8, 16, MOOV_FOURCC);
      spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(mp4Chunk0);
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(bootstrap).toHaveBeenCalledOnceWith(state, mp4Chunk0, null, undefined, false);
    });

    it('rejects EBML bytes for a public share before MP4Box', async () => {
      const state = createBootstrapState(82, KASUMI_CHUNK_SIZE * 2, 2);
      state.shareUuid = 'share-82';
      state.file = createFile({
        decryptedName: 'movie.webm',
        shareUuid: 'share-82',
        shareFdk: new Uint8Array([1, 2, 3]),
      });
      const ebmlChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      new DataView(ebmlChunk0).setUint32(0, EBML_HEADER);
      shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['chunk-0'])));
      spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(ebmlChunk0);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Este vídeo não está em um formato compatível com o streaming do Nanika.',
      );

      expect(shareSpy.downloadSharedFileRange).toHaveBeenCalledOnceWith(
        'share-82',
        state.dataOffset,
        state.dataOffset + KASUMI_CHUNK_SIZE + 16 - 1,
      );
      expect(bootstrap).not.toHaveBeenCalled();
    });
  });

  function prepareSuccessfulInitialization(): {
    platform: { mediaSource: FakeMediaSource; restore: () => void };
    fetchRange: jasmine.Spy;
    bootstrap: jasmine.Spy;
    attachListeners: jasmine.Spy;
    schedule: jasmine.Spy;
  } {
    const platform = installPlatformFakes();
    const header = new Blob(['header']);
    const fetchRange = spyOn<any>(service, 'fetchRange').and.returnValue(Promise.resolve(header));
    kasumiSpy.extractMetadata.and.resolveTo({
      metadata: null,
      dataOffset: 64,
      expectedSize: 5 * 1024 * 1024,
    });
    const bootstrap = spyOn<any>(service, 'bootstrapLastChunk').and.resolveTo();
    const attachListeners = spyOn<any>(service, 'attachVideoListeners').and.stub();
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    return { platform, fetchRange, bootstrap, attachListeners, schedule };
  }

  async function bootstrapWithTrailingMoov(
    fixture: { chunk0: ArrayBuffer; lastChunk: ArrayBuffer },
    id: number,
  ): Promise<{
    state: any;
    fetchRange: jasmine.Spy;
    decrypt: jasmine.Spy;
    bootstrap: jasmine.Spy;
  }> {
    const state = createBootstrapState(id, KASUMI_CHUNK_SIZE * 4, 4);
    const fetchRange = spyOn<any>(service, 'fetchRange').and.callFake(
      (_fileId: number, start: number) => Promise.resolve(new Blob([String(start)])),
    );
    const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
      (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
        Promise.resolve(chunkIndex === 0 ? fixture.chunk0 : chunkIndex === 3 ? fixture.lastChunk : new ArrayBuffer(16)),
    );
    const bootstrap = stubBootstrapSuccess(service);
    (service as any).state = state;

    await (service as any).bootstrapLastChunk(state);
    return { state, fetchRange, decrypt, bootstrap };
  }

  describe('B.93 structural tail authority', () => {
    function tailFixture(offset = 64): { chunk0: ArrayBuffer; lastChunk: ArrayBuffer } {
      const chunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const first = new DataView(chunk0);
      writeBoxHeader(first, 0, 8, FTYP_FOURCC);
      writeBoxHeader(first, 8, 3 * KASUMI_CHUNK_SIZE + offset - 8, MDAT_FOURCC);
      const lastChunk = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      writeBoxHeader(new DataView(lastChunk), offset, 32, MOOV_FOURCC);
      return { chunk0, lastChunk };
    }

    async function rejectTail(fixture: { chunk0: ArrayBuffer; lastChunk: ArrayBuffer }): Promise<void> {
      const state = createBootstrapState(9303, 4 * KASUMI_CHUNK_SIZE, 4);
      const fetch = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['encrypted']));
      spyOn<any>(service, 'sendToCryptoWorker').and.returnValues(
        Promise.resolve(fixture.chunk0), Promise.resolve(fixture.lastChunk),
      );
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;
      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejected();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(fetch.calls.count()).toBeLessThanOrEqual(2);
    }

    it('ignores a plausible moov inside tail mdat payload before the declared boundary', async () => {
      const fixture = tailFixture();
      writeBoxHeader(new DataView(fixture.lastChunk), 16, 16, MOOV_FOURCC);
      const { state, fetchRange, decrypt, bootstrap } = await bootstrapWithTrailingMoov(fixture, 9301);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state, fixture.chunk0, fixture.lastChunk.slice(64, 96), 3 * KASUMI_CHUNK_SIZE + 64,
      );
      expect(fetchRange).toHaveBeenCalledTimes(2);
      expect(decrypt.calls.allArgs().map(args => args[2])).toEqual([0, 3]);
      expect(state.nextChunkIndex).toBe(0);
    });

    it('recognizes an extended-size tail moov as the whole declared box', async () => {
      const fixture = tailFixture();
      writeExtendedBoxHeader(new DataView(fixture.lastChunk), 64, 32, MOOV_FOURCC);
      const { state, bootstrap } = await bootstrapWithTrailingMoov(fixture, 9302);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state, fixture.chunk0, fixture.lastChunk.slice(64, 96), 3 * KASUMI_CHUNK_SIZE + 64,
      );
    });

    it('rejects a truncated extended tail header without bootstrap or extra fetches', async () => {
      const fixture = tailFixture();
      const offset = KASUMI_CHUNK_SIZE - 12;
      new DataView(fixture.chunk0).setUint32(8, 3 * KASUMI_CHUNK_SIZE + offset - 8);
      const last = new DataView(fixture.lastChunk);
      writeBoxHeader(last, 64, 32, FREE_FOURCC);
      writeBoxHeader(last, offset, 1, MOOV_FOURCC);
      await rejectTail(fixture);
    });

    for (const size of [0, 1, 2, 4, 7]) {
      it(`rejects invalid tail box size ${size}`, async () => {
        const fixture = tailFixture();
        writeBoxHeader(new DataView(fixture.lastChunk), 64, size, MOOV_FOURCC);
        await rejectTail(fixture);
      });
    }

    it('rejects an unsafe extended tail size before granting arithmetic authority', async () => {
      const fixture = tailFixture();
      writeExtendedBoxHeader(new DataView(fixture.lastChunk), 64, 2 ** 53, MOOV_FOURCC);
      await rejectTail(fixture);
    });

    it('rejects a tail moov beyond the plaintext file', async () => {
      const fixture = tailFixture();
      writeBoxHeader(new DataView(fixture.lastChunk), 64, KASUMI_CHUNK_SIZE, MOOV_FOURCC);
      await rejectTail(fixture);
    });

    it('walks structural free and skip boxes without granting their payload authority', async () => {
      const fixture = tailFixture();
      const last = new DataView(fixture.lastChunk);
      writeBoxHeader(last, 64, 24, FREE_FOURCC);
      writeBoxHeader(last, 72, 16, MOOV_FOURCC);
      writeBoxHeader(last, 88, 8, SKIP_FOURCC);
      writeBoxHeader(last, 96, 32, MOOV_FOURCC);
      const { state, bootstrap } = await bootstrapWithTrailingMoov(fixture, 9304);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state, fixture.chunk0, fixture.lastChunk.slice(96, 128), 3 * KASUMI_CHUNK_SIZE + 96,
      );
    });

    it('fails closed when a tail moov begins in an unsupported earlier chunk', async () => {
      const fixture = tailFixture();
      new DataView(fixture.chunk0).setUint32(8, 3 * KASUMI_CHUNK_SIZE - 16 - 8);
      await rejectTail(fixture);
    });

    it('aborts the owned tail fetch and suppresses its late continuation after destroy', async () => {
      const fixture = tailFixture();
      const state = createBootstrapState(9305, 4 * KASUMI_CHUNK_SIZE, 4);
      Object.assign(state, {
        mediaSource: { readyState: 'closed' }, videoElement: createVideo(), videoUrl: 'blob:tail',
        cryptoWorker: new FakeWorker(), transmuxWorker: new FakeWorker(),
        seekDebounceTimeout: null, initialSeekInterval: null,
      });
      const entered = deferred<AbortController>();
      const tail = deferred<Blob>();
      spyOn<any>(service, 'fetchRange').and.callFake(
        (_id: number, start: number, _end: number, controller: AbortController) => {
          if (start === state.dataOffset) return Promise.resolve(new Blob(['first']));
          entered.resolve(controller);
          return tail.promise;
        },
      );
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(fixture.chunk0);
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;
      const pending = (service as any).bootstrapLastChunk(state);
      const controller = await entered.promise;
      service.destroyStream();
      expect(controller.signal.aborted).toBeTrue();
      tail.resolve(new Blob(['late']));
      await pending;
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(bootstrap).not.toHaveBeenCalled();
      expect((service as any).appendToSourceBufferRaw).not.toHaveBeenCalled();
      expect((service as any).state).toBeNull();
    });
  });

  describe('initializeStream characterization', () => {
    it('decrypts local FDK, prepares MediaSource state, bootstraps, attaches listeners and primes normally', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const file = createFile({ id: 30 });
      const video = createVideo();
      const { platform, fetchRange, bootstrap, attachListeners, schedule } =
        prepareSuccessfulInitialization();

      try {
        await service.initializeStream(video, file);

        const state = (service as any).state;
        expect(cryptoSpy.decryptName).toHaveBeenCalledWith('encrypted-fdk');
        expect(fetchRange).toHaveBeenCalledWith(
          30,
          0,
          128 * 1024 - 1,
          jasmine.any(AbortController),
          { gdriveUrl: null, gdriveToken: null },
          undefined,
        );
        expect(kasumiSpy.extractMetadata).toHaveBeenCalledWith(jasmine.any(Blob), state.fdk, file.sizeBytes);
        expect(state.file).toBe(file);
        expect(state.fdk).not.toBe(file.shareFdk);
        expect(state.plaintextSize).toBe(5 * 1024 * 1024);
        expect(state.totalChunks).toBe(2);
        expect(state.dataOffset).toBe(64);
        expect(state.mediaSource).toBeInstanceOf(FakeMediaSource);
        expect(video.src).toBe('blob:stream');
        expect(bootstrap).toHaveBeenCalledOnceWith(state);
        expect(attachListeners).toHaveBeenCalledOnceWith(state, video);
        expect(schedule).toHaveBeenCalledOnceWith(state, video);
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('ends a single-chunk fast-start stream only after bootstrap appends settle', async () => {
      const appendOrder: string[] = [];
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource: any = {
        readyState: 'open',
        sourceBuffers: [sourceBuffer],
      } as any;
      mediaSource.endOfStream = jasmine.createSpy('endOfStream').and.callFake(() => {
        appendOrder.push('eos');
        mediaSource.readyState = 'ended';
      });
      const video = createVideo();
      const state: any = {
        file: createFile({ id: 54 }),
        videoElement: video,
        videoUrl: 'blob:stream',
        plaintextSize: 32,
        totalChunks: 1,
        dataOffset: 0,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        cryptoWorker: { terminate: jasmine.createSpy('cryptoTerminate') },
        transmuxWorker: { terminate: jasmine.createSpy('transmuxTerminate') },
        shareUuid: null,
      };
      const decryptedChunk = new ArrayBuffer(32);
      const view = new DataView(decryptedChunk);
      writeBoxHeader(view, 0, 8, FTYP_FOURCC);
      writeBoxHeader(view, 8, 16, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [{ id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) }],
        segments: [
          { id: 1, buffer: new ArrayBuffer(2) },
          { id: 1, buffer: new ArrayBuffer(3) },
        ],
      });
      const normalTransmux = spyOn<any>(service, 'sendToTransmuxWorker');
      spyOn<any>(service, 'appendToSourceBufferRaw').and.callFake(async (_sb: SourceBuffer, buffer: ArrayBuffer) => {
        appendOrder.push(buffer.byteLength === 1 ? 'init' : 'segment');
      });
      (service as any).state = state;
      const teardown = spyOn<any>(service, 'teardownState').and.callThrough();
      service.isStreaming.set(true);

      expect(mediaSource.endOfStream).not.toHaveBeenCalled();
      await (service as any).bootstrapLastChunk(state);

      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state,
        decryptedChunk,
        null,
        undefined,
        true,
      );
      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(normalTransmux).not.toHaveBeenCalled();
      expect(state.nextChunkIndex).toBe(1);
      expect(appendOrder).toEqual(['init', 'segment', 'segment', 'eos']);
      expect(state.sourceBuffers.size).toBe(1);
      expect(state.aborted).toBeFalse();
      expect(state.cryptoWorker.terminate).not.toHaveBeenCalled();
      expect(state.transmuxWorker.terminate).not.toHaveBeenCalled();
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
      expect(teardown).not.toHaveBeenCalled();
      expect(state.videoUrl).toBe('blob:stream');
      video.currentTime = 0;
      expect(video.currentTime).toBe(0);
      expect(service.isStreaming()).toBeFalse();
    });

    it('keeps normal pipeline EOS and rejects premature or stale completion', async () => {
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
      } as any;
      const state: any = {
        file: createFile({ id: 55 }),
        dataOffset: 0,
        plaintextSize: 32,
        totalChunks: 1,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        seekGeneration: 0,
        mediaSource,
        currentFetches: new Set<AbortController>(),
        processLock: Promise.resolve(),
        sourceBuffers: new Map(),
      };
      const video = createVideo();
      spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const pipeline = spyOn<any>(service, 'runChunkPipeline').and.resolveTo();
      (service as any).state = state;
      service.isStreaming.set(true);

      (service as any).scheduleNextChunk(state, video);
      for (let i = 0; i < 6; i++) await Promise.resolve();

      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(state.nextChunkIndex).toBe(1);
      expect(state.activeDownloads).toBe(0);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);

      state.nextChunkIndex = 0;
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);

      state.nextChunkIndex = 1;
      state.activeDownloads = 1;
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);

      state.activeDownloads = 0;
      state.aborted = true;
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);

      state.aborted = false;
      (service as any).state = { mediaSource };
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
    });

    it('does not end a multi-chunk fast-start stream before the remaining chunks are consumed', () => {
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
      } as any;
      const state: any = {
        nextChunkIndex: 1,
        totalChunks: 3,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
      };
      (service as any).state = state;

      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).not.toHaveBeenCalled();

      state.nextChunkIndex = 3;
      (service as any).signalEndOfStreamIfComplete(state);
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
    });

    it('does not end a stream when a bootstrap append fails', async () => {
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
      } as any;
      const state: any = {
        file: createFile({ id: 56 }),
        plaintextSize: 32,
        totalChunks: 1,
        dataOffset: 0,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk = new ArrayBuffer(32);
      const view = new DataView(decryptedChunk);
      view.setUint32(0, 16);
      view.setUint32(4, MOOV_FOURCC);
      spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk);
      spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [{ id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) }],
        segments: [],
      });
      spyOn<any>(service, 'appendToSourceBufferRaw').and.rejectWith(new Error('append failed'));
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError('append failed');
      expect(mediaSource.endOfStream).not.toHaveBeenCalled();
      expect(state.aborted).toBeFalse();
    });

    it('handles a moov that crosses from chunk 0 into chunk 1 without replaying chunk 1', async () => {
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
        sourceBuffers: [sourceBuffer],
      } as any;
      const state: any = {
        file: createFile({ id: 57 }),
        plaintextSize: KASUMI_CHUNK_SIZE * 2,
        totalChunks: 2,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const chunk0View = new DataView(decryptedChunk0);
      const moovOffset = KASUMI_CHUNK_SIZE - 12;
      writeTopLevelPrefix(chunk0View, moovOffset);
      writeBoxHeader(chunk0View, moovOffset, 20, MOOV_FOURCC);
      const decryptedChunk1 = new ArrayBuffer(16);
      const chunk1View = new DataView(decryptedChunk1);
      chunk1View.setUint32(0, 16);
      chunk1View.setUint32(4, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.returnValues(
        Promise.resolve(new Blob(['chunk-0'])),
        Promise.resolve(new Blob(['chunk-1'])),
      );
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
        (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
          Promise.resolve(chunkIndex === 0 ? decryptedChunk0 : decryptedChunk1),
      );
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [
          { id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) },
        ],
        segments: [{ id: 1, buffer: new ArrayBuffer(2) }],
      });
      const normalTransmux = spyOn<any>(service, 'sendToTransmuxWorker');
      spyOn<any>(service, 'appendToSourceBufferRaw').and.resolveTo();
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      const macSize = 16;
      expect(fetchRange).toHaveBeenCalledTimes(2);
      expect(fetchRange.calls.argsFor(0).slice(0, 3)).toEqual([
        state.file.id,
        state.dataOffset,
        state.dataOffset + macSize + KASUMI_CHUNK_SIZE - 1,
      ]);
      expect(fetchRange.calls.argsFor(1).slice(0, 3)).toEqual([
        state.file.id,
        state.dataOffset + KASUMI_CHUNK_SIZE + macSize,
        state.dataOffset + 2 * KASUMI_CHUNK_SIZE + 2 * macSize - 1,
      ]);
      expect(decrypt).toHaveBeenCalledTimes(2);
      expect(decrypt.calls.argsFor(1)[2]).toBe(1);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state,
        decryptedChunk0,
        decryptedChunk1,
        KASUMI_CHUNK_SIZE,
        true,
      );
      expect(state.nextChunkIndex).toBe(2);
      expect(normalTransmux).not.toHaveBeenCalled();
      expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
    });

    it('uses the actual encrypted length when the crossing continuation is short', async () => {
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
        sourceBuffers: [sourceBuffer],
      } as any;
      const state: any = {
        file: createFile({ id: 571 }),
        plaintextSize: KASUMI_CHUNK_SIZE + 123,
        totalChunks: 2,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const chunk0View = new DataView(decryptedChunk0);
      const moovOffset = KASUMI_CHUNK_SIZE - 8;
      writeTopLevelPrefix(chunk0View, moovOffset);
      writeBoxHeader(chunk0View, moovOffset, 16, MOOV_FOURCC);
      const decryptedChunk1 = new ArrayBuffer(123);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.returnValues(
        Promise.resolve(new Blob(['chunk-0'])),
        Promise.resolve(new Blob(['chunk-1'])),
      );
      spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
        (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
          Promise.resolve(chunkIndex === 0 ? decryptedChunk0 : decryptedChunk1),
      );
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [
          { id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) },
        ],
        segments: [{ id: 1, buffer: new ArrayBuffer(2) }],
      });
      spyOn<any>(service, 'appendToSourceBufferRaw').and.resolveTo();
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      const macSize = 16;
      const rangeStart = state.dataOffset + KASUMI_CHUNK_SIZE + macSize;
      expect(fetchRange.calls.argsFor(1).slice(0, 3)).toEqual([
        state.file.id,
        rangeStart,
        rangeStart + macSize + 123 - 1,
      ]);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state,
        decryptedChunk0,
        decryptedChunk1,
        KASUMI_CHUNK_SIZE,
        true,
      );
      expect(state.nextChunkIndex).toBe(2);
    });

    it('keeps a five-chunk crossing bootstrap bounded and resumes at chunk 2', async () => {
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource = {
        readyState: 'open',
        endOfStream: jasmine.createSpy('endOfStream'),
        sourceBuffers: [sourceBuffer],
      } as any;
      const state: any = {
        file: createFile({ id: 58 }),
        plaintextSize: KASUMI_CHUNK_SIZE * 5,
        totalChunks: 5,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4; codecs="avc1.64001f"']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const chunk0View = new DataView(decryptedChunk0);
      const moovOffset = KASUMI_CHUNK_SIZE - 12;
      writeTopLevelPrefix(chunk0View, moovOffset);
      writeBoxHeader(chunk0View, moovOffset, 20, MOOV_FOURCC);
      const decryptedChunk1 = new ArrayBuffer(16);
      const decryptedLastChunk = new ArrayBuffer(16);
      const lastChunkView = new DataView(decryptedLastChunk);
      lastChunkView.setUint32(0, 16);
      lastChunkView.setUint32(4, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.callFake(
        (_fileId: number, start: number) => Promise.resolve(new Blob([String(start)])),
      );
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
        (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
          Promise.resolve(
            chunkIndex === 0
              ? decryptedChunk0
              : chunkIndex === 1
                ? decryptedChunk1
                : decryptedLastChunk,
          ),
      );
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [
          { id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) },
        ],
        segments: [{ id: 1, buffer: new ArrayBuffer(2) }],
      });
      spyOn<any>(service, 'appendToSourceBufferRaw').and.resolveTo();
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(fetchRange).toHaveBeenCalledTimes(2);
      expect(fetchRange.calls.argsFor(1)[1]).toBe(state.dataOffset + KASUMI_CHUNK_SIZE + 16);
      expect(decrypt).toHaveBeenCalledTimes(2);
      expect(decrypt.calls.argsFor(1)[2]).toBe(1);
      expect(bootstrap).toHaveBeenCalledOnceWith(
        state,
        decryptedChunk0,
        decryptedChunk1,
        KASUMI_CHUNK_SIZE,
        false,
      );
      expect(state.nextChunkIndex).toBe(2);
      expect(mediaSource.endOfStream).not.toHaveBeenCalled();
    });

    it('rejects a moov whose declared end is outside the plaintext file', async () => {
      const state: any = {
        file: createFile({ id: 59 }),
        plaintextSize: KASUMI_CHUNK_SIZE * 4,
        totalChunks: 4,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource: { readyState: 'open', sourceBuffers: [] },
        sourceBuffers: new Map(),
        codecStrings: new Map(),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const moovOffset = KASUMI_CHUNK_SIZE - 12;
      const view = new DataView(decryptedChunk0);
      writeTopLevelPrefix(view, moovOffset);
      view.setUint32(moovOffset, state.plaintextSize - moovOffset + 1);
      view.setUint32(moovOffset + 4, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Metadados MP4 invalidos (moov fora dos limites do arquivo).',
      );
      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(bootstrap).not.toHaveBeenCalled();
    });

    it('rejects a bounded moov that would require a second continuation chunk', async () => {
      const state: any = {
        file: createFile({ id: 60 }),
        plaintextSize: KASUMI_CHUNK_SIZE * 4,
        totalChunks: 4,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource: { readyState: 'open', sourceBuffers: [] },
        sourceBuffers: new Map(),
        codecStrings: new Map(),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const moovOffset = KASUMI_CHUNK_SIZE - 12;
      const view = new DataView(decryptedChunk0);
      writeTopLevelPrefix(view, moovOffset);
      view.setUint32(moovOffset, 2 * KASUMI_CHUNK_SIZE + 1 - moovOffset);
      view.setUint32(moovOffset + 4, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Metadados MP4 invalidos (moov exige mais de um chunk de continuacao).',
      );
      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledTimes(1);
    });

    it('does not publish a continuation after the stream is destroyed during its fetch', async () => {
      const sourceBuffer = {} as SourceBuffer;
      const mediaSource = {
        readyState: 'open',
        sourceBuffers: [sourceBuffer],
        removeSourceBuffer: jasmine.createSpy('removeSourceBuffer'),
      } as any;
      const state: any = {
        file: createFile({ id: 61 }),
        plaintextSize: KASUMI_CHUNK_SIZE * 4,
        totalChunks: 4,
        dataOffset: 64,
        nextChunkIndex: 0,
        activeDownloads: 0,
        aborted: false,
        mediaSource,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        codecStrings: new Map([[1, 'video/mp4']]),
        currentFetches: new Set<AbortController>(),
        lifecycleController: new AbortController(),
        fdk: new Uint8Array([1]),
        baseNonce: new Uint8Array([2]),
        cryptoWorker: { terminate: jasmine.createSpy('cryptoTerminate') },
        transmuxWorker: { terminate: jasmine.createSpy('transmuxTerminate') },
        videoElement: createVideo(),
        videoUrl: 'blob:stream',
        seekDebounceTimeout: null,
        initialSeekInterval: null,
        removeVideoListeners: null,
        gdriveToken: null,
        shareUuid: null,
      };
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const view = new DataView(decryptedChunk0);
      const moovOffset = KASUMI_CHUNK_SIZE - 12;
      writeTopLevelPrefix(view, moovOffset);
      writeBoxHeader(view, moovOffset, 20, MOOV_FOURCC);
      const continuation = deferred<Blob>();
      const fetchRange = spyOn<any>(service, 'fetchRange').and.returnValues(
        Promise.resolve(new Blob(['chunk-0'])),
        continuation.promise,
      );
      spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      const append = spyOn<any>(service, 'appendToSourceBufferRaw');
      (service as any).state = state;

      const pending = (service as any).bootstrapLastChunk(state);
      for (let i = 0; i < 50 && fetchRange.calls.count() < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchRange).toHaveBeenCalledTimes(2);
      expect(fetchRange.calls.argsFor(1)[1]).toBe(state.dataOffset + KASUMI_CHUNK_SIZE + 16);

      service.destroyStream();
      continuation.resolve(new Blob(['chunk-1']));
      await pending;

      expect(state.aborted).toBeTrue();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });

    it('ignores a fake moov inside mdat that would otherwise trigger a continuation fetch', async () => {
      const fixture = createFalseMoovFixture(KASUMI_CHUNK_SIZE + 128);
      const { state, fetchRange, decrypt } = await bootstrapWithTrailingMoov(fixture, 62);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([
        0,
        3,
      ]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 3]);
    });

    it('ignores a fake moov inside mdat that would otherwise require multiple continuations', async () => {
      const fixture = createFalseMoovFixture(2 * KASUMI_CHUNK_SIZE + 1 - 128);
      const { state, fetchRange, decrypt } = await bootstrapWithTrailingMoov(fixture, 63);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([
        0,
        3,
      ]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 3]);
    });

    it('ignores a fake moov inside mdat whose declared end is outside the file', async () => {
      const fixture = createFalseMoovFixture(4 * KASUMI_CHUNK_SIZE + 1 - 128);
      const { state, fetchRange, decrypt } = await bootstrapWithTrailingMoov(fixture, 64);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([
        0,
        3,
      ]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 3]);
    });

    it('walks multiple complete top-level boxes before a real moov', async () => {
      const state = createBootstrapState(65, KASUMI_CHUNK_SIZE * 2, 2);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const view = new DataView(decryptedChunk0);
      writeBoxHeader(view, 0, 8, FTYP_FOURCC);
      writeBoxHeader(view, 8, 8, FREE_FOURCC);
      writeBoxHeader(view, 16, 8, SKIP_FOURCC);
      writeBoxHeader(view, 24, 16, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(fetchRange).toHaveBeenCalledOnceWith(
        state.file.id,
        state.dataOffset,
        state.dataOffset + 16 + KASUMI_CHUNK_SIZE - 1,
        jasmine.any(AbortController),
        state,
        state.shareUuid,
      );
      expect(decrypt).toHaveBeenCalledOnceWith(state, jasmine.any(ArrayBuffer), 0);
      expect(bootstrap).toHaveBeenCalledOnceWith(state, decryptedChunk0, null, undefined, false);
      expect(state.nextChunkIndex).toBe(1);
    });

    it('does not scan arbitrary bytes after an mdat that extends beyond chunk 0', async () => {
      const fixture = createFalseMoovFixture(0);
      const view = new DataView(fixture.chunk0);
      view.setUint32(132, MOOV_FOURCC);
      const { state, fetchRange, decrypt } = await bootstrapWithTrailingMoov(fixture, 66);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([
        0,
        3,
      ]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 3]);
    });

    for (const size of [4, 0, 1]) {
      it(`rejects unsupported initial top-level size ${size} without granting tail authority`, async () => {
        await expectAsync(bootstrapWithTrailingMoov(createUnsupportedBoxFixture(size), 67))
          .toBeRejectedWithError('Metadados de video nao encontrados (moov atom ausente).');
        expect((service as any).fetchRange).toHaveBeenCalledTimes(1);
        expect((service as any).sendBootstrapToTransmuxWorker).not.toHaveBeenCalled();
      });
    }

    it('walks an extended-size box before a normal moov without falling back', async () => {
      const fixture = { chunk0: new ArrayBuffer(KASUMI_CHUNK_SIZE), lastChunk: new ArrayBuffer(KASUMI_CHUNK_SIZE) };
      const view = new DataView(fixture.chunk0);
      writeBoxHeader(view, 0, 8, FTYP_FOURCC);
      writeExtendedBoxHeader(view, 8, 24, FREE_FOURCC);
      writeBoxHeader(view, 32, 16, MOOV_FOURCC);
      writeBoxHeader(new DataView(fixture.lastChunk), 0, 16, MOOV_FOURCC);

      const { state, fetchRange, decrypt, bootstrap } = await bootstrapWithTrailingMoov(fixture, 70);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([0]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0]);
      expect(bootstrap).toHaveBeenCalledOnceWith(state, fixture.chunk0, null, undefined, false);
      expect(state.nextChunkIndex).toBe(1);
    });

    it('walks multiple boxes including an extended box before a normal moov', async () => {
      const state = createBootstrapState(71, KASUMI_CHUNK_SIZE * 2, 2);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const view = new DataView(decryptedChunk0);
      writeBoxHeader(view, 0, 8, FTYP_FOURCC);
      writeExtendedBoxHeader(view, 8, 24, FREE_FOURCC);
      writeBoxHeader(view, 32, 8, SKIP_FOURCC);
      writeBoxHeader(view, 40, 16, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledOnceWith(state, jasmine.any(ArrayBuffer), 0);
      expect(bootstrap).toHaveBeenCalledOnceWith(state, decryptedChunk0, null, undefined, false);
      expect(state.nextChunkIndex).toBe(1);
    });

    it('recognizes a complete extended-size moov in chunk 0', async () => {
      const state = createBootstrapState(72, KASUMI_CHUNK_SIZE * 2, 2);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const view = new DataView(decryptedChunk0);
      writeBoxHeader(view, 0, 8, FTYP_FOURCC);
      writeExtendedBoxHeader(view, 8, 32, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = stubBootstrapSuccess(service);
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledOnceWith(state, jasmine.any(ArrayBuffer), 0);
      expect(bootstrap).toHaveBeenCalledOnceWith(state, decryptedChunk0, null, undefined, false);
      expect(state.nextChunkIndex).toBe(1);
    });

    it('uses the existing crossing policy for an extended-size moov', async () => {
      const state = createBootstrapState(73, KASUMI_CHUNK_SIZE * 2, 2);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const decryptedChunk1 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const moovOffset = KASUMI_CHUNK_SIZE - 20;
      const view = new DataView(decryptedChunk0);
      writeTopLevelPrefix(view, moovOffset);
      writeExtendedBoxHeader(view, moovOffset, 64, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.returnValues(
        Promise.resolve(new Blob(['chunk-0'])),
        Promise.resolve(new Blob(['chunk-1'])),
      );
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.callFake(
        (_stream: any, _buffer: ArrayBuffer, chunkIndex: number) =>
          Promise.resolve(chunkIndex === 0 ? decryptedChunk0 : decryptedChunk1),
      );
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker').and.resolveTo({
        initData: [{ id: 1, codecString: 'video/mp4; codecs="avc1.64001f"', buffer: new ArrayBuffer(1) }],
        segments: [{ id: 1, buffer: new ArrayBuffer(2) }],
      });
      spyOn<any>(service, 'appendToSourceBufferRaw').and.resolveTo();
      (service as any).state = state;

      await (service as any).bootstrapLastChunk(state);

      expect(fetchRange).toHaveBeenCalledTimes(2);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 1]);
      expect(bootstrap).toHaveBeenCalledOnceWith(state, decryptedChunk0, decryptedChunk1, KASUMI_CHUNK_SIZE, true);
      expect(state.nextChunkIndex).toBe(2);
    });

    it('ignores a raw moov inside an extended mdat that exceeds chunk 0', async () => {
      const fixture = createFalseMoovFixture(0);
      const view = new DataView(fixture.chunk0);
      writeExtendedBoxHeader(view, 8, KASUMI_CHUNK_SIZE * 3 - 8, MDAT_FOURCC);
      writeBoxHeader(view, 128, 4 * KASUMI_CHUNK_SIZE, MOOV_FOURCC);
      const { state, fetchRange, decrypt } = await bootstrapWithTrailingMoov(fixture, 74);

      expect(fetchRange.calls.allArgs().map((args) => (args[1] - state.dataOffset) / (KASUMI_CHUNK_SIZE + 16))).toEqual([0, 3]);
      expect(decrypt.calls.allArgs().map((args) => args[2])).toEqual([0, 3]);
    });

    it('bounds a truncated extended-size header without reading past the buffer', () => {
      const buffer = new ArrayBuffer(12);
      writeBoxHeader(new DataView(buffer), 0, 1, FREE_FOURCC);

      expect((service as any).walkTopLevelBoxes(buffer).moov).toBeNull();
    });

    it('rejects extended sizes smaller than the 16-byte header', () => {
      for (const size of [0, 1, 8, 15]) {
        const buffer = new ArrayBuffer(16);
        writeExtendedBoxHeader(new DataView(buffer), 0, size, MOOV_FOURCC);

        expect((service as any).walkTopLevelBoxes(buffer).moov).toBeNull();
      }
    });

    it('reads Number.MAX_SAFE_INTEGER exactly for an extended-size moov', () => {
      const buffer = new ArrayBuffer(16);
      writeExtendedBoxHeader(new DataView(buffer), 0, Number.MAX_SAFE_INTEGER, MOOV_FOURCC);

      expect((service as any).walkTopLevelBoxes(buffer).moov).toEqual({
        offset: 0,
        size: Number.MAX_SAFE_INTEGER,
      });
    });

    it('rejects extended sizes above Number.MAX_SAFE_INTEGER before authority', () => {
      const buffer = new ArrayBuffer(16);
      writeExtendedBoxHeader(new DataView(buffer), 0, 0x20_0000_0000_0000, MOOV_FOURCC);

      expect((service as any).walkTopLevelBoxes(buffer).moov).toBeNull();
    });

    it('applies the existing outside-file bound to an extended-size moov', async () => {
      const state = createBootstrapState(75, KASUMI_CHUNK_SIZE * 4, 4);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const moovOffset = KASUMI_CHUNK_SIZE - 20;
      const view = new DataView(decryptedChunk0);
      writeTopLevelPrefix(view, moovOffset);
      writeExtendedBoxHeader(view, moovOffset, state.plaintextSize - moovOffset + 1, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Metadados MP4 invalidos (moov fora dos limites do arquivo).',
      );
      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(bootstrap).not.toHaveBeenCalled();
    });

    it('applies the existing one-continuation bound to an extended-size moov', async () => {
      const state = createBootstrapState(76, KASUMI_CHUNK_SIZE * 4, 4);
      const decryptedChunk0 = new ArrayBuffer(KASUMI_CHUNK_SIZE);
      const moovOffset = KASUMI_CHUNK_SIZE - 20;
      const view = new DataView(decryptedChunk0);
      writeTopLevelPrefix(view, moovOffset);
      writeExtendedBoxHeader(view, moovOffset, 2 * KASUMI_CHUNK_SIZE + 1 - moovOffset, MOOV_FOURCC);
      const fetchRange = spyOn<any>(service, 'fetchRange').and.resolveTo(new Blob(['chunk-0']));
      const decrypt = spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(decryptedChunk0);
      const bootstrap = spyOn<any>(service, 'sendBootstrapToTransmuxWorker');
      (service as any).state = state;

      await expectAsync((service as any).bootstrapLastChunk(state)).toBeRejectedWithError(
        'Metadados MP4 invalidos (moov exige mais de um chunk de continuacao).',
      );
      expect(fetchRange).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(bootstrap).not.toHaveBeenCalled();
    });

    it('grows the metadata prefix only when the first 128 KiB is structurally incomplete', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const { platform, fetchRange } = prepareSuccessfulInitialization();
      fetchRange.and.returnValues(Promise.resolve(new Blob(['small'])), Promise.resolve(new Blob(['large'])));
      kasumiSpy.extractMetadata.and.returnValues(
        Promise.reject(new Error('Partial blob is too small to contain the full metadata block')),
        Promise.resolve({ metadata: null, dataOffset: 64, expectedSize: 5 * 1024 * 1024 }),
      );

      try {
        await service.initializeStream(createVideo(), createFile({ id: 301 }));
        expect(fetchRange).toHaveBeenCalledTimes(2);
        expect(fetchRange.calls.argsFor(0).slice(0, 3)).toEqual([301, 0, 128 * 1024 - 1]);
        expect(fetchRange.calls.argsFor(1).slice(0, 3)).toEqual([301, 0, 1024 * 1024 - 1]);
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('does not retry metadata authentication failures', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const { platform, fetchRange } = prepareSuccessfulInitialization();
      kasumiSpy.extractMetadata.and.rejectWith(new Error('Failed to authenticate or decrypt KAS2 metadata'));

      try {
        await service.initializeStream(createVideo(), createFile({ id: 302 }));
        expect(fetchRange).toHaveBeenCalledOnceWith(
          302,
          0,
          128 * 1024 - 1,
          jasmine.any(AbortController),
          { gdriveUrl: null, gdriveToken: null },
          undefined,
        );
        expect(service.error()).toBe('Failed to authenticate or decrypt KAS2 metadata');
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('selects a same-folder proxy unless forceOriginal is enabled', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const original = createFile({
        id: 31,
        decryptedName: 'movie.mp4',
        encryptedFdk: 'original-fdk',
      });
      const proxy = createFile({
        id: 32,
        decryptedName: 'movie.mp4.proxy.mp4',
        encryptedFdk: 'proxy-fdk',
      });
      driveStoreMock.files.set([original, proxy]);
      const { platform, fetchRange } = prepareSuccessfulInitialization();

      try {
        await service.initializeStream(createVideo(), original);
        expect(fetchRange.calls.mostRecent().args[0]).toBe(32);
        service.destroyStream();

        await service.initializeStream(createVideo(), { ...original, forceOriginal: true });
        expect(fetchRange.calls.mostRecent().args[0]).toBe(31);
        service.destroyStream();

        driveStoreMock.files.set([original, { ...proxy, folderId: 99 }]);
        await service.initializeStream(createVideo(), original);
        expect(fetchRange.calls.mostRecent().args[0]).toBe(31);
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('bypasses vault and proxy selection for public shares and routes the header to the share source', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(false);
      const shareFdk = new Uint8Array([9, 8, 7]);
      const file = createFile({ id: 33, shareUuid: 'share-33', shareFdk, encryptedFdk: undefined });
      const proxy = createFile({ id: 34, decryptedName: 'movie.mp4.proxy.mp4' });
      driveStoreMock.files.set([file, proxy]);
      const { platform, fetchRange } = prepareSuccessfulInitialization();

      try {
        await service.initializeStream(createVideo(), file);

        const state = (service as any).state;
        expect(cryptoSpy.decryptName).not.toHaveBeenCalled();
        expect(state.file).toBe(file);
        expect(state.fdk).not.toBe(shareFdk);
        expect(Array.from(state.fdk)).toEqual(Array.from(shareFdk));
        expect(fetchRange).toHaveBeenCalledWith(
          33,
          0,
          128 * 1024 - 1,
          jasmine.any(AbortController),
          { gdriveUrl: null, gdriveToken: null },
          'share-33',
        );
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('resolves Google metadata before routing the header directly to Google', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      driveSpy.downloadExternalMetadata.and.returnValue(
        of({
          storage_provider: 'google_drive',
          external_file_id: 'test-external-id',
          access_token: 'test-access-token',
        }),
      );
      const file = createFile({ id: 35, storageProvider: 'google_drive' });
      const { platform, fetchRange } = prepareSuccessfulInitialization();

      try {
        await service.initializeStream(createVideo(), file);

        expect(driveSpy.downloadExternalMetadata).toHaveBeenCalledWith(35);
        expect(fetchRange).toHaveBeenCalledWith(
          35,
          0,
          128 * 1024 - 1,
          jasmine.any(AbortController),
          {
            gdriveUrl: 'https://www.googleapis.com/drive/v3/files/test-external-id?alt=media',
            gdriveToken: 'test-access-token',
          },
          undefined,
        );
        expect(driveSpy.downloadFileRange).not.toHaveBeenCalled();
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('preserves initial seek setup without scheduling the normal first chunk', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const video = createVideo();
      const { platform, schedule } = prepareSuccessfulInitialization();

      try {
        await service.initializeStream(video, createFile({ id: 36 }), 12);

        expect(video.currentTime).toBe(12);
        expect(schedule).not.toHaveBeenCalled();
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('surfaces metadata failure and stops streaming before publishing a state', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      spyOn<any>(service, 'fetchRange').and.returnValue(Promise.resolve(new Blob(['header'])));
      kasumiSpy.extractMetadata.and.rejectWith(new Error('metadata failed'));

      await service.initializeStream(createVideo(), createFile({ id: 37 }));

      expect(service.error()).toBe('metadata failed');
      expect(service.isStreaming()).toBeFalse();
      expect((service as any).state).toBeNull();
    });
  });

  describe('initialization lifecycle hardening', () => {
    it('invalidates and aborts initialization when destroyed before state commit', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const pending = deferred<Blob>();
      let headerController!: AbortController;
      spyOn<any>(service, 'fetchRange').and.callFake((...args: any[]) => {
        headerController = args[3];
        return pending.promise;
      });

      const init = service.initializeStream(createVideo(), createFile({ id: 40 }));
      for (let i = 0; i < 20 && !headerController; i++) await Promise.resolve();
      service.destroyStream();
      expect(headerController.signal.aborted).toBeTrue();

      pending.resolve(new Blob(['header']));
      await init;
      expect((service as any).state).toBeNull();
    });

    it('keeps the newest stream when an older initialization completes later', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const platform = installPlatformFakes();
      const pendingA = deferred<Blob>();
      const pendingB = deferred<Blob>();
      const fetchRange = spyOn<any>(service, 'fetchRange').and.callFake((fileId: number) => {
        return fileId === 41 ? pendingA.promise : pendingB.promise;
      });
      kasumiSpy.extractMetadata.and.resolveTo({
        metadata: null,
        dataOffset: 64,
        expectedSize: 5 * 1024 * 1024,
      });
      spyOn<any>(service, 'bootstrapLastChunk').and.resolveTo();
      spyOn<any>(service, 'attachVideoListeners').and.stub();
      spyOn<any>(service, 'scheduleNextChunk').and.stub();

      try {
        const first = service.initializeStream(createVideo(), createFile({ id: 41 }));
        for (let i = 0; i < 20 && fetchRange.calls.count() < 1; i++) await Promise.resolve();
        const second = service.initializeStream(createVideo(), createFile({ id: 42 }));
        for (let i = 0; i < 20 && fetchRange.calls.count() < 2; i++) await Promise.resolve();
        expect(fetchRange).toHaveBeenCalledTimes(2);

        pendingB.resolve(new Blob(['header-b']));
        await second;
        expect((service as any).state.file.id).toBe(42);

        pendingA.resolve(new Blob(['header-a']));
        await first;
        expect((service as any).state.file.id).toBe(42);
        expect(service.error()).toBeNull();
        expect(service.isStreaming()).toBeTrue();
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('ignores a stale initialization failure and preserves the newer workers', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const platform = installPlatformFakes();
      const bootstrapA = deferred<void>();
      let bootstrapStarted = false;
      spyOn<any>(service, 'fetchRange').and.returnValue(Promise.resolve(new Blob(['header'])));
      kasumiSpy.extractMetadata.and.resolveTo({
        metadata: null,
        dataOffset: 64,
        expectedSize: 5 * 1024 * 1024,
      });
      spyOn<any>(service, 'bootstrapLastChunk').and.callFake((state: any) =>
        state.file.id === 43
          ? ((bootstrapStarted = true), bootstrapA.promise)
          : Promise.resolve(),
      );
      spyOn<any>(service, 'attachVideoListeners').and.stub();
      spyOn<any>(service, 'scheduleNextChunk').and.stub();

      try {
        const first = service.initializeStream(createVideo(), createFile({ id: 43 }));
        for (let i = 0; i < 100 && !bootstrapStarted; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(bootstrapStarted).toBeTrue();
        expect((service as any).state.file.id).toBe(43);
        const second = service.initializeStream(createVideo(), createFile({ id: 44 }));
        await second;
        const workers = [...FakeWorker.instances];
        bootstrapA.reject(new Error('stale initialization failed'));
        await first;

        expect((service as any).state.file.id).toBe(44);
        expect(service.error()).toBeNull();
        expect(service.isStreaming()).toBeTrue();
        expect(workers.slice(-2).every((worker) => !worker.terminate.calls.any())).toBeTrue();
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('zeroizes an owned FDK when Google metadata resolution fails before stream input handoff', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      const ownedFdk = new Uint8Array([1, 2, 3, 4]);
      spyOn<any>(service, 'resolveOwnedFdk').and.resolveTo(ownedFdk);
      driveSpy.downloadExternalMetadata.and.returnValue(
        new Observable((subscriber) => subscriber.error(new Error('google metadata failed'))),
      );

      await service.initializeStream(
        createVideo(),
        createFile({ id: 53, storageProvider: 'google_drive' }),
      );

      expect(Array.from(ownedFdk).every((value) => value === 0)).toBeTrue();
    });

    it('zeroizes an owned FDK when Google metadata resolution is aborted by destroy before state commit', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      const ownedFdk = new Uint8Array([5, 6, 7]);
      const metadata = new Subject<any>();
      spyOn<any>(service, 'resolveOwnedFdk').and.resolveTo(ownedFdk);
      driveSpy.downloadExternalMetadata.and.returnValue(metadata.asObservable());

      const initialization = service.initializeStream(
        createVideo(),
        createFile({ id: 54, storageProvider: 'google_drive' }),
      );
      for (let i = 0; i < 20 && driveSpy.downloadExternalMetadata.calls.count() === 0; i++)
        await Promise.resolve();

      expect(driveSpy.downloadExternalMetadata).toHaveBeenCalledOnceWith(54);
      service.destroyStream();
      await initialization;

      expect(Array.from(ownedFdk).every((value) => value === 0)).toBeTrue();
      expect((service as any).state).toBeNull();
      expect(service.isStreaming()).toBeFalse();
      expect(service.error()).toBeNull();
    });

    it('blocks stale media side effects and zeroizes key material during base nonce read', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      const platform = installPlatformFakes();
      const video = createVideo();
      video.src = 'blob:preexisting';
      const ownedFdk = new Uint8Array([8, 9, 10, 11]);
      const nonceBytes = new Uint8Array(24);
      nonceBytes.fill(7);
      const nonceRead = deferred<ArrayBuffer>();
      let nonceReadStarted = false;
      const header = {
        size: 128,
        slice: jasmine.createSpy('slice').and.callFake((start: number, end: number) => {
          expect(start).toBe(0);
          expect(end).toBe(24);
          return {
            arrayBuffer: () => {
              nonceReadStarted = true;
              return nonceRead.promise;
            },
          };
        }),
      } as unknown as Blob;

      spyOn<any>(service, 'resolveOwnedFdk').and.resolveTo(ownedFdk);
      spyOn<any>(service, 'fetchRange').and.resolveTo(header);
      kasumiSpy.extractMetadata.and.resolveTo({
        metadata: null,
        dataOffset: 64,
        expectedSize: 5 * 1024 * 1024,
      });
      spyOn<any>(service, 'bootstrapLastChunk').and.resolveTo();
      spyOn<any>(service, 'attachVideoListeners').and.stub();
      spyOn<any>(service, 'scheduleNextChunk').and.stub();
      const initialization = service.initializeStream(video, createFile({ id: 55 }));

      try {
        for (let i = 0; i < 20 && !nonceReadStarted; i++) await Promise.resolve();
        expect(nonceReadStarted).toBeTrue();

        service.destroyStream();
        nonceRead.resolve(nonceBytes.buffer);
        await initialization;

        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(video.src).toBe('blob:preexisting');
        expect((service as any).state).toBeNull();
        expect(service.isStreaming()).toBeFalse();
        expect(service.error()).toBeNull();
        expect(Array.from(ownedFdk).every((value) => value === 0)).toBeTrue();
        expect(Array.from(nonceBytes).every((value) => value === 0)).toBeTrue();
      } finally {
        service.destroyStream();
        platform.restore();
      }
    });

    it('owns and zeroizes stream key material independently from shared metadata', async () => {
      const shareFdk = new Uint8Array([9, 8, 7]);
      const setup = prepareSuccessfulInitialization();
      try {
        const file = createFile({ id: 45, shareUuid: 'share-45', shareFdk });
        await service.initializeStream(createVideo(), file);
        const state = (service as any).state;
        expect(state.fdk).not.toBe(shareFdk);
        shareFdk[0] = 1;
        expect(state.fdk[0]).toBe(9);
        const fdk = state.fdk;
        const baseNonce = state.baseNonce;

        service.destroyStream();
        expect(Array.from(fdk).every((value) => value === 0)).toBeTrue();
        expect(Array.from(baseNonce).every((value) => value === 0)).toBeTrue();
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('zeroizes locally decrypted FDK and nonce after normal teardown', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const setup = prepareSuccessfulInitialization();
      try {
        await service.initializeStream(createVideo(), createFile({ id: 451 }));
        const state = (service as any).state;
        const fdk = state.fdk;
        const baseNonce = state.baseNonce;
        service.destroyStream();
        expect(Array.from(fdk).every((value) => value === 0)).toBeTrue();
        expect(Array.from(baseNonce).every((value) => value === 0)).toBeTrue();
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('cleans the committed session when bootstrap fails', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const revoke = spyOn(URL, 'revokeObjectURL');
      const setup = prepareSuccessfulInitialization();
      setup.bootstrap.and.rejectWith(new Error('bootstrap failed'));
      try {
        await service.initializeStream(createVideo(), createFile({ id: 46 }));
        expect((service as any).state).toBeNull();
        expect(service.error()).toBe('bootstrap failed');
        expect(FakeWorker.instances.every((worker) => worker.terminate.calls.any())).toBeTrue();
        expect(revoke).toHaveBeenCalledWith('blob:stream');
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('cancels the RxJS subscription when a range request is aborted', async () => {
      const pending = new Subject<Blob>();
      driveSpy.downloadFileRange.and.returnValue(pending.asObservable());
      const controller = new AbortController();
      const request = (service as any).fetchRange(47, 0, 10, controller);
      await Promise.resolve();
      expect(pending.observed).toBeTrue();

      controller.abort();
      await expectAsync(request).toBeRejectedWithError('Fetch aborted.');
      expect(pending.observed).toBeFalse();
    });

    it('terminates a worker already created when the second worker fails', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const setup = prepareSuccessfulInitialization();
      const CreatedThenThrows = class extends FakeWorker {
        private static count = 0;
        constructor() {
          super();
          if (++CreatedThenThrows.count === 2) throw new Error('worker creation failed');
        }
      };
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: CreatedThenThrows,
      });
      try {
        await service.initializeStream(createVideo(), createFile({ id: 48 }));
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('cancels a scheduled retry when the range request is aborted', async () => {
      jasmine.clock().install();
      const attempts = jasmine.createSpy('attempts');
      driveSpy.downloadFileRange.and.returnValue(
        new Observable<Blob>((subscriber) => {
          attempts();
          subscriber.error(new Error('transient failure'));
        }),
      );
      const controller = new AbortController();
      const request = (service as any).fetchRange(49, 0, 10, controller);
      await Promise.resolve();
      controller.abort();
      jasmine.clock().tick(10_000);

      try {
        await expectAsync(request).toBeRejectedWithError('Fetch aborted.');
        expect(attempts).toHaveBeenCalledTimes(1);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('zeroizes a temporary non-share FDK when metadata extraction fails', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      let fdk!: Uint8Array;
      spyOn<any>(service, 'fetchRange').and.returnValue(Promise.resolve(new Blob(['header'])));
      kasumiSpy.extractMetadata.and.callFake((_header: Blob, receivedFdk: Uint8Array) => {
        fdk = receivedFdk;
        return Promise.reject(new Error('metadata failed'));
      });

      await service.initializeStream(createVideo(), createFile({ id: 50 }));
      expect(Array.from(fdk).every((value) => value === 0)).toBeTrue();
    });

    it('stores and cancels the initial-seek interval during teardown', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const setup = prepareSuccessfulInitialization();
      const video = createVideo();
      try {
        await service.initializeStream(video, createFile({ id: 51 }), 12);
        const state = (service as any).state;
        expect(state.initialSeekInterval).not.toBeNull();
        service.destroyStream();
        expect(video.play).not.toHaveBeenCalled();
        expect(state.initialSeekInterval).toBeNull();
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('cancels the seek debounce callback during teardown', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const setup = prepareSuccessfulInitialization();
      setup.attachListeners.and.callThrough();
      const video = document.createElement('video');
      let clockInstalled = false;
      try {
        await service.initializeStream(video, createFile({ id: 52 }));
        const onSeek = spyOn<any>(service, 'onSeek').and.stub();
        jasmine.clock().install();
        clockInstalled = true;
        video.dispatchEvent(new Event('seeking'));
        expect((service as any).state.seekDebounceTimeout).not.toBeNull();
        service.destroyStream();
        jasmine.clock().tick(500);
        expect(onSeek).not.toHaveBeenCalled();
      } finally {
        service.destroyStream();
        setup.platform.restore();
        if (clockInstalled) jasmine.clock().uninstall();
      }
    });

    it('revokes an owned ObjectURL when worker creation fails before commit', async () => {
      cryptoSpy.isVaultUnlocked.and.returnValue(true);
      cryptoSpy.decryptName.and.resolveTo('AQID');
      const setup = prepareSuccessfulInitialization();
      const revoke = spyOn(URL, 'revokeObjectURL');
      spyOn<any>(service, 'createWorkers').and.throwError('worker creation failed');
      try {
        await service.initializeStream(createVideo(), createFile({ id: 53 }));
        expect(revoke).toHaveBeenCalledWith('blob:stream');
        expect((service as any).state).toBeNull();
      } finally {
        service.destroyStream();
        setup.platform.restore();
      }
    });

    it('does not let stale cleanup remove a newer ObjectURL on the same video', async () => {
      const platform = installPlatformFakes();
      const video = document.createElement('video');
      video.src = 'blob:b';
      const removeAttribute = spyOn(video, 'removeAttribute').and.callThrough();
      const revoke = spyOn(URL, 'revokeObjectURL');
      try {
        (service as any).cleanupInitializationResources(
          video,
          'blob:a',
          platform.mediaSource,
          null,
          null,
          null,
          null,
        );
        expect(revoke).toHaveBeenCalledWith('blob:a');
        expect(removeAttribute).not.toHaveBeenCalled();
        expect(video.src).toBe('blob:b');
      } finally {
        platform.restore();
      }
    });
  });

  describe('Range routing', () => {
    it('uses the share endpoint when a share UUID is present', async () => {
      const blob = new Blob(['shared']);
      shareSpy.downloadSharedFileRange.and.returnValue(of(blob));

      const result = await (service as any).fetchRange(
        1,
        10,
        20,
        new AbortController(),
        { gdriveUrl: null, gdriveToken: null },
        'share-123',
      );

      expect(result).toBe(blob);
      expect(shareSpy.downloadSharedFileRange).toHaveBeenCalledWith('share-123', 10, 20);
      expect(driveSpy.downloadFileRange).not.toHaveBeenCalled();
    });

    it('uses the Google Drive endpoint when an external URL and token are present', async () => {
      const blob = new Blob(['external']);
      driveSpy.downloadExternalFileRange.and.returnValue(of(blob));

      const result = await (service as any).fetchRange(
        1,
        10,
        20,
        new AbortController(),
        { gdriveUrl: 'https://drive/file', gdriveToken: 'token' },
      );

      expect(result).toBe(blob);
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledWith(
        'https://drive/file',
        'token',
        10,
        20,
      );
    });

    it('fails immediately when the range request is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expectAsync((service as any).fetchRange(1, 0, 1, controller)).toBeRejectedWithError(
        'Fetch aborted.',
      );
    });
  });

  it('tears down an active session and resets public streaming state', () => {
    const controller = new AbortController();
    const cryptoWorker = jasmine.createSpyObj<Worker>('cryptoWorker', ['terminate']);
    const transmuxWorker = jasmine.createSpyObj<Worker>('transmuxWorker', ['terminate']);
    const mediaSource = {
      readyState: 'open',
      sourceBuffers: [],
      removeSourceBuffer: jasmine.createSpy('removeSourceBuffer'),
    } as any;
    const video = {
      src: 'blob:stream',
      removeAttribute: jasmine.createSpy('removeAttribute'),
      load: jasmine.createSpy('load'),
    } as any;
    (service as any).state = {
      aborted: false,
      currentFetches: new Set([controller]),
      removeVideoListeners: jasmine.createSpy('removeVideoListeners'),
      cryptoWorker,
      transmuxWorker,
      mediaSource,
      videoUrl: 'blob:stream',
      videoElement: video,
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
    const removeListener = spyOn(sb, 'removeEventListener').and.callThrough();
    sb.appendBuffer = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    sb.remove = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    await (service as any).appendToSourceBufferRaw(sb, new ArrayBuffer(1));
    expect(removeListener).toHaveBeenCalledWith('updateend', jasmine.any(Function));
    expect(removeListener).toHaveBeenCalledWith('error', jasmine.any(Function));
    await (service as any).removeRangeRaw(sb, 0, 1);
    expect(sb.updating).toBeFalse();

    const waiting = new EventTarget() as any;
    waiting.updating = true;
    const waitingAdd = waiting.addEventListener.bind(waiting);
    waiting.addEventListener = (
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      waitingAdd(type, listener, options);
      if (type === 'updateend' && waiting.updating) {
        queueMicrotask(() => {
          waiting.updating = false;
          waiting.dispatchEvent(new Event('updateend'));
        });
      }
    };
    waiting.appendBuffer = () =>
      queueMicrotask(() => {
        waiting.updating = false;
        waiting.dispatchEvent(new Event('updateend'));
      });
    await (service as any).appendToSourceBuffer(
      { aborted: false, seekGeneration: 1, mediaSource: { readyState: 'open' } },
      1,
      waiting,
      new ArrayBuffer(1),
      { currentTime: 0 } as HTMLVideoElement,
    );

    const failing = new EventTarget() as any;
    failing.updating = false;
    failing.appendBuffer = () => {
      throw new Error('append');
    };
    await expectAsync(
      (service as any).appendToSourceBufferRaw(failing, new ArrayBuffer(1)),
    ).toBeRejectedWithError('append');
    const removeFailing = new EventTarget() as any;
    removeFailing.updating = false;
    removeFailing.remove = () => {
      throw new Error('remove');
    };
    await (service as any).removeRangeRaw(removeFailing, 0, 1);
  });

  it('reproduces a stale append after updateend invalidates its generation', async () => {
    const sb = new EventTarget() as any;
    sb.updating = true;
    sb.appendBuffer = jasmine.createSpy('appendBuffer').and.callFake(() =>
      queueMicrotask(() => sb.dispatchEvent(new Event('updateend'))),
    );
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
    };

    const pending = (service as any).appendToSourceBuffer(
      state,
      1,
      sb,
      new ArrayBuffer(1),
      { currentTime: 0 } as HTMLVideoElement,
    );
    state.seekGeneration = 2;
    sb.updating = false;
    sb.dispatchEvent(new Event('updateend'));

    await pending;
    expect(sb.appendBuffer).not.toHaveBeenCalled();
  });

  it('does not append when the operation is already stale before waiting', async () => {
    const sb = new EventTarget() as any;
    sb.updating = false;
    sb.appendBuffer = jasmine.createSpy('appendBuffer');

    await (service as any).appendToSourceBuffer(
      { aborted: false, seekGeneration: 2, mediaSource: { readyState: 'open' } },
      1,
      sb,
      new ArrayBuffer(1),
      { currentTime: 0 } as HTMLVideoElement,
    );

    expect(sb.appendBuffer).not.toHaveBeenCalled();
  });

  it('does not append segment B after generation changes between worker segments', async () => {
    const sb = new EventTarget() as any;
    sb.updating = false;
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      totalChunks: 1,
      plaintextSize: 1,
      mediaSource: { readyState: 'open' },
      sourceBuffers: new Map([[1, sb]]),
    };
    const segmentA = new ArrayBuffer(1);
    const segmentB = new ArrayBuffer(1);
    const appendBuffer = (sb.appendBuffer = jasmine.createSpy('appendBuffer').and.callFake(() => {
      if (appendBuffer.calls.count() === 1) state.seekGeneration = 2;
      queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    }));
    spyOn<any>(service, 'sendToCryptoWorker').and.resolveTo(new ArrayBuffer(1));
    spyOn<any>(service, 'sendToTransmuxWorker').and.resolveTo({
      segments: [
        { id: 1, buffer: segmentA },
        { id: 1, buffer: segmentB },
      ],
    });

    await (service as any).runChunkPipeline(
      state,
      1,
      0,
      1,
      Promise.resolve(new ArrayBuffer(1)),
      { currentTime: 0 } as HTMLVideoElement,
    );

    expect(appendBuffer).toHaveBeenCalledTimes(1);
  });

  it('stops a quota retry when seek invalidates its generation', async () => {
    jasmine.clock().install();
    try {
      const sb = new EventTarget() as any;
      sb.updating = false;
      const appendBuffer = (sb.appendBuffer = jasmine.createSpy('appendBuffer').and.callFake(() => {
        throw { name: 'QuotaExceededError' };
      }));
      const state: any = {
        aborted: false,
        seekGeneration: 1,
        mediaSource: { readyState: 'open' },
      };
      const pending = (service as any).appendToSourceBuffer(
        state,
        1,
        sb,
        new ArrayBuffer(1),
        { currentTime: 0 } as HTMLVideoElement,
      );

      await Promise.resolve();
      await Promise.resolve();
      state.seekGeneration = 2;
      jasmine.clock().tick(500);
      await pending;

      expect(appendBuffer).toHaveBeenCalledTimes(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('debounces rapid seeking and uses the final position once', () => {
    jasmine.clock().install();
    const video = document.createElement('video');
    const state: any = {
      seekDebounceTimeout: null,
      removeVideoListeners: null,
    };
    const onSeek = spyOn<any>(service, 'onSeek').and.stub();

    try {
      (service as any).attachVideoListeners(state, video);
      video.currentTime = 10;
      video.dispatchEvent(new Event('seeking'));
      jasmine.clock().tick(100);
      video.currentTime = 20;
      video.dispatchEvent(new Event('seeking'));
      jasmine.clock().tick(100);
      video.currentTime = 30;
      video.dispatchEvent(new Event('seeking'));
      jasmine.clock().tick(299);

      expect(onSeek).not.toHaveBeenCalled();
      jasmine.clock().tick(1);

      expect(onSeek).toHaveBeenCalledTimes(1);
      expect(onSeek.calls.mostRecent().args[1].currentTime).toBe(30);
    } finally {
      state.removeVideoListeners?.();
      if (state.seekDebounceTimeout) clearTimeout(state.seekDebounceTimeout);
      jasmine.clock().uninstall();
    }
  });

  it('keeps the application seek barrier through the native seeked event', () => {
    jasmine.clock().install();
    const video = document.createElement('video');
    const state: any = {
      seekDebounceTimeout: null,
      removeVideoListeners: null,
    };
    spyOn<any>(service, 'onSeek').and.stub();

    try {
      (service as any).attachVideoListeners(state, video);
      video.dispatchEvent(new Event('seeking'));
      expect(service.isSeeking()).toBeTrue();

      video.dispatchEvent(new Event('seeked'));
      expect(service.isSeeking()).toBeTrue();
    } finally {
      state.removeVideoListeners?.();
      if (state.seekDebounceTimeout) clearTimeout(state.seekDebounceTimeout);
      jasmine.clock().uninstall();
    }
  });

  it('blocks normal timeupdate work while the seek debounce is pending', () => {
    jasmine.clock().install();
    const video = document.createElement('video');
    const state: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 2,
      sourceBuffers: new Map(),
      processLock: Promise.resolve(),
      seekGeneration: 1,
      seekDebounceTimeout: null,
      removeVideoListeners: null,
    };
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    const evict = spyOn<any>(service, 'evictStaleRanges').and.returnValue(Promise.resolve());
    spyOn<any>(service, 'onSeek').and.stub();

    try {
      (service as any).attachVideoListeners(state, video);
      video.dispatchEvent(new Event('seeking'));
      video.currentTime = 15;
      video.dispatchEvent(new Event('timeupdate'));

      expect(schedule).not.toHaveBeenCalled();
      expect(evict).not.toHaveBeenCalled();
    } finally {
      state.removeVideoListeners?.();
      if (state.seekDebounceTimeout) clearTimeout(state.seekDebounceTimeout);
      jasmine.clock().uninstall();
    }
  });

  it('keeps an unbuffered seek blocked until application resync completes', async () => {
    const video = document.createElement('video');
    const seekResult = deferred<{ chunkIndex: number; resumeTime: number; exactOffset: number }>();
    const sourceBuffer = {
      updating: false,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      abort: jasmine.createSpy('abort'),
    } as any;
    const state: any = {
      aborted: false,
      videoDuration: 30,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      totalChunks: 10,
      nextChunkIndex: 0,
      processLock: Promise.resolve(),
      mediaSource: { readyState: 'open' },
      seekDebounceTimeout: null,
      removeVideoListeners: null,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.returnValue(seekResult.promise);
    spyOn<any>(service, 'scheduleNextChunk').and.stub();
    (service as any).attachVideoListeners(state, video);

    video.currentTime = 25;
    (service as any).onSeek(state, video);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isSeeking()).toBeTrue();

    video.dispatchEvent(new Event('seeked'));
    expect(service.isSeeking()).toBeTrue();

    seekResult.resolve({ chunkIndex: 5, resumeTime: 24, exactOffset: 5 * KASUMI_CHUNK_SIZE + 12 });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(service.isSeeking()).toBeFalse();
    state.removeVideoListeners?.();
  });

  it('clears forward MSE data from the MP4Box resume boundary', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.abort = jasmine.createSpy('abort');
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE + 1234,
    });
    spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(state.nextChunkIndex).toBe(6);
    expect(service.isSeeking()).toBeFalse();
  });

  it('resets each SourceBuffer parser after cleanup and before scheduling the next chunk', async () => {
    const events: string[] = [];
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      events.push('remove');
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort').and.callFake(() => {
      expect(sourceBuffer.updating).toBeFalse();
      expect(service.isSeeking()).toBeTrue();
      events.push('abort');
    });
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE + 1234,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.callFake(() => {
      events.push('schedule');
    });
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.abort).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['remove', 'abort', 'schedule']);
    expect(state.nextChunkIndex).toBe(6);
    expect(schedule).toHaveBeenCalledOnceWith(jasmine.anything(), jasmine.anything());
  });

  it('reopens an ended MediaSource through remove before resetting and scheduling', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      mediaSource.readyState = 'open';
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBuffer.abort).toHaveBeenCalledOnceWith();
    expect(state.nextChunkIndex).toBe(6);
    expect(schedule).toHaveBeenCalledOnceWith(jasmine.anything(), jasmine.anything());
  });

  it('reopens an ended MediaSource even when no forward range remains', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      mediaSource.readyState = 'open';
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBuffer.abort).toHaveBeenCalledOnceWith();
    expect(state.nextChunkIndex).toBe(6);
    expect(schedule).toHaveBeenCalledOnceWith(jasmine.anything(), jasmine.anything());
  });

  it('allows removeRange to use native ended-to-open semantics but not closed state', async () => {
    const endedSourceBuffer = new EventTarget() as any;
    const endedMediaSource = { readyState: 'ended' } as any;
    endedSourceBuffer.updating = false;
    endedSourceBuffer.remove = jasmine.createSpy('endedRemove').and.callFake(() => {
      endedMediaSource.readyState = 'open';
      queueMicrotask(() => endedSourceBuffer.dispatchEvent(new Event('updateend')));
    });

    await (service as any).removeRange(
      { mediaSource: endedMediaSource, isRemoving: false } as any,
      endedSourceBuffer,
      0,
      1,
    );

    expect(endedSourceBuffer.remove).toHaveBeenCalledOnceWith(0, 1);

    const closedSourceBuffer = { remove: jasmine.createSpy('closedRemove'), updating: false } as any;
    await (service as any).removeRange(
      { mediaSource: { readyState: 'closed' }, isRemoving: false } as any,
      closedSourceBuffer,
      0,
      1,
    );

    expect(closedSourceBuffer.remove).not.toHaveBeenCalled();
  });

  it('reopens once and removes real ranges across multiple SourceBuffers', async () => {
    const mediaSource = { readyState: 'ended' } as any;
    const sourceBufferA = new EventTarget() as any;
    const sourceBufferB = new EventTarget() as any;
    for (const sourceBuffer of [sourceBufferA, sourceBufferB]) sourceBuffer.updating = false;
    sourceBufferA.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBufferB.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBufferA.remove = jasmine.createSpy('removeA').and.callFake(() => {
      mediaSource.readyState = 'open';
      queueMicrotask(() => sourceBufferA.dispatchEvent(new Event('updateend')));
    });
    sourceBufferB.remove = jasmine.createSpy('removeB').and.callFake(() => {
      queueMicrotask(() => sourceBufferB.dispatchEvent(new Event('updateend')));
    });
    sourceBufferA.abort = jasmine.createSpy('abortA');
    sourceBufferB.abort = jasmine.createSpy('abortB');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([
        [1, sourceBufferA],
        [2, sourceBufferB],
      ]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBufferA.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBufferB.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBufferA.abort).toHaveBeenCalledOnceWith();
    expect(sourceBufferB.abort).toHaveBeenCalledOnceWith();
    expect(schedule).toHaveBeenCalledOnceWith(jasmine.anything(), jasmine.anything());
  });

  it('stops safely when teardown aborts an ended-MediaSource reopen', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      state.aborted = true;
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBuffer.abort).not.toHaveBeenCalled();
    expect(state.nextChunkIndex).toBe(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('discards an ended-MediaSource reopen when the seek generation becomes stale', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      state.seekGeneration = 4;
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBuffer.abort).not.toHaveBeenCalled();
    expect(state.nextChunkIndex).toBe(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not remove an empty open buffer before resetting and scheduling', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.remove = jasmine.createSpy('remove');
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBuffer.remove).not.toHaveBeenCalled();
    expect(sourceBuffer.abort).toHaveBeenCalledOnceWith();
    expect(schedule).toHaveBeenCalledOnceWith(jasmine.anything(), jasmine.anything());
  });

  it('keeps closed MediaSource terminal at clearAndResume entry', async () => {
    const sourceBuffer = {
      buffered: { length: 0, start: () => 0, end: () => 0 },
      remove: jasmine.createSpy('remove'),
      abort: jasmine.createSpy('abort'),
      updating: false,
    } as any;
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'closed' },
      isRemoving: false,
    };
    const workerSeek = spyOn<any>(service, 'sendSeekToTransmuxWorker');
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(service.isSeeking()).toBeFalse();
    expect(workerSeek).not.toHaveBeenCalled();
    expect(sourceBuffer.remove).not.toHaveBeenCalled();
    expect(sourceBuffer.abort).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('propagates an abort failure after an ended-MediaSource reopen', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      mediaSource.readyState = 'open';
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    sourceBuffer.abort = jasmine.createSpy('abort').and.throwError('abort failed after reopen');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await expectAsync(
      (service as any).clearAndResume(
        state,
        3,
        62.4,
        120,
        { currentTime: 62.4 } as HTMLVideoElement,
      ),
    ).toBeRejectedWithError('abort failed after reopen');

    expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(state.nextChunkIndex).toBe(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not silently succeed when the current generation cannot reopen MSE', async () => {
    const sourceBuffer = new EventTarget() as any;
    const mediaSource = { readyState: 'ended' } as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.throwError('reopen failed');
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource,
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await expectAsync(
      (service as any).clearAndResume(
        state,
        3,
        62.4,
        120,
        { currentTime: 62.4 } as HTMLVideoElement,
      ),
    ).toBeRejectedWithError('reopen failed');

    expect(state.nextChunkIndex).toBe(2);
    expect(sourceBuffer.abort).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps cleanup pending when the seek response is already stale', async () => {
    const seekResult = deferred<{ chunkIndex: number; resumeTime: number; exactOffset: number }>();
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    sourceBuffer.remove = jasmine.createSpy('remove');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.returnValue(seekResult.promise);
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    const pending = (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );
    seekResult.resolve({ chunkIndex: 6, resumeTime: 60, exactOffset: 6 * KASUMI_CHUNK_SIZE });
    state.seekGeneration = 4;
    await pending;

    expect(sourceBuffer.remove).not.toHaveBeenCalled();
    expect(state.nextChunkIndex).toBeUndefined();
    expect(service.isSeeking()).toBeTrue();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('stops forward cleanup before the next SourceBuffer when generation changes', async () => {
    const sourceBufferA = new EventTarget() as any;
    const sourceBufferB = new EventTarget() as any;
    for (const sourceBuffer of [sourceBufferA, sourceBufferB]) {
      sourceBuffer.updating = false;
      sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
    }
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBufferA], [2, sourceBufferB]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    sourceBufferA.remove = jasmine.createSpy('removeA').and.callFake(() => {
      state.seekGeneration = 4;
      queueMicrotask(() => sourceBufferA.dispatchEvent(new Event('updateend')));
    });
    sourceBufferB.remove = jasmine.createSpy('removeB');
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBufferA.remove).toHaveBeenCalledOnceWith(60, 121);
    expect(sourceBufferB.remove).not.toHaveBeenCalled();
    expect(service.isSeeking()).toBeTrue();
  });

  it('stops the parser reset when generation changes between SourceBuffers', async () => {
    const sourceBufferA = new EventTarget() as any;
    const sourceBufferB = new EventTarget() as any;
    for (const sourceBuffer of [sourceBufferA, sourceBufferB]) {
      sourceBuffer.updating = false;
      sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
      sourceBuffer.abort = jasmine.createSpy('abort');
    }
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBufferA], [2, sourceBufferB]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    sourceBufferA.abort.and.callFake(() => {
      state.seekGeneration = 4;
    });
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await (service as any).clearAndResume(
      state,
      3,
      62.4,
      120,
      { currentTime: 62.4 } as HTMLVideoElement,
    );

    expect(sourceBufferA.abort).toHaveBeenCalledTimes(1);
    expect(sourceBufferB.abort).not.toHaveBeenCalled();
    expect(state.nextChunkIndex).toBeUndefined();
    expect(service.isSeeking()).toBeTrue();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('surfaces a current-generation MediaSource close before parser reset', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.abort = jasmine.createSpy('abort');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.callFake(async () => {
      state.mediaSource.readyState = 'closed';
      return { chunkIndex: 6, resumeTime: 60, exactOffset: 6 * KASUMI_CHUNK_SIZE };
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.isSeeking.set(true);

    await expectAsync(
      (service as any).clearAndResume(
        state,
        3,
        62.4,
        120,
        { currentTime: 62.4 } as HTMLVideoElement,
      ),
    ).toBeRejectedWithError('MediaSource indisponivel apos a limpeza do seek.');

    expect(sourceBuffer.abort).not.toHaveBeenCalled();
    expect(state.nextChunkIndex).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('propagates a parser reset failure without promotion or scheduling', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.abort = jasmine.createSpy('abort').and.throwError('abort failed');
    const state: any = {
      aborted: false,
      videoDuration: 120,
      totalChunks: 10,
      nextChunkIndex: 2,
      seekGeneration: 3,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 60,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const schedule = spyOn<any>(service, 'scheduleNextChunk').and.stub();

    await expectAsync(
      (service as any).clearAndResume(
        state,
        3,
        62.4,
        120,
        { currentTime: 62.4 } as HTMLVideoElement,
      ),
    ).toBeRejectedWithError('abort failed');

    expect(state.nextChunkIndex).toBe(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('uses the safe forward boundary for equal, greater and zero resume times', async () => {
    const cases = [
      { requestedTime: 50, resumeTime: 50, expected: 50 },
      { requestedTime: 50, resumeTime: 51, expected: 50 },
      { requestedTime: 3, resumeTime: 0, expected: 0 },
    ];
    const sendSeek = spyOn<any>(service, 'sendSeekToTransmuxWorker');
    spyOn<any>(service, 'scheduleNextChunk').and.stub();

    for (const [index, testCase] of cases.entries()) {
      const sourceBuffer = new EventTarget() as any;
      sourceBuffer.updating = false;
      sourceBuffer.buffered = { length: 1, start: () => 55, end: () => 100 };
      sourceBuffer.abort = jasmine.createSpy(`abort-${index}`);
      sourceBuffer.remove = jasmine.createSpy(`remove-${index}`).and.callFake(() => {
        queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
      });
      const state: any = {
        aborted: false,
        videoDuration: 120,
        totalChunks: 10,
        seekGeneration: index + 1,
        sourceBuffers: new Map([[1, sourceBuffer]]),
        mediaSource: { readyState: 'open' },
        isRemoving: false,
      };
      sendSeek.and.resolveTo({
        chunkIndex: 6,
        resumeTime: testCase.resumeTime,
        exactOffset: 6 * KASUMI_CHUNK_SIZE,
      });
      service.isSeeking.set(true);

      await (service as any).clearAndResume(
        state,
        index + 1,
        testCase.requestedTime,
        120,
        { currentTime: testCase.requestedTime } as HTMLVideoElement,
      );

      expect(sourceBuffer.remove).toHaveBeenCalledOnceWith(testCase.expected, 121);
    }
  });

  it('handles seek decisions and timeupdate scheduling guards', async () => {
    const buffered = { length: 1, start: () => 0, end: () => 20 } as any;
    const bufferedAbort = jasmine.createSpy('bufferedAbort');
    const video = { currentTime: 10 } as any;
    const updateSpy = spyOn<any>(service, 'onTimeupdateTick').and.stub();
    const state: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 3,
      videoDuration: 30,
      sourceBuffers: new Map([[1, { buffered, abort: bufferedAbort }]]),
      currentFetches: new Set<AbortController>(),
      seekGeneration: 0,
      mediaSource: { readyState: 'open' },
      processLock: Promise.resolve(),
      isRemoving: false,
    };
    (service as any).onSeek(state, video);
    expect(service.isSeeking()).toBeFalse();
    expect(updateSpy).toHaveBeenCalled();
    expect(bufferedAbort).not.toHaveBeenCalled();
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

    const scheduleSpy = spyOn<any>(service, 'scheduleNextChunk').and.callFake(
      (s: any) => s.nextChunkIndex++,
    );
    const gcSpy = spyOn<any>(service, 'evictStaleRanges').and.returnValue(Promise.resolve());
    service.isSeeking.set(false);
    const tickState: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 2,
      sourceBuffers: new Map([
        [1, { buffered: { length: 0, start: () => 0, end: () => 0 }, abort: bufferedAbort }],
      ]),
      processLock: Promise.resolve(),
    };
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    await tickState.processLock;
    expect(scheduleSpy).toHaveBeenCalled();
    expect(gcSpy).toHaveBeenCalled();
    expect(bufferedAbort).not.toHaveBeenCalled();

    tickState.aborted = true;
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    tickState.aborted = false;
    service.isSeeking.set(true);
    (service as any).onTimeupdateTick(tickState, { currentTime: 12 } as any);
    service.isSeeking.set(false);
  });

  it('handles SourceBuffer removal and garbage collection guards', async () => {
    const state: any = {
      isRemoving: false,
      mediaSource: { readyState: 'open' },
      sourceBuffers: new Map(),
    };
    const sb = new EventTarget() as any;
    sb.updating = false;
    sb.buffered = { length: 1, start: () => 0, end: () => 20 };
    sb.abort = jasmine.createSpy('abort');
    sb.remove = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
    state.sourceBuffers.set(1, sb);
    await (service as any).evictStaleRanges(state, 15);
    expect(state.isRemoving).toBeFalse();
    expect(sb.abort).not.toHaveBeenCalled();

    await (service as any).evictStaleRanges({ ...state, isRemoving: true }, 15);
    await (service as any).evictStaleRanges(
      { ...state, mediaSource: { readyState: 'closed' } },
      15,
    );
    await (service as any).evictStaleRanges(
      { ...state, mediaSource: { readyState: 'open' }, sourceBuffers: new Map() },
      5,
    );

    const closed = { updating: false, remove: jasmine.createSpy('remove') } as any;
    await (service as any).removeRange(
      { mediaSource: { readyState: 'closed' }, isRemoving: false },
      closed,
      0,
      1,
    );
    expect(closed.remove).not.toHaveBeenCalled();

    const updating = { updating: true, remove: jasmine.createSpy('remove') } as any;
    await (service as any).removeRange(
      { mediaSource: { readyState: 'open' }, isRemoving: false },
      updating,
      0,
      1,
    );

    const errorSb = new EventTarget() as any;
    errorSb.updating = false;
    errorSb.remove = () => queueMicrotask(() => errorSb.dispatchEvent(new Event('error')));
    await expectAsync((service as any).removeRange(state, errorSb, 0, 1)).toBeRejectedWithError(
      'SourceBuffer error during remove.',
    );

    const throwing = {
      updating: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      remove: () => {
        throw new Error('closed');
      },
    } as any;
    await (service as any).removeRange(state, throwing, 0, 1);
    expect(state.isRemoving).toBeFalse();
  });

  it('does not start queued GC after a seek changes its generation', async () => {
    const gate = deferred<void>();
    const remove = jasmine.createSpy('remove').and.callFake(() => {
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 0, end: () => 20 };
    sourceBuffer.remove = remove;
    const state: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 1,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      processLock: gate.promise,
      seekGeneration: 1,
      isRemoving: false,
      mediaSource: { readyState: 'open' },
    };
    spyOn<any>(service, 'scheduleNextChunk').and.callFake((s: any) => {
      s.nextChunkIndex = s.totalChunks;
    });
    service.isSeeking.set(false);

    (service as any).onTimeupdateTick(state, { currentTime: 15 } as any);
    state.seekGeneration = 2;
    gate.resolve(undefined);
    await state.processLock;

    expect(remove).not.toHaveBeenCalled();
  });

  it('runs queued GC for the current generation', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 0, end: () => 20 };
    const remove = (sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    }));
    const state: any = {
      aborted: false,
      activeDownloads: 0,
      nextChunkIndex: 0,
      totalChunks: 1,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      processLock: Promise.resolve(),
      seekGeneration: 1,
      isRemoving: false,
      mediaSource: { readyState: 'open' },
    };
    spyOn<any>(service, 'scheduleNextChunk').and.callFake((s: any) => {
      s.nextChunkIndex = s.totalChunks;
    });
    service.isSeeking.set(false);

    (service as any).onTimeupdateTick(state, { currentTime: 15 } as any);
    await state.processLock;

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not start the next GC removal after generation changes between buffers', async () => {
    const first = new EventTarget() as any;
    first.updating = false;
    first.buffered = { length: 1, start: () => 0, end: () => 20 };
    first.remove = jasmine.createSpy('remove');
    const second = new EventTarget() as any;
    second.updating = false;
    second.buffered = { length: 1, start: () => 0, end: () => 20 };
    second.remove = jasmine.createSpy('remove');
    const state: any = {
      aborted: false,
      isRemoving: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
      sourceBuffers: new Map([
        [1, first],
        [2, second],
      ]),
    };

    const pending = (service as any).evictStaleRanges(state, 15, 1);
    await Promise.resolve();
    expect(first.remove).toHaveBeenCalledTimes(1);

    state.seekGeneration = 2;
    first.dispatchEvent(new Event('updateend'));
    await pending;

    expect(second.remove).not.toHaveBeenCalled();
  });

  it('does not start stale quota removal while waiting for SourceBuffer idle', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 0, end: () => 10 };
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      sourceBuffer.updating = false;
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    const append = (sourceBuffer.appendBuffer = jasmine
      .createSpy('appendBuffer')
      .and.callFake(() => {
        sourceBuffer.updating = true;
        throw { name: 'QuotaExceededError' };
      }));
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
    };

    const pending = (service as any).appendToSourceBuffer(
      state,
      1,
      sourceBuffer,
      new ArrayBuffer(1),
      { currentTime: 5 } as HTMLVideoElement,
    );
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(1);

    state.seekGeneration = 2;
    sourceBuffer.updating = false;
    sourceBuffer.dispatchEvent(new Event('updateend'));
    await pending;

    expect(sourceBuffer.remove).not.toHaveBeenCalled();
  });

  it('keeps current quota removal and append retry working', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start: () => 0, end: () => 10 };
    sourceBuffer.abort = jasmine.createSpy('abort');
    sourceBuffer.remove = jasmine.createSpy('remove').and.callFake(() => {
      sourceBuffer.updating = false;
      queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    });
    const append = (sourceBuffer.appendBuffer = jasmine
      .createSpy('appendBuffer')
      .and.callFake(() => {
        if (append.calls.count() === 1) {
          sourceBuffer.updating = true;
          throw { name: 'QuotaExceededError' };
        }
        sourceBuffer.updating = true;
        queueMicrotask(() => {
          sourceBuffer.updating = false;
          sourceBuffer.dispatchEvent(new Event('updateend'));
        });
      }));
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
    };
    const pending = (service as any).appendToSourceBuffer(
      state,
      1,
      sourceBuffer,
      new ArrayBuffer(1),
      { currentTime: 5 } as HTMLVideoElement,
    );
    for (let i = 0; i < 3; i++) await Promise.resolve();
    sourceBuffer.updating = false;
    sourceBuffer.dispatchEvent(new Event('updateend'));
    await pending;

    expect(sourceBuffer.remove).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(2);
    expect(sourceBuffer.abort).not.toHaveBeenCalled();
  });

  it('handles worker success, ignored messages and worker errors', async () => {
    const makeWorker = (data: any) => {
      const worker = new EventTarget() as any;
      worker.postMessage = () =>
        queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data })));
      return worker;
    };
    const cryptoWorker = makeWorker({
      chunkIndex: 0,
      type: 'CHUNK_DECRYPTED',
      decryptedChunk: new ArrayBuffer(2),
    });
    const state: any = { cryptoWorker, fdk: new Uint8Array(32), baseNonce: new Uint8Array(24) };
    await expectAsync(
      (service as any).sendToCryptoWorker(state, new ArrayBuffer(1), 0),
    ).toBeResolved();

    state.cryptoWorker = makeWorker({ chunkIndex: 0, type: 'ERROR', message: 'decrypt failed' });
    await expectAsync(
      (service as any).sendToCryptoWorker(state, new ArrayBuffer(1), 0),
    ).toBeRejectedWithError('decrypt failed');

    const transmuxWorker = makeWorker({ chunkIndex: 1, type: 'CHUNK_TRANSMUXED', segments: [] });
    state.transmuxWorker = transmuxWorker;
    await expectAsync(
      (service as any).sendToTransmuxWorker(state, new ArrayBuffer(1), 1, true),
    ).toBeResolved();

    state.transmuxWorker = makeWorker({ chunkIndex: 1, type: 'ERROR', message: 'transmux failed' });
    await expectAsync(
      (service as any).sendToTransmuxWorker(state, new ArrayBuffer(1), 1, false),
    ).toBeRejectedWithError('transmux failed');

    state.transmuxWorker = makeWorker({
      type: 'SEEK_COMPLETE',
      generation: 2,
      chunkIndex: 4,
      resumeTime: 9,
      exactOffset: 4 * KASUMI_CHUNK_SIZE + 8,
    });
    await expectAsync((service as any).sendSeekToTransmuxWorker(state, 10, 2)).toBeResolvedTo({
      chunkIndex: 4,
      resumeTime: 9,
      exactOffset: 4 * KASUMI_CHUNK_SIZE + 8,
    });
  });

  it('transfers per-chunk key copies while preserving runtime-owned state', async () => {
    const worker = new EventTarget() as any;
    let posted: { message: any; transferables: Transferable[] } | undefined;
    worker.postMessage = jasmine.createSpy('postMessage').and.callFake(
      (message: any, transferables: Transferable[]) => {
        posted = { message, transferables };
        queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'CHUNK_DECRYPTED',
            chunkIndex: 4,
            decryptedChunk: new ArrayBuffer(2),
          },
        })));
      },
    );
    const state: any = {
      cryptoWorker: worker,
      fdk: new Uint8Array(32).fill(0x5a),
      baseNonce: new Uint8Array(24).fill(0x6b),
    };
    const originalFdk = Array.from(state.fdk) as number[];
    const originalBaseNonce = Array.from(state.baseNonce) as number[];
    const encryptedChunk = new ArrayBuffer(3);

    await expectAsync((service as any).sendToCryptoWorker(state, encryptedChunk, 4)).toBeResolved();

    expect(posted).toBeDefined();
    expect(posted!.message.fdk).toEqual(jasmine.any(ArrayBuffer));
    expect(posted!.message.baseNonce).toEqual(jasmine.any(ArrayBuffer));
    expect(posted!.message.fdk).not.toBe(state.fdk.buffer);
    expect(posted!.message.baseNonce).not.toBe(state.baseNonce.buffer);
    expect(Array.from(new Uint8Array(posted!.message.fdk))).toEqual(originalFdk);
    expect(Array.from(new Uint8Array(posted!.message.baseNonce))).toEqual(originalBaseNonce);
    expect(posted!.transferables).toEqual([
      encryptedChunk,
      posted!.message.fdk,
      posted!.message.baseNonce,
    ]);
    expect(Array.from(state.fdk)).toEqual(originalFdk);
    expect(Array.from(state.baseNonce)).toEqual(originalBaseNonce);
  });

  it('wipes sender-owned key copies when worker handoff fails', async () => {
    const worker = new EventTarget() as any;
    let posted: { message: any; transferables: Transferable[] } | undefined;
    worker.postMessage = jasmine.createSpy('postMessage').and.callFake(
      (message: any, transferables: Transferable[]) => {
        posted = { message, transferables };
        throw new Error('A16_POSTMESSAGE_FAILURE');
      },
    );
    const state: any = {
      cryptoWorker: worker,
      fdk: new Uint8Array(32).fill(0x5a),
      baseNonce: new Uint8Array(24).fill(0x6b),
    };
    const originalFdk = Array.from(state.fdk) as number[];
    const originalBaseNonce = Array.from(state.baseNonce) as number[];

    await expectAsync(
      (service as any).sendToCryptoWorker(state, new ArrayBuffer(3), 4),
    ).toBeRejectedWithError('A16_POSTMESSAGE_FAILURE');

    expect(posted).toBeDefined();
    expect(Array.from(new Uint8Array(posted!.message.fdk))).toEqual(new Array(32).fill(0));
    expect(Array.from(new Uint8Array(posted!.message.baseNonce))).toEqual(new Array(24).fill(0));
    expect(Array.from(state.fdk)).toEqual(originalFdk);
    expect(Array.from(state.baseNonce)).toEqual(originalBaseNonce);
  });

  it('creates a fresh key copy for each sequential chunk', async () => {
    const worker = new EventTarget() as any;
    const posts: { message: any; transferables: Transferable[] }[] = [];
    worker.postMessage = jasmine.createSpy('postMessage').and.callFake(
      (message: any, transferables: Transferable[]) => {
        posts.push({ message, transferables });
        queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'CHUNK_DECRYPTED',
            chunkIndex: posts.length - 1,
            decryptedChunk: new ArrayBuffer(2),
          },
        })));
      },
    );
    const state: any = {
      cryptoWorker: worker,
      fdk: new Uint8Array(32).fill(0x5a),
      baseNonce: new Uint8Array(24).fill(0x6b),
    };

    await expectAsync((service as any).sendToCryptoWorker(state, new ArrayBuffer(3), 0)).toBeResolved();
    await expectAsync((service as any).sendToCryptoWorker(state, new ArrayBuffer(3), 1)).toBeResolved();

    expect(posts).toHaveSize(2);
    expect(posts[0].message.fdk).not.toBe(posts[1].message.fdk);
    expect(posts[0].message.baseNonce).not.toBe(posts[1].message.baseNonce);
    expect(Array.from(new Uint8Array(posts[0].message.fdk))).toEqual(new Array(32).fill(0x5a));
    expect(Array.from(new Uint8Array(posts[1].message.fdk))).toEqual(new Array(32).fill(0x5a));
    expect(Array.from(state.fdk)).toEqual(new Array(32).fill(0x5a));
    expect(Array.from(state.baseNonce)).toEqual(new Array(24).fill(0x6b));
  });

  it('correlates seek errors, ignores other generations and cleans listeners', async () => {
    const worker = new EventTarget() as any;
    worker.postMessage = jasmine.createSpy('postMessage');
    const removeSpy = spyOn(worker, 'removeEventListener').and.callThrough();
    const state: any = { transmuxWorker: worker };

    const failed = (service as any).sendSeekToTransmuxWorker(state, 10, 5);
    worker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ERROR', generation: 4, message: 'stale failure' },
    }));
    worker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'OTHER', generation: 5 },
    }));
    await Promise.resolve();
    expect(removeSpy).not.toHaveBeenCalled();

    worker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ERROR', generation: 5, message: 'current failure' },
    }));
    await expectAsync(failed).toBeRejectedWithError('current failure');
    expect(removeSpy).toHaveBeenCalledTimes(3);

    removeSpy.calls.reset();
    const completed = (service as any).sendSeekToTransmuxWorker(state, 20, 6);
    worker.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'SEEK_COMPLETE',
        generation: 6,
        chunkIndex: 9,
        resumeTime: 18,
        exactOffset: 9 * KASUMI_CHUNK_SIZE + 5,
      },
    }));
    await expectAsync(completed).toBeResolvedTo({
      chunkIndex: 9,
      resumeTime: 18,
      exactOffset: 9 * KASUMI_CHUNK_SIZE + 5,
    });
    expect(removeSpy).toHaveBeenCalledTimes(3);
  });

  it('surfaces only current seek failures and never schedules after an error', async () => {
    const rejection = deferred<void>();
    const clearSpy = spyOn<any>(service, 'clearAndResume').and.returnValue(rejection.promise);
    const scheduleSpy = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    const state: any = {
      aborted: false,
      videoDuration: 30,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, { buffered: { length: 1, start: () => 0, end: () => 2 } }]]),
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      processLock: Promise.resolve(),
    };
    const video = { currentTime: 25 } as any;
    service.error.set(null);
    service.isSeeking.set(false);

    (service as any).onSeek(state, video);
    expect(clearSpy).toHaveBeenCalledWith(state, 1, 25, 30, video);
    rejection.reject(new Error('seek failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(service.error()).toBe('seek failed');
    expect(service.isSeeking()).toBeFalse();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('does not use the buffered fast path after a decoder MediaError', () => {
    const sourceBuffer = {
      buffered: { length: 1, start: () => 0, end: () => 30 },
    } as any;
    const state: any = {
      aborted: false,
      videoDuration: 30,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      processLock: Promise.resolve(),
    };
    const video = {
      currentTime: 10,
      error: { code: 3, message: 'PipelineStatus::PIPELINE_ERROR_DECODE' },
    } as any;
    const clear = spyOn<any>(service, 'clearAndResume').and.returnValue(Promise.resolve());
    const tick = spyOn<any>(service, 'onTimeupdateTick').and.stub();

    (service as any).onSeek(state, video);

    expect(clear).toHaveBeenCalledOnceWith(state, 1, 10, 30, video);
    expect(tick).not.toHaveBeenCalled();
    expect(service.isSeeking()).toBeTrue();
  });

  it('keeps the buffered fast path when the media element has no error', () => {
    const sourceBuffer = {
      buffered: { length: 1, start: () => 0, end: () => 30 },
    } as any;
    const state: any = {
      aborted: false,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, sourceBuffer]]),
    };
    const video = { currentTime: 10, error: null } as any;
    const clear = spyOn<any>(service, 'clearAndResume').and.stub();
    const tick = spyOn<any>(service, 'onTimeupdateTick').and.stub();

    (service as any).onSeek(state, video);

    expect(clear).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnceWith(state, video);
    expect(service.isSeeking()).toBeFalse();
  });

  it('surfaces a current-generation SourceBuffer.abort failure through the seek error signal', async () => {
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.abort = jasmine.createSpy('abort').and.throwError('abort failed');
    const state: any = {
      aborted: false,
      videoDuration: 30,
      totalChunks: 10,
      nextChunkIndex: 0,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, sourceBuffer]]),
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      processLock: Promise.resolve(),
      mediaSource: { readyState: 'open' },
      isRemoving: false,
    };
    spyOn<any>(service, 'sendSeekToTransmuxWorker').and.resolveTo({
      chunkIndex: 6,
      resumeTime: 24,
      exactOffset: 6 * KASUMI_CHUNK_SIZE,
    });
    const scheduleSpy = spyOn<any>(service, 'scheduleNextChunk').and.stub();
    service.error.set(null);
    service.isSeeking.set(false);

    (service as any).onSeek(state, { currentTime: 25 } as any);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(service.error()).toBe('abort failed');
    expect(service.isSeeking()).toBeFalse();
    expect(state.nextChunkIndex).toBe(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('ignores a stale seek failure without changing current UI state', async () => {
    const rejection = deferred<void>();
    spyOn<any>(service, 'clearAndResume').and.returnValue(rejection.promise);
    const state: any = {
      aborted: false,
      videoDuration: 30,
      seekGeneration: 0,
      sourceBuffers: new Map([[1, { buffered: { length: 1, start: () => 0, end: () => 2 } }]]),
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      processLock: Promise.resolve(),
    };
    service.error.set(null);
    service.isSeeking.set(false);

    (service as any).onSeek(state, { currentTime: 25 } as any);
    state.seekGeneration = 2;
    rejection.reject(new Error('stale seek failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(service.error()).toBeNull();
    expect(service.isSeeking()).toBeTrue();
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
      sourceBuffers: new Map(),
    };
    (service as any).attachVideoListeners(state, video);
    video.dispatchEvent(new Event('waiting'));
    expect(service.isBuffering()).toBeTrue();
    video.dispatchEvent(new Event('playing'));
    expect(service.isBuffering()).toBeFalse();
    video.dispatchEvent(new Event('canplay'));
    service.isSeeking.set(true);
    video.dispatchEvent(new Event('seeked'));
    expect(service.isSeeking()).toBeTrue();
    state.removeVideoListeners();
  });

  it('logs the first media error with safe diagnostics and removes the listener', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 3, message: 'decoder diagnostic' },
    });
    const state: any = {
      aborted: false,
      activeDownloads: 3,
      nextChunkIndex: 0,
      totalChunks: 10,
      seekGeneration: 4,
      mediaSource: { readyState: 'open' },
      seekDebounceTimeout: null,
      removeVideoListeners: null,
      sourceBuffers: new Map(),
    };
    const error = spyOn(console, 'error');
    (service as any).attachVideoListeners(state, video);

    video.dispatchEvent(new Event('error'));
    expect(error).toHaveBeenCalledWith(
      '[VideoStream] HTMLMediaElement error',
      jasmine.objectContaining({
        code: 3,
        message: 'decoder diagnostic',
        readyState: video.readyState,
        networkState: video.networkState,
        seekGeneration: 4,
        isSeeking: service.isSeeking(),
        mediaSourceReadyState: 'open',
      }),
    );

    const calls = error.calls.count();
    state.removeVideoListeners();
    video.dispatchEvent(new Event('error'));
    expect(error.calls.count()).toBe(calls);
  });

  it('clears a closed source buffer safely and ends an open media source', async () => {
    const closed = { readyState: 'closed' } as any;
    await expectAsync(
      (service as any).appendToSourceBuffer(
        { mediaSource: closed, aborted: false, seekGeneration: 1 },
        1,
        {},
        new ArrayBuffer(1),
        {} as HTMLVideoElement,
      ),
    ).toBeRejectedWithError('SourceBuffer indisponivel (closed).');
    const mediaSource = {
      readyState: 'open',
      endOfStream: jasmine.createSpy('endOfStream'),
    } as any;
    const state = { mediaSource, aborted: false } as any;
    (service as any).signalEndOfStream(state);
    expect(mediaSource.endOfStream).toHaveBeenCalled();
    expect(service.isStreaming()).toBeFalse();
  });

  it('reacquires Google metadata once after a range 401 and retries the exact range with the new token', async () => {
    jasmine.clock().install();
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/old?alt=media',
      gdriveToken: 'token-old',
    };
    driveSpy.downloadExternalFileRange.and.returnValues(
      throwError(() => ({ status: 401 })),
      of(new Blob(['range'])),
    );
    driveSpy.downloadExternalMetadata.and.returnValue(of({
      storage_provider: 'google_drive',
      external_file_id: 'new-file',
      access_token: 'token-new',
    }));

    try {
      const request = (service as any).fetchRange(70, 123, 456, new AbortController(), credentials);
      await Promise.resolve();
      jasmine.clock().tick(7_000);
      const result = await request;

      expect(result.size).toBe(5);
      expect(driveSpy.downloadExternalMetadata).toHaveBeenCalledOnceWith(70);
      expect(driveSpy.downloadExternalFileRange.calls.allArgs()).toEqual([
        ['https://www.googleapis.com/drive/v3/files/old?alt=media', 'token-old', 123, 456],
        ['https://www.googleapis.com/drive/v3/files/new-file?alt=media', 'token-new', 123, 456],
      ]);
      expect(credentials).toEqual({
        gdriveUrl: 'https://www.googleapis.com/drive/v3/files/new-file?alt=media',
        gdriveToken: 'token-new',
      });
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('does not retry a Google 401 more than once after recovery', async () => {
    jasmine.clock().install();
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/old?alt=media',
      gdriveToken: 'token-old',
    };
    driveSpy.downloadExternalFileRange.and.returnValues(
      throwError(() => ({ status: 401 })),
      throwError(() => ({ status: 401 })),
    );
    driveSpy.downloadExternalMetadata.and.returnValue(of({
      storage_provider: 'google_drive',
      external_file_id: 'new-file',
      access_token: 'token-new',
    }));

    try {
      const request = (service as any).fetchRange(71, 10, 20, new AbortController(), credentials);
      await Promise.resolve();
      jasmine.clock().tick(7_000);
      await expectAsync(request).toBeRejectedWith(jasmine.objectContaining({ status: 401 }));

      expect(driveSpy.downloadExternalMetadata).toHaveBeenCalledOnceWith(71);
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('fails a Google 403 immediately without metadata recovery or generic retries', async () => {
    jasmine.clock().install();
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/file?alt=media',
      gdriveToken: 'token',
    };
    driveSpy.downloadExternalFileRange.and.returnValue(throwError(() => ({ status: 403 })));

    try {
      const request = (service as any).fetchRange(72, 30, 40, new AbortController(), credentials);
      await Promise.resolve();
      jasmine.clock().tick(7_000);
      await expectAsync(request).toBeRejectedWith(jasmine.objectContaining({ status: 403 }));

      expect(driveSpy.downloadExternalMetadata).not.toHaveBeenCalled();
      expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledOnceWith(credentials.gdriveUrl, 'token', 30, 40);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('preserves generic retries for transient Google range failures', async () => {
    const previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 10_000;
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/file?alt=media',
      gdriveToken: 'token',
    };
    const blob = new Blob(['range']);
    let attempts = 0;
    driveSpy.downloadExternalFileRange.and.returnValue(new Observable<Blob>((subscriber) => {
      attempts++;
      if (attempts === 1) subscriber.error({ status: 500 });
      else if (attempts === 2) subscriber.error({ status: 503 });
      else {
        subscriber.next(blob);
        subscriber.complete();
      }
    }));

    try {
      const request = (service as any).fetchRange(75, 70, 80, new AbortController(), credentials);
      await expectAsync(request).toBeResolvedTo(blob);
      expect(driveSpy.downloadExternalMetadata).not.toHaveBeenCalled();
      expect(attempts).toBe(3);
    } finally {
      jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    }
  });

  it('does not publish credentials or retry when aborted during Google recovery', async () => {
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/old?alt=media',
      gdriveToken: 'token-old',
    };
    const metadata = new Subject<any>();
    driveSpy.downloadExternalFileRange.and.returnValue(throwError(() => ({ status: 401 })));
    driveSpy.downloadExternalMetadata.and.returnValue(metadata.asObservable());
    const controller = new AbortController();
    const request = (service as any).fetchRange(73, 50, 60, controller, credentials);

    await Promise.resolve();
    expect(driveSpy.downloadExternalMetadata).toHaveBeenCalledOnceWith(73);
    controller.abort();
    metadata.next({ storage_provider: 'google_drive', external_file_id: 'late', access_token: 'late-token' });

    await expectAsync(request).toBeRejectedWithError('Fetch aborted.');
    expect(driveSpy.downloadExternalFileRange).toHaveBeenCalledOnceWith(credentials.gdriveUrl, 'token-old', 50, 60);
    expect(credentials).toEqual({
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/old?alt=media',
      gdriveToken: 'token-old',
    });
  });

  it('does not overwrite newer credentials when an older recovery completes late', async () => {
    const credentials = {
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/old?alt=media',
      gdriveToken: 'token-old',
    };
    const metadata = new Subject<any>();
    driveSpy.downloadExternalFileRange.and.returnValue(throwError(() => ({ status: 401 })));
    driveSpy.downloadExternalMetadata.and.returnValue(metadata.asObservable());

    const recovery = (service as any).refreshGoogleCredentials(
      74,
      credentials,
      credentials.gdriveUrl,
      credentials.gdriveToken,
      new AbortController().signal,
      () => true,
      DRIVE_CONTROL_REQUEST_DEADLINE_MS,
    );
    await Promise.resolve();
    credentials.gdriveUrl = 'https://www.googleapis.com/drive/v3/files/newer?alt=media';
    credentials.gdriveToken = 'token-newer';
    metadata.next({ storage_provider: 'google_drive', external_file_id: 'mid', access_token: 'token-mid' });
    await recovery;

    expect(credentials).toEqual({
      gdriveUrl: 'https://www.googleapis.com/drive/v3/files/newer?alt=media',
      gdriveToken: 'token-newer',
    });
  });

  it('settles worker requests on fatal events, lifecycle abort, timeout and postMessage throw', async () => {
    const makeState = (worker: EventTarget) => ({
      cryptoWorker: worker,
      fdk: new Uint8Array(32),
      baseNonce: new Uint8Array(24),
      lifecycleController: new AbortController(),
    });

    const fatalWorker = new EventTarget() as any;
    fatalWorker.postMessage = jasmine.createSpy('postMessage');
    const fatalRequest = (service as any).sendToCryptoWorker(
      makeState(fatalWorker),
      new ArrayBuffer(1),
      0,
    );
    fatalWorker.dispatchEvent(new Event('error'));
    await expectAsync(fatalRequest).toBeRejectedWithError(
      'Falha no processamento criptográfico do vídeo.',
    );

    const abortWorker = new EventTarget() as any;
    abortWorker.postMessage = jasmine.createSpy('postMessage');
    const abortState = makeState(abortWorker);
    const abortRequest = (service as any).sendToCryptoWorker(
      abortState,
      new ArrayBuffer(1),
      0,
    );
    abortState.lifecycleController.abort();
    await expectAsync(abortRequest).toBeRejectedWithError('Fetch aborted.');

    const throwingWorker = new EventTarget() as any;
    throwingWorker.postMessage = jasmine.createSpy('postMessage').and.throwError('post failed');
    const throwingRequest = (service as any).sendToCryptoWorker(
      makeState(throwingWorker),
      new ArrayBuffer(1),
      0,
    );
    await expectAsync(throwingRequest).toBeRejectedWithError('post failed');

    jasmine.clock().install();
    try {
      const silentWorker = new EventTarget() as any;
      silentWorker.postMessage = jasmine.createSpy('postMessage');
      const timeoutRequest = (service as any).sendToCryptoWorker(
        makeState(silentWorker),
        new ArrayBuffer(1),
        0,
      );
      jasmine.clock().tick(30_000);
      await expectAsync(timeoutRequest).toBeRejectedWithError(
        'Tempo limite excedido aguardando resposta do worker.',
      );
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('settles bootstrap, seek and transmux requests on worker messageerror', async () => {
    const worker = new EventTarget() as any;
    worker.postMessage = jasmine.createSpy('postMessage');
    const state: any = {
      transmuxWorker: worker,
      lifecycleController: new AbortController(),
    };

    const bootstrap = (service as any).sendBootstrapToTransmuxWorker(
      state,
      new ArrayBuffer(1),
      null,
    );
    worker.dispatchEvent(new Event('messageerror'));
    await expectAsync(bootstrap).toBeRejectedWithError('Falha no processamento do vídeo.');

    const seek = (service as any).sendSeekToTransmuxWorker(state, 10, 1);
    worker.dispatchEvent(new Event('messageerror'));
    await expectAsync(seek).toBeRejectedWithError('Falha no processamento do vídeo.');

    const transmux = (service as any).sendToTransmuxWorker(state, new ArrayBuffer(1), 0, false);
    worker.dispatchEvent(new Event('messageerror'));
    await expectAsync(transmux).toBeRejectedWithError('Falha no processamento do vídeo.');
  });

  it('settles SourceBuffer waits on error, abort, lifecycle abort and timeout', async () => {
    const errorBuffer = new EventTarget() as any;
    errorBuffer.updating = true;
    const errorWait = (service as any).waitForSourceBufferIdle(errorBuffer);
    errorBuffer.dispatchEvent(new Event('error'));
    await expectAsync(errorWait).toBeRejectedWithError('Erro no SourceBuffer.');

    const nativeAbortBuffer = new EventTarget() as any;
    nativeAbortBuffer.updating = true;
    const nativeAbortWait = (service as any).waitForSourceBufferIdle(nativeAbortBuffer);
    nativeAbortBuffer.dispatchEvent(new Event('abort'));
    await expectAsync(nativeAbortWait).toBeRejectedWithError(
      'Operação do SourceBuffer abortada.',
    );

    const controller = new AbortController();
    const lifecycleBuffer = new EventTarget() as any;
    lifecycleBuffer.updating = true;
    const lifecycleWait = (service as any).waitForSourceBufferIdle(
      lifecycleBuffer,
      controller.signal,
    );
    controller.abort();
    await expectAsync(lifecycleWait).toBeRejectedWithError('Fetch aborted.');

    jasmine.clock().install();
    try {
      const silentBuffer = new EventTarget() as any;
      silentBuffer.updating = true;
      const timeoutWait = (service as any).waitForSourceBufferIdle(silentBuffer);
      jasmine.clock().tick(10_000);
      await expectAsync(timeoutWait).toBeRejectedWithError(
        'Tempo limite excedido na operação do SourceBuffer.',
      );
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('settles append and remove operations on async SourceBuffer failure and timeout', async () => {
    const appendError = new EventTarget() as any;
    appendError.appendBuffer = () => queueMicrotask(() => appendError.dispatchEvent(new Event('error')));
    const appendFailure = (service as any).appendToSourceBufferRaw(
      appendError,
      new ArrayBuffer(1),
    );
    await expectAsync(appendFailure).toBeRejectedWithError('Erro no appendBuffer.');

    jasmine.clock().install();
    try {
      const removeBuffer = new EventTarget() as any;
      removeBuffer.remove = jasmine.createSpy('remove');
      const removeTimeout = (service as any).removeRangeRaw(removeBuffer, 0, 1);
      jasmine.clock().tick(10_000);
      await expectAsync(removeTimeout).toBeRejectedWithError(
        'Tempo limite excedido na operação do SourceBuffer.',
      );
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('uses one absolute quota recovery deadline and aborts its delay with the stream', async () => {
    let now = 0;
    spyOn(Date, 'now').and.callFake(() => now);
    const delaySpy = spyOn<any>(service, 'delay').and.callFake(async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('aborted');
      now += ms;
    });
    const sourceBuffer = new EventTarget() as any;
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    sourceBuffer.appendBuffer = jasmine.createSpy('appendBuffer').and.callFake(() => {
      throw { name: 'QuotaExceededError' };
    });
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
      lifecycleController: new AbortController(),
    };
    const pending = (service as any).appendToSourceBuffer(
      state,
      1,
      sourceBuffer,
      new ArrayBuffer(1),
      { currentTime: 0 } as HTMLVideoElement,
    );
    await expectAsync(pending).toBeRejectedWithError(
      'Não foi possível liberar espaço no buffer de vídeo.',
    );
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);

    delaySpy.and.callFake((_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) {
        reject((service as any).createAbortError());
        return;
      }
      signal?.addEventListener('abort', () => reject((service as any).createAbortError()), { once: true });
    }));
    const abortBuffer = new EventTarget() as any;
    abortBuffer.updating = false;
    abortBuffer.buffered = { length: 0, start: () => 0, end: () => 0 };
    abortBuffer.appendBuffer = jasmine.createSpy('appendBuffer').and.callFake(() => {
      throw { name: 'QuotaExceededError' };
    });
    const lifecycleController = new AbortController();
    const abortState: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
      lifecycleController,
    };
    const abortPending = (service as any).appendToSourceBuffer(
      abortState,
      1,
      abortBuffer,
      new ArrayBuffer(1),
      { currentTime: 0 } as HTMLVideoElement,
    );
    for (let i = 0; i < 4; i++) await Promise.resolve();
    lifecycleController.abort();
    abortState.aborted = true;
    await expectAsync(abortPending).toBeRejectedWithError('Fetch aborted.');
    expect(abortBuffer.appendBuffer).toHaveBeenCalledTimes(1);
  });

  it('limits automatic append restart to one shared recovery context', async () => {
    const recoveryContext = { appendRestartsRemaining: 1 };
    const state: any = {
      aborted: false,
      seekGeneration: 0,
      nextChunkIndex: 0,
      totalChunks: 1,
      plaintextSize: 1,
      dataOffset: 0,
      file: createFile(),
      shareUuid: null,
      gdriveUrl: null,
      gdriveToken: null,
      currentFetches: new Set<AbortController>(),
      activeDownloads: 0,
      processLock: Promise.resolve(),
      recoveryContext,
    };
    const video = { currentTime: 4 } as HTMLVideoElement;
    spyOn<any>(service, 'fetchRange').and.returnValue(Promise.resolve(new Blob(['x'])));
    spyOn<any>(service, 'runChunkPipeline').and.returnValue(
      Promise.reject(new Error('Erro no appendBuffer.')),
    );
    const restart = spyOn<any>(service, 'initializeStreamAttempt').and.returnValue(Promise.resolve());
    const failure = spyOn<any>(service, 'failStream').and.stub();

    (service as any).scheduleNextChunk(state, video);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(restart).toHaveBeenCalledOnceWith(video, state.file, 5, recoveryContext);
    expect(recoveryContext.appendRestartsRemaining).toBe(0);

    state.nextChunkIndex = 0;
    state.activeDownloads = 0;
    state.processLock = Promise.resolve();
    (service as any).scheduleNextChunk(state, video);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(failure).toHaveBeenCalledOnceWith(state, 'Erro no appendBuffer.');
  });

  it('creates a fresh automatic recovery budget for each public initialization', async () => {
    const attempt = spyOn<any>(service, 'initializeStreamAttempt').and.returnValue(Promise.resolve());
    const video = createVideo();
    const file = createFile();

    await service.initializeStream(video, file);
    await service.initializeStream(video, file);

    expect(attempt.calls.argsFor(0)[3]).toEqual({ appendRestartsRemaining: 1 });
    expect(attempt.calls.argsFor(1)[3]).toEqual({ appendRestartsRemaining: 1 });
  });

  it('fails the current native media error, preserves owned seek recovery and ignores stale errors', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 3, message: 'decoder failure' },
    });
    const state: any = {
      aborted: false,
      seekGeneration: 1,
      mediaSource: { readyState: 'open' },
      seekDebounceTimeout: null,
      removeVideoListeners: null,
      sourceBuffers: new Map(),
    };
    const fail = spyOn<any>(service, 'failStream').and.stub();
    (service as any).state = state;
    (service as any).attachVideoListeners(state, video);
    video.dispatchEvent(new Event('error'));
    expect(fail).toHaveBeenCalledOnceWith(state, 'Falha ao reproduzir o vídeo.');

    fail.calls.reset();
    service.isSeeking.set(true);
    video.dispatchEvent(new Event('error'));
    expect(fail).not.toHaveBeenCalled();
    service.isSeeking.set(false);

    fail.calls.reset();
    (service as any).state = { ...state };
    video.dispatchEvent(new Event('error'));
    expect(fail).not.toHaveBeenCalled();
    state.removeVideoListeners?.();
  });
});
