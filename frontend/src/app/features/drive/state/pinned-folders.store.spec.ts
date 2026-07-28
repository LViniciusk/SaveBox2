import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppStateService } from '../../../core/state/app-state.service';
import { DriveService } from '../services/drive.service';
import { DriveStore } from './drive.store';
import { PinnedFoldersStore } from './pinned-folders.store';
import { Observable, of, throwError } from 'rxjs';

describe('PinnedFoldersStore', () => {
  let store: PinnedFoldersStore;
  let drive: any;
  let driveStore: any;
  let appState: any;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['getPinnedFolders', 'pinFolder', 'unpinFolder', 'reorderPinnedFolders']);
    driveStore = { files: signal([]) };
    appState = { isLocked: signal(false) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PinnedFoldersStore,
        { provide: DriveService, useValue: drive },
        { provide: DriveStore, useValue: driveStore },
        { provide: AppStateService, useValue: appState },
      ],
    });
    store = TestBed.inject(PinnedFoldersStore);
  });

  it('loads ordered ids once for concurrent callers and resolves safe names', async () => {
    drive.getPinnedFolders.and.returnValue(of({ folders: [{ folder_id: 2, position: 1 }, { folder_id: 1, position: 0 }] }));
    driveStore.files.set([
      { id: 1, isFolder: true, decryptedName: 'Raiz', encryptedName: 'cipher-1' },
      { id: 2, isFolder: true, decryptedName: 'Projetos', encryptedName: 'cipher-2' },
      { id: 3, isFolder: false, decryptedName: 'arquivo', encryptedName: 'cipher-3' },
    ]);

    await Promise.all([store.load(), store.load()]);

    expect(drive.getPinnedFolders).toHaveBeenCalledTimes(1);
    expect(store.pinnedFolderIds()).toEqual([1, 2]);
    expect(store.pinnedFolders().map(folder => folder.name)).toEqual(['Raiz', 'Projetos']);
    expect(store.pinnedFolders()[0].available).toBeTrue();
  });

  it('uses protected and unavailable labels without exposing ciphertext', async () => {
    drive.getPinnedFolders.and.returnValue(of({ folders: [{ folder_id: 2, position: 0 }, { folder_id: 9, position: 1 }] }));
    driveStore.files.set([{ id: 2, isFolder: true, decryptedName: 'Nome', encryptedName: 'ciphertext' }]);
    await store.load();
    appState.isLocked.set(true);
    expect(store.pinnedFolders().map(folder => folder.name)).toEqual(['Pasta protegida', 'Pasta protegida']);
    expect(store.pinnedFolders()[1].available).toBeFalse();
    expect(store.pinnedFolders().map(folder => folder.name).join(' ')).not.toContain('ciphertext');
  });

  it('updates pessimistically for pin and unpin and preserves state on errors', async () => {
    drive.getPinnedFolders.and.returnValue(of({ folders: [{ folder_id: 1, position: 0 }] }));
    await store.load();
    drive.pinFolder.and.returnValue(of(void 0));
    const pin = store.pin(2);
    expect(store.pinnedFolderIds()).toEqual([1]);
    await pin;
    expect(store.pinnedFolderIds()).toEqual([1, 2]);

    drive.unpinFolder.and.returnValue(throwError(() => new Error('offline')));
    await expectAsync(store.unpin(1)).toBeRejected();
    expect(store.pinnedFolderIds()).toEqual([1, 2]);
  });

  it('deduplicates pending clicks and validates reorder locally', async () => {
    drive.getPinnedFolders.and.returnValue(of({ folders: [{ folder_id: 1, position: 0 }, { folder_id: 2, position: 1 }] }));
    await store.load();
    let resolvePin!: () => void;
    drive.pinFolder.and.returnValue(new Observable<void>(subscriber => { resolvePin = () => { subscriber.next(); subscriber.complete(); }; }));
    const first = store.pin(3);
    const second = store.pin(3);
    expect(drive.pinFolder).toHaveBeenCalledTimes(1);
    expect(store.isPending(3)).toBeTrue();
    resolvePin();
    await Promise.all([first, second]);

    await store.reorder([1, 1]);
    expect(drive.reorderPinnedFolders).not.toHaveBeenCalled();
    drive.reorderPinnedFolders.and.returnValue(of(void 0));
    await store.reorder([2, 1, 3]);
    expect(drive.reorderPinnedFolders).toHaveBeenCalledWith([2, 1, 3]);
    expect(store.pinnedFolderIds()).toEqual([2, 1, 3]);
  });

  it('keeps the previous state after a load error and clears feature state', async () => {
    drive.getPinnedFolders.and.returnValue(of({ folders: [{ folder_id: 1, position: 0 }] }));
    await store.load();
    drive.getPinnedFolders.and.returnValue(throwError(() => new Error('offline')));
    await store.load();
    expect(store.pinnedFolderIds()).toEqual([1]);
    store.clear();
    expect(store.pinnedFolderIds()).toEqual([]);
    expect(store.pendingFolderIds().size).toBe(0);
  });
});
