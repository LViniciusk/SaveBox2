import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { jwtInterceptor } from './jwt.interceptor';
import { AuthService } from '../auth/auth.service';
import { provideZonelessChangeDetection } from '@angular/core';

describe('JwtInterceptor', () => {
  let httpMock: HttpTestingController;
  let httpClient: HttpClient;
  let authSpy: any;

  beforeEach(() => {
    authSpy = jasmine.createSpyObj('AuthService', ['getToken']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([jwtInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authSpy }
      ]
    });

    httpMock = TestBed.inject(HttpTestingController);
    httpClient = TestBed.inject(HttpClient);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should attach Bearer token if token exists and URL is not Google Drive API', () => {
    // Arrange
    authSpy.getToken.and.returnValue('fake-jwt-token');

    // Act
    httpClient.get('/api/data').subscribe();

    // Assert
    const req = httpMock.expectOne('/api/data');
    expect(req.request.headers.has('Authorization')).toBeTrue();
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-jwt-token');
    expect(req.request.withCredentials).toBeTrue();
  });

  it('should not attach Bearer token if URL is googleapis.com', () => {
    // Arrange
    authSpy.getToken.and.returnValue('fake-jwt-token');

    // Act
    httpClient.get('https://www.googleapis.com/drive/v3/files').subscribe();

    // Assert
    const req = httpMock.expectOne('https://www.googleapis.com/drive/v3/files');
    expect(req.request.headers.has('Authorization')).toBeFalse();
  });

  it('should not trust a lookalike googleapis hostname', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');

    httpClient.get('https://googleapis.com.attacker.test/drive/v3/files').subscribe();

    const req = httpMock.expectOne('https://googleapis.com.attacker.test/drive/v3/files');
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-jwt-token');
  });

  it('should not attach Bearer token if token is empty', () => {
    // Arrange
    authSpy.getToken.and.returnValue(null);

    // Act
    httpClient.get('/api/data').subscribe();

    // Assert
    const req = httpMock.expectOne('/api/data');
    expect(req.request.headers.has('Authorization')).toBeFalse();
  });
});
