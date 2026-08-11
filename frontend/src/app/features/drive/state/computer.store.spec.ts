import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
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

  it('A19M-COMPUTER-001 clears files, previews, path and navigation history', () => {
    store.selectedTarget.set(google);
    store.currentFolderId.set(11);
    store.files.set([{ id: 21, isFolder: false, decryptedName: 'segredo.txt' } as any]);
    store.folderPreviewFiles.set([{ id: 22, isFolder: false, decryptedName: 'preview-secreto.jpg' } as any]);
    (store as any).folderPath.set([{ id: 11, name: 'Projetos Secretos' }]);
    (store as any).backHistory.set([{
      target: google, folderId: 10, folders: [{ id: 10, name: 'Segredo Anterior' }],
    }]);
    (store as any).forwardHistory.set([{
      target: google, folderId: 12, folders: [{ id: 12, name: 'Segredo Futuro' }],
    }]);

    (store as any).clearDecryptedPresentationData();

    expect(store.files()).toEqual([]);
    expect(store.folderPreviewFiles()).toEqual([]);
    expect(store.currentFolderId()).toBeNull();
    expect(store.currentPath().map(item => item.name)).toEqual(['Nanika', 'Este Computador', 'user@example.com']);
    expect(store.canGoBack()).toBeFalse();
    expect(store.canGoForward()).toBeFalse();
  });

  it('A19M-COMPUTER-002 ignores an old page response after presentation clear', async () => {
    const response = new Subject<StorageTreeResponse>();
    driveService.getStorageTree.and.returnValue(response.asObservable());
    store.selectedTarget.set(google);

    const loading = (store as any).loadPage(0);
    (store as any).clearDecryptedPresentationData();
    response.next(page());
    response.complete();
    await loading;

    expect(store.files()).toEqual([]);
    expect(store.folderPreviewFiles()).toEqual([]);
  });

  it('A19M-COMPUTER-003 ignores an old decrypt completion after presentation clear', async () => {
    const decryptStarted = deferred<void>();
    const decrypt = deferred<string>();
    driveService.getStorageTree.and.returnValue(of(page()));
    cryptoService.decryptName.and.callFake(async () => {
      decryptStarted.resolve();
      return decrypt.promise;
    });
    store.selectedTarget.set(google);

    const loading = (store as any).loadPage(0);
    await decryptStarted.promise;
    (store as any).clearDecryptedPresentationData();
    decrypt.resolve('segredo.txt');
    await loading;

    expect(store.files()).toEqual([]);
    expect(store.folderPreviewFiles()).toEqual([]);
  });

  it('A19M-COMPUTER-004 ignores an old folder preview completion after presentation clear', async () => {
    const previewResponse = new Subject<StorageTreeResponse>();
    const previewStarted = deferred<void>();
    const previewDecryptStarted = deferred<void>();
    const previewDecrypt = deferred<string>();
    driveService.getStorageTree.and.callFake((_provider, _storage, folderId) => {
      if (folderId === null) return of(page());
      previewStarted.resolve();
      return previewResponse.asObservable();
    });
    cryptoService.decryptName.and.callFake(async value => {
      if (value === 'enc-photo') {
        previewDecryptStarted.resolve();
        return previewDecrypt.promise;
      }
      return ({ 'enc-folder': 'Projetos', 'enc-root': 'raiz.txt' } as Record<string, string>)[value] ?? value;
    });
    store.selectedTarget.set(google);

    const loading = (store as any).loadPage(0);
    await previewStarted.promise;
    previewResponse.next({ ...page(11), files: [{
      id: 23, folder_id: 11, encrypted_name: 'enc-photo', encrypted_fdk: 'enc-fdk',
      size_bytes: 1024, is_hidden: false, storage_provider: 'google_drive', external_storage_id: 7,
    }] });
    previewResponse.complete();
    await previewDecryptStarted.promise;
    (store as any).clearDecryptedPresentationData();
    previewDecrypt.resolve('foto.jpg');
    await loading;

    expect(store.files()).toEqual([]);
    expect(store.folderPreviewFiles()).toEqual([]);
  });

  it('A19M-COMPUTER-005 allows fresh navigation after presentation clear', async () => {
    (store as any).clearDecryptedPresentationData();
    await store.openTarget(google);

    expect(store.files().some(file => file.decryptedName === 'raiz.txt')).toBeTrue();
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

  it('deduplicates targets, preserves them on refresh failure and force-refreshes after a home click', async () => {
    driveService.getStorageTargets.and.returnValue(of([local, local, google]));
    await store.loadTargets();
    expect(store.targets().map(target => target.key)).toEqual(['local', 'google:7']);

    await store.openTarget(google);
    await store.openHome();
    expect(store.selectedTarget()).toBeNull();
    expect(store.currentFolderId()).toBeNull();
    expect(store.currentPath().map(item => item.name)).toEqual(['Nanika', 'Este Computador']);
    expect(store.canGoBack()).toBeFalse();
    expect(store.canGoForward()).toBeFalse();
    expect(store.canGoUp()).toBeFalse();
    expect(driveService.getStorageTargets).toHaveBeenCalledTimes(2);

    driveService.getStorageTargets.and.returnValue(throwError(() => new Error('offline')));
    await store.loadTargets({ force: true });
    expect(store.targets().map(target => target.key)).toEqual(['local', 'google:7']);
  });

  it('ignores a stale target response when a newer refresh completes first', async () => {
    const first = new Subject<StorageTarget[]>();
    const second = new Subject<StorageTarget[]>();
    driveService.getStorageTargets.and.returnValues(first, second);

    const firstRequest = store.loadTargets({ force: true });
    const secondRequest = store.loadTargets({ force: true });
    second.next([local, google]);
    second.complete();
    first.next([local]);
    first.complete();
    await Promise.all([firstRequest, secondRequest]);

    expect(store.targets().map(target => target.key)).toEqual(['local', 'google:7']);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
