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
import { PinnedFoldersStore } from '../../state/pinned-folders.store';
import { VaultHomeComponent } from './vault-home.component';

@Component({
  selector: 'app-gdrive-shell',
  standalone: true,
  template: '<div class="gdrive-shell-stub"><ng-content /></div>',
})
class GDriveShellStubComponent {
  readonly currentView = input<any>();
  readonly currentFolderId = input<number | null>(null);
  readonly currentPath = input<any[]>([]);
  readonly canGoBack = input(false);
  readonly canGoForward = input(false);
  readonly canGoUp = input(false);
  readonly locked = input(false);
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
  readonly videoSelected = output<any>();
  readonly imageSelected = output<any>();
  readonly shareRequested = output<any>();
  readonly pinnedFolderNavigate = output<number>();
  readonly emptyTrashRequested = output<void>();
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
  readonly file = input.required<any>();
  readonly close = output<void>();
  readonly videoReady = output<void>();
}

@Component({ selector: 'app-image-player', standalone: true, template: '' })
class ImagePlayerStubComponent {
  readonly file = input.required<any>();
  readonly playlist = input<any[]>([]);
  readonly isVideoPlaying = input(false);
  readonly isVideoLoading = input(false);
  readonly fileChange = output<any>();
  readonly close = output<void>();
  readonly closeVideo = output<void>();
  readonly playVideo = output<any>();
  readonly videoReady = output<void>();
}

@Component({ selector: 'app-share-modal', standalone: true, template: '' })
class ShareModalStubComponent {
  readonly file = input.required<any>();
  readonly close = output<void>();
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
    reDecryptAll: jasmine.createSpy('reDecryptAll'),
    clearDecryptedNames: jasmine.createSpy('clearDecryptedNames'),
    navigateTo: jasmine.createSpy('navigateTo'),
    goBack: jasmine.createSpy('goBack'),
    goForward: jasmine.createSpy('goForward'),
    navigateUp: jasmine.createSpy('navigateUp'),
    loadTrash: jasmine.createSpy('loadTrash'),
    createFolder: jasmine.createSpy('createFolder'),
    uploadFile: jasmine.createSpy('uploadFile').and.resolveTo(),
    uploadFiles: jasmine.createSpy('uploadFiles').and.resolveTo(),
  };
  const cryptoService = {
    isVaultUnlocked: jasmine.createSpy('isVaultUnlocked').and.returnValue(false),
    lockVault: jasmine.createSpy('lockVault'),
  };
  const dialogService = { activeDialog: signal(null), dialogValue: signal('') };

  beforeEach(async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    appState.isLocked.set(true);
    appState.lock.calls.reset();
    cryptoService.lockVault.calls.reset();
    driveStore.loadQuota.calls.reset();
    driveStore.loadTree.calls.reset();
    driveStore.uploadFile.calls.reset();
    driveStore.uploadFiles.calls.reset();
    driveStore.goBack.calls.reset();
    driveStore.goForward.calls.reset();
    driveStore.navigateUp.calls.reset();
    driveStore.files.set([]);
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
          ShareModalStubComponent,
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

  it('switches shells without recreating the parent or changing drive state', () => {
    const component = fixture.componentInstance;
    const currentView = component.currentView;
    const store = TestBed.inject(DriveStore);

    expect(fixture.nativeElement.querySelector('.gdrive-shell-stub')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.default-shell-stub')).toBeNull();

    themeService.setTheme('default');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.default-shell-stub')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.gdrive-shell-stub')).toBeNull();
    expect(fixture.componentInstance).toBe(component);
    expect(component.currentView).toBe(currentView);
    expect(component.currentView()).toBe('transfers');
    expect((component['driveStore'] as unknown) === (store as unknown)).toBeTrue();
    expect(appState.isLocked()).toBeTrue();
    expect(driveStore.loadQuota).toHaveBeenCalledOnceWith();
    expect(driveStore.loadTree).toHaveBeenCalledOnceWith();
    expect(TestBed.inject(PinnedFoldersStore).load).toHaveBeenCalledOnceWith();
  });

  it('locks the drive and clears decrypted names', () => {
    const component = fixture.componentInstance;

    component.lockDrive();

    expect(cryptoService.lockVault).toHaveBeenCalled();
    expect(driveStore.clearDecryptedNames).toHaveBeenCalled();
    expect(driveStore.navigateTo).toHaveBeenCalledWith(null);
    expect(appState.lock).toHaveBeenCalled();
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
    expect(fixture.nativeElement.querySelectorAll('input[type="file"]').length).toBe(1);
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

  it('resolves an address path against decrypted folders', () => {
    appState.isLocked.set(false);
    driveStore.files.set([
      { id: 7, isFolder: true, parentId: null, decryptedName: 'Projetos' },
      { id: 8, isFolder: true, parentId: 7, decryptedName: '2026' },
    ]);

    fixture.componentInstance.onAddressNavigate('Este Computador > Nanika > Projetos > 2026');

    expect(driveStore.navigateTo).toHaveBeenCalledWith(8);
    expect(fixture.componentInstance.currentView()).toBe('drive');
  });
});
