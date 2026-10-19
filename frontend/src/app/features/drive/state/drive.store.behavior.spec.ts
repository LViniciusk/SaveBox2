import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { buildGoogleAuthorizationUrl, DriveFile, DriveStore } from './drive.store';
import { environment } from '../../../../environments/environment';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { AppStateService, AppStatus } from '../../../core/state/app-state.service';
import { UploadBatchCoordinatorService } from '../upload/upload-batch-coordinator.service';
import { UploadEngineService } from '../upload/upload-engine.service';
import { KASUMI_KAS2_METADATA_PREFIX_SIZE, KASUMI_MAX_METADATA_SIZE } from '../../../core/crypto/kasumi-format';

describe('DriveStore public behavior', () => {
  let store: DriveStore;
  let drive: jasmine.SpyObj<DriveService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  let kasumi: jasmine.SpyObj<KasumiCryptoService>;
  let dialog: jasmine.SpyObj<DialogService>;
  const status = signal(AppStatus.Unlocked);
  const base64Bytes = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  const downloadFile = (storageProvider: DriveFile['storageProvider'] = 'local'): DriveFile => ({
    id: 41,
    isFolder: false,
    encryptedName: 'encrypted-name',
    decryptedName: 'download.bin',
    type: 'unknown',
    sizeBytes: 24,
    sizeFormatted: '24 B',
    modifiedAt: '',
    owner: 'me',
    encryptedFdk: 'encrypted-fdk',
    storageProvider,
    externalStorageId: null,
  });

  beforeEach(() => {
    status.set(AppStatus.Unlocked);
    localStorage.removeItem('preferred_storage_provider');
    drive = jasmine.createSpyObj('DriveService', [
      'getTree', 'getQuota', 'getPendingUploads', 'getTrash', 'createFolder', 'updateFolder',
      'updateFile', 'trashFolder', 'trashFile', 'hardDeleteFolder', 'hardDeleteFile',
      'restoreFolder', 'restoreFile', 'emptyTrash', 'batchSoftDeleteFiles', 'batchSoftDeleteFolders',
      'batchHardDeleteFiles', 'batchHardDeleteFolders', 'downloadFileRange', 'downloadPendingUploadRecoveryPrefix',
      'getUploadedChunks', 'getExternalUploadRecoveryContext',
      'initFileUpload', 'uploadChunk',
      'getLinkedGoogleAccounts', 'generateGoogleState', 'unlinkGoogleAccount',
      'downloadExternalMetadata', 'cancelExternalUpload',
    ]);
    crypto = jasmine.createSpyObj('CryptoService', [
      'isVaultUnlocked', 'decryptName', 'encryptName', 'hashName',
    ]);
    const appState = jasmine.createSpyObj('AppStateService', [], { status });
    kasumi = jasmine.createSpyObj('KasumiCryptoService', [
      'extractMetadata', 'encryptFileParts', 'extractBaseNonce', 'calculateEncryptedSize', 'generateBaseNonce',
    ]);
    dialog = jasmine.createSpyObj('DialogService', ['confirm']);
    const transcoder = jasmine.createSpyObj('VideoTranscoderService', [
      'isVideo', 'isStreamingFormatSupported', 'transcodeToProxy',
    ]);

    drive.getTree.and.returnValue(of({ folders: [], files: [], has_more: false }));
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));
    drive.getTrash.and.returnValue(of({ folders: [], files: [] }));
    drive.getQuota.and.returnValue(of({ used_bytes: 1, max_bytes: 2 }));
    drive.createFolder.and.returnValue(of({ id: 1 }));
    drive.updateFolder.and.returnValue(of({}));
    drive.updateFile.and.returnValue(of({}));
    drive.trashFolder.and.returnValue(of(undefined));
    drive.trashFile.and.returnValue(of(undefined));
    drive.hardDeleteFolder.and.returnValue(of(undefined));
    drive.hardDeleteFile.and.returnValue(of(undefined));
    drive.cancelExternalUpload.and.returnValue(of({ status: 'cleanup_pending' }));
    drive.restoreFolder.and.returnValue(of(undefined));
    drive.restoreFile.and.returnValue(of(undefined));
    drive.emptyTrash.and.returnValue(of({}));
    drive.batchSoftDeleteFiles.and.returnValue(of(undefined));
    drive.batchSoftDeleteFolders.and.returnValue(of(undefined));
    drive.batchHardDeleteFiles.and.returnValue(of(undefined));
    drive.batchHardDeleteFolders.and.returnValue(of(undefined));
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [] }));
    drive.initFileUpload.and.returnValue(of({ file_id: 1 }));
    drive.uploadChunk.and.returnValue(of(undefined));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob(['header'])));
    drive.getExternalUploadRecoveryContext.and.returnValue(of({
      storage_provider: 'google_drive', external_storage_id: 1,
      name_hash: 'hash',
    }));
    drive.getLinkedGoogleAccounts.and.returnValue(of({ accounts: [] }));
    drive.generateGoogleState.and.returnValue(of({ state: 'state' }));
    drive.unlinkGoogleAccount.and.returnValue(of({}));
    drive.downloadExternalMetadata.and.returnValue(of({
      storage_provider: 'google_drive', external_file_id: 'external', access_token: 'token'
    }));
    crypto.isVaultUnlocked.and.returnValue(true);
    crypto.decryptName.and.callFake(async (value: string) => value);
    crypto.encryptName.and.resolveTo('encrypted');
    crypto.hashName.and.resolveTo('hash');
    kasumi.extractBaseNonce.and.resolveTo(new Uint8Array(24));
    kasumi.calculateEncryptedSize.and.returnValue(24);
    kasumi.generateBaseNonce.and.returnValue(new Uint8Array(24).fill(8));
    kasumi.encryptFileParts.and.callFake(async function* () { yield new Blob([new Uint8Array(24)]); });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), DriveStore,
        { provide: DriveService, useValue: drive }, { provide: CryptoService, useValue: crypto },
        { provide: KasumiCryptoService, useValue: kasumi }, { provide: DialogService, useValue: dialog },
        { provide: VideoTranscoderService, useValue: transcoder }, { provide: AppStateService, useValue: appState },
      ],
    });
    store = TestBed.inject(DriveStore);
  });

  it('B.94 bounds upload initialization and reports error rather than user cancellation', async () => {
    jasmine.clock().install();
    try {
      store.setStorageProvider('local');
      const source = new Subject<{ file_id: number }>();
      drive.initFileUpload.and.returnValue(source);
      const input = new File(['x'], 'synthetic.bin');
      spyOn(TestBed.inject(UploadEngineService), 'planUpload').and.resolveTo({
        file: input, fdk: new Uint8Array(32), encryptedName: 'cipher', nameHash: 'hash', encryptedFdk: 'key',
        totalChunks: 1, encryptedSize: 24,
      });
      store.addTransfer({ id: 'b94-init', fileName: 'synthetic.bin', type: 'upload', status: 'processing', progress: 0 });
      (store as any).ensureUploadController('b94-init');
      let error: Error | undefined;
      const pending = (store as any)._uploadSingleFile(input, null, false, 'b94-init', false)
        .catch((value: Error) => { error = value; });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(30_000);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(source.observed).toBeFalse();
      expect(error?.name).toBe('NetworkDeadlineError');
      expect(store.transfers().find(item => item.id === 'b94-init')?.status).toBe('error');
      expect(drive.uploadChunk).not.toHaveBeenCalled();
      source.error(new Error('synthetic teardown'));
      await pending;
    } finally { jasmine.clock().uninstall(); }
  });

  it('classifies every supported file type and normalizes folder ancestry', async () => {
    const names = ['a.pdf', 'b.jpg', 'c.docx', 'd.xlsx', 'e.mp4', 'f.mp3', 'g.bin'];
    drive.getTree.and.returnValue(of({
      folders: [{ id: 10, parent_id: null, encrypted_name: 'root' }],
      files: names.map((encrypted_name, id) => ({ id, encrypted_name, size_bytes: id ? 1024 : 0, folder_id: null, encrypted_fdk: 'fdk', is_hidden: false, storage_provider: 'local' as const, external_storage_id: null })),
      has_more: false,
    }));
    await store.loadTree();
    expect(store.files().map(file => file.type)).toEqual(['folder', 'pdf', 'image', 'doc', 'spreadsheet', 'video', 'audio', 'unknown']);
    expect(store.files()[1].sizeFormatted).toBe('0 B');
    expect(store.files()[2].sizeFormatted).toBe('1 KB');
    expect(store.files()[0].parentId).toBeNull();
  });

  it('A19M-DRIVE-001 blocks an old loadTree decrypt from republishing after lock', async () => {
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    drive.getTree.and.returnValue(of({
      folders: [],
      files: [{
        id: 77, folder_id: null, encrypted_name: 'encrypted-secret', size_bytes: 12,
        encrypted_fdk: 'fdk', is_hidden: false, storage_provider: 'local', external_storage_id: null,
      }],
      has_more: false,
    }));
    crypto.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });

    const loading = store.loadTree();
    await decryptStarted.promise;
    store.clearDecryptedPresentationData();
    decrypt.resolve('segredo.txt');
    await loading;

    expect(store.files()).toEqual([]);
  });

  it('A19M-DRIVE-002 blocks an old loadTrash decrypt from republishing after lock', async () => {
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    drive.getTrash.and.returnValue(of({
      folders: [],
      files: [{
        id: 78, folder_id: null, encrypted_name: 'encrypted-trash-secret', size_bytes: 12,
        encrypted_fdk: 'fdk', is_hidden: false, storage_provider: 'local', external_storage_id: null,
      }],
    }));
    crypto.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });

    const loading = store.loadTrash();
    await decryptStarted.promise;
    store.clearDecryptedPresentationData();
    decrypt.resolve('lixeira-secreta.txt');
    await loading;

    expect(store.trashFiles()).toEqual([]);
  });

  it('A19M-REDECRYPT-001 blocks stale reDecryptAll publication and recovery filename updates', async () => {
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    store.files.set([{ id: 79, isFolder: false, encryptedName: 'encrypted-file', decryptedName: null } as DriveFile]);
    store.addTransfer({
      id: 'pending-recovery', fileName: 'placeholder', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: { encrypted_name: 'encrypted-recovery' } as any,
    });
    crypto.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });

    const reDecrypting = store.reDecryptAll();
    await decryptStarted.promise;
    store.clearDecryptedPresentationData();
    decrypt.resolve('segredo-reidratado.txt');
    await reDecrypting;

    expect(store.files()[0]).toEqual(jasmine.objectContaining({ id: 79, decryptedName: null }));
    expect(store.transfers().find(transfer => transfer.id === 'pending-recovery')?.fileName)
      .toBe('Arquivo Desconhecido');
  });

  it('A19M-DRIVE-003 allows a fresh loadTree to publish after the lock boundary', async () => {
    store.clearDecryptedPresentationData();
    crypto.decryptName.and.resolveTo('novo.txt');
    drive.getTree.and.returnValue(of({
      folders: [],
      files: [{
        id: 80, folder_id: null, encrypted_name: 'encrypted-new', size_bytes: 12,
        encrypted_fdk: 'fdk', is_hidden: false, storage_provider: 'local', external_storage_id: null,
      }],
      has_more: false,
    }));

    await store.loadTree();

    expect(store.files().map(file => file.decryptedName)).toEqual(['novo.txt']);
  });

  it('loads files beyond the first tree page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({
      id,
      folder_id: null,
      encrypted_name: `file-${id}`,
      size_bytes: 1,
      encrypted_fdk: 'fdk',
      is_hidden: false,
          storage_provider: 'local' as const,
          external_storage_id: null,
    }));
    drive.getTree.and.callFake((_limit?: number, offset = 0) => of({
      folders: [],
      files: offset === 0 ? firstPage : [{
        id: 100,
        folder_id: null,
        encrypted_name: 'new-file',
        size_bytes: 1,
        encrypted_fdk: 'fdk',
        is_hidden: false,
        storage_provider: 'local' as const,
        external_storage_id: null,
      }],
      has_more: offset === 0,
    }));

    await store.loadTree();

    expect(drive.getTree).toHaveBeenCalledTimes(2);
    expect(store.files()).toHaveSize(101);
  });

  it('uses has_more to avoid a terminal request after an exact page multiple', async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({
      id: start + index,
      folder_id: null,
      encrypted_name: `file-${start + index}`,
      size_bytes: 1,
      encrypted_fdk: 'fdk',
      is_hidden: false,
      storage_provider: 'local' as const,
      external_storage_id: null,
    }));
    drive.getTree.and.callFake((_limit?: number, offset = 0) => of({
      folders: [],
      files: page(offset),
      has_more: offset === 0,
    }));

    await store.loadTree();

    expect(drive.getTree).toHaveBeenCalledTimes(2);
    expect(drive.getTree.calls.argsFor(0)).toEqual([100, 0]);
    expect(drive.getTree.calls.argsFor(1) as any).toEqual([100, 100, false]);
    expect(store.files()).toHaveSize(200);
  });

  it('prunes thumbnails by file ids instead of folder ids', async () => {
    store.thumbnails.set({ 42: 'stale-thumbnail' });
    drive.getTree.and.returnValue(of({
      folders: [{ id: 42, parent_id: null, encrypted_name: 'folder' }],
      files: [],
      has_more: false,
    }));

    await store.loadTree();

    expect(store.thumbnails()[42]).toBeUndefined();
  });

  it('retains a thumbnail when the same id is still a file', async () => {
    store.thumbnails.set({ 42: 'valid-thumbnail' });
    drive.getTree.and.returnValue(of({
      folders: [],
      files: [{
        id: 42, folder_id: null, encrypted_name: 'file', size_bytes: 1,
        encrypted_fdk: 'fdk', is_hidden: false, storage_provider: 'local', external_storage_id: null,
      }],
      has_more: false,
    }));

    await store.loadTree();

    expect(store.thumbnails()[42]).toBe('valid-thumbnail');
  });

  it('creates recovery transfers with zero-safe progress and clears old recoveries', async () => {
    store.transfers.set([{ id: 'old', fileName: 'old', type: 'upload', status: 'paused', progress: 1, isRecovery: true, timestamp: new Date() }]);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 4, encrypted_name: 'draft', total_chunks: 0, uploaded_chunks_count: 0 },
      { id: 5, encrypted_name: 'half', total_chunks: 4, uploaded_chunks_count: 2 },
    ] }));
    await store.loadPendingUploads();
    expect(store.transfers().filter(t => t.isRecovery).map(t => [t.id, t.progress])).toEqual([
      ['pending_5', 50], ['pending_4', 0],
    ]);
  });

  it('clears recovery transfers when the pending upload list is empty', async () => {
    store.transfers.set([{ id: 'stale', fileName: 'stale', type: 'upload', status: 'paused', progress: 20, isRecovery: true, timestamp: new Date() }]);
    crypto.decryptName.and.resolveTo('');
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 6, encrypted_name: 'unknown', total_chunks: 1, uploaded_chunks_count: 0 },
    ] }));

    await store.loadPendingUploads();
    expect(store.transfers()[0].fileName).toBe('Arquivo Desconhecido');

    drive.getPendingUploads.and.returnValue(of({} as any));
    await store.loadPendingUploads();

    expect(store.transfers()).toEqual([]);
  });

  it('does not duplicate a live upload when the server still reports its file id as pending', async () => {
    store.addTransfer({ id: 'live-upload', fileName: 'live', type: 'upload', status: 'processing', progress: 30 });
    (store as any).uploadInitializedFileIds.set('live-upload', new Set([42]));
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 42, encrypted_name: 'live', total_chunks: 2, uploaded_chunks_count: 1 },
      { id: 43, encrypted_name: 'recovery', total_chunks: 2, uploaded_chunks_count: 0 },
    ] }));

    await store.loadPendingUploads();

    expect(store.transfers().some(transfer => transfer.id === 'pending_42')).toBeFalse();
    expect(store.transfers().some(transfer => transfer.id === 'pending_43')).toBeTrue();
  });

  it('rechecks live upload ownership after decrypting a pending name', async () => {
    let becameLive = false;
    crypto.decryptName.and.callFake(async (value: string) => {
      if (!becameLive) {
        becameLive = true;
        store.addTransfer({ id: 'live-upload', fileName: 'live', type: 'upload', status: 'pending', progress: 0 });
        (store as any).uploadInitializedFileIds.set('live-upload', new Set([44]));
      }
      return value;
    });
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 44, encrypted_name: 'live', total_chunks: 1, uploaded_chunks_count: 0 },
    ] }));

    await store.loadPendingUploads();

    expect(store.transfers().some(transfer => transfer.id === 'pending_44')).toBeFalse();
  });

  it('preserves an active recovery while its FDK is being decrypted', async () => {
    const pending = { id: 9, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24, total_chunks: 1, uploaded_chunks_count: 0 };
    store.addTransfer({
      id: 'pending_9', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      statusMessage: 'Arquivo selecionado', isRecovery: true, pendingData: pending as any,
    });
    let resolveFdk!: (value: string) => void;
    crypto.decryptName.and.returnValue(new Promise<string>(resolve => resolveFdk = resolve));
    spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
      (store as any).releaseTerminalUploadRuntime('pending_9');
    });

    const recovery = store.recoverUpload('pending_9', pending as any, new File(['plain'], 'selected.txt'));
    await Promise.resolve();
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));
    await store.loadPendingUploads();

    const matching = store.transfers().filter(transfer => transfer.id === 'pending_9');
    expect(matching).toHaveSize(1);
    expect(matching[0].statusMessage).toBe('Arquivo selecionado');

    resolveFdk('ZmRr');
    await recovery;
  });

  it('does not resurrect recovery cancelled while decrypting the FDK', async () => {
    const pending = {
      id: 15, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 9,
      total_chunks: 1, uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_15', fileName: 'selected.txt', type: 'upload', status: 'processing', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    let resolveFdk!: (value: string) => void;
    crypto.decryptName.and.returnValue(new Promise<string>(resolve => resolveFdk = resolve));
    const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.resolveTo();

    const recovery = store.recoverUpload('pending_15', pending as any, new File(['plain'], 'selected.txt'));
    await Promise.resolve();
    await store.cancelTransfer('pending_15');
    resolveFdk('ZmRr');
    await recovery;

    expect(runUploadLoop).not.toHaveBeenCalled();
    expect((store as any).activeUploads.size).toBe(0);
    expect((store as any).recoveringUploadFileIds.has('pending_15')).toBeFalse();
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
    expect(drive.hardDeleteFile).toHaveBeenCalledTimes(1);
    expect(store.transfers().find(item => item.id === 'pending_15')?.status).toBe('cancelled');
  });

  it('does not register or resume a recovery cancelled during encryption', async () => {
    const pending = {
      id: 26, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_26', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    const uploadedChunks = new Subject<{ uploaded_chunks: number[] }>();
    drive.getUploadedChunks.and.returnValue(uploadedChunks.asObservable());
    crypto.decryptName.and.resolveTo('ZmRr');
    const controller = new AbortController();
    (store as any).uploadControllers.set('pending_26', controller);
    const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.resolveTo();

    const recovery = store.recoverUpload('pending_26', pending as any, file);
    await Promise.resolve();

    const cancellation = store.cancelTransfer('pending_26');
    expect(controller.signal.aborted).toBeTrue();
    uploadedChunks.next({ uploaded_chunks: [] });
    uploadedChunks.complete();
    await cancellation;
    await recovery;

    expect(runUploadLoop).not.toHaveBeenCalled();
    expect((store as any).activeUploads.size).toBe(0);
    expect((store as any).recoveringUploadFileIds.has('pending_26')).toBeFalse();
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
    expect(drive.hardDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('aborts local metadata recovery and does not continue after cancellation', async () => {
    const pending = {
      id: 16, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_16', fileName: 'selected.txt', type: 'upload', status: 'processing', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    const prefix = new Subject<Blob>();
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(prefix.asObservable());
    crypto.decryptName.and.resolveTo('ZmRr');
    const recovery = store.recoverUpload('pending_16', pending as any, new File(['plain'], 'selected.txt'));
    await Promise.resolve();
    await Promise.resolve();

    await store.cancelTransfer('pending_16');
    await recovery;

    expect(prefix.observers.length).toBe(0);
    expect(kasumi.extractMetadata).not.toHaveBeenCalled();
    expect((store as any).activeUploads.size).toBe(0);
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a partial recovery has no chunk zero', async () => {
    const pending = {
      id: 17, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 3, uploaded_chunks_count: 2, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_17', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [1, 2] }));
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_17', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('Contexto criptográfico incompleto.');

    expect(drive.downloadPendingUploadRecoveryPrefix).not.toHaveBeenCalled();
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect((store as any).recoveringUploadFileIds.has('pending_17')).toBeFalse();
  });

  it('requires the original ciphertext context for a partial recovery', async () => {
    const pending = {
      id: 18, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_18', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(throwError(() => new Error('offline')));
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_18', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('offline');

    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(18, 99);
    expect(drive.downloadFileRange).not.toHaveBeenCalled();
    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('uses a fresh nonce for a local recovery with no uploaded chunks', async () => {
    const pending = {
      id: 21, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24,
      total_chunks: 1, uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_21', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    crypto.decryptName.and.resolveTo('ZmRr');
    const controller = new AbortController();
    (store as any).uploadControllers.set('pending_21', controller);
    kasumi.generateBaseNonce.and.returnValue(new Uint8Array(24).fill(0x31));
    const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
      (store as any).releaseTerminalUploadRuntime('pending_21');
    });

    await store.recoverUpload('pending_21', pending as any, file);

    expect(drive.getUploadedChunks).toHaveBeenCalledWith(21);
    expect(kasumi.generateBaseNonce).toHaveBeenCalledTimes(1);
    expect(runUploadLoop).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the partial ciphertext prefix is shorter than a nonce', async () => {
    const pending = {
      id: 22, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_22', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob([new Uint8Array(10)])));
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_22', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('Contexto criptográfico incompleto.');

    expect(kasumi.extractMetadata).not.toHaveBeenCalled();
    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('rejects a partial recovery when the selected file size differs from metadata', async () => {
    const pending = {
      id: 23, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_23', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob([new Uint8Array(100)])));
    kasumi.extractMetadata.and.resolveTo({ metadata: '{"thumb":"original"}', expectedSize: file.size + 1 } as any);
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_23', pending as any, file))
      .toBeRejectedWithError('O arquivo selecionado não corresponde ao upload pendente.');

    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('rejects a partial recovery when re-encryption changes ciphertext geometry', async () => {
    const pending = {
      id: 24, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 100,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_24', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob([new Uint8Array(100)])));
    kasumi.extractMetadata.and.resolveTo({ metadata: null, expectedSize: file.size } as any);
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_24', pending as any, file))
      .toBeRejectedWithError('O arquivo selecionado não reproduz o upload pendente.');

    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('reuses exact partial metadata and grows bounded prefix reads', async () => {
    const pending = {
      id: 19, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 1024 * 1024,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['1234567890'], 'selected.txt');
    const firstPrefix = new Uint8Array(128 * 1024).fill(7);
    const secondPrefix = new Uint8Array(1024 * 1024).fill(7);
    store.addTransfer({
      id: 'pending_19', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValues(of(new Blob([firstPrefix])), of(new Blob([secondPrefix])));
    let metadataAttempts = 0;
    kasumi.extractMetadata.and.callFake(async () => {
      metadataAttempts++;
      if (metadataAttempts === 1) {
        throw new Error('Partial blob is too small to contain the full metadata block');
      }
      return { metadata: '{"thumb":"exact-original"}', expectedSize: file.size, dataOffset: 123 };
    });
    kasumi.calculateEncryptedSize.and.returnValue(1024 * 1024);
    let capturedNonce: Uint8Array | undefined;
    let capturedMetadata: string | undefined;
    crypto.decryptName.and.resolveTo('ZmRr');
    const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
      const runtime = (store as any).activeUploads.get('pending_19_recovery');
      capturedNonce = new Uint8Array(runtime.plan.baseNonce);
      capturedMetadata = runtime.plan.rematerializationMetadata;
      (store as any).releaseTerminalUploadRuntime('pending_19');
    });

    await store.recoverUpload('pending_19', pending as any, file);

    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(19, 131071);
    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(19, 1048575);
    expect(drive.downloadFileRange).not.toHaveBeenCalledWith(19, jasmine.any(Number), jasmine.any(Number));
    expect(capturedNonce).toEqual(new Uint8Array(24).fill(7));
    expect(capturedMetadata).toBe('{"thumb":"exact-original"}');
    expect(runUploadLoop).toHaveBeenCalledTimes(1);
  });

  it('preserves contextual KAS2 metadata through pause, resume, and a second pause', async () => {
    const pending = {
      id: 29, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
      folder_id: null,
    };
    const file = new File([new Uint8Array(24)], 'selected.txt');
    const exactMetadata = '{  "version": 2, "extra": "✓", "thumb": "not-canonical" }';
    const baseNonce = new Uint8Array(24).fill(0x7a);
    store.addTransfer({
      id: 'pending_29', fileName: file.name, type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob([new Uint8Array(24).fill(7)])));
    crypto.decryptName.and.resolveTo('ZmRr');
    kasumi.extractMetadata.and.resolveTo({ metadata: exactMetadata, expectedSize: file.size } as any);
    kasumi.extractBaseNonce.and.resolveTo(baseNonce);
    const uploadEngine = TestBed.inject(UploadEngineService);
    spyOn(uploadEngine, 'executeLocal').and.returnValues(
      Promise.resolve({ paused: true }),
      Promise.resolve({ paused: true }),
      Promise.resolve({ paused: false }),
    );

    await store.recoverUpload('pending_29', pending as any, file);

    const firstPause = (store as any).activeUploads.get('pending_29_recovery');
    expect(firstPause.provider).toBe('local');
    expect(firstPause.plan.rematerializationMetadata).toBe(exactMetadata);
    expect('encryptedBlob' in firstPause.plan).toBeFalse();

    await store.resumeUpload('pending_29');

    const secondPause = (store as any).activeUploads.get('pending_29_recovery');
    expect(secondPause.provider).toBe('local');
    expect(secondPause.plan.rematerializationMetadata).toBe(exactMetadata);

    await store.resumeUpload('pending_29');

    expect(uploadEngine.executeLocal).toHaveBeenCalledTimes(3);
    expect((uploadEngine.executeLocal as jasmine.Spy).calls.argsFor(1)[0].baseNonce).toBe(firstPause.plan.baseNonce);
    expect((uploadEngine.executeLocal as jasmine.Spy).calls.argsFor(2)[0].baseNonce).toBe(firstPause.plan.baseNonce);
    expect((store as any).activeUploads.has('pending_29_recovery')).toBeFalse();
  });

  it('stops bounded prefix recovery after repeated partial metadata failures', async () => {
    const pending = {
      id: 27, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 4 * 1024 * 1024,
      total_chunks: 1, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    store.addTransfer({
      id: 'pending_27', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValues(
      of(new Blob([new Uint8Array(128 * 1024)])),
      of(new Blob([new Uint8Array(1024 * 1024)])),
      of(new Blob([new Uint8Array(4 * 1024 * 1024)])),
    );
    kasumi.extractMetadata.and.rejectWith(new Error('partial blob'));
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_27', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('partial blob');

    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledTimes(3);
    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(27, 131071);
    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(27, 1048575);
    expect(drive.downloadPendingUploadRecoveryPrefix).toHaveBeenCalledWith(27, 4194303);
    expect(drive.downloadFileRange).not.toHaveBeenCalledWith(27, jasmine.any(Number), jasmine.any(Number));
  });

  it('rejects a partial recovery when total chunk geometry differs', async () => {
    const pending = {
      id: 28, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24,
      total_chunks: 2, uploaded_chunks_count: 1, storage_provider: 'local', external_storage_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_28', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    drive.downloadPendingUploadRecoveryPrefix.and.returnValue(of(new Blob([new Uint8Array(100)])));
    kasumi.extractMetadata.and.resolveTo({ metadata: null, expectedSize: file.size } as any);
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_28', pending as any, file))
      .toBeRejectedWithError('Geometria de chunks incompatível com o upload pendente.');

    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('uses fresh Google recovery context without creating a new logical file', async () => {
    const pending = {
      id: 20, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24,
      total_chunks: 1, uploaded_chunks_count: 0, storage_provider: 'google_drive', external_storage_id: 42,
      folder_id: null,
    };
    const file = new File(['plain'], 'selected.txt');
    store.addTransfer({
      id: 'pending_20', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getExternalUploadRecoveryContext.and.returnValue(of({
      storage_provider: 'google_drive', external_storage_id: 42,
      name_hash: 'opaque-hash',
    }));
    crypto.decryptName.and.resolveTo('ZmRr');
    const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
      const upload = (store as any).activeUploads.get('pending_20_recovery');
      expect(upload.fileId).toBe(20);
      expect(upload.provider).toBe('google_drive');
      expect(upload.plan.nameHash).toBe('opaque-hash');
      expect(upload.plan.baseNonce).toEqual(jasmine.any(Uint8Array));
      expect('encryptedBlob' in upload.plan).toBeFalse();
      (store as any).releaseTerminalUploadRuntime('pending_20');
    });

    await store.recoverUpload('pending_20', pending as any, file);

    expect(drive.getExternalUploadRecoveryContext).toHaveBeenCalledWith(20);
    expect(runUploadLoop).toHaveBeenCalledTimes(1);
    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('keeps a Google pending recovery when its recovery context is unavailable', async () => {
    const pending = {
      id: 25, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 9,
      total_chunks: 1, uploaded_chunks_count: 0, storage_provider: 'google_drive', external_storage_id: 42,
    };
    store.addTransfer({
      id: 'pending_25', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getExternalUploadRecoveryContext.and.returnValue(throwError(() => new Error('context unavailable')));
    crypto.decryptName.and.resolveTo('ZmRr');

    await expectAsync(store.recoverUpload('pending_25', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('context unavailable');

    expect((store as any).activeUploads.size).toBe(0);
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(store.transfers().find(item => item.id === 'pending_25')?.status).toBe('error');
  });

  it('aborts a Google recovery while its context request is pending', async () => {
    const pending = {
      id: 29, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 9,
      total_chunks: 1, uploaded_chunks_count: 0, storage_provider: 'google_drive', external_storage_id: 42,
    };
    const context = new Subject<any>();
    store.addTransfer({
      id: 'pending_29', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    drive.getExternalUploadRecoveryContext.and.returnValue(context.asObservable());
    crypto.decryptName.and.resolveTo('ZmRr');

    const recovery = store.recoverUpload('pending_29', pending as any, new File(['plain'], 'selected.txt'));
    await Promise.resolve();
    await Promise.resolve();
    await store.cancelTransfer('pending_29');
    context.next({
      storage_provider: 'google_drive', external_storage_id: 42,
      name_hash: 'hash',
    });
    context.complete();
    await recovery;

    expect(context.observers.length).toBe(0);
    expect((store as any).activeUploads.size).toBe(0);
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
  });

  it('preserves an active recovery while the Local plan is pending', async () => {
    const pending = { id: 10, encrypted_name: 'pending', encrypted_fdk: 'fdk', size_bytes: 24, total_chunks: 1, uploaded_chunks_count: 0 };
    store.addTransfer({
      id: 'pending_10', fileName: 'selected.txt', type: 'upload', status: 'processing', progress: 0,
      statusMessage: 'Recuperando contexto de criptografia...', isRecovery: true, pendingData: pending as any,
    });
    const uploadedChunks = new Subject<{ uploaded_chunks: number[] }>();
    drive.getUploadedChunks.and.returnValue(uploadedChunks.asObservable());
    crypto.decryptName.and.resolveTo('ZmRr');
    spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
      (store as any).releaseTerminalUploadRuntime('pending_10');
    });

    const recovery = store.recoverUpload('pending_10', pending as any, new File(['plain'], 'selected.txt'));
    await Promise.resolve();
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));
    await store.loadPendingUploads();

    expect(store.transfers().filter(transfer => transfer.id === 'pending_10')).toHaveSize(1);
    expect(store.transfers().find(transfer => transfer.id === 'pending_10')?.statusMessage)
      .toBe('Recuperando contexto de criptografia...');

    uploadedChunks.next({ uploaded_chunks: [] });
    uploadedChunks.complete();
    await recovery;
  });

  it('does not duplicate a paused recovery represented by activeUploads', async () => {
    const pending = { id: 11, encrypted_name: 'pending', total_chunks: 1, uploaded_chunks_count: 1 };
    store.addTransfer({
      id: 'pending_11', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 50,
      statusMessage: 'Pausado', isRecovery: true, pendingData: pending as any,
    });
    (store as any).activeUploads.set('pending_11_recovery', {
      provider: 'local',
      transferId: 'pending_11', file: new File(['plain'], 'selected.txt'), fileId: 11,
      folderId: null, isHiddenProxy: false,
      plan: { fdk: new Uint8Array([1]), baseNonce: new Uint8Array(24) },
    });
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    await store.loadPendingUploads();

    expect(store.transfers().filter(transfer => transfer.id === 'pending_11')).toHaveSize(1);
  });

  it('keeps an active recovery when a pending snapshot temporarily omits it', async () => {
    store.addTransfer({
      id: 'pending_12', fileName: 'selected.txt', type: 'upload', status: 'processing', progress: 20,
      statusMessage: 'Enviando...', isRecovery: true, pendingData: { id: 12 } as any,
    });
    (store as any).recoveringUploadFileIds.set('pending_12', 12);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));

    await store.loadPendingUploads();

    expect(store.transfers().filter(transfer => transfer.id === 'pending_12')).toHaveSize(1);
  });

  it('releases recovery ownership after terminal preparation failure without deleting backend state', async () => {
    const pending = { id: 13, encrypted_name: 'orphan', encrypted_fdk: 'fdk', size_bytes: 24, total_chunks: 1, uploaded_chunks_count: 0 };
    store.addTransfer({
      id: 'pending_13', fileName: 'selected.txt', type: 'upload', status: 'paused', progress: 0,
      isRecovery: true, pendingData: pending as any,
    });
    crypto.decryptName.and.resolveTo('ZmRr');
    kasumi.generateBaseNonce.and.callFake(() => { throw new Error('wrong file'); });

    await expectAsync(store.recoverUpload('pending_13', pending as any, new File(['plain'], 'selected.txt')))
      .toBeRejectedWithError('wrong file');

    expect((store as any).recoveringUploadFileIds.has('pending_13')).toBeFalse();
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));
    await store.loadPendingUploads();
    expect(store.transfers().filter(transfer => transfer.id === 'pending_13')).toHaveSize(1);
  });

  it('cleans recovery ownership once on explicit cancellation', async () => {
    const pending = { id: 14, encrypted_name: 'orphan', total_chunks: 1, uploaded_chunks_count: 0 };
    store.addTransfer({
      id: 'pending_14', fileName: 'selected.txt', type: 'upload', status: 'processing', progress: 20,
      isRecovery: true, pendingData: pending as any,
    });
    (store as any).recoveringUploadFileIds.set('pending_14', 14);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));

    await store.cancelTransfer('pending_14');

    expect((store as any).recoveringUploadFileIds.has('pending_14')).toBeFalse();
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
    expect(drive.hardDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a completed file from a stale pending snapshot', async () => {
    const pending = { id: 42, encrypted_name: 'completed', total_chunks: 1, uploaded_chunks_count: 0 };
    let resolveName!: (value: string) => void;
    crypto.decryptName.and.returnValue(new Promise<string>(resolve => resolveName = resolve));
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    const loading = store.loadPendingUploads();
    await Promise.resolve();
    (store as any).files.set([{
      id: 42, isFolder: false, type: 'unknown', encryptedName: 'completed', decryptedName: 'completed',
    }]);
    resolveName('completed');
    await loading;

    expect(store.transfers().some(transfer => transfer.id === 'pending_42')).toBeFalse();
  });

  it('does not let a folder with the same id hide a pending file', async () => {
    (store as any).files.set([{ id: 42, isFolder: true }]);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 42, encrypted_name: 'file', total_chunks: 1, uploaded_chunks_count: 0 },
    ] }));

    await store.loadPendingUploads();

    expect(store.transfers().filter(transfer => transfer.id === 'pending_42')).toHaveSize(1);
  });

  it('filters completed files while retaining unrelated orphan recoveries', async () => {
    (store as any).files.set([{ id: 42, isFolder: false }]);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [
      { id: 42, encrypted_name: 'completed', total_chunks: 1, uploaded_chunks_count: 0 },
      { id: 43, encrypted_name: 'orphan', total_chunks: 1, uploaded_chunks_count: 0 },
    ] }));

    await store.loadPendingUploads();

    expect(store.transfers().some(transfer => transfer.id === 'pending_42')).toBeFalse();
    expect(store.transfers().some(transfer => transfer.id === 'pending_43')).toBeTrue();
  });

  it('serializes pending upload synchronization and preserves the rejection', async () => {
    const loadPendingUploads = spyOn(store, 'loadPendingUploads').and.resolveTo();

    await (store as any).syncPendingUploads();
    expect(loadPendingUploads).toHaveBeenCalledTimes(1);

    loadPendingUploads.and.rejectWith(new Error('offline'));
    await expectAsync((store as any).syncPendingUploads()).toBeRejectedWithError('offline');
    await (store as any).syncPendingUploads().catch(() => undefined);
    expect(loadPendingUploads).toHaveBeenCalledTimes(3);
  });

  it('ignora a resposta de pendências que chega após o detach da sessão', async () => {
    const response = new Subject<any>();
    drive.getPendingUploads.and.returnValue(response.asObservable());
    const decryptName = crypto.decryptName;
    const loading = store.loadPendingUploads();

    (store as any).resetUploadRuntimeState();
    response.next({ pending_uploads: [{ id: 77, encrypted_name: 'old-name', total_chunks: 1, uploaded_chunks_count: 0 }] });
    response.complete();
    await loading;

    expect(decryptName).not.toHaveBeenCalled();
    expect(store.transfers()).toEqual([]);
  });

  it('não publica o nome decifrado se o detach ocorrer durante a decifragem', async () => {
    let resolveName!: (value: string) => void;
    crypto.decryptName.and.returnValue(new Promise<string>(resolve => { resolveName = resolve; }));
    drive.getPendingUploads.and.returnValue(of({
      pending_uploads: [{ id: 78, encrypted_name: 'old-name', total_chunks: 1, uploaded_chunks_count: 0 }],
    }));

    const loading = store.loadPendingUploads();
    await Promise.resolve();
    (store as any).resetUploadRuntimeState();
    resolveName('old plaintext');
    await loading;

    expect(store.transfers()).toEqual([]);
  });

  it('A19M2-PENDING-001 mantém a recuperação com rótulo seguro quando o lock cruza a decifragem', async () => {
    const pending = { id: 81, encrypted_name: 'old-name', total_chunks: 2, uploaded_chunks_count: 1 };
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    crypto.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    const loading = store.loadPendingUploads();
    await decryptStarted.promise;
    store.clearDecryptedPresentationData();
    decrypt.resolve('nome-secreto.txt');
    await loading;

    expect(store.transfers()).toEqual([jasmine.objectContaining({
      id: 'pending_81',
      fileName: 'Arquivo Desconhecido',
      status: 'paused',
      progress: 50,
      isRecovery: true,
      pendingData: pending,
    })]);
  });

  it('A19M2-PENDING-002 não tenta decifrar uma pendência quando a apresentação já está bloqueada', async () => {
    const pending = { id: 82, encrypted_name: 'locked-name', total_chunks: 1, uploaded_chunks_count: 0 };
    crypto.isVaultUnlocked.and.returnValue(false);
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    await store.loadPendingUploads();

    expect(crypto.decryptName).not.toHaveBeenCalled();
    expect(store.transfers()[0]).toEqual(jasmine.objectContaining({
      id: 'pending_82',
      fileName: 'Arquivo Desconhecido',
      pendingData: pending,
    }));
  });

  it('A19M2-PENDING-003 publica o nome da recuperação enquanto a apresentação está desbloqueada', async () => {
    const pending = { id: 83, encrypted_name: 'encrypted-name', total_chunks: 1, uploaded_chunks_count: 0 };
    crypto.decryptName.and.resolveTo('nome-atual.txt');
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    await store.loadPendingUploads();

    expect(store.transfers()[0]).toEqual(jasmine.objectContaining({
      id: 'pending_83',
      fileName: 'nome-atual.txt',
    }));
  });

  it('A19M2-PENDING-004 descarta a publicação quando o logout invalida o runtime durante a decifragem', async () => {
    const pending = { id: 84, encrypted_name: 'logout-name', total_chunks: 1, uploaded_chunks_count: 0 };
    let resolveName!: (value: string) => void;
    crypto.decryptName.and.returnValue(new Promise<string>(resolve => resolveName = resolve));
    drive.getPendingUploads.and.returnValue(of({ pending_uploads: [pending] }));

    const loading = store.loadPendingUploads();
    await Promise.resolve();
    store.resetUploadRuntimeState();
    resolveName('nome-obsoleto.txt');
    await loading;

    expect(store.transfers()).toEqual([]);
  });

  it('A19M2-PENDING-005 redige apenas a apresentação da recuperação e preserva o runtime de upload', () => {
    store.addTransfer({
      id: 'pending-85', fileName: 'recuperacao-secreta.txt', type: 'upload', status: 'paused', progress: 40,
      isRecovery: true, pendingData: { id: 85, encrypted_name: 'encrypted' } as any,
    });
    store.addTransfer({
      id: 'active-upload', fileName: 'upload-ativo.txt', type: 'upload', status: 'processing', progress: 40,
    });
    (store as any).uploadInitializedFileIds.set('active-upload', new Set([86]));
    const generation = (store as any).uploadRuntimeGeneration;

    store.clearDecryptedPresentationData();

    expect(store.transfers()).toEqual([
      jasmine.objectContaining({ id: 'active-upload', fileName: 'upload-ativo.txt', status: 'processing' }),
      jasmine.objectContaining({ id: 'pending-85', fileName: 'Arquivo Desconhecido', isRecovery: true }),
    ]);
    expect((store as any).uploadRuntimeGeneration).toBe(generation);
    expect((store as any).uploadInitializedFileIds.has('active-upload')).toBeTrue();
  });

  it('A19M2-PENDING-006 reidrata o rótulo da recuperação após um novo unlock', async () => {
    store.addTransfer({
      id: 'pending-87', fileName: 'Arquivo Desconhecido', type: 'upload', status: 'paused', progress: 20,
      isRecovery: true, pendingData: { id: 87, encrypted_name: 'encrypted-recovery' } as any,
    });
    store.clearDecryptedPresentationData();
    crypto.decryptName.and.resolveTo('recuperacao-restaurada.txt');

    await store.reDecryptAll();

    expect(store.transfers().find(transfer => transfer.id === 'pending-87')?.fileName)
      .toBe('recuperacao-restaurada.txt');
  });

  it('A19M3-PENDING-007 redige o rótulo de uma recuperação concluída pela proveniência pendente', () => {
    const pendingData = {
      id: 89, folder_id: null, encrypted_name: 'encrypted-completed-name', size_bytes: 123,
      total_chunks: 1, encrypted_fdk: 'encrypted-fdk', uploaded_chunks_count: 1,
      storage_provider: 'local', external_storage_id: null,
    } as any;
    store.addTransfer({
      id: 'pending-89', fileName: 'financeiro-2026.xlsx', type: 'upload', status: 'success', progress: 100,
      isRecovery: false, pendingData,
    });

    store.clearDecryptedPresentationData();

    expect(store.transfers()).toEqual([jasmine.objectContaining({
      id: 'pending-89', fileName: 'Arquivo Desconhecido', type: 'upload', status: 'success', progress: 100,
      isRecovery: false, pendingData,
    })]);
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
  });

  it('A19M3-UPLOAD-001 preserva o rótulo de um upload comum no lock manual', () => {
    store.addTransfer({
      id: 'ordinary-upload', fileName: 'foto-local.jpg', type: 'upload', status: 'success', progress: 100,
    });

    store.clearDecryptedPresentationData();

    expect(store.transfers().find(transfer => transfer.id === 'ordinary-upload')?.fileName)
      .toBe('foto-local.jpg');
  });

  it('A19M2-REDECRYPT-002 não publica rótulo de recuperação após a apresentação ficar obsoleta', async () => {
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    store.addTransfer({
      id: 'pending-88', fileName: 'Arquivo Desconhecido', type: 'upload', status: 'paused', progress: 20,
      isRecovery: true, pendingData: { id: 88, encrypted_name: 'encrypted-recovery' } as any,
    });
    crypto.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });

    const reDecrypting = store.reDecryptAll();
    await decryptStarted.promise;
    store.clearDecryptedPresentationData();
    decrypt.resolve('rótulo-obsoleto.txt');
    await reDecrypting;

    expect(store.transfers().find(transfer => transfer.id === 'pending-88')?.fileName)
      .toBe('Arquivo Desconhecido');
  });

  it('não deixa uma sincronização antiga recapturar a geração nova', async () => {
    const firstGate = deferred<void>();
    const loadPendingUploads = spyOn(store, 'loadPendingUploads').and.returnValue(firstGate.promise);
    const first = (store as any).syncPendingUploads();
    const second = (store as any).syncPendingUploads();

    (store as any).resetUploadRuntimeState();
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(loadPendingUploads).not.toHaveBeenCalled();
  });

  it('reconciles pending uploads after batch and single-upload failures', async () => {
    const coordinator = TestBed.inject(UploadBatchCoordinatorService);
    const loadPendingUploads = spyOn(store, 'loadPendingUploads').and.resolveTo();
    spyOn(coordinator, 'upload').and.callFake((candidates, callbacks) => {
      callbacks.onResult({
        transferId: candidates[0].transferId,
        status: 'error',
        error: new Error('batch failed'),
      });
      return Promise.resolve({ total: 1, succeeded: 0, paused: 0, cancelled: 0, failed: 1 });
    });

    await (store as any).uploadBatchFiles([{ file: new File(['x'], 'x.txt'), folderId: null }], false);
    await Promise.resolve();

    const uploadEngine = TestBed.inject(UploadEngineService);
    spyOn(uploadEngine, 'planUpload').and.rejectWith(new Error('single failed'));
    await expectAsync((store as any)._uploadSingleFile(new File(['x'], 'x.txt'), null, false, 'single', false))
      .toBeRejectedWithError('single failed');
    expect(loadPendingUploads).toHaveBeenCalledTimes(2);
  });

  it('routes WebM through the individual upload path while MP4 remains directly batchable', async () => {
    store.setStorageProvider('local');
    const webm = new File(['webm'], 'movie.webm', { type: 'video/webm' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const other = new File(['other'], 'other.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.callFake(file => file.name.toLowerCase().endsWith('.webm'));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => file.name.toLowerCase().endsWith('.mp4'));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 2, succeeded: 2, paused: 0, cancelled: 0, failed: 0 });

    await store.uploadFiles([webm, text, other]);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.calls.mostRecent().args[0]).toBe(webm);
    expect(uploadBatch).toHaveBeenCalledOnceWith(jasmine.arrayContaining([
      jasmine.objectContaining({ file: text }),
      jasmine.objectContaining({ file: other }),
    ]));
  });

  it('routes a MIME-less WebM through the existing individual transcode path', async () => {
    const original = new File(['webm'], 'movie.webm');
    const converted = new File(['mp4'], 'movie_proxy.mp4', { type: 'video/mp4' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    const productionPolicy = new VideoTranscoderService();
    transcoder.isVideo.and.callFake(file => productionPolicy.isVideo(file));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => productionPolicy.isStreamingFormatSupported(file));
    transcoder.transcodeToProxy.and.resolveTo(converted);
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();

    await (store as any)._doUpload(original, null, false, undefined, 'mime-less-webm');

    expect(transcoder.transcodeToProxy).toHaveBeenCalledOnceWith(original, 'pure', jasmine.any(Function), (store as any).uploadControllers.get('mime-less-webm').signal);
    const uploadedFile = upload.calls.mostRecent().args[0] as File;
    expect(uploadedFile.name).toBe('movie.webm');
    expect(uploadedFile.type).toBe('video/mp4');
  });

  it('preserves a MIME-less WebM when the existing transcode fallback fails', async () => {
    const original = new File(['webm'], 'movie.webm');
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    const productionPolicy = new VideoTranscoderService();
    transcoder.isVideo.and.callFake(file => productionPolicy.isVideo(file));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => productionPolicy.isStreamingFormatSupported(file));
    transcoder.transcodeToProxy.and.rejectWith(new Error('ffmpeg failed'));
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();

    await (store as any)._doUpload(original, null, false, undefined, 'mime-less-webm-fallback');

    expect(transcoder.transcodeToProxy).toHaveBeenCalledOnceWith(original, 'pure', jasmine.any(Function), (store as any).uploadControllers.get('mime-less-webm-fallback').signal);
    expect(upload).toHaveBeenCalledOnceWith(original, null, false, 'mime-less-webm-fallback', false, false, 0);
    expect(original.type).toBe('');
  });

  it('routes a MIME-less WebM to individual upload during a mixed multi-upload', async () => {
    store.setStorageProvider('local');
    const webm = new File(['webm'], 'movie.webm');
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const other = new File(['other'], 'other.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    const productionPolicy = new VideoTranscoderService();
    transcoder.isVideo.and.callFake(file => productionPolicy.isVideo(file));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => productionPolicy.isStreamingFormatSupported(file));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 2, succeeded: 2, paused: 0, cancelled: 0, failed: 0 });

    await store.uploadFiles([webm, text, other]);

    expect(uploadFile).toHaveBeenCalledOnceWith(webm, null, true, jasmine.any(String), jasmine.any(String));
    expect(uploadBatch).toHaveBeenCalledOnceWith(jasmine.arrayContaining([
      jasmine.objectContaining({ file: text }),
      jasmine.objectContaining({ file: other }),
    ]));
  });

  it('routes a MIME-less WebM to individual upload during a folder upload', async () => {
    store.setStorageProvider('local');
    const webm = new File(['webm'], 'movie.webm');
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    const productionPolicy = new VideoTranscoderService();
    transcoder.isVideo.and.callFake(file => productionPolicy.isVideo(file));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => productionPolicy.isStreamingFormatSupported(file));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 1, succeeded: 1, paused: 0, cancelled: 0, failed: 0 });
    spyOn<any>(store, 'flushTreeReconciliation').and.resolveTo();
    spyOn(store, 'loadQuota').and.resolveTo();

    await (store as any).uploadFolderCandidates(
      [{ file: webm, folderId: 7 }, { file: text, folderId: 7 }],
      'folder-upload',
      ['webm-transfer', 'text-transfer'],
      'folder-group',
    );

    expect(uploadFile).toHaveBeenCalledOnceWith(webm, 7, false, 'folder-group', 'webm-transfer');
    expect(uploadBatch).toHaveBeenCalledOnceWith([
      jasmine.objectContaining({ file: text, folderId: 7, groupId: 'folder-group', transferId: 'text-transfer' }),
    ], false);
  });

  it('keeps MP4 in the batch path without invoking the transcoder', async () => {
    store.setStorageProvider('local');
    const mp4 = new File(['mp4'], 'movie.mp4', { type: 'video/mp4' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.callFake(file => file.type.startsWith('video/'));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => file.name.toLowerCase().endsWith('.mp4'));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 2, succeeded: 2, paused: 0, cancelled: 0, failed: 0 });

    await store.uploadFiles([mp4, text]);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(uploadBatch).toHaveBeenCalledOnceWith(jasmine.arrayContaining([
      jasmine.objectContaining({ file: mp4 }),
      jasmine.objectContaining({ file: text }),
    ]));
    expect(transcoder.transcodeToProxy).not.toHaveBeenCalled();
  });

  it('routes a folder WebM through individual conversion while preserving the folder batch path', async () => {
    store.setStorageProvider('local');
    const webm = new File(['webm'], 'movie.webm', { type: 'video/webm' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.callFake(file => file.name.toLowerCase().endsWith('.webm'));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => file.name.toLowerCase().endsWith('.mp4'));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 1, succeeded: 1, paused: 0, cancelled: 0, failed: 0 });
    spyOn<any>(store, 'flushTreeReconciliation').and.resolveTo();
    spyOn(store, 'loadQuota').and.resolveTo();

    await (store as any).uploadFolderCandidates(
      [{ file: webm, folderId: 7 }, { file: text, folderId: 7 }],
      'folder-upload',
      ['webm-transfer', 'text-transfer'],
      'folder-group',
    );

    expect(uploadFile).toHaveBeenCalledOnceWith(webm, 7, false, 'folder-group', 'webm-transfer');
    expect(uploadBatch).toHaveBeenCalledOnceWith([
      jasmine.objectContaining({ file: text, folderId: 7, groupId: 'folder-group', transferId: 'text-transfer' }),
    ], false);
  });

  it('keeps a folder MP4 in the existing batch path', async () => {
    store.setStorageProvider('local');
    const mp4 = new File(['mp4'], 'movie.mp4', { type: 'video/mp4' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.callFake(file => file.type.startsWith('video/'));
    (transcoder as any).isStreamingFormatSupported.and.callFake((file: File) => file.name.toLowerCase().endsWith('.mp4'));
    const uploadFile = spyOn(store, 'uploadFile').and.resolveTo();
    const uploadBatch = spyOn<any>(store, 'uploadBatchFiles').and.resolveTo({ total: 2, succeeded: 2, paused: 0, cancelled: 0, failed: 0 });
    spyOn<any>(store, 'flushTreeReconciliation').and.resolveTo();
    spyOn(store, 'loadQuota').and.resolveTo();

    await (store as any).uploadFolderCandidates(
      [{ file: mp4, folderId: 7 }, { file: text, folderId: 7 }],
      'folder-upload',
      ['mp4-transfer', 'text-transfer'],
      'folder-group',
    );

    expect(uploadFile).not.toHaveBeenCalled();
    expect(uploadBatch).toHaveBeenCalledOnceWith([
      jasmine.objectContaining({ file: mp4, folderId: 7, groupId: 'folder-group', transferId: 'mp4-transfer' }),
      jasmine.objectContaining({ file: text, folderId: 7, groupId: 'folder-group', transferId: 'text-transfer' }),
    ], false);
  });

  it('transcodes a WebM before upload while preserving its original filename', async () => {
    const original = new File(['webm'], 'movie.webm', { type: 'video/webm' });
    const converted = new File(['mp4'], 'movie_proxy.mp4', { type: 'video/mp4' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.returnValue(true);
    (transcoder as any).isStreamingFormatSupported.and.returnValue(false);
    transcoder.transcodeToProxy.and.resolveTo(converted);
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();

    await (store as any)._doUpload(original, null, false, undefined, 'webm-transfer');

    expect(transcoder.transcodeToProxy).toHaveBeenCalledOnceWith(original, 'pure', jasmine.any(Function), (store as any).uploadControllers.get('webm-transfer').signal);
    const uploadedFile = upload.calls.mostRecent().args[0] as File;
    expect(uploadedFile.name).toBe('movie.webm');
    expect(uploadedFile.type).toBe('video/mp4');
  });

  it('falls back to the original WebM when transcoding fails', async () => {
    const original = new File(['webm'], 'movie.webm', { type: 'video/webm' });
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.returnValue(true);
    (transcoder as any).isStreamingFormatSupported.and.returnValue(false);
    transcoder.transcodeToProxy.and.rejectWith(new Error('ffmpeg failed'));
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();

    await (store as any)._doUpload(original, null, false, undefined, 'webm-fallback');

    expect(upload).toHaveBeenCalledOnceWith(original, null, false, 'webm-fallback', false, false, 0);
  });

  it('B.92 forwards the exact upload signal and cancels transcode without original-upload fallback', async () => {
    const id = 'b92-transcode-cancel';
    const controller = new AbortController();
    (store as any).uploadControllers.set(id, controller);
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.returnValue(true);
    (transcoder as any).isStreamingFormatSupported.and.returnValue(false);
    let signal: AbortSignal | undefined;
    let abortObserved = false;
    let reject!: (error: unknown) => void;
    transcoder.transcodeToProxy.and.callFake((...args: any[]) => {
      signal = args[3];
      return new Promise<File>((_resolve, rejectTranscode) => {
        reject = rejectTranscode;
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(new DOMException('synthetic cancellation', 'AbortError'));
        }, { once: true });
      });
    });
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();
    const plan = spyOn(TestBed.inject(UploadEngineService), 'planUpload').and.callThrough();
    const log = spyOn(console, 'error');
    const operation = (store as any)._doUpload(new File(['video'], 'synthetic.webm'), null, false, undefined, id);
    (store as any).uploadOperations.set(id, operation);
    const outcome = operation.then(() => 'SUCCESS', (error: Error) => error.name);

    expect(signal).toBe(controller.signal);
    const cancellation = store.cancelTransfer(id);
    expect(controller.signal.aborted).toBeTrue();
    expect(abortObserved).toBeTrue();
    // Settle the unbound pre-patch fake too; missing propagation remains an explicit RED.
    if (!signal) reject(new DOMException('synthetic cancellation', 'AbortError'));
    await cancellation;

    expect(await outcome).toBe('AbortError');
    expect(store.transfers().find(item => item.id === id)?.status).toBe('cancelled');
    expect(upload).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(drive.initFileUpload).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('B.92 propagates a transcode AbortError instead of falling back to the original', async () => {
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.returnValue(true);
    (transcoder as any).isStreamingFormatSupported.and.returnValue(false);
    const cancellation = new DOMException('synthetic cancellation', 'AbortError');
    transcoder.transcodeToProxy.and.rejectWith(cancellation);
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();
    const log = spyOn(console, 'error');

    await expectAsync((store as any)._doUpload(new File(['video'], 'synthetic.webm'), null, false))
      .toBeRejectedWith(cancellation);
    expect(upload).not.toHaveBeenCalled();
    expect(drive.initFileUpload).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('B.92 runtime reset aborts the active transcode and blocks old transfer publication', async () => {
    const id = 'b92-transcode-reset';
    const transcoder = TestBed.inject(VideoTranscoderService) as jasmine.SpyObj<VideoTranscoderService>;
    transcoder.isVideo.and.returnValue(true);
    (transcoder as any).isStreamingFormatSupported.and.returnValue(false);
    let signal: AbortSignal | undefined;
    let reject!: (error: unknown) => void;
    transcoder.transcodeToProxy.and.callFake((...args: any[]) => {
      signal = args[3];
      return new Promise<File>((_resolve, rejectTranscode) => {
        reject = rejectTranscode;
        signal?.addEventListener('abort', () => reject(new DOMException('synthetic reset', 'AbortError')), { once: true });
      });
    });
    const upload = spyOn<any>(store, '_uploadSingleFile').and.resolveTo();
    const operation = (store as any)._doUpload(new File(['video'], 'synthetic.webm'), null, false, undefined, id);
    const outcome = operation.then(() => 'SUCCESS', (error: Error) => error.name);
    expect(signal).toBe((store as any).uploadControllers.get(id).signal);

    store.resetUploadRuntimeState();
    expect(signal?.aborted).toBeTrue();
    if (!signal) reject(new DOMException('synthetic reset', 'AbortError'));
    expect(await outcome).toBe('AbortError');
    expect(store.transfers().some(item => item.id === id)).toBeFalse();
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not start a Google upload when no Drive account is linked', async () => {
    store.setStorageProvider('google_drive');
    drive.getLinkedGoogleAccounts.and.returnValue(of({ accounts: [] }));

    await expectAsync(store.uploadFile(new File(['x'], 'x.txt')))
      .toBeRejectedWithError('Conta Google Drive não vinculada. Vincule uma conta nas configurações antes de enviar arquivos.');
    expect(drive.getLinkedGoogleAccounts).toHaveBeenCalledTimes(1);
  });

  describe('B.47 replacement characterization', () => {
    const replacementFile = (): DriveFile => ({
      id: 701,
      isFolder: false,
      encryptedName: 'old-cipher',
      decryptedName: 'replace.txt',
      type: 'unknown',
      sizeBytes: 4,
      sizeFormatted: '4 B',
      modifiedAt: '',
      owner: 'me',
      encryptedFdk: 'old-fdk',
      folderId: null,
      storageProvider: 'local',
      externalStorageId: null,
    });

    const prepared = (file: File) => ({
      file,
      encryptedName: 'new-cipher',
      nameHash: 'new-hash',
      encryptedFdk: 'new-fdk',
      fdk: new Uint8Array(32).fill(47),
      totalChunks: 1,
      encryptedSize: 6,
    });

    const configureReplacement = (secondInit: Observable<{ file_id: number }>) => {
      const file = new File(['new'], 'replace.txt', { type: 'text/plain' });
      store.setStorageProvider('local');
      const uploadEngine = TestBed.inject(UploadEngineService);
      spyOn(uploadEngine, 'planUpload').and.resolveTo(prepared(file) as any);
      drive.initFileUpload.and.returnValues(
        throwError(() => new HttpErrorResponse({ status: 409 })),
        secondInit as any,
      );
      store.files.set([replacementFile()]);
      return file;
    };

    it('keeps the old file untouched when replacement is declined', async () => {
      dialog.confirm.and.resolveTo(false);
      const file = configureReplacement(of({ file_id: 702 }));

      await store.uploadFile(file, null, false, undefined, 'b47-replace-declined');

      expect(drive.trashFile).not.toHaveBeenCalled();
      expect(drive.hardDeleteFile).not.toHaveBeenCalled();
      expect(drive.initFileUpload).toHaveBeenCalledTimes(1);
    });

    it('does not hard-delete OLD while the NEW replacement is pending', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      let releaseReplacement!: () => void;
      let replacementStarted!: () => void;
      const replacementPending = new Promise<void>(resolve => { releaseReplacement = resolve; });
      const replacementStartedPromise = new Promise<void>(resolve => { replacementStarted = resolve; });
      const upload = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        replacementStarted();
        await replacementPending;
      });
      const doUpload = spyOn(store as any, '_doUpload').and.callThrough();

      const replacement = store.uploadFile(file, null, false, undefined, 'b47-replace-pending');
      await replacementStartedPromise;

      expect(drive.trashFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      const firstOperation = (doUpload.calls.all()[0] as any).returnValue;
      expect((store as any).uploadOperations.get('b47-replace-pending')).not.toBe(firstOperation);
      expect(upload).toHaveBeenCalledTimes(1);

      releaseReplacement();
      await replacement;
    });

    it('restores OLD when NEW fails before initialization and preserves the error', async () => {
      dialog.confirm.and.resolveTo(true);
      const expected = new HttpErrorResponse({ status: 500, error: { error: 'new failed' } });
      const file = configureReplacement(throwError(() => expected));

      await expectAsync(store.uploadFile(file, null, false, undefined, 'b47-replace-failed'))
        .toBeRejectedWith(expected);

      expect(drive.trashFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(drive.restoreFile).toHaveBeenCalledWith(701);
    });

    it('cleans an initialized NEW before restoring OLD when replacement fails', async () => {
      dialog.confirm.and.resolveTo(true);
      const expected = new HttpErrorResponse({ status: 500, error: { error: 'new failed after init' } });
      const file = configureReplacement(of({ file_id: 702 }));
      spyOn(store as any, 'runUploadLoop').and.rejectWith(expected);

      await expectAsync(store.uploadFile(file, null, false, undefined, 'b47-replace-failed-after-init'))
        .toBeRejectedWith(expected);

      expect(drive.trashFile).toHaveBeenCalledWith(701);
      expect(drive.trashFile).toHaveBeenCalledWith(702);
      expect(drive.hardDeleteFile).toHaveBeenCalledWith(702);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(drive.restoreFile).toHaveBeenCalledWith(701);
    });

    it('keeps OLD tombstoned while NEW is paused', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        store.updateTransfer('b47-replace-paused', { status: 'paused' });
      });

      await store.uploadFile(file, null, false, undefined, 'b47-replace-paused');

      expect(runUploadLoop).toHaveBeenCalledTimes(1);
      expect(drive.trashFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(drive.restoreFile).not.toHaveBeenCalledWith(701);
    });

    it('hard-deletes exactly OLD only after NEW succeeds', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      const runUploadLoop = spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        store.updateTransfer('b47-replace-success', { status: 'success' });
      });

      await store.uploadFile(file, null, false, undefined, 'b47-replace-success');

      expect(runUploadLoop).toHaveBeenCalledTimes(1);
      expect(drive.hardDeleteFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(702);
      expect(drive.restoreFile).not.toHaveBeenCalled();
    });

    it('does not invalidate NEW success when OLD cleanup fails', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      const cleanupFailure = new HttpErrorResponse({ status: 503, error: { error: 'offline' } });
      drive.hardDeleteFile.and.returnValue(throwError(() => cleanupFailure));
      spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        store.updateTransfer('b47-replace-cleanup-failure', { status: 'success' });
      });

      await store.uploadFile(file, null, false, undefined, 'b47-replace-cleanup-failure');

      expect(drive.hardDeleteFile).toHaveBeenCalledWith(701);
      expect(drive.restoreFile).not.toHaveBeenCalled();
    });

    it('logs only status when OLD cleanup fails after NEW success', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      const cleanupFailure = new HttpErrorResponse({
        status: 503,
        url: 'https://B47-ERROR-URL-SENTINEL.invalid/path',
        error: { marker: 'B47-ERROR-PAYLOAD-SENTINEL' },
      });
      const consoleError = spyOn(console, 'error');
      drive.hardDeleteFile.and.returnValue(throwError(() => cleanupFailure));
      spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        store.updateTransfer('b47-replace-cleanup-log', { status: 'success' });
      });

      await store.uploadFile(file, null, false, undefined, 'b47-replace-cleanup-log');

      expect(drive.hardDeleteFile).toHaveBeenCalledWith(701);
      expect(drive.restoreFile).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith('Falha ao limpar arquivo substituído', 503);
      expect(consoleError.calls.allArgs().some(args => args.some(arg => arg === cleanupFailure))).toBeFalse();
    });

    it('logs only status when restoring OLD after NEW cancellation fails', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      const restoreFailure = new HttpErrorResponse({
        status: 503,
        error: { marker: 'B47-RESTORE-CANCEL-SENTINEL' },
      });
      const consoleError = spyOn(console, 'error');
      drive.restoreFile.and.returnValue(throwError(() => restoreFailure));
      spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        store.updateTransfer('b47-replace-cancelled-restore-log', { status: 'cancelled' });
      });

      await store.uploadFile(file, null, false, undefined, 'b47-replace-cancelled-restore-log');

      expect(drive.restoreFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(consoleError).toHaveBeenCalledWith('Falha ao restaurar arquivo substituído', 503);
      expect(consoleError.calls.allArgs().some(args => args.some(arg => arg === restoreFailure))).toBeFalse();
    });

    it('keeps the primary replacement error when restoring OLD also fails', async () => {
      dialog.confirm.and.resolveTo(true);
      const primaryFailure = new HttpErrorResponse({
        status: 500,
        error: { marker: 'B47-PRIMARY-NEW-FAILURE' },
      });
      const restoreFailure = new HttpErrorResponse({
        status: 503,
        error: { marker: 'B47-RESTORE-FAILURE-SENTINEL' },
      });
      const file = configureReplacement(throwError(() => primaryFailure));
      const consoleError = spyOn(console, 'error');
      drive.restoreFile.and.returnValue(throwError(() => restoreFailure));

      await expectAsync(store.uploadFile(file, null, false, undefined, 'b47-replace-primary-error-authority'))
        .toBeRejectedWith(primaryFailure);

      expect(drive.restoreFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(consoleError).toHaveBeenCalledWith('Falha ao restaurar arquivo substituído', 503);
      expect(consoleError.calls.allArgs().some(args => args.some(arg => arg === restoreFailure))).toBeFalse();
    });

    it('restores OLD after cancelling NEW and cleans only NEW runtime ownership', async () => {
      dialog.confirm.and.resolveTo(true);
      const file = configureReplacement(of({ file_id: 702 }));
      let releaseReplacement!: () => void;
      let replacementStarted!: () => void;
      const replacementPending = new Promise<void>(resolve => { releaseReplacement = resolve; });
      const replacementStartedPromise = new Promise<void>(resolve => { replacementStarted = resolve; });
      spyOn(store as any, 'runUploadLoop').and.callFake(async () => {
        replacementStarted();
        await replacementPending;
        store.updateTransfer('b47-replace-cancelled', { status: 'cancelled' });
      });

      const upload = store.uploadFile(file, null, false, undefined, 'b47-replace-cancelled');
      await replacementStartedPromise;
      const cancellation = store.cancelTransfer('b47-replace-cancelled');
      releaseReplacement();
      await Promise.all([upload, cancellation]);

      expect(drive.restoreFile).toHaveBeenCalledWith(701);
      expect(drive.hardDeleteFile).not.toHaveBeenCalledWith(701);
      expect(drive.trashFile).toHaveBeenCalledWith(702);
      expect(drive.hardDeleteFile).toHaveBeenCalledWith(702);
    });
  });

  it('appends a completed upload once without changing the current selection', async () => {
    const loadTree = spyOn(store, 'loadTree').and.resolveTo();
    store.selectedFileIds.set(new Set([99]));
    const file = new File(['data'], 'photo.png', { type: 'image/png' });
    (store as any).activeUploads.set('upload_batch', {
      provider: 'local',
      transferId: 'upload', file, fileId: 77, folderId: 12, isHiddenProxy: false,
      plan: { encryptedName: 'cipher-name', encryptedFdk: 'cipher-fdk', encryptedSize: 128, thumbnail: 'data:image/webp;base64,thumb', fdk: new Uint8Array(32), baseNonce: new Uint8Array(24) },
    });

    (store as any).appendCompletedUploadToTree('upload_batch');
    (store as any).appendCompletedUploadToTree('upload_batch');
    await (store as any).flushTreeReconciliation();

    expect(store.files().filter(file => file.id === 77)).toHaveSize(1);
    expect(store.files().find(file => file.id === 77)).toEqual(jasmine.objectContaining({
      folderId: 12, decryptedName: 'photo.png', type: 'image', encryptedName: 'cipher-name',
    }));
    expect(store.selectedFileIds()).toEqual(new Set([99]));
    expect(store.thumbnails()[77]).toBe('data:image/webp;base64,thumb');
    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it('mantém a receita Local sem Blob durante pause e resume', async () => {
    const uploadEngine = TestBed.inject(UploadEngineService);
    store.setStorageProvider('local');
    const file = new File(['plain'], 'paused.txt', { type: 'text/plain' });
    const fdk = new Uint8Array(32).fill(0x71);
    const plan = {
      file,
      encryptedName: 'encrypted-name',
      nameHash: 'name-hash',
      encryptedFdk: 'encrypted-fdk',
      fdk,
      totalChunks: 1,
      encryptedSize: 10,
      baseNonce: new Uint8Array(24).fill(0x72),
    };
    spyOn(uploadEngine, 'planUpload').and.resolveTo(plan as any);
    spyOn(uploadEngine, 'executeLocal').and.returnValues(
      Promise.resolve({ paused: true }),
      Promise.resolve({ paused: true }),
      Promise.resolve({ paused: false }),
    );
    drive.initFileUpload.and.returnValue(of({ file_id: 501 }));
    store.addTransfer({ id: 'paused-local', fileName: file.name, type: 'upload', status: 'processing', progress: 0 });

    await (store as any)._uploadSingleFile(file, null, false, 'paused-local', false);

    const pausedRuntime = (store as any).activeUploads.get('paused-local_original');
    expect(pausedRuntime.provider).toBe('local');
    expect(pausedRuntime.plan.fdk).toBe(fdk);
    expect('encryptedBlob' in pausedRuntime.plan).toBeFalse();

    await store.resumeUpload('paused-local');

    expect(uploadEngine.executeLocal).toHaveBeenCalledTimes(2);
    expect((uploadEngine.executeLocal as jasmine.Spy).calls.argsFor(1)[0]).toBe(pausedRuntime.plan);
    const pausedAgain = (store as any).activeUploads.get('paused-local_original');
    expect(pausedAgain.provider).toBe('local');
    expect(pausedAgain.plan.fdk).toBe(fdk);
    expect(pausedAgain.plan.baseNonce).toBe(pausedRuntime.plan.baseNonce);
    expect('encryptedBlob' in pausedAgain.plan).toBeFalse();

    await store.resumeUpload('paused-local');

    expect(uploadEngine.executeLocal).toHaveBeenCalledTimes(3);
    expect((uploadEngine.executeLocal as jasmine.Spy).calls.argsFor(2)[0]).toBe(pausedAgain.plan);
    expect((store as any).activeUploads.has('paused-local_original')).toBeFalse();
    expect([...fdk]).toEqual(new Array(32).fill(0));
  });

  it('parks a paused batch runtime before the batch operation resolves', async () => {
    const coordinator = TestBed.inject(UploadBatchCoordinatorService);
    const file = new File(['plain'], 'batch-paused.txt');
    const fdk = new Uint8Array(32).fill(0x77);
    const plan = {
      file,
      encryptedName: 'encrypted-name', nameHash: 'name-hash', encryptedFdk: 'encrypted-fdk',
      fdk, totalChunks: 1, encryptedSize: 10,
      baseNonce: new Uint8Array(24).fill(0x78),
    };
    spyOn(coordinator, 'upload').and.callFake(async (candidates, callbacks) => {
      const candidate = candidates[0];
      callbacks.onInitialized(candidate, { provider: 'local', plan }, {
        client_ref: candidate.transferId, file_id: 504, name_hash: plan.nameHash, storage_provider: 'local',
      });
      await callbacks.onResult({ transferId: candidate.transferId, status: 'paused' });
      return { total: 1, succeeded: 0, paused: 1, cancelled: 0, failed: 0 };
    });

    await (store as any).uploadBatchFiles([{ file, folderId: null, transferId: 'batch-paused' }], false);

    const runtime = (store as any).activeUploads.get('batch-paused_batch');
    expect(runtime.provider).toBe('local');
    expect('encryptedBlob' in runtime.plan).toBeFalse();
    expect(runtime.plan.fdk).toBe(fdk);
  });

  it('preserva a sessão Google recebida pelo batch e reutiliza a mesma sessão no resume', async () => {
    const coordinator = TestBed.inject(UploadBatchCoordinatorService);
    const uploadEngine = TestBed.inject(UploadEngineService);
    store.setStorageProvider('google_drive');
    const transferId = 'batch-google-session-resume';
    const file = new File(['plain'], 'batch-google.txt');
    const fdk = new Uint8Array(32).fill(0x71);
    const plan = {
      file,
      encryptedName: 'encrypted-name', nameHash: 'name-hash', encryptedFdk: 'encrypted-fdk',
      fdk, totalChunks: 1, encryptedSize: 10,
      baseNonce: new Uint8Array(24).fill(0x72),
    };
    const session = {
      session_uri: 'https://upload.example/batch-s1',
      access_token: 'batch-token-s1',
    };
    spyOn(coordinator, 'upload').and.callFake(async (candidates, callbacks) => {
      const candidate = candidates[0];
      callbacks.onInitialized(candidate, { provider: 'google_drive', plan }, {
        client_ref: candidate.transferId, file_id: 905, name_hash: plan.nameHash, storage_provider: 'google_drive',
      });
      await callbacks.onResult({ transferId: candidate.transferId, status: 'paused', googleSession: session });
      return { total: 1, succeeded: 0, paused: 1, cancelled: 0, failed: 0 };
    });

    await (store as any).uploadBatchFiles([{ file, folderId: null, transferId }], false);

    const runtime = (store as any).activeUploads.get(`${transferId}_batch`);
    expect(runtime).toBeDefined();
    expect(runtime.provider).toBe('google_drive');
    expect(runtime.plan).toBe(plan);
    expect(runtime.session).toBe(session);

    const executeGoogle = spyOn(uploadEngine, 'executeGoogle').and.resolveTo({ paused: false });
    spyOn(store, 'loadPendingUploads').and.resolveTo();

    await store.resumeUpload(transferId);

    const call = executeGoogle.calls.mostRecent();
    expect(call.args[0]).toBe(plan);
    expect(call.args[1]).toBe(905);
    expect(call.args[2]).toBe(session);
    expect((store as any).activeUploads.has(`${transferId}_batch`)).toBeFalse();
    expect([...fdk]).toEqual(new Array(32).fill(0));
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
  });

  it('cancels a paused plan, zeroizes its FDK, and cleans the initialized file', async () => {
    const fdk = new Uint8Array(32).fill(0x73);
    const transferId = 'paused-cancel';
    store.addTransfer({ id: transferId, fileName: 'paused.txt', type: 'upload', status: 'paused', progress: 20 });
    (store as any).ensureUploadController(transferId);
    (store as any).activeUploads.set(`${transferId}_original`, {
      provider: 'local',
      transferId,
      file: new File(['plain'], 'paused.txt'),
      fileId: 502,
      plan: {
        file: new File(['plain'], 'paused.txt'), encryptedName: 'name', nameHash: 'hash', encryptedFdk: 'fdk',
        fdk, totalChunks: 1, encryptedSize: 10, baseNonce: new Uint8Array(24).fill(0x74),
      },
      folderId: null, isHiddenProxy: false,
    });

    await store.cancelTransfer(transferId);

    expect([...fdk]).toEqual(new Array(32).fill(0));
    expect((store as any).activeUploads.has(`${transferId}_original`)).toBeFalse();
    expect(drive.trashFile).toHaveBeenCalledWith(502);
    expect(drive.hardDeleteFile).toHaveBeenCalledWith(502);
  });

  it('retoma Google usando a receita e a sessão sem rematerialização', async () => {
    const uploadEngine = TestBed.inject(UploadEngineService);
    const fdk = new Uint8Array(32).fill(0x75);
    const transferId = 'paused-google-resume';
    const file = new File(['plain'], 'paused.txt');
    const plan = {
      file, encryptedName: 'name', nameHash: 'hash', encryptedFdk: 'fdk', fdk,
      totalChunks: 1, encryptedSize: 10, baseNonce: new Uint8Array(24).fill(0x76),
    };
    const session = { session_uri: 'https://upload.example/session', access_token: 'token' };
    store.addTransfer({ id: transferId, fileName: 'paused.txt', type: 'upload', status: 'paused', progress: 20 });
    (store as any).ensureUploadController(transferId);
    (store as any).activeUploads.set(`${transferId}_original`, {
      provider: 'google_drive',
      transferId,
      file,
      fileId: 503,
      plan,
      session,
      folderId: null, isHiddenProxy: false,
    });
    const executeGoogle = spyOn(uploadEngine, 'executeGoogle').and.resolveTo({ paused: false });
    spyOn(store, 'loadPendingUploads').and.resolveTo();

    await store.resumeUpload(transferId);

    expect(executeGoogle).toHaveBeenCalledWith(
      plan, 503, session, jasmine.anything(), jasmine.anything(),
    );
    expect((store as any).activeUploads.has(`${transferId}_original`)).toBeFalse();
    expect([...fdk]).toEqual(new Array(32).fill(0));
    expect(store.transfers()[0]).toEqual(jasmine.objectContaining({ status: 'success' }));
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
  });

  it('retoma Local com a mesma receita e um controller novo', async () => {
    const transferId = 'public-resume-race';
    store.setStorageProvider('local');
    const file = new File([new Uint8Array(24)], 'resume.txt');
    const fdk = new Uint8Array(32).fill(0x79);
    const plan = {
      file, encryptedName: 'name', nameHash: 'hash', encryptedFdk: 'fdk', fdk,
      totalChunks: 1, encryptedSize: 24, baseNonce: new Uint8Array(24).fill(0x7b),
    };
    const uploadEngine = TestBed.inject(UploadEngineService);
    spyOn(uploadEngine, 'planUpload').and.resolveTo(plan as any);
    const executeLocal = spyOn(uploadEngine, 'executeLocal').and.returnValues(
      Promise.resolve({ paused: true }), Promise.resolve({ paused: false }),
    );
    drive.initFileUpload.and.returnValue(of({ file_id: 902 }));

    await store.uploadFile(file, null, false, undefined, transferId);
    const runtime = (store as any).activeUploads.get(`${transferId}_original`);
    expect(runtime.provider).toBe('local');
    const firstPlan = runtime.plan;
    await store.resumeUpload(transferId);

    expect(executeLocal).toHaveBeenCalledTimes(2);
    expect(executeLocal.calls.argsFor(1)[0]).toBe(firstPlan);
    expect((executeLocal.calls.argsFor(1)[2] as any).signal)
      .not.toBe((executeLocal.calls.argsFor(0)[2] as any).signal);
    expect((store as any).activeUploads.has(`${transferId}_original`)).toBeFalse();
    expect([...fdk]).toEqual(new Array(32).fill(0));
  });

  it('B88 upload pause/resume keeps one initialized MP4 runtime and settles once', async () => {
    const transferId = 'b88-paused-video';
    const file = new File([new Uint8Array(24)], 'paused-video.mp4', { type: 'video/mp4' });
    const fdk = new Uint8Array(32).fill(0x7c);
    const plan = {
      file, encryptedName: 'name', nameHash: 'hash', encryptedFdk: 'fdk', fdk,
      totalChunks: 1, encryptedSize: 24, baseNonce: new Uint8Array(24).fill(0x7d),
    };
    const uploadEngine = TestBed.inject(UploadEngineService);
    spyOn(uploadEngine, 'planUpload').and.resolveTo(plan as any);
    const executeLocal = spyOn(uploadEngine, 'executeLocal').and.returnValues(
      Promise.resolve({ paused: true }), Promise.resolve({ paused: false }),
    );
    drive.initFileUpload.and.returnValue(of({ file_id: 904 }));

    await store.uploadFile(file, null, false, undefined, transferId);
    expect(drive.initFileUpload).toHaveBeenCalledOnceWith(
      null, 'name', 'hash', 'fdk', 24, 1, 'local', undefined, undefined, undefined, false,
    );
    expect((store as any).activeUploads.has(`${transferId}_original`)).toBeTrue();

    await store.resumeUpload(transferId);

    expect(executeLocal).toHaveBeenCalledTimes(2);
    expect((store as any).activeUploads.has(`${transferId}_original`)).toBeFalse();
    expect(store.transfers().find(transfer => transfer.id === transferId)?.status).toBe('success');
    expect([...fdk]).toEqual(new Array(32).fill(0));
  });

  it('rejects encryption operations while locked and clears sensitive derived state', async () => {
    crypto.isVaultUnlocked.and.returnValue(false);
    await expectAsync(store.createFolder('secret')).toBeRejectedWithError('Drive trancado');
    store.files.set([{ id: 1, decryptedName: 'name' } as DriveFile]);
    store.thumbnails.set({ 1: 'data' });
    status.set(AppStatus.Locked);
    TestBed.flushEffects();
    expect(store.thumbnails()).toEqual({});
    store.clearDecryptedNames();
    expect(store.files()[0].decryptedName).toBeNull();
  });

  it('A19-LOCK-019..021 clears decrypted names from files and trash without changing ciphertext metadata', () => {
    const file = { id: 1, decryptedName: 'arquivo-secreto', encryptedName: 'cipher-file', encryptedFdk: 'fdk-file', sizeBytes: 7 } as DriveFile;
    const trash = { id: 2, decryptedName: 'lixeira-secreta', encryptedName: 'cipher-trash', encryptedFdk: 'fdk-trash', sizeBytes: 9 } as DriveFile;
    store.files.set([file]);
    store.trashFiles.set([trash]);
    store.thumbnails.set({ 1: 'data:image/png;base64,thumb' });

    (store as any).clearDecryptedPresentationData();

    expect(store.files()[0]).toEqual(jasmine.objectContaining({ id: 1, decryptedName: null, encryptedName: 'cipher-file', encryptedFdk: 'fdk-file', sizeBytes: 7 }));
    expect(store.trashFiles()[0]).toEqual(jasmine.objectContaining({ id: 2, decryptedName: null, encryptedName: 'cipher-trash', encryptedFdk: 'fdk-trash', sizeBytes: 9 }));
    expect(store.thumbnails()).toEqual({});
  });

  it('creates a folder in the current location with encrypted metadata and refreshes the tree', async () => {
    store.currentFolderId.set(42);
    spyOn(store, 'loadTree').and.resolveTo();

    await store.createFolder('Projetos');

    expect(drive.createFolder).toHaveBeenCalledWith('encrypted', 'hash', 42);
    expect(store.loadTree).toHaveBeenCalledTimes(1);
  });

  it('tracks transfer speed using recent samples and removes terminal transfers', () => {
    store.addTransfer({ id: 't', fileName: 'x', type: 'download', status: 'processing', progress: 0 });
    spyOn(Date, 'now').and.returnValues(1000, 2000, 3000, 4000);
    store.updateTransferProgress('t', 10, 100, 1000);
    store.updateTransferProgress('t', 20, 1124, 1000);
    expect(store.transfers()[0].speed).toBe('1.0 KB/s');
    expect(store.transfers()[0].eta).toContain('restantes');
    store.updateTransfer('t', { status: 'error' });
    store.clearCompletedTransfers();
    expect(store.transfers()).toEqual([]);
  });

  it('aggregates grouped transfers by bytes and preserves partial outcomes', () => {
    (store as any).createTransferGroup('multiple-files', ['a', 'b']);
    store.transfers.set([
      { id: 'a', fileName: 'a', type: 'upload', status: 'success', progress: 100, totalBytes: 100, bytesTransferred: 100, groupId: store.transferGroups()[0].id, timestamp: new Date() },
      { id: 'b', fileName: 'b', type: 'upload', status: 'error', progress: 50, totalBytes: 300, bytesTransferred: 50, groupId: store.transferGroups()[0].id, timestamp: new Date() },
    ]);

    const view = store.transferGroupViews()[0];
    expect(view.totalFiles).toBe(2);
    expect(view.completedFiles).toBe(1);
    expect(view.failedFiles).toBe(1);
    expect(view.totalBytes).toBe(400);
    expect(view.transferredBytes).toBe(150);
    expect(view.progress).toBe(0.375);
    expect(view.status).toBe('partial');
    expect(view.canClear).toBeTrue();
  });

  it('reuses individual controls for group pause, resume, cancel and terminal cleanup', async () => {
    const groupId = (store as any).createTransferGroup('multiple-files', ['upload', 'download', 'done']);
    store.transfers.set([
      { id: 'upload', fileName: 'upload', type: 'upload', status: 'processing', progress: 0, timestamp: new Date(), groupId },
      { id: 'download', fileName: 'download', type: 'download', status: 'paused', progress: 0, timestamp: new Date(), groupId },
      { id: 'done', fileName: 'done', type: 'upload', status: 'success', progress: 100, timestamp: new Date(), groupId },
    ]);
    spyOn(store, 'pauseTransfer').and.callThrough();
    spyOn(store, 'resumeUpload').and.resolveTo();
    spyOn(store, 'resumeDownload').and.resolveTo();
    spyOn(store, 'cancelTransfer').and.resolveTo();

    store.pauseTransferGroup(groupId);
    expect(store.pauseTransfer).toHaveBeenCalledWith('upload');
    await store.resumeTransferGroup(groupId);
    expect(store.resumeDownload).toHaveBeenCalledWith('download');
    await store.cancelTransferGroup(groupId);
    expect(store.cancelTransfer).not.toHaveBeenCalledWith('done');

    store.updateTransfer('upload', { status: 'success' });
    store.updateTransfer('download', { status: 'success' });
    store.clearTransferGroup(groupId);
    expect(store.transferGroups()).toHaveSize(0);
    expect(store.transfers()).toEqual([]);
  });

  it('derives queued, active, paused, error and cancelled aggregate states', () => {
    const queued = (store as any).createTransferGroup('multiple-files', ['queued']);
    const active = (store as any).createTransferGroup('multiple-files', ['active']);
    const paused = (store as any).createTransferGroup('multiple-files', ['paused']);
    const failed = (store as any).createTransferGroup('multiple-files', ['failed']);
    const cancelled = (store as any).createTransferGroup('multiple-files', ['cancelled']);
    store.transfers.set([
      { id: 'active', fileName: 'active', type: 'upload', status: 'processing', progress: 0, timestamp: new Date(), groupId: active },
      { id: 'paused', fileName: 'paused', type: 'upload', status: 'paused', progress: 0, timestamp: new Date(), groupId: paused },
      { id: 'failed', fileName: 'failed', type: 'upload', status: 'error', progress: 0, timestamp: new Date(), groupId: failed },
    ]);
    store.transferGroups.update(groups => groups.map(group => group.id === cancelled
      ? { ...group, cancelledTransferIds: ['cancelled'], cancelledBytes: { cancelled: { totalBytes: 0, transferredBytes: 0 } } }
      : group));

    const views = store.transferGroupViews();
    expect(views.find(view => view.id === queued)?.status).toBe('queued');
    expect(views.find(view => view.id === active)?.status).toBe('active');
    expect(views.find(view => view.id === paused)?.status).toBe('paused');
    expect(views.find(view => view.id === failed)?.status).toBe('error');
    expect(views.find(view => view.id === cancelled)?.status).toBe('cancelled');
  });

  it('renames and moves files, including an optimized proxy, and rejects folder self-moves', async () => {
    const file = { id: 1, isFolder: false, decryptedName: 'movie.mp4', folderId: 7 } as DriveFile;
    const proxy = { id: 2, isFolder: false, decryptedName: 'movie.mp4.proxy.mp4', folderId: 7 } as DriveFile;
    store.files.set([file, proxy]);
    spyOn(store, 'loadTree').and.resolveTo();
    await store.renameItem(file, 'renamed.mp4');
    expect(drive.updateFile).toHaveBeenCalledWith(1, { encrypted_name: 'encrypted', name_hash: 'hash' });
    expect(drive.updateFile).toHaveBeenCalledWith(2, { encrypted_name: 'encrypted', name_hash: 'hash' });
    await store.moveItem(file, 9);
    expect(drive.updateFile).toHaveBeenCalledWith(1, { folder_id: 9 });
    const folder = { id: 9, isFolder: true } as DriveFile;
    await expectAsync(store.moveItem(folder, 9)).toBeRejectedWithError('Não é possível mover uma pasta para dentro de si mesma');
  });

  it('handles trash and permanent-delete batches with empty sides and cleanup reloads', async () => {
    spyOn(store, 'loadTree').and.resolveTo();
    spyOn(store, 'loadTrash').and.resolveTo();
    spyOn(store, 'loadQuota').and.resolveTo();
    await store.batchTrashItems([{ id: 1, isFolder: false } as DriveFile]);
    expect(drive.batchSoftDeleteFiles).toHaveBeenCalledWith([1]);
    expect(drive.batchSoftDeleteFolders).not.toHaveBeenCalled();
    store.trashFiles.set([{ id: 3, isFolder: false, decryptedName: 'x.proxy.mp4', folderId: null } as DriveFile]);
    await store.batchPermanentDeleteItems([{ id: 2, isFolder: false, decryptedName: 'x', folderId: null } as DriveFile]);
    expect(drive.batchHardDeleteFiles).toHaveBeenCalledWith([2, 3]);
    await store.emptyTrash();
    expect(drive.emptyTrash).toHaveBeenCalled();
  });

  it('keeps loading flags false after quota and trash failures', async () => {
    drive.getQuota.and.returnValue(throwError(() => new Error('quota')));
    drive.getTrash.and.returnValue(throwError(() => new Error('trash')));
    await store.loadQuota();
    await store.loadTrash();
    expect(store.isLoading()).toBeFalse();
  });

  it('navigates folders, persists preferences, and loads linked-account response shapes', async () => {
    const root = { id: 1, isFolder: true, parentId: null, decryptedName: 'root' } as DriveFile;
    const child = { id: 2, isFolder: true, parentId: 1, decryptedName: 'child' } as DriveFile;
    store.files.set([root, child]);
    store.navigateTo(2);
    store.selectedFileIds.set(new Set([2]));
    store.navigateUp();
    expect(store.currentFolderId()).toBe(1);
    expect(store.selectedFileIds().size).toBe(1);
    store.setStorageProvider('google_drive');
    store.setConvertIncompatibleVideos(true);
    store.setIncompatibleVideoConversionMode('compressed');
    store.setDisplayMode('grid');
    expect(localStorage.getItem('preferred_storage_provider')).toBe('google_drive');
    expect(localStorage.getItem('preferred_convert_incompatible')).toBe('true');
    expect(localStorage.getItem('preferred_incompatible_mode')).toBe('compressed');
    expect(localStorage.getItem('preferred_display_mode')).toBe('grid');
    drive.getLinkedGoogleAccounts.and.returnValue(of({ accounts: [{ id: 1, account_email: 'one@example.com', account_picture: '  ' }] }));
    await store.loadLinkedAccounts();
    expect(store.linkedAccounts()).toEqual([{
      id: 1,
      accountEmail: 'one@example.com',
      accountPicture: undefined,
      rootFolderId: undefined,
      status: 'ready',
      usedBytes: 0,
      maxBytes: null,
      availableBytes: null,
      nanikaUsedBytes: 0,
    }]);
    drive.getLinkedGoogleAccounts.and.returnValue(throwError(() => new Error('offline')));
    await store.loadLinkedAccounts();
    expect(store.linkedAccounts()).toEqual([]);
  });

  it('preserves a valid linked account picture', async () => {
    drive.getLinkedGoogleAccounts.and.returnValue(of({ accounts: [{
      id: 2, account_email: 'two@example.com', account_picture: 'https://example.test/two.png',
    }] }));

    await store.loadLinkedAccounts();

    expect(store.linkedAccounts()[0].accountPicture).toBe('https://example.test/two.png');
  });

  it('requests only the minimal Google Drive and profile scopes', async () => {
    const authorizationUrl = buildGoogleAuthorizationUrl('http://localhost:4200', 'state');
    const url = new URL(authorizationUrl);
    const scopes = new Set(decodeURIComponent(url.searchParams.get('scope') ?? '').split(' '));
    expect(url.searchParams.get('client_id')).toBe(environment.googleClientId);
    expect(scopes).toEqual(new Set([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]));
    expect(scopes.has('https://www.googleapis.com/auth/drive')).toBeFalse();
  });

  it('loads trash classifications and re-decrypts existing files', async () => {
    drive.getTrash.and.returnValue(of({
      folders: [{ id: 10, parent_id: undefined, encrypted_name: 'folder' }],
      files: [
        { id: 11, folder_id: undefined, encrypted_name: 'photo.png', size_bytes: 1024, encrypted_fdk: 'fdk', is_hidden: false },
        { id: 12, folder_id: 10, encrypted_name: 'data.bin', size_bytes: 2048, encrypted_fdk: 'fdk', is_hidden: false }
      ]
    }));
    await store.loadTrash();
    expect(store.trashFiles().map(file => file.type)).toEqual(['folder', 'image', 'unknown']);
    expect(store.trashFiles()[0].parentId).toBeNull();
    store.files.set([{ id: 20, isFolder: false, encryptedName: 'renamed.pdf', decryptedName: null } as DriveFile]);
    await store.reDecryptAll();
    expect(store.files()[0]).toEqual(jasmine.objectContaining({ decryptedName: 'renamed.pdf', type: 'pdf' }));
  });

  it('loads local and Google Drive thumbnails and ignores unavailable metadata', async () => {
    const kasumi = TestBed.inject(KasumiCryptoService) as jasmine.SpyObj<KasumiCryptoService>;
    kasumi.extractMetadata.and.resolveTo({ metadata: JSON.stringify({ thumb: 'data:image/webp;base64,thumb' }) } as any);
    drive.downloadFileRange.and.returnValue(of(new Blob(['header'])));
    crypto.decryptName.and.resolveTo(btoa('fdk'));
    await store.loadThumbnail({ id: 1, encryptedFdk: 'encrypted', storageProvider: 'local' } as any);
    expect(store.thumbnails()[1]).toContain('data:image');
    await store.loadThumbnail({ id: 1, encryptedFdk: 'encrypted', storageProvider: 'local' } as any);
    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
    await store.loadThumbnail({ id: 2, encryptedFdk: null } as any);
    expect(store.thumbnails()[2]).toBeUndefined();
  });

  it('coalesces thumbnail loads and clamps the requested range to the known size', async () => {
    const response = new Subject<Blob>();
    const kasumi = TestBed.inject(KasumiCryptoService) as jasmine.SpyObj<KasumiCryptoService>;
    kasumi.extractMetadata.and.resolveTo({ metadata: JSON.stringify({ thumb: 'data:image/png;base64,thumb' }) } as any);
    crypto.decryptName.and.resolveTo(btoa('fdk'));
    drive.downloadFileRange.and.returnValue(response.asObservable());
    const file = { id: 22, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 3 } as DriveFile;

    const first = store.loadThumbnail(file);
    const second = store.loadThumbnail(file);
    await Promise.resolve();
    expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
    expect(drive.downloadFileRange).toHaveBeenCalledWith(22, 0, 2);
    response.next(new Blob(['abc']));
    response.complete();
    await Promise.all([first, second]);
    expect(store.thumbnails()[22]).toContain('data:image');
  });

  it('expands the header range when a large thumbnail does not fit the initial probe', async () => {
    const kasumi = TestBed.inject(KasumiCryptoService) as jasmine.SpyObj<KasumiCryptoService>;
    kasumi.extractMetadata.and.returnValues(
      Promise.reject(new Error('Partial blob is too small to contain the full metadata block')),
      Promise.resolve({ metadata: JSON.stringify({ thumb: 'data:image/webp;base64,large' }) } as any),
    );
    crypto.decryptName.and.resolveTo(btoa('fdk'));
    drive.downloadFileRange.and.returnValues(of(new Blob(['small'])), of(new Blob(['header-with-thumbnail'])));

    await store.loadThumbnail({ id: 24, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 2 * 1024 * 1024 } as DriveFile);

    expect(drive.downloadFileRange).toHaveBeenCalledWith(24, 0, 131071);
    expect(drive.downloadFileRange).toHaveBeenCalledWith(24, 0, 1048575);
    expect(store.thumbnails()[24]).toContain('large');
  });

  it('retries a 400 response only when it reports an incomplete upload', async () => {
    jasmine.clock().install();
    try {
      const kasumi = TestBed.inject(KasumiCryptoService) as jasmine.SpyObj<KasumiCryptoService>;
      kasumi.extractMetadata.and.resolveTo({ metadata: JSON.stringify({ thumb: 'data:image/png;base64,thumb' }) } as any);
      crypto.decryptName.and.resolveTo(btoa('fdk'));
      drive.downloadFileRange.and.returnValues(
        throwError(() => new HttpErrorResponse({ status: 400, error: 'upload incomplete' })),
        of(new Blob(['abc']))
      );
      const file = { id: 23, encryptedFdk: 'encrypted', storageProvider: 'local', sizeBytes: 3 } as DriveFile;

      await store.loadThumbnail(file);
      expect(drive.downloadFileRange).toHaveBeenCalledTimes(1);
      jasmine.clock().tick(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('zeroizes a vault FDK when local metadata extraction fails before handoff', async () => {
    const originalBytes = new Uint8Array(32).fill(0x5a);
    const captured: { value?: Uint8Array } = {};
    crypto.decryptName.and.resolveTo(base64Bytes(originalBytes));
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(24)])));
    kasumi.extractMetadata.and.callFake(async (_header: Blob, fdk: Uint8Array) => {
      captured.value = fdk;
      throw new Error('B24_METADATA_FAILURE');
    });

    await expectAsync(store.downloadFile(downloadFile())).toBeRejectedWithError('B24_METADATA_FAILURE');

    expect(captured.value).toBeDefined();
    expect(Array.from(captured.value!)).toEqual(new Array(32).fill(0));
  });

  it('grows the Local download metadata prefix without publishing partial state', async () => {
    const file = { ...downloadFile(), sizeBytes: 5 * 1024 * 1024 };
    crypto.decryptName.and.resolveTo(base64Bytes(new Uint8Array(32).fill(1)));
    drive.downloadFileRange.and.returnValues(of(new Blob(['small'])), of(new Blob(['large'])));
    kasumi.extractMetadata.and.returnValues(
      Promise.reject(new Error('Partial blob is too small to contain the full metadata block')),
      Promise.resolve({ dataOffset: 64, expectedSize: 10 } as any),
    );
    spyOn((store as any).downloadEngine, 'run').and.resolveTo();

    await store.downloadFile(file);

    expect(drive.downloadFileRange).toHaveBeenCalledTimes(2);
    expect(drive.downloadFileRange.calls.argsFor(0)).toEqual([41, 0, 128 * 1024 - 1]);
    expect(drive.downloadFileRange.calls.argsFor(1)).toEqual([41, 0, 1024 * 1024 - 1]);
    expect((store as any).downloadEngine.getState(store.transfers()[0].id)).toBeDefined();
  });

  it('does not retry Local metadata authentication failures', async () => {
    const file = { ...downloadFile(), sizeBytes: KASUMI_MAX_METADATA_SIZE + KASUMI_KAS2_METADATA_PREFIX_SIZE + 1 };
    crypto.decryptName.and.resolveTo(base64Bytes(new Uint8Array(32).fill(1)));
    drive.downloadFileRange.and.returnValue(of(new Blob(['header'])));
    kasumi.extractMetadata.and.rejectWith(new Error('Failed to authenticate or decrypt KAS2 metadata'));

    await expectAsync(store.downloadFile(file)).toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');

    expect(drive.downloadFileRange).toHaveBeenCalledOnceWith(41, 0, 128 * 1024 - 1);
    expect((store as any).downloadEngine.getState(store.transfers()[0].id)).toBeUndefined();
  });

  it('keeps shareFdk caller-owned while wiping its runtime copy on pre-handoff failure', async () => {
    const shareFdk = new Uint8Array(32).fill(7);
    const captured: { value?: Uint8Array } = {};
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(24)])));
    kasumi.extractMetadata.and.callFake(async (_header: Blob, fdk: Uint8Array) => {
      captured.value = fdk;
      throw new Error('B24_SHARE_FDK_FAILURE');
    });

    await expectAsync(store.downloadFile({ ...downloadFile(), shareFdk }))
      .toBeRejectedWithError('B24_SHARE_FDK_FAILURE');

    expect(captured.value).toBeDefined();
    expect(captured.value).not.toBe(shareFdk);
    expect(Array.from(captured.value!)).toEqual(new Array(32).fill(0));
    expect(Array.from(shareFdk)).toEqual(new Array(32).fill(7));
  });

  it('keeps an accepted local state usable while paused', async () => {
    const originalBytes = new Uint8Array(32).fill(0x5a);
    crypto.decryptName.and.resolveTo(base64Bytes(originalBytes));
    drive.downloadFileRange.and.returnValue(of(new Blob([new Uint8Array(24)])));
    kasumi.extractMetadata.and.resolveTo({ dataOffset: 24, expectedSize: 0 } as any);

    const operation = store.downloadFile(downloadFile());
    const transferId = store.transfers()[0].id;
    store.pauseTransfer(transferId);
    await operation;

    const state = (store as any).downloadEngine.getState(transferId);
    expect(state).toBeDefined();
    expect(Array.from(state.fdk)).toEqual(Array.from(originalBytes));
    expect(Array.from(state.baseNonce)).toEqual(new Array(24).fill(0));
    expect(state.plaintextChunks).toEqual([]);
    (store as any).downloadEngine.cancel(transferId);
  });

  it('keeps an accepted Google state FDK usable while paused', async () => {
    const originalBytes = new Uint8Array(32).fill(0x5a);
    crypto.decryptName.and.resolveTo(base64Bytes(originalBytes));

    const operation = store.downloadFile({ ...downloadFile('google_drive'), id: 42 });
    const transferId = store.transfers()[0].id;
    store.pauseTransfer(transferId);
    await operation;

    const state = (store as any).downloadEngine.getState(transferId);
    expect(state).toBeDefined();
    expect(Array.from(state.fdk)).toEqual(Array.from(originalBytes));
    expect(drive.downloadExternalMetadata).toHaveBeenCalledOnceWith(42);
    (store as any).downloadEngine.cancel(transferId);
  });

  it('does not hand off a local state after cancellation during the header request', async () => {
    const header = new Subject<Blob>();
    crypto.decryptName.and.resolveTo(base64Bytes(new Uint8Array(32).fill(0x5a)));
    drive.downloadFileRange.and.returnValue(header.asObservable());

    const operation = store.downloadFile(downloadFile());
    await Promise.resolve();
    await Promise.resolve();
    const transferId = store.transfers()[0].id;
    expect(drive.downloadFileRange).toHaveBeenCalledOnceWith(41, 0, 23);

    await store.cancelTransfer(transferId);
    header.complete();
    await operation;

    expect((store as any).downloadEngine.getState(transferId)).toBeUndefined();
    expect(store.transfers().find(transfer => transfer.id === transferId)?.status).toBe('cancelled');
  });

  it('keeps the Google error path pre-handoff without residual engine state', async () => {
    crypto.decryptName.and.resolveTo(base64Bytes(new Uint8Array(32).fill(0x5a)));
    drive.downloadExternalMetadata.and.returnValue(throwError(() => new Error('B24_GOOGLE_METADATA_FAILURE')));

    await expectAsync(store.downloadFile({ ...downloadFile('google_drive'), id: 43 }))
      .toBeRejectedWithError('B24_GOOGLE_METADATA_FAILURE');

    const transferId = store.transfers()[0].id;
    expect((store as any).downloadEngine.getState(transferId)).toBeUndefined();
    expect(store.transfers()[0]).toEqual(jasmine.objectContaining({ status: 'error', errorMsg: 'B24_GOOGLE_METADATA_FAILURE' }));
  });

  it('covers transfer speed units and pause/cancel cleanup', async () => {
    store.addTransfer({ id: 'bytes', fileName: 'b', type: 'upload', status: 'processing', progress: 0 });
    spyOn(Date, 'now').and.returnValues(1000, 2000, 3000, 4000);
    store.updateTransferProgress('bytes', 1, 1, 10);
    store.updateTransferProgress('bytes', 2, 2, 10);
    expect(store.transfers()[0].speed).toBe('1.0 B/s');
    store.updateTransferProgress('bytes', 3, 2 * 1024 * 1024, 4 * 1024 * 1024);
    store.updateTransferProgress('bytes', 4, 3 * 1024 * 1024, 4 * 1024 * 1024);
    expect(store.transfers()[0].speed).toBe('1.5 MB/s');
    store.pauseTransfer('bytes');
    expect(store.transfers()[0].status).toBe('paused');
    await store.cancelTransfer('bytes');
    expect(store.transfers().find(t => t.id === 'bytes')?.status).toBe('cancelled');
  });

  it('cancels a recovered upload and cleans its incomplete server file', async () => {
    store.transfers.set([{
      id: 'pending_9', fileName: 'draft', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: { id: 9 } as any, timestamp: new Date(),
    }]);

    await store.cancelTransfer('pending_9');

    expect(drive.trashFile).toHaveBeenCalledWith(9);
    expect(drive.hardDeleteFile).toHaveBeenCalledWith(9);
    expect(store.transfers().find(t => t.id === 'pending_9')?.status).toBe('cancelled');
  });

  it('cancels a download locally without calling upload cleanup endpoints', async () => {
    const downloadEngine = (store as any).downloadEngine;
    spyOn(downloadEngine, 'cancel').and.callThrough();
    store.addTransfer({ id: 'download-live', fileName: 'file', type: 'download', status: 'processing', progress: 20 });

    await store.cancelTransfer('download-live');

    expect(downloadEngine.cancel).toHaveBeenCalledWith('download-live');
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
    expect(store.transfers().find(transfer => transfer.id === 'download-live')?.status).toBe('cancelled');
  });

  it('resets download runtime state and removes only download group members', () => {
    const groupId = (store as any).createTransferGroup('multiple-files', ['download-runtime', 'upload-runtime']);
    store.transfers.set([
      { id: 'download-runtime', fileName: 'download', type: 'download', status: 'processing', progress: 10, groupId, timestamp: new Date() },
      { id: 'upload-runtime', fileName: 'upload', type: 'upload', status: 'paused', progress: 10, groupId, timestamp: new Date() },
    ]);
    const reset = spyOn((store as any).downloadEngine, 'resetRuntimeState').and.callThrough();

    store.resetDownloadRuntimeState();

    expect(reset).toHaveBeenCalledOnceWith();
    expect(store.transfers().map(transfer => transfer.id)).toEqual(['upload-runtime']);
    expect(store.transferGroups()[0].transferIds).toEqual(['upload-runtime']);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
