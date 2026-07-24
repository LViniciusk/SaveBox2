import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ShareService } from './share.service';
import { environment } from '../../../../environments/environment';

describe('ShareService', () => {
  let service: ShareService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ShareService
      ]
    });
    service = TestBed.inject(ShareService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should get shared file metadata', () => {
    service.getSharedFileMetadata('share-123').subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/share/share-123`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should download shared file', () => {
    service.downloadSharedFile('share-123').subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/share/share-123/download`);
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob());
  });

  it('should download shared file range', () => {
    service.downloadSharedFileRange('share-123', 0, 100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/share/share-123/download`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Range')).toBe('bytes=0-100');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob());
  });
});
