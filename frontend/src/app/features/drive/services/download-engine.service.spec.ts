import { Observable, of, Subject } from 'rxjs';
import { DownloadEngineService } from './download-engine.service';
import type { DownloadCallbacks, DownloadState, GoogleDownloadState, LocalDownloadState } from './download-engine.service';
import type { DriveFile, TransferItem } from '../state/drive.store';
import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';

describe('DownloadEngineService', () => {
  const file = { id: 7, isFolder: false, decryptedName: 'arquivo.bin', encryptedName: 'cipher', sizeBytes: 3 } as DriveFile;
  let drive: jasmine.SpyObj<any>;
  let kasumi: jasmine.SpyObj<any>;
  let service: DownloadEngineService;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['downloadFileRange', 'downloadExternalFile']);
    kasumi = jasmine.createSpyObj('KasumiCryptoService', ['decryptFile', 'decryptFileChunk']);
    service = new DownloadEngineService(drive, kasumi);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:test');
    spyOn(URL, 'revokeObjectURL');
  });

  const encryptedChunk = (size: number): Blob => ({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(size)),
  } as Blob);

  const googleState = (fdk = new Uint8Array([4]), externalFileId = 'external'): GoogleDownloadState => ({
    kind: 'google', file, fdk, meta: { external_file_id: externalFileId, access_token: 'test-token' },
  });

  const localState = (fdk = new Uint8Array([5])): LocalDownloadState => ({
    kind: 'local', file, fdk, baseNonce: new Uint8Array(24).fill(6), expectedSize: 3,
    decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
  });

  const callbacks = (overrides: Partial<DownloadCallbacks> = {}): DownloadCallbacks => ({
    setProgress: jasmine.createSpy('setProgress'),
    updateTransfer: jasmine.createSpy('updateTransfer'),
    isPaused: () => false,
    ...overrides,
  });

  const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
  };

  it('B.94 limits each local range without imposing a whole-download deadline', async () => {
    jasmine.clock().install();
    try {
      const source = new Subject<Blob>();
      drive.downloadFileRange.and.returnValue(source);
      const state = localState();
      const signal = service.begin('b94-download');
      service.setState('b94-download', state);
      const owner = callbacks();
      let error: Error | undefined;
      const pending = service.run('b94-download', state, owner).catch(value => { error = value; });
      jasmine.clock().tick(300_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(source.observed).toBeFalse();
      expect(error?.name).toBe('NetworkDeadlineError');
      expect(signal.aborted).toBeFalse();
      expect(owner.updateTransfer).not.toHaveBeenCalled();
      service.cancel('b94-download');
      await pending;
      expect(Array.from(state.fdk).every(value => value === 0)).toBeTrue();
    } finally { jasmine.clock().uninstall(); }
  });

  it('B.94 keeps a whole-file Google download cancellation-only', async () => {
    jasmine.clock().install();
    try {
      const source = new Subject<Blob>();
      drive.downloadExternalFile.and.returnValue(source);
      const state = googleState();
      service.begin('b94-whole');
      service.setState('b94-whole', state);
      const owner = callbacks();
      const pending = service.run('b94-whole', state, owner);
      jasmine.clock().tick(86_400_000);
      expect(source.observed).toBeTrue();
      expect(owner.updateTransfer).not.toHaveBeenCalled();
      service.cancel('b94-whole');
      await pending;
      expect(source.observed).toBeFalse();
      expect(state.fdk.every(value => value === 0)).toBeTrue();
    } finally { jasmine.clock().uninstall(); }
  });

  it('runs and removes a completed local download state', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([1]), baseNonce: new Uint8Array(24), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(19)])));
    kasumi.decryptFileChunk.and.resolveTo(new Uint8Array([1, 2, 3]));
    service.begin('download-1');
    service.setState('download-1', state);
    const update = jasmine.createSpy('updateTransfer');

    await service.run('download-1', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });

    expect(drive.downloadFileRange).toHaveBeenCalledWith(7, 24, 42);
    expect(update).toHaveBeenCalledWith('download-1', jasmine.objectContaining({ status: 'success' }));
    expect(service.getState('download-1')).toBeUndefined();
  });

  it('keeps a paused download state without requesting another range', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([1]), baseNonce: new Uint8Array(24), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    service.begin('download-2');
    service.setState('download-2', state);
    const update = jasmine.createSpy('updateTransfer');

    await service.run('download-2', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => true,
    });

    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('download-2', { status: 'paused' });
    expect(service.getState('download-2')).toBe(state);
  });

  it('aborts a pending range request and wipes runtime state without reporting an error', async () => {
    let unsubscribed = false;
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([9]), baseNonce: new Uint8Array(24).fill(7), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(new Observable<Blob>(subscriber => {
      const timer = setTimeout(() => subscriber.next(new Blob([new Uint8Array(19)])), 20);
      return () => { unsubscribed = true; clearTimeout(timer); };
    }));
    service.begin('download-cancel');
    service.setState('download-cancel', state);
    const update = jasmine.createSpy('updateTransfer');
    const running = service.run('download-cancel', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });

    await Promise.resolve();
    service.cancel('download-cancel');
    await running;

    expect(unsubscribed).toBeTrue();
    expect(update).not.toHaveBeenCalled();
    expect(service.getState('download-cancel')).toBeUndefined();
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(state.baseNonce.every(value => value === 0)).toBeTrue();
  });

  it('ignores a stale run after a newer runtime begins for the same transfer id', async () => {
    const oldState: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([1]), baseNonce: new Uint8Array(24), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    service.begin('download-race');
    service.setState('download-race', oldState);
    const update = jasmine.createSpy('updateTransfer');
    const running = service.run('download-race', oldState, {
      setProgress: jasmine.createSpy('setProgress').and.callFake(() => service.begin('download-race')),
      updateTransfer: update, isPaused: () => false,
    });
    await running;

    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
  });

  it('downloads Google Drive content through the external download observable', async () => {
    const fdk = new Uint8Array([4]);
    const googleState: DownloadState = {
      kind: 'google', file, fdk,
      meta: { external_file_id: 'external-1', access_token: 'token' },
    };
    const encrypted = new Blob(['encrypted']);
    const decrypted = new Blob(['plain']);
    const progress = jasmine.createSpy('setProgress');
    const click = spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(() => {
      expect(document.querySelector('a[download="arquivo.bin"]')).not.toBeNull();
    });
    drive.downloadExternalFile.and.returnValue(of(encrypted));
    kasumi.decryptFile.and.resolveTo(decrypted);
    service.begin('download-google');
    service.setState('download-google', googleState);

    await service.run('download-google', googleState, {
      setProgress: progress, updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    });

    expect(drive.downloadExternalFile).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/external-1?alt=media', 'token'
    );
    expect(kasumi.decryptFile).toHaveBeenCalledWith(encrypted, jasmine.any(Uint8Array), googleState.file.sizeBytes);
    expect(kasumi.decryptFile.calls.mostRecent().args[1]).toBe(fdk);
    expect(progress.calls.allArgs()).toEqual([[70, encrypted.size / 2, encrypted.size], [95, encrypted.size, encrypted.size]]);
    expect(URL.createObjectURL).toHaveBeenCalledWith(decrypted);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="arquivo.bin"]')).toBeNull();
    expect(fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('download-google')).toBeUndefined();
  });

  it('ignores Google completion when cancelled during decrypt', async () => {
    let resolveDecrypt!: (value: Blob) => void;
    const googleState: DownloadState = {
      kind: 'google', file, fdk: new Uint8Array([4]),
      meta: { external_file_id: 'external-2', access_token: 'token' },
    };
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.returnValue(new Promise<Blob>(resolve => {
      resolveDecrypt = resolve;
    }));
    service.begin('download-google-cancel');
    service.setState('download-google-cancel', googleState);
    const update = jasmine.createSpy('updateTransfer');
    const running = service.run('download-google-cancel', googleState, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });
    await Promise.resolve();
    expect(kasumi.decryptFile).toHaveBeenCalled();
    service.cancel('download-google-cancel');
    resolveDecrypt(new Blob(['plain']));
    await running;

    expect(service.getState('download-google-cancel')).toBeUndefined();
    expect(googleState.fdk).toEqual(new Uint8Array([0]));
    expect(update).not.toHaveBeenCalledWith('download-google-cancel', jasmine.objectContaining({ status: 'success' }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('ignores local completion when cancelled during decryptFileChunk', async () => {
    let resolveDecrypt!: (value: Uint8Array) => void;
    const localState: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([5]), baseNonce: new Uint8Array(24).fill(6), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    const encryptedChunk = { arrayBuffer: () => Promise.resolve(new Uint8Array(19).buffer) } as Blob;
    drive.downloadFileRange.and.returnValue(of(encryptedChunk));
    kasumi.decryptFileChunk.and.returnValue(new Promise<Uint8Array>(resolve => resolveDecrypt = resolve));
    service.begin('download-local-cancel');
    service.setState('download-local-cancel', localState);
    const update = jasmine.createSpy('updateTransfer');
    const running = service.run('download-local-cancel', localState, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });
    for (let i = 0; i < 10 && kasumi.decryptFileChunk.calls.count() === 0; i++) {
      await Promise.resolve();
    }
    expect(kasumi.decryptFileChunk).toHaveBeenCalled();
    service.cancel('download-local-cancel');
    resolveDecrypt(new Uint8Array([1, 2, 3]));
    await running;

    expect(localState.plaintextChunks).toEqual([]);
    expect(localState.decryptedBytes).toBe(0);
    expect(localState.currentOffset).toBe(24);
    expect(localState.chunkIndex).toBe(0);
    expect(localState.fdk).toEqual(new Uint8Array([0]));
    expect(localState.baseNonce.every(value => value === 0)).toBeTrue();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith('download-local-cancel', jasmine.objectContaining({ status: 'success' }));
  });

  it('wipes Google runtime state when reset happens during decrypt', async () => {
    let resolveDecrypt!: (value: Blob) => void;
    const googleState: DownloadState = {
      kind: 'google', file, fdk: new Uint8Array([8]),
      meta: { external_file_id: 'external-3', access_token: 'token' },
    };
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.returnValue(new Promise<Blob>(resolve => resolveDecrypt = resolve));
    service.begin('download-google-reset');
    service.setState('download-google-reset', googleState);
    const update = jasmine.createSpy('updateTransfer');
    const running = service.run('download-google-reset', googleState, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });
    await Promise.resolve();
    service.resetRuntimeState();
    resolveDecrypt(new Blob(['plain']));
    await running;

    expect(service.getState('download-google-reset')).toBeUndefined();
    expect(googleState.fdk).toEqual(new Uint8Array([0]));
    expect(update).not.toHaveBeenCalledWith('download-google-reset', jasmine.objectContaining({ status: 'success' }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a truncated local chunk without decrypting or saving it', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([2]), baseNonce: new Uint8Array(24).fill(3), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(18)])));
    service.begin('download-truncated');
    service.setState('download-truncated', state);

    await expectAsync(service.run('download-truncated', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    })).toBeRejectedWithError('File corrupted or truncated');

    expect(kasumi.decryptFileChunk).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    service.deleteState('download-truncated');
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(state.baseNonce.every(value => value === 0)).toBeTrue();
    expect(state.plaintextChunks).toEqual([]);
  });

  it('resumes a partial local download from the supplied offset and chunk index', async () => {
    const previous = new Blob(['old']);
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([7]), baseNonce: new Uint8Array(24).fill(9), expectedSize: 6,
      decryptedBytes: 3, currentOffset: 43, chunkIndex: 1, plaintextChunks: [previous],
    };
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(19)])));
    kasumi.decryptFileChunk.and.resolveTo(new Uint8Array([4, 5, 6]));
    service.begin('download-resume');
    service.setState('download-resume', state);
    const progress = jasmine.createSpy('setProgress');

    await service.run('download-resume', state, {
      setProgress: progress, updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    });

    expect(drive.downloadFileRange).toHaveBeenCalledWith(7, 43, 61);
    expect(kasumi.decryptFileChunk).toHaveBeenCalledWith(
      jasmine.any(Uint8Array), jasmine.any(Uint8Array), state.baseNonce, 1, jasmine.any(Uint8Array)
    );
    expect(progress).toHaveBeenCalledWith(50, 3, 6);
    const downloaded = (URL.createObjectURL as jasmine.Spy).calls.mostRecent().args[0] as Blob;
    expect(downloaded.size).toBe(6);
    expect(service.getState('download-resume')).toBeUndefined();
  });

  it('revokes the object URL and removes the anchor when click throws', async () => {
    const click = spyOn(HTMLAnchorElement.prototype, 'click').and.throwError('click failed');
    const googleState: DownloadState = {
      kind: 'google', file, fdk: new Uint8Array([4]),
      meta: { external_file_id: 'external-click', access_token: 'token' },
    };
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('download-click-failure');
    service.setState('download-click-failure', googleState);

    await expectAsync(service.run('download-click-failure', googleState, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    })).toBeRejectedWithError('click failed');

    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(document.querySelector('a[download="arquivo.bin"]')).toBeNull();
    service.cancel('download-click-failure');
  });

  it('downloads multiple local chunks with inclusive ranges and commits progression in order', async () => {
    const initialOffset = 24;
    const expectedSize = KASUMI_CHUNK_SIZE + 1;
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([10]), baseNonce: new Uint8Array(24).fill(11), expectedSize,
      decryptedBytes: 0, currentOffset: initialOffset, chunkIndex: 0, plaintextChunks: [],
    };
    const ranges: Array<[number, number]> = [];
    const decryptCalls: Array<{ baseNonce: Uint8Array; fdk: Uint8Array; chunkIndex: number }> = [];
    drive.downloadFileRange.and.callFake((_id: number, start: number, end: number) => {
      ranges.push([start, end]);
      return of(encryptedChunk(end - start + 1));
    });
    kasumi.decryptFileChunk.and.callFake(
      (_ciphertext: Uint8Array, _tag: Uint8Array, baseNonce: Uint8Array, chunkIndex: number, fdk: Uint8Array) => {
        decryptCalls.push({ baseNonce, fdk, chunkIndex });
        return Promise.resolve(new Uint8Array(chunkIndex === 0 ? KASUMI_CHUNK_SIZE : 1));
      },
    );
    const progress = jasmine.createSpy('setProgress');
    const committedSnapshots: Array<Pick<DownloadState & { kind: 'local' }, 'decryptedBytes' | 'currentOffset' | 'chunkIndex'>> = [];
    progress.and.callFake((value: number) => {
      if (value === 100) {
        committedSnapshots.push({
          decryptedBytes: state.kind === 'local' ? state.decryptedBytes : -1,
          currentOffset: state.kind === 'local' ? state.currentOffset : -1,
          chunkIndex: state.kind === 'local' ? state.chunkIndex : -1,
        });
      }
    });
    const update = jasmine.createSpy('updateTransfer');
    service.begin('download-multi');
    service.setState('download-multi', state);

    await service.run('download-multi', state, {
      setProgress: progress, updateTransfer: update, isPaused: () => false,
    });

    expect(ranges).toEqual([
      [initialOffset, initialOffset + 16 + KASUMI_CHUNK_SIZE - 1],
      [initialOffset + 16 + KASUMI_CHUNK_SIZE, initialOffset + 16 + KASUMI_CHUNK_SIZE + 16],
    ]);
    expect(decryptCalls.map(call => call.chunkIndex)).toEqual([0, 1]);
    expect(decryptCalls[0].baseNonce).toBe(decryptCalls[1].baseNonce);
    expect(decryptCalls[0].fdk).toBe(decryptCalls[1].fdk);
    expect(committedSnapshots).toEqual([{
      decryptedBytes: KASUMI_CHUNK_SIZE,
      currentOffset: initialOffset + 16 + KASUMI_CHUNK_SIZE,
      chunkIndex: 1,
    }]);
    expect(update).toHaveBeenCalledWith('download-multi', jasmine.objectContaining({ status: 'success' }));
    expect(service.getState('download-multi')).toBeUndefined();
  });

  it('uses exactly one range at the exact chunk boundary', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([12]), baseNonce: new Uint8Array(24).fill(13), expectedSize: KASUMI_CHUNK_SIZE,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    service.begin('download-boundary');
    service.setState('download-boundary', state);
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(16 + KASUMI_CHUNK_SIZE)));
    kasumi.decryptFileChunk.and.resolveTo(new Uint8Array(KASUMI_CHUNK_SIZE));

    await service.run('download-boundary', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    });

    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
    expect(drive.downloadFileRange).toHaveBeenCalledWith(7, 24, 24 + 16 + KASUMI_CHUNK_SIZE - 1);
    expect(kasumi.decryptFileChunk).toHaveBeenCalledTimes(1);
    expect(kasumi.decryptFileChunk).toHaveBeenCalledWith(
      jasmine.any(Uint8Array), jasmine.any(Uint8Array), state.baseNonce, 0, state.fdk,
    );
    expect(service.getState('download-boundary')).toBeUndefined();
  });

  it('pauses after a range response without decrypting or mutating resumable state', async () => {
    const fdk = new Uint8Array([14]);
    const baseNonce = new Uint8Array(24).fill(15);
    const state: DownloadState = {
      kind: 'local', file, fdk, baseNonce, expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(19)));
    const update = jasmine.createSpy('updateTransfer');
    service.begin('download-pause-range');
    service.setState('download-pause-range', state);

    await service.run('download-pause-range', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update,
      isPaused: jasmine.createSpy('isPaused').and.returnValues(false, true),
    });

    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
    expect(kasumi.decryptFileChunk).not.toHaveBeenCalled();
    expect(state.plaintextChunks).toEqual([]);
    expect(state.decryptedBytes).toBe(0);
    expect(state.currentOffset).toBe(24);
    expect(state.chunkIndex).toBe(0);
    expect(fdk).toEqual(new Uint8Array([14]));
    expect(baseNonce).toEqual(new Uint8Array(24).fill(15));
    expect(update).toHaveBeenCalledWith('download-pause-range', { status: 'paused' });
    expect(service.getState('download-pause-range')).toBe(state);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    service.cancel('download-pause-range');
  });

  it('pauses after decrypt resolves without committing plaintext or wiping keys', async () => {
    let resolveDecrypt!: (value: Uint8Array) => void;
    let markDecryptStarted!: () => void;
    const decryptStarted = new Promise<void>(resolve => { markDecryptStarted = resolve; });
    const fdk = new Uint8Array([16]);
    const baseNonce = new Uint8Array(24).fill(17);
    const state: DownloadState = {
      kind: 'local', file, fdk, baseNonce, expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(19)));
    kasumi.decryptFileChunk.and.callFake(() => {
      markDecryptStarted();
      return new Promise<Uint8Array>(resolve => { resolveDecrypt = resolve; });
    });
    const update = jasmine.createSpy('updateTransfer');
    let paused = false;
    service.begin('download-pause-decrypt');
    service.setState('download-pause-decrypt', state);
    const running = service.run('download-pause-decrypt', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => paused,
    });

    await decryptStarted;
    paused = true;
    resolveDecrypt(new Uint8Array([1, 2, 3]));
    await running;

    expect(state.plaintextChunks).toEqual([]);
    expect(state.decryptedBytes).toBe(0);
    expect(state.currentOffset).toBe(24);
    expect(state.chunkIndex).toBe(0);
    expect(fdk).toEqual(new Uint8Array([16]));
    expect(baseNonce).toEqual(new Uint8Array(24).fill(17));
    expect(update).toHaveBeenCalledWith('download-pause-decrypt', { status: 'paused' });
    expect(service.getState('download-pause-decrypt')).toBe(state);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    service.cancel('download-pause-decrypt');
  });

  it('rejects stale arrayBuffer completion without decrypting, committing, or downloading', async () => {
    let resolveBuffer!: (value: ArrayBuffer) => void;
    let markBufferStarted!: () => void;
    const bufferStarted = new Promise<void>(resolve => { markBufferStarted = resolve; });
    const oldState: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([18]), baseNonce: new Uint8Array(24).fill(19), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    const pendingBlob = {
      arrayBuffer: () => {
        markBufferStarted();
        return new Promise<ArrayBuffer>(resolve => { resolveBuffer = resolve; });
      },
    } as Blob;
    drive.downloadFileRange.and.returnValue(of(pendingBlob));
    const update = jasmine.createSpy('updateTransfer');
    service.begin('download-stale-array-buffer');
    service.setState('download-stale-array-buffer', oldState);
    const running = service.run('download-stale-array-buffer', oldState, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: update, isPaused: () => false,
    });

    await bufferStarted;
    const newState: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([20]), baseNonce: new Uint8Array(24).fill(21), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    service.begin('download-stale-array-buffer');
    service.setState('download-stale-array-buffer', newState);
    resolveBuffer(new ArrayBuffer(19));
    await running;

    expect(kasumi.decryptFileChunk).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith('download-stale-array-buffer', jasmine.objectContaining({ status: 'success' }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    expect(oldState.baseNonce.every(value => value === 0)).toBeTrue();
    expect(service.getState('download-stale-array-buffer')).toBe(newState);
    service.cancel('download-stale-array-buffer');
  });

  it('zeroizes local sensitive state after successful download', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([22]), baseNonce: new Uint8Array(24).fill(23), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(19)));
    kasumi.decryptFileChunk.and.resolveTo(new Uint8Array([1, 2, 3]));
    service.begin('download-zeroize-success');
    service.setState('download-zeroize-success', state);

    await service.run('download-zeroize-success', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    });

    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(state.baseNonce.every(value => value === 0)).toBeTrue();
    expect(state.plaintextChunks).toEqual([]);
    expect(service.getState('download-zeroize-success')).toBeUndefined();
  });

  it('propagates decrypt failures without committing or wiping resumable state', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([24]), baseNonce: new Uint8Array(24).fill(25), expectedSize: 3,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(19)));
    kasumi.decryptFileChunk.and.callFake(() => Promise.reject(new Error('decrypt failed')));
    service.begin('download-decrypt-error');
    service.setState('download-decrypt-error', state);

    await expectAsync(service.run('download-decrypt-error', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    })).toBeRejectedWithError('decrypt failed');

    expect(state.plaintextChunks).toEqual([]);
    expect(state.decryptedBytes).toBe(0);
    expect(state.currentOffset).toBe(24);
    expect(state.chunkIndex).toBe(0);
    expect(state.fdk).toEqual(new Uint8Array([24]));
    expect(state.baseNonce).toEqual(new Uint8Array(24).fill(25));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    service.deleteState('download-decrypt-error');
  });

  it('completes a zero-byte local download without requesting or decrypting a chunk', async () => {
    const state: DownloadState = {
      kind: 'local', file, fdk: new Uint8Array([26]), baseNonce: new Uint8Array(24).fill(27), expectedSize: 0,
      decryptedBytes: 0, currentOffset: 24, chunkIndex: 0, plaintextChunks: [],
    };
    service.begin('download-zero-byte');
    service.setState('download-zero-byte', state);

    await service.run('download-zero-byte', state, {
      setProgress: jasmine.createSpy('setProgress'), updateTransfer: jasmine.createSpy('updateTransfer'), isPaused: () => false,
    });

    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(kasumi.decryptFileChunk).not.toHaveBeenCalled();
    const downloaded = (URL.createObjectURL as jasmine.Spy).calls.mostRecent().args[0] as Blob;
    expect(downloaded.size).toBe(0);
    expect(service.getState('download-zero-byte')).toBeUndefined();
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(state.baseNonce.every(value => value === 0)).toBeTrue();
    expect(state.plaintextChunks).toEqual([]);
  });

  it('uses the fallback filename for a Google download without a decrypted name', async () => {
    const state: GoogleDownloadState = { ...googleState(), file: { ...file, decryptedName: '' } };
    const click = spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(() => {
      expect(document.querySelector('a[download="arquivo_desconhecido"]')).not.toBeNull();
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-fallback-name');
    service.setState('google-fallback-name', state);

    await service.run('google-fallback-name', state, callbacks());

    expect(click).toHaveBeenCalledTimes(1);
    expect(service.getState('google-fallback-name')).toBeUndefined();
  });

  it('does not request Google content when paused before the run starts', async () => {
    const state = googleState(new Uint8Array([28]), 'google-initial-pause');
    const update = jasmine.createSpy('updateTransfer');
    service.begin('google-initial-pause');
    service.setState('google-initial-pause', state);

    await service.run('google-initial-pause', state, callbacks({
      updateTransfer: update,
      isPaused: () => true,
    }));

    expect(drive.downloadExternalFile).not.toHaveBeenCalled();
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-initial-pause', { status: 'paused' });
    expect(service.getState('google-initial-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([28]));
    service.cancel('google-initial-pause');
  });

  it('unsubscribes a pending Google request and wipes state on cancel', async () => {
    const state = googleState(new Uint8Array([29]), 'google-http-cancel');
    const unsubscribed = jasmine.createSpy('unsubscribed');
    drive.downloadExternalFile.and.returnValue(new Observable<Blob>(() => () => unsubscribed()));
    service.begin('google-http-cancel');
    service.setState('google-http-cancel', state);
    const running = service.run('google-http-cancel', state, callbacks());

    await Promise.resolve();
    service.cancel('google-http-cancel');
    await running;

    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(service.getState('google-http-cancel')).toBeUndefined();
    expect(state.fdk).toEqual(new Uint8Array([0]));
  });

  it('drops a settled Google request on pause and resumes by reissuing the monolithic request', async () => {
    const state = googleState(new Uint8Array([30]), 'google-http-pause');
    const encrypted = new Blob(['encrypted']);
    const update = jasmine.createSpy('updateTransfer');
    const isPaused = jasmine.createSpy('isPaused').and.returnValues(false, true);
    drive.downloadExternalFile.and.returnValue(of(encrypted));
    service.begin('google-http-pause');
    service.setState('google-http-pause', state);

    await service.run('google-http-pause', state, callbacks({ updateTransfer: update, isPaused }));

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-http-pause', { status: 'paused' });
    expect(service.getState('google-http-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([30]));
    expect(state.meta.access_token).toBe('test-token');

    isPaused.and.returnValue(false);
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    await service.run('google-http-pause', state, callbacks({ updateTransfer: update, isPaused }));

    expect(drive.downloadExternalFile).toHaveBeenCalledTimes(2);
    expect(service.getState('google-http-pause')).toBeUndefined();
  });

  it('drops a Google response that arrives after pause while HTTP is pending', async () => {
    const state = googleState(new Uint8Array([47]), 'google-http-pending-pause');
    let emit!: (value: Blob) => void;
    const update = jasmine.createSpy('updateTransfer');
    let paused = false;
    drive.downloadExternalFile.and.returnValue(new Observable<Blob>(subscriber => {
      emit = value => subscriber.next(value);
    }));
    service.begin('google-http-pending-pause');
    service.setState('google-http-pending-pause', state);
    const running = service.run('google-http-pending-pause', state, callbacks({
      updateTransfer: update,
      isPaused: () => paused,
    }));

    await Promise.resolve();
    paused = true;
    emit(new Blob(['encrypted']));
    await running;

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-http-pending-pause', { status: 'paused' });
    expect(service.getState('google-http-pending-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([47]));
    service.cancel('google-http-pending-pause');
  });

  it('does not let a newer runtime publish completion from an old Google request', async () => {
    const oldState = googleState(new Uint8Array([31]), 'google-http-stale');
    const newState = googleState(new Uint8Array([32]), 'google-http-new');
    drive.downloadExternalFile.and.returnValue(new Observable<Blob>(() => () => undefined));
    service.begin('google-http-stale');
    service.setState('google-http-stale', oldState);
    const running = service.run('google-http-stale', oldState, callbacks());

    await Promise.resolve();
    service.begin('google-http-stale');
    service.setState('google-http-stale', newState);
    await running;

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-http-stale')).toBe(newState);
    service.cancel('google-http-stale');
  });

  it('drops a Google decrypt result on pause while retaining the exact FDK and metadata', async () => {
    const state = googleState(new Uint8Array([33]), 'google-decrypt-pause');
    const decrypt = deferred<Blob>();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const update = jasmine.createSpy('updateTransfer');
    let paused = false;
    kasumi.decryptFile.and.callFake(() => {
      markStarted();
      return decrypt.promise;
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    service.begin('google-decrypt-pause');
    service.setState('google-decrypt-pause', state);
    const running = service.run('google-decrypt-pause', state, callbacks({
      updateTransfer: update,
      isPaused: () => paused,
    }));

    await started;
    paused = true;
    decrypt.resolve(new Blob(['plain']));
    await running;

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-decrypt-pause', { status: 'paused' });
    expect(service.getState('google-decrypt-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([33]));
    expect(state.meta.access_token).toBe('test-token');
    service.cancel('google-decrypt-pause');
  });

  it('does not publish a stale Google decrypt result after a newer runtime replaces it', async () => {
    const oldState = googleState(new Uint8Array([34]), 'google-decrypt-stale');
    const newState = googleState(new Uint8Array([35]), 'google-decrypt-new');
    const decrypt = deferred<Blob>();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    kasumi.decryptFile.and.callFake(() => {
      markStarted();
      return decrypt.promise;
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    const progress = jasmine.createSpy('setProgress');
    const update = jasmine.createSpy('updateTransfer');
    service.begin('google-decrypt-stale');
    service.setState('google-decrypt-stale', oldState);
    const running = service.run('google-decrypt-stale', oldState, callbacks({ setProgress: progress, updateTransfer: update }));

    await started;
    service.begin('google-decrypt-stale');
    service.setState('google-decrypt-stale', newState);
    decrypt.resolve(new Blob(['plain']));
    await running;

    expect(progress.calls.allArgs()).toEqual([[70, 4.5, 9]]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith('google-decrypt-stale', jasmine.objectContaining({ status: 'success' }));
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-decrypt-stale')).toBe(newState);
    service.cancel('google-decrypt-stale');
  });

  it('propagates a Google decrypt failure without reporting success or wiping retained state', async () => {
    const state = googleState(new Uint8Array([36]), 'google-decrypt-error');
    const update = jasmine.createSpy('updateTransfer');
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.callFake(() => Promise.reject(new Error('decrypt failed')));
    service.begin('google-decrypt-error');
    service.setState('google-decrypt-error', state);

    await expectAsync(service.run('google-decrypt-error', state, callbacks({ updateTransfer: update })))
      .toBeRejectedWithError('decrypt failed');

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith('google-decrypt-error', jasmine.objectContaining({ status: 'success' }));
    expect(state.fdk).toEqual(new Uint8Array([36]));
    service.deleteState('google-decrypt-error');
  });

  it('does not start Google decrypt when the 70% callback cancels the runtime', async () => {
    const state = googleState(new Uint8Array([37]), 'google-progress70-cancel');
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 70) service.cancel('google-progress70-cancel');
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    service.begin('google-progress70-cancel');
    service.setState('google-progress70-cancel', state);

    await service.run('google-progress70-cancel', state, callbacks({ setProgress: progress }));

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-progress70-cancel')).toBeUndefined();
  });

  it('does not start Google decrypt when the 70% callback replaces the runtime', async () => {
    const oldState = googleState(new Uint8Array([38]), 'google-progress70-replace');
    const newState = googleState(new Uint8Array([39]), 'google-progress70-new');
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 70) {
        service.begin('google-progress70-replace');
        service.setState('google-progress70-replace', newState);
      }
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    service.begin('google-progress70-replace');
    service.setState('google-progress70-replace', oldState);

    await service.run('google-progress70-replace', oldState, callbacks({ setProgress: progress }));

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-progress70-replace')).toBe(newState);
    service.cancel('google-progress70-replace');
  });

  it('does not start Google decrypt when the 70% callback pauses the runtime', async () => {
    const state = googleState(new Uint8Array([40]), 'google-progress70-pause');
    const update = jasmine.createSpy('updateTransfer');
    let paused = false;
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 70) paused = true;
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    service.begin('google-progress70-pause');
    service.setState('google-progress70-pause', state);

    await service.run('google-progress70-pause', state, callbacks({
      setProgress: progress,
      updateTransfer: update,
      isPaused: () => paused,
    }));

    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-progress70-pause', { status: 'paused' });
    expect(service.getState('google-progress70-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([40]));
    service.cancel('google-progress70-pause');
  });

  it('keeps the existing stale-runtime barrier after the 95% callback', async () => {
    const oldState = googleState(new Uint8Array([41]), 'google-progress95-replace');
    const newState = googleState(new Uint8Array([42]), 'google-progress95-new');
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 95) {
        service.begin('google-progress95-replace');
        service.setState('google-progress95-replace', newState);
      }
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-progress95-replace');
    service.setState('google-progress95-replace', oldState);

    await service.run('google-progress95-replace', oldState, callbacks({ setProgress: progress }));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(service.getState('google-progress95-replace')).toBe(newState);
    service.cancel('google-progress95-replace');
  });

  it('keeps the existing stale-runtime barrier after the 95% callback cancels', async () => {
    const state = googleState(new Uint8Array([43]), 'google-progress95-cancel');
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 95) service.cancel('google-progress95-cancel');
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-progress95-cancel');
    service.setState('google-progress95-cancel', state);

    await service.run('google-progress95-cancel', state, callbacks({ setProgress: progress }));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-progress95-cancel')).toBeUndefined();
  });

  it('does not trigger a browser download when the 95% callback pauses', async () => {
    const state = googleState(new Uint8Array([44]), 'google-progress95-pause');
    const update = jasmine.createSpy('updateTransfer');
    let paused = false;
    const progress = jasmine.createSpy('setProgress').and.callFake((value: number) => {
      if (value === 95) paused = true;
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-progress95-pause');
    service.setState('google-progress95-pause', state);

    await service.run('google-progress95-pause', state, callbacks({
      setProgress: progress,
      updateTransfer: update,
      isPaused: () => paused,
    }));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('google-progress95-pause', { status: 'paused' });
    expect(service.getState('google-progress95-pause')).toBe(state);
    expect(state.fdk).toEqual(new Uint8Array([44]));
    service.cancel('google-progress95-pause');
  });

  it('does not publish success if cancellation happens during the browser click', async () => {
    const state = googleState(new Uint8Array([45]), 'google-click-cancel');
    const update = jasmine.createSpy('updateTransfer');
    const click = spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(() => {
      service.cancel('google-click-cancel');
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-click-cancel');
    service.setState('google-click-cancel', state);

    await service.run('google-click-cancel', state, callbacks({ updateTransfer: update }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalledWith('google-click-cancel', jasmine.objectContaining({ status: 'success' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(state.fdk).toEqual(new Uint8Array([0]));
    expect(service.getState('google-click-cancel')).toBeUndefined();
  });

  it('propagates Google HTTP errors without retrying or downloading', async () => {
    const state = googleState(new Uint8Array([46]), 'google-http-error');
    const update = jasmine.createSpy('updateTransfer');
    drive.downloadExternalFile.and.returnValue(new Observable<Blob>(subscriber => {
      subscriber.error(new Error('google failed'));
    }));
    service.begin('google-http-error');
    service.setState('google-http-error', state);

    await expectAsync(service.run('google-http-error', state, callbacks({ updateTransfer: update })))
      .toBeRejectedWithError('google failed');

    expect(drive.downloadExternalFile).toHaveBeenCalledTimes(1);
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith('google-http-error', jasmine.objectContaining({ status: 'success' }));
    expect(state.fdk).toEqual(new Uint8Array([46]));
    service.deleteState('google-http-error');
  });

  it('does not delete a newer Google runtime created during the success callback', async () => {
    const oldState = googleState(new Uint8Array([51]), 'google-terminal-old');
    const newState = googleState(new Uint8Array([52]), 'google-terminal-new');
    const newFdk = newState.fdk;
    const update = jasmine.createSpy('updateTransfer').and.callFake((id: string, changes: Partial<TransferItem>) => {
      if (changes.status === 'success') {
        service.begin(id);
        expect(service.setState(id, newState)).toBeTrue();
      }
    });
    drive.downloadExternalFile.and.returnValue(of(new Blob(['encrypted'])));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    service.begin('google-terminal-replace');
    service.setState('google-terminal-replace', oldState);

    await service.run('google-terminal-replace', oldState, callbacks({ updateTransfer: update }));

    expect(service.getState('google-terminal-replace')).toBe(newState);
    expect(newState.fdk).toBe(newFdk);
    expect(newState.fdk).toEqual(new Uint8Array([52]));
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    service.cancel('google-terminal-replace');
  });

  it('does not wipe a newer Local runtime created during the success callback', async () => {
    const oldState = localState(new Uint8Array([59]));
    oldState.baseNonce.fill(58);
    const newState = localState(new Uint8Array([60]));
    newState.baseNonce.fill(61);
    newState.plaintextChunks.push(new Blob(['existing']));
    const newFdk = newState.fdk;
    const newBaseNonce = newState.baseNonce;
    const newPlaintextChunks = newState.plaintextChunks;
    const update = jasmine.createSpy('updateTransfer').and.callFake((id: string, changes: Partial<TransferItem>) => {
      if (changes.status === 'success') {
        service.begin(id);
        expect(service.setState(id, newState)).toBeTrue();
      }
    });
    drive.downloadFileRange.and.returnValue(of(encryptedChunk(19)));
    kasumi.decryptFileChunk.and.resolveTo(new Uint8Array([1, 2, 3]));
    service.begin('local-terminal-replace');
    service.setState('local-terminal-replace', oldState);

    await service.run('local-terminal-replace', oldState, callbacks({ updateTransfer: update }));

    expect(service.getState('local-terminal-replace')).toBe(newState);
    expect(newState.fdk).toBe(newFdk);
    expect(newState.baseNonce).toBe(newBaseNonce);
    expect(newState.plaintextChunks).toBe(newPlaintextChunks);
    expect(newState.fdk).toEqual(new Uint8Array([60]));
    expect(newState.baseNonce.every(value => value === 61)).toBeTrue();
    expect(newState.plaintextChunks).toEqual([jasmine.any(Blob)]);
    expect(oldState.fdk).toEqual(new Uint8Array([0]));
    expect(oldState.baseNonce.every(value => value === 0)).toBeTrue();
    expect(oldState.plaintextChunks).toEqual([]);
    service.cancel('local-terminal-replace');
  });
});
