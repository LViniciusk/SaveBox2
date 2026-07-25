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
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';

describe('DriveStore', () => {
  let store: DriveStore;
  let driveServiceSpy: any;
  let cryptoServiceSpy: any;
  let appStateSpy: any;

  beforeEach(() => {
    driveServiceSpy = jasmine.createSpyObj('DriveService', [
      'updateFile', 'trashFile', 'restoreFile', 'getTree', 'getQuota', 'getTrash'
      , 'getPendingUploads', 'batchSoftDeleteFiles', 'batchSoftDeleteFolders'
    ]);
    cryptoServiceSpy = jasmine.createSpyObj('CryptoService', ['isVaultUnlocked', 'decryptName']);
    const kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['encryptFile']);
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

    driveServiceSpy.getTree.and.returnValue(of({ files: [], folders: [] }));
    driveServiceSpy.getQuota.and.returnValue(of({ used_bytes: 0, max_bytes: 100 }));
    driveServiceSpy.getTrash.and.returnValue(of({ files: [], folders: [] }));
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
        { id: 1, isFolder: false, decryptedName: 'test.pdf', encryptedName: 'enc1', type: 'pdf', sizeBytes: 100, sizeFormatted: '100 B', modifiedAt: '', owner: '' },
        { id: 2, isFolder: true, decryptedName: 'folder', encryptedName: 'enc2', type: 'folder', sizeBytes: 0, sizeFormatted: '0 B', modifiedAt: '', owner: '' }
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
        { id: 10, isFolder: true, parentId: 5, decryptedName: 'child', encryptedName: 'enc', type: 'folder', sizeBytes: 0, sizeFormatted: '', modifiedAt: '', owner: '' }
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
        ]
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
});
});
