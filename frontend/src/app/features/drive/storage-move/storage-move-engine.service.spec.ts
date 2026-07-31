import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { DriveService } from '../services/drive.service';
import { DriveFile } from '../state/drive.store';
import { StorageTarget } from '../state/drive.types';
import { StorageMoveJob } from './storage-move.models';
import { StorageMoveEngineService } from './storage-move-engine.service';

describe('StorageMoveEngineService', () => {
  let engine: StorageMoveEngineService;
  let driveService: jasmine.SpyObj<DriveService>;

  const job = (status: StorageMoveJob['status'] = 'paused'): StorageMoveJob => ({
    id: 4, file_id: 9, status,
    source_provider: 'local', source_external_storage_id: null,
    target_provider: 'google_drive', target_external_storage_id: 7,
    total_bytes: 100, transferred_bytes: 40,
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

  beforeEach(() => {
    driveService = jasmine.createSpyObj<DriveService>('DriveService', [
      'startStorageMove', 'getActiveStorageMoves', 'getStorageMove', 'pauseStorageMove',
      'resumeStorageMove', 'cancelStorageMove', 'getStorageMoveUploadedChunks',
      'downloadStorageMoveSourceRange', 'getStorageMoveSource', 'downloadExternalFileRange',
      'uploadStorageMoveChunk', 'createStorageMoveGoogleSession', 'reportStorageMoveProgress',
      'completeStorageMove',
    ]);
    driveService.getActiveStorageMoves.and.returnValue(of({ moves: [job()] }));
    driveService.pauseStorageMove.and.returnValue(of(job('paused')));
    driveService.cancelStorageMove.and.returnValue(of(job('cancelled')));

    TestBed.configureTestingModule({ providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      StorageMoveEngineService,
      { provide: DriveService, useValue: driveService },
    ] });
    engine = TestBed.inject(StorageMoveEngineService);
  });

  it('restores paused jobs with decrypted labels without moving bytes', async () => {
    await engine.loadActive([target], [file]);

    expect(engine.jobs()[0]).toEqual(jasmine.objectContaining({
      fileName: 'arquivo.bin', sourceLabel: 'Local', targetLabel: 'Conta Google', status: 'paused',
    }));
    expect(engine.activeFileIds().has(9)).toBeTrue();
    expect(driveService.getStorageMove).not.toHaveBeenCalled();
  });

  it('cancels idempotently through the persistent backend job and allows terminal cards to clear', async () => {
    await engine.loadActive([target], [file]);
    await engine.cancel(4);

    expect(driveService.cancelStorageMove).toHaveBeenCalledOnceWith(4);
    expect(engine.jobs()[0].status).toBe('cancelled');
    expect(engine.activeFileIds().has(9)).toBeFalse();
    engine.clear(4);
    expect(engine.jobs()).toEqual([]);
  });
});
