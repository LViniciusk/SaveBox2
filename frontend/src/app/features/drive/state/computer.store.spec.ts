import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService, StorageTreeResponse } from '../services/drive.service';
import { StorageTarget } from './drive.types';
import { ComputerStore } from './computer.store';

describe('ComputerStore', () => {
  let store: ComputerStore;
  let driveService: jasmine.SpyObj<DriveService>;
  let cryptoService: jasmine.SpyObj<CryptoService>;

  const local: StorageTarget = {
    key: 'local', provider: 'local', label: 'Disco local', externalStorageId: null,
    usedBytes: 10, maxBytes: 100, availableBytes: 90, nanikaUsedBytes: 10, status: 'ready',
  };
  const google: StorageTarget = {
    key: 'google:7', provider: 'google_drive', label: 'user@example.com', externalStorageId: 7,
    usedBytes: 20, maxBytes: 200, availableBytes: 180, nanikaUsedBytes: 5, status: 'ready',
  };
  const page = (folderId: number | null = null): StorageTreeResponse => ({
    target: { provider: 'google_drive', external_storage_id: 7 },
    current_folder_id: folderId,
    folders: folderId === null ? [{ id: 11, parent_id: null, encrypted_name: 'enc-folder' }] : [],
    files: [{
      id: folderId === null ? 21 : 22,
      folder_id: folderId,
      encrypted_name: folderId === null ? 'enc-root' : 'enc-child',
      encrypted_fdk: 'enc-fdk', size_bytes: 1024, is_hidden: false,
      storage_provider: 'google_drive', external_storage_id: 7,
    }],
    total_files: 1, has_more: false, file_limit: 50, file_offset: 0,
  });

  beforeEach(() => {
    driveService = jasmine.createSpyObj<DriveService>('DriveService', ['getStorageTargets', 'getStorageTree']);
    cryptoService = jasmine.createSpyObj<CryptoService>('CryptoService', ['isVaultUnlocked', 'decryptName']);
    cryptoService.isVaultUnlocked.and.returnValue(true);
    cryptoService.decryptName.and.callFake(async value => ({
      'enc-folder': 'Projetos', 'enc-root': 'raiz.txt', 'enc-child': 'filho.txt',
    })[value] ?? value);
    driveService.getStorageTargets.and.returnValue(of([local, google]));
    driveService.getStorageTree.and.callFake((_provider, _storage, folderId) => of(page(folderId)));

    TestBed.configureTestingModule({ providers: [
      provideZonelessChangeDetection(),
      ComputerStore,
      { provide: DriveService, useValue: driveService },
      { provide: CryptoService, useValue: cryptoService },
    ] });
    store = TestBed.inject(ComputerStore);
  });

  it('keeps computer navigation independent and scopes every page to the selected account', async () => {
    await store.loadTargets();
    await store.openTarget(google);

    expect(store.currentPath().map(item => item.name)).toEqual(['Nanika', 'Este Computador', 'user@example.com']);
    expect(driveService.getStorageTree).toHaveBeenCalledWith('google_drive', 7, null, 50, 0);
    expect(store.files().every(item => item.externalStorageId === 7)).toBeTrue();

    const folder = store.files().find(item => item.isFolder)!;
    await store.openFolder(folder);
    expect(store.currentFolderId()).toBe(11);
    expect(store.canGoBack()).toBeTrue();
    await store.goBack();
    expect(store.currentFolderId()).toBeNull();
    await store.goForward();
    expect(store.currentFolderId()).toBe(11);
  });

  it('navigates an editable address through decrypted folder names', async () => {
    await store.loadTargets();
    await store.navigateAddress('Nanika/Este Computador/user@example.com/Projetos');

    expect(store.selectedTarget()).toBe(google);
    expect(store.currentFolderId()).toBe(11);
    expect(store.files()[0].decryptedName).toBe('filho.txt');
  });

  it('does not open unavailable targets and exposes request failures', async () => {
    await store.openTarget({ ...google, status: 'unavailable' });
    expect(driveService.getStorageTree).not.toHaveBeenCalled();

    driveService.getStorageTargets.and.returnValue(throwError(() => new Error('offline')));
    await store.loadTargets();
    expect(store.error()).toContain('Não foi possível');
    expect(store.loading()).toBeFalse();
  });
});
