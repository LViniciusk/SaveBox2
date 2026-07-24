import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { DriveFile, DriveStore } from './drive.store';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { AppStateService, AppStatus } from '../../../core/state/app-state.service';

describe('DriveStore public behavior', () => {
  let store: DriveStore;
  let drive: jasmine.SpyObj<DriveService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  const status = signal(AppStatus.Unlocked);

  beforeEach(() => {
    status.set(AppStatus.Unlocked);
    drive = jasmine.createSpyObj('DriveService', [
      'getTree', 'getQuota', 'getPendingUploads', 'getTrash', 'createFolder', 'updateFolder',
      'updateFile', 'trashFolder', 'trashFile', 'hardDeleteFolder', 'hardDeleteFile',
      'restoreFolder', 'restoreFile', 'emptyTrash', 'batchSoftDeleteFiles', 'batchSoftDeleteFolders',
      'batchHardDeleteFiles', 'batchHardDeleteFolders', 'downloadFileRange',
      'getLinkedGoogleAccounts', 'generateGoogleState', 'unlinkGoogleAccount',
      'downloadExternalMetadata',
    ]);
    crypto = jasmine.createSpyObj('CryptoService', [
      'isVaultUnlocked', 'decryptName', 'encryptName', 'hashName',
    ]);
    const appState = jasmine.createSpyObj('AppStateService', [], { status });
    const kasumi = jasmine.createSpyObj('KasumiCryptoService', ['extractMetadata', 'encryptFile']);
    const dialog = jasmine.createSpyObj('DialogService', ['confirm']);
    const transcoder = jasmine.createSpyObj('VideoTranscoderService', ['isVideo']);

    drive.getTree.and.returnValue(of({ folders: [], files: [] }));
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
    drive.restoreFolder.and.returnValue(of(undefined));
    drive.restoreFile.and.returnValue(of(undefined));
    drive.emptyTrash.and.returnValue(of({}));
    drive.batchSoftDeleteFiles.and.returnValue(of(undefined));
    drive.batchSoftDeleteFolders.and.returnValue(of(undefined));
    drive.batchHardDeleteFiles.and.returnValue(of(undefined));
    drive.batchHardDeleteFolders.and.returnValue(of(undefined));
    drive.getLinkedGoogleAccounts.and.returnValue(of([]));
    drive.generateGoogleState.and.returnValue(of({ state: 'state' }));
    drive.unlinkGoogleAccount.and.returnValue(of({}));
    drive.downloadExternalMetadata.and.returnValue(of({
      storage_provider: 'google_drive', external_file_id: 'external', access_token: 'token'
    }));
    crypto.isVaultUnlocked.and.returnValue(true);
    crypto.decryptName.and.callFake(async (value: string) => value);
    crypto.encryptName.and.resolveTo('encrypted');
    crypto.hashName.and.resolveTo('hash');

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

  it('classifies every supported file type and normalizes folder ancestry', async () => {
    const names = ['a.pdf', 'b.jpg', 'c.docx', 'd.xlsx', 'e.mp4', 'f.mp3', 'g.bin'];
    drive.getTree.and.returnValue(of({
      folders: [{ id: 10, parent_id: null, encrypted_name: 'root' }],
      files: names.map((encrypted_name, id) => ({ id, encrypted_name, size_bytes: id ? 1024 : 0, folder_id: null, encrypted_fdk: 'fdk', is_hidden: false })),
    }));
    await store.loadTree();
    expect(store.files().map(file => file.type)).toEqual(['folder', 'pdf', 'image', 'doc', 'spreadsheet', 'video', 'audio', 'unknown']);
    expect(store.files()[1].sizeFormatted).toBe('0 B');
    expect(store.files()[2].sizeFormatted).toBe('1 KB');
    expect(store.files()[0].parentId).toBeNull();
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

  it('rejects encryption operations while locked and clears sensitive derived state', async () => {
    crypto.isVaultUnlocked.and.returnValue(false);
    await expectAsync(store.createFolder('secret')).toBeRejectedWithError('Drive trancado');
    store.files.set([{ id: 1, decryptedName: 'name' } as DriveFile]);
    store.thumbnails.set({ 1: 'data' });
    status.set(AppStatus.Locked);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.thumbnails()).toEqual({});
    store.clearDecryptedNames();
    expect(store.files()[0].decryptedName).toBeNull();
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
    store.trashFiles.set([{ id: 3, isFolder: false, decryptedName: '__PROXY__x', folderId: null } as DriveFile]);
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
    drive.getLinkedGoogleAccounts.and.returnValue(of({ accounts: [{ id: 1 }] } as any));
    await store.loadLinkedAccounts();
    expect(store.linkedAccounts()).toEqual([{ id: 1 }] as any);
    drive.getLinkedGoogleAccounts.and.returnValue(throwError(() => new Error('offline')));
    await store.loadLinkedAccounts();
    expect(store.linkedAccounts()).toEqual([]);
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
    expect(store.transfers().some(t => t.id === 'bytes')).toBeFalse();
  });

  it('cancels a recovered upload and cleans its incomplete server file', async () => {
    store.transfers.set([{
      id: 'pending_9', fileName: 'draft', type: 'upload', status: 'paused', progress: 50,
      isRecovery: true, pendingData: { id: 9 } as any, timestamp: new Date(),
    }]);

    await store.cancelTransfer('pending_9');

    expect(drive.trashFile).toHaveBeenCalledWith(9);
    expect(drive.hardDeleteFile).toHaveBeenCalledWith(9);
    expect(store.transfers()).toEqual([]);
  });
});
