import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, Subject, of, throwError } from 'rxjs';
import { DriveService } from '../services/drive.service';
import { DriveFile } from '../state/drive.store';
import { StorageTarget } from '../state/drive.types';
import { StorageMoveJob } from './storage-move.models';
import { StorageMoveEngineService } from './storage-move-engine.service';
import { NetworkDeadlineError } from '../upload/abortable-observable';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS, DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';

describe('StorageMoveEngineService', () => {
  let engine: StorageMoveEngineService;
  let driveService: jasmine.SpyObj<DriveService>;
  let httpTesting: HttpTestingController;

  const job = (status: StorageMoveJob['status'] = 'paused'): StorageMoveJob => ({
    id: 4, file_id: 9, status,
    source_provider: 'local', source_external_storage_id: null,
    target_provider: 'google_drive', target_external_storage_id: 7,
    total_bytes: 100, transferred_bytes: 40,
    is_retryable: status === 'paused',
    items: [{ id: 5, file_id: 9, role: 'original', total_bytes: 100, transferred_bytes: 40, status: status === 'cancelled' ? 'cancelled' : 'transferring' }],
  });
  const file: DriveFile = {
    id: 9, isFolder: false, encryptedName: 'cipher', decryptedName: 'arquivo.bin', type: 'unknown',
    sizeBytes: 100, sizeFormatted: '100 B', modifiedAt: '—', owner: 'eu',
    storageProvider: 'local', externalStorageId: null,
  };
  const target: StorageTarget = {
    key: 'google:7', provider: 'google_drive', label: 'Conta Google', externalStorageId: 7,
    usedBytes: 0, maxBytes: 1000, availableBytes: 1000, nanikaUsedBytes: 0, status: 'ready',
  };
  const localTarget: StorageTarget = {
    ...target, key: 'local', provider: 'local', label: 'Local', externalStorageId: null,
  };

  beforeEach(() => {
    driveService = jasmine.createSpyObj<DriveService>('DriveService', [
      'startStorageMove', 'getActiveStorageMoves', 'getStorageMove', 'pauseStorageMove',
      'resumeStorageMove', 'cancelStorageMove', 'getStorageMoveUploadedChunks',
      'downloadStorageMoveSourceRange', 'getStorageMoveSource', 'downloadExternalFileRange',
      'uploadStorageMoveChunk', 'createStorageMoveGoogleSession', 'reportStorageMoveProgress',
      'completeStorageMove', 'markStorageMoveTargetUploaded', 'reconcileStorageMove',
      'reportStorageMoveFailure', 'clearStorageMove',
    ]);
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [job()] }));
    driveService.startStorageMove.and.returnValue(of(job('prepared')));
    driveService.getStorageMove.and.returnValue(of(job('transferring')));
    driveService.resumeStorageMove.and.returnValue(of(job('transferring')));
    driveService.pauseStorageMove.and.returnValue(of(job('paused')));
    driveService.cancelStorageMove.and.returnValue(of(job('cancelled')));
    driveService.reconcileStorageMove.and.returnValue(of(job()));
    driveService.downloadStorageMoveSourceRange.and.returnValue(of(new Blob([new Uint8Array(100)])));
    driveService.createStorageMoveGoogleSession.and.returnValue(of({ session_uri: 'https://google.test/session', access_token: 'token' }));
    driveService.reportStorageMoveProgress.and.callFake((_moveId, _itemId, transferredBytes) => of({ ...job('transferring'), transferred_bytes: transferredBytes, items: [{ ...job('transferring').items[0], transferred_bytes: transferredBytes }] }));
    driveService.markStorageMoveTargetUploaded.and.callFake((_moveId, _itemId, targetExternalFileId) => of({ ...job('target_uploaded'), transferred_bytes: 100, items: [{ ...job('target_uploaded').items[0], transferred_bytes: 100, status: 'target_uploaded', target_external_file_id: targetExternalFileId }] }));
    driveService.completeStorageMove.and.returnValue(of({ ...job('completed'), transferred_bytes: 100, items: [{ ...job('completed').items[0], transferred_bytes: 100, status: 'completed' }] }));
    driveService.clearStorageMove.and.returnValue(of(undefined));

    TestBed.configureTestingModule({ providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      StorageMoveEngineService,
      { provide: DriveService, useValue: driveService },
    ] });
    engine = TestBed.inject(StorageMoveEngineService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  describe('B.94 bounded storage-move wait', () => {
    beforeEach(() => jasmine.clock().install());
    afterEach(() => jasmine.clock().uninstall());

    it('B.94 treats an expired Google PUT as ambiguous before outer retry', async () => {
      const item = job('transferring').items[0];
      (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'synthetic-token' });
      const controller = new AbortController();
      let result: unknown;
      const pending = (engine as any).retry(
        () => (engine as any).writeGoogleChunk(item, 0, 99, new Blob(['frame']), controller.signal), controller.signal,
      ).then((value: unknown) => { result = value; }, () => undefined);
      const put = httpTesting.expectOne('https://google.test/session');
      jasmine.clock().tick(300_000);
      await flushMicrotasks();
      expect(put.cancelled).toBeTrue();
      expect(result).toEqual({ kind: 'ambiguous' });
      httpTesting.expectNone('https://google.test/session');
      controller.abort();
      await pending;
    });

    it('B.94 gives a bounded source range its own finite deadline', async () => {
      const source = new Subject<Blob>();
      driveService.downloadStorageMoveSourceRange.and.returnValue(source);
      const controller = new AbortController();
      let error: Error | undefined;
      const pending = (engine as any).readRange(job('transferring'), job().items[0], 0, 99, controller.signal)
        .catch((value: Error) => { error = value; });
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(300_000);
      await flushMicrotasks();
      expect(source.observed).toBeFalse();
      expect(error?.name).toBe('NetworkDeadlineError');
      controller.abort();
      await pending;
    });

    it('B.94 expires a pause command and reconciles canonical state exactly once', async () => {
      const source = new Subject<StorageMoveJob>();
      driveService.pauseStorageMove.and.returnValue(source);
      driveService.getStorageMove.and.returnValue(of(job('paused')));
      let completed = false;
      const pending = engine.pause(4).then(() => { completed = true; });
      jasmine.clock().tick(30_000);
      await flushMicrotasks();
      expect(source.observed).toBeFalse();
      expect(completed).toBeTrue();
      expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
      source.next(job('paused'));
      source.complete();
      await pending;
    });

    it('B.94 reconciles a final PUT deadline once and acknowledges only the confirmed target', async () => {
      const moving = job('transferring');
      driveService.reconcileStorageMove.and.returnValue(of({
        ...job('target_uploaded'), transferred_bytes: 100,
        items: [{ ...moving.items[0], status: 'target_uploaded', target_external_file_id: 'confirmed-target', transferred_bytes: 100 }],
      }));
      const pending = (engine as any).transferToGoogle(moving, moving.items[0], new AbortController().signal);
      await flushMicrotasks();
      const put = httpTesting.expectOne('https://google.test/session');
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      await pending;
      expect(put.cancelled).toBeTrue();
      expect(driveService.reconcileStorageMove).toHaveBeenCalledOnceWith(4);
      expect(driveService.markStorageMoveTargetUploaded).toHaveBeenCalledOnceWith(4, 5, 'confirmed-target');
      expect(driveService.reportStorageMoveProgress).not.toHaveBeenCalled();
      httpTesting.expectNone('https://google.test/session');
    });

    it('B.94 persists an intermediate PUT deadline without retransmission or speculative progress', async () => {
      const moving = { ...job('transferring'), total_bytes: DRIVE_TRANSFER_CHUNK_SIZE + 1,
        items: [{ ...job().items[0], total_bytes: DRIVE_TRANSFER_CHUNK_SIZE + 1 }] };
      driveService.startStorageMove.and.returnValue(of(moving));
      driveService.getStorageMove.and.returnValue(of(moving));
      driveService.resumeStorageMove.and.returnValue(of(moving));
      driveService.reportStorageMoveFailure.and.returnValue(of({ ...moving, status: 'paused', is_retryable: true }));
      await engine.start(file, target);
      await flushMicrotasks(100);
      const put = httpTesting.expectOne('https://google.test/session');
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      await flushMicrotasks(100);
      expect(put.cancelled).toBeTrue();
      httpTesting.expectNone('https://google.test/session');
      expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
      expect(driveService.reportStorageMoveProgress).not.toHaveBeenCalled();
      expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
      expect(driveService.reportStorageMoveFailure).toHaveBeenCalledOnceWith(
        4, 'GOOGLE_TARGET_WRITE_FAILED', 'target_write', true, []);
      expect(engine.jobs()[0].status).toBe('paused');
    });

    it('B.94 exhausts only the existing safe-read retry budget', async () => {
      const sources: Subject<Blob>[] = [];
      driveService.downloadStorageMoveSourceRange.and.callFake(() => {
        const source = new Subject<Blob>();
        sources.push(source);
        return source;
      });
      const wait = spyOn(engine as any, 'wait').and.resolveTo();
      let error: unknown;
      const signal = new AbortController().signal;
      const pending = (engine as any).retry(() => (engine as any).readRange(job(), job().items[0], 0, 99, signal), signal)
        .catch((value: unknown) => { error = value; });
      for (let attempt = 0; attempt < 4; attempt++) {
        expect(sources[attempt].observed).toBeTrue();
        jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
        await flushMicrotasks();
        expect(sources[attempt].observed).toBeFalse();
      }
      await pending;
      expect(error).toBeInstanceOf(NetworkDeadlineError);
      expect((engine as any).isRetryableFailure(error)).toBeTrue();
      expect(driveService.downloadStorageMoveSourceRange).toHaveBeenCalledTimes(4);
      expect(wait).toHaveBeenCalledTimes(3);
    });

    it('B.94 retries an idempotent local chunk at the same item and index', async () => {
      const source = new Subject<{ transferred_bytes: number }>();
      driveService.getStorageMoveUploadedChunks.and.returnValue(of({ uploaded_chunks: [] }));
      driveService.uploadStorageMoveChunk.and.returnValues(source, of({ transferred_bytes: 100 }));
      spyOn(engine as any, 'wait').and.resolveTo();
      const local = { ...job('transferring'), target_provider: 'local' as const, target_external_storage_id: null };
      const pending = (engine as any).transferToLocal(local, local.items[0], new AbortController().signal);
      await flushMicrotasks();
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      await pending;
      expect(source.observed).toBeFalse();
      expect(driveService.uploadStorageMoveChunk).toHaveBeenCalledTimes(2);
      for (const args of driveService.uploadStorageMoveChunk.calls.allArgs()) {
        expect(args.slice(0, 3)).toEqual([4, 5, 0]);
      }
    });

    it('B.94 bounds Google source metadata before any range is attempted', async () => {
      const source = new Subject<any>();
      driveService.getStorageMoveSource.and.returnValue(source);
      const google = { ...job(), source_provider: 'google_drive' as const, source_external_storage_id: 8 };
      const pending = (engine as any).readRange(google, google.items[0], 0, 99, new AbortController().signal);
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(source.observed).toBeFalse();
      expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
    });

    it('B.94 leaves canonical progress unchanged after an ACK deadline', async () => {
      const source = new Subject<StorageMoveJob>();
      driveService.reportStorageMoveProgress.and.returnValue(source);
      (engine as any).upsertCanonical(job('transferring'));
      const pending = (engine as any).updateProgress(4, 5, 100, new AbortController().signal);
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      source.next({ ...job('transferring'), transferred_bytes: 100 });
      expect(source.observed).toBeFalse();
      expect(engine.jobs()[0].transferred_bytes).toBe(40);
    });

    it('B.94 retains irreversible target ownership when target ACK reaches its deadline', async () => {
      const ack = new Subject<StorageMoveJob>();
      driveService.markStorageMoveTargetUploaded.and.returnValue(ack);
      const moving = job('transferring');
      const pending = (engine as any).transferToGoogle(moving, moving.items[0], new AbortController().signal);
      await flushMicrotasks();
      httpTesting.expectOne('https://google.test/session').flush({ id: 'owned-target' });
      await flushMicrotasks();
      expect(ack.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(ack.observed).toBeFalse();
      expect((engine as any).targetFileIds.get(5)).toBe('owned-target');
      expect(driveService.markStorageMoveTargetUploaded).toHaveBeenCalledTimes(1);
      httpTesting.expectNone('https://google.test/session');
    });

    it('B.94 bounds final reconciliation without claiming an unconfirmed target', async () => {
      const source = new Subject<StorageMoveJob>();
      driveService.reconcileStorageMove.and.returnValue(source);
      const moving = job('transferring');
      const pending = (engine as any).transferToGoogle(moving, moving.items[0], new AbortController().signal);
      await flushMicrotasks();
      httpTesting.expectOne('https://google.test/session');
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      await flushMicrotasks();
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(source.observed).toBeFalse();
      expect((engine as any).targetFileIds.has(5)).toBeFalse();
      expect(driveService.reconcileStorageMove).toHaveBeenCalledOnceWith(4);
      expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
      httpTesting.expectNone('https://google.test/session');
    });

    it('B.94 keeps owner abort distinct from write ambiguity', async () => {
      const item = job().items[0];
      (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'synthetic-token' });
      const controller = new AbortController();
      const pending = (engine as any).retry(
        () => (engine as any).writeGoogleChunk(item, 0, 99, new Blob(['frame']), controller.signal), controller.signal);
      const put = httpTesting.expectOne('https://google.test/session');
      controller.abort();
      await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      expect(put.cancelled).toBeTrue();
      httpTesting.expectNone('https://google.test/session');
    });
  });

  it('restores paused jobs with decrypted labels without moving bytes', async () => {
    await engine.loadActive([target], [file]);

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      fileName: 'arquivo.bin', sourceLabel: 'Local', targetLabel: 'Conta Google', status: 'paused',
    }));
    expect(engine.activeFileIds().has(9)).toBeTrue();
    expect(driveService.getStorageMove).not.toHaveBeenCalled();
    expect(driveService.reconcileStorageMove).toHaveBeenCalledOnceWith(4);
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
  });

  it('preserves the current start contract when no lifecycle boundary wins', async () => {
    const prepared: StorageMoveJob = { ...job('prepared'), target_provider: 'local', target_external_storage_id: null };
    driveService.startStorageMove.and.returnValue(of(prepared));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await expectAsync(engine.start(file, localTarget))
      .toBeResolvedTo(prepared);

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      fileName: 'arquivo.bin', sourceLabel: 'Local', targetLabel: 'Local', status: 'prepared',
    }));
    expect(runSpy).toHaveBeenCalledOnceWith(prepared.id);
  });

  it('does not resurrect a started move when reset wins before the start response', async () => {
    const pending = new Subject<StorageMoveJob>();
    const prepared: StorageMoveJob = { ...job('prepared'), target_provider: 'local', target_external_storage_id: null };
    driveService.startStorageMove.and.returnValue(pending);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const startPromise = engine.start(file, localTarget);
    await flushMicrotasks();
    engine.resetRuntimeState();
    pending.next(prepared);
    pending.complete();

    await expectAsync(startPromise).toBeResolvedTo(prepared);
    expect(engine.jobs()).toEqual([]);
    expect((engine as any).names.size).toBe(0);
    expect((engine as any).labels.size).toBe(0);
    expect((engine as any).controllers.size).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not restore a decrypted filename when presentation data is cleared during start', async () => {
    const pending = new Subject<StorageMoveJob>();
    const prepared: StorageMoveJob = { ...job('prepared'), target_provider: 'local', target_external_storage_id: null };
    driveService.startStorageMove.and.returnValue(pending);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const startPromise = engine.start(file, localTarget);
    await flushMicrotasks();
    engine.clearDecryptedPresentationData();
    pending.next(prepared);
    pending.complete();

    await expectAsync(startPromise).toBeResolvedTo(prepared);
    expect(engine.jobs()).toHaveSize(1);
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      fileName: 'Arquivo 9', sourceLabel: 'Local', targetLabel: 'Local', status: 'prepared',
    }));
    expect((engine as any).names.has(prepared.id)).toBeFalse();
    expect(runSpy).toHaveBeenCalledOnceWith(prepared.id);
  });

  it('does not repopulate active moves when reset wins during the initial active-move GET', async () => {
    const pending = new Subject<{ moves: StorageMoveJob[] }>();
    const pausedLocal: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null };
    driveService.getActiveStorageMoves.and.returnValue(pending);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const loading = engine.loadActive([target], [file]);
    await flushMicrotasks();
    engine.resetRuntimeState();
    pending.next({ moves: [pausedLocal] });
    pending.complete();
    await loading;

    expect(engine.jobs()).toEqual([]);
    expect((engine as any).names.size).toBe(0);
    expect((engine as any).labels.size).toBe(0);
    expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not mark a newer runtime stateSyncError when an older active-move GET fails', async () => {
    const older = new Subject<{ moves: StorageMoveJob[] }>();
    const newer: StorageMoveJob = { ...job('paused'), id: 8, file_id: 10, target_provider: 'local', target_external_storage_id: null };
    let getCall = 0;
    driveService.getActiveStorageMoves.and.callFake(() => getCall++ === 0 ? older : of({ moves: [newer] }));

    const olderLoad = engine.loadActive([target], [file]);
    await flushMicrotasks();
    engine.resetRuntimeState();
    await engine.loadActive([target], [file]);

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ id: newer.id, status: 'paused', stateSyncError: false }));
    older.error(new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }));
    await olderLoad;

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ id: newer.id, status: 'paused', stateSyncError: false }));
    expect(engine.jobs()[0].speedBytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(engine.jobs()[0].etaSeconds).toBeNull();
  });

  it('does not restore decrypted filenames when presentation data is cleared during active-move GET', async () => {
    const pending = new Subject<{ moves: StorageMoveJob[] }>();
    const pausedLocal: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null };
    driveService.getActiveStorageMoves.and.returnValue(pending);

    const loading = engine.loadActive([target], [file]);
    await flushMicrotasks();
    engine.clearDecryptedPresentationData();
    pending.next({ moves: [pausedLocal] });
    pending.complete();
    await loading;

    expect(engine.jobs()).toHaveSize(1);
    expect(engine.jobs()[0].fileName).toBe('Arquivo 9');
    expect((engine as any).names.has(pausedLocal.id)).toBeFalse();
    expect(engine.jobs()[0].status).toBe('paused');
  });

  it('does not resurrect a Google move when reset wins during active-move reconciliation', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const pausedGoogle: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [pausedGoogle] }));
    driveService.reconcileStorageMove.and.returnValue(reconciliation);

    const loading = engine.loadActive([target], [file]);
    await flushMicrotasks();
    expect(driveService.reconcileStorageMove).toHaveBeenCalledOnceWith(pausedGoogle.id);
    engine.resetRuntimeState();
    reconciliation.next({ ...pausedGoogle, status: 'target_uploaded' });
    reconciliation.complete();
    await loading;

    expect(engine.jobs()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not resurrect or mark stateSyncError after reset wins during Google reconciliation', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const pausedGoogle: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [pausedGoogle] }));
    driveService.reconcileStorageMove.and.returnValue(reconciliation);

    const loading = engine.loadActive([target], [file]);
    await flushMicrotasks();
    engine.resetRuntimeState();
    reconciliation.error(new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }));
    await loading;

    expect(engine.jobs()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('keeps the newer post-reset active-move result when the older load completes last', async () => {
    const older = new Subject<{ moves: StorageMoveJob[] }>();
    const newer: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null };
    const stale: StorageMoveJob = { ...job('transferring'), target_provider: 'local', target_external_storage_id: null };
    let getCall = 0;
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getActiveStorageMoves.and.callFake(() => getCall++ === 0 ? older : of({ moves: [newer] }));

    const olderLoad = engine.loadActive([target], [file]);
    await flushMicrotasks();
    engine.resetRuntimeState();
    await engine.loadActive([target], [file]);
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused' }));

    older.next({ moves: [stale] });
    older.complete();
    await olderLoad;

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ id: newer.id, status: 'paused', stateSyncError: false }));
    expect(runSpy).not.toHaveBeenCalled();
    expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
  });

  it('keeps successful Cancel on one DELETE without canonical recovery', async () => {
    const current = job('transferring');
    const cancelled: StorageMoveJob = {
      ...current, status: 'cancelled', items: [{ ...current.items[0], status: 'cancelled' }],
    };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(of(cancelled));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(driveService.cancelStorageMove).toHaveBeenCalledOnceWith(current.id, [{
      item_id: current.items[0].id,
      target_external_file_id: 'target-123',
    }]);
    expect(driveService.getStorageMove).not.toHaveBeenCalled();
    expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
    expect(engine.jobs()[0].status).toBe('cancelled');
    expect((engine as any).targetFileIds.has(current.items[0].id)).toBeFalse();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not publish a late Cancel success after reset wins', async () => {
    const pending = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const cancelled: StorageMoveJob = { ...current, status: 'cancelled' };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(pending);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(current.id);
    await flushMicrotasks();
    engine.resetRuntimeState();
    pending.next(cancelled);
    pending.complete();

    await cancellation;
    expect(engine.jobs()).toEqual([]);
    expect((engine as any).targetFileIds.size).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('silently finishes a Cancel error after reset without issuing recovery GET', async () => {
    const cancelError = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    const pending = new Subject<StorageMoveJob>();
    (engine as any).upsertCanonical(job('transferring'));
    driveService.cancelStorageMove.and.returnValue(pending);

    const cancellation = engine.cancel(4);
    await flushMicrotasks();
    engine.resetRuntimeState();
    pending.error(cancelError);

    await expectAsync(cancellation).toBeResolved();
    expect(driveService.getStorageMove).not.toHaveBeenCalled();
    expect(engine.jobs()).toEqual([]);
  });

  it('converges a rejected Cancel to canonical cancelled without retrying DELETE', async () => {
    const current = job('transferring');
    const cancelled: StorageMoveJob = { ...current, status: 'cancelled' };
    const cancelError = new HttpErrorResponse({ status: 409, statusText: 'Conflict' });
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => cancelError));
    driveService.getStorageMove.and.returnValue(of(cancelled));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(driveService.cancelStorageMove).toHaveBeenCalledOnceWith(current.id, [{
      item_id: current.items[0].id,
      target_external_file_id: 'target-123',
    }]);
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(current.id);
    expect(engine.jobs()[0].status).toBe('cancelled');
    expect((engine as any).targetFileIds.size).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('publishes canonical completed after a rejected Cancel without guessing cancelled', async () => {
    const current = job('transferring');
    const completed: StorageMoveJob = { ...current, status: 'completed', transferred_bytes: 100 };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(completed));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('completed');
    expect((engine as any).targetFileIds.size).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('recovers cleanup_pending through the existing real cleanup runner', async () => {
    const current = job('transferring');
    const cleanupPending: StorageMoveJob = { ...current, status: 'cleanup_pending' };
    const completed: StorageMoveJob = { ...current, status: 'completed', transferred_bytes: 100 };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValues(of(cleanupPending), of(cleanupPending));
    driveService.completeStorageMove.and.returnValue(of(completed));

    await engine.cancel(current.id);
    await flushMicrotasks(60);

    expect(engine.jobs()[0].status).toBe('completed');
    expect(driveService.completeStorageMove).toHaveBeenCalledOnceWith(current.id);
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.createStorageMoveGoogleSession).not.toHaveBeenCalled();
    expect((engine as any).targetFileIds.size).toBe(0);
  });

  it('keeps canonical paused after a rejected Cancel without auto-resuming', async () => {
    const current = job('transferring');
    const paused: StorageMoveJob = { ...current, status: 'paused', is_retryable: false };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(paused));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('paused');
    expect((engine as any).targetFileIds.get(current.items[0].id)).toBe('target-123');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('keeps canonical failed after a rejected Cancel without auto-resuming', async () => {
    const current = job('transferring');
    const failed: StorageMoveJob = { ...current, status: 'failed', is_retryable: true };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(failed));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('failed');
    expect((engine as any).targetFileIds.get(current.items[0].id)).toBe('target-123');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('publishes canonical committing after a rejected Cancel without calling run', async () => {
    const current = job('transferring');
    const committing: StorageMoveJob = { ...current, status: 'committing' };
    (engine as any).upsertCanonical(current);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(committing));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('committing');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('restores a local prepared runner after a rejected Cancel', async () => {
    const current: StorageMoveJob = { ...job('prepared'), target_provider: 'local', target_external_storage_id: null };
    (engine as any).upsertCanonical(current);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(current));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('prepared');
    expect(runSpy).toHaveBeenCalledOnceWith(current.id);
  });

  it('restores a local transferring runner after a rejected Cancel', async () => {
    const current: StorageMoveJob = { ...job('transferring'), target_provider: 'local', target_external_storage_id: null };
    (engine as any).upsertCanonical(current);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(current));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].status).toBe('transferring');
    expect(runSpy).toHaveBeenCalledOnceWith(current.id);
  });

  it('reconciles a known Google target before restoring transferring execution', async () => {
    const current = job('transferring');
    const reconciled: StorageMoveJob = {
      ...current, status: 'target_uploaded', transferred_bytes: 100,
      items: [{ ...current.items[0], status: 'target_uploaded', transferred_bytes: 100, target_external_file_id: 'target-123' }],
    };
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(current));
    driveService.reconcileStorageMove.and.returnValue(of(reconciled));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(driveService.reconcileStorageMove).toHaveBeenCalledOnceWith(current.id);
    expect(engine.jobs()[0].status).toBe('target_uploaded');
    expect(runSpy).toHaveBeenCalledOnceWith(current.id);
    expect(driveService.createStorageMoveGoogleSession).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
  });

  it('fails closed when Google reconciliation fails after a rejected Cancel', async () => {
    const current = job('transferring');
    const reconcileError = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(of(current));
    driveService.reconcileStorageMove.and.returnValue(throwError(() => reconcileError));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.cancel(current.id);

    expect(engine.jobs()[0].stateSyncError).toBeTrue();
    expect((engine as any).targetFileIds.get(current.items[0].id)).toBe('target-123');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('preserves the original Cancel error when canonical recovery also fails', async () => {
    const current = job('transferring');
    const cancelError = new HttpErrorResponse({ status: 409, statusText: 'Conflict' });
    const stateError = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => cancelError));
    driveService.getStorageMove.and.returnValue(throwError(() => stateError));

    let caught: unknown;
    try {
      await engine.cancel(current.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(cancelError);
    expect(engine.jobs()[0].stateSyncError).toBeTrue();
    expect((engine as any).targetFileIds.get(current.items[0].id)).toBe('target-123');
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(current.id);
  });

  it('does not publish a stale Cancel recovery after reset wins during GET', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const cancelError = new HttpErrorResponse({ status: 409 });
    (engine as any).upsertCanonical(current);
    driveService.cancelStorageMove.and.returnValue(throwError(() => cancelError));
    driveService.getStorageMove.and.returnValue(recovery);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(current.id);
    await flushMicrotasks();
    engine.resetRuntimeState();
    recovery.next({ ...current, status: 'cancelled' });
    recovery.complete();

    await cancellation;
    expect(engine.jobs()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not publish a stale Cancel recovery after reset wins during Google reconciliation', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const cancelError = new HttpErrorResponse({ status: 409 });
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => cancelError));
    driveService.getStorageMove.and.returnValue(of(current));
    driveService.reconcileStorageMove.and.returnValue(reconciliation);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(current.id);
    await flushMicrotasks();
    engine.resetRuntimeState();
    reconciliation.next({ ...current, status: 'target_uploaded' });
    reconciliation.complete();

    await cancellation;
    expect(engine.jobs()).toEqual([]);
    expect((engine as any).targetFileIds.size).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('keeps a newer Cancel owner after an older Cancel completes', async () => {
    const first = new Subject<StorageMoveJob>();
    const second = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const firstResult: StorageMoveJob = { ...current, status: 'cancelled' };
    const secondResult: StorageMoveJob = { ...current, status: 'completed' };
    let calls = 0;
    (engine as any).upsertCanonical(current);
    (engine as any).targetFileIds.set(current.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.callFake(() => calls++ === 0 ? first : second);
    const firstCancel = engine.cancel(current.id);
    await flushMicrotasks();
    const secondCancel = engine.cancel(current.id);
    await flushMicrotasks();

    first.next(firstResult);
    first.complete();
    await firstCancel;
    expect(engine.jobs()[0].status).toBe('transferring');
    expect((engine as any).targetFileIds.get(current.items[0].id)).toBe('target-123');
    await engine.resume(current.id);
    expect(driveService.getStorageMove).not.toHaveBeenCalled();

    second.next(secondResult);
    second.complete();
    await secondCancel;
    expect(engine.jobs()[0].status).toBe('completed');
    expect((engine as any).targetFileIds.size).toBe(0);
  });

  it('keeps Resume suppressed during Cancel canonical recovery', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const current = job('transferring');
    (engine as any).upsertCanonical(current);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(recovery);

    const cancellation = engine.cancel(current.id);
    await flushMicrotasks();
    await engine.resume(current.id);
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(current.id);
    recovery.next({ ...current, status: 'paused' });
    recovery.complete();
    await cancellation;
  });

  it('does not let a Pause started during Cancel overwrite canonical cancelled', async () => {
    const cancelResponse = new Subject<StorageMoveJob>();
    const pauseResponse = new Subject<StorageMoveJob>();
    const transferring = job('transferring');
    const paused: StorageMoveJob = { ...transferring, status: 'paused', is_retryable: false };
    const cancelled: StorageMoveJob = { ...transferring, status: 'cancelled' };
    (engine as any).upsertCanonical(transferring);
    driveService.cancelStorageMove.and.returnValue(cancelResponse);
    driveService.pauseStorageMove.and.returnValue(pauseResponse);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(transferring.id);
    await flushMicrotasks();
    const pausing = engine.pause(transferring.id);
    await flushMicrotasks();

    cancelResponse.next(cancelled);
    cancelResponse.complete();
    await cancellation;
    expect(engine.jobs()[0].status).toBe('cancelled');

    pauseResponse.next(paused);
    pauseResponse.complete();
    await pausing;

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not let a Pause started during rejected-Cancel recovery overwrite canonical cancelled', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const pauseResponse = new Subject<StorageMoveJob>();
    const transferring = job('transferring');
    const paused: StorageMoveJob = { ...transferring, status: 'paused', is_retryable: false };
    const cancelled: StorageMoveJob = { ...transferring, status: 'cancelled' };
    (engine as any).upsertCanonical(transferring);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(recovery);
    driveService.pauseStorageMove.and.returnValue(pauseResponse);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(transferring.id);
    await flushMicrotasks();
    const pausing = engine.pause(transferring.id);
    await flushMicrotasks();

    recovery.next(cancelled);
    recovery.complete();
    await cancellation;
    expect(engine.jobs()[0].status).toBe('cancelled');

    pauseResponse.next(paused);
    pauseResponse.complete();
    await pausing;

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not let a Pause started during Cancel overwrite canonical completed', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const pauseResponse = new Subject<StorageMoveJob>();
    const transferring = job('transferring');
    const paused: StorageMoveJob = { ...transferring, status: 'paused', is_retryable: false };
    const completed: StorageMoveJob = { ...transferring, status: 'completed' };
    (engine as any).upsertCanonical(transferring);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(recovery);
    driveService.pauseStorageMove.and.returnValue(pauseResponse);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(transferring.id);
    await flushMicrotasks();
    const pausing = engine.pause(transferring.id);
    await flushMicrotasks();

    recovery.next(completed);
    recovery.complete();
    await cancellation;
    expect(engine.jobs()[0].status).toBe('completed');

    pauseResponse.next(paused);
    pauseResponse.complete();
    await pausing;

    expect(engine.jobs()[0].status).toBe('completed');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs direct target_uploaded recovery without retransmitting media', async () => {
    const targetUploaded: StorageMoveJob = {
      ...job('target_uploaded'),
      transferred_bytes: 100,
      items: [{ ...job('target_uploaded').items[0], status: 'target_uploaded', transferred_bytes: 100, target_external_file_id: 'target-123' }],
    };
    const completed: StorageMoveJob = {
      ...targetUploaded,
      status: 'completed',
      items: [{ ...targetUploaded.items[0], status: 'completed' }],
    };
    (engine as any).upsertCanonical(targetUploaded);
    (engine as any).targetFileIds.set(targetUploaded.items[0].id, 'target-123');
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValues(of(targetUploaded), of(targetUploaded));
    driveService.completeStorageMove.and.returnValue(of(completed));

    await engine.cancel(targetUploaded.id);
    await flushMicrotasks(100);

    expect(engine.jobs()[0].status).toBe('completed');
    expect(driveService.completeStorageMove).toHaveBeenCalledOnceWith(targetUploaded.id);
    expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
    expect(driveService.createStorageMoveGoogleSession).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
    expect(driveService.uploadStorageMoveChunk).not.toHaveBeenCalled();
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
    expect((engine as any).targetFileIds.has(targetUploaded.items[0].id)).toBeFalse();
  });

  it('preserves a valid Pause after rejected Cancel remains nonterminal', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const pauseResponse = new Subject<StorageMoveJob>();
    const transferring = { ...job('transferring'), target_provider: 'local' as const, target_external_storage_id: null };
    const paused: StorageMoveJob = { ...transferring, status: 'paused', is_retryable: false };
    (engine as any).upsertCanonical(transferring);
    driveService.cancelStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(recovery);
    driveService.pauseStorageMove.and.returnValue(pauseResponse);
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const cancellation = engine.cancel(transferring.id);
    await flushMicrotasks();
    const pausing = engine.pause(transferring.id);
    await flushMicrotasks();

    recovery.next(transferring);
    recovery.complete();
    await cancellation;
    pauseResponse.next(paused);
    pauseResponse.complete();
    await pausing;

    expect(engine.jobs()[0].status).toBe('paused');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(runSpy).toHaveBeenCalledOnceWith(transferring.id);
  });

  it('does not publish an initial run GET after reset wins before the await continuation', async () => {
    const initial = new Subject<StorageMoveJob>();
    const transferring: StorageMoveJob = {
      ...job('transferring'), target_provider: 'local', target_external_storage_id: null,
    };
    driveService.getStorageMove.and.returnValue(initial);

    const oldRun = (engine as any).run(4) as Promise<void>;
    expect((engine as any).controllers.get(4)).toBeDefined();
    initial.next(transferring);
    initial.complete();
    engine.resetRuntimeState();

    await oldRun;
    await flushMicrotasks();

    expect(engine.jobs()).toEqual([]);
    expect((engine as any).controllers.size).toBe(0);
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.uploadStorageMoveChunk).not.toHaveBeenCalled();
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
    expect(driveService.reportStorageMoveFailure).not.toHaveBeenCalled();
  });

  it('does not let an obsolete run finalizer clear a newer runner transient state', async () => {
    const initial = new Subject<StorageMoveJob>();
    const stale: StorageMoveJob = {
      ...job('transferring'), target_provider: 'local', target_external_storage_id: null,
    };
    const newer: StorageMoveJob = {
      ...job('paused'), target_provider: 'local', target_external_storage_id: null,
    };
    driveService.getStorageMove.and.returnValue(initial);

    const oldRun = (engine as any).run(4) as Promise<void>;
    const oldController = (engine as any).controllers.get(4) as AbortController;
    initial.next(stale);
    initial.complete();
    engine.resetRuntimeState();

    const newController = new AbortController();
    const newSession = { uri: 'new-session', token: 'new-token' };
    const newMetadata = { externalFileId: 'new-source', accessToken: 'new-access-token' };
    (engine as any).controllers.set(4, newController);
    (engine as any).upsertCanonical(newer);
    (engine as any).sessions.set(5, newSession);
    (engine as any).sourceMetadata.set(5, newMetadata);
    (engine as any).startedAt.set(4, { time: 123, bytes: 40 });
    (engine as any).stages.set(4, 'target_write');
    (engine as any).validatingMoveIds.add(4);

    await oldRun;

    expect(oldController.signal.aborted).toBeTrue();
    expect((engine as any).controllers.get(4)).toBe(newController);
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused' }));
    expect((engine as any).sessions.get(5)).toBe(newSession);
    expect((engine as any).sourceMetadata.get(5)).toBe(newMetadata);
    expect((engine as any).startedAt.get(4)).toEqual({ time: 123, bytes: 40 });
    expect((engine as any).stages.get(4)).toBe('target_write');
    expect((engine as any).validatingMoveIds.has(4)).toBeTrue();
  });

  it('does not publish a settled Resume response after reset wins', async () => {
    const resumeResponse = new Subject<StorageMoveJob>();
    const prepared: StorageMoveJob = {
      ...job('prepared'), target_provider: 'local', target_external_storage_id: null,
    };
    const resumed: StorageMoveJob = {
      ...prepared, status: 'transferring', is_retryable: true,
    };
    driveService.getStorageMove.and.returnValue(of(prepared));
    driveService.resumeStorageMove.and.returnValue(resumeResponse);

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    expect(driveService.resumeStorageMove).toHaveBeenCalledOnceWith(4);
    resumeResponse.next(resumed);
    resumeResponse.complete();
    engine.resetRuntimeState();

    await oldRun;
    expect(engine.jobs()).toEqual([]);
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
    expect(driveService.reportStorageMoveFailure).not.toHaveBeenCalled();
  });

  it('does not publish a settled completion response after reset wins', async () => {
    const completion = new Subject<StorageMoveJob>();
    const targetUploaded: StorageMoveJob = {
      ...job('target_uploaded'), target_provider: 'local', target_external_storage_id: null,
      transferred_bytes: 100,
      items: [{ ...job('target_uploaded').items[0], status: 'target_uploaded', transferred_bytes: 100 }],
    };
    const completed: StorageMoveJob = {
      ...targetUploaded, status: 'completed',
      items: [{ ...targetUploaded.items[0], status: 'completed' }],
    };
    driveService.getStorageMove.and.returnValue(of(targetUploaded));
    driveService.completeStorageMove.and.returnValue(completion);

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    expect(driveService.completeStorageMove).toHaveBeenCalledOnceWith(4);
    completion.next(completed);
    completion.complete();
    engine.resetRuntimeState();

    await oldRun;
    expect(engine.jobs()).toEqual([]);
    expect(driveService.reportStorageMoveFailure).not.toHaveBeenCalled();
  });

  it('does not enter cleanup after a settled cleanup response loses ownership', async () => {
    const completion = new Subject<StorageMoveJob>();
    const cleanupPending: StorageMoveJob = {
      ...job('cleanup_pending'), target_provider: 'local', target_external_storage_id: null,
      transferred_bytes: 100,
    };
    const completed: StorageMoveJob = { ...cleanupPending, status: 'completed' };
    driveService.getStorageMove.and.returnValue(of(cleanupPending));
    driveService.completeStorageMove.and.returnValue(completion);

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    completion.next(completed);
    completion.complete();
    engine.resetRuntimeState();

    await oldRun;
    expect(engine.jobs()).toEqual([]);
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
  });

  it('does not publish a settled cleanup GET after reset wins', async () => {
    const cleanupState = new Subject<StorageMoveJob>();
    const cleanupPending: StorageMoveJob = {
      ...job('cleanup_pending'), target_provider: 'local', target_external_storage_id: null,
      transferred_bytes: 100,
    };
    const completed: StorageMoveJob = { ...cleanupPending, status: 'completed' };
    let getCalls = 0;
    spyOn(engine as any, 'wait').and.resolveTo();
    driveService.getStorageMove.and.callFake(() => getCalls++ === 0 ? of(cleanupPending) : cleanupState);
    driveService.completeStorageMove.and.returnValue(of(cleanupPending));

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    expect(getCalls).toBe(2);
    cleanupState.next(completed);
    cleanupState.complete();
    engine.resetRuntimeState();

    await oldRun;
    expect(engine.jobs()).toEqual([]);
  });

  it('does not publish stale progress after reset wins before its continuation', async () => {
    const progress = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const updated = { ...current, transferred_bytes: 100 };
    const controller = new AbortController();
    (engine as any).upsertCanonical(current);
    (engine as any).controllers.set(4, controller);
    driveService.reportStorageMoveProgress.and.returnValue(progress);

    const pending = (engine as any).updateProgress(4, 5, 100, controller.signal) as Promise<void>;
    await flushMicrotasks();
    progress.next(updated);
    progress.complete();
    engine.resetRuntimeState();

    await expectAsync(pending).toBeRejected();
    expect(engine.jobs()).toEqual([]);
  });

  it('does not publish a stale Local target ACK after reset wins', async () => {
    const acknowledgment = new Subject<StorageMoveJob>();
    const local: StorageMoveJob = {
      ...job('transferring'), target_provider: 'local', target_external_storage_id: null,
    };
    const uploaded: StorageMoveJob = {
      ...local, status: 'target_uploaded', transferred_bytes: 100,
      items: [{ ...local.items[0], status: 'target_uploaded', transferred_bytes: 100 }],
    };
    const controller = new AbortController();
    (engine as any).controllers.set(4, controller);
    driveService.getStorageMoveUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    driveService.reportStorageMoveProgress.and.returnValue(of(local));
    driveService.markStorageMoveTargetUploaded.and.returnValue(acknowledgment);

    const pending = (engine as any).transferToLocal(local, local.items[0], controller.signal) as Promise<void>;
    await flushMicrotasks();
    expect(driveService.markStorageMoveTargetUploaded).toHaveBeenCalledOnceWith(4, 5);
    acknowledgment.next(uploaded);
    acknowledgment.complete();
    engine.resetRuntimeState();

    await expectAsync(pending).toBeRejected();
    expect(engine.jobs()).toEqual([]);
  });

  it('does not let an old Google session response overwrite a newer session', async () => {
    const session = new Subject<{ session_uri: string; access_token: string }>();
    const google: StorageMoveJob = job('transferring');
    const controller = new AbortController();
    (engine as any).controllers.set(4, controller);
    driveService.createStorageMoveGoogleSession.and.returnValue(session);

    const pending = (engine as any).transferToGoogle(google, google.items[0], controller.signal) as Promise<void>;
    await flushMicrotasks();
    session.next({ session_uri: 'old-session', access_token: 'old-token' });
    session.complete();
    engine.resetRuntimeState();
    const newSession = { uri: 'new-session', token: 'new-token' };
    (engine as any).sessions.set(5, newSession);

    await expectAsync(pending).toBeRejected();
    expect((engine as any).sessions.get(5)).toBe(newSession);
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
  });

  it('does not let an obsolete Google transfer finalizer delete a newer session', async () => {
    const google = job('transferring');
    const controller = new AbortController();
    let rejectOldRead!: (error: unknown) => void;
    (engine as any).controllers.set(4, controller);
    driveService.createStorageMoveGoogleSession.and.returnValue(
      of({ session_uri: 'old-session', access_token: 'old-token' }));
    spyOn<any>(engine, 'readRange').and.returnValue(new Promise<Blob>((_, reject) => {
      rejectOldRead = reject;
    }));

    const pending = (engine as any).transferToGoogle(google, google.items[0], controller.signal) as Promise<void>;
    await flushMicrotasks();
    expect((engine as any).sessions.get(5)?.uri).toBe('old-session');

    engine.resetRuntimeState();
    const newSession = { uri: 'new-session', token: 'new-token' };
    (engine as any).sessions.set(5, newSession);
    rejectOldRead(new DOMException('Aborted', 'AbortError'));

    await expectAsync(pending).toBeRejected();
    expect((engine as any).sessions.get(5)).toBe(newSession);
  });

  it('does not let a completed stale cleanup drop newer target ownership', async () => {
    const cleanupPending: StorageMoveJob = {
      ...job('cleanup_pending'), target_provider: 'local', target_external_storage_id: null,
    };
    const completed: StorageMoveJob = { ...cleanupPending, status: 'completed' };
    let resolveCleanup!: (value: StorageMoveJob) => void;
    driveService.getStorageMove.and.returnValue(of(cleanupPending));
    spyOn<any>(engine, 'finishCleanup').and.returnValue(new Promise<StorageMoveJob>(resolve => {
      resolveCleanup = resolve;
    }));

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    expect((engine as any).finishCleanup).toHaveBeenCalledOnceWith(4, jasmine.any(AbortSignal));
    resolveCleanup(completed);

    engine.resetRuntimeState();
    const newer: StorageMoveJob = {
      ...job('paused'), target_provider: 'google_drive', target_external_storage_id: 7,
    };
    (engine as any).upsertCanonical(newer);
    (engine as any).targetFileIds.set(5, 'new-owner-target');

    await oldRun;

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused' }));
    expect((engine as any).targetFileIds.get(5)).toBe('new-owner-target');
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
  });

  it('does not continue to another item or commit after reset wins after a transfer settles', async () => {
    let resolveFirstTransfer!: () => void;
    const firstTransfer = new Promise<void>(resolve => {
      resolveFirstTransfer = resolve;
    });
    const transferring: StorageMoveJob = {
      ...job('transferring'), target_provider: 'local', target_external_storage_id: null,
      items: [
        { ...job('transferring').items[0], id: 5, status: 'transferring' },
        { ...job('transferring').items[0], id: 6, status: 'transferring' },
      ],
    };
    let transferCalls = 0;
    driveService.getStorageMove.and.returnValue(of(transferring));
    driveService.resumeStorageMove.and.returnValue(of(transferring));
    spyOn<any>(engine, 'transferToLocal').and.callFake(() => {
      transferCalls++;
      return transferCalls === 1 ? firstTransfer : Promise.resolve();
    });

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks();
    expect(transferCalls).toBe(1);

    resolveFirstTransfer();
    engine.resetRuntimeState();
    const newController = new AbortController();
    (engine as any).controllers.set(4, newController);
    (engine as any).upsertCanonical({ ...transferring, status: 'paused' });
    (engine as any).stages.set(4, 'target_write');

    await oldRun;

    expect(transferCalls).toBe(1);
    expect((engine as any).controllers.get(4)).toBe(newController);
    expect((engine as any).stages.get(4)).toBe('target_write');
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
    expect(driveService.reportStorageMoveFailure).not.toHaveBeenCalled();
  });

  it('does not cache stale Google source metadata or erase a newer cache', async () => {
    const source = new Subject<{ provider: 'google_drive'; external_file_id: string; external_storage_id: number; access_token: string; size_bytes: number }>();
    const googleSource: StorageMoveJob = {
      ...job('transferring'), source_provider: 'google_drive', source_external_storage_id: 8,
      target_provider: 'local', target_external_storage_id: null,
    };
    const controller = new AbortController();
    (engine as any).controllers.set(4, controller);
    driveService.getStorageMoveSource.and.returnValue(source);

    const pending = (engine as any).readRange(googleSource, googleSource.items[0], 0, 99, controller.signal) as Promise<Blob>;
    await flushMicrotasks();
    source.next({ provider: 'google_drive', external_file_id: 'old-source', external_storage_id: 8, access_token: 'old-token', size_bytes: 100 });
    source.complete();
    engine.resetRuntimeState();
    const newMetadata = { externalFileId: 'new-source', accessToken: 'new-token' };
    (engine as any).sourceMetadata.set(5, newMetadata);

    await expectAsync(pending).toBeRejected();
    expect((engine as any).sourceMetadata.get(5)).toBe(newMetadata);
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
  });

  it('does not publish stale ambiguous Google reconciliation after reset wins', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const google = job('transferring');
    const reconciled: StorageMoveJob = {
      ...google, status: 'target_uploaded', transferred_bytes: 100,
      items: [{ ...google.items[0], status: 'target_uploaded', transferred_bytes: 100, target_external_file_id: 'target-123' }],
    };
    const controller = new AbortController();
    (engine as any).controllers.set(4, controller);
    driveService.reconcileStorageMove.and.returnValue(reconciliation);

    const pending = (engine as any).reconcileAmbiguousGoogleUpload(google, google.items[0], controller.signal) as Promise<string>;
    await flushMicrotasks();
    reconciliation.next(reconciled);
    reconciliation.complete();
    engine.resetRuntimeState();
    (engine as any).validatingMoveIds.add(4);

    await expectAsync(pending).toBeRejected();
    expect(engine.jobs()).toEqual([]);
    expect((engine as any).validatingMoveIds.has(4)).toBeTrue();
  });

  it('does not publish a stale failure report after reset wins', async () => {
    const failure = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const controller = new AbortController();
    (engine as any).upsertCanonical(current);
    (engine as any).controllers.set(4, controller);
    driveService.reportStorageMoveFailure.and.returnValue(failure);

    const pending = (engine as any).persistFailureState(
      4, engine.jobs()[0], 'TEST_FAILURE', 'target_write', true, [], controller.signal) as Promise<boolean>;
    await flushMicrotasks();
    failure.next({ ...current, status: 'failed' });
    failure.complete();
    engine.resetRuntimeState();

    await pending;
    expect(engine.jobs()).toEqual([]);
  });

  it('does not publish stale failure recovery after reset wins', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const current = job('transferring');
    const controller = new AbortController();
    (engine as any).upsertCanonical(current);
    (engine as any).controllers.set(4, controller);
    driveService.reportStorageMoveFailure.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 409 })));
    driveService.getStorageMove.and.returnValue(recovery);

    const pending = (engine as any).persistFailureState(
      4, engine.jobs()[0], 'TEST_FAILURE', 'target_write', true, [], controller.signal) as Promise<boolean>;
    await flushMicrotasks();
    recovery.next({ ...current, status: 'target_uploaded' });
    recovery.complete();
    engine.resetRuntimeState();

    await pending;
    expect(engine.jobs()).toEqual([]);
  });

  it('does not rerun a failed owner after reset wins during failure persistence', async () => {
    const first = { ...job('transferring'), target_provider: 'local' as const, target_external_storage_id: null };
    const second = { ...first, status: 'paused' as const };
    let resolveFailure!: (value: boolean) => void;
    const failurePersistence = new Promise<boolean>(resolve => { resolveFailure = resolve; });
    const transfer = spyOn<any>(engine, 'transferToLocal').and.returnValue(Promise.reject(new Error('transfer failed')));
    const persist = spyOn<any>(engine, 'persistFailureState').and.returnValue(failurePersistence);
    driveService.getStorageMove.and.returnValues(of(first), of(second));
    driveService.resumeStorageMove.and.returnValue(of(first));

    const oldRun = (engine as any).run(4) as Promise<void>;
    await flushMicrotasks(10);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    engine.resetRuntimeState();
    resolveFailure(true);

    await oldRun;
    await flushMicrotasks(30);
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
    expect((engine as any).controllers.size).toBe(0);
  });

  it('preserves a completed Google target before progress failure persistence', async () => {
    const progressError = new HttpErrorResponse({ status: 400, statusText: 'Progress rejected' });
    driveService.reportStorageMoveProgress.and.returnValue(throwError(() => progressError));
    driveService.reportStorageMoveFailure.and.returnValue(of(job('paused')));

    await engine.start(file, target);
    await flushMicrotasks(40);
    const put = httpTesting.expectOne('https://google.test/session');
    put.flush({ id: 'google-target-123' });
    await flushMicrotasks(40);

    expect(driveService.reportStorageMoveFailure).toHaveBeenCalledWith(
      4, jasmine.any(String), jasmine.any(String), false, [{
        item_id: 5, target_external_file_id: 'google-target-123',
      }]);
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
    expect(driveService.createStorageMoveGoogleSession).toHaveBeenCalledOnceWith(4, 5);
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
  });

  it('resumes a manually paused local move without requiring retryable failure metadata', async () => {
    const paused: StorageMoveJob = {
      ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false,
    };
    const resumed: StorageMoveJob = { ...paused, status: 'transferring' };
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(of(resumed));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.resume(paused.id);

    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(paused.id);
    expect(driveService.resumeStorageMove).toHaveBeenCalledOnceWith(paused.id);
    expect(driveService.reconcileStorageMove).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledOnceWith(paused.id);

    await engine.resume(paused.id);
    expect(driveService.resumeStorageMove).toHaveBeenCalledTimes(2);
  });

  it('reconciles before resuming a manually paused Google move', async () => {
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const resumed: StorageMoveJob = { ...paused, status: 'transferring' };
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.reconcileStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(of(resumed));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await engine.resume(paused.id);

    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(paused.id);
    expect(driveService.getStorageMove).toHaveBeenCalledBefore(driveService.reconcileStorageMove);
    expect(driveService.reconcileStorageMove).toHaveBeenCalledBefore(driveService.resumeStorageMove);
    expect(driveService.resumeStorageMove).toHaveBeenCalledOnceWith(paused.id);
    expect(driveService.reconcileStorageMove).toHaveBeenCalledBefore(runSpy);
    expect(runSpy).toHaveBeenCalledOnceWith(paused.id);
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
  });

  it('keeps Resume single-flight while the initial GET is pending', async () => {
    const pending = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    driveService.getStorageMove.and.returnValue(pending);
    driveService.resumeStorageMove.and.returnValue(of({ ...paused, status: 'transferring' }));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    const first = engine.resume(4);
    await flushMicrotasks();
    await engine.resume(4);

    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
    pending.next(paused);
    pending.complete();
    await first;

    expect(driveService.resumeStorageMove).toHaveBeenCalledOnceWith(4);
    expect(runSpy).toHaveBeenCalledOnceWith(4);
  });

  it('does not let a stale resume GET overwrite a winning cancel', async () => {
    const pending = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    (engine as any).upsertCanonical(paused);
    driveService.getStorageMove.and.returnValue(pending);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    pending.next(paused);
    pending.complete();
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not resurrect a move when reset wins during the initial Resume GET', async () => {
    const pending = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.returnValue(pending);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    engine.resetRuntimeState();
    pending.next(paused);
    pending.complete();
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()).toEqual([]);
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('drops stale Google reconciliation success after cancel', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.reconcileStorageMove.and.returnValue(reconciliation);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    reconciliation.next(paused);
    reconciliation.complete();
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not publish stale Google reconciliation errors after cancel', async () => {
    const reconciliation = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.reconcileStorageMove.and.returnValue(reconciliation);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    reconciliation.error(new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }));
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not publish a stale Resume response after cancel', async () => {
    const resumeResponse = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    const resumed: StorageMoveJob = { ...paused, status: 'transferring' };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(resumeResponse);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    resumeResponse.next(resumed);
    resumeResponse.complete();
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not resurrect a move when reset wins during the Resume response', async () => {
    const resumeResponse = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(resumeResponse);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    engine.resetRuntimeState();
    resumeResponse.next({ ...paused, status: 'transferring' });
    resumeResponse.complete();
    await expectAsync(resumePromise).toBeResolved();

    expect(engine.jobs()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('suppresses an initial GET error after cancel wins', async () => {
    const initial = new Subject<StorageMoveJob>();
    (engine as any).upsertCanonical(job('paused'));
    driveService.getStorageMove.and.returnValue(initial);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    initial.error(new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }));

    await expectAsync(resumePromise).toBeResolved();
    expect(engine.jobs()[0].status).toBe('cancelled');
  });

  it('suppresses a Resume POST error after cancel wins', async () => {
    const resumeResponse = new Subject<StorageMoveJob>();
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(resumeResponse);

    const resumePromise = engine.resume(4);
    await flushMicrotasks();
    await engine.cancel(4);
    resumeResponse.error(new HttpErrorResponse({ status: 503, statusText: 'Unavailable' }));

    await expectAsync(resumePromise).toBeResolved();
    expect(engine.jobs()[0].status).toBe('cancelled');
  });

  it('does not start Resume while a superseding Cancel is pending', async () => {
    const cancelResponse = new Subject<StorageMoveJob>();
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    (engine as any).upsertCanonical(job('paused'));
    driveService.cancelStorageMove.and.returnValue(cancelResponse);

    const cancelPromise = engine.cancel(4);
    await flushMicrotasks();
    await engine.resume(4);

    expect(driveService.getStorageMove).not.toHaveBeenCalled();
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    cancelResponse.next(job('cancelled'));
    cancelResponse.complete();
    await cancelPromise;
    expect(engine.jobs()[0].status).toBe('cancelled');
  });

  it('keeps the newer Resume owner when an older Resume finally unwinds', async () => {
    const first = new Subject<StorageMoveJob>();
    const second = new Subject<StorageMoveJob>();
    const resumed: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    let getCall = 0;
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    driveService.getStorageMove.and.callFake(() => getCall++ === 0 ? first : second);
    driveService.resumeStorageMove.and.returnValue(of({ ...resumed, status: 'transferring' }));

    const firstResume = engine.resume(4);
    await flushMicrotasks();
    engine.resetRuntimeState();
    const secondResume = engine.resume(4);
    await flushMicrotasks();

    expect((engine as any).resumingMoveIds.has(4)).toBeTrue();
    first.next(job('completed'));
    first.complete();
    await firstResume;

    expect(engine.jobs()).toEqual([]);
    expect((engine as any).resumingMoveIds.has(4)).toBeTrue();

    second.next(resumed);
    second.complete();
    await secondResume;

    expect((engine as any).resumingMoveIds.has(4)).toBeFalse();
    expect(runSpy).toHaveBeenCalledOnceWith(4);
  });

  it('preserves current-owner initial GET errors', async () => {
    const error = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    driveService.getStorageMove.and.returnValue(throwError(() => error));

    let received: unknown;
    try {
      await engine.resume(4);
    } catch (caught) {
      received = caught;
    }

    expect(received).toBe(error);
  });

  it('preserves current-owner Local Resume errors', async () => {
    const paused: StorageMoveJob = { ...job('paused'), target_provider: 'local', target_external_storage_id: null, is_retryable: false };
    const error = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.resumeStorageMove.and.returnValue(throwError(() => error));

    let received: unknown;
    try {
      await engine.resume(4);
    } catch (caught) {
      received = caught;
    }

    expect(received).toBe(error);
  });

  it('preserves current-owner Google reconciliation stateSyncError behavior', async () => {
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    driveService.getStorageMove.and.returnValue(of(paused));
    driveService.reconcileStorageMove.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Unavailable' })));

    await expectAsync(engine.resume(4)).toBeResolved();

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused', stateSyncError: true }));
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
  });

  it('reconciles canonical state after a stale pause rejection', async () => {
    const transferring = { ...job('transferring'), is_retryable: false };
    const controller = new AbortController();
    (engine as any).upsertCanonical(transferring);
    (engine as any).controllers.set(transferring.id, controller);
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(of({ ...transferring, status: 'target_uploaded' }));

    await expectAsync(engine.pause(transferring.id)).toBeResolved();

    expect(controller.signal.aborted).toBeTrue();
    expect(engine.jobs()[0].status).toBe('target_uploaded');
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(transferring.id);
  });

  it('reconciles a rejected pause and lets the real runner finish target_uploaded without retransmitting', async () => {
    const targetUploaded: StorageMoveJob = {
      ...job('target_uploaded'),
      transferred_bytes: 100,
      items: [{ ...job('target_uploaded').items[0], status: 'target_uploaded', transferred_bytes: 100, target_external_file_id: 'target-id' }],
    };
    const completed: StorageMoveJob = {
      ...targetUploaded,
      status: 'completed',
      items: [{ ...targetUploaded.items[0], status: 'completed' }],
    };
    let oldRequestUnsubscribed = false;
    let getCalls = 0;
    let recoveredController: AbortController | undefined;
    driveService.getStorageMove.and.callFake(() => {
      if (getCalls++ === 0) {
        return new Observable<StorageMoveJob>(() => () => { oldRequestUnsubscribed = true; });
      }
      return of(targetUploaded);
    });
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.completeStorageMove.and.callFake(() => {
      recoveredController = (engine as any).controllers.get(4);
      return of(completed);
    });

    const oldRun = (engine as any).run(4) as Promise<void>;
    const oldController = (engine as any).controllers.get(4) as AbortController;
    expect((engine as any).controllers.has(4)).toBeTrue();

    await expectAsync(engine.pause(4)).toBeResolved();
    await oldRun;
    await flushMicrotasks(100);

    expect(oldRequestUnsubscribed).toBeTrue();
    expect(driveService.getStorageMove).toHaveBeenCalledTimes(3);
    expect(driveService.completeStorageMove).toHaveBeenCalledOnceWith(4);
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(driveService.getStorageMoveSource).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
    expect(driveService.createStorageMoveGoogleSession).not.toHaveBeenCalled();
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
    expect(recoveredController).toBeDefined();
    expect(recoveredController).not.toBe(oldController);
    expect(recoveredController?.signal.aborted).toBeFalse();
    expect(driveService.reportStorageMoveFailure).not.toHaveBeenCalled();
    expect(engine.jobs()[0].status).toBe('completed');
    expect((engine as any).controllers.has(4)).toBeFalse();
  });

  it('keeps a canonical paused state after a rejected pause without auto-resuming', async () => {
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    const controller = new AbortController();
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, controller);
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(of(paused));
    const runSpy = spyOn<any>(engine, 'run');

    await expectAsync(engine.pause(4)).toBeResolved();

    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
    expect(runSpy).not.toHaveBeenCalled();
    expect(driveService.resumeStorageMove).not.toHaveBeenCalled();
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused', is_retryable: false }));
  });

  it('publishes a canonical terminal state after a rejected pause without restarting', async () => {
    const completed: StorageMoveJob = {
      ...job('completed'),
      transferred_bytes: 100,
      items: [{ ...job('completed').items[0], status: 'completed', transferred_bytes: 100 }],
    };
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(of(completed));
    const runSpy = spyOn<any>(engine, 'run');

    await expectAsync(engine.pause(4)).toBeResolved();

    expect(runSpy).not.toHaveBeenCalled();
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
    expect(engine.jobs()[0].status).toBe('completed');
  });

  it('marks state synchronization failure and preserves the pause error when canonical recovery fails', async () => {
    const pauseError = new HttpErrorResponse({ status: 400, statusText: 'Invalid state' });
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(throwError(() => pauseError));
    driveService.getStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Unavailable' })));

    let received: unknown;
    try {
      await engine.pause(4);
    } catch (error) {
      received = error;
    }

    expect(received).toBe(pauseError);
    expect(driveService.getStorageMove).toHaveBeenCalledOnceWith(4);
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      status: 'transferring', stateSyncError: true, speedBytesPerSecond: 0, etaSeconds: null,
    }));
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
  });

  it('does not fetch canonical state after an accepted pause', async () => {
    const paused: StorageMoveJob = { ...job('paused'), is_retryable: false };
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(of(paused));

    await expectAsync(engine.pause(4)).toBeResolved();

    expect(driveService.getStorageMove).not.toHaveBeenCalled();
    expect(driveService.pauseStorageMove).toHaveBeenCalledOnceWith(4);
    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({ status: 'paused', is_retryable: false }));
  });

  it('schedules the existing runner for cleanup_pending after rejected-pause recovery', async () => {
    const cleanupPending = { ...job('cleanup_pending'), transferred_bytes: 100 };
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(of(cleanupPending));
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();

    await expectAsync(engine.pause(4)).toBeResolved();

    expect(runSpy).toHaveBeenCalledOnceWith(4);
  });

  it('does not let a stale rejected-pause recovery overwrite a winning cancel', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(recovery);

    const pausePromise = engine.pause(4);
    await flushMicrotasks();
    await engine.cancel(4);
    recovery.next(job('transferring'));
    recovery.complete();
    await pausePromise;

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('does not resurrect a move when reset wins during rejected-pause recovery', async () => {
    const recovery = new Subject<StorageMoveJob>();
    const runSpy = spyOn<any>(engine, 'run').and.resolveTo();
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.pauseStorageMove.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Invalid state' })));
    driveService.getStorageMove.and.returnValue(recovery);

    const pausePromise = engine.pause(4);
    await flushMicrotasks();
    engine.resetRuntimeState();
    recovery.next({ ...job('target_uploaded'), transferred_bytes: 100 });
    recovery.complete();
    await pausePromise;

    expect(engine.jobs()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('contains an initial active-move sync failure without rejecting', async () => {
    (engine as any).upsertCanonical(job('transferring'));
    driveService.getActiveStorageMoves.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unavailable' })));

    await expectAsync(engine.loadActive([target], [file])).toBeResolved();

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      status: 'transferring', stateSyncError: true, speedBytesPerSecond: 0, etaSeconds: null,
    }));
    expect(engine.activeFileIds().has(9)).toBeTrue();
  });

  it('clears the active-move sync error after a later canonical response', async () => {
    (engine as any).upsert(job('transferring'), { stateSyncError: true });
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [job('paused')] }));
    driveService.reconcileStorageMove.and.returnValue(of(job('paused')));

    await engine.loadActive([target], [file]);

    expect(engine.jobs()[0].stateSyncError).toBeFalse();
    expect(engine.jobs()[0].status).toBe('paused');
  });

  it('reconciles missing nonterminal cards after a successful active response', async () => {
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).sessions.set(5, { uri: 'session', token: 'token' });
    (engine as any).sourceMetadata.set(5, { externalFileId: 'source', accessToken: 'token' });
    (engine as any).targetFileIds.set(5, 'target');
    (engine as any).names.set(4, 'arquivo');
    (engine as any).labels.set(4, { source: 'Local', target: 'Google Drive' });
    (engine as any).startedAt.set(4, { time: 1, bytes: 1 });
    (engine as any).stages.set(4, 'commit');
    (engine as any).validatingMoveIds.add(4);
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [] }));

    await engine.loadActive([target], [file]);

    expect(engine.jobs()).toEqual([]);
    expect(engine.activeFileIds().has(9)).toBeFalse();
    expect((engine as any).sessions.size).toBe(0);
    expect((engine as any).sourceMetadata.size).toBe(0);
    expect((engine as any).targetFileIds.size).toBe(0);
    expect((engine as any).startedAt.size).toBe(0);
    expect((engine as any).stages.size).toBe(0);
    expect((engine as any).validatingMoveIds.size).toBe(0);
    expect((engine as any).names.size).toBe(0);
    expect((engine as any).labels.size).toBe(0);
    expect(driveService.cancelStorageMove).not.toHaveBeenCalled();
    expect(driveService.clearStorageMove).not.toHaveBeenCalled();
  });

  it('removes stale paused and failed cards from a successful canonical response', async () => {
    (engine as any).upsertCanonical(job('paused'));
    (engine as any).upsertCanonical({ ...job('failed'), id: 8, file_id: 10 });
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [] }));

    await engine.loadActive([target], [file]);

    expect(engine.jobs()).toEqual([]);
  });

  it('keeps completed and cancelled presentation cards when active response omits them', async () => {
    (engine as any).upsertCanonical(job('completed'));
    (engine as any).upsertCanonical({ ...job('cancelled'), id: 8, file_id: 10 });
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [] }));

    await engine.loadActive([target], [file]);

    expect(engine.jobs().map(item => item.status)).toEqual(['completed', 'cancelled']);
    expect(engine.activeFileIds().size).toBe(0);
  });

  it('keeps canonical jobs and removes only missing nonterminal jobs', async () => {
    const canonical = { ...job('paused'), id: 4 };
    (engine as any).upsertCanonical(canonical);
    (engine as any).upsertCanonical({ ...job('transferring'), id: 8, file_id: 10 });
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [canonical] }));
    driveService.reconcileStorageMove.and.returnValue(of(canonical));

    await engine.loadActive([target], [file]);

    expect(engine.jobs().map(item => item.id)).toEqual([4]);
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
  });

  it('does not discard a move whose local controller is still active', async () => {
    (engine as any).upsertCanonical(job('transferring'));
    (engine as any).controllers.set(4, new AbortController());
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [] }));

    await engine.loadActive([target], [file]);

    expect(engine.jobs()[0].id).toBe(4);
    expect((engine as any).controllers.has(4)).toBeTrue();
  });

  it('removes decrypted presentation data when the vault is locked', async () => {
    await engine.loadActive([target], [file]);

    engine.clearDecryptedPresentationData();

    expect(engine.jobs()[0].fileName).toBe('Arquivo 9');
    expect((engine as any).names.size).toBe(0);
    expect(engine.jobs()[0].status).toBe('paused');
  });

  it('clears cards and all per-move runtime state without calling the backend on reset', async () => {
    await engine.loadActive([target], [file]);
    (engine as any).sessions.set(5, { uri: 'https://google.test/session', token: 'secret' });
    (engine as any).sourceMetadata.set(5, { externalFileId: 'source-id', accessToken: 'secret' });
    (engine as any).targetFileIds.set(5, 'target-id');

    engine.resetRuntimeState();

    expect(engine.jobs()).toEqual([]);
    expect((engine as any).controllers.size).toBe(0);
    expect((engine as any).sessions.size).toBe(0);
    expect((engine as any).sourceMetadata.size).toBe(0);
    expect((engine as any).targetFileIds.size).toBe(0);
    expect((engine as any).names.size).toBe(0);
    expect((engine as any).labels.size).toBe(0);
    expect(driveService.clearStorageMove).not.toHaveBeenCalled();
  });

  it('cancels idempotently through the persistent backend job and allows terminal cards to clear', async () => {
    await engine.loadActive([target], [file]);
    await engine.cancel(4);

    expect(driveService.cancelStorageMove).toHaveBeenCalledOnceWith(4, []);
    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.activeFileIds().has(9)).toBeFalse();
    await engine.clear(4);
    expect(engine.jobs()).toEqual([]);
    expect((engine as any).names.size).toBe(0);
    expect((engine as any).labels.size).toBe(0);
    expect((engine as any).startedAt.size).toBe(0);
    expect((engine as any).targetFileIds.size).toBe(0);
    expect((engine as any).sessions.size).toBe(0);
    expect((engine as any).validatingMoveIds.size).toBe(0);
  });

  it('uses the server-confirmed offset after a Google 308 response', async () => {
    const startPromise = engine.start(file, target);
    await startPromise;
    await flushMicrotasks();

    const firstPut = httpTesting.expectOne('https://google.test/session');
    expect(firstPut.request.headers.get('Content-Range')).toBe('bytes 0-99/100');
    firstPut.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: new HttpHeaders({ Range: 'bytes=0-39' }),
    });
    await flushMicrotasks();

    const secondPut = httpTesting.expectOne('https://google.test/session');
    expect(secondPut.request.headers.get('Content-Range')).toBe('bytes 40-99/100');
    secondPut.flush({ id: 'google-file-id' });
    await flushMicrotasks();

    expect(driveService.markStorageMoveTargetUploaded).toHaveBeenCalledWith(4, 5, 'google-file-id');
    expect(driveService.completeStorageMove).toHaveBeenCalledWith(4);
    expect((engine as any).sessions.size).toBe(0);
  });

  it('reconciles a status-zero result from the final Google PUT before failing', async () => {
    driveService.reconcileStorageMove.and.returnValue(of({
      ...job('target_uploaded'),
      transferred_bytes: 100,
      items: [{ ...job('target_uploaded').items[0], transferred_bytes: 100, status: 'target_uploaded', target_external_file_id: 'reconciled-id' }],
    }));

    const startPromise = engine.start(file, target);
    await startPromise;
    await flushMicrotasks();

    const put = httpTesting.expectOne('https://google.test/session');
    put.error(new ProgressEvent('error'));
    await flushMicrotasks();

    expect(driveService.reconcileStorageMove).toHaveBeenCalledWith(4);
    expect(driveService.markStorageMoveTargetUploaded).toHaveBeenCalledWith(4, 5, 'reconciled-id');
    expect(driveService.completeStorageMove).toHaveBeenCalledWith(4);
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
  });

  it('keeps the Google target for cancel when the target ACK fails', async () => {
    driveService.markStorageMoveTargetUploaded.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Unavailable' })));
    driveService.reportStorageMoveFailure.and.returnValue(of(job('paused')));

    await engine.start(file, target);
    await flushMicrotasks();
    const put = httpTesting.expectOne('https://google.test/session');
    put.flush({ id: 'google-target-123' });
    await flushMicrotasks();

    expect((engine as any).targetFileIds.get(5)).toBe('google-target-123');

    await engine.cancel(4);

    expect(driveService.cancelStorageMove).toHaveBeenCalledWith(4, [{
      item_id: 5,
      target_external_file_id: 'google-target-123',
    }]);
    expect((engine as any).targetFileIds.has(5)).toBeFalse();
  });

  it('reconciles a paused Google job before completing without a second upload', async () => {
    const paused = job('paused');
    const reconciled = {
      ...job('target_uploaded'),
      transferred_bytes: 100,
      items: [{ ...job('target_uploaded').items[0], status: 'target_uploaded' as const,
        transferred_bytes: 100, target_external_file_id: 'google-target-123' }],
    };
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [paused] }));
    driveService.reconcileStorageMove.and.returnValue(of(reconciled));
    driveService.getStorageMove.and.returnValue(of(reconciled));

    await engine.loadActive([target], [file]);
    await flushMicrotasks();

    expect(driveService.reconcileStorageMove).toHaveBeenCalledBefore(driveService.completeStorageMove);
    expect(driveService.createStorageMoveGoogleSession).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
    expect(engine.jobs()[0].status).toBe('completed');
  });

  it('resumes a Google-to-local commit point without retransmitting bytes', async () => {
    const paused: StorageMoveJob = {
      ...job('paused'), source_provider: 'google_drive', source_external_storage_id: 7,
      target_provider: 'local', target_external_storage_id: null, transferred_bytes: 100,
      items: [{ ...job('paused').items[0], status: 'target_uploaded', transferred_bytes: 100 }],
    };
    const resumed: StorageMoveJob = { ...paused, status: 'target_uploaded', is_retryable: false };
    driveService.getStorageMove.and.returnValues(of(paused), of(resumed));
    driveService.resumeStorageMove.and.returnValue(of(resumed));
    driveService.completeStorageMove.and.returnValue(of({ ...resumed, status: 'completed' }));

    await engine.resume(4);
    await flushMicrotasks();

    expect(driveService.resumeStorageMove).toHaveBeenCalledWith(4);
    expect(driveService.completeStorageMove).toHaveBeenCalledWith(4);
    expect(driveService.getStorageMoveUploadedChunks).not.toHaveBeenCalled();
    expect(driveService.getStorageMoveSource).not.toHaveBeenCalled();
    expect(driveService.downloadStorageMoveSourceRange).not.toHaveBeenCalled();
    expect(driveService.downloadExternalFileRange).not.toHaveBeenCalled();
    expect(driveService.uploadStorageMoveChunk).not.toHaveBeenCalled();
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
  });

  it('refreshes cleanup-pending jobs until the backend confirms completion', async () => {
    jasmine.clock().install();
    try {
    const cleanupPending = { ...job('cleanup_pending'), transferred_bytes: 100 };
    const completed = { ...job('completed'), transferred_bytes: 100 };
    driveService.completeStorageMove.and.returnValue(of(cleanupPending));
    driveService.getStorageMove.and.returnValues(of(job('transferring')), of(completed));

    engine.start(file, target);
    await flushMicrotasks();

    const put = httpTesting.expectOne('https://google.test/session');
    put.flush({ id: 'google-file-id' });
    await flushMicrotasks();
    jasmine.clock().tick(550);
    await flushMicrotasks();

    expect(driveService.completeStorageMove).toHaveBeenCalledWith(4);
    expect(driveService.getStorageMove).toHaveBeenCalledTimes(2);
    expect(engine.jobs()[0].status).toBe('completed');
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('keeps a cancelled move terminal when the aborted PUT resolves late', async () => {
    await engine.start(file, target);
    await flushMicrotasks();
    httpTesting.expectOne('https://google.test/session');

    await engine.cancel(4);
    await flushMicrotasks();

    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(httpTesting.match('https://google.test/session')).toHaveSize(0);
    expect(driveService.completeStorageMove).not.toHaveBeenCalled();
    expect(driveService.markStorageMoveTargetUploaded).not.toHaveBeenCalled();
  });

  it('caches Google source metadata for an item and refreshes it once after 401', async () => {
    const sourceJob = {
      ...job('transferring'),
      source_provider: 'google_drive' as const,
      source_external_storage_id: 8,
      target_provider: 'local' as const,
      target_external_storage_id: null,
      items: [{ ...job('transferring').items[0], source_external_file_id: 'source-id' }],
    };
    driveService.getStorageMoveSource.and.returnValues(
      of({ provider: 'google_drive' as const, external_file_id: 'source-id', external_storage_id: 8, access_token: 'token-a', size_bytes: 100 }),
      of({ provider: 'google_drive' as const, external_file_id: 'source-id', external_storage_id: 8, access_token: 'token-b', size_bytes: 100 }),
    );
    driveService.downloadExternalFileRange.and.returnValues(
      throwError(() => new HttpErrorResponse({ status: 401 })),
      of(new Blob(['ok'])),
      of(new Blob(['ok'])),
    );
    const signal = new AbortController().signal;

    await (engine as any).readRange(sourceJob, sourceJob.items[0], 0, 9, signal);
    await (engine as any).readRange(sourceJob, sourceJob.items[0], 10, 19, signal);

    expect(driveService.getStorageMoveSource).toHaveBeenCalledTimes(2);
    expect(driveService.downloadExternalFileRange).toHaveBeenCalledTimes(3);
    expect(driveService.downloadExternalFileRange.calls.argsFor(1)[1]).toBe('token-b');
    expect((engine as any).sourceMetadata.get(5).accessToken).toBe('token-b');
  });

  it('fails after the refreshed Google source token also returns 401', async () => {
    const sourceJob = {
      ...job('transferring'),
      source_provider: 'google_drive' as const,
      source_external_storage_id: 8,
      target_provider: 'local' as const,
      target_external_storage_id: null,
      items: [{ ...job('transferring').items[0], source_external_file_id: 'source-id' }],
    };
    driveService.getStorageMoveSource.and.returnValues(
      of({ provider: 'google_drive' as const, external_file_id: 'source-id', external_storage_id: 8, access_token: 'token-a', size_bytes: 100 }),
      of({ provider: 'google_drive' as const, external_file_id: 'source-id', external_storage_id: 8, access_token: 'token-b', size_bytes: 100 }),
    );
    driveService.downloadExternalFileRange.and.returnValues(
      throwError(() => new HttpErrorResponse({ status: 401 })),
      throwError(() => new HttpErrorResponse({ status: 401 })),
    );

    await expectAsync((engine as any).readRange(sourceJob, sourceJob.items[0], 0, 9, new AbortController().signal)).toBeRejected();

    expect(driveService.getStorageMoveSource).toHaveBeenCalledTimes(2);
    expect(driveService.downloadExternalFileRange).toHaveBeenCalledTimes(2);
    expect((engine as any).sourceMetadata.has(5)).toBeFalse();
  });

  it('does not retry permanent HTTP failures and honors retryable statuses', async () => {
    const waitSpy = spyOn(engine as any, 'wait').and.resolveTo();
    const retryable = spyOn(engine as any, 'retry');
    retryable.and.callThrough();
    let attempts = 0;
    const value = await (engine as any).retry(() => {
      attempts++;
      if (attempts < 2) return Promise.reject(new HttpErrorResponse({ status: 425 }));
      return Promise.resolve('ok');
    }, new AbortController().signal);
    expect(value).toBe('ok');
    expect(attempts).toBe(2);
    expect(waitSpy).toHaveBeenCalled();

    attempts = 0;
    await expectAsync((engine as any).retry(() => {
      attempts++;
      return Promise.reject(new HttpErrorResponse({ status: 400 }));
    }, new AbortController().signal)).toBeRejected();
    expect(attempts).toBe(1);
  });

  it('persists an exhausted 425 as retryable and rejects status 600', async () => {
    spyOn(engine as any, 'wait').and.resolveTo();
    driveService.downloadStorageMoveSourceRange.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 425 })));
    driveService.reportStorageMoveFailure.and.returnValue(of(job('paused')));

    await engine.start(file, target);
    await flushMicrotasks(120);

    expect(driveService.reportStorageMoveFailure).toHaveBeenCalledWith(
      4, jasmine.any(String), jasmine.any(String), true, []);
    expect((engine as any).isRetryableHttpStatus(425)).toBeTrue();
    expect((engine as any).isRetryableHttpStatus(600)).toBeFalse();
  });

  it('retries every transient status in the policy exactly once before success', async () => {
    const waitSpy = spyOn(engine as any, 'wait').and.resolveTo();
    const statuses = [0, 408, 425, 429, 500, 501, 502, 503, 504];

    for (const status of statuses) {
      let attempts = 0;
      await expectAsync((engine as any).retry(() => {
        attempts++;
        if (attempts === 1) return Promise.reject(new HttpErrorResponse({ status }));
        return Promise.resolve(status);
      }, new AbortController().signal)).toBeResolvedTo(status);
      expect(attempts).toBe(2);
    }

    expect(waitSpy).toHaveBeenCalledTimes(statuses.length);
  });

  it('does not retry permanent HTTP statuses', async () => {
    const waitSpy = spyOn(engine as any, 'wait').and.resolveTo();
    const statuses = [400, 401, 403, 404, 409, 410, 413, 416];

    for (const status of statuses) {
      let attempts = 0;
      await expectAsync((engine as any).retry(() => {
        attempts++;
        return Promise.reject(new HttpErrorResponse({ status }));
      }, new AbortController().signal)).toBeRejected();
      expect(attempts).toBe(1);
    }

    expect(waitSpy).not.toHaveBeenCalled();
  });

  it('honors Retry-After and aborts the backoff without another attempt', async () => {
    const waitSpy = spyOn(engine as any, 'wait').and.callThrough();
    let attempts = 0;
    const retryAfter = new HttpHeaders({ 'Retry-After': '2' });
    const value = await (engine as any).retry(() => {
      attempts++;
      if (attempts === 1) return Promise.reject(new HttpErrorResponse({ status: 429, headers: retryAfter }));
      return Promise.resolve('ok');
    }, new AbortController().signal);
    expect(value).toBe('ok');
    expect(waitSpy).toHaveBeenCalledWith(2000, jasmine.any(AbortSignal));

    const controller = new AbortController();
    attempts = 0;
    const pending = (engine as any).retry(() => {
      attempts++;
      return Promise.reject(new HttpErrorResponse({ status: 503 }));
    }, controller.signal);
    await flushMicrotasks(3);
    controller.abort();
    await expectAsync(pending).toBeRejected();
    expect(attempts).toBe(1);
  });

  it('rejects malformed or impossible Google 308 ranges', async () => {
    const item = { ...job('transferring').items[0], total_bytes: 100 };
    const cases = ['bytes=40-10', 'bytes=0-20', 'bytes=0-100', 'bytes=0-1000'];

    for (const range of cases) {
      (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'token' });
      const pending = (engine as any).writeGoogleChunk(item, 40, 99, new Blob(['chunk']), new AbortController().signal);
      const request = httpTesting.expectOne('https://google.test/session');
      request.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: new HttpHeaders({ Range: range }) });
      await expectAsync(pending).toBeRejected();
    }
  });

  it('treats malformed 308 ranges and intermediate status zero as ambiguous', async () => {
    const item = { ...job('transferring').items[0], total_bytes: 100 };
    (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'token' });
    const withoutRange = (engine as any).writeGoogleChunk(item, 0, 99, new Blob(['chunk']), new AbortController().signal);
    let request = httpTesting.expectOne('https://google.test/session');
    request.flush(null, { status: 308, statusText: 'Resume Incomplete' });
    await expectAsync(withoutRange).toBeResolvedTo(jasmine.objectContaining({ kind: 'ambiguous' }));

    for (const range of ['0-39', 'bytes=abc']) {
      (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'token' });
      const malformed = (engine as any).writeGoogleChunk(item, 0, 99, new Blob(['chunk']), new AbortController().signal);
      request = httpTesting.expectOne('https://google.test/session');
      request.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: new HttpHeaders({ Range: range }) });
      await expectAsync(malformed).toBeResolvedTo(jasmine.objectContaining({ kind: 'ambiguous' }));
    }

    const statusZero = (engine as any).writeGoogleChunk(item, 0, 99, new Blob(['chunk']), new AbortController().signal);
    request = httpTesting.expectOne('https://google.test/session');
    request.error(new ProgressEvent('error'));
    await expectAsync(statusZero).toBeResolvedTo(jasmine.objectContaining({ kind: 'ambiguous' }));
  });

  it('stops repeated zero-advance Google 308 responses', async () => {
    const item = { ...job('transferring').items[0], total_bytes: 100 };
    (engine as any).sessions.set(item.id, { uri: 'https://google.test/session', token: 'token' });
    const pending = (engine as any).transferToGoogle(job('transferring'), item, new AbortController().signal);

    for (let index = 0; index < 5; index++) {
      await flushMicrotasks();
      const request = httpTesting.expectOne('https://google.test/session');
      request.flush(null, {
        status: 308,
        statusText: 'Resume Incomplete',
        headers: new HttpHeaders({ Range: 'bytes=0-39' }),
      });
    }

    await expectAsync(pending).toBeRejected();
  });

  it('keeps stateSyncError after cleanup timeout and clears it on later canonical success', async () => {
    const cleanupPending = { ...job('cleanup_pending'), transferred_bytes: 100 };
    const completed = { ...job('completed'), transferred_bytes: 100 };
    spyOn(engine as any, 'wait').and.resolveTo();
    driveService.completeStorageMove.and.returnValue(of(cleanupPending));
    let stateCalls = 0;
    driveService.getStorageMove.and.callFake(() => of(stateCalls++ === 0 ? job('transferring') : cleanupPending));
    await engine.start(file, target);
    await flushMicrotasks(200);
    const put = httpTesting.expectOne('https://google.test/session');
    put.flush({ id: 'cleanup-target' });
    await flushMicrotasks(200);

    expect(engine.jobs()[0].stateSyncError).toBeTrue();

    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [cleanupPending] }));
    driveService.getStorageMove.and.returnValue(of(completed));
    await engine.loadActive([target], [file]);
    await flushMicrotasks();

    expect(engine.jobs()[0].status).toBe('completed');
    expect(engine.jobs()[0].stateSyncError).toBeFalse();
  });
});

async function flushMicrotasks(count = 30): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
