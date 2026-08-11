import { Observable, of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ThumbnailLoaderService } from './thumbnail-loader.service';
import type { DriveFile } from '../state/drive.store';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPruneService(): ThumbnailLoaderService {
  return new ThumbnailLoaderService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

function createThumbnailFile(id: number): DriveFile {
  return { id, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;
}

describe('ThumbnailLoaderService', () => {
  for (const action of ['clear', 'prune'] as const) {
    it(`unsubscribes a pending local range on ${action}`, async () => {
      const range = new Subject<Blob>();
      const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(range) };
      const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata') };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
      const loading = service.load(createThumbnailFile(50));
      await flushMicrotasks();
      expect(range.observed).toBeTrue();

      if (action === 'clear') service.clear();
      else service.prune(new Set());

      expect(range.observed).toBeFalse();
      // Settle the pre-patch request too, so RED observes cancellation rather than a timeout.
      range.next(new Blob(['late']));
      range.complete();
      await loading;
      expect(kasumi.extractMetadata).not.toHaveBeenCalled();
      expect(service.thumbnails()).toEqual({});
    });
  }

  describe('cancellation ownership', () => {
    let service: ThumbnailLoaderService;
    let crypto: { decryptName: jasmine.Spy };
    let drive: { downloadFileRange: jasmine.Spy; downloadExternalMetadata: jasmine.Spy };
    let http: { get: jasmine.Spy };
    let kasumi: { extractMetadata: jasmine.Spy };
    let range: Subject<Blob>;
    let metadata: Subject<{ external_file_id: string; access_token: string }>;
    let warn: jasmine.Spy;

    beforeEach(() => {
      range = new Subject<Blob>();
      metadata = new Subject();
      crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(range),
        downloadExternalMetadata: jasmine.createSpy('downloadExternalMetadata').and.returnValue(metadata),
      };
      http = { get: jasmine.createSpy('get').and.returnValue(range) };
      kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"current"}' }) };
      service = new ThumbnailLoaderService(crypto as any, drive as any, http as any, kasumi as any);
      warn = spyOn(console, 'warn');
    });

    it('prunes only the removed local request and retains the other owner', async () => {
      const retained = new Subject<Blob>();
      drive.downloadFileRange.and.callFake((id: number) => id === 51 ? retained : range);
      const removedLoad = service.load(createThumbnailFile(50));
      const retainedLoad = service.load(createThumbnailFile(51));
      await flushMicrotasks();
      expect(range.observed).toBeTrue();
      expect(retained.observed).toBeTrue();
      const owner = (service as any).controllers.get(51);

      service.prune(new Set([51]));
      expect(range.observed).toBeFalse();
      expect(retained.observed).toBeTrue();
      expect((service as any).controllers.get(51)).toBe(owner);
      expect(owner.signal.aborted).toBeFalse();
      range.next(new Blob(['late']));
      retained.next(new Blob(['current']));
      await Promise.all([removedLoad, retainedLoad]);

      expect(service.thumbnails()).toEqual({ 51: 'current' });
      expect(kasumi.extractMetadata).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    for (const action of ['clear', 'prune'] as const) {
      it(`aborts Google metadata on ${action} without starting a range or retaining the FDK`, async () => {
        const fdk = spyOn<any>(service, 'decodeFdk').and.callThrough();
        const loading = service.load({ ...createThumbnailFile(52), storageProvider: 'google_drive' });
        await flushMicrotasks();
        expect(metadata.observed).toBeTrue();

        if (action === 'clear') service.clear();
        else service.prune(new Set());
        expect(metadata.observed).toBeFalse();
        metadata.next({ external_file_id: 'remote', access_token: 'test-token' });
        await loading;

        expect(fdk.calls.mostRecent().returnValue).toEqual(new Uint8Array(3));
        expect(http.get).not.toHaveBeenCalled();
        expect(drive.downloadFileRange).not.toHaveBeenCalled();
        expect(kasumi.extractMetadata).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });

      it(`aborts a pending Google range on ${action}`, async () => {
        drive.downloadExternalMetadata.and.returnValue(of({ external_file_id: 'remote', access_token: 'test-token' }));
        const loading = service.load({ ...createThumbnailFile(53), storageProvider: 'google_drive' });
        await flushMicrotasks();
        expect(range.observed).toBeTrue();

        if (action === 'clear') service.clear();
        else service.prune(new Set());
        expect(range.observed).toBeFalse();
        await loading;

        expect(http.get).toHaveBeenCalledTimes(1);
        expect(drive.downloadFileRange).not.toHaveBeenCalled();
        expect(kasumi.extractMetadata).not.toHaveBeenCalled();
        expect(service.thumbnails()).toEqual({});
        expect(warn).not.toHaveBeenCalled();
      });

      it(`aborts the second adaptive range on ${action} without a third request`, async () => {
        drive.downloadFileRange.and.returnValues(of(new Blob(['partial'])), range);
        kasumi.extractMetadata.and.rejectWith(new Error('partial blob'));
        const loading = service.load({ ...createThumbnailFile(54), sizeBytes: 2 * 1024 * 1024 });
        await flushMicrotasks();
        expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
        expect(range.observed).toBeTrue();

        if (action === 'clear') service.clear();
        else service.prune(new Set());
        expect(range.observed).toBeFalse();
        await loading;

        expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
        expect(kasumi.extractMetadata).toHaveBeenCalledTimes(1);
        expect(service.thumbnails()).toEqual({});
        expect(warn).not.toHaveBeenCalled();
      });
    }

    it('prunes Google metadata without aborting a retained local request', async () => {
      const removedLoad = service.load({ ...createThumbnailFile(55), storageProvider: 'google_drive' });
      const retainedLoad = service.load(createThumbnailFile(56));
      await flushMicrotasks();
      expect(metadata.observed).toBeTrue();
      expect(range.observed).toBeTrue();

      service.prune(new Set([56]));
      expect(metadata.observed).toBeFalse();
      expect(range.observed).toBeTrue();
      range.next(new Blob(['current']));
      await Promise.all([removedLoad, retainedLoad]);

      expect(service.thumbnails()).toEqual({ 56: 'current' });
      expect(http.get).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('wipes an already resolved FDK when clear cancels the local request', async () => {
      const fdk = spyOn<any>(service, 'decodeFdk').and.callThrough();
      const loading = service.load(createThumbnailFile(57));
      await flushMicrotasks();
      expect(fdk.calls.mostRecent().returnValue).not.toEqual(new Uint8Array(3));

      service.clear();
      await loading;

      expect(fdk.calls.mostRecent().returnValue).toEqual(new Uint8Array(3));
      expect(kasumi.extractMetadata).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('suppresses a resolved metadata result after prune and wipes its FDK', async () => {
      const extraction = deferred<{ metadata: string }>();
      drive.downloadFileRange.and.returnValue(of(new Blob(['header'])));
      kasumi.extractMetadata.and.returnValue(extraction.promise);
      const loading = service.load(createThumbnailFile(58));
      await flushMicrotasks();
      const fdk = kasumi.extractMetadata.calls.mostRecent().args[1] as Uint8Array;

      service.prune(new Set());
      extraction.resolve({ metadata: '{"thumb":"stale"}' });
      await loading;

      expect(service.thumbnails()).toEqual({});
      expect(fdk).toEqual(new Uint8Array(3));
      expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not grow a range after stale metadata extraction rejects as partial', async () => {
      const extraction = deferred<{ metadata: string }>();
      drive.downloadFileRange.and.returnValue(of(new Blob(['header'])));
      kasumi.extractMetadata.and.returnValue(extraction.promise);
      const loading = service.load({ ...createThumbnailFile(59), sizeBytes: 2 * 1024 * 1024 });
      await flushMicrotasks();
      const fdk = kasumi.extractMetadata.calls.mostRecent().args[1] as Uint8Array;

      service.prune(new Set());
      extraction.reject(new Error('partial blob'));
      await loading;

      expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
      expect(kasumi.extractMetadata).toHaveBeenCalledTimes(1);
      expect(service.thumbnails()).toEqual({});
      expect(fdk).toEqual(new Uint8Array(3));
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not retry, warn or permanently fail a cancelled request', async () => {
      jasmine.clock().install();
      try {
        const file = createThumbnailFile(60);
        const loading = service.load(file);
        await flushMicrotasks();
        service.clear();
        range.error(new HttpErrorResponse({ status: 0 }));
        await loading;
        jasmine.clock().tick(1_000);
        await flushMicrotasks();
        expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();

        drive.downloadFileRange.and.returnValue(of(new Blob(['current'])));
        await service.load(file);
        expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
        expect(service.thumbnails()[file.id]).toBe('current');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('clears a scheduled retry without starting another request', async () => {
      jasmine.clock().install();
      try {
        drive.downloadFileRange.and.returnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
        await service.load(createThumbnailFile(61));
        expect(warn).toHaveBeenCalledTimes(1);

        service.clear();
        jasmine.clock().tick(1_000);
        await flushMicrotasks();

        expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
        expect(service.thumbnails()).toEqual({});
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('aborts and removes a controller-only prune candidate', () => {
      const controller = new AbortController();
      (service as any).controllers.set(62, controller);
      const before = service.thumbnails();

      service.prune(new Set());

      expect(controller.signal.aborted).toBeTrue();
      expect((service as any).controllers.has(62)).toBeFalse();
      expect(service.thumbnails()).toBe(before);
    });
  });

  it('loads and caches the thumbnail metadata', async () => {
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const http = {};
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"data:image/png;base64,AA=="}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, http as any, kasumi as any);
    const file = { id: 8, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    await service.load(file);
    await service.load(file);

    expect(service.thumbnails()[8]).toBe('data:image/png;base64,AA==');
    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
  });

  it('does not commit a result from a generation invalidated by clear', async () => {
    let resolveName!: (value: string) => void;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.returnValue(new Promise<string>(resolve => resolveName = resolve)) };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"stale"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 9, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    const loading = service.load(file);
    service.clear();
    resolveName('ZmRr');
    await loading;

    expect(service.thumbnails()).toEqual({});
    expect(drive.downloadFileRange).not.toHaveBeenCalled();
  });

  it('prunes thumbnails and retry state for files no longer in the tree', async () => {
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"old"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 10, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    await service.load(file);
    service.prune(new Set());

    expect(service.thumbnails()).toEqual({});
    await service.load(file);
    expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate a valid load when pruning another file', async () => {
    let resolveName!: (value: string) => void;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.returnValue(new Promise<string>(resolve => resolveName = resolve)) };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"A"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const fileA = { id: 1, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    service.setThumbnail(2, 'B');
    const loading = service.load(fileA);
    service.prune(new Set([1]));
    resolveName('ZmRr');
    await loading;

    expect(service.thumbnails()).toEqual({ 1: 'A' });
  });

  it('does not invalidate a valid retry when pruning another file', async () => {
    jasmine.clock().install();
    try {
      let attempts = 0;
      const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      const drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.callFake(() => {
          attempts++;
          return attempts === 1
            ? new Observable<Blob>(subscriber => subscriber.error(new HttpErrorResponse({ status: 400, error: 'upload incomplete' })))
            : of(new Blob(['header']));
        }),
      };
      const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"retry"}' }) };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
      const fileA = { id: 3, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

      await service.load(fileA);
      service.setThumbnail(4, 'B');
      service.prune(new Set([3]));
      jasmine.clock().tick(300);
      for (let i = 0; i < 10 && !service.thumbnails()[3]; i++) {
        await Promise.resolve();
      }

      expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
      expect(service.thumbnails()[3]).toBe('retry');
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('invalidates a stale load when its own file is pruned', async () => {
    let resolveName!: (value: string) => void;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.returnValue(new Promise<string>(resolve => resolveName = resolve)) };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"stale"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 5, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    const loading = service.load(file);
    service.prune(new Set());
    resolveName('ZmRr');
    await loading;

    expect(service.thumbnails()).toEqual({});
  });

  describe('prune selective lifecycle characterization', () => {
    it('removes a thumbnail-only candidate', () => {
      const service = createPruneService();
      service.setThumbnail(30, 'thumbnail');

      service.prune(new Set());

      expect(service.thumbnails()).toEqual({});
    });

    it('removes an in-flight-only candidate', () => {
      const service = createPruneService();
      const state = service as any;
      state.inFlight.set(31, Promise.resolve());

      service.prune(new Set());

      expect(state.inFlight.has(31)).toBeFalse();
    });

    it('removes a retry-timer-only candidate', () => {
      const service = createPruneService();
      const state = service as any;
      const timer = setTimeout(() => undefined, 60_000);
      state.retryTimers.set(32, timer);

      service.prune(new Set());

      expect(state.retryTimers.has(32)).toBeFalse();
      clearTimeout(timer);
    });

    it('removes a retry-count-only candidate', () => {
      const service = createPruneService();
      const state = service as any;
      state.retries.set(33, 2);

      service.prune(new Set());

      expect(state.retries.has(33)).toBeFalse();
    });

    it('removes a permanent-failure-only candidate', () => {
      const service = createPruneService();
      const state = service as any;
      state.permanentFailures.add(34);

      service.prune(new Set());

      expect(state.permanentFailures.has(34)).toBeFalse();
    });

    it('removes a file-generation-only candidate', () => {
      const service = createPruneService();
      const state = service as any;
      state.fileGenerations.set(35, 1);

      service.prune(new Set());

      expect(state.fileGenerations.has(35)).toBeFalse();
    });

    it('removes a candidate present in every lifecycle collection', () => {
      const service = createPruneService();
      const state = service as any;
      const timer = setTimeout(() => undefined, 60_000);
      state.inFlight.set(36, Promise.resolve());
      state.retryTimers.set(36, timer);
      state.retries.set(36, 1);
      state.permanentFailures.add(36);
      state.fileGenerations.set(36, 1);
      service.setThumbnail(36, 'thumbnail');

      service.prune(new Set());

      expect(state.inFlight.has(36)).toBeFalse();
      expect(state.retryTimers.has(36)).toBeFalse();
      expect(state.retries.has(36)).toBeFalse();
      expect(state.permanentFailures.has(36)).toBeFalse();
      expect(state.fileGenerations.has(36)).toBeFalse();
      expect(service.thumbnails()).toEqual({});
      clearTimeout(timer);
    });

    it('retains every lifecycle collection for a retained candidate', () => {
      const service = createPruneService();
      const state = service as any;
      const timer = 0 as ReturnType<typeof setTimeout>;
      state.inFlight.set(37, Promise.resolve());
      state.retryTimers.set(37, timer);
      state.retries.set(37, 1);
      state.permanentFailures.add(37);
      state.fileGenerations.set(37, 1);
      service.thumbnails.set({ 37: 'thumbnail' });

      service.prune(new Set([37]));

      expect(state.inFlight.has(37)).toBeTrue();
      expect(state.retryTimers.get(37)).toBe(timer);
      expect(state.retries.get(37)).toBe(1);
      expect(state.permanentFailures.has(37)).toBeTrue();
      expect(state.fileGenerations.get(37)).toBe(1);
      expect(service.thumbnails()).toEqual({ 37: 'thumbnail' });
    });

    it('clears a defined falsy timer handle when its file is removed', () => {
      const service = createPruneService();
      const state = service as any;
      const clearTimeoutSpy = spyOn(window, 'clearTimeout').and.callThrough();
      state.retryTimers.set(38, 0 as ReturnType<typeof setTimeout>);

      service.prune(new Set());

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(state.retryTimers.has(38)).toBeFalse();
    });

    it('preserves signal identity when only lifecycle state is removed', () => {
      const service = createPruneService();
      const state = service as any;
      service.setThumbnail(39, 'retained');
      const before = service.thumbnails();
      state.retries.set(40, 1);

      service.prune(new Set([39]));

      expect(service.thumbnails()).toBe(before);
      expect(service.thumbnails()).toEqual({ 39: 'retained' });
    });

    it('replaces the signal only when a thumbnail is removed', () => {
      const service = createPruneService();
      service.setThumbnail(41, 'remove');
      service.setThumbnail(42, 'retain');
      const before = service.thumbnails();

      service.prune(new Set([42]));

      expect(service.thumbnails()).not.toBe(before);
      expect(service.thumbnails()).toEqual({ 42: 'retain' });
    });

    it('keeps the caller retention set unchanged and is idempotent', () => {
      const service = createPruneService();
      service.setThumbnail(43, 'thumbnail');
      const retained = new Set([43]);
      const before = service.thumbnails();

      service.prune(retained);
      service.prune(retained);

      expect(retained).toEqual(new Set([43]));
      expect(service.thumbnails()).toBe(before);
    });

    it('does not resurrect a pruned retry', async () => {
      jasmine.clock().install();
      try {
        let attempts = 0;
        const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
        const drive = {
          downloadFileRange: jasmine.createSpy('downloadFileRange').and.callFake(() => {
            attempts++;
            return new Observable<Blob>(subscriber => subscriber.error(new HttpErrorResponse({ status: 400, error: 'upload incomplete' })));
          }),
        };
        const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata') };
        const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
        const file = createThumbnailFile(44);

        await service.load(file);
        service.prune(new Set());
        jasmine.clock().tick(1_000);
        await flushMicrotasks();

        expect(attempts).toBe(1);
        expect(service.thumbnails()).toEqual({});
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('keeps the global generation unchanged during selective pruning', () => {
      const service = createPruneService();
      const state = service as any;
      state.generation = 4;
      state.nextFileGeneration = 9;
      state.fileGenerations.set(45, 9);

      service.prune(new Set());

      expect(state.generation).toBe(4);
      expect(state.nextFileGeneration).toBe(9);
      expect(state.fileGenerations.has(45)).toBeFalse();
    });

    function createRacingService() {
      const names = [deferred<string>(), deferred<string>()];
      const metadata = [deferred<{ metadata: string }>(), deferred<{ metadata: string }>()];
      let nameIndex = 0;
      let metadataIndex = 0;
      const crypto = {
        decryptName: jasmine.createSpy('decryptName').and.callFake(() => names[nameIndex++].promise),
      };
      const drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))),
      };
      const kasumi = {
        extractMetadata: jasmine.createSpy('extractMetadata').and.callFake(() => metadata[metadataIndex++].promise),
      };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
      return { service, names, metadata, crypto, file: createThumbnailFile(46) };
    }

    it('allows a reloaded file to win when the old load completes first', async () => {
      const { service, names, metadata, crypto, file } = createRacingService();
      const oldLoad = service.load(file);
      names[0].resolve('ZmRr');
      await flushMicrotasks();
      const oldController = (service as any).controllers.get(file.id);
      service.prune(new Set());
      expect(oldController.signal.aborted).toBeTrue();
      const newLoad = service.load(file);
      const newController = (service as any).controllers.get(file.id);
      expect(newController).not.toBe(oldController);
      names[1].resolve('ZmRr');
      await flushMicrotasks();

      metadata[0].resolve({ metadata: '{"thumb":"old"}' });
      await oldLoad;
      expect((service as any).controllers.get(file.id)).toBe(newController);
      expect(newController.signal.aborted).toBeFalse();
      const deduplicated = service.load(file);
      expect(crypto.decryptName).toHaveBeenCalledTimes(2);
      metadata[1].resolve({ metadata: '{"thumb":"new"}' });
      await Promise.all([newLoad, deduplicated]);

      expect(service.thumbnails()[file.id]).toBe('new');
      expect((service as any).controllers.has(file.id)).toBeFalse();
      expect((service as any).inFlight.has(file.id)).toBeFalse();
    });

    it('allows a reloaded file to win when the new load completes first', async () => {
      const { service, names, metadata, file } = createRacingService();
      const oldLoad = service.load(file);
      names[0].resolve('ZmRr');
      await flushMicrotasks();
      const oldController = (service as any).controllers.get(file.id);
      service.prune(new Set());
      expect(oldController.signal.aborted).toBeTrue();
      const newLoad = service.load(file);
      const newController = (service as any).controllers.get(file.id);
      names[1].resolve('ZmRr');
      await flushMicrotasks();

      metadata[1].resolve({ metadata: '{"thumb":"new"}' });
      await newLoad;
      expect(newController.signal.aborted).toBeFalse();
      metadata[0].resolve({ metadata: '{"thumb":"old"}' });
      await oldLoad;

      expect(service.thumbnails()[file.id]).toBe('new');
      expect((service as any).controllers.has(file.id)).toBeFalse();
      expect((service as any).inFlight.has(file.id)).toBeFalse();
    });
  });

  it('deduplicates concurrent loads through the public load method', async () => {
    let resolveName!: (value: string) => void;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.returnValue(new Promise<string>(resolve => resolveName = resolve)) };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"shared"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 11, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    const first = service.load(file);
    const second = service.load(file);
    resolveName('ZmRr');
    await Promise.all([first, second]);

    expect(crypto.decryptName).toHaveBeenCalledTimes(1);
    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
    expect(kasumi.extractMetadata).toHaveBeenCalledTimes(1);
    expect(service.thumbnails()[11]).toBe('shared');
  });

  it('uses a direct Google Drive range request for Google-backed files', async () => {
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = {
      downloadExternalMetadata: jasmine.createSpy('downloadExternalMetadata').and.returnValue(of({
        external_file_id: 'external-file-id',
        access_token: 'test-access-token',
      })),
      downloadFileRange: jasmine.createSpy('downloadFileRange'),
    };
    const http = { get: jasmine.createSpy('get').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"google"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, http as any, kasumi as any);
    const file = { id: 12, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'google_drive', sizeBytes: 200_000 } as DriveFile;

    await service.load(file);

    expect(http.get).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/external-file-id?alt=media',
      jasmine.objectContaining({
        headers: { Range: 'bytes=0-131071', Authorization: 'Bearer test-access-token' },
        responseType: 'blob',
      }),
    );
    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(service.thumbnails()[12]).toBe('google');
  });

  it('does not fall back to local range when Google metadata resolves after invalidation', async () => {
    const metadata$ = new Subject<{ external_file_id: string; access_token: string }>();
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = {
      downloadExternalMetadata: jasmine.createSpy('downloadExternalMetadata').and.returnValue(metadata$),
      downloadFileRange: jasmine.createSpy('downloadFileRange'),
    };
    const http = { get: jasmine.createSpy('get') };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata') };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, http as any, kasumi as any);
    const file = { id: 24, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'google_drive', sizeBytes: 200_000 } as DriveFile;

    const loading = service.load(file);
    await flushMicrotasks();
    expect(drive.downloadExternalMetadata).toHaveBeenCalledTimes(1);

    service.clear();
    metadata$.next({ external_file_id: 'stale-google-file', access_token: 'test-access-token' });
    metadata$.complete();
    await loading;

    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(kasumi.extractMetadata).not.toHaveBeenCalled();
    expect(service.thumbnails()).toEqual({});
  });

  it('preserves the initial local range for large files', async () => {
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = { extractMetadata: jasmine.createSpy('extractMetadata').and.resolveTo({ metadata: '{"thumb":"large"}' }) };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 13, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 200_000 } as DriveFile;

    await service.load(file);

    expect(drive.downloadFileRange).toHaveBeenCalledWith(13, 0, 131071);
  });

  it('grows the metadata range after an incomplete blob', async () => {
    let attempts = 0;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = {
      extractMetadata: jasmine.createSpy('extractMetadata').and.callFake(async () => {
        attempts++;
        if (attempts === 1) throw new Error('partial blob');
        return { metadata: '{"thumb":"grown"}' };
      }),
    };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 14, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 2 * 1024 * 1024 } as DriveFile;

    await service.load(file);

    expect(drive.downloadFileRange).toHaveBeenCalledWith(14, 0, 131071);
    expect(drive.downloadFileRange).toHaveBeenCalledWith(14, 0, 1048575);
    expect(service.thumbnails()[14]).toBe('grown');
  });

  it('caps adaptive local ranges at the known file size', async () => {
    let attempts = 0;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = {
      extractMetadata: jasmine.createSpy('extractMetadata').and.callFake(async () => {
        attempts++;
        if (attempts === 1) throw new Error('metadata block incomplete');
        return { metadata: '{"thumb":"capped"}' };
      }),
    };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 15, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 200_000 } as DriveFile;

    await service.load(file);

    expect(drive.downloadFileRange).toHaveBeenCalledWith(15, 0, 131071);
    expect(drive.downloadFileRange).toHaveBeenCalledWith(15, 0, 199999);
    expect(drive.downloadFileRange.calls.allArgs().every(([, , end]) => end < file.sizeBytes)).toBeTrue();
  });

  it('does not retry permanent 404 or 416 failures', async () => {
    const statuses = [404, 416];
    let nextStatus = 0;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = {
      downloadFileRange: jasmine.createSpy('downloadFileRange').and.callFake(() =>
        throwError(() => new HttpErrorResponse({ status: statuses[nextStatus++] }))),
    };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, {} as any);

    for (const [index, status] of statuses.entries()) {
      const file = { id: 16 + index, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;
      await service.load(file);
      await service.load(file);
      expect(status).toBe(statuses[index]);
    }

    expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
  });

  it('retries incomplete-like 400 errors but permanently fails unrelated 400 errors', async () => {
    jasmine.clock().install();
    try {
      const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      const drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.callFake((fileId: number) =>
          fileId === 18
            ? throwError(() => new HttpErrorResponse({ status: 400, error: 'upload incomplete' }))
            : throwError(() => new HttpErrorResponse({ status: 400, error: 'invalid request' }))),
      };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, {} as any);
      const transient = { id: 18, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;
      const permanent = { id: 19, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

      await service.load(transient);
      jasmine.clock().tick(300);
      await flushMicrotasks();
      expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
      service.clear();

      await service.load(permanent);
      jasmine.clock().tick(300);
      await flushMicrotasks();
      expect(drive.downloadFileRange).toHaveBeenCalledTimes(3);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('retries network status 0 failures', async () => {
    jasmine.clock().install();
    try {
      const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      const drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(
          throwError(() => new HttpErrorResponse({ status: 0 })),
        ),
      };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, {} as any);
      const file = { id: 20, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

      await service.load(file);
      jasmine.clock().tick(300);
      await flushMicrotasks();

      expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('stops after the initial attempt and two transient retries', async () => {
    jasmine.clock().install();
    try {
      const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
      const drive = {
        downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(
          throwError(() => new HttpErrorResponse({ status: 0 })),
        ),
      };
      const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, {} as any);
      const file = { id: 21, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

      await service.load(file);
      jasmine.clock().tick(300);
      await flushMicrotasks();
      jasmine.clock().tick(600);
      await flushMicrotasks();
      await service.load(file);

      expect(drive.downloadFileRange).toHaveBeenCalledTimes(3);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('zeroizes the FDK after a successful metadata extraction', async () => {
    let capturedFdk!: Uint8Array;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = {
      extractMetadata: jasmine.createSpy('extractMetadata').and.callFake((_blob: Blob, fdk: Uint8Array) => {
        capturedFdk = fdk;
        return Promise.resolve({ metadata: '{"thumb":"wiped"}' });
      }),
    };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 22, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    await service.load(file);

    expect(Array.from(capturedFdk)).toEqual([0, 0, 0]);
  });

  it('zeroizes the FDK when metadata extraction fails', async () => {
    let capturedFdk!: Uint8Array;
    const crypto = { decryptName: jasmine.createSpy('decryptName').and.resolveTo('ZmRr') };
    const drive = { downloadFileRange: jasmine.createSpy('downloadFileRange').and.returnValue(of(new Blob(['header']))) };
    const kasumi = {
      extractMetadata: jasmine.createSpy('extractMetadata').and.callFake((_blob: Blob, fdk: Uint8Array) => {
        capturedFdk = fdk;
        return Promise.reject(new Error('invalid metadata'));
      }),
    };
    const service = new ThumbnailLoaderService(crypto as any, drive as any, {} as any, kasumi as any);
    const file = { id: 23, isFolder: false, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 10 } as DriveFile;

    await service.load(file);

    expect(Array.from(capturedFdk)).toEqual([0, 0, 0]);
  });
});
