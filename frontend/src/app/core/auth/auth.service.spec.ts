import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { AppStateService } from '../state/app-state.service';
import { CryptoService } from '../crypto/crypto.service';
import { environment } from '../../../environments/environment';
import { ComputerStore } from '../../features/drive/state/computer.store';
import { DriveStore } from '../../features/drive/state/drive.store';
import { StorageMoveEngineService } from '../../features/drive/storage-move/storage-move-engine.service';

describe('AuthService', () => {
  const GOOGLE_LOGIN_ATTEMPT_KEY = 'nanika.google-login-attempt.v1';

  let service: AuthService;
  let httpMock: HttpTestingController;
  let appStateSpy: jasmine.SpyObj<AppStateService>;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let computerStoreSpy: jasmine.SpyObj<ComputerStore>;
  let driveStoreSpy: jasmine.SpyObj<DriveStore>;
  let storageMoveEngineSpy: jasmine.SpyObj<StorageMoveEngineService>;
  let router: Router;

  const tokenFor = (payload: Record<string, unknown>) => {
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${encoded}.signature`;
  };

  const storeGoogleLoginAttempt = (state: string, nonce: string): void => {
    sessionStorage.setItem(GOOGLE_LOGIN_ATTEMPT_KEY, JSON.stringify({
      state,
      nonce,
      createdAt: Date.now(),
    }));
  };

  beforeEach(() => {
    sessionStorage.removeItem(GOOGLE_LOGIN_ATTEMPT_KEY);
    appStateSpy = jasmine.createSpyObj('AppStateService', ['login', 'logout', 'status']);
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['lockVault']);
    computerStoreSpy = jasmine.createSpyObj('ComputerStore', ['loadTargets']);
    computerStoreSpy.loadTargets.and.resolveTo();
    driveStoreSpy = jasmine.createSpyObj('DriveStore', ['loadLinkedAccounts', 'resetUploadRuntimeState', 'resetDownloadRuntimeState']);
    driveStoreSpy.loadLinkedAccounts.and.resolveTo();
    storageMoveEngineSpy = jasmine.createSpyObj('StorageMoveEngineService', ['resetRuntimeState']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        provideZonelessChangeDetection(),
        AuthService,
        { provide: AppStateService, useValue: appStateSpy },
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: ComputerStore, useValue: computerStoreSpy },
        { provide: DriveStore, useValue: driveStoreSpy },
        { provide: StorageMoveEngineService, useValue: storageMoveEngineSpy }
      ]
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    sessionStorage.removeItem(GOOGLE_LOGIN_ATTEMPT_KEY);
    httpMock.verify();
  });

  it('restores a session and propagates user and vault state from the token', () => {
    let result: boolean | undefined;
    service.restoreSession().subscribe(value => result = value);
    const req = httpMock.expectOne(`${environment.apiUrl}/api/auth/refresh`);

    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ token: tokenFor({ email: 'user@example.com', name: 'User', is_vault_initialized: true }) });

    expect(result).toBeTrue();
    expect(service.getToken()).toContain('header.');
    expect(appStateSpy.login).toHaveBeenCalledWith(
      { email: 'user@example.com', name: 'User', picture: '' },
      true
    );
  });

  it('logs out locally when session restoration fails', () => {
    let result: boolean | undefined;
    service.restoreSession().subscribe(value => result = value);
    httpMock.expectOne(`${environment.apiUrl}/api/auth/refresh`).flush('offline', {
      status: 503,
      statusText: 'Unavailable'
    });

    expect(result).toBeFalse();
    expect(appStateSpy.logout).toHaveBeenCalled();
  });

  it('rejects a Google login callback without a locally initiated attempt', async () => {
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    const promise = service.handleOAuthCallback('id_token=id-token&state=attacker-state');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
    expect(service.getToken()).toBeNull();
    expect(appStateSpy.login).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('rejects a Google login callback whose state does not match the pending attempt', async () => {
    storeGoogleLoginAttempt('victim-state', 'victim-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    const promise = service.handleOAuthCallback('id_token=id-token&state=attacker-state');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('uses the stored nonce rather than callback state when exchanging a valid Google login', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    const promise = service.handleOAuthCallback('id_token=id-token&state=expected-state');
    const req = httpMock.expectOne(`${environment.apiUrl}/api/auth/google`);

    expect(req.request.body).toEqual({
      id_token: 'id-token',
      nonce: 'expected-nonce',
    });
    expect(req.request.body.nonce).not.toBe('expected-state');
    req.flush({ token: tokenFor({ email: 'new@example.com', is_vault_initialized: false }) });
    await promise;

    expect(navigate).toHaveBeenCalledWith(['/drive/setup']);
  });

  it('generates independent state and nonce and stores them before redirecting', () => {
    spyOn(crypto, 'randomUUID').and.returnValues(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    const redirect = spyOn(service as any, 'redirectToGoogle').and.callFake((url: string) => {
      expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).not.toBeNull();
      const parsed = JSON.parse(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY) as string);
      expect(parsed.state).toBe('11111111-1111-4111-8111-111111111111');
      expect(parsed.nonce).toBe('22222222-2222-4222-8222-222222222222');

      const authUrl = new URL(url);
      expect(authUrl.searchParams.get('client_id')).toBe(environment.googleClientId);
      expect(authUrl.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/auth/callback`);
      expect(authUrl.searchParams.get('response_type')).toBe('id_token');
      expect(authUrl.searchParams.get('scope')).toBe('openid email profile');
      expect(authUrl.searchParams.get('prompt')).toBe('select_account');
      expect(authUrl.searchParams.get('state')).toBe(parsed.state);
      expect(authUrl.searchParams.get('nonce')).toBe(parsed.nonce);
      expect(authUrl.searchParams.get('state')).not.toBe(authUrl.searchParams.get('nonce'));
    });

    service.loginWithGoogle();

    expect(redirect).toHaveBeenCalledOnceWith(jasmine.any(String));
  });

  it('consumes a Google login attempt before the backend request and rejects replay', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    const first = service.handleOAuthCallback('id_token=id-token&state=expected-state');
    expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
    const req = httpMock.expectOne(`${environment.apiUrl}/api/auth/google`);
    req.flush({ token: tokenFor({ email: 'new@example.com', is_vault_initialized: true }) });
    await first;

    const replay = service.handleOAuthCallback('id_token=id-token&state=expected-state');
    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await replay;

    expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('rejects a callback without state and consumes the pending attempt', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('id_token=id-token');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
    expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
  });

  it('rejects a valid-state callback without an ID token', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('state=expected-state');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(service.error()).toBe('Falha na autenticação: token não recebido.');
  });

  it('accepts a matching provider access denial without contacting the backend', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('error=access_denied&state=expected-state');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(service.error()).toBe('Acesso negado. Tente novamente.');
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('rejects a provider error whose state does not match the pending attempt', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('error=access_denied&state=wrong-state');

    httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
    await promise;

    expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
  });

  it('rejects expired and future login attempts before contacting the backend', async () => {
    spyOn(router, 'navigate').and.resolveTo(true);
    const cases = [
      { state: 'expired-state', nonce: 'expired-nonce', createdAt: Date.now() - 600_001 },
      { state: 'future-state', nonce: 'future-nonce', createdAt: Date.now() + 60_000 },
    ];

    for (const attempt of cases) {
      sessionStorage.setItem(GOOGLE_LOGIN_ATTEMPT_KEY, JSON.stringify(attempt));
      const promise = service.handleOAuthCallback(`id_token=id-token&state=${attempt.state}`);

      httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
      await promise;
      expect(service.error()).toBe('Tentativa de login inválida ou expirada.');
    }
  });

  it('discards malformed and invalid login attempt records', async () => {
    spyOn(router, 'navigate').and.resolveTo(true);
    const records = [
      '{',
      'null',
      '[]',
      JSON.stringify({ nonce: 'nonce', createdAt: Date.now() }),
      JSON.stringify({ state: 'state', createdAt: Date.now() }),
      JSON.stringify({ state: '', nonce: 'nonce', createdAt: Date.now() }),
      JSON.stringify({ state: 'state', nonce: '', createdAt: Date.now() }),
      JSON.stringify({ state: 'state', nonce: 'nonce', createdAt: 'now' }),
    ];

    for (const record of records) {
      sessionStorage.setItem(GOOGLE_LOGIN_ATTEMPT_KEY, record);
      const promise = service.handleOAuthCallback('id_token=id-token&state=state');

      httpMock.expectNone(`${environment.apiUrl}/api/auth/google`);
      await promise;
      expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
    }
  });

  it('fails closed when session storage cannot persist the login attempt', () => {
    storeGoogleLoginAttempt('old-state', 'old-nonce');
    const redirect = spyOn(service as any, 'redirectToGoogle');
    spyOn(sessionStorage, 'setItem').and.throwError('SecurityError');

    service.loginWithGoogle();

    expect(redirect).not.toHaveBeenCalled();
    expect(service.error()).toBe('Não foi possível iniciar o login com Google.');
    expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
  });

  it('replaces an older pending attempt when a new login starts', () => {
    spyOn(crypto, 'randomUUID').and.returnValues(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    );
    spyOn(service as any, 'redirectToGoogle');

    service.loginWithGoogle();
    service.loginWithGoogle();

    expect(JSON.parse(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY) as string)).toEqual(
      jasmine.objectContaining({
        state: '33333333-3333-4333-8333-333333333333',
        nonce: '44444444-4444-4444-8444-444444444444',
      }),
    );
  });

  it('handles OAuth login success and chooses setup for an uninitialized vault', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('id_token=id-token&state=expected-state');
    const req = httpMock.expectOne(`${environment.apiUrl}/api/auth/google`);
    expect(req.request.body).toEqual({ id_token: 'id-token', nonce: 'expected-nonce' });
    req.flush({ token: tokenFor({ email: 'new@example.com', is_vault_initialized: false }) });
    await promise;

    expect(appStateSpy.login).toHaveBeenCalledWith(
      { email: 'new@example.com', name: '', picture: '' },
      false
    );
    expect(navigate).toHaveBeenCalledWith(['/drive/setup']);
    expect(service.loading()).toBeFalse();
  });

  it('surfaces OAuth server errors and returns to login', async () => {
    storeGoogleLoginAttempt('expected-state', 'expected-nonce');
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('id_token=id-token&state=expected-state');
    httpMock.expectOne(`${environment.apiUrl}/api/auth/google`).flush(
      { error: 'provider down' },
      { status: 502, statusText: 'Bad Gateway' }
    );
    await promise;

    expect(service.error()).toBe('provider down');
    expect(service.loading()).toBeFalse();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('refreshes computer targets after linking Google Drive', async () => {
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.linkGoogleDrive('auth-code', 'state');
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/google/link`);

    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({});
    await promise;

    expect(computerStoreSpy.loadTargets).toHaveBeenCalledWith({ force: true });
    expect(driveStoreSpy.loadLinkedAccounts).toHaveBeenCalledOnceWith();
    expect(navigate).toHaveBeenCalledWith(['/drive/home'], { queryParams: { drive_linked: 'success' } });
  });

  it('logs out, locks the vault, and sends the in-memory token to the server', () => {
    storeGoogleLoginAttempt('pending-state', 'pending-nonce');
    const navigate = spyOn(router, 'navigate').and.stub();
    (service as any).jwtToken = 'jwt-token';

    service.logout();
    const req = httpMock.expectOne(`${environment.apiUrl}/logout`);

    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-token');
    expect(cryptoSpy.lockVault).toHaveBeenCalled();
    expect(storageMoveEngineSpy.resetRuntimeState).toHaveBeenCalledOnceWith();
    expect((driveStoreSpy as any).resetUploadRuntimeState).toHaveBeenCalledOnceWith();
    expect(driveStoreSpy.resetDownloadRuntimeState).toHaveBeenCalledOnceWith();
    expect(appStateSpy.logout).toHaveBeenCalled();
    expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    req.flush({});
  });

  it('logoutGlobal também desmonta o runtime de uploads antes da navegação', () => {
    const navigate = spyOn(router, 'navigate').and.stub();
    (service as any).jwtToken = 'jwt-token';

    service.logoutGlobal();
    const req = httpMock.expectOne(`${environment.apiUrl}/logout/global`);

    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-token');
    expect((driveStoreSpy as any).resetUploadRuntimeState).toHaveBeenCalledOnceWith();
    expect(driveStoreSpy.resetDownloadRuntimeState).toHaveBeenCalledOnceWith();
    expect(cryptoSpy.lockVault).toHaveBeenCalledOnceWith();
    expect(appStateSpy.logout).toHaveBeenCalledOnceWith();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    req.flush({});
  });

  it('clears a pending Google login attempt after credential login succeeds', () => {
    storeGoogleLoginAttempt('pending-state', 'pending-nonce');
    service.loginWithCredentials('user', 'password').subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/login`);

    req.flush({ token: tokenFor({ email: 'user@example.com', is_vault_initialized: true }) });

    expect(sessionStorage.getItem(GOOGLE_LOGIN_ATTEMPT_KEY)).toBeNull();
  });

  it('commits credential login to AppState only after the HTTP response', () => {
    let completed = false;
    service.loginWithCredentials('user', 'password').subscribe(() => {
      completed = true;
    });
    const req = httpMock.expectOne(`${environment.apiUrl}/login`);

    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(appStateSpy.login).not.toHaveBeenCalled();
    expect(completed).toBeFalse();

    req.flush({ token: tokenFor({ email: 'user@example.com', is_vault_initialized: true }) });

    expect(appStateSpy.login).toHaveBeenCalledOnceWith(
      { email: 'user@example.com', name: '', picture: '' },
      true,
    );
    expect(completed).toBeTrue();
  });

  describe('decodeUserFromIdToken', () => {
    it('should gracefully handle malformed JWT without crashing global execution', () => {
      // Arrange
      const malformedJwt = 'this.is.not_a_valid_jwt';

      // Act
      // Accessing private method via type casting to test internal robustness per requirement
      const result = (service as any).decodeUserFromIdToken(malformedJwt);

      // Assert - Should return empty object fallback instead of throwing error
      expect(result).toEqual({ email: '', name: '', picture: '' });
    });

    it('should decode a valid JWT correctly', () => {
      // Arrange
      // Base64Url encoded {"email":"test@example.com","name":"Test","picture":"pic.png"}
      const payloadBase64 = btoa(JSON.stringify({
        email: 'test@example.com',
        name: 'Test',
        picture: 'pic.png'
      })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const validJwt = `header.${payloadBase64}.signature`;

      // Act
      const result = (service as any).decodeUserFromIdToken(validJwt);

      // Assert
      expect(result).toEqual({ email: 'test@example.com', name: 'Test', picture: 'pic.png' });
    });
  });
});
