import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { AppStateService } from '../state/app-state.service';
import { CryptoService } from '../crypto/crypto.service';
import { environment } from '../../../environments/environment';

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;
  let appStateSpy: jasmine.SpyObj<AppStateService>;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let router: Router;

  const tokenFor = (payload: Record<string, unknown>) => {
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${encoded}.signature`;
  };

  beforeEach(() => {
    appStateSpy = jasmine.createSpyObj('AppStateService', ['login', 'logout', 'status']);
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['lockVault']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        provideZonelessChangeDetection(),
        AuthService,
        { provide: AppStateService, useValue: appStateSpy },
        { provide: CryptoService, useValue: cryptoSpy }
      ]
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => httpMock.verify());

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

  it('handles OAuth login success and chooses setup for an uninitialized vault', async () => {
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('id_token=id-token&state=nonce');
    const req = httpMock.expectOne(`${environment.apiUrl}/api/auth/google`);
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
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const promise = service.handleOAuthCallback('id_token=id-token&state=nonce');
    httpMock.expectOne(`${environment.apiUrl}/api/auth/google`).flush(
      { error: 'provider down' },
      { status: 502, statusText: 'Bad Gateway' }
    );
    await promise;

    expect(service.error()).toBe('provider down');
    expect(service.loading()).toBeFalse();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('logs out, locks the vault, and sends the in-memory token to the server', () => {
    const navigate = spyOn(router, 'navigate').and.stub();
    (service as any).jwtToken = 'jwt-token';

    service.logout();
    const req = httpMock.expectOne(`${environment.apiUrl}/logout`);

    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-token');
    expect(cryptoSpy.lockVault).toHaveBeenCalled();
    expect(appStateSpy.logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    req.flush({});
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
