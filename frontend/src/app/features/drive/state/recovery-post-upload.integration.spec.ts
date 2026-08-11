import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { DownloadEngineService } from '../services/download-engine.service';
import { DriveService } from '../services/drive.service';
import type { TreeResponse } from '../services/drive.service';
import { ThumbnailLoaderService } from '../services/thumbnail-loader.service';
import { StorageMoveEngineService } from '../storage-move/storage-move-engine.service';
import { FolderUploadCoordinatorService } from '../upload/folder-upload-coordinator.service';
import { UploadBatchCoordinatorService } from '../upload/upload-batch-coordinator.service';
import { UploadEngineService } from '../upload/upload-engine.service';
import { DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';
import { environment } from '../../../../environments/environment';
import { DriveStore } from './drive.store';

describe('recovery post-upload continuation integration', () => {
  let store: DriveStore;
  let drive: DriveService;
  let kasumi: KasumiCryptoService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        DriveStore,
        DriveService,
        UploadEngineService,
        KasumiCryptoService,
        { provide: CryptoService, useValue: {
          isVaultUnlocked: signal(true),
          decryptName: jasmine.createSpy('decryptName').and.resolveTo('recovery.bin'),
        } },
        { provide: DialogService, useValue: {} },
        { provide: VideoTranscoderService, useValue: {} },
        { provide: UploadBatchCoordinatorService, useValue: {} },
        { provide: FolderUploadCoordinatorService, useValue: {} },
        { provide: StorageMoveEngineService, useValue: { activeFileIds: () => new Set(), jobs: signal([]) } },
        { provide: DownloadEngineService, useValue: {} },
        {
          provide: ThumbnailLoaderService,
          useValue: { thumbnails: signal({}), clear: () => undefined, setThumbnail: () => undefined, prune: () => undefined },
        },
      ],
    });
    store = TestBed.inject(DriveStore);
    drive = TestBed.inject(DriveService);
    kasumi = TestBed.inject(KasumiCryptoService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    const timer = (store as any).treeReconciliationTimer as ReturnType<typeof setTimeout> | null;
    if (timer) clearTimeout(timer);
  });

  for (const refresh of [false, true]) {
    it(refresh
      ? 'treats a completed recovery removed by reconciliation as terminal success'
      : 'publishes terminal success after the confirmed prefix and final HTTP chunk', async () => {
      const transferId = refresh ? 'm26-local-recovery' : 'm23-local-recovery';
      const uploadId = `${transferId}_recovery`;
      const fileId = 7321;
      const file = new File([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)], 'recovery.bin');
      const fdk = new Uint8Array(32).fill(0x5a);
      const encryptedSize = kasumi.calculateEncryptedSize(file.size);
      const plan = {
        file,
        encryptedName: 'encrypted-name',
        nameHash: '',
        encryptedFdk: 'encrypted-fdk',
        fdk,
        totalChunks: Math.ceil(encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE),
        encryptedSize,
        baseNonce: new Uint8Array(24).fill(0x2a),
      };
      expect(plan.totalChunks).toBe(2);

      store.addTransfer({
        id: transferId,
        fileName: file.name,
        type: 'upload',
        status: 'processing',
        progress: 50,
        statusMessage: 'Retomando upload...',
        isRecovery: true,
      });
      (store as any).activeUploads.set(uploadId, {
        provider: 'local',
        transferId,
        file,
        fileId,
        plan,
        folderId: null,
        initRes: {},
        isHiddenProxy: false,
      });
      if (!refresh) spyOn(store as any, 'scheduleTreeReconciliation');
      const updateProgress = spyOn(store, 'updateTransferProgress').and.callThrough();
      const actualTree = drive.getTree.bind(drive);
      const treeStarted = new Promise<void>(resolve => {
        spyOn(drive, 'getTree').and.callFake((...args) => { resolve(); return actualTree(...args); });
      });
      const actualPending = drive.getPendingUploads.bind(drive);
      const pendingStarted = new Promise<void>(resolve => {
        spyOn(drive, 'getPendingUploads').and.callFake(() => { resolve(); return actualPending(); });
      });
      const actualQuota = drive.getQuota.bind(drive);
      const quotaStarted = new Promise<void>(resolve => {
        spyOn(drive, 'getQuota').and.callFake(() => { resolve(); return actualQuota(); });
      });

      let postStarted!: () => void;
      const started = new Promise<void>(resolve => postStarted = resolve);
      const actualUploadChunk = drive.uploadChunk.bind(drive);
      spyOn(drive, 'uploadChunk').and.callFake((id, index, blob) => {
        const request = actualUploadChunk(id, index, blob);
        if (index === 1) postStarted();
        return request;
      });

      const operation = (store as any).runUploadLoop(uploadId, transferId, fileId, false, refresh) as Promise<void>;
      const uploadedChunks = http.expectOne(`${environment.apiUrl}/files/${fileId}/uploaded-chunks`);
      expect(uploadedChunks.request.method).toBe('GET');
      uploadedChunks.flush({ uploaded_chunks: [0] });

      await started;
      const finalChunk = http.expectOne(`${environment.uploadApiUrl}/files/${fileId}/chunks`);
      expect(finalChunk.request.method).toBe('POST');
      expect(finalChunk.request.headers.get('X-Chunk-Index')).toBe('1');
      expect(finalChunk.request.withCredentials).toBeTrue();
      expect(finalChunk.request.body instanceof Blob).toBeTrue();
      expect((finalChunk.request.body as Blob).size).toBe(encryptedSize - DRIVE_TRANSFER_CHUNK_SIZE);
      finalChunk.flush(null);

      if (refresh) {
        await treeStarted;
        // Observe the actual signal before allowing reconciliation to remove the transfer.
        expect(store.transfers().find(item => item.id === transferId)).toEqual(jasmine.objectContaining({
          status: 'success', progress: 100,
        }));
        expect(store.files().some(item => item.id === fileId)).toBeTrue();
        expect((store as any).activeUploads.has(uploadId)).toBeFalse();
        expect([...fdk]).toEqual(new Array(32).fill(0));
        const tree = http.expectOne(`${environment.apiUrl}/tree?file_limit=100&file_offset=0`);
        expect(tree.request.method).toBe('GET');
        const response: TreeResponse = {
          folders: [],
          files: [{
            id: fileId, folder_id: null, encrypted_name: plan.encryptedName,
            encrypted_fdk: plan.encryptedFdk, size_bytes: encryptedSize, mime_type: file.type,
            storage_provider: 'local', external_storage_id: null, is_hidden: false,
          }],
          has_more: false,
        };
        tree.flush(response);
        await pendingStarted;
        expect(store.transfers().find(item => item.id === transferId)?.status).toBe('success');
        const pending = http.expectOne(`${environment.apiUrl}/pending-uploads`);
        expect(pending.request.method).toBe('GET');
        pending.flush({ pending_uploads: [] });
        await quotaStarted;
        expect(store.transfers().some(item => item.id === transferId)).toBeFalse();
        const quota = http.expectOne(`${environment.apiUrl}/users/me/quota`);
        expect(quota.request.method).toBe('GET');
        quota.flush({ used_bytes: encryptedSize, max_bytes: encryptedSize * 2,
          gdrive_used_bytes: 0, gdrive_max_bytes: 0 });
      }
      await operation;

      expect(updateProgress.calls.allArgs().map(([, value]) => value)).toEqual([50, 100]);
      if (!refresh) expect(store.transfers().find(item => item.id === transferId)).toEqual(jasmine.objectContaining({
        status: 'success',
        progress: 100,
        statusMessage: 'Concluído!',
      }));
      expect((store as any).activeUploads.has(uploadId)).toBeFalse();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(store.files().some(item => item.id === fileId)).toBeTrue();
      expect(store.transfers().some(item => item.id === `pending_${fileId}`)).toBeFalse();
      http.expectNone(request => request.url.includes('/users/me/quota'));
    });
  }
});
