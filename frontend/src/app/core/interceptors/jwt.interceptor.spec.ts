import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { jwtInterceptor } from './jwt.interceptor';
import { AuthService } from '../auth/auth.service';
import { provideZonelessChangeDetection } from '@angular/core';
import { environment } from '../../../environments/environment';

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

  it('attaches the Nanika JWT to the configured API authority', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');
    const url = `${environment.apiUrl.replace(/\/+$/, '')}/api/data`;

    httpClient.get(url).subscribe();

    const req = httpMock.expectOne(url);
    expect(req.request.headers.has('Authorization')).toBeTrue();
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-jwt-token');
    expect(req.request.withCredentials).toBeTrue();
  });

  it('attaches the Nanika JWT to the configured upload authority', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');
    const url = `${environment.uploadApiUrl.replace(/\/+$/, '')}/files/1/chunks`;

    httpClient.get(url).subscribe();

    const req = httpMock.expectOne(url);
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-jwt-token');
    expect(req.request.withCredentials).toBeTrue();
  });

  it('does not attach the Nanika JWT or credentials to an unrelated external origin', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');

    httpClient.get('https://external.example.test/resource').subscribe();

    const req = httpMock.expectOne('https://external.example.test/resource');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(req.request.withCredentials).toBeFalse();
  });

  it('does not trust an external Google hostname lookalike', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');

    httpClient.get('https://googleapis.com.attacker.test/drive/v3/files').subscribe();

    const req = httpMock.expectOne('https://googleapis.com.attacker.test/drive/v3/files');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(req.request.withCredentials).toBeFalse();
  });

  it('preserves an external provider Authorization header and request headers', () => {
    authSpy.getToken.and.returnValue('fake-jwt-token');

    httpClient.get('https://www.googleapis.com/drive/v3/files', {
      headers: {
        Authorization: 'Bearer google-access-token',
        Range: 'bytes=0-15',
        'X-Provider': 'drive',
      },
    }).subscribe();

    const req = httpMock.expectOne('https://www.googleapis.com/drive/v3/files');
    expect(req.request.headers.get('Authorization')).toBe('Bearer google-access-token');
    expect(req.request.headers.get('Range')).toBe('bytes=0-15');
    expect(req.request.headers.get('X-Provider')).toBe('drive');
    expect(req.request.withCredentials).toBeFalse();
  });

  it('does not mutate a configured Nanika request when the token is empty', () => {
    authSpy.getToken.and.returnValue(null);
    const url = `${environment.apiUrl.replace(/\/+$/, '')}/api/data`;

    httpClient.get(url).subscribe();

    const req = httpMock.expectOne(url);
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(req.request.withCredentials).toBeFalse();
  });
});
