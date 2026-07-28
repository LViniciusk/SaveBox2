import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { errorInterceptor, BYPASS_LOGOUT } from './error.interceptor';
import { AuthService } from '../auth/auth.service';
import { AppStateService } from '../state/app-state.service';
import { provideZonelessChangeDetection } from '@angular/core';

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
    httpClient.get('/api/data').subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne('/api/data');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).toHaveBeenCalled();
  });

  it('should call appState.lock on 403 response', () => {
    // Act
    httpClient.get('/api/data').subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne('/api/data');
    req.flush('Forbidden', { status: 403, statusText: 'Forbidden' });

    expect(appStateSpy.lock).toHaveBeenCalled();
  });

  it('should ignore 401 if BYPASS_LOGOUT context is true', () => {
    // Arrange
    const context = new HttpContext().set(BYPASS_LOGOUT, true);
    
    // Act
    httpClient.get('/api/data', { context }).subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne('/api/data');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
  });

  it('should ignore 401 and 403 if URL is public share', () => {
    // Act
    httpClient.get('/api/share/123').subscribe({
      error: () => {}
    });

    // Assert
    const req = httpMock.expectOne('/api/share/123');
    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(appStateSpy.lock).not.toHaveBeenCalled();
  });
});
