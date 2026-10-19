import { Component, input, output, provideZonelessChangeDetection, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { ThemeService } from '../../../../core/theme/theme.service';
import { THEME_STORAGE_KEY } from '../../../../core/theme/theme.types';
import { DriveStore } from '../../state/drive.store';
import { ComputerStore } from '../../state/computer.store';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';
import { StorageMoveEngineService } from '../../storage-move/storage-move-engine.service';
import type { DroppedItems } from '../../services/data-transfer-reader.service';
import type { FolderUploadSourceFile } from '../../upload/upload.models';
import { VaultHomeComponent } from './vault-home.component';

@Component({
  selector: 'app-gdrive-shell',
  standalone: true,
  template: '<div class="gdrive-shell-stub"><button id="gdrive-lock" (click)="lockRequested.emit()"></button><ng-content /></div>',
})
class GDriveShellStubComponent {
  readonly currentView = input<any>();
  readonly currentFolderId = input<number | null>(null);
  readonly currentPath = input<any[]>([]);
  readonly canGoBack = input(false);
  readonly canGoForward = input(false);
  readonly canGoUp = input(false);
  readonly locked = input(false);
  readonly movingFileIds = input<ReadonlySet<number>>(new Set<number>());
  readonly quota = input<any>();
  readonly unlockRequested = output<void>();
  readonly lockRequested = output<void>();
  readonly backRequested = output<void>();
  readonly forwardRequested = output<void>();
  readonly upRequested = output<void>();
  readonly addressNavigate = output<string>();
  readonly viewChange = output<any>();
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly uploadFolderRequested = output<void>();
  readonly previewRequested = output<any>();
  readonly shareRequested = output<any>();
  readonly storageMoveRequested = output<any>();
  readonly pinnedFolderNavigate = output<number>();
  readonly emptyTrashRequested = output<void>();
  readonly dropStarted = output<void>();
  readonly externalDrop = output<any>();
  readonly dropError = output<unknown>();
}

@Component({
  selector: 'app-default-shell',
  standalone: true,
  template: '<div class="default-shell-stub"><ng-content /></div>',
})
class DefaultShellStubComponent extends GDriveShellStubComponent {}

@Component({ selector: 'app-unlock-modal', standalone: true, template: '' })
class UnlockModalStubComponent { readonly modalClosed = output<void>(); }

@Component({ selector: 'app-video-player', standalone: true, template: '' })
class VideoPlayerStubComponent {
  static destroyCount = 0;
  readonly file = input.required<any>();
  readonly close = output<void>();
  readonly videoReady = output<void>();
  ngOnDestroy(): void { VideoPlayerStubComponent.destroyCount++; }
}

@Component({ selector: 'app-image-player', standalone: true, template: '' })
class ImagePlayerStubComponent {
  static destroyCount = 0;
  readonly file = input.required<any>();
  readonly playlist = input<any[]>([]);
  readonly isVideoPlaying = input(false);
  readonly isVideoLoading = input(false);
  readonly fileChange = output<any>();
  readonly close = output<void>();
  readonly closeVideo = output<void>();
  readonly playVideo = output<any>();
  readonly videoReady = output<void>();
  ngOnDestroy(): void { ImagePlayerStubComponent.destroyCount++; }
}

@Component({ selector: 'app-audio-player', standalone: true, template: '' })
class AudioPlayerStubComponent {
  readonly file = input.required<any>();
  readonly close = output<void>();
  readonly downloadRequested = output<void>();
}

@Component({ selector: 'app-share-modal', standalone: true, template: '' })
class ShareModalStubComponent {
  static destroyCount = 0;
  readonly file = input.required<any>();
  readonly close = output<void>();
  ngOnDestroy(): void { ShareModalStubComponent.destroyCount++; }
}

@Component({ selector: 'app-storage-target-picker', standalone: true, template: '' })
class StorageTargetPickerStubComponent {
  static destroyCount = 0;
  readonly file = input.required<any>();
  readonly targets = input<any[]>([]);
  readonly busy = input(false);
  readonly loadingTargets = input(false);
  readonly error = input<string | null>(null);
  readonly cancelled = output<void>();
  readonly confirmed = output<any>();
  ngOnDestroy(): void { StorageTargetPickerStubComponent.destroyCount++; }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('VaultHomeComponent theme switching', () => {
  let fixture: ComponentFixture<VaultHomeComponent>;
  let themeService: ThemeService;
  const appState = { isLocked: signal(true), lock: jasmine.createSpy('lock') };
  const driveStore = {
    quota: signal({ usedBytes: 10, maxBytes: 100 }),
    currentFolderId: signal<number | null>(null),
    currentPath: signal([{ id: null, name: 'Meu Drive' }]),
    files: signal<any[]>([]),
    canGoBack: signal(false),
    canGoForward: signal(false),
    canGoUp: signal(false),
    loadQuota: jasmine.createSpy('loadQuota'),
    loadTree: jasmine.createSpy('loadTree'),
    loadLinkedAccounts: jasmine.createSpy('loadLinkedAccounts').and.resolveTo(),
    reDecryptAll: jasmine.createSpy('reDecryptAll'),
    clearDecryptedNames: jasmine.createSpy('clearDecryptedNames'),
    clearDecryptedPresentationData: jasmine.createSpy('clearDecryptedPresentationData'),
    resetDownloadRuntimeState: jasmine.createSpy('resetDownloadRuntimeState'),
    resetUploadRuntimeState: jasmine.createSpy('resetUploadRuntimeState'),
    navigateTo: jasmine.createSpy('navigateTo'),
    goBack: jasmine.createSpy('goBack'),
    goForward: jasmine.createSpy('goForward'),
    navigateUp: jasmine.createSpy('navigateUp'),
    loadTrash: jasmine.createSpy('loadTrash'),
    createFolder: jasmine.createSpy('createFolder'),
    uploadFile: jasmine.createSpy('uploadFile').and.resolveTo(),
    uploadFiles: jasmine.createSpy('uploadFiles').and.resolveTo(),
    uploadFolder: jasmine.createSpy('uploadFolder').and.resolveTo(),
    uploadFolderSources: jasmine.createSpy('uploadFolderSources').and.resolveTo(),
  };
  const cryptoService = {
    isVaultUnlocked: jasmine.createSpy('isVaultUnlocked').and.returnValue(false),
    lockVault: jasmine.createSpy('lockVault'),
  };
  const dialogService = { activeDialog: signal(null), dialogValue: signal(''), cancelActive: jasmine.createSpy('cancelActive') };
  const computerStore = {
    targets: signal([]),
    currentFolderId: signal<number | null>(null),
    currentPath: signal<any[]>([]),
    canGoBack: signal(false),
    canGoForward: signal(false),
    canGoUp: signal(false),
    loadTargets: jasmine.createSpy('loadTargets').and.resolveTo(),
    clearDecryptedPresentationData: jasmine.createSpy('clearDecryptedPresentationData'),
    openHome: jasmine.createSpy('openHome').and.resolveTo(),
    refresh: jasmine.createSpy('refresh').and.resolveTo(),
    goBack: jasmine.createSpy('computerGoBack').and.resolveTo(),
    goForward: jasmine.createSpy('computerGoForward').and.resolveTo(),
    goUp: jasmine.createSpy('computerGoUp').and.resolveTo(),
    navigateAddress: jasmine.createSpy('computerNavigateAddress').and.resolveTo(),
  };
  const storageMoveEngine = {
    jobs: signal([]),
    activeFileIds: signal(new Set<number>()),
    start: jasmine.createSpy('start').and.resolveTo({}),
    loadActive: jasmine.createSpy('loadActive').and.resolveTo(),
    clearDecryptedPresentationData: jasmine.createSpy('clearDecryptedPresentationData'),
    resetRuntimeState: jasmine.createSpy('resetRuntimeState'),
  };

  beforeEach(async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    appState.isLocked.set(true);
    appState.lock.calls.reset();
    cryptoService.lockVault.calls.reset();
    dialogService.cancelActive.calls.reset();
    driveStore.loadQuota.calls.reset();
    driveStore.loadTree.calls.reset();
    driveStore.loadLinkedAccounts.calls.reset();
    driveStore.uploadFile.calls.reset();
    driveStore.uploadFiles.calls.reset();
    driveStore.uploadFolderSources.calls.reset();
    driveStore.uploadFolder.calls.reset();
    driveStore.clearDecryptedPresentationData.calls.reset();
    driveStore.resetDownloadRuntimeState.calls.reset();
    driveStore.resetUploadRuntimeState.calls.reset();
    computerStore.clearDecryptedPresentationData.calls.reset();
    driveStore.goBack.calls.reset();
    driveStore.goForward.calls.reset();
    driveStore.navigateUp.calls.reset();
    driveStore.files.set([]);
    driveStore.currentFolderId.set(null);
    VideoPlayerStubComponent.destroyCount = 0;
    ImagePlayerStubComponent.destroyCount = 0;
    ShareModalStubComponent.destroyCount = 0;
    StorageTargetPickerStubComponent.destroyCount = 0;
    await TestBed.configureTestingModule({
      imports: [VaultHomeComponent],
      providers: [
        provideZonelessChangeDetection(),
        ThemeService,
        { provide: AppStateService, useValue: appState },
        { provide: AuthService, useValue: {} },
        { provide: CryptoService, useValue: cryptoService },
        { provide: DialogService, useValue: dialogService },
        { provide: DriveStore, useValue: driveStore },
        { provide: ComputerStore, useValue: computerStore },
        { provide: StorageMoveEngineService, useValue: storageMoveEngine },
        { provide: PinnedFoldersStore, useValue: { load: jasmine.createSpy('load').and.resolveTo(), pinnedFolders: signal([]) } },
      ],
    }).overrideComponent(VaultHomeComponent, {
      set: {
        providers: [],
        imports: [
          CommonModule,
          GDriveShellStubComponent,
          DefaultShellStubComponent,
          UnlockModalStubComponent,
          VideoPlayerStubComponent,
          ImagePlayerStubComponent,
          AudioPlayerStubComponent,
          ShareModalStubComponent,
          StorageTargetPickerStubComponent,
        ],
      },
    }).compileComponents();

    fixture = TestBed.createComponent(VaultHomeComponent);
    themeService = TestBed.inject(ThemeService);
    fixture.componentInstance.currentView.set('transfers');
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset['theme'];
  });

  it('switches shells without recreating the parent or changing drive state', async () => {
    const component = fixture.componentInstance;
    const currentView = component.currentView;
    const store = TestBed.inject(DriveStore);

    expect(fixture.nativeElement.querySelector('.gdrive-shell-stub')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.default-shell-stub')).toBeNull();

    themeService.setTheme('default');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.default-shell-stub')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.gdrive-shell-stub')).toBeNull();
    expect(fixture.componentInstance).toBe(component);
    expect(component.currentView).toBe(currentView);
    expect(component.currentView()).toBe('transfers');
    expect((component['driveStore'] as unknown) === (store as unknown)).toBeTrue();
    expect(appState.isLocked()).toBeTrue();
    expect(driveStore.loadQuota).toHaveBeenCalledOnceWith();
    expect(driveStore.loadTree).toHaveBeenCalledOnceWith();
    expect(driveStore.loadLinkedAccounts).toHaveBeenCalledOnceWith();
  });

  it('opens sharing only for local files regardless of theme', () => {
    const component = fixture.componentInstance;
    const local = { id: 1, isFolder: false, storageProvider: 'local' } as any;
    const google = { id: 3, isFolder: false, storageProvider: 'google_drive' } as any;

    component.onShareRequested(local);
    expect(component.shareFile()).toBe(local);
    component.shareFile.set(null);
    themeService.setTheme('default');
    component.onShareRequested(google);
    expect(component.shareFile()).toBeNull();
  });

  it('centralizes storage moves and blocks invalid or duplicate requests', async () => {
    const component = fixture.componentInstance;
    const file = { id: 9, isFolder: false, isHidden: false, storageProvider: 'local', sizeBytes: 1 } as any;
    const folder = { ...file, id: 10, isFolder: true };
    const target = { key: 'google:7', provider: 'google_drive', externalStorageId: 7, label: 'Google', status: 'ready' } as any;
    appState.isLocked.set(false);

    component.onStorageMoveRequested(folder);
    expect(component.moveFile()).toBeNull();
    await component.onStorageMoveRequested(file);
    expect(component.moveFile()).toBe(file);
    expect(computerStore.loadTargets).toHaveBeenCalled();

    await component.startStorageMove(file, target);
    expect(storageMoveEngine.start).toHaveBeenCalledOnceWith(file, target);
    expect(component.moveFile()).toBeNull();

    storageMoveEngine.activeFileIds.set(new Set([9]));
    component.onStorageMoveRequested(file);
    expect(component.moveFile()).toBeNull();
  });

  it('locks the drive and clears decrypted names', () => {
    const component = fixture.componentInstance;

    component.lockDrive();

    expect(cryptoService.lockVault).toHaveBeenCalled();
    expect(driveStore.clearDecryptedPresentationData).toHaveBeenCalled();
    expect(computerStore.clearDecryptedPresentationData).toHaveBeenCalled();
    expect(storageMoveEngine.clearDecryptedPresentationData).toHaveBeenCalled();
    expect(driveStore.navigateTo).toHaveBeenCalledWith(null);
    expect(appState.lock).toHaveBeenCalled();
  });

  it('A19-LOCK-003 converges GDrive lock intent on VaultHome.lockDrive', () => {
    appState.isLocked.set(false);
    themeService.setTheme('gdrive');
    fixture.detectChanges();

    fixture.nativeElement.querySelector('#gdrive-lock').click();

    expect(cryptoService.lockVault).toHaveBeenCalledTimes(1);
  });

  it('A19-LOCK-009..016 closes local decrypted presentation and destroys its owners', () => {
    const component = fixture.componentInstance;
    appState.isLocked.set(false);
    const image = { id: 10, decryptedName: 'segredo.png' };
    const video = { id: 11, decryptedName: 'segredo.mp4' };
    component.activeImageFile.set(image as any);
    component.activeImagePlaylist.set([image, { id: 12 } as any]);
    component.activeVideoFile.set(video as any);
    component.isVideoReady.set(true);
    component.shareFile.set(image as any);
    component.moveFile.set(image as any);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-image-player')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-share-modal')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-storage-target-picker')).not.toBeNull();

    component.lockDrive();
    fixture.detectChanges();

    expect(component.activeImageFile()).toBeNull();
    expect(component.activeImagePlaylist()).toEqual([]);
    expect(component.activeVideoFile()).toBeNull();
    expect(component.isVideoReady()).toBeFalse();
    expect(component.shareFile()).toBeNull();
    expect(component.moveFile()).toBeNull();
    expect(fixture.nativeElement.querySelector('app-image-player')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-video-player')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-share-modal')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-storage-target-picker')).toBeNull();
    expect(ImagePlayerStubComponent.destroyCount).toBe(1);
    expect(VideoPlayerStubComponent.destroyCount).toBe(0);
    expect(ShareModalStubComponent.destroyCount).toBe(1);
    expect(StorageTargetPickerStubComponent.destroyCount).toBe(1);
  });

  it('A19M-VIDEO-001 destroys the standalone VideoPlayer owner on lock', () => {
    const component = fixture.componentInstance;
    appState.isLocked.set(false);
    component.activeVideoFile.set({ id: 11, decryptedName: 'segredo.mp4' } as any);
    component.isVideoReady.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-video-player')).not.toBeNull();

    component.lockDrive();
    fixture.detectChanges();

    expect(component.activeVideoFile()).toBeNull();
    expect(component.isVideoReady()).toBeFalse();
    expect(fixture.nativeElement.querySelector('app-video-player')).toBeNull();
    expect(VideoPlayerStubComponent.destroyCount).toBe(1);
  });

  it('A19-LOCK-022..024 preserves Storage Move and upload ownership during manual lock', () => {
    const component = fixture.componentInstance;
    component.lockDrive();

    expect(storageMoveEngine.resetRuntimeState).not.toHaveBeenCalled();
    expect(driveStore.resetUploadRuntimeState).not.toHaveBeenCalled();
    expect(driveStore.resetDownloadRuntimeState).toHaveBeenCalled();
  });

  it('uses the shared input for one or many files and resets it before awaiting', async () => {
    appState.isLocked.set(false);
    driveStore.currentFolderId.set(42);
    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    Object.defineProperty(input, 'files', { configurable: true, value: files });

    await fixture.componentInstance.onFilesSelected({ target: input } as unknown as Event);

    expect(input.value).toBe('');
    expect(driveStore.uploadFiles).toHaveBeenCalledOnceWith(files, 42);
    expect(driveStore.uploadFile).not.toHaveBeenCalled();
  });

  it('uses uploadFile for one file and supports selecting the same file again', async () => {
    appState.isLocked.set(false);
    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['a'], 'a.txt');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    await fixture.componentInstance.onFilesSelected({ target: input } as unknown as Event);
    await fixture.componentInstance.onFilesSelected({ target: input } as unknown as Event);

    expect(driveStore.uploadFile).toHaveBeenCalledTimes(2);
    expect(driveStore.uploadFiles).not.toHaveBeenCalled();
    expect(input.hasAttribute('webkitdirectory')).toBeFalse();
    expect(fixture.nativeElement.querySelectorAll('input[type="file"]').length).toBe(2);
  });

  it('uses the single directory input and forwards the captured destination', async () => {
    appState.isLocked.set(false);
    driveStore.currentFolderId.set(42);
    const input = fixture.nativeElement.querySelector('input[webkitdirectory]') as HTMLInputElement;
    const file = new File(['a'], 'a.txt');
    Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: 'Projeto/a.txt' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    await fixture.componentInstance.onFolderSelected({ target: input } as unknown as Event);

    expect(driveStore.uploadFolder).toHaveBeenCalledOnceWith([file], 42);
    expect(input.value).toBe('');
    expect(fixture.nativeElement.querySelectorAll('input[webkitdirectory]').length).toBe(1);
  });

  it('does not start uploads while locked, after clearing the input', async () => {
    appState.isLocked.set(true);
    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a'], 'a.txt')] });

    await fixture.componentInstance.onFilesSelected({ target: input } as unknown as Event);

    expect(input.value).toBe('');
    expect(driveStore.uploadFile).not.toHaveBeenCalled();
    expect(driveStore.uploadFiles).not.toHaveBeenCalled();
  });

  it('delegates Este Computador addresses to its independent navigator', () => {
    appState.isLocked.set(false);
    driveStore.files.set([
      { id: 7, isFolder: true, parentId: null, decryptedName: 'Projetos' },
      { id: 8, isFolder: true, parentId: 7, decryptedName: '2026' },
    ]);

    fixture.componentInstance.onAddressNavigate('Este Computador > Nanika > Projetos > 2026');

    expect(computerStore.navigateAddress).toHaveBeenCalledWith('Este Computador > Nanika > Projetos > 2026');
    expect(driveStore.navigateTo).not.toHaveBeenCalledWith(8);
    expect(fixture.componentInstance.currentView()).toBe('computer');
  });

  describe('onAddressNavigate (B.18)', () => {
    const folder = (id: number, decryptedName: string, parentId: number | null = null) => ({
      id,
      isFolder: true,
      parentId,
      decryptedName,
    });
    const file = (id: number, decryptedName: string, parentId: number | null = null) => ({
      id,
      isFolder: false,
      parentId,
      folderId: parentId,
      decryptedName,
    });

    const navigate = (value: string, files: any[] = [], view: any = 'drive') => {
      appState.isLocked.set(false);
      driveStore.files.set(files);
      fixture.componentInstance.currentView.set(view);
      fixture.componentInstance.onAddressNavigate(value);
    };

    beforeEach(() => {
      appState.isLocked.set(false);
      driveStore.files.set([]);
      driveStore.navigateTo.calls.reset();
      computerStore.navigateAddress.calls.reset();
      fixture.componentInstance.currentView.set('drive');
    });

    it('does nothing while the vault is locked', () => {
      appState.isLocked.set(true);

      fixture.componentInstance.onAddressNavigate('Nanika/Projetos');

      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(computerStore.navigateAddress).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('resolves the Nanika root and consumes only one outer namespace token', () => {
      navigate('Nanika/Nanika/Child', [folder(40, 'Nanika'), folder(41, 'Child', 40)]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(41);
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('resolves a nested literal Nanika folder', () => {
      navigate('Nanika/Projetos/Nanika/2026', [
        folder(30, 'Projetos'),
        folder(31, 'Nanika', 30),
        folder(32, '2026', 31),
      ]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(32);
    });

    it('resolves a root literal Meu Drive folder', () => {
      navigate('Nanika/Meu Drive/2026', [folder(50, 'Meu Drive'), folder(51, '2026', 50)]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(51);
    });

    it('resolves a nested literal Meu Drive folder', () => {
      navigate('Nanika/Projetos/Meu Drive/2026', [
        folder(60, 'Projetos'),
        folder(61, 'Meu Drive', 60),
        folder(62, '2026', 61),
      ]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(62);
    });

    it('keeps a nested exact Este Computador folder in the Drive namespace', () => {
      navigate('Nanika/Projetos/Este Computador/2026', [
        folder(20, 'Projetos'),
        folder(21, 'Este Computador', 20),
        folder(22, '2026', 21),
      ]);

      expect(computerStore.navigateAddress).not.toHaveBeenCalled();
      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(22);
    });

    it('keeps a folder containing Este Computador as literal Drive data', () => {
      navigate('Nanika/Este Computador Backup', [folder(10, 'Este Computador Backup')]);

      expect(computerStore.navigateAddress).not.toHaveBeenCalled();
      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(10);
    });

    it('keeps a folder with a reserved name suffix as literal Drive data', () => {
      navigate('Nanika/Backup Este Computador', [folder(11, 'Backup Este Computador')]);

      expect(computerStore.navigateAddress).not.toHaveBeenCalled();
      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(11);
    });

    it('dispatches the canonical Computer namespace without rebuilding the address', () => {
      navigate('Nanika/Este Computador/Windows-SSD', []);

      expect(computerStore.navigateAddress).toHaveBeenCalledOnceWith('Nanika/Este Computador/Windows-SSD');
      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('computer');
    });

    it('dispatches the direct Computer namespace for the existing address contract', () => {
      const value = 'Este Computador > Nanika > Projetos > 2026';

      navigate(value);

      expect(computerStore.navigateAddress).toHaveBeenCalledOnceWith(value);
      expect(driveStore.navigateTo).not.toHaveBeenCalled();
    });

    it('matches the Computer namespace case-insensitively', () => {
      const value = 'nanika/ESTE COMPUTADOR/Windows-SSD';

      navigate(value);

      expect(computerStore.navigateAddress).toHaveBeenCalledOnceWith(value);
      expect(driveStore.navigateTo).not.toHaveBeenCalled();
    });

    it('preserves the current Computer view override', () => {
      const value = 'Nanika/SomeTarget/Folder';

      navigate(value, [], 'computer');

      expect(computerStore.navigateAddress).toHaveBeenCalledOnceWith(value);
      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('computer');
    });

    it('accepts a Drive address without the optional Nanika prefix', () => {
      navigate('Projetos/2026', [folder(70, 'Projetos'), folder(71, '2026', 70)]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(71);
    });

    it('preserves case-insensitive folder matching', () => {
      navigate('NANIKA/proJETOS/2026', [folder(72, 'Projetos'), folder(73, '2026', 72)]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(73);
    });

    it('preserves separators, whitespace and empty-segment handling', () => {
      navigate('  Nanika / / Projetos\\\\2026  ', [folder(74, 'Projetos'), folder(75, '2026', 74)]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(75);
    });

    it('resolves duplicate names only under the selected parent', () => {
      navigate('Nanika/B/Docs', [
        folder(100, 'A'),
        folder(101, 'Docs', 100),
        folder(200, 'B'),
        folder(201, 'Docs', 200),
      ]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(201);
    });

    it('ignores a same-name file when a folder is available', () => {
      navigate('Nanika/Projetos', [file(80, 'Projetos'), folder(81, 'Projetos')]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(81);
    });

    it('keeps an invalid first segment atomic', () => {
      navigate('Nanika/Inexistente', [folder(90, 'Projetos')]);

      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('keeps an invalid middle segment atomic', () => {
      navigate('Nanika/Projetos/Inexistente/2026', [folder(91, 'Projetos')]);

      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('does not partially navigate from the trash view', () => {
      navigate('Nanika/Projetos/Inexistente', [folder(92, 'Projetos')], 'trash');

      expect(driveStore.navigateTo).not.toHaveBeenCalled();
      expect(fixture.componentInstance.currentView()).toBe('trash');
    });

    it('commits a valid path from the trash view only after full resolution', () => {
      navigate('Nanika/Projetos', [folder(93, 'Projetos')], 'trash');

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(93);
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('navigates to the Drive root for an empty address', () => {
      navigate('');

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(null);
      expect(fixture.componentInstance.currentView()).toBe('drive');
    });

    it('does not fuzzy-match a partial folder name', () => {
      navigate('Nanika/Proj', [folder(94, 'Projetos')]);

      expect(driveStore.navigateTo).not.toHaveBeenCalled();
    });

    it('preserves literal reserved substrings in Drive folder names', () => {
      navigate('Nanika/Meu Drive Backup', [folder(95, 'Meu Drive Backup')]);

      expect(driveStore.navigateTo).toHaveBeenCalledOnceWith(95);
    });
  });

  describe('external drop ownership (B.19)', () => {
    const file = (name: string) => new File([name], name);
    const folderSource = (name = 'Projeto'): FolderUploadSourceFile => ({
      file: file('arquivo.txt'),
      relativePath: `${name}/arquivo.txt`,
    });
    const drop = (files: File[] = [], folders: FolderUploadSourceFile[] = []): DroppedItems => ({ files, folders });

    beforeEach(() => {
      appState.isLocked.set(false);
      fixture.componentInstance.currentView.set('drive');
      driveStore.currentFolderId.set(null);
      driveStore.uploadFile.and.resolveTo();
      driveStore.uploadFiles.and.resolveTo();
      driveStore.uploadFolderSources.and.resolveTo();
      spyOn(window, 'alert').and.stub();
      spyOn(console, 'error').and.stub();
    });

    it('ignores a drop when no destination was captured', async () => {
      await fixture.componentInstance.onDropped(drop([file('uncaptured.txt')]));

      expect(driveStore.uploadFile).not.toHaveBeenCalled();
      expect(driveStore.uploadFiles).not.toHaveBeenCalled();
      expect(driveStore.uploadFolderSources).not.toHaveBeenCalled();
    });

    it('does not capture a target while locked', async () => {
      const component = fixture.componentInstance;
      appState.isLocked.set(true);
      driveStore.currentFolderId.set(42);

      component.onDropStarted();
      appState.isLocked.set(false);
      await component.onDropped(drop([file('locked-start.txt')]));

      expect(driveStore.uploadFile).not.toHaveBeenCalled();
    });

    it('does not capture a target outside the Drive view', async () => {
      const component = fixture.componentInstance;
      component.currentView.set('trash');
      driveStore.currentFolderId.set(42);

      component.onDropStarted();
      component.currentView.set('drive');
      await component.onDropped(drop([file('non-drive-start.txt')]));

      expect(driveStore.uploadFile).not.toHaveBeenCalled();
    });

    it('captures the unlocked Drive root as a valid null destination', async () => {
      const component = fixture.componentInstance;

      component.onDropStarted();
      driveStore.currentFolderId.set(42);
      await component.onDropped(drop([file('root.txt')]));

      expect(driveStore.uploadFile).toHaveBeenCalledOnceWith(jasmine.any(File), null);
    });

    it('keeps the destination snapshot when navigation changes during read completion', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();
      driveStore.currentFolderId.set(99);

      await component.onDropped(drop([file('captured.txt')]));

      expect(driveStore.uploadFile).toHaveBeenCalledOnceWith(jasmine.any(File), 42);
    });

    it('consumes a captured target when lock or view changes before the result arrives', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();
      appState.isLocked.set(true);
      component.currentView.set('trash');

      await component.onDropped(drop([file('blocked.txt')]));
      appState.isLocked.set(false);
      component.currentView.set('drive');
      await component.onDropped(drop([file('must-not-reuse.txt')]));

      expect(driveStore.uploadFile).not.toHaveBeenCalled();
    });

    it('accepts one drop result for each start and never reuses the target', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();

      await component.onDropped(drop([file('first.txt')]));
      await component.onDropped(drop([file('second.txt')]));

      expect(driveStore.uploadFile).toHaveBeenCalledOnceWith(jasmine.any(File), 42);
    });

    it('consumes an empty drop without starting an upload', async () => {
      const component = fixture.componentInstance;
      component.onDropStarted();

      await component.onDropped(drop());

      expect(driveStore.uploadFile).not.toHaveBeenCalled();
      expect(driveStore.uploadFiles).not.toHaveBeenCalled();
      expect(driveStore.uploadFolderSources).not.toHaveBeenCalled();
    });

    it('uses uploadFile for one dropped file', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();
      const droppedFile = file('one.txt');

      await component.onDropped(drop([droppedFile]));

      expect(driveStore.uploadFile).toHaveBeenCalledOnceWith(droppedFile, 42);
      expect(driveStore.uploadFiles).not.toHaveBeenCalled();
    });

    it('uses uploadFiles with the drop-files batch label for multiple files', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();
      const files = [file('one.txt'), file('two.txt')];

      await component.onDropped(drop(files));

      expect(driveStore.uploadFiles).toHaveBeenCalledOnceWith(files, 42, 'drop-files');
      expect(driveStore.uploadFile).not.toHaveBeenCalled();
    });

    it('uses uploadFolderSources with the drop-folders batch label', async () => {
      const component = fixture.componentInstance;
      driveStore.currentFolderId.set(42);
      component.onDropStarted();
      const folders = [folderSource()];

      await component.onDropped(drop([], folders));

      expect(driveStore.uploadFolderSources).toHaveBeenCalledOnceWith(folders, 42, 'drop-folders');
    });

    it('uploads files before folders and preserves the captured destination', async () => {
      const component = fixture.componentInstance;
      const files = [file('one.txt'), file('two.txt')];
      const folders = [folderSource()];
      const filesDone = deferred<void>();
      driveStore.currentFolderId.set(42);
      driveStore.uploadFiles.and.returnValue(filesDone.promise);
      component.onDropStarted();

      const operation = component.onDropped(drop(files, folders));
      expect(driveStore.uploadFiles).toHaveBeenCalledOnceWith(files, 42, 'drop-files');
      expect(driveStore.uploadFolderSources).not.toHaveBeenCalled();

      driveStore.currentFolderId.set(99);
      filesDone.resolve();
      await operation;

      expect(driveStore.uploadFolderSources).toHaveBeenCalledOnceWith(folders, 42, 'drop-folders');
    });

    it('preserves the current best-effort behavior when the view changes mid-operation', async () => {
      const component = fixture.componentInstance;
      const filesDone = deferred<void>();
      const folders = [folderSource()];
      driveStore.currentFolderId.set(42);
      driveStore.uploadFiles.and.returnValue(filesDone.promise);
      component.onDropStarted();

      const operation = component.onDropped(drop([file('one.txt'), file('two.txt')], folders));
      component.currentView.set('trash');
      filesDone.resolve();
      await operation;

      expect(driveStore.uploadFolderSources).toHaveBeenCalledOnceWith(folders, 42, 'drop-folders');
    });

    it('does not start the folder phase when the drive locks mid-operation', async () => {
      const component = fixture.componentInstance;
      const filesDone = deferred<void>();
      const folders = [folderSource()];
      driveStore.currentFolderId.set(42);
      driveStore.uploadFiles.and.returnValue(filesDone.promise);
      component.onDropStarted();

      const operation = component.onDropped(drop([file('one.txt'), file('two.txt')], folders));
      appState.isLocked.set(true);
      filesDone.resolve();
      await operation;

      expect(driveStore.uploadFolderSources).not.toHaveBeenCalled();
    });

    it('continues with folders after a file-phase error while unlocked', async () => {
      const component = fixture.componentInstance;
      const folders = [folderSource()];
      driveStore.currentFolderId.set(42);
      driveStore.uploadFiles.and.rejectWith(new Error('file phase failed'));
      component.onDropStarted();

      await component.onDropped(drop([file('one.txt'), file('two.txt')], folders));

      expect(driveStore.uploadFolderSources).toHaveBeenCalledOnceWith(folders, 42, 'drop-folders');
    });

    it('uses the exact fallback message for a file-phase error', async () => {
      const component = fixture.componentInstance;
      driveStore.uploadFile.and.rejectWith(new Error('local failure'));
      component.onDropStarted();

      await component.onDropped(drop([file('failed.txt')]));

      expect(window.alert).toHaveBeenCalledOnceWith('Erro no upload dos arquivos arrastados');
    });

    it('uses the exact fallback message for a folder-phase error', async () => {
      const component = fixture.componentInstance;
      driveStore.uploadFolderSources.and.rejectWith(new Error('local failure'));
      component.onDropStarted();

      await component.onDropped(drop([], [folderSource()]));

      expect(window.alert).toHaveBeenCalledOnceWith('Erro no upload das pastas arrastadas');
    });

    it('preserves an existing Google Drive error message', async () => {
      const component = fixture.componentInstance;
      const message = 'Google Drive indisponível';
      driveStore.uploadFile.and.rejectWith(new Error(message));
      component.onDropStarted();

      await component.onDropped(drop([file('google-error.txt')]));

      expect(window.alert).toHaveBeenCalledOnceWith(message);
    });

    it('does not start folders after a file-phase error followed by a lock', async () => {
      const component = fixture.componentInstance;
      const folders = [folderSource()];
      driveStore.currentFolderId.set(42);
      driveStore.uploadFiles.and.callFake(async () => {
        appState.isLocked.set(true);
        throw new Error('file phase failed');
      });
      component.onDropStarted();

      await component.onDropped(drop([file('one.txt'), file('two.txt')], folders));

      expect(driveStore.uploadFolderSources).not.toHaveBeenCalled();
    });

    it('does not retry files when the folder phase fails', async () => {
      const component = fixture.componentInstance;
      const files = [file('one.txt'), file('two.txt')];
      const folders = [folderSource()];
      driveStore.currentFolderId.set(42);
      driveStore.uploadFolderSources.and.rejectWith(new Error('folder phase failed'));
      component.onDropStarted();

      await component.onDropped(drop(files, folders));

      expect(driveStore.uploadFiles).toHaveBeenCalledOnceWith(files, 42, 'drop-files');
      expect(driveStore.uploadFolderSources).toHaveBeenCalledOnceWith(folders, 42, 'drop-folders');
    });

    it('keeps the existing read-error alert and logging contract', () => {
      const component = fixture.componentInstance;
      const error = new Error('read failed');

      component.onDropError(error);

      expect(console.error).toHaveBeenCalledOnceWith('Erro ao ler itens arrastados', error);
      expect(window.alert).toHaveBeenCalledOnceWith('Não foi possível ler os itens arrastados');
    });
  });
});
