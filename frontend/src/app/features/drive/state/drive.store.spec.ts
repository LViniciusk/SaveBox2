import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DriveStore, DriveFile } from './drive.store';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { AppStateService, AppStatus } from '../../../core/state/app-state.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, Subject, throwError } from 'rxjs';
import { signal } from '@angular/core';

describe('DriveStore', () => {
  let store: DriveStore;
  let driveServiceSpy: any;
  let cryptoServiceSpy: any;
  let appStateSpy: any;

  beforeEach(() => {
    driveServiceSpy = jasmine.createSpyObj('DriveService', [
      'updateFile', 'trashFile', 'hardDeleteFile', 'restoreFile', 'getTree', 'getQuota', 'getTrash'
      , 'getPendingUploads', 'batchSoftDeleteFiles', 'batchSoftDeleteFolders', 'cancelExternalUpload', 'initFileUpload'
    ]);
    cryptoServiceSpy = jasmine.createSpyObj('CryptoService', ['isVaultUnlocked', 'decryptName']);
    const kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['generateBaseNonce']);
    const dialogSpy = jasmine.createSpyObj('DialogService', ['confirm']);
    const transcoderSpy = jasmine.createSpyObj('VideoTranscoderService', ['isVideo']);
    appStateSpy = jasmine.createSpyObj('AppStateService', [], {
      status: signal(AppStatus.Unlocked)
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        DriveStore,
        { provide: DriveService, useValue: driveServiceSpy },
        { provide: CryptoService, useValue: cryptoServiceSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: DialogService, useValue: dialogSpy },
        { provide: VideoTranscoderService, useValue: transcoderSpy },
        { provide: AppStateService, useValue: appStateSpy }
      ]
    });

    driveServiceSpy.getTree.and.returnValue(of({ files: [], folders: [], has_more: false }));
    driveServiceSpy.getQuota.and.returnValue(of({ used_bytes: 0, max_bytes: 100 }));
    driveServiceSpy.getTrash.and.returnValue(of({ files: [], folders: [] }));
    driveServiceSpy.cancelExternalUpload.and.returnValue(of({ status: 'cleanup_pending' }));
    driveServiceSpy.initFileUpload.and.returnValue(of({ file_id: 1 }));
    cryptoServiceSpy.isVaultUnlocked.and.returnValue(true);

    store = TestBed.inject(DriveStore);
  });

  describe('moveItem', () => {
    it('should call updateFile and reload tree when moving a file to a target folder', async () => {
      // Arrange
      const mockFile = { id: 10, isFolder: false, decryptedName: 'test.pdf' } as DriveFile;
      const targetFolderId = 5;
      
      driveServiceSpy.updateFile.and.returnValue(of({}));
      spyOn(store, 'loadTree').and.returnValue(Promise.resolve());

      // Act
      await store.moveItem(mockFile, targetFolderId);

      // Assert
      expect(driveServiceSpy.updateFile).toHaveBeenCalledWith(10, { folder_id: targetFolderId });
      expect(store.loadTree).toHaveBeenCalled();
    });
  });

  describe('trashItem', () => {
    it('should call trashFile and reload state (tree and quota)', async () => {
      // Arrange
      const mockFile = { id: 20, isFolder: false, decryptedName: 'document.doc', folderId: null } as DriveFile;
      driveServiceSpy.trashFile.and.returnValue(of({}));
      spyOn(store, 'loadTree').and.returnValue(Promise.resolve());
      spyOn(store, 'loadQuota').and.returnValue(Promise.resolve());
      
      store.files.set([mockFile]);

      // Act
      await store.trashItem(mockFile);

      // Assert
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(20);
      expect(store.loadTree).toHaveBeenCalled();
      expect(store.loadQuota).toHaveBeenCalled();
    });
  });

  describe('restoreItem', () => {
    it('should call restoreFile and reload all states (trash, tree, quota)', async () => {
      // Arrange
      const mockFile = { id: 30, isFolder: false, decryptedName: 'image.jpg', folderId: null } as DriveFile;
      driveServiceSpy.restoreFile.and.returnValue(of({}));
      spyOn(store, 'loadTrash').and.returnValue(Promise.resolve());
      spyOn(store, 'loadTree').and.returnValue(Promise.resolve());
      spyOn(store, 'loadQuota').and.returnValue(Promise.resolve());

      store.trashFiles.set([mockFile]);

      // Act
      await store.restoreItem(mockFile);

      // Assert
      expect(driveServiceSpy.restoreFile).toHaveBeenCalledWith(30);
      expect(store.loadTrash).toHaveBeenCalled();
      expect(store.loadTree).toHaveBeenCalled();
      expect(store.loadQuota).toHaveBeenCalled();
    });
  describe('clearDecryptedNames', () => {
    it('should set decryptedName to null for all files', () => {
      store.files.set([
        { id: 1, isFolder: false, decryptedName: 'test.pdf', encryptedName: 'enc1', type: 'pdf', sizeBytes: 100, sizeFormatted: '100 B', modifiedAt: '', owner: '', storageProvider: 'local', externalStorageId: null },
        { id: 2, isFolder: true, decryptedName: 'folder', encryptedName: 'enc2', type: 'folder', sizeBytes: 0, sizeFormatted: '0 B', modifiedAt: '', owner: '', storageProvider: 'local', externalStorageId: null }
      ]);
      store.clearDecryptedNames();
      expect(store.files()[0].decryptedName).toBeNull();
      expect(store.files()[1].decryptedName).toBeNull();
    });
  });

  describe('navigateTo / navigateUp', () => {
    it('should set currentFolderId and clear selected files', () => {
      store.selectedFileIds.set(new Set([1, 2]));
      store.navigateTo(5);
      expect(store.currentFolderId()).toBe(5);
      expect(store.selectedFileIds().size).toBe(0);
    });

    it('should navigate to parent folder', () => {
      store.files.set([
        { id: 10, isFolder: true, parentId: 5, decryptedName: 'child', encryptedName: 'enc', type: 'folder', sizeBytes: 0, sizeFormatted: '', modifiedAt: '', owner: '', storageProvider: 'local', externalStorageId: null }
      ]);
      store.currentFolderId.set(10);
      store.navigateUp();
      expect(store.currentFolderId()).toBe(5);
    });
    
    it('should navigate to null if currentFolder is not found or has no parent', () => {
      store.currentFolderId.set(999);
      store.navigateUp();
      expect(store.currentFolderId()).toBeNull();
    });

    it('should support back and forward navigation without duplicating history', () => {
      store.navigateTo(1);
      store.navigateTo(2);
      expect(store.canGoBack()).toBeTrue();

      store.goBack();
      expect(store.currentFolderId()).toBe(1);
      expect(store.canGoForward()).toBeTrue();

      store.goForward();
      expect(store.currentFolderId()).toBe(2);
      expect(store.canGoForward()).toBeFalse();
    });
  });

  describe('Storage / Display mode setters', () => {
    it('should set storage provider and update local storage', () => {
      spyOn(localStorage, 'setItem');
      store.setStorageProvider('google_drive');
      expect(store.storageProvider()).toBe('google_drive');
      expect(localStorage.setItem).toHaveBeenCalledWith('preferred_storage_provider', 'google_drive');
    });

    it('should set display mode and update local storage', () => {
      spyOn(localStorage, 'setItem');
      store.setDisplayMode('grid');
      expect(store.displayMode()).toBe('grid');
      expect(localStorage.setItem).toHaveBeenCalledWith('preferred_display_mode', 'grid');
    });
    
    it('should set convert incompatible videos flag', () => {
      spyOn(localStorage, 'setItem');
      store.setConvertIncompatibleVideos(false);
      expect(store.convertIncompatibleVideos()).toBeFalse();
      expect(localStorage.setItem).toHaveBeenCalledWith('preferred_convert_incompatible', 'false');
    });

    it('should set conversion mode', () => {
      spyOn(localStorage, 'setItem');
      store.setIncompatibleVideoConversionMode('compressed');
      expect(store.incompatibleVideoConversionMode()).toBe('compressed');
      expect(localStorage.setItem).toHaveBeenCalledWith('preferred_incompatible_mode', 'compressed');
    });
  });

  describe('derived state and tree loading', () => {
    it('should expose visible files, current folder files and upload status', () => {
      const folder = { id: 5, isFolder: true, parentId: null, isHidden: false } as DriveFile;
      const visible = { id: 6, isFolder: false, folderId: 5, isHidden: false } as DriveFile;
      const hidden = { id: 7, isFolder: false, folderId: 5, isHidden: true } as DriveFile;
      store.files.set([folder, visible, hidden]);
      store.currentFolderId.set(5);
      store.transfers.set([
        { id: 'u', fileName: 'a', type: 'upload', status: 'processing', progress: 42, timestamp: new Date(), statusMessage: 'Enviando' },
        { id: 'd', fileName: 'b', type: 'download', status: 'processing', progress: 10, timestamp: new Date() }
      ]);

      expect(store.visibleFiles()).toEqual([folder, visible]);
      expect(store.currentFolderFiles()).toEqual([visible]);
      expect(store.isUploading()).toBeTrue();
      expect(store.isDownloading()).toBeTrue();
      expect(store.uploadProgress()).toBe(42);
      expect(store.downloadProgress()).toBe(10);
      expect(store.uploadStatusMessage()).toBe('Enviando');
    });

    it('uses safe defaults for inactive, successful and unnamed transfers', () => {
      store.transfers.set([]);
      expect(store.uploadProgress()).toBe(0);
      expect(store.downloadProgress()).toBe(0);
      expect(store.uploadStatusMessage()).toBe('Fazendo upload...');

      store.transfers.set([
        { id: 'success', fileName: 'ok.txt', type: 'upload', status: 'success', progress: 100, timestamp: new Date() },
        { id: 'working', fileName: 'working.txt', type: 'upload', status: 'processing', progress: 1, timestamp: new Date() },
      ]);
      expect(store.uploadStatusMessage()).toBe('working.txt');

      store.transfers.set([
        { id: 'success', fileName: 'ok.txt', type: 'upload', status: 'success', progress: 100, timestamp: new Date() },
      ]);
      expect(store.uploadStatusMessage()).toBe('Concluído!');
    });

    it('should classify decrypted tree entries and preserve hidden files', async () => {
      cryptoServiceSpy.decryptName.and.callFake((name: string) => Promise.resolve(name));
      driveServiceSpy.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));
      driveServiceSpy.getTree.and.returnValue(of({
        folders: [{ id: 1, parent_id: null, encrypted_name: 'Docs' }],
        files: [
          { id: 2, folder_id: 1, encrypted_name: 'photo.PNG', size_bytes: 2048, encrypted_fdk: 'fdk', is_hidden: false },
          { id: 3, folder_id: null, encrypted_name: 'unknown.bin', size_bytes: 0, encrypted_fdk: 'fdk', is_hidden: true }
        ],
        has_more: false
      }));

      await store.loadTree();

      expect(store.files().map(f => [f.type, f.decryptedName, f.isHidden])).toEqual([
        ['folder', 'Docs', undefined], ['image', 'photo.PNG', false], ['unknown', 'unknown.bin', true]
      ]);
      expect(store.isLoading()).toBeFalse();
    });

    it('should clear loading state when tree request fails', async () => {
      driveServiceSpy.getTree.and.returnValue(throwError(() => new Error('offline')));
      await store.loadTree();
      expect(store.isLoading()).toBeFalse();
    });

    it('should update transfer entries and remove completed transfers', () => {
      store.addTransfer({ id: 'done', fileName: 'done', type: 'upload', status: 'success', progress: 100 });
      store.addTransfer({ id: 'active', fileName: 'active', type: 'upload', status: 'processing', progress: 20 });
      store.updateTransfer('active', { statusMessage: 'working' });
      expect(store.transfers().find(t => t.id === 'active')?.statusMessage).toBe('working');
      store.clearCompletedTransfers();
      expect(store.transfers().map(t => t.id)).toEqual(['active']);
    });
  });

  describe('batch operations', () => {
    it('should send only the non-empty file and folder batches', async () => {
      driveServiceSpy.batchSoftDeleteFiles.and.returnValue(of({}));
      driveServiceSpy.batchSoftDeleteFolders.and.returnValue(of({}));
      spyOn(store, 'loadTree').and.returnValue(Promise.resolve());
      spyOn(store, 'loadQuota').and.returnValue(Promise.resolve());

      await store.batchTrashItems([
        { id: 1, isFolder: false } as DriveFile,
        { id: 2, isFolder: true } as DriveFile
      ]);

      expect(driveServiceSpy.batchSoftDeleteFiles).toHaveBeenCalledWith([1]);
      expect(driveServiceSpy.batchSoftDeleteFolders).toHaveBeenCalledWith([2]);
      expect(store.loadTree).toHaveBeenCalled();
      expect(store.loadQuota).toHaveBeenCalled();
    });
  });

  describe('cleanupCancelledUpload (B.17)', () => {
    let promisePrototype: any;
    let nativeFinally: Promise<unknown>['finally'];
    let detachedRejections: unknown[];

    const state = () => store as any;
    const cleanup = (transferId = 'transfer-A') => state().cleanupCancelledUpload(transferId) as Promise<void>;
    const zeroFdk = () => new Uint8Array(32).fill(0x7a);
    const addRuntime = (transferId: string, uploadId: string, fileId: number, fdk: any) => {
      state().activeUploads.set(uploadId, {
        provider: 'local',
        transferId,
        file: new File(['payload'], `${uploadId}.bin`),
        fileId,
        plan: { fdk },
        folderId: null,
        isHiddenProxy: false,
      });
    };

    beforeEach(() => {
      driveServiceSpy.trashFile.and.returnValue(of(undefined));
      driveServiceSpy.hardDeleteFile.and.returnValue(of(undefined));
      driveServiceSpy.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));
      detachedRejections = [];
      promisePrototype = Object.getPrototypeOf((async () => undefined)());
      nativeFinally = promisePrototype.finally;
      promisePrototype.finally = function (onFinally: unknown) {
        const derived = nativeFinally.call(this, onFinally as any);
        derived.catch(error => detachedRejections.push(error));
        return derived;
      };
    });

    afterEach(() => {
      promisePrototype.finally = nativeFinally;
    });

    it('returns the same Promise for concurrent cleanup of one transfer', async () => {
      const trash = new Subject<void>();
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 10, fdk);

      const first = cleanup();
      const second = cleanup();

      expect(second).toBe(first);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(state().uploadCleanupPromises.get('transfer-A')).toBe(first);
      trash.next();
      await first;
      expect(state().uploadCleanupPromises.has('transfer-A')).toBeFalse();
      expect([...fdk]).toEqual(new Array(32).fill(0));
    });

    it('releases a successful cleanup and allows a new cycle', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([11]));
      const first = cleanup();
      await first;
      expect(state().uploadCleanupPromises.has('transfer-A')).toBeFalse();

      const second = cleanup();
      expect(second).not.toBe(first);
      await second;
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
    });

    it('releases a failed cleanup and preserves the original sync rejection', async () => {
      const expected = new Error('offline');
      const sync = spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.reject(expected));

      const first = cleanup();
      await first.then(
        () => fail('cleanup should reject'),
        error => expect(error).toBe(expected),
      );
      expect(state().uploadCleanupPromises.has('transfer-A')).toBeFalse();

      sync.and.returnValue(Promise.resolve());
      const second = cleanup();
      expect(second).not.toBe(first);
      await second;
    });

    it('does not create a detached rejection from cleanup lifecycle release', async () => {
      const expected = new Error('offline');
      spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.reject(expected));

      await cleanup().then(
        () => fail('cleanup should reject'),
        error => expect(error).toBe(expected),
      );
      await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(undefined);
      });
      expect(detachedRejections).toEqual([]);
    });

    it('collects initialized and recovering file IDs exactly once', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([20]));
      state().recoveringUploadFileIds.set('transfer-A', 21);
      await cleanup();

      expect(driveServiceSpy.trashFile.calls.allArgs()).toEqual([[20], [21]]);
      expect(driveServiceSpy.hardDeleteFile.calls.allArgs()).toEqual([[20], [21]]);
    });

    it('hands terminal Google cancellation to the control plane without hard-deleting', async () => {
      const fdk = zeroFdk();
      state().activeUploads.set('runtime-google', {
        provider: 'google_drive',
        transferId: 'transfer-A',
        file: new File(['payload'], 'google.bin'),
        fileId: 30,
        plan: { fdk },
        folderId: null,
        isHiddenProxy: false,
        session: { session_uri: 'https://upload.example/session', access_token: 'ephemeral' },
      });
      state().uploadInitializedFileIds.set('transfer-A', new Set([30]));

      await state().cleanupCancelledUpload('transfer-A', 30);

      expect(driveServiceSpy.cancelExternalUpload).toHaveBeenCalledOnceWith(30);
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      expect(state().uploadInitializedFileIds.has('transfer-A')).toBeFalse();
      expect([...fdk]).toEqual(new Array(32).fill(0));
    });

    it('matches an active runtime by upload transferId', async () => {
      addRuntime('transfer-A', 'runtime-key', 22, zeroFdk());
      await cleanup();
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(22);
      expect(state().activeUploads.has('runtime-key')).toBeFalse();
    });

    it('matches an active runtime by uploadId', async () => {
      addRuntime('other-transfer', 'transfer-A', 23, zeroFdk());
      await cleanup();
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(23);
      expect(state().activeUploads.has('transfer-A')).toBeFalse();
    });

    it('does not collect or remove an unrelated active runtime', async () => {
      const fdk = zeroFdk();
      addRuntime('other-transfer', 'other-runtime', 24, fdk);
      await cleanup();
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(state().activeUploads.has('other-runtime')).toBeTrue();
      expect([...fdk]).toEqual(new Array(32).fill(0x7a));
    });

    it('deduplicates initialized, recovering and active ownership with Set', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([25]));
      state().recoveringUploadFileIds.set('transfer-A', 25);
      addRuntime('transfer-A', 'runtime-A', 25, zeroFdk());
      await cleanup();
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(25);
    });

    it('retires local ownership and zeroizes before the first remote request resolves', async () => {
      const trash = new Subject<void>();
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      const targetFdk = zeroFdk();
      const unrelatedFdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 26, targetFdk);
      addRuntime('other-transfer', 'runtime-other', 27, unrelatedFdk);
      state().uploadInitializedFileIds.set('transfer-A', new Set([26]));
      state().recoveringUploadFileIds.set('transfer-A', 26);

      const pending = cleanup();
      expect(state().uploadInitializedFileIds.has('transfer-A')).toBeTrue();
      expect(state().recoveringUploadFileIds.has('transfer-A')).toBeTrue();
      expect(state().activeUploads.has('runtime-A')).toBeFalse();
      expect(state().activeUploads.has('runtime-other')).toBeTrue();
      expect([...targetFdk]).toEqual(new Array(32).fill(0));
      expect([...unrelatedFdk]).toEqual(new Array(32).fill(0x7a));
      trash.next();
      await pending;
    });

    it('zeroizes the exact FDK reference after successful cleanup', async () => {
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 28, fdk);
      await cleanup();
      expect([...fdk]).toEqual(new Array(32).fill(0));
    });

    it('zeroizes the FDK before and despite a trash failure', async () => {
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 29, fdk);
      spyOn(console, 'error');
      driveServiceSpy.trashFile.and.returnValue(throwError(() => ({ status: 500 })));
      await cleanup();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
    });

    it('zeroizes the FDK despite a hard-delete failure', async () => {
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 30, fdk);
      spyOn(console, 'error');
      driveServiceSpy.hardDeleteFile.and.returnValue(throwError(() => ({ status: 500 })));
      await cleanup();
      expect([...fdk]).toEqual(new Array(32).fill(0));
    });

    it('zeroizes the FDK before a terminal sync failure', async () => {
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 31, fdk);
      const expected = new Error('offline');
      spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.reject(expected));
      await cleanup().catch(error => expect(error).toBe(expected));
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.has('runtime-A')).toBeFalse();
    });

    it('zeroizes every runtime belonging to the same transfer', async () => {
      const firstFdk = zeroFdk();
      const secondFdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A1', 32, firstFdk);
      addRuntime('transfer-A', 'runtime-A2', 33, secondFdk);
      await cleanup();
      expect([...firstFdk]).toEqual(new Array(32).fill(0));
      expect([...secondFdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.size).toBe(0);
    });

    it('keeps trash, hard-delete and next file processing sequential', async () => {
      const events: string[] = [];
      state().uploadInitializedFileIds.set('transfer-A', new Set([34, 35]));
      driveServiceSpy.trashFile.and.callFake((id: number) => {
        events.push(`trash:${id}`);
        return of(undefined);
      });
      driveServiceSpy.hardDeleteFile.and.callFake((id: number) => {
        events.push(`hard:${id}`);
        return of(undefined);
      });
      spyOn(state(), 'syncPendingUploads').and.callFake(() => {
        events.push('sync');
        return Promise.resolve();
      });

      await cleanup();
      expect(events).toEqual(['trash:34', 'hard:34', 'trash:35', 'hard:35', 'sync']);
    });

    it('skips hard-delete for trash 404 and continues to the next file', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([36, 37]));
      spyOn(console, 'error');
      driveServiceSpy.trashFile.and.callFake((id: number) =>
        id === 36 ? throwError(() => ({ status: 404 })) : of(undefined));
      await cleanup();
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(37);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('logs trash non-404 without stopping later files', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([38, 39]));
      spyOn(console, 'error');
      driveServiceSpy.trashFile.and.callFake((id: number) =>
        id === 38 ? throwError(() => ({ status: 500 })) : of(undefined));
      await cleanup();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(39);
    });

    it('ignores hard-delete 404 and continues to the next file', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([40, 41]));
      spyOn(console, 'error');
      driveServiceSpy.hardDeleteFile.and.callFake((id: number) =>
        id === 40 ? throwError(() => ({ status: 404 })) : of(undefined));
      await cleanup();
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(2);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(2);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('logs hard-delete non-404 without stopping later files', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([42, 43]));
      spyOn(console, 'error');
      driveServiceSpy.hardDeleteFile.and.callFake((id: number) =>
        id === 42 ? throwError(() => ({ status: 500 })) : of(undefined));
      await cleanup();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(2);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(43);
    });

    it('continues remote cleanup when the first trash request fails', async () => {
      state().uploadInitializedFileIds.set('transfer-A', new Set([44, 45]));
      spyOn(console, 'error');
      driveServiceSpy.trashFile.and.callFake((id: number) =>
        id === 44 ? throwError(() => ({ status: 500 })) : of(undefined));
      await cleanup();
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(45);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(45);
    });

    it('syncs exactly once even when there are no file IDs', async () => {
      const sync = spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.resolve());
      await cleanup();
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('syncs exactly once after all remote cleanup attempts', async () => {
      const events: string[] = [];
      state().uploadInitializedFileIds.set('transfer-A', new Set([46, 47, 48]));
      driveServiceSpy.trashFile.and.callFake((id: number) => {
        events.push(`trash:${id}`);
        return of(undefined);
      });
      driveServiceSpy.hardDeleteFile.and.callFake((id: number) => {
        events.push(`hard:${id}`);
        return of(undefined);
      });
      const sync = spyOn(state(), 'syncPendingUploads').and.callFake(() => {
        events.push('sync');
        return Promise.resolve();
      });
      await cleanup();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(events[events.length - 1]).toBe('sync');
    });

    it('cancels a normal upload and cleans its owned runtime once', async () => {
      const fdk = zeroFdk();
      addRuntime('transfer-A', 'runtime-A', 49, fdk);
      store.transfers.set([{ id: 'transfer-A', fileName: 'a', type: 'upload', status: 'processing', progress: 10, timestamp: new Date() }]);

      await store.cancelTransfer('transfer-A');
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(49);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(49);
      expect(state().activeUploads.has('runtime-A')).toBeFalse();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(store.transfers()[0].status).toBe('cancelled');
    });

    it('does not duplicate deletion for a recovery runtime owned by cleanup', async () => {
      const fdk = zeroFdk();
      addRuntime('recovery-A', 'recovery-A_recovery', 50, fdk);
      store.transfers.set([{
        id: 'recovery-A', fileName: 'recovery', type: 'upload', status: 'paused', progress: 40,
        timestamp: new Date(), isRecovery: true,
        pendingData: { id: 50, folder_id: null, encrypted_name: 'enc', size_bytes: 1, total_chunks: 1, encrypted_fdk: 'fdk', uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null }
      }]);

      await store.cancelTransfer('recovery-A');
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect([...fdk]).toEqual(new Array(32).fill(0));
    });

    it('uses recovery pendingData fallback only when cleanup has no ownership', async () => {
      store.transfers.set([{
        id: 'recovery-B', fileName: 'recovery', type: 'upload', status: 'paused', progress: 40,
        timestamp: new Date(), isRecovery: true,
        pendingData: { id: 51, folder_id: null, encrypted_name: 'enc', size_bytes: 1, total_chunks: 1, encrypted_fdk: 'fdk', uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null }
      }]);

      await store.cancelTransfer('recovery-B');
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(51);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(51);
    });

    it('does not invoke upload cleanup endpoints when cancelling a download', async () => {
      const cancelDownload = spyOn(state().downloadEngine, 'cancel');
      store.transfers.set([{ id: 'download-A', fileName: 'a', type: 'download', status: 'processing', progress: 10, timestamp: new Date() }]);

      await store.cancelTransfer('download-A');
      expect(cancelDownload).toHaveBeenCalledWith('download-A');
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      expect(store.transfers()[0].status).toBe('cancelled');
    });

    it('keeps cancelling status while remote cleanup is pending', async () => {
      const trash = new Subject<void>();
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      addRuntime('transfer-A', 'runtime-A', 52, zeroFdk());
      store.transfers.set([{ id: 'transfer-A', fileName: 'a', type: 'upload', status: 'processing', progress: 10, timestamp: new Date() }]);

      const cancellation = store.cancelTransfer('transfer-A');
      expect(store.transfers()[0].status).toBe('cancelling');
      trash.next();
      await cancellation;
      expect(store.transfers()[0].status).toBe('cancelled');
    });

    it('A18M2-CLEANUP-RECOVERY-001 não republica recuperação cancelada após logout durante cleanup próprio', async () => {
      const trash = new Subject<void>();
      const fdk = new Uint8Array(32).fill(0x74);
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      addRuntime('recovery-cleanup-logout', 'recovery-runtime', 55, fdk);
      store.transfers.set([{
        id: 'recovery-cleanup-logout', fileName: 'recovery.bin', type: 'upload', status: 'paused', progress: 40,
        timestamp: new Date(), isRecovery: true,
        pendingData: { id: 55, folder_id: null, encrypted_name: 'enc', size_bytes: 1, total_chunks: 1, encrypted_fdk: 'fdk', uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null }
      }]);

      const cancellation = store.cancelTransfer('recovery-cleanup-logout');
      expect(driveServiceSpy.trashFile).toHaveBeenCalledOnceWith(55);
      state().resetUploadRuntimeState();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.size).toBe(0);
      expect(store.transfers()).toEqual([]);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();

      trash.next();
      trash.complete();
      await cancellation;

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledOnceWith(55);
      expect(driveServiceSpy.cancelExternalUpload).not.toHaveBeenCalled();
      expect(store.transfers()).toEqual([]);
    });

    it('A18M2-CLEANUP-RECOVERY-002 não republica recuperação após logout durante cleanup fallback', async () => {
      const trash = new Subject<void>();
      let fallbackStarted!: () => void;
      const started = new Promise<void>(resolve => { fallbackStarted = resolve; });
      driveServiceSpy.trashFile.and.callFake((id: number) => {
        if (id === 56) {
          fallbackStarted();
          return trash.asObservable();
        }
        return of(undefined);
      });
      store.transfers.set([{
        id: 'recovery-fallback-logout', fileName: 'recovery.bin', type: 'upload', status: 'paused', progress: 40,
        timestamp: new Date(), isRecovery: true,
        pendingData: { id: 56, folder_id: null, encrypted_name: 'enc', size_bytes: 1, total_chunks: 1, encrypted_fdk: 'fdk', uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null }
      }]);

      const cancellation = store.cancelTransfer('recovery-fallback-logout');
      await started;
      expect(driveServiceSpy.trashFile).toHaveBeenCalledOnceWith(56);
      state().resetUploadRuntimeState();
      expect(store.transfers()).toEqual([]);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();

      trash.next();
      trash.complete();
      await cancellation;

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledOnceWith(56);
      expect(store.transfers()).toEqual([]);
    });

    it('does not start cleanup for terminal transfers', async () => {
      store.transfers.set([
        { id: 'success-A', fileName: 'a', type: 'upload', status: 'success', progress: 100, timestamp: new Date() },
        { id: 'error-A', fileName: 'b', type: 'upload', status: 'error', progress: 10, timestamp: new Date() },
        { id: 'cancelled-A', fileName: 'c', type: 'upload', status: 'cancelled', progress: 10, timestamp: new Date() },
      ]);

      await store.cancelTransfer('success-A');
      await store.cancelTransfer('error-A');
      await store.cancelTransfer('cancelled-A');
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
    });

    it('shares a pending cleanup with recovery cancellation without fallback deletion', async () => {
      const trash = new Subject<void>();
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      addRuntime('recovery-C', 'recovery-C_recovery', 53, zeroFdk());
      const first = cleanup('recovery-C');
      store.transfers.set([{
        id: 'recovery-C', fileName: 'recovery', type: 'upload', status: 'cancelling', progress: 40,
        timestamp: new Date(), isRecovery: true,
        pendingData: { id: 53, folder_id: null, encrypted_name: 'enc', size_bytes: 1, total_chunks: 1, encrypted_fdk: 'fdk', uploaded_chunks_count: 0, storage_provider: 'local', external_storage_id: null }
      }]);

      const cancellation = store.cancelTransfer('recovery-C');
      expect(state().uploadCleanupPromises.get('recovery-C')).toBe(first);
      trash.next();
      await Promise.all([first, cancellation]);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
    });

    it('A18M-CLEANUP-001 termina uma limpeza explícita já iniciada sem duplicá-la no logout', async () => {
      const trash = new Subject<void>();
      driveServiceSpy.trashFile.and.returnValue(trash.asObservable());
      const fdk = zeroFdk();
      addRuntime('cleanup-in-flight-logout', 'cleanup-runtime', 54, fdk);
      store.transfers.set([{
        id: 'cleanup-in-flight-logout', fileName: 'cleanup.bin', type: 'upload', status: 'processing',
        progress: 40, timestamp: new Date(),
      }]);

      const cancellation = store.cancelTransfer('cleanup-in-flight-logout');
      expect(store.transfers()[0].status).toBe('cancelling');
      expect(driveServiceSpy.trashFile).toHaveBeenCalledOnceWith(54);

      state().resetUploadRuntimeState();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(store.transfers()).toEqual([]);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();

      trash.next();
      await cancellation;

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledOnceWith(54);
      expect(driveServiceSpy.cancelExternalUpload).not.toHaveBeenCalled();
      expect(store.transfers()).toEqual([]);
    });

    it('preserves sync rejection through the public cancellation caller', async () => {
      const expected = new Error('offline');
      spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.reject(expected));
      store.transfers.set([{ id: 'transfer-A', fileName: 'a', type: 'upload', status: 'processing', progress: 10, timestamp: new Date() }]);

      await store.cancelTransfer('transfer-A').then(
        () => fail('cancellation should reject'),
        error => expect(error).toBe(expected),
      );
      expect(store.transfers()[0].status).toBe('cancelling');
      expect(state().uploadCleanupPromises.has('transfer-A')).toBeFalse();
    });
  });

  describe('resetUploadRuntimeState (B.87)', () => {
    const state = () => store as any;
    const reset = () => state().resetUploadRuntimeState();
    const runtime = (transferId: string, uploadId: string, provider: 'local' | 'google_drive', fdk: Uint8Array) => ({
      provider,
      transferId,
      file: new File(['payload'], `${uploadId}.bin`),
      fileId: provider === 'local' ? 201 : 202,
      plan: { fdk },
      folderId: null,
      initRes: {},
      isHiddenProxy: false,
      ...(provider === 'google_drive'
        ? { session: { session_uri: 'https://upload.example/session', access_token: 'ephemeral' } }
        : {}),
    });
    const pending = (id: number) => ({
      id,
      folder_id: null,
      encrypted_name: 'encrypted-name',
      size_bytes: 1,
      total_chunks: 1,
      encrypted_fdk: 'encrypted-fdk',
      uploaded_chunks_count: 0,
      storage_provider: 'local' as const,
      external_storage_id: null,
    });
    const file = (name: string) => new File(['payload'], name);
    const prepared = (fdk: Uint8Array, source: File) => ({
      file: source,
      encryptedName: 'encrypted-name',
      nameHash: '',
      encryptedFdk: 'encrypted-fdk',
      fdk,
      totalChunks: 1,
      encryptedSize: 9,
      baseNonce: new Uint8Array(24).fill(7),
    });

    it('aborta e zeroiza runtimes ativos sem executar limpeza remota', () => {
      const localController = new AbortController();
      const groupController = new AbortController();
      const localFdk = new Uint8Array(32).fill(0x7a);
      const googleFdk = new Uint8Array(32).fill(0x7b);
      state().activeUploads.set('local-runtime', runtime('upload-local', 'local-runtime', 'local', localFdk));
      state().activeUploads.set('google-runtime', runtime('upload-google', 'google-runtime', 'google_drive', googleFdk));
      state().uploadControllers.set('upload-local', localController);
      state().uploadGroupControllers.set('group-1', groupController);
      state().uploadOperations.set('upload-local', Promise.resolve());
      state().uploadInitializedFileIds.set('upload-local', new Set([201]));
      state().recoveringUploadFileIds.set('upload-google', 202);
      state().uploadCleanupPromises.set('upload-local', Promise.resolve());
      state().googleCleanupPendingFileIds.set('upload-google', 202);
      state().googleCleanupBlockedTransfers.add('upload-google');
      state().pausedTransfers.add('upload-local');
      state().cancelledTransfers.add('upload-google');
      store.transfers.set([
        { id: 'upload-local', fileName: 'local', type: 'upload', status: 'processing', progress: 20, timestamp: new Date() },
        { id: 'download-keep', fileName: 'download', type: 'download', status: 'processing', progress: 20, timestamp: new Date() },
      ]);
      state().transferGroups.set([{
        id: 'group-1', source: 'multiple-files', transferIds: ['upload-local', 'download-keep'], createdAt: 1,
        cancelledTransferIds: ['upload-google'], cancelledBytes: { 'upload-google': { totalBytes: 1, transferredBytes: 1 } },
      }]);

      reset();

      expect(localController.signal.aborted).toBeTrue();
      expect(groupController.signal.aborted).toBeTrue();
      expect([...localFdk]).toEqual(new Array(32).fill(0));
      expect([...googleFdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.size).toBe(0);
      expect(state().uploadControllers.size).toBe(0);
      expect(state().uploadGroupControllers.size).toBe(0);
      expect(state().uploadOperations.size).toBe(0);
      expect(state().uploadInitializedFileIds.size).toBe(0);
      expect(state().recoveringUploadFileIds.size).toBe(0);
      expect(state().uploadCleanupPromises.size).toBe(0);
      expect(state().googleCleanupPendingFileIds.size).toBe(0);
      expect(state().googleCleanupBlockedTransfers.size).toBe(0);
      expect(state().pausedTransfers.has('upload-local')).toBeFalse();
      expect(state().cancelledTransfers.has('upload-google')).toBeFalse();
      expect(store.transfers().map(item => item.id)).toEqual(['download-keep']);
      expect(state().transferGroups()[0].transferIds).toEqual(['download-keep']);
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.cancelExternalUpload).not.toHaveBeenCalled();
    });

    it('é idempotente e não altera downloads ao ser chamada novamente', () => {
      store.transfers.set([
        { id: 'download-keep', fileName: 'download', type: 'download', status: 'processing', progress: 20, timestamp: new Date() },
      ]);

      expect(() => reset()).not.toThrow();
      expect(() => reset()).not.toThrow();
      expect(store.transfers().map(item => item.id)).toEqual(['download-keep']);
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
    });

    it('torna um resultado de upload antigo inerte após o reset', async () => {
      const controller = new AbortController();
      const fdk = new Uint8Array(32).fill(0x7a);
      state().uploadControllers.set('upload-race', controller);
      state().activeUploads.set('upload-race_runtime', runtime('upload-race', 'upload-race_runtime', 'local', fdk));
      store.transfers.set([{ id: 'upload-race', fileName: 'race', type: 'upload', status: 'processing', progress: 20, timestamp: new Date() }]);
      let resolveExecution!: (value: { paused: boolean; cancelled?: boolean }) => void;
      spyOn(state().uploadEngine, 'executeLocal').and.returnValue(new Promise(resolve => { resolveExecution = resolve; }));

      const execution = state().runUploadLoop('upload-race_runtime', 'upload-race', 201, false);
      reset();
      resolveExecution({ paused: false, cancelled: true });
      await execution;

      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      expect(store.transfers()).toEqual([]);
    });

    it('A18M-RECOVERY-001 zera a FDK reconstruída se o logout ocorrer antes do handoff', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('p'.repeat(32))));
      let capturedFdk: Uint8Array | undefined;
      let preparationStarted!: () => void;
      const started = new Promise<void>(resolve => { preparationStarted = resolve; });
      let resolvePreparation!: (value: any) => void;
      const preparation = new Promise<any>(resolve => { resolvePreparation = resolve; });
      spyOn(state(), 'prepareLocalRecovery').and.callFake((_id: string, _data: any, _source: File, fdk: Uint8Array) => {
        capturedFdk = fdk;
        preparationStarted();
        return preparation;
      });
      const runUploadLoop = spyOn(state(), 'runUploadLoop').and.resolveTo();
      const transfer = {
        id: 'recovery-pre-handoff-logout', fileName: 'pre-handoff.bin', type: 'upload' as const,
        status: 'paused' as const, progress: 20, timestamp: new Date(), isRecovery: true,
        pendingData: pending(109),
      };
      store.transfers.set([transfer]);

      const recovery = store.recoverUpload(transfer.id, transfer.pendingData!, file('pre-handoff.bin'));
      await started;
      const exactFdk = capturedFdk!;
      expect([...exactFdk]).toEqual(new Array(32).fill(0x70));

      state().resetUploadRuntimeState();
      expect(state().activeUploads.size).toBe(0);
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      resolvePreparation(prepared(exactFdk, file('pre-handoff.bin')));
      await recovery;

      expect([...exactFdk]).toEqual(new Array(32).fill(0));
      expect(runUploadLoop).not.toHaveBeenCalled();
      expect(store.transfers()).toEqual([]);
    });

    it('A18M-RECOVERY-002 zera imediatamente a FDK após o handoff quando ocorre logout', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('q'.repeat(32))));
      const exactFdk = new Uint8Array(32).fill(0x71);
      spyOn(state(), 'prepareLocalRecovery').and.returnValue(
        Promise.resolve(prepared(exactFdk, file('post-handoff.bin'))),
      );
      let executionStarted!: () => void;
      const started = new Promise<void>(resolve => { executionStarted = resolve; });
      const executeLocal = spyOn(state().uploadEngine, 'executeLocal').and.callFake(
        (_plan: any, _fileId: number, control: any) => {
          executionStarted();
          return new Promise(resolve => {
            const detached = () => resolve({ paused: false, cancelled: true });
            if (control.signal.aborted) detached();
            else control.signal.addEventListener('abort', detached, { once: true });
          });
        },
      );
      const transfer = {
        id: 'recovery-post-handoff-logout', fileName: 'post-handoff.bin', type: 'upload' as const,
        status: 'paused' as const, progress: 20, timestamp: new Date(), isRecovery: true,
        pendingData: pending(110),
      };
      store.transfers.set([transfer]);

      const recovery = store.recoverUpload(transfer.id, transfer.pendingData!, file('post-handoff.bin'));
      await started;
      expect(state().activeUploads.has(`${transfer.id}_recovery`)).toBeTrue();

      state().resetUploadRuntimeState();
      expect([...exactFdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.size).toBe(0);
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
      await recovery;

      expect(executeLocal).toHaveBeenCalledOnceWith(
        jasmine.anything(), 110, jasmine.anything(), jasmine.anything(),
      );
      expect(store.transfers()).toEqual([]);
    });

    it('A18M-SESSION-001 aceita um novo upload depois do reset da sessão anterior', async () => {
      store.setStorageProvider('local');
      const oldFdk = new Uint8Array(32).fill(0x72);
      state().activeUploads.set('old-runtime', runtime('old-upload', 'old-runtime', 'local', oldFdk));
      store.transfers.set([{ id: 'old-upload', fileName: 'old.bin', type: 'upload', status: 'processing', progress: 20, timestamp: new Date() }]);
      state().resetUploadRuntimeState();

      const fileToUpload = file('fresh.bin');
      const freshFdk = new Uint8Array(32).fill(0x73);
      const plan = {
        file: fileToUpload, encryptedName: 'encrypted-name', nameHash: 'name-hash',
        encryptedFdk: 'encrypted-fdk', fdk: freshFdk, totalChunks: 1, encryptedSize: 9,
        baseNonce: new Uint8Array(24).fill(8),
      };
      spyOn(state().uploadEngine, 'planUpload').and.resolveTo(plan as any);
      spyOn(state().uploadEngine, 'executeLocal').and.resolveTo({ paused: false });
      driveServiceSpy.initFileUpload.and.returnValue(of({ file_id: 111 }));

      await store.uploadFile(fileToUpload, null, false, undefined, 'fresh-next-session');

      expect(driveServiceSpy.initFileUpload).toHaveBeenCalledTimes(1);
      expect(state().uploadEngine.planUpload).toHaveBeenCalledOnceWith(fileToUpload, jasmine.anything());
      expect(state().uploadEngine.executeLocal).toHaveBeenCalled();
      expect(store.transfers().find(item => item.id === 'fresh-next-session')?.status).toBe('success');
      expect([...freshFdk]).toEqual(new Array(32).fill(0));
      expect([...oldFdk]).toEqual(new Array(32).fill(0));
      expect(driveServiceSpy.trashFile).not.toHaveBeenCalled();
      expect(driveServiceSpy.hardDeleteFile).not.toHaveBeenCalled();
    });
  });

  describe('recoverUpload (B.32)', () => {
    const state = () => store as any;
    const pending = (id: number, encryptedFdk = 'encrypted-fdk') => ({
      id,
      folder_id: null,
      encrypted_name: 'encrypted-name',
      size_bytes: 1,
      total_chunks: 1,
      encrypted_fdk: encryptedFdk,
      uploaded_chunks_count: 0,
      storage_provider: 'local' as const,
      external_storage_id: null,
    });
    const file = (name: string) => new File(['payload'], name);
    const prepared = (fdk: Uint8Array, source: File) => ({
      file: source,
      encryptedName: 'encrypted-name',
      nameHash: '',
      encryptedFdk: 'encrypted-fdk',
      fdk,
      totalChunks: 1,
      encryptedSize: 9,
      baseNonce: new Uint8Array(24).fill(7),
    });

    it('deduplicates concurrent recovery calls for the same transfer id', async () => {
      let resolveDecrypt!: (value: string) => void;
      const decrypt = new Promise<string>(resolve => { resolveDecrypt = resolve; });
      cryptoServiceSpy.decryptName.and.returnValue(decrypt);
      spyOn(state(), 'prepareLocalRecovery').and.callFake((_id: string, _data: any, source: File, fdk: Uint8Array) =>
        Promise.resolve(prepared(fdk, source)));
      spyOn(state(), 'runUploadLoop').and.callFake((_uploadId: string, id: string) => {
        state().releaseTerminalUploadRuntime(id);
        return Promise.resolve();
      });

      const first = store.recoverUpload('recovery-same', pending(101), file('first.bin'));
      const second = store.recoverUpload('recovery-same', pending(101), file('second.bin'));

      expect(second).toBe(first);
      expect(cryptoServiceSpy.decryptName).toHaveBeenCalledTimes(1);
      resolveDecrypt(btoa('a'.repeat(32)));
      await first;
    });

    it('releases the recovery controller after successful terminal recovery', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('b'.repeat(32))));
      spyOn(state(), 'prepareLocalRecovery').and.callFake((_id: string, _data: any, source: File, fdk: Uint8Array) =>
        Promise.resolve(prepared(fdk, source)));
      spyOn(state(), 'runUploadLoop').and.callFake((_uploadId: string, id: string) => {
        state().releaseTerminalUploadRuntime(id);
        return Promise.resolve();
      });

      await store.recoverUpload('recovery-success', pending(102), file('success.bin'));

      expect(state().uploadControllers.has('recovery-success')).toBeFalse();
    });

    it('releases the recovery controller after terminal recovery failure', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('c'.repeat(32))));
      spyOn(state(), 'prepareLocalRecovery').and.callFake((_id: string, _data: any, source: File, fdk: Uint8Array) =>
        Promise.resolve(prepared(fdk, source)));
      spyOn(state(), 'runUploadLoop').and.callFake(() => Promise.reject(new Error('upload failed')));

      await store.recoverUpload('recovery-error', pending(103), file('error.bin'));

      expect(state().uploadControllers.has('recovery-error')).toBeFalse();
    });

    it('keeps recoveries for different transfer ids independent', async () => {
      let resolveA!: (value: string) => void;
      let resolveB!: (value: string) => void;
      const decryptA = new Promise<string>(resolve => { resolveA = resolve; });
      const decryptB = new Promise<string>(resolve => { resolveB = resolve; });
      cryptoServiceSpy.decryptName.and.callFake((value: string) => value === 'a' ? decryptA : decryptB);
      spyOn(state(), 'prepareLocalRecovery').and.callFake((_id: string, _data: any, source: File, fdk: Uint8Array) =>
        Promise.resolve(prepared(fdk, source)));
      spyOn(state(), 'runUploadLoop').and.callFake((_uploadId: string, id: string) => {
        state().releaseTerminalUploadRuntime(id);
        return Promise.resolve();
      });

      const first = store.recoverUpload('recovery-a', pending(104, 'a'), file('a.bin'));
      const second = store.recoverUpload('recovery-b', pending(105, 'b'), file('b.bin'));
      resolveA(btoa('d'.repeat(32)));
      await first;
      expect(state().uploadControllers.has('recovery-b')).toBeTrue();
      resolveB(btoa('e'.repeat(32)));
      await second;
      expect(state().uploadControllers.has('recovery-a')).toBeFalse();
      expect(state().uploadControllers.has('recovery-b')).toBeFalse();
    });

    it('makes cancellation await the canonical recovery operation', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('f'.repeat(32))));
      driveServiceSpy.trashFile.and.returnValue(of(undefined));
      driveServiceSpy.hardDeleteFile.and.returnValue(of(undefined));
      driveServiceSpy.getPendingUploads.and.returnValue(of({ pending_uploads: [] }));
      let resolvePreparation!: (value: any) => void;
      const preparation = new Promise<any>(resolve => { resolvePreparation = resolve; });
      let resolvePreparationStarted!: () => void;
      const preparationStarted = new Promise<void>(resolve => { resolvePreparationStarted = resolve; });
      spyOn(state(), 'prepareLocalRecovery').and.callFake(() => {
        resolvePreparationStarted();
        return preparation;
      });

      const transfer = {
        id: 'recovery-cancel',
        fileName: 'cancel.bin',
        type: 'upload' as const,
        status: 'paused' as const,
        progress: 40,
        timestamp: new Date(),
        isRecovery: true,
        pendingData: pending(106),
      };
      store.transfers.set([transfer]);
      const recovery = store.recoverUpload(transfer.id, transfer.pendingData!, file('cancel.bin'));
      await preparationStarted;
      let cancellationSettled = false;
      const cancellation = store.cancelTransfer(transfer.id).then(() => { cancellationSettled = true; });

      await Promise.resolve();
      expect(state().uploadOperations.has(transfer.id)).toBeTrue();
      expect(cancellationSettled).toBeFalse();
      resolvePreparation(prepared(new Uint8Array(32), file('cancel.bin')));
      await Promise.all([recovery, cancellation]);

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect(store.transfers()[0].status).toBe('cancelled');
    });

    it('does not fallback-delete a recovery already cleaned by its canonical runtime', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('g'.repeat(32))));
      driveServiceSpy.trashFile.and.returnValue(of(undefined));
      driveServiceSpy.hardDeleteFile.and.returnValue(of(undefined));
      const sync = spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.resolve());
      const fdk = new Uint8Array(32).fill(0x67);
      const recovery = {
        id: 'recovery-post-handoff',
        fileName: 'post-handoff.bin',
        type: 'upload' as const,
        status: 'paused' as const,
        progress: 40,
        timestamp: new Date(),
        isRecovery: true,
        pendingData: pending(107),
      };
      store.transfers.set([recovery]);
      const prepare = spyOn(state(), 'prepareLocalRecovery')
        .and.returnValue(Promise.resolve(prepared(fdk, file('post-handoff.bin'))));

      let executionStartedResolve!: () => void;
      const executionStarted = new Promise<void>(resolve => { executionStartedResolve = resolve; });
      let executionCancelledResolve!: () => void;
      const executionCancelled = new Promise<void>(resolve => { executionCancelledResolve = resolve; });
      const execute = spyOn(state().uploadEngine, 'executeLocal').and.callFake((_plan: any, _fileId: number, control: any) => {
        executionStartedResolve();
        return new Promise(resolve => {
          const finishCancelled = () => {
            executionCancelledResolve();
            resolve({ paused: false, cancelled: true });
          };
          if (control.signal.aborted) finishCancelled();
          else control.signal.addEventListener('abort', finishCancelled, { once: true });
        });
      });

      const recoveryOperation = store.recoverUpload(recovery.id, recovery.pendingData!, file('post-handoff.bin'));
      await executionStarted;
      expect(state().activeUploads.has(`${recovery.id}_recovery`)).toBeTrue();
      expect(state().uploadOperations.has(recovery.id)).toBeTrue();

      const cancellation = store.cancelTransfer(recovery.id);
      await executionCancelled;
      await Promise.all([recoveryOperation, cancellation]);

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(recovery.pendingData!.id);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(recovery.pendingData!.id);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(state().activeUploads.has(`${recovery.id}_recovery`)).toBeFalse();
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(state().uploadOperations.has(recovery.id)).toBeFalse();
      expect(state().uploadControllers.has(recovery.id)).toBeFalse();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(store.transfers()[0].status).toBe('cancelled');
    });

    it('preserves canonical cleanup rejection after recovery runtime handoff', async () => {
      cryptoServiceSpy.decryptName.and.returnValue(Promise.resolve(btoa('h'.repeat(32))));
      driveServiceSpy.trashFile.and.returnValue(of(undefined));
      driveServiceSpy.hardDeleteFile.and.returnValue(of(undefined));
      const expected = new Error('offline');
      const sync = spyOn(state(), 'syncPendingUploads').and.returnValue(Promise.reject(expected));
      const fdk = new Uint8Array(32).fill(0x68);
      const recovery = {
        id: 'recovery-post-handoff-error',
        fileName: 'post-handoff-error.bin',
        type: 'upload' as const,
        status: 'paused' as const,
        progress: 40,
        timestamp: new Date(),
        isRecovery: true,
        pendingData: pending(108),
      };
      store.transfers.set([recovery]);
      const prepare = spyOn(state(), 'prepareLocalRecovery')
        .and.returnValue(Promise.resolve(prepared(fdk, file('post-handoff-error.bin'))));

      let executionStartedResolve!: () => void;
      const executionStarted = new Promise<void>(resolve => { executionStartedResolve = resolve; });
      let executionCancelledResolve!: () => void;
      const executionCancelled = new Promise<void>(resolve => { executionCancelledResolve = resolve; });
      const execute = spyOn(state().uploadEngine, 'executeLocal').and.callFake((_plan: any, _fileId: number, control: any) => {
        executionStartedResolve();
        return new Promise(resolve => {
          const finishCancelled = () => {
            executionCancelledResolve();
            resolve({ paused: false, cancelled: true });
          };
          if (control.signal.aborted) finishCancelled();
          else control.signal.addEventListener('abort', finishCancelled, { once: true });
        });
      });

      const recoveryOperation = store.recoverUpload(recovery.id, recovery.pendingData!, file('post-handoff-error.bin'));
      await executionStarted;
      expect(state().activeUploads.has(`${recovery.id}_recovery`)).toBeTrue();
      expect(state().uploadOperations.has(recovery.id)).toBeTrue();

      const cancellation = store.cancelTransfer(recovery.id);
      await executionCancelled;
      const expectSameRejection = (operation: Promise<unknown>) => operation.then(
        () => fail('operation should preserve canonical cleanup rejection'),
        error => expect(error).toBe(expected),
      );
      await Promise.all([expectSameRejection(recoveryOperation), expectSameRejection(cancellation)]);

      expect(driveServiceSpy.trashFile).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(driveServiceSpy.trashFile).toHaveBeenCalledWith(recovery.pendingData!.id);
      expect(driveServiceSpy.hardDeleteFile).toHaveBeenCalledWith(recovery.pendingData!.id);
      expect([...fdk]).toEqual(new Array(32).fill(0));
      expect(state().activeUploads.has(`${recovery.id}_recovery`)).toBeFalse();
      expect(state().uploadCleanupPromises.has(recovery.id)).toBeFalse();
      expect(state().uploadOperations.has(recovery.id)).toBeFalse();
      expect(state().uploadControllers.has(recovery.id)).toBeFalse();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
});
