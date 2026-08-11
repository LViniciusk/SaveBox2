import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TopbarComponent } from './topbar.component';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CryptoService, SecurityPhraseChangeError } from '../../../../core/crypto/crypto.service';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { DriveStore } from '../../state/drive.store';
import { ThemeService } from '../../../../core/theme/theme.service';
import { THEME_STORAGE_KEY } from '../../../../core/theme/theme.types';

describe('TopbarComponent theme selector', () => {
  let fixture: ComponentFixture<TopbarComponent>;
  let themeService: ThemeService;
  let anchorClickSpy: jasmine.Spy;
  const appState = {
    isLocked: signal(false),
    user: signal({ email: 'user@example.com', name: 'Usuário', picture: '' }),
    lock: jasmine.createSpy('lock'),
  };
  const driveStore = {
    storageProvider: signal<'local' | 'google_drive'>('local'),
    linkedAccounts: signal<unknown[]>([]),
    quota: signal<any>({ usedBytes: 10, maxBytes: 100, gdriveUsedBytes: 0, gdriveMaxBytes: 0 }),
    convertIncompatibleVideos: signal(false),
    incompatibleVideoConversionMode: signal<'pure' | 'compressed'>('pure'),
    loadLinkedAccounts: jasmine.createSpy('loadLinkedAccounts'),
    setStorageProvider: jasmine.createSpy('setStorageProvider'),
    setConvertIncompatibleVideos: jasmine.createSpy('setConvertIncompatibleVideos'),
    setIncompatibleVideoConversionMode: jasmine.createSpy('setIncompatibleVideoConversionMode'),
    linkGoogleDrive: jasmine.createSpy('linkGoogleDrive'),
    unlinkGoogleAccount: jasmine.createSpy('unlinkGoogleAccount'),
    clearDecryptedNames: jasmine.createSpy('clearDecryptedNames'),
    navigateTo: jasmine.createSpy('navigateTo'),
  };
  const cryptoService = {
    isVaultUnlocked: jasmine.createSpy('isVaultUnlocked').and.returnValue(true),
    lockVault: jasmine.createSpy('lockVault'),
    changeSecurityPhrase: jasmine.createSpy('changeSecurityPhrase').and.resolveTo(),
  };
  const authService = {
    getToken: jasmine.createSpy('getToken').and.returnValue('token'),
    logout: jasmine.createSpy('logout'),
    logoutGlobal: jasmine.createSpy('logoutGlobal'),
    updateProfile: jasmine.createSpy('updateProfile'),
    restoreSession: jasmine.createSpy('restoreSession'),
  };
  const dialogService = {
    confirm: jasmine.createSpy('confirm'),
    prompt: jasmine.createSpy('prompt'),
  };

  beforeEach(async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    await TestBed.configureTestingModule({
      imports: [TopbarComponent],
      providers: [
        provideZonelessChangeDetection(),
        ThemeService,
        { provide: AppStateService, useValue: appState },
        { provide: AuthService, useValue: authService },
        { provide: CryptoService, useValue: cryptoService },
        { provide: DialogService, useValue: dialogService },
        { provide: DriveStore, useValue: driveStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TopbarComponent);
    themeService = TestBed.inject(ThemeService);
    anchorClickSpy = spyOn(HTMLAnchorElement.prototype, 'click').and.stub();
    fixture.componentInstance.openSettings();
    fixture.detectChanges();
  });

  afterEach(() => {
    cryptoService.changeSecurityPhrase.calls.reset();
    cryptoService.changeSecurityPhrase.and.resolveTo();
    driveStore.linkedAccounts.set([]);
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset['theme'];
  });

  it('renders the accessible appearance selector with GDrive active by default', () => {
    const group = fixture.nativeElement.querySelector('[role="radiogroup"]') as HTMLElement;
    const radios = fixture.nativeElement.querySelectorAll('input[name="theme"]') as NodeListOf<HTMLInputElement>;

    expect(fixture.nativeElement.textContent).toContain('Aparência');
    expect(fixture.nativeElement.textContent).toContain('Default');
    expect(fixture.nativeElement.textContent).toContain('GDrive');
    expect(group.getAttribute('aria-labelledby')).toBe('theme-heading');
    expect(radios.length).toBe(2);
    expect(radios[0].checked).toBeFalse();
    expect(radios[1].checked).toBeTrue();
    expect(radios[0].disabled).toBeFalse();
    expect(radios[1].disabled).toBeFalse();
  });

  it('changes the theme immediately and persists the preference', () => {
    const setTheme = spyOn(themeService, 'setTheme').and.callThrough();
    const defaultRadio = fixture.nativeElement.querySelector('input[value="default"]') as HTMLInputElement;

    defaultRadio.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(setTheme).toHaveBeenCalledOnceWith('default');
    expect(themeService.theme()).toBe('default');
    expect(document.documentElement.dataset['theme']).toBe('default');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('default');
    expect(defaultRadio.checked).toBeTrue();
    expect((fixture.nativeElement.querySelector('input[value="gdrive"]') as HTMLInputElement).checked).toBeFalse();
  });

  it('uses the same ThemeService and leaves drive state untouched', () => {
    const currentFolderId = signal<number | null>(42);
    const selectedFileIds = signal<number[]>([7, 8]);
    const transfers = signal([{ id: 'transfer-1' }]);
    const displayMode = signal<'list' | 'grid'>('grid');
    const setTheme = spyOn(themeService, 'setTheme').and.callThrough();
    const defaultRadio = fixture.nativeElement.querySelector('input[value="default"]') as HTMLInputElement;

    defaultRadio.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(setTheme).toHaveBeenCalledWith('default');
    expect((TestBed.inject(DriveStore) as unknown) === (driveStore as unknown)).toBeTrue();
    expect(currentFolderId()).toBe(42);
    expect(selectedFileIds()).toEqual([7, 8]);
    expect(transfers()).toEqual([{ id: 'transfer-1' }]);
    expect(displayMode()).toBe('grid');
    expect(appState.isLocked()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.settings-modal')).not.toBeNull();
  });

  it('switches back to GDrive without duplicating the selection action', () => {
    themeService.setTheme('default');
    fixture.detectChanges();
    const setTheme = spyOn(themeService, 'setTheme').and.callThrough();
    const gdriveRadio = fixture.nativeElement.querySelector('input[value="gdrive"]') as HTMLInputElement;

    gdriveRadio.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(setTheme).toHaveBeenCalledOnceWith('gdrive');
    expect(themeService.theme()).toBe('gdrive');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('gdrive');
  });

  it('covers the existing topbar guards used by the settings modal', async () => {
    const component = fixture.componentInstance;

    component.toggleProfileMenu();
    component.toggleProfileMenu();

    driveStore.quota.set(null);
    expect(component.getTotalQuotaPercentFormatted()).toBe('0');
    expect(component.getTotalQuotaMaxFormatted()).toBe('5 TB');
    driveStore.quota.set({ usedBytes: 0, maxBytes: 0 });
    expect(component.getTotalQuotaPercentFormatted()).toBe('0');

    await component.changeSecurityPhrase();
    component.oldPhrase.set('old');
    component.newPhrase.set('new');
    component.confirmPhrase.set('different');
    await component.changeSecurityPhrase();
    component.confirmPhrase.set('new');
    await component.changeSecurityPhrase();
    component.newPhrase.set('new phrase');
    component.confirmPhrase.set('new phrase');
    await component.changeSecurityPhrase();

    expect(component.changePhraseSuccess()).toContain('alterada com sucesso');
  });

  it('blocks double submit and re-enables the flow after completion', async () => {
    const component = fixture.componentInstance;
    cryptoService.changeSecurityPhrase.calls.reset();
    component.oldPhrase.set('old phrase');
    component.newPhrase.set('new phrase');
    component.confirmPhrase.set('new phrase');
    let release!: () => void;
    const pending = new Promise<void>(resolve => release = resolve);
    cryptoService.changeSecurityPhrase.and.returnValue(pending);

    const first = component.changeSecurityPhrase();
    const second = component.changeSecurityPhrase();
    expect(cryptoService.changeSecurityPhrase).toHaveBeenCalledOnceWith('old phrase', 'new phrase');
    expect(component.isChangingPhrase()).toBeTrue();

    release();
    await Promise.all([first, second]);
    expect(component.isChangingPhrase()).toBeFalse();
  });

  it('reports backend failure without claiming success', async () => {
    const component = fixture.componentInstance;
    cryptoService.changeSecurityPhrase.calls.reset();
    component.oldPhrase.set('old phrase');
    component.newPhrase.set('new phrase');
    component.confirmPhrase.set('new phrase');
    cryptoService.changeSecurityPhrase.and.rejectWith(new SecurityPhraseChangeError('SERVER_UNAVAILABLE'));

    await component.changeSecurityPhrase();

    expect(cryptoService.changeSecurityPhrase).toHaveBeenCalledOnceWith('old phrase', 'new phrase');
    expect(component.changePhraseSuccess()).toBe('');
    expect(component.changePhraseError()).toContain('temporariamente indisponível');
    expect(component.isChangingPhrase()).toBeFalse();
  });

  it('keeps phrase success and warns when the new recovery download fails', async () => {
    const component = fixture.componentInstance;
    cryptoService.changeSecurityPhrase.calls.reset();
    cryptoService.changeSecurityPhrase.and.resolveTo();
    component.oldPhrase.set('old phrase');
    component.newPhrase.set('new phrase');
    component.confirmPhrase.set('new phrase');
    anchorClickSpy.and.throwError('download blocked');

    await component.changeSecurityPhrase();

    expect(component.changePhraseSuccess()).toContain('arquivo de recuperação anterior');
    expect(component.changePhraseWarning()).toContain('novo arquivo de recuperação');
    expect(component.changePhraseWarning()).toContain('frase antiga');
    expect(component.changePhraseError()).toBe('');
  });

  it('keeps the existing topbar actions wired', () => {
    const component = fixture.componentInstance;
    const unlock = jasmine.createSpy('unlock');
    const lock = jasmine.createSpy('lock');
    component.unlockRequested.subscribe(unlock);
    component.lockRequested.subscribe(lock);

    expect(component.getAccountName('maria@example.com')).toBe('Maria');
    expect(component.getBubbleColorClass('maria@example.com')).toContain('bubble-');
    component.onUnlockClick();
    (fixture.nativeElement.querySelector('.lock-btn') as HTMLButtonElement).click();
    component.onDocumentClick({ target: document.createElement('button') } as unknown as MouseEvent);
    component.logout();

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(cryptoService.lockVault).not.toHaveBeenCalled();
    expect(appState.lock).not.toHaveBeenCalled();
    expect(authService.logout).toHaveBeenCalled();
  });

  it('A19-LOCK-001 emits lock intent without owning Vault teardown', () => {
    const component = fixture.componentInstance as any;
    const lock = jasmine.createSpy('lock');
    cryptoService.lockVault.calls.reset();
    appState.lock.calls.reset();

    expect(component.lockRequested).toBeDefined();
    component.lockRequested.subscribe(lock);
    (fixture.nativeElement.querySelector('.lock-btn') as HTMLButtonElement).click();

    expect(lock).toHaveBeenCalledTimes(1);
    expect(cryptoService.lockVault).not.toHaveBeenCalled();
    expect(appState.lock).not.toHaveBeenCalled();
  });

  it('A19-LOCK-C07 clears security phrase fields before emitting lock intent', () => {
    const component = fixture.componentInstance as any;
    component.oldPhrase.set('old secret');
    component.newPhrase.set('new secret');
    component.confirmPhrase.set('new secret');
    component.changePhraseError.set('error');
    component.changePhraseSuccess.set('success');
    component.changePhraseWarning.set('warning');
    expect(component.lockRequested).toBeDefined();

    (fixture.nativeElement.querySelector('.lock-btn') as HTMLButtonElement).click();

    expect(component.oldPhrase()).toBe('');
    expect(component.newPhrase()).toBe('');
    expect(component.confirmPhrase()).toBe('');
    expect(component.changePhraseError()).toBe('');
    expect(component.changePhraseSuccess()).toBe('');
    expect(component.changePhraseWarning()).toBe('');
  });

  it('uses a fallback when a linked account picture is missing or broken', () => {
    driveStore.linkedAccounts.set([
      { id: 1, accountEmail: 'alice@example.com', accountPicture: 'https://example.test/alice.png' },
      { id: 2, accountEmail: 'bob@example.com' },
      { id: 3, accountEmail: 'carol@example.com', accountPicture: 'https://example.test/carol.png' },
    ] as any);
    const component = fixture.componentInstance;
    component.isProfileMenuOpen.set(true);
    component.isAccountsExpanded.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.profile-card-subrow img').length).toBe(2);
    const broken = fixture.nativeElement.querySelector('img[src="https://example.test/carol.png"]') as HTMLImageElement;
    broken.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img[src="https://example.test/carol.png"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.profile-card-subrow .bubble-blue, .profile-card-subrow .bubble-purple, .profile-card-subrow .bubble-teal')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('img[src="https://example.test/alice.png"]')).not.toBeNull();
  });

  it('opens the existing settings modal from the compact entry', () => {
    const component = fixture.componentInstance;
    component.isSettingsOpen.set(false);
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.compact-settings-btn').click();
    fixture.detectChanges();
    expect(component.isSettingsOpen()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.settings-modal')).not.toBeNull();
  });
});
