import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { errorInterceptor } from './error.interceptor';
import { BYPASS_LOGOUT } from './http-context-tokens';
import { AuthService } from '../auth/auth.service';
import { AppStateService } from '../state/app-state.service';
import { provideZonelessChangeDetection } from '@angular/core';
import { environment } from '../../../environments/environment';

describe('ErrorInterceptor', () => {
  let httpMock: HttpTestingController;
  let httpClient: HttpClient;
  let authSpy: any;
  let appStateSpy: any;

  beforeEach(() => {
    authSpy = jasmine.createSpyObj('AuthService', ['logout']);
    appStateSpy = jasmine.createSpyObj('AppStateService', ['lock']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authSpy },
        { provide: AppStateService, useValue: appStateSpy }
      ]
    });

    httpMock = TestBed.inject(HttpTestingController);
    httpClient = TestBed.inject(HttpClient);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should call authService.logout on 401 response', () => {
    // Act
    httpClient.get(`${environment.apiUrl}/api/data`).subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne(`${environment.apiUrl}/api/data`);
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).toHaveBeenCalled();
  });

  it('should call appState.lock on 403 response', () => {
    // Act
    httpClient.get(`${environment.apiUrl}/api/data`).subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne(`${environment.apiUrl}/api/data`);
    req.flush('Forbidden', { status: 403, statusText: 'Forbidden' });

    expect(appStateSpy.lock).toHaveBeenCalled();
  });

  it('should ignore 401 if BYPASS_LOGOUT context is true', () => {
    // Arrange
    const context = new HttpContext().set(BYPASS_LOGOUT, true);
    
    // Act
    httpClient.get(`${environment.apiUrl}/api/data`, { context }).subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne(`${environment.apiUrl}/api/data`);
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
  });

  it('should ignore 401 and 403 if URL is public share', () => {
    // Act
    httpClient.get(`${environment.apiUrl}/share/123`).subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne(`${environment.apiUrl}/share/123`);
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });

  it('does not mutate Nanika session state for a Google 401', () => {
    httpClient.get('https://www.googleapis.com/drive/v3/files/test?alt=media').subscribe({ error: () => {} });

    const req = httpMock.expectOne('https://www.googleapis.com/drive/v3/files/test?alt=media');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });

  it('does not mutate Nanika Vault state for a Google 403', () => {
    httpClient.get('https://www.googleapis.com/drive/v3/files/test?alt=media').subscribe({ error: () => {} });

    const req = httpMock.expectOne('https://www.googleapis.com/drive/v3/files/test?alt=media');
    req.flush('Forbidden', { status: 403, statusText: 'Forbidden' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });

  it('keeps the upload API session-authoritative for a 401', () => {
    httpClient.get(`${environment.uploadApiUrl}/files/1/chunks`).subscribe({ error: () => {} });

    const req = httpMock.expectOne(`${environment.uploadApiUrl}/files/1/chunks`);
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).toHaveBeenCalledTimes(1);
  });

  it('ignores 401 and 403 from an unknown external origin', () => {
    httpClient.get('https://example.test/api').subscribe({ error: () => {} });

    const req = httpMock.expectOne('https://example.test/api');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();

    httpClient.get('https://example.test/api').subscribe({ error: () => {} });
    httpMock.expectOne('https://example.test/api').flush('Forbidden', { status: 403, statusText: 'Forbidden' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });

  it('rejects an external share-looking URL before public-share classification', () => {
    httpClient.get('https://evil.test/share/foo').subscribe({ error: () => {} });

    const req = httpMock.expectOne('https://evil.test/share/foo');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });
});
