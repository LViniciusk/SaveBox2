import { provideZonelessChangeDetection } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { DriveService } from '../services/drive.service';
import { UploadBatchCoordinatorService } from './upload-batch-coordinator.service';
import { UploadEngineService } from './upload-engine.service';
import { PreparedUpload, UploadBatchCandidate, UploadBatchResult } from './upload.models';

describe('UploadBatchCoordinatorService', () => {
  let coordinator: UploadBatchCoordinatorService;
  let drive: jasmine.SpyObj<DriveService>;
  let engine: jasmine.SpyObj<UploadEngineService>;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['batchInitUploads']);
    engine = jasmine.createSpyObj('UploadEngineService', ['prepareUpload', 'execute']);
    engine.execute.and.resolveTo({ paused: false });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UploadBatchCoordinatorService,
        { provide: DriveService, useValue: drive },
        { provide: UploadEngineService, useValue: engine },
      ],
    });
    coordinator = TestBed.inject(UploadBatchCoordinatorService);
  });

  it('uses windows, correlates by name_hash, and keeps secrets out of the request', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(index));
    engine.prepareUpload.and.callFake(file => Promise.resolve(prepared(file.name)));
    drive.batchInitUploads.and.callFake(items => of({
      files: [...items].reverse().map((item, index) => ({
        file_id: index + 1,
        name_hash: item.name_hash,
        storage_provider: 'local' as const,
      }))
    }));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, callbacks(results));

    expect(summary).toEqual({ total: 6, succeeded: 6, paused: 0, failed: 0 });
    expect(drive.batchInitUploads).toHaveBeenCalledTimes(2);
    for (const call of drive.batchInitUploads.calls.allArgs()) {
      expect(call[0].length).toBeLessThanOrEqual(100);
      expect(call[0].length).toBeLessThanOrEqual(5);
      expect(call[0].every(item => !('name' in item) && !('path' in item))).toBeTrue();
    }
    expect(results).toEqual(candidates.map(item => `${item.transferId}:success`));
    expect(engine.execute).toHaveBeenCalledTimes(6);
  });

  it('isolates preparation failures and does not fall back to individual init', async () => {
    const candidates = [candidate(1), candidate(2)];
    engine.prepareUpload.and.callFake(file => file.name === 'file-1.txt'
      ? Promise.resolve(prepared(file.name))
      : Promise.reject(new Error('prepare failed')));
    drive.batchInitUploads.and.returnValue(of({ files: [{ file_id: 9, name_hash: 'hash-file-1.txt', storage_provider: 'local' }] }));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, callbacks(results));

    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(drive.batchInitUploads).toHaveBeenCalledTimes(1);
    expect(drive.batchInitUploads.calls.mostRecent().args[0]).toHaveSize(1);
    expect(results).toContain('file-2.txt:error');
  });

  it('requires a complete correlated Google response', async () => {
    const item = candidate(1, 'google_drive');
    engine.prepareUpload.and.resolveTo(prepared(item.file.name));
    drive.batchInitUploads.and.returnValue(of({ files: [{ file_id: 1, name_hash: 'hash-file-1.txt', storage_provider: 'google_drive' }] }));
    const results: string[] = [];

    const summary = await coordinator.upload([item], callbacks(results));

    expect(summary).toEqual({ total: 1, succeeded: 0, paused: 0, failed: 1 });
    expect(engine.execute).not.toHaveBeenCalled();
    expect(results).toEqual(['file-1.txt:error']);
  });

  it('runs Google uploads with the provider credentials from the batch response', async () => {
    const item = candidate(1, 'google_drive');
    engine.prepareUpload.and.resolveTo(prepared(item.file.name));
    drive.batchInitUploads.and.returnValue(of({ files: [{
      file_id: 7,
      name_hash: 'hash-file-1.txt',
      storage_provider: 'google_drive',
      access_token: 'access-token',
      root_folder_id: 'root-folder',
    }] }));

    const summary = await coordinator.upload([item], callbacks([]));

    expect(summary).toEqual({ total: 1, succeeded: 1, paused: 0, failed: 0 });
    expect(engine.execute).toHaveBeenCalledWith(
      jasmine.anything(),
      7,
      'google_drive',
      jasmine.objectContaining({ access_token: 'access-token', root_folder_id: 'root-folder' }),
      item.control,
      jasmine.anything()
    );
  });

  it('reports paused and execution-error results without losing the other upload', async () => {
    const candidates = [candidate(1), candidate(2)];
    engine.prepareUpload.and.callFake(file => Promise.resolve(prepared(file.name)));
    drive.batchInitUploads.and.returnValue(of({ files: candidates.map((item, index) => ({
      file_id: index + 1,
      name_hash: `hash-${item.file.name}`,
      storage_provider: 'local' as const,
    })) }));
    engine.execute.and.callFake(preparedUpload => preparedUpload.file.name === 'file-1.txt'
      ? Promise.resolve({ paused: true })
      : Promise.reject(new Error('upload failed')));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, callbacks(results));

    expect(summary).toEqual({ total: 2, succeeded: 0, paused: 1, failed: 1 });
    expect(results).toEqual(['file-1.txt:paused', 'file-2.txt:error']);
  });

  it('forwards engine progress to the batch callback with its candidate identity', async () => {
    const item = candidate(1);
    engine.prepareUpload.and.resolveTo(prepared(item.file.name));
    drive.batchInitUploads.and.returnValue(of({ files: [{
      file_id: 1,
      name_hash: 'hash-file-1.txt',
      storage_provider: 'local',
    }] }));
    engine.execute.and.callFake((_prepared, _fileId, _provider, _response, _control, uploadCallbacks) => {
      uploadCallbacks.onProgress({ progress: 50, transferredBytes: 5, totalBytes: 10 });
      return Promise.resolve({ paused: false });
    });
    const progress = jasmine.createSpy('progress');

    await coordinator.upload([item], {
      onInitialized: () => undefined,
      onProgress: progress,
      onResult: () => undefined,
    });

    expect(progress).toHaveBeenCalledWith(item, 50, 5, 10);
  });

  it('rejects duplicate prepared hashes before calling the batch endpoint', async () => {
    const candidates = [candidate(1), candidate(2)];
    engine.prepareUpload.and.callFake(file => Promise.resolve({ ...prepared(file.name), nameHash: 'same-hash' }));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, callbacks(results));

    expect(summary).toEqual({ total: 2, succeeded: 0, paused: 0, failed: 2 });
    expect(drive.batchInitUploads).not.toHaveBeenCalled();
    expect(results).toEqual(['file-1.txt:error', 'file-2.txt:error']);
  });

  it('stops later windows after unauthorized batch initialization', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(index));
    engine.prepareUpload.and.callFake(file => Promise.resolve(prepared(file.name)));
    drive.batchInitUploads.and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, callbacks(results));

    expect(summary).toEqual({ total: 6, succeeded: 0, paused: 0, failed: 6 });
    expect(drive.batchInitUploads).toHaveBeenCalledTimes(1);
    expect(results).toHaveSize(6);
  });

  it('splits 101 files into bounded windows', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
    engine.prepareUpload.and.callFake(file => Promise.resolve(prepared(file.name)));
    drive.batchInitUploads.and.callFake(items => of({ files: items.map((item, index) => ({
      file_id: index + 1,
      name_hash: item.name_hash,
      storage_provider: 'local' as const,
    })) }));

    const summary = await coordinator.upload(candidates, callbacks([]));

    expect(summary.succeeded).toBe(101);
    expect(drive.batchInitUploads.calls.count()).toBe(21);
    expect(drive.batchInitUploads.calls.allArgs().every(([items]) => items.length <= 100)).toBeTrue();
  });

  function candidate(index: number, provider: 'local' | 'google_drive' = 'local'): UploadBatchCandidate {
    const file = new File([`content-${index}`], `file-${index}.txt`);
    return {
      file,
      folderId: null,
      transferId: file.name,
      provider,
      control: { shouldPause: () => false, shouldCancel: () => false },
    };
  }

  function prepared(name: string): PreparedUpload {
    return {
      file: new File(['plain'], name),
      encryptedBlob: new Blob(['encrypted']),
      encryptedName: `encrypted-${name}`,
      nameHash: `hash-${name}`,
      encryptedFdk: `encrypted-fdk-${name}`,
      fdk: new Uint8Array([1, 2, 3]),
      totalChunks: 1,
      encryptedSize: 9,
    };
  }

  function callbacks(results: string[]) {
    return {
      onInitialized: () => undefined,
      onProgress: () => undefined,
      onResult: (result: UploadBatchResult) => results.push(`${result.transferId}:${result.status}`),
    };
  }
});
